'use strict';
// Private Codex app-server over stdio (newline-delimited JSON-RPC). One process per room; no daemon, no ports.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');
const { toCodexInput } = require('./attachments');
const { fromCodex, sum } = require('./localUsage');

// Methods the room must never call, whatever a future caller asks for.
const FORBIDDEN = new Set(['account/rateLimitResetCredit/consume', 'account/logout', 'account/login/start', 'thread/delete']);

// These overrides belong only to the private room process, never the user's saved config.
const DISABLED_FEATURES = ['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'skill_mcp_dependency_install'];
const roomConfig = () => ({ features: Object.fromEntries(DISABLED_FEATURES.map(k => [k, false])), web_search: 'disabled' });
const permissionError = (reason = 'this thread has not passed the permission checks') => Object.assign(new Error(`Codex room permissions could not be verified: ${reason}. Update the CLI or check managed settings; no room turn was started.`), { roomPermission: true });
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);

const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || p;

// A human-readable activity for a Codex thread item, or null for items that aren't steps.
function describeItem(item) {
  switch (item && item.type) {
    case 'reasoning': return { phase: 'thinking', label: 'thinking' };
    case 'agentMessage': return { phase: 'writing', label: 'writing' };
    case 'commandExecution': return { phase: 'tool', label: `running ${clip(item.command, 50)}`, step: true };
    case 'fileChange': return { phase: 'tool', label: `editing ${(item.changes || []).map((c) => base(c.path)).slice(0, 3).join(', ') || 'files'}`, step: true };
    case 'mcpToolCall': return { phase: 'tool', label: `using ${item.server}.${item.tool}`, step: true };
    case 'dynamicToolCall': return { phase: 'tool', label: `using ${item.tool}`, step: true };
    case 'webSearch': return { phase: 'tool', label: `searching ${clip(item.query || 'the web', 40)}`, step: true };
    case 'imageView': return { phase: 'tool', label: `viewing ${base(item.path)}`, step: true };
    case 'plan': return { phase: 'thinking', label: 'planning' };
    case 'contextCompaction': return { phase: 'thinking', label: 'compacting context' };
    case 'collabAgentToolCall': case 'subAgentActivity': return { phase: 'tool', label: 'working with a sub-agent', step: true };
    default: return null;
  }
}

class CodexClient extends EventEmitter {
  // tools: typed room tools, attached to threads this client STARTS (app-server takes dynamicTools only on
  // thread/start; they persist across thread/resume). Calls go to the running turn's onTool.
  // access: 'read' | 'edit' | 'run'. The sandbox stays read-only at every level; above read only, each turn runs with
  // approvals "on-request", so every file change (and, at "run", every command that needs more than the sandbox)
  // asks first. onApproval({ kind, command, reason, cwd, paths, diff }) answers { allow, why }. At "edit", command
  // requests are declined without asking.
  constructor({ exe, cwd, tools = [], log = () => {}, access = 'read', onApproval = null, onRefused = () => {} }) {
    super();
    this.exe = exe; this.cwd = cwd; this.log = log; this.tools = tools; this.access = access; this.onApproval = onApproval; this.onRefused = onRefused;
    this.items = new Map(); // recent file-change items by id: their paths and diffs, for the approval card
    this.verifiedThreads = new Set(); this.permissionEpoch = 0;
    this.nextId = 0; this.pending = new Map(); this.proc = null;
  }

  async start() {
    this.proc = spawn(this.exe, ['app-server', ...DISABLED_FEATURES.flatMap(k => ['-c', `features.${k}=false`]), '-c', 'web_search="disabled"'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this._fail(e));
    this.proc.on('exit', (code, sig) => this._fail(new Error(`codex app-server exited (${code ?? sig})`)));
    this.proc.stderr.on('data', (d) => this.log(`codex stderr: ${String(d).slice(0, 400)}`));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));
    await this.request('initialize', { clientInfo: { name: 'wagon-wheel', title: 'Wagon Wheel', version: require('../package.json').version }, ...(this.tools.length ? { capabilities: { experimentalApi: true } } : {}) });
    this._write({ method: 'initialized' });
  }

  _fail(err) {
    this.permissionEpoch++; this.verifiedThreads.clear();
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    if (this.proc) { this.proc = null; this.emit('exit', err); }
  }

  _write(msg) {
    if (!this.proc) throw new Error('codex app-server is not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method === 'item/tool/call') { this._onToolCall(m); return; }
    if (m.id !== undefined && (m.method === 'item/fileChange/requestApproval' || m.method === 'item/commandExecution/requestApproval')) { this._onApprovalRequest(m); return; }
    if (m.id !== undefined && m.method) {
      // Any other server-to-client request (user input, permissions, elicitation). The room never grants those.
      this.log(`codex asked ${m.method}; declined`);
      this._write({ id: m.id, error: { code: -32601, message: 'Wagon Wheel does not grant approvals or input' } });
      return;
    }
    if (m.method === 'item/started' && m.params && m.params.item && m.params.item.type === 'fileChange') {
      this.items.set(m.params.item.id, m.params.item);
      if (this.items.size > 100) this.items.delete(this.items.keys().next().value);
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error))); else resolve(m.result);
      return;
    }
    if (m.method) this.emit('notification', m.method, m.params || {});
  }

  // A typed room tool, called from inside a turn. Only the running turn on that thread may answer it.
  async _onToolCall(m) {
    const p = m.params || {}; const t = this.currentTurn;
    let r;
    if (!t || !t.onTool || t.threadId !== p.threadId) r = { ok: false, text: 'Not available: no turn is open on this thread.' };
    else {
      try { r = await t.onTool(p.tool, p.arguments || {}); } catch (e) { r = { ok: false, text: `Failed: ${e.message}` }; }
      if (this.currentTurn !== t || t.cancelled) r = { ok: false, text: 'Not delivered: that turn already ended.' }; // Stopped or finished while the tool ran
    }
    try { this._write({ id: m.id, result: { contentItems: [{ type: 'inputText', text: String(r.text || '') }], success: !!r.ok } }); } catch (e) { this.log(`tool reply: ${e.message}`); }
  }

  // Codex asking to change files or to run a command outside its read-only sandbox. Only the running turn on that
  // thread can be asked, and only above read only; the room's answer becomes Codex's decision.
  async _onApprovalRequest(m) {
    const p = m.params || {}, t = this.currentTurn, command = m.method === 'item/commandExecution/requestApproval';
    let ans = { allow: false, why: 'not available' };
    if (!t || t.cancelled || t.threadId !== p.threadId || this.access === 'read' || !this.onApproval) ans = { allow: false, why: 'no turn is open' };
    else if (command && this.access !== 'run') { ans = { allow: false, why: 'this agent can edit files but not run commands' }; this.onRefused({ kind: 'command', command: p.command || '', reason: p.reason || '' }); }
    else {
      // Every path a change touches, including where an update moves a file (kind.move_path). An item the room never
      // saw has no paths, and the host refuses it rather than guess.
      const item = this.items.get(p.itemId) || {};
      const changes = (Array.isArray(item.changes) ? item.changes : []).map((c) => ({ path: typeof c.path === 'string' ? c.path : '', type: c.kind && c.kind.type, to: c.kind && typeof c.kind.move_path === 'string' ? c.kind.move_path : null, diff: typeof c.diff === 'string' ? c.diff : '' }));
      try {
        ans = await this.onApproval(command ? { kind: 'command', command: String(p.command || ''), reason: p.reason || '', cwd: p.cwd || this.cwd }
          : { kind: 'edit', reason: p.reason || '', grantRoot: p.grantRoot || null, changes, paths: changes.flatMap((c) => [c.path, c.to]).filter(Boolean), diff: changes.map((c) => c.diff).join('\n') });
      } catch (e) { ans = { allow: false, why: e.message }; }
      if (this.currentTurn !== t || t.cancelled) ans = { allow: false, why: 'that turn already ended' };
    }
    try { this._write({ id: m.id, result: { decision: ans.allow ? 'accept' : 'decline' } }); } catch (e) { this.log(`approval reply: ${e.message}`); }
  }

  request(method, params, timeoutMs = 120000) {
    if (FORBIDDEN.has(method)) return Promise.reject(new Error(`${method} is forbidden in Wagon Wheel`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this._write({ id, method, params }); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
    });
  }

  safety(developerInstructions) {
    return { approvalPolicy: 'never', sandbox: 'read-only', cwd: this.cwd, developerInstructions };
  }

  async listThreads(searchTerm, limit = 20) {
    const r = await this.request('thread/list', { limit, searchTerm: searchTerm || null });
    return r.data || [];
  }

  async _attach(method, params) {
    // An empty mcp_servers table MERGES with inherited config. Disable each inherited server explicitly.
    // Read config before every attachment so new project/user entries cannot slip into a resumed thread.
    const epoch = ++this.permissionEpoch; this.verifiedThreads.clear();
    let stage = 'configuration read';
    try {
      const { config } = await this.request('config/read', { cwd: this.cwd, includeLayers: false }, 20000);
      if (!record(config) || !record(config.features) || !record(config.mcp_servers) ||
          config.web_search !== 'disabled' || DISABLED_FEATURES.some(k => config.features[k] !== false)) throw permissionError('disabled features or web search could not be confirmed');
      const overrides = { ...roomConfig(), mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers).map(k => [k, { enabled: false }])) };
      stage = method;
      const r = await this.request(method, { ...params, cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', config: overrides }, 600000);
      if (!r.thread || typeof r.thread.id !== 'string' || !r.thread.id || r.approvalPolicy !== 'never' ||
          r.sandbox?.type !== 'readOnly' || r.sandbox.networkAccess !== false) throw permissionError('the thread did not return the required read-only sandbox and approval policy');
      stage = 'MCP inventory check';
      await this._verifyInventory(r.thread.id);
      if (epoch !== this.permissionEpoch) throw permissionError('the process or attachment was stopped or replaced');
      this.verifiedThreads.add(r.thread.id);
      return r.thread;
    } catch (e) {
      this.stop();
      // Config and CLI failures can contain personal paths/settings. Do not forward their raw payload. One fact is
      // kept: Codex writes a thread to disk only after its first turn, so resuming a thread that never had one says
      // "no rollout found". The room can then start a fresh thread instead (extension.js bootSeats).
      if (e.roomPermission) throw e;
      throw Object.assign(permissionError(`${stage} failed`), { noRollout: stage === 'thread/resume' && /\bno rollout found\b/i.test(String(e && e.message)) });
    }
  }

  async _verifyInventory(threadId) {
    let cursor = null; const seen = new Set();
    do {
      const r = await this.request('mcpServerStatus/list', { threadId, limit: 100, cursor, detail: 'full' }, 20000);
      if (!r || !Array.isArray(r.data) || !(r.nextCursor === null || typeof r.nextCursor === 'string')) throw permissionError('the CLI did not return a supported MCP inventory');
      for (const server of r.data) {
        // Zero tools alone is not enough: a server still starting may expose tools later.
        if (!server || server.runtimeStatus !== 'disabled' || !record(server.tools) || Object.keys(server.tools).length ||
            !Array.isArray(server.resources) || server.resources.length ||
            !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length) throw permissionError('an external MCP server is not confirmed disabled');
      }
      cursor = r.nextCursor;
      if (cursor !== null && (!cursor || seen.has(cursor) || seen.size >= 100)) throw permissionError('MCP inventory pagination could not be completed');
      seen.add(cursor);
    } while (cursor !== null);
  }

  startThread(developerInstructions) {
    return this._attach('thread/start', { ...this.safety(developerInstructions), ephemeral: false, ...(this.tools.length ? { dynamicTools: this.tools.map((t) => ({ type: 'function', ...t })) } : {}) });
  }

  forkThread(threadId, developerInstructions) {
    return this._attach('thread/fork', { threadId, excludeTurns: true, ephemeral: false, ...this.safety(developerInstructions) });
  }

  resumeThread(threadId) {
    return this._attach('thread/resume', { threadId, excludeTurns: true });
  }

  async setName(threadId, name) {
    try { await this.request('thread/name/set', { threadId, name }); } catch (e) { this.log(`name/set: ${e.message}`); }
  }

  // Recent user/agent messages from a thread, oldest first. Reads local history; no model call.
  async recentMessages(threadId, turns = 8) {
    const r = await this.request('thread/turns/list', { threadId, limit: turns, sortDirection: 'desc', itemsView: 'full' }, 180000);
    const out = [];
    for (const turn of (r.data || []).slice().reverse()) {
      for (const item of turn.items || []) {
        if (item.type === 'userMessage') {
          const text = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          if (text) out.push({ role: 'user', text });
        } else if (item.type === 'agentMessage' && item.text) out.push({ role: 'codex', text: item.text });
      }
    }
    return out;
  }

  async listModels() {
    try { const r = await this.request('model/list', { limit: 50 }, 20000); return (r.data || []).filter((m) => !m.hidden); } catch (e) { this.log(`model/list: ${e.message}`); return []; }
  }

  compact(threadId) { if (!this.verifiedThreads.has(threadId)) return Promise.reject(permissionError()); return this.request('thread/compact/start', { threadId }, 600000); }

  async rateLimits() {
    try { return await this.request('account/rateLimits/read', {}, 20000); } catch (e) { this.log(`rateLimits: ${e.message}`); return null; }
  }

  // Run one turn; resolves with the agent's text. onDelta streams partial text.
  runTurn(threadId, text, onDelta = () => {}, onActivity = () => {}, attachments = [], opts = {}) {
    if (!this.verifiedThreads.has(threadId)) return Promise.reject(permissionError());
    return new Promise((resolve, reject) => {
      let turnId = null; const messages = new Map(); let lastError = null; const thinking = new Map(); let usage = null;
      this.lastTurnUsage = null;
      onActivity({ phase: 'waiting', label: 'waiting for the model' });
      const onNote = (method, p) => {
        if (p.threadId && p.threadId !== threadId) return;
        if (turnId && p.turnId && p.turnId !== turnId) return;
        if (method === 'turn/started' && p.turn && (!turnId || p.turn.id === turnId)) {
          turnId = active.turnId = p.turn.id; active.started = true;
          if (active.cancelled) this._interruptTurn(active);
        } else if (method === 'thread/tokenUsage/updated' && p.tokenUsage) {
          usage = sum(usage, fromCodex(p.tokenUsage.last)); this.lastTurnUsage = usage; // one report per model call
        } else if (method === 'turn/diff/updated' && p.diff) {
          onActivity({ phase: 'diff', diff: p.diff });
        } else if (method === 'item/started') {
          const a = describeItem(p.item); if (a) onActivity(a);
        } else if (method === 'item/reasoning/summaryTextDelta') {
          thinking.set(p.itemId, (thinking.get(p.itemId) || '') + p.delta);
          onActivity({ phase: 'thinking', label: 'thinking', thinking: [...thinking.values()].join('\n\n') });
        } else if (method === 'item/agentMessage/delta') {
          messages.set(p.itemId, (messages.get(p.itemId) || '') + p.delta);
          onDelta([...messages.values()].join('\n\n'));
        } else if (method === 'item/completed' && p.item && p.item.type === 'agentMessage') {
          messages.set(p.item.id, p.item.text || messages.get(p.item.id) || '');
        } else if (method === 'error') {
          lastError = (p.error && p.error.message) || 'Codex error';
        } else if (method === 'turn/completed' && p.turn && (!turnId || p.turn.id === turnId)) {
          cleanup();
          const status = p.turn.status; const reply = [...messages.values()].join('\n\n').trim();
          if (status === 'completed') resolve(reply);
          else if (status === 'interrupted') { const e = new Error('stopped'); e.stopped = true; reject(e); }
          else reject(new Error((p.turn.error && p.turn.error.message) || lastError || `turn ${status}`));
        }
      };
      // The active turn exists from now, so a Stop before the turn is running is remembered. The server answers
      // turn/start with an ID before the turn is live (interrupt then fails: "no active turn"), so a held Stop
      // is sent once turn/started arrives.
      const active = { threadId, turnId: null, started: false, cancelled: false, onTool: opts.onTool || null }; this.currentTurn = active;
      const onExit = (err) => { cleanup(); reject(err); };
      const cleanup = () => { this.off('notification', onNote); this.off('exit', onExit); if (this.currentTurn === active) this.currentTurn = null; };
      this.on('notification', onNote); this.once('exit', onExit);
      // The approval policy is set on every turn: "never" at read only (nothing can ask), "on-request" above it.
      this.request('turn/start', { threadId, input: toCodexInput(text, attachments), approvalPolicy: this.access === 'read' ? 'never' : 'on-request', ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.fast ? { serviceTierForTurn: 'priority' } : {}) })
        .then((r) => { if (!turnId) turnId = active.turnId = r && r.turn && r.turn.id; if (active.cancelled && active.started) this._interruptTurn(active); })
        .catch((e) => { cleanup(); reject(e); });
    });
  }

  // Steer: add input to the running turn (Codex's native turn/steer). The same turn keeps going.
  async steer(threadId, text, attachments = []) {
    const t = this.currentTurn;
    if (!t || !t.started || t.cancelled || t.threadId !== threadId) return false;
    await this.request('turn/steer', { threadId, expectedTurnId: t.turnId, input: toCodexInput(text, attachments) }, 20000);
    return true;
  }

  // Stop. Before the turn is live the cancel is held, and sent once (see runTurn).
  async interrupt() {
    const t = this.currentTurn; if (!t) return;
    t.cancelled = true;
    if (t.started) await this._interruptTurn(t);
  }

  async _interruptTurn(t) {
    if (t.interruptSent) return; t.interruptSent = true;
    try { await this.request('turn/interrupt', { threadId: t.threadId, turnId: t.turnId }, 10000); } catch (e) { this.log(`interrupt: ${e.message}`); }
  }

  stop() { this.permissionEpoch++; this.verifiedThreads.clear(); if (this.proc) { this.proc.stdin.end(); this.proc.kill(); } }
}

module.exports = { CodexClient, FORBIDDEN, describeItem };
