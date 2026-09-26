'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { CodexClient } = require('./codexClient');
const { ClaudeClient } = require('./claudeClient');
const { Room, AGENTS } = require('./room');
const { toolSpecs, PRESETS } = require('./tasks');
const { Scheduler } = require('./scheduler');
const { roomPrompt, participantPrompt, acpPrompt } = require('./prompts');
const { normalizeParticipants, SessionClaims } = require('./participants');
const { AcpClient } = require('./acpClient');
const { HistorySources, LOCAL_ONLY } = require('./historySources');
const { claudeHistoryReader, codexHistoryReader } = require('./sessionHistory');
const setup = require('./setup');
const { LocalUsage } = require('./localUsage');
const feedback = require('./feedback');
const roomsView = require('./roomsView');
const roomLock = require('./roomLock');
const startRoom = require('./startRoom');
const claudeModels = require('./claudeModels');
const copyMode = require('./copyMode');
const editPolicy = require('./editPolicy');
const { accessText } = require('./prompts');
const { claudeCard, codexCard } = require('./approvalCards');
const { ULTRACODE } = claudeModels;

// Token use across every local session on this computer (all rooms share one scanner; rescans read only new bytes).
const localUsage = { scanner: null, last: null, running: null };
async function scanLocalUsage() {
  if (localUsage.running) return localUsage.running;
  localUsage.scanner = localUsage.scanner || new LocalUsage();
  localUsage.running = localUsage.scanner.scan().then((r) => { localUsage.last = r; return r; }, (e) => { log(`local usage scan: ${e.message}`); return localUsage.last; }).finally(() => { localUsage.running = null; });
  return localUsage.running;
}
const claudeHistory = require('./claudeHistory');
const attachments = require('./attachments');
const commands = require('./commands');
const diffs = require('./diffs');
const paths = require('./paths');
const ideContext = require('./ideContext');
const claudeUsage = require('./claudeUsage');
const { findClaude, atLeast } = require('./claudeBinary');

const HANDOFF_RULE = 4; // version of the room's hand-off rules; older saved rooms get one notice when it changes
let claudeBin = null; // resolved once per window: newest Claude Code CLI on the machine
// Claude Code's own model menu, asked of the CLI once per window (no model call); the built-in copy until it answers.
let claudeCatalog = null, claudeCatalogAsked = null;
const claudeMenu = () => claudeCatalog || commands.CLAUDE_CATALOG;
// Claude Code lists Ultracode with its effort levels (/effort ultracode: "xhigh + dynamic workflow orchestration"), for
// models that offer Extra high. Tested with Claude Code 2.1.283; older CLIs don't get it.
const ULTRACODE_CLI = '2.1.283';
// An agent that can edit never gets Ultracode: a workflow's agents can't show an approval card.
const claudeEfforts = (cat, v, access = 'read') => { const e = (cat && cat.efforts) || []; return access === 'read' && e.includes('xhigh') && atLeast(v, ULTRACODE_CLI) ? [...e, ULTRACODE] : e; };
// The Start a Room screen's Claude models: the ones this CLI can run.
const startClaudeModels = (v) => claudeMenu().filter((m) => !m.minCli || atLeast(v, m.minCli)).map((m) => ({ id: m.id, name: m.name, note: m.note, efforts: claudeEfforts(m, v), older: !!m.older }));
// Weekly limits are per model family ("Fable"); Default (recommended) counts against the model it resolves to.
const limitName = (m) => { const f = claudeModels.familyOf(m.resolves || m.id); return f ? f.family[0].toUpperCase() + f.family.slice(1) : m.name; };
// Asked once per window, only of a real CLI on disk; open rooms refresh their pickers when the answer arrives.
function refreshClaudeMenu() {
  if (claudeCatalogAsked || !claudeBin || !path.isAbsolute(String(claudeBin.path)) || !fs.existsSync(claudeBin.path)) return claudeCatalogAsked;
  claudeCatalogAsked = claudeModels.query(claudeBin.path).then((l) => {
    if (l && l.length) { claudeCatalog = l; for (const x of sessions) if (x.room && !x.disposed) x.postMeta(); }
    return claudeCatalog;
  }, () => null);
  return claudeCatalogAsked;
}
const sessions = new Set();
const sessionClaims = new SessionClaims(); // only writers owned by this extension-host process
const roomClaims = new Map(); // one writer per saved room in this extension host
let lastEditor = null; // last code editor used; the room panel steals focus, so track it

let roomsTree = null; // the side panel's saved-rooms list, once activated
const refreshRooms = () => { if (roomsTree) roomsTree.refresh(); };

let output;
const recentLog = []; // last lines of this window's log, kept in memory for Report a Problem (opt-in, scrubbed)
const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  recentLog.push(line); if (recentLog.length > 50) recentLog.shift();
  if (output) output.appendLine(line);
};
const hostLabel = () => (vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : 'this computer');
const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex CLI' };
const setupLine = (p) => `${PROVIDER_NAMES[p.provider]}: ${p.installation === 'available' ? `v${p.version}` : p.installation}${p.installation === 'available' ? `, ${p.authentication === 'present' ? 'signed in' : p.authentication === 'signed-out' ? 'signed out' : 'sign-in unknown'}` : ''}${p.issue ? ` (${p.issue})` : ''}`;


// Report a Problem: versions and the focused room's roster, plus scrubbed log lines only if the person opts in.
async function reportProblem() {
  const s = settings();
  // Same trust rule as Check Setup: no CLI is run for an untrusted workspace.
  const [claudeV, codexV] = vscode.workspace.isTrusted
    ? await Promise.all([setup.cliVersion('claude', s.claude.path), setup.cliVersion('codex', s.codexExe)]) : ['not checked', 'not checked'];
  const open = [...sessions], room = open.find((x) => x.panel && x.panel.active) || open[open.length - 1];
  let seats = [];
  if (room) {
    let controls = {}; try { controls = room.room ? room.controls() : {}; } catch { /* roster only */ }
    seats = (room.meta.participants || room.meta.seats || []).map((p) => ({ id: p.id, label: p.label, provider: p.provider,
      model: (controls[p.id] && controls[p.id].model) || p.model || null, effort: (controls[p.id] && controls[p.id].effort) || p.effort || null }));
  }
  const pkg = require('../package.json');
  const facts = { extension: pkg.version, vscode: vscode.version, platform: `${process.platform} ${process.arch}`, remote: vscode.env.remoteName || null,
    clis: [{ name: 'Claude Code CLI', version: /^\d/.test(claudeV) ? claudeV : null, state: claudeV }, { name: 'Codex CLI', version: /^\d/.test(codexV) ? codexV : null, state: codexV }],
    seats, log: recentLog.slice() };
  const who = { home: os.homedir(), user: os.userInfo().username };
  const preview = feedback.issueUrl(facts, { includeLog: true, ...who }).logLines;
  const WITH = 'Open issue with log lines', WITHOUT = 'Open issue';
  const detail = ['This opens a new GitHub issue in your browser. Nothing is sent until you submit it there.',
    '', `Included: Wagon Wheel ${facts.extension}, VS Code ${facts.vscode}, ${facts.platform}, Claude Code CLI ${claudeV}, Codex CLI ${codexV}, and the room's seats and models.`,
    `Room: ${feedback.roomLine(seats)}`,
    'The report itself never includes your conversation, prompts, files or session contents.',
    ...(preview.length ? ['', `"${WITH}" also adds these ${preview.length} lines. They can include error text from the CLIs, so read them first (home folder, emails and key-like text are removed):`, ...preview] : [])].join('\n');
  const pick = await vscode.window.showInformationMessage('Wagon Wheel: Report a Problem', { modal: true, detail }, WITHOUT, ...(preview.length ? [WITH] : []));
  if (!pick) return;
  const { url } = feedback.issueUrl(facts, { includeLog: pick === WITH, ...who });
  log(`report a problem: opened issue form (${pick === WITH ? 'with' : 'without'} log lines)`);
  // A string, not vscode.Uri: Uri.parse decodes the query and the opener re-encodes it lossily (& # + and ? change),
  // so GitHub would receive a different issue than the one previewed. openExternal passes strings through unchanged.
  vscode.env.openExternal(url);
}

function firstExisting(candidates) {
  for (const c of candidates) if (c && (c.indexOf('/') === -1 || fs.existsSync(c))) return c;
  return candidates[candidates.length - 1];
}

// Display name for the human: the setting, else the first name in git's identity, else the OS login.
function defaultName() {
  try { const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/)[0]; if (n) return n; } catch { /* no git */ }
  return os.userInfo().username || 'You';
}

// Experimental ACP agents, by profile. Each runs its own tools under its own configuration: Wagon Wheel cannot
// sandbox it, only refuse client file/terminal access and reject the permission requests it receives.
const ACP_PROFILES = { gemini: { label: 'Gemini', command: 'gemini', args: ['--experimental-acp'] } };

// Settings live under wagonWheel.*; values set under the pre-rename wagonCircle.* still apply until replaced.
function config() {
  const c = vscode.workspace.getConfiguration('wagonWheel'), old = vscode.workspace.getConfiguration('wagonCircle');
  const setHere = (i) => i && [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some((v) => v !== undefined);
  return { get: (k) => (setHere(c.inspect(k)) || !setHere(old.inspect(k)) ? c.get(k) : old.get(k)), isSet: (k) => setHere(c.inspect(k)) || setHere(old.inspect(k)), update: (...a) => c.update(...a) };
}

function settings() {
  const c = config();
  const home = os.homedir();
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return {
    claudeModel: c.get('claudeModel') || null,
    claude: claudeBin || (claudeBin = findClaude(c.get('claudePath') || null)),
    codexExe: firstExisting([c.get('codexPath'), path.join(home, '.local/bin/codex'), path.join(home, '.codex/packages/standalone/current/codex'), 'codex']),
    userName: (c.get('userName') || '').trim() || defaultName(),
    defaultTarget: c.get('defaultTarget') || 'claude',
    claudeEffort: c.get('claudeEffort') || null,
    codexModel: c.get('codexModel') || null,
    codexEffort: c.get('codexEffort') || null,
    bothMode: c.get('bothMode') || 'sequential',
    taskMode: ['auto', 'chat', 'work'].includes(c.get('taskMode')) ? c.get('taskMode') : 'auto',
    allowBypass: c.get('allowBypass') === true,
    agentPosts: Number.isInteger(c.get('agentPostsPerTask')) ? Math.min(20, Math.max(0, c.get('agentPostsPerTask'))) : 3,
    // Three plain numbers; a taskDefaults object saved before v0.5 still applies until they are set.
    taskDefaults: cleanLimits({ ...PRESETS.balanced, ...(c.get('taskDefaults') || {}), ...Object.fromEntries([['turns', 'taskTurns'], ['reserve', 'taskReserve'], ['minutes', 'taskMinutes']].filter(([, key]) => c.isSet(key)).map(([k, key]) => [k, c.get(key)])) }),
    cwd: c.get('cwd') || (ws ? ws.uri.fsPath : home),
    // Only known, named profiles: no arbitrary executable from settings (DESIGN.md "Additional agents").
    extraAgents: [...new Set(Array.isArray(c.get('experimentalAgents')) ? c.get('experimentalAgents') : [])].filter((id) => typeof id === 'string' && Object.hasOwn(ACP_PROFILES, id)).map((id) => ({ id, ...ACP_PROFILES[id] }))
  };
}

class RoomSession {
  constructor(context, meta, state) {
    this.context = context; this.meta = meta; this.state = state; this.quota = null;
    this.file = path.join(context.globalStorageUri.fsPath, 'rooms', `${meta.id}.json`);
    this.attDir = path.join(context.globalStorageUri.fsPath, 'rooms', meta.id, 'attachments');
    this.pendingAtts = new Map(); this.extraClients = new Set(); this.disposed = false;
    this.slots = Object.create(null); this.ownedClients = new Set();
  }

  save() {
    if (this.disposed || roomClaims.get(this.file) !== this) return;
    this.syncSeats();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write then rename: another window reading this file never sees it half-written.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ meta: this.meta, state: this.room ? this.room.state : this.state }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  syncSeats() {
    if (this.disposed) return;
    for (const r of Object.values(this.slots)) {
      const p = r.seat;
      if (p.provider === 'claude' && r.client && r.client.sessionId && r.client.sessionId !== p.sessionId) this.adoptId(r, r.client, r.client.sessionId);
      // Preserve older metadata readers for the original two seat ids, without using it for routing.
      if (p.id === p.provider) {
        this.meta[p.provider === 'codex' ? 'codexThreadId' : 'claudeSessionId'] = p.sessionId;
        for (const k of ['model', 'effort', 'fast']) this.meta[p.provider + k[0].toUpperCase() + k.slice(1)] = p[k];
        if (p.provider === 'codex') { this.meta.codexTyped = p.typed; this.meta.codexTypedThreads = p.typedThreads; }
      }
    }
  }

  bindId(r, id) {
    if (!sessionClaims.claim(r.seat.provider, id, r.owner)) throw new Error('That conversation is already in use by another agent or room in this extension host. Use a copy instead.');
    if (r.seat.sessionId !== id) sessionClaims.release(r.seat.provider, r.seat.sessionId, r.owner);
    r.seat.sessionId = id;
  }

  // A Claude seat learns its session id from the CLI's first line: claim it then, not at the next save, so a
  // sibling's Continue picker cannot take it in between. Never throws: a save or a finishing turn must not fail
  // because of a claim, so a conflict is reported once in the room and logged instead.
  adoptId(r, client, id) {
    if (this.disposed || r.client !== client || r.seat.sessionId === id) return;
    // A new id from the CLI is a conversation this room created (fresh, or a copy): record it as the room's own, so
    // the lists can leave it out later. A continued original keeps its id and never reaches this line.
    if (r.seat.provider === 'claude') r.seat.typedThreads = [...new Set([...(r.seat.typedThreads || []), id])].slice(-50);
    try { this.bindId(r, id); } catch (e) {
      if (r.claimNoted === id) return; r.claimNoted = id;
      log(`${r.seat.id}: could not claim ${id}: ${e.message}`);
      if (this.room) this.room.note(`${r.seat.label} is using a conversation (${String(id).slice(0, 8)}) that another agent or room is also using. Switch one of them to a copy so they stop sharing it.`);
    }
  }

  peers(id) { return this.roster.filter((p) => p.id !== id); }
  toolsFor(id) { const peers = this.peers(id).map((x) => x.id); return toolSpecs(peers).filter((t) => peers.length || t.name !== 'request_assistance'); }
  brief(r, typed) { return participantPrompt(r.seat, this.peers(r.seat.id), this.meta.humanName, typed); }

  async makeCodex(r, action, source, valid = () => !this.disposed) {
    const p = r.seat, c = new CodexClient({ exe: this.options.codexExe, cwd: p.cwd, tools: this.toolsFor(p.id), log, access: p.access || 'read',
      onApproval: (req) => this.approve(r, c, codexCard(req, (x) => this.rel(p, x))),
      onRefused: (x) => !this.disposed && this.room && this.room.note(`${p.label} asked to run \`${String(x.command).slice(0, 120)}\` outside its sandbox; refused, because it can edit files but not run commands.`) });
    this.ownedClients.add(c); if (r.switching) r.switchClient = c;
    let ready = false;
    try {
      await c.start(); if (!valid()) return null;
      let t;
      if (action === 'continue') t = await c.resumeThread(source);
      else if (action === 'fork') t = await c.forkThread(source, this.brief(r, false));
      else t = await c.startThread(this.brief(r, true));
      if (action !== 'continue') p.briefAccess = p.access || 'read'; // what its instructions say it can do
      if (!valid()) return null;
      // Name threads the room creates; never rename a conversation the person brought in as the original.
      if (action !== 'continue') { await c.setName(t.id, `Wagon Wheel: ${this.meta.name} · ${p.label}`); if (!valid()) return null; }
      const models = await c.listModels(); if (!valid()) return null;
      c.on('notification', (method) => { if (method === 'account/rateLimits/updated' && this.room) this.refreshQuota(); });
      c.on('exit', (e) => this.post({ type: 'notice', text: `${p.label} process exited: ${e.message}. Reopen the room to restart it.` }));
      ready = true; return { client: c, id: t.id, models };
    } finally { if (!ready) { c.stop(); this.ownedClients.delete(c); } }
  }

  // One approval card for either vendor. The host decides first (editPolicy): outside the agent's folder, inside git's
  // own folder or with no known files is refused without a card; a file that can run code always gets a card.
  async approve(r, client, req) {
    const gone = () => this.disposed || !this.room || r.client !== client;
    if (gone()) return { allow: false, why: 'the room is closed' };
    const root = r.seat.cwd;
    if (req.kind === 'command' && !req.cwd) req = { ...req, cwd: root }; // Claude runs commands in its own folder
    let verdict = { refused: null, sensitive: null };
    if (req.kind === 'edit') verdict = editPolicy.check(req.paths || [], root, await editPolicy.gitDirs(root));
    else if ((req.paths || []).some((x) => !editPolicy.within(editPolicy.abs(root, x), root))) verdict.refused = 'it would run outside its folder';
    if (gone()) return { allow: false, why: 'the room is closed' };
    return this.room.requestApproval(r.seat.id, { ...req, refused: req.refused || verdict.refused, sensitive: verdict.sensitive });
  }

  // Codex's instructions are fixed when its thread starts, so a level changed since then is said at the top of its next
  // turn (and remembered once that turn went through).
  codexTurn(r, text, delta, activity, files, onTool) {
    const p = r.seat, now = p.access || 'read', told = p.briefAccess || 'read';
    const lead = now !== told ? `[Wagon Wheel notice: ${this.meta.humanName} changed what you can do in this room. This replaces what you were told before.] ${accessText('codex', now, this.meta.humanName)}\n\n` : '';
    return r.client.runTurn(p.sessionId, lead + text, delta, activity, files, { model: p.model, effort: p.effort, fast: p.fast, onTool })
      .then((out) => { if (lead) { p.briefAccess = now; this.save(); } return out; });
  }

  rel(p, file) { const r = path.relative(p.cwd, path.resolve(p.cwd, String(file || ''))); return r && !r.startsWith('..') ? r : String(file || ''); }

  makeClaude(r, sessionId, forkFrom) {
    const p = r.seat;
    const c = new ClaudeClient({ exe: this.options.claude.path, cwd: p.cwd, model: p.model, effort: p.effort, fast: !!p.fast && this.claudeFastOk(p.model),
      onNotice: (t) => !this.disposed && this.room && this.room.note(`${p.label}: ${t}`), systemPrompt: this.brief(r, true), tools: this.toolsFor(p.id),
      onSession: (id) => this.adoptId(r, c, id), sessionId, forkFrom, addDirs: [this.attDir], log, access: p.access || 'read',
      onPermission: (req) => this.approve(r, c, claudeCard(req, (x) => this.rel(p, x))),
      // A background job (Ultracode) finished after Claude's reply ended: the room decides whether its report is posted.
      onUnprompted: (info) => (this.disposed || !this.room || r.client !== c ? null : this.room.unprompted(p.id, info)),
      onJobs: (jobs) => { if (this.disposed || (r.client !== c && jobs.length)) return; r.jobs = jobs; this.post({ type: 'jobs', name: p.id, jobs }); } });
    this.ownedClients.add(c); return c;
  }

  async boot(opts = {}) {
    if (this.disposed || this.room) return;
    if (this.booting) return this.booting;
    if (roomClaims.has(this.file) && roomClaims.get(this.file) !== this) {
      // Not disposed: the panel closing cleans up, and the room may boot here once the owner closes. The page
      // clears its log on init, so the refusal is kept and posted again after init (see postInit).
      const msg = 'This room is already open in this extension host. Use its existing panel.';
      this.refusal = `Could not start: ${msg}`;
      this.post({ type: 'notice', text: this.refusal }); throw new Error(msg);
    }
    // Another VS Code window is a separate extension host: its claim is the lock file next to the room.
    const lock = roomLock.acquire(this.file);
    if (!lock.ok) {
      const msg = `This room is open in another VS Code window. Close it there, or use that window. If no window has it open, delete its lock file: ${roomLock.lockPath(this.file)}`;
      this.refusal = `Could not start: ${msg}`;
      this.post({ type: 'notice', text: this.refusal }); throw new Error(msg);
    }
    roomClaims.set(this.file, this);
    this.booting = this.bootSeats(opts);
    try { await this.booting; }
    catch (e) {
      // Tell the panel before disposing: post() is a no-op afterwards, and the toast alone is easy to miss.
      this.post({ type: 'notice', text: `Could not start: ${e.message}` });
      this.disposed = true; this.scheduler?.dispose(); this.closeClients(); throw e;
    }
    finally { this.booting = null; }
  }

  // Whether a seat ever answered in this room's saved transcript (seeded history from other sessions does not count).
  seatSpoke(id) { return !!(this.state && Array.isArray(this.state.transcript) && this.state.transcript.some((e) => e && e.from === id && e.kind !== 'history')); }

  // A roster is fixed before creating any thread: Codex dynamic-tool peer enums are immutable on a thread.
  async bootSeats({ shareSeed = {} } = {}) {
    const s = this.options = settings(), m = this.meta;
    m.humanName = s.userName; this.claudeVersion = s.claude.version;
    m.seats = normalizeParticipants(m, s);
    // Bypass is per session: a reopened room starts asking again.
    for (const p of m.seats) if (p.mode === 'bypass') { p.mode = 'ask'; this.pendingNotes = [...(this.pendingNotes || []), `${p.label}'s bypass mode ended when the room closed, so it asks you again. Turn it back on from its menu if you want it.`]; }
    if (m.ideContext === undefined) m.ideContext = c_ide();
    if (m.bothMode === undefined) m.bothMode = s.bothMode;
    if (m.defaultTarget === undefined || (m.defaultTarget !== 'both' && !m.seats.some((p) => p.id === m.defaultTarget))) m.defaultTarget = m.seats.some((p) => p.id === s.defaultTarget) ? s.defaultTarget : m.seats[0].id;
    const xs = s.extraAgents.filter((x) => !m.seats.some((p) => p.id === x.id)).map((x) => ({ ...x, provider: 'acp', cwd: m.cwd }));
    this.roster = [...m.seats, ...xs];
    // Reserve every saved binding before launching any process; duplicate seats/rooms fail without dispatch.
    for (const p of m.seats) {
      const r = this.slots[p.id] = { seat: p, owner: {}, client: null, models: [] };
      this.bindId(r, p.sessionId);
    }
    const seeds = [];
    for (const r of Object.values(this.slots)) {
      const p = r.seat;
      // Where this seat starts: its own saved conversation (continue), a copy of another one (seat.forkFrom, set by
      // the Start a Room screen), or fresh.
      const others = Object.keys(this.slots).filter((id) => id !== p.id);
      if (p.provider === 'codex') {
        let src = (!p.sessionId && p.forkFrom) || null;
        let action = p.sessionId ? 'continue' : src ? 'fork' : 'new', made;
        const seedFrom = shareSeed[p.id] ? (action === 'continue' ? p.sessionId : src) : null;
        try { made = await this.makeCodex(r, action, p.sessionId || src); }
        catch (e) {
          // Codex saves a thread only after its first turn, so a room closed before this seat ever answered has
          // nothing to resume. If it never spoke here: a copy is made again from the same source conversation, and
          // a thread this room created starts fresh. Anything else (it spoke, or it continued someone's original)
          // keeps failing: never drop history silently.
          const quiet = action === 'continue' && e.noRollout && !this.seatSpoke(p.id) && !this.disposed;
          const ours = (p.typedThreads || []).includes(p.sessionId) && !p.forkFrom;
          if (quiet && p.forkFrom) {
            log(`${p.id}: its saved Codex copy was never written (no turn yet); copying the source again`);
            this.pendingNotes = [...(this.pendingNotes || []), `Codex never saved ${p.label}'s copy because it had no replies yet, so ${p.label} starts from a new copy of the same conversation.`];
            src = p.forkFrom; action = 'fork'; made = await this.makeCodex(r, 'fork', src);
          } else if (quiet && ours) {
            log(`${p.id}: its saved Codex thread was never written (no turn yet); starting a fresh thread`);
            this.pendingNotes = [...(this.pendingNotes || []), `Codex never saved ${p.label}'s earlier conversation because it had no replies yet, so ${p.label} starts a new one.`];
            action = 'new'; made = await this.makeCodex(r, 'new');
          } else throw e;
        }
        if (this.disposed) return;
        r.client = made.client; r.models = made.models; this.bindId(r, made.id);
        if (action === 'new') { p.typed = true; p.typedThreads = [...(p.typedThreads || []), made.id]; }
        r.saved = action === 'continue'; r.since = (this.state && Array.isArray(this.state.transcript) ? this.state.transcript.length : 0);
        if (action === 'fork') { p.typed = false; p.forkFrom = src; }
        if (seedFrom) { let items = []; try { items = await r.client.recentMessages(seedFrom, 8); } catch (e) { log(`history read failed: ${e.message}`); } if (this.disposed) return; seeds.push({ owner: p.id, readers: others, items }); }
      } else {
        const src = p.sessionId ? null : p.forkFrom || null, seedFrom = shareSeed[p.id] ? src || p.sessionId : null;
        if (seedFrom) {
          let items = []; try { const file = claudeHistory.fileFor(seedFrom); if (file) items = claudeHistory.recentMessages(file, 8); } catch (e) { log(`history read failed: ${e.message}`); }
          seeds.push({ owner: p.id, readers: others, items });
        }
        r.client = this.makeClaude(r, p.sessionId, src); p.typed = true;
      }
    }
    this.updateAliases();
    m.extra = m.extra || {}; this.extras = [];
    for (const x of xs) {
      const a = new AcpClient({ exe: x.command, args: x.args, cwd: x.cwd, label: x.label, brief: acpPrompt(x.label, m.humanName, this.peers(x.id).map((p) => p.label)), log });
      this.extraClients.add(a);
      try {
        await a.start(); if (this.disposed) return;
        const old = m.extra[x.id]?.sessionId;
        if (old && a.capabilities.loadSession) await a.loadSession(old);
        else { await a.newSession(); if (old) this.pendingNotes = [...(this.pendingNotes || []), `${x.label} cannot reload its saved session; it started a new private session.`]; }
        if (this.disposed) return;
        m.extra[x.id] = { sessionId: a.sessionId, label: x.label }; this.extras.push({ ...x, client: a });
      } catch (e) { a.stop(); this.extraClients.delete(a); if (this.disposed) return; this.pendingNotes = [...(this.pendingNotes || []), `${x.label} (experimental) could not start: ${e.message}`]; }
    }
    m.participants = [...m.seats, ...this.extras].map(({ id, label, provider, cwd }) => ({ id, label, provider, cwd }));
    const agents = {};
    for (const r of Object.values(this.slots)) {
      const p = r.seat;
      agents[p.id] = { get typed() { return p.typed; }, get lastTurnUsage() { return r.client.lastTurnUsage; },
        send: (text, delta, activity, files, onTool) => (p.provider === 'codex'
          ? this.codexTurn(r, text, delta, activity, files, onTool)
          : r.client.send(text, delta, activity, files, onTool)).finally(() => { this.syncSeats(); if (p.provider === 'codex') this.refreshQuota(); }),
        interrupt: () => r.client.interrupt(), steer: (text, files) => p.provider === 'codex' ? r.client.steer(p.sessionId, text, files) : r.client.steer(text, files) };
    }
    for (const x of this.extras) agents[x.id] = x.client;
    this.history = new HistorySources({ saved: m.history || (m.history = {}), participants: m.participants,
      working: () => Object.fromEntries([...Object.values(this.slots).map((r) => [r.seat.id, { sessionId: r.seat.provider === 'claude' ? r.client.sessionId : r.seat.sessionId }]), ...this.extras.map((x) => [x.id, { sessionId: x.client.sessionId }])]),
      makeReader: ({ provider, sessionId, file }) => provider === 'acp' ? async () => { throw new Error('history reading is not available for ACP agents yet'); } : provider === 'codex' ? async (args) => { if (!this.codex) throw new Error('No local Codex reader is active'); return codexHistoryReader(this.codex)(args); }
        : async (args) => { const f = file || claudeHistory.fileFor(sessionId); if (!f) throw new Error('that Claude session has no saved file yet'); return claudeHistoryReader(f, claudeHistory.ROOT)(args); } });
    // The model tag on each reply: this seat only (controls() builds every seat's menus and checks saved rooms on disk).
    const labelFor = (id) => {
      const r = this.slots[id]; if (!r) return null; const p = r.seat;
      const name = p.provider === 'claude' ? (claudeMenu().find((x) => x.id === (p.model || 'default')) || {}).name
        : ((r.models || []).find((x) => x.id === p.model) || (p.model ? {} : (r.models || [])[0]) || {}).displayName;
      return [name || p.model, p.effort, p.fast ? '⚡' : ''].filter(Boolean).join(' · ');
    };
    this.room = new Room({ agents, state: this.state, humanName: m.humanName, defaultTarget: m.defaultTarget, bothMode: m.bothMode, labelFor, readHistory: (id, args) => this.history.read(id, args), labels: Object.fromEntries(m.participants.map((p) => [p.id, p.label])), postCap: s.agentPosts, modeFor: (id) => (this.slots[id] ? this.slots[id].seat.mode || 'ask' : 'ask') });
    for (const note of this.pendingNotes || []) this.room.note(note); this.pendingNotes = null;
    if (!this.room.tasks.state.defaults) { this.room.tasks.setDefaults(s.taskDefaults); this.room.tasks.mode = s.taskMode; }
    for (const x of seeds) this.room.seedHistory(x.items, x.owner, x.readers.filter((id) => agents[id]));
    if ((m.handoffRule || 0) < HANDOFF_RULE) { if (this.room.state.transcript.length) this.room.note('Wagon Circle is now Wagon Wheel. Agents request assistance through typed room tools where supported; relayed history is reference only.'); m.handoffRule = HANDOFF_RULE; }
    this.room.on('message', (entry) => this.post({ type: 'message', entry: this.view(entry) }));
    this.room.on('draft', (d) => this.post({ type: 'draft', ...d }));
    this.room.on('activity', (a) => this.post({ type: 'activity', ...a }));
    this.room.on('status', (st) => { const r = this.slots[st.name]; this.post({ type: 'status', ...st, participantUsage: r?.client.lastTurnUsage || null, participantCost: r?.client.totalCostUsd }); });
    this.room.on('stop', () => {
      this.switchEpoch = (this.switchEpoch || 0) + 1; for (const r of Object.values(this.slots)) if (r.switchClient) r.switchClient.stop();
      // Stop also ends auto-accept and bypass: after a Stop, every edit asks again.
      const loud = Object.values(this.slots).filter((r) => r.seat.mode && r.seat.mode !== 'ask').map((r) => `${r.seat.label}'s ${r.seat.mode === 'bypass' ? 'bypass' : 'auto-accept'} mode`);
      for (const r of Object.values(this.slots)) r.seat.mode = 'ask';
      if (loud.length) { this.room.note(`Stop turned off ${loud.join(' and ')}: every edit asks you again.`); this.postMeta(); }
      // Stop covers background jobs too: they would otherwise keep working and report back later.
      for (const r of Object.values(this.slots)) { const n = r.client && r.client.stopJobs ? r.client.stopJobs() : 0; if (n) this.room.note(`${r.seat.label}: stopped ${n} background job${n === 1 ? '' : 's'}.`); }
    });
    this.room.on('changed', () => this.save()); this.room.on('task', () => this.postTask());
    // Records that can come many per turn (approval cards) are saved once things settle, not one full write each.
    this.room.on('dirty', () => { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { if (!this.disposed) this.save(); }, 750); });
    this.room.on('approval', (entry) => this.post({ type: 'approval', entry: this.view(entry) }));
    this.scheduler = new Scheduler({ log });
    this.scheduler.add('task-clock', { everyMs: 15000, check: async () => { this.room.tick(); return 'quiet'; } });
    this.scheduler.add('usage', { everyMs: 5 * 60e3, check: async () => { await Promise.all([this.refreshQuota(), this.refreshClaudeUsage(true), this.refreshLocalUsage()]); return 'quiet'; } });
    this.room.on('message', (e) => { if (this.slots[e.from]?.seat.provider === 'claude') this.refreshClaudeUsage(); });
    this.claudeExe = s.claude.path; this.save(); this.refreshQuota(); this.refreshClaudeUsage(true);
  }

  updateAliases() {
    this.codex = Object.values(this.slots).find((r) => r.seat.provider === 'codex')?.client;
    this.claude = Object.values(this.slots).find((r) => r.seat.provider === 'claude')?.client;
    this.codexModels = Object.values(this.slots).find((r) => r.seat.provider === 'codex')?.models || [];
  }

  closeClients() {
    for (const c of this.ownedClients) c.stop(); this.ownedClients.clear();
    for (const c of this.extraClients) c.stop(); this.extraClients.clear();
    for (const r of Object.values(this.slots)) sessionClaims.releaseOwner(r.owner);
    if (roomClaims.get(this.file) === this) { roomClaims.delete(this.file); roomLock.release(this.file); }
  }

  // Claude plan usage via headless `/usage` (no model call, free). Throttled; refreshed after Claude replies.
  async refreshLocalUsage() { const r = await scanLocalUsage(); if (r) this.post({ type: 'localUsage', usage: r }); }

  async refreshClaudeUsage(force) {
    if (this.disposed || !this.claude) return;
    if (!force && this.usageAt && Date.now() - this.usageAt < 45000) return;
    this.usageAt = Date.now();
    const u = await claudeUsage.fetch(this.claudeExe, Object.values(this.slots).find((r) => r.seat.provider === 'claude').seat.cwd);
    if (!u || this.disposed) return;
    this.claudeUsage = u;
    this.post({ type: 'claudeUsage', usage: u });
    this.postMeta();
  }

  // Save this room's model and effort for a vendor as the defaults for new rooms (user settings).
  async saveDefaults(id) {
    const r = this.slots[id]; if (!r) return;
    const p = r.seat, cfg = config(), G = vscode.ConfigurationTarget.Global;
    await cfg.update(p.provider + 'Model', p.model || '', G); await cfg.update(p.provider + 'Effort', p.effort || '', G);
    if (!this.disposed) this.room.note(`Saved ${p.label}'s model and effort as defaults for new ${p.provider === 'claude' ? 'Claude Code' : 'Codex'} seats. Existing seats keep their settings.`);
  }

  async refreshQuota() {
    if (this.disposed || !this.codex) return;
    let r; try { r = await this.codex.rateLimits(); } catch { return; }
    if (!r || this.disposed) return;
    const snap = r.rateLimits || {};
    this.quota = { primary: snap.primary, secondary: snap.secondary, resetCredits: r.rateLimitResetCredits ? Number(r.rateLimitResetCredits.availableCount) : null, reached: snap.rateLimitReachedType || null };
    this.post({ type: 'quota', quota: this.quota });
  }

  attach(panel) {
    this.panel = panel; sessions.add(this);
    panel.webview.onDidReceiveMessage((m) => {
      if (this.disposed || !m || typeof m !== 'object') return;
      if (this.refusal && !this.room && m.type !== 'ready') return; // a refused room's panel only shows why
      if (m.type === 'ready') this.postInit();
      else if ((m.type === 'send' || m.type === 'steer') && this.room && typeof m.text === 'string') {
        const files = (Array.isArray(m.attachmentIds) ? m.attachmentIds : []).map((id) => this.pendingAtts.get(id)).filter(Boolean);
        files.forEach((f) => this.pendingAtts.delete(f.id));
        const snap = m.ide && this.meta.ideContext !== false ? ideSnapshot(this.meta.cwd) : null;
        const ide = snap ? { summary: ideContext.summary(snap), text: ideContext.format(snap) } : null;
        if (!m.text.trim() && !files.length) return;
        if (m.type === 'steer') this.room.steerFromHuman(m.text.trim(), files, ide);
        else this.room.postFromHuman(m.text.trim(), files, ide);
      }
      else if (m.type === 'saveDefaults' && this.slots[m.vendor]) this.saveDefaults(m.vendor);
      else if (m.type === 'historyShare' && this.room) this.shareHistory(m.source, m.reader, !!m.on, m.allHistory);
      else if (m.type === 'toggleIde') { this.meta.ideContext = !!m.on; this.postMeta(); }
      else if (m.type === 'openDiff' && typeof m.diff === 'string') openDiff(m.diff, this.meta.cwd);
      else if (m.type === 'command' && this.room && typeof m.text === 'string') this.runCommand(m.text).catch((e) => { if (!this.disposed) this.room.note(`Command failed: ${e.message}`); });
      else if (m.type === 'attachData' && typeof m.data === 'string') this.addAttachment({ name: m.name, data: m.data });
      else if (m.type === 'attachUris' && Array.isArray(m.uris)) m.uris.forEach((u) => { try { this.addAttachment({ name: path.basename(vscode.Uri.parse(u).fsPath), fromPath: vscode.Uri.parse(u).fsPath }); } catch (e) { this.post({ type: 'attachError', text: e.message }); } });
      else if (m.type === 'pickFiles') vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' }).then((uris) => (uris || []).forEach((u) => this.addAttachment({ name: path.basename(u.fsPath), fromPath: u.fsPath })));
      else if (m.type === 'unattach') { const a = this.pendingAtts.get(m.id); if (a) { this.pendingAtts.delete(m.id); fs.rm(a.path, () => {}); } }
      else if (m.type === 'stop' && this.room) this.room.stopAll();
      else if (m.type === 'approval' && this.room && typeof m.id === 'string' && ['allow', 'allowTask', 'deny'].includes(m.decision)) this.room.answerApproval(m.id, m.decision);
      else if (m.type === 'approvalFull' && this.room && typeof m.id === 'string') {
        const p = this.room.pendingApprovals.get(m.id);
        // A read-only view (the room's own document scheme), so closing VS Code never asks to save it.
        if (p && p.full) { const key = `/change-${m.id}-${Date.now()}.${p.kind === 'command' ? 'sh' : 'diff'}`; proposed.set(key, p.full); vscode.workspace.openTextDocument(vscode.Uri.parse(`wagon-wheel-proposed:${key}`)).then((d) => vscode.window.showTextDocument(d, { preview: true }), (e) => log(`full change: ${e.message}`)); }
      }
      else if (m.type === 'copy' && this.room && this.meta.copy && ['open', 'bringIn', 'remove', 'refresh'].includes(m.action)) this.copyAction(m.action).catch((e) => this.room && this.room.note(`Separate copy: ${e.message}`));
      else if (m.type === 'moveOut' && this.room && this.slots[m.vendor]) this.moveOut(m.vendor).catch((e) => this.room && this.room.note(`Couldn't move the conversation out: ${e.message}`));
      else if (m.type === 'copyResume' && this.room && this.slots[m.vendor] && ['source', 'fork'].includes(m.which)) {
        const cmd = this.resumeCommand(m.vendor, m.which);
        if (!cmd) this.room.note(m.which === 'source' ? (this.controls()[m.vendor].sourceInUse === 'unknown' ? 'Wagon Wheel can\'t read its saved rooms right now, so it can\'t confirm nothing is writing to the original. Use Continue a copy yourself, or try again in a moment.' : `Another agent is keeping going in ${this.slots[m.vendor].seat.label}'s original, so it can't be opened safely right now. Use Continue a copy yourself instead.`) : `${this.slots[m.vendor].seat.label}'s conversation isn't saved yet. It is saved after its first reply.`);
        else vscode.env.clipboard.writeText(cmd).then(() => vscode.window.setStatusBarMessage(`Wagon Wheel: copied "${cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd}". Paste it in a terminal to open that conversation.`, 6000));
      }
      else if (m.type === 'session' && this.room && this.slots[m.vendor] && ['new', 'switch', 'continue', 'fork'].includes(m.action)) this.switchSession(m.vendor, m.action).catch((e) => { if (!this.disposed) this.room.note(`Couldn't switch the working session: ${e.message}`); });
      else if (m.type === 'taskPause' && this.room) this.room.pauseTask();
      else if (m.type === 'taskResume' && this.room) this.room.resumeTask();
      else if (m.type === 'taskMode' && this.room && ['auto', 'chat', 'work'].includes(m.mode)) { this.room.tasks.mode = m.mode; this.room.note(`Mode: ${MODE_TEXT[m.mode]}`); this.postTask(); }
      else if ((m.type === 'taskLimits' || m.type === 'taskDefaults') && this.room && m.limits) {
        const lim = cleanLimits(m.limits);
        if (m.type === 'taskLimits') this.room.setTaskLimits(lim);
        else { this.room.tasks.setDefaults(lim); { const d = this.room.tasks.defaults, G = vscode.ConfigurationTarget.Global; config().update('taskTurns', d.turns, G); config().update('taskReserve', d.reserve, G); config().update('taskMinutes', d.minutes, G); } this.room.note(`Saved as your defaults for new tasks: ${lim.turns} turns (${lim.reserve} kept for wrapping up), ${lim.minutes} minutes. Tasks already running keep their own settings.`); }
        this.postTask();
      }
    });
    panel.onDidDispose(() => this.dispose());
  }

  post(msg) { if (!this.disposed && this.panel) this.panel.webview.postMessage(msg); }

  shareHistory(source, reader, on, allHistory) {
    if (this.disposed || !this.history || !this.slots[source] || !Object.hasOwn(this.room.agents, reader) || source === reader) return;
    this.history.shareWith(source, reader, on, { allHistory });
    this.room.note(`${this.room.labels[source]}'s working history ${on ? 'is now shared with' : 'is no longer shared with'} ${this.room.labels[reader]}. Earlier passages already read remain in that session. ${LOCAL_ONLY}`);
    this.postMeta();
  }

  async addHistorySource() {
    const claudeItems = claudeHistory.listSessions(40).map((x) => ({ label: `Claude Code: ${x.title || x.preview}`, detail: x.cwd, src: { provider: 'claude', sessionId: x.id, title: x.title || x.preview, file: x.path } }));
    let threads = []; try { if (this.codex) threads = await this.codex.listThreads(null, 40); } catch (e) { log(`codex list: ${e.message}`); }
    if (this.disposed) return;
    const codexItems = threads.map((t) => ({ label: `Codex: ${t.name || (t.preview || '').slice(0, 80) || t.id}`, detail: t.cwd, src: { provider: 'codex', sessionId: t.id, title: t.name || t.preview || t.id } }));
    const pick = await vscode.window.showQuickPick([...claudeItems, ...codexItems], { title: 'Add local session history as reference', matchOnDetail: true });
    if (!pick || this.disposed) return;
    const alreadyAdded = () => {
      const existing = this.history.saved.sources.find((s) => s.provider === pick.src.provider && s.sessionId === pick.src.sessionId);
      if (!existing) return false;
      this.room.note(`Already added as ${existing.id}. Readers and history range are unchanged. To replace its sharing policy, use /history remove ${existing.id}, then add it again. Passages already read remain in those sessions.`);
      return true;
    };
    if (alreadyAdded()) return;
    const readers = await vscode.window.showQuickPick(this.meta.participants.map((p) => ({ label: p.label, description: p.id, id: p.id })), { title: 'Which participants may read this source?', canPickMany: true });
    if (!readers?.length || this.disposed) return;
    const span = await vscode.window.showQuickPick([{ label: 'Include all earlier history', all: true }, { label: 'Only from now on', all: false }], { title: 'How much of this source may they read?' });
    if (!span || this.disposed) return;
    if (alreadyAdded()) return; // another picker may have added it while this one awaited consent
    const source = this.history.add({ ...pick.src, allHistory: span.all, readers: readers.map((x) => x.id) });
    this.room.note(`Added ${source.title} as ${source.id}, reference for ${readers.map((x) => x.label).join(', ')}. Old requests and approvals are evidence, not instructions.`); this.postMeta();
  }

  // Working session picker. New starts fresh; Fork branches a copy (the original is never written); Continue
  // resumes the chosen session itself, so the human is warned first: Wagon Wheel cannot see whether another
  // Claude Code or Codex window has it open. Switches wait for the agent to be idle; the room's cursor, tasks and
  // allowances stay, and the room history is not replayed into the new session.
  async switchSession(id, action) {
    const r = this.slots[id], room = this.room;
    if (!r || !room || this.disposed) return;
    const p = r.seat, L = p.label;
    const unresolved = () => room.held.has(id) || room.tasks._requests().some((q) => ['open', 'delivered'].includes(q.status) && (q.from === id || q.to === id));
    if ((r.jobs || []).length) { room.note(`${L} has a background job running. Let it finish, or press Stop, before changing its conversation.`); return; }
    if (room.busy[id] || r.switching || unresolved()) { room.note(`${L} is busy. Let it finish, or press Stop, before changing its conversation.`); return; }
    const epoch = this.switchEpoch || 0, live = () => !this.disposed && (this.switchEpoch || 0) === epoch;
    const cursor = room.state.transcript.length;
    r.switching = true; room.busy[id] = true; room.emit('status', { name: id, busy: true, since: Date.now() });
    let reserved = null, made = null, adopted = false;
    try {
      let pick = null;
      if (action !== 'new') {
        const made = startRoom.roomMade(roomsView.listRooms(path.dirname(this.file))); // hide Wagon Wheel's own room conversations
        const items = p.provider === 'claude'
          ? claudeHistory.listSessions(80).filter((x) => x.cwd === p.cwd && x.id !== p.sessionId && !startRoom.isRoomConversation('claude', x, made)).map((x) => ({ label: x.title || x.preview, id: x.id, mtime: x.mtime, name: x.title || x.preview }))
          : (await r.client.listThreads(null, 80)).filter((t) => t.id !== p.sessionId && !startRoom.isRoomConversation('codex', { ...t, originator: startRoom.codexOriginator(t.path) }, made) && !startRoom.isChatConversation('codex', t, startRoom.codexChatIds())).map((t) => ({ label: t.name || (t.preview || '').slice(0, 80) || t.id, detail: t.cwd, id: t.id, mtime: t.updatedAt ? t.updatedAt * 1000 : null, name: t.name || t.preview }));
        if (!live()) return;
        if (!items.length) { room.note(`No other ${p.provider === 'claude' ? `Claude conversations from ${L}'s folder` : 'Codex conversations'} were found for ${L}.`); return; }
        pick = await vscode.window.showQuickPick(items, { title: `${L}: ${action === 'switch' ? 'switch to one of your conversations' : action === 'fork' ? 'work on a copy of a conversation' : 'keep going in a conversation'}`, placeHolder: 'Your recent conversations, newest first', matchOnDetail: true });
        if (!pick || !live()) return;
        // In a separate copy, agents use copies of conversations: an original would carry the copy's folder home.
        if (action === 'continue' && this.meta.copy) { room.note(`In a separate copy, ${L} can use a copy of that conversation, not the original.`); action = 'fork'; }
        if (action === 'switch' && this.meta.copy) action = 'fork';
        if (action === 'switch') {
          const how = await vscode.window.showQuickPick([
            { label: 'Work on a copy (recommended)', detail: 'Your original conversation stays exactly as it is. The agent continues from a copy.', action: 'fork' },
            { label: 'Keep going in the original', detail: 'Adds to your original conversation. Only choose this if it is not open anywhere else right now.', action: 'continue' }],
            { title: `${L}: use "${String(pick.name || pick.id).slice(0, 50)}" how?` });
          if (!how || !live()) return;
          action = how.action;
        }
        if (action === 'continue') {
          const recent = pick.mtime && Date.now() - pick.mtime < 120000;
          const go = await vscode.window.showWarningMessage(`Keep going in "${String(pick.name || pick.id).slice(0, 60)}" as ${L}?`, { modal: true,
            detail: `${recent ? 'It changed in the last two minutes, so it may be open somewhere else right now. ' : ''}${L} will add to that conversation directly. Wagon Wheel stops its other agents and rooms in this window from using it, but it can't see other apps or VS Code windows. Close it there first, or use a copy.` }, 'Keep going in the original', 'Use a copy instead');
          if (!go || !live()) return; if (go === 'Use a copy instead') action = 'fork';
        }
      }
      if (!live() || unresolved()) { if (live()) room.note(`${L} was given new work in the meantime, so its conversation was not changed.`); return; }
      if (action === 'continue') {
        const why = this.whyInUse(p.provider, pick.id);
        if (why) throw new Error(why === 'agent' ? 'That conversation is already in use by another agent or room. Use a copy instead.' : 'Wagon Wheel can\'t read its saved rooms right now, so it can\'t confirm nothing else is using that conversation. Use a copy, or try again in a moment.');
        if (!sessionClaims.claim(p.provider, pick.id, r.owner)) throw new Error('That conversation is already in use by another agent or room. Use a copy instead.');
        reserved = pick.id;
      }
      if (p.provider === 'codex') {
        made = await this.makeCodex(r, action, pick?.id, live); if (!made || !live()) return;
      } else made = { client: this.makeClaude(r, action === 'continue' ? pick.id : null, action === 'fork' ? pick.id : null), id: action === 'continue' ? pick.id : null };
      if (!live() || unresolved()) return;
      const old = r.client;
      this.bindId(r, made.id); r.client = made.client; r.models = made.models || [];
      p.forkFrom = action === 'fork' ? pick.id : null;
      const sources = { ...(this.meta.sources || {}) };
      if (action === 'new') delete sources[id]; else sources[id] = { kind: action === 'fork' ? 'copy' : 'original', id: pick.id, title: pick.name ? String(pick.name).slice(0, 120) : null };
      this.meta.sources = sources;
      if (p.provider === 'codex') { if (action === 'new') p.typedThreads = [...(p.typedThreads || []), made.id]; p.typed = (p.typedThreads || []).includes(made.id); r.saved = action === 'continue'; r.since = cursor; }
      this.history.resetParticipant(id); room.state.cursors[id] = cursor;
      old.stop(); this.ownedClients.delete(old); adopted = true;
      this.updateAliases();
      room.note(`${L} now uses ${action === 'new' ? 'a brand-new conversation' : action === 'fork' ? `a copy of "${String(pick.name || pick.id).slice(0, 50)}"` : `your original "${String(pick.name || pick.id).slice(0, 50)}"`}. It doesn't see the room's earlier messages. Sharing settings for it were reset; the task keeps its turn count.${p.provider === 'codex' && !p.typed ? ' Other agents reach it with @mentions, because a conversation brought in from Codex can\'t use the room\'s hand-off tools.' : ''}`);
      this.postMeta(); this.postTask();
    } finally {
      if (reserved && !adopted) sessionClaims.release(p.provider, reserved, r.owner);
      if (made && !adopted) { made.client.stop(); this.ownedClients.delete(made.client); }
      r.switchClient = null; r.switching = false; room.busy[id] = false; room.emit('status', { name: id, busy: false });
      const pending = room.pending[id]; room.pending[id] = 0;
      if (pending && !this.disposed) room.deliver(id, pending);
    }
  }

  // Read only / can edit / can edit and run commands. One agent above read only per room; raising a level in your own
  // folder asks first. Claude restarts on the same conversation with the new tools; Codex applies it from its next turn.
  async setAccess(r, level) {
    const room = this.room, p = r.seat, L = p.label, now = p.access || 'read';
    if (!['read', 'edit', 'run'].includes(level) || level === now) return;
    if (room.busy[p.id] || (r.jobs || []).length) { room.note(`${L} is busy. Let it finish, or press Stop, before changing what it can do.`); return; }
    // In a separate-copy room, only an agent working inside the copy can edit: the room promises your folder is untouched.
    if (level !== 'read' && this.meta.copy && !editPolicy.within(p.cwd, this.meta.copy.dir)) { room.note(`In this room edits happen in the separate copy, and ${L} works in ${p.cwd}, outside it. Only an agent working in the copy can edit here.`); return; }
    const other = Object.values(this.slots).find((o) => o !== r && (o.seat.access || 'read') !== 'read');
    if (level !== 'read' && other) { room.note(`Only one agent in a room can edit files, and ${other.seat.label} already can. Set ${other.seat.label} to read only first.`); return; }
    if (level !== 'read' && now === 'read') {
      const where = this.meta.copy ? `the separate copy of your project (branch ${this.meta.copy.branch})` : p.cwd;
      const go = await vscode.window.showWarningMessage(`Let ${L} ${level === 'run' ? 'edit files and run commands' : 'edit files'} in ${where}?`, { modal: true,
        detail: `Every ${level === 'run' ? 'edit and command' : 'edit'} asks you first, as a card in the room. Files outside ${where === p.cwd ? 'that folder' : 'the copy'} are refused.${level === 'run' ? ` ${p.provider === 'codex' ? 'A command you allow runs outside Codex\'s sandbox.' : 'A command you allow runs with your user account.'}` : ''}` }, level === 'run' ? 'Allow edits and commands' : 'Allow edits');
      if (!go || this.disposed || room.busy[p.id]) return;
      const took = Object.values(this.slots).find((o) => o !== r && (o.seat.access || 'read') !== 'read'); // changed while the question was open
      if (took) { room.note(`Only one agent in a room can edit files, and ${took.seat.label} already can.`); return; }
    }
    p.access = level; room.clearAllowRules(p.id);
    if (p.mode && p.mode !== 'ask' && (level === 'read' || (p.mode === 'bypass' && level !== 'run'))) p.mode = 'ask'; // a mode never outlives the level it needs
    if (p.provider === 'claude') {
      const effort = p.effort === ULTRACODE && level !== 'read' ? 'xhigh' : undefined; if (effort) p.effort = effort;
      r.client.systemPrompt = this.brief(r, true); r.client.setOptions({ access: level, ...(effort ? { effort } : {}) });
    } else r.client.access = level;
    const text = { read: 'read only', edit: 'able to edit files, asking you before each edit', run: 'able to edit files and run commands, asking you before each one' }[level];
    room.note(`${L} is now ${text}.${p.provider === 'claude' && p.effort === 'xhigh' && level !== 'read' ? ' Its effort changed from Ultracode to Extra high: Ultracode is for read-only agents.' : ''}`);
    this.save();
  }

  // Ask me / Auto-accept edits / Bypass. The room answers on the person's behalf, after its own refusals (outside the
  // folder, git's folder, unseen changes), so nothing a mode allows is invisible: each is a line in the room. Bypass
  // needs the wagonWheel.allowBypass setting and a warning each time; it ends on Stop and when the room closes.
  async setMode(r, mode) {
    const room = this.room, p = r.seat, L = p.label, access = p.access || 'read';
    if (!['ask', 'auto', 'bypass'].includes(mode)) return;
    // Ask me also revokes any "Allow edits for this task" it had, even when it is already on Ask me.
    if (mode === 'ask') {
      const had = (room.state.allowRules || []).some((x) => x.seat === p.id); room.clearAllowRules(p.id);
      if ((p.mode || 'ask') === 'ask') { if (had) { room.note(`${L}'s edits for this task are no longer allowed ahead of time: it asks you before each one again.`); this.save(); } return; }
    }
    if (mode === (p.mode || 'ask')) return;
    if (access === 'read') { room.note(`${L} can only read, so there is nothing to accept. Let it edit first.`); return; }
    if (mode === 'bypass' && access !== 'run') { room.note(`Bypass is for an agent that can also run commands. For ${L}, Auto-accept edits does the same for edits.`); return; }
    if (mode === 'bypass' && !this.options.allowBypass) { room.note('Bypass is off in your settings. To offer it, turn on "Wagon Wheel: Allow Bypass" (wagonWheel.allowBypass) in Settings.'); return; }
    if (mode === 'bypass') {
      const go = await vscode.window.showWarningMessage(`Let ${L} edit files and run commands without asking you?`, { modal: true,
        detail: `Bypass skips every card. Commands run the moment ${L} asks, with your user account${p.provider === 'codex' ? ' and outside Codex\'s sandbox' : ''}, and can change or delete anything you can. Wagon Wheel still refuses edits outside ${p.cwd} and inside git's own folder, and records each action in the room. Stop turns bypass off, and so does closing the room. Use it only for work you'd let ${L} do unattended.` }, 'Turn on bypass');
      if (go !== 'Turn on bypass' || this.disposed || (p.access || 'read') !== 'run') return;
    }
    p.mode = mode;
    room.note(mode === 'ask' ? `${L} asks you before each ${access === 'run' ? 'edit and command' : 'edit'} again.`
      : mode === 'auto' ? `${L} auto-accepts edits in its folder; each shows as a line in the room. Commands, and files that can run code, still ask. Stop turns this off.`
      : `Bypass is on for ${L}: its edits and commands go ahead without asking. Each shows as a line in the room. Stop turns it off.`);
    this.save();
  }

  // The separate copy: open it, bring its changes into your folder (a command you run), or remove it (same).
  async copyAction(action) {
    const c = this.meta.copy, room = this.room;
    if (action === 'open') { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(c.dir), { forceNewWindow: true }); return; }
    if (action === 'refresh') { try { this.post({ type: 'copyChanges', changes: await copyMode.changes(c) }); } catch (e) { log(`copy changes: ${e.message}`); } return; } // a count; never a room note
    const busy = Object.values(room.busy).some(Boolean);
    const cmd = action === 'bringIn' ? copyMode.bringInCommand(c, this.meta.name) : copyMode.removeCommand(c);
    await vscode.env.clipboard.writeText(cmd);
    room.note(action === 'bringIn'
      ? `Copied a command that brings the copy's changes into ${c.repo}: it commits them on ${c.branch}, then merges that branch into the branch you have checked out there. Paste it in a terminal when you're ready.${busy ? ' An agent is still working; wait for it to finish first.' : ''}`
      : `Copied a command that removes the copy and its branch ${c.branch}. Anything not brought into your folder is lost. Close this room first.`);
  }

  postTask() {
    if (!this.room) return;
    const t = this.room.tasks;
    this.post({ type: 'task', task: t.summary(), mode: t.mode, defaults: t.defaults, presets: PRESETS, typed: Object.fromEntries(Object.entries(this.room.agents).map(([id, a]) => [id, !!a.typed])) });
  }

  claudeFastOk(model) {
    const cat = claudeMenu().find((x) => x.id === (model || 'default'));
    return !!(cat && cat.fast && atLeast(this.claudeVersion, '2.1.205'));
  }

  // What the pickers show: each vendor's models, efforts and fast mode, gated by what this machine can run.
  // Which of the person's conversations a seat started from: { kind: 'copy'|'original', id, title } or null (fresh).
  sourceOf(p) {
    const known = this.meta.sources && this.meta.sources[p.id];
    if (known && typeof known.id === 'string') return known;
    if (p.forkFrom) return { kind: 'copy', id: p.forkFrom, title: null };
    return null;
  }

  // Rooms made before sources were recorded (or by Switch without a title) look the title up once after starting.
  async fillSourceTitles() {
    let changed = false;
    for (const r of Object.values(this.slots)) {
      const p = r.seat, src = this.sourceOf(p);
      if (!src || src.title) continue;
      let title = null;
      try {
        if (p.provider === 'claude') title = claudeHistory.titleFor(src.id);
        else if (r.client) {
          let t = null; try { t = (await r.client.request('thread/read', { threadId: src.id }, 20000)).thread; } catch { /* older CLI: fall back to the list */ }
          if (!t) t = (await r.client.listThreads(null, 100)).find((x) => x.id === src.id);
          title = t ? t.name || t.preview : null;
        }
      } catch (e) { log(`source title: ${e.message}`); }
      if (this.disposed) return;
      if (title) { this.meta.sources = { ...(this.meta.sources || {}), [p.id]: { ...src, title: String(title).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) } }; changed = true; }
    }
    if (changed) this.postMeta();
  }

  // Whether a Codex seat's current thread is saved: a resumed thread is (resume only works on saved ones), and a new
  // thread or copy is once the seat has answered since the room started using it (r.since, a transcript index).
  codexSaved(r) {
    if (r.saved) return true;
    const t = this.room ? this.room.state.transcript : this.state && this.state.transcript;
    return Array.isArray(t) && t.slice(r.since || 0).some((e) => e && e.from === r.seat.id && e.kind !== 'history');
  }

  // This seat's own conversation id, or null when it has none yet that its app could open: a Claude copy gets one with
  // its first reply, and Codex saves a thread only after its first reply.
  ownConversation(id) {
    const r = this.slots[id]; if (!r) return null;
    const p = r.seat;
    if (p.provider === 'claude') return r.client?.sessionId || p.sessionId || null;
    return p.sessionId && this.codexSaved(r) ? p.sessionId : null;
  }

  // Is a person's original also being written by an agent in some room (claimed here, or bound in a saved room)?
  // Fails closed: a room file that can't be read right now (being written, too large to load, corrupt) counts as in use.
  // This room's own seats are in memory (the claims above), so its own file is skipped: a long room never blocks itself.
  sourceInUse(provider, convId) { return this.whyInUse(provider, convId) !== null; }
  whyInUse(provider, convId) {
    if (sessionClaims.isClaimed(provider, convId)) return 'agent';
    try {
      // One listing: the rooms searched and the unreadable count must describe the same moment.
      const listed = roomsView.listRooms(path.dirname(this.file), this.roomsCache || (this.roomsCache = new Map()));
      const rooms = listed.filter((room) => room.file !== this.file);
      if (rooms.some((room) => room.seats.some((x) => x.provider === provider && x.sessionId === convId))) return 'agent';
      // Unreadable files are not in the list at all; one that was listed unparsed (too large) can't be ruled out either.
      if ((listed.unreadable || 0) > 0 || rooms.some((room) => room.large)) return 'unknown';
      return null;
    } catch { return 'unknown'; }
  }

  // Commands that open a conversation in its own app, built here from ids the room holds (never from the page):
  // 'source' reopens the person's original a copy came from; 'fork' opens a copy of this agent's conversation as it
  // is now; 'resume' reopens this agent's own conversation (only offered once the room has let go of it).
  resumeCommand(id, which) {
    const r = this.slots[id]; if (!r) return null;
    const p = r.seat, src = this.sourceOf(p);
    // 'source' only for a copy, and never while any agent keeps going in that original: no second writer.
    if (which === 'source' && (!src || src.kind !== 'copy' || this.sourceInUse(p.provider, src.id))) return null;
    const conv = which === 'source' ? src.id : this.ownConversation(id);
    if (typeof conv !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(conv)) return null;
    const cd = `cd '${String(p.cwd).replace(/'/g, `'\\''`)}' && `;
    if (p.provider === 'codex') return `${cd}codex ${which === 'fork' ? 'fork' : 'resume'} ${conv}`;
    return `${cd}claude --resume ${conv}${which === 'fork' ? ' --fork-session' : ''}`;
  }

  // Move an agent's conversation out of the room: the agent starts over here, and the person gets the command to keep
  // going in that conversation in Claude Code or Codex. The room stops writing to it before the command is handed over.
  async moveOut(id) {
    const r = this.slots[id]; if (!r || !this.room || this.disposed) return;
    const p = r.seat, L = p.label, app = p.provider === 'claude' ? 'Claude Code' : 'Codex';
    const cmd = this.resumeCommand(id, 'resume');
    if (!cmd) { this.room.note(`${L}'s conversation isn't saved yet. It is saved after ${L}'s first reply.`); return; }
    const go = await vscode.window.showWarningMessage(`Move ${L}'s conversation out of the room?`, { modal: true,
      detail: `${L} starts a fresh conversation here and won't remember this one. You keep going in this one yourself in ${app}: the command to open it is copied to your clipboard.` }, 'Move it out');
    if (go !== 'Move it out' || this.disposed) return;
    const before = r.client;
    await this.switchSession(id, 'new');
    if (r.client === before || this.disposed) return; // the switch was refused (busy, pending work); its note says why
    await vscode.env.clipboard.writeText(cmd);
    this.room.note(`${L}'s earlier conversation has left the room, and ${L} starts fresh. To keep going in it, paste this in a terminal: ${cmd}`);
  }

  controls() {
    const v = this.claudeVersion;
    return Object.fromEntries(Object.values(this.slots).map((r) => {
      const p = r.seat;
      const models = p.provider === 'claude'
        ? claudeMenu().map((x) => ({ ...x, available: x.minCli ? atLeast(v, x.minCli) : true, blocked: claudeUsage.blockFor(this.claudeUsage, limitName(x)), fastOk: !!x.fast && atLeast(v, '2.1.205') }))
        : r.models.map((x) => ({ id: x.id, name: x.displayName, note: typeof x.description === 'string' ? x.description.slice(0, 120) : '', efforts: (x.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), defaultEffort: x.defaultReasoningEffort, fast: (x.serviceTiers || []).find((t) => t.id === 'priority') || null }));
      return [p.id, { provider: p.provider, label: p.label, cwd: p.cwd, source: this.sourceOf(p),
        own: this.ownConversation(p.id), // null until its app has saved it (first reply)
        sourceInUse: (() => { const src = this.sourceOf(p); return src && src.kind === 'copy' ? this.whyInUse(p.provider, src.id) || false : false; })(), // 'agent' | 'unknown' | false
        session: r.client?.sessionId || p.sessionId || p.forkFrom, typed: !!p.typed,
        shared: !!this.history?.describe().share[p.id], readers: this.history ? this.history.readers(p.id) : [], allHistory: !this.history || this.history.allHistory(p.id),
        cli: p.provider === 'claude' && v ? v.join('.') : undefined, model: p.model || models[0]?.id || null, effort: p.effort, fast: !!p.fast, models,
        jobs: r.jobs || [], access: p.access || 'read', mode: p.mode || 'ask', allowBypass: !!(this.options && this.options.allowBypass), editorElsewhere: Object.values(this.slots).some((o) => o !== r && (o.seat.access || 'read') !== 'read'),
        efforts: p.provider === 'claude' ? (() => { const cat = claudeMenu().find((x) => x.id === (p.model || 'default')); return cat ? claudeEfforts(cat, v, p.access) : commands.CLAUDE_EFFORTS; })() : undefined }];
    }));
  }

  cmdSpecs() { return commands.specs({ participants: this.meta.participants || [], controls: this.controls() }); }

  postMeta() { this.save(); this.post({ type: 'meta', meta: this.meta, commands: this.cmdSpecs(), controls: this.controls() }); }

  async runCommand(text) {
    if (this.disposed || !this.room) return;
    const room = this.room, m = this.meta;
    const { spec, arg, error } = commands.parse(text, this.cmdSpecs());
    if (error) { room.note(error); return; }
    const say = (t) => room.note(t);
    if (spec.participant) {
      const r = this.slots[spec.participant]; if (!r) return;
      const p = r.seat, action = spec.action;
      if (action === 'session') { await this.switchSession(p.id, arg); return; }
      if (action === 'access') { await this.setAccess(r, arg); this.postMeta(); return; }
      if (action === 'mode') { await this.setMode(r, arg); this.postMeta(); return; }
      if (action === 'model' || action === 'effort') {
        if (p.provider === 'claude') {
          const cat = claudeMenu().find((x) => x.id === arg);
          const blocked = action === 'model' && cat && claudeUsage.blockFor(this.claudeUsage, limitName(cat));
          if (blocked) { say(`${p.label}: ${blocked}. Model unchanged.`); return; }
          if (action === 'effort') {
            const now = claudeMenu().find((x) => x.id === (p.model || 'default'));
            if (now && !claudeEfforts(now, this.claudeVersion, p.access).includes(arg)) { say(arg === ULTRACODE && p.access !== 'read' ? `Ultracode is for read-only agents: a workflow's agents can't ask you before editing. Set ${p.label} to read only first.` : `${now.name} doesn't offer that effort level.`); return; }
          }
          if (action === 'model' && p.fast && !this.claudeFastOk(arg)) { p.fast = false; r.client.setOptions({ fast: false }); }
          const opts = { [action]: arg };
          // A model that doesn't offer the current effort level (Haiku has none) starts without one, in the same restart.
          if (action === 'model' && p.effort && cat && !claudeEfforts(cat, this.claudeVersion, p.access).includes(p.effort)) { p.effort = null; opts.effort = null; }
          r.client.setOptions(opts);
        } else if (action === 'model') {
          const model = r.models.find((x) => x.id === arg);
          if (p.effort && model && !(model.supportedReasoningEfforts || []).some((e) => e.reasoningEffort === p.effort)) p.effort = null;
        }
        p[action] = arg;
        if (arg === ULTRACODE) say(`${p.label} effort set to Ultracode: Extra high, plus background workflows. Their agents can only read, like ${p.label}, and when one finishes ${p.label} posts the result here on its own (at most ${this.room.postCap} per task). Uses your plan faster.`);
        else say(`${p.label} ${action} set to ${arg}. Its conversation and the task's turn count stay the same.${p.provider === 'claude' && (r.jobs || []).length ? ` It switches once its background job${r.jobs.length === 1 ? '' : 's'} finish.` : ''}`);
      } else if (action === 'fast') {
        const on = arg === 'on', c = this.controls()[p.id], model = c.models.find((x) => x.id === c.model);
        if (on && !(p.provider === 'claude' ? this.claudeFastOk(p.model) : model?.fast)) { say(`Fast mode is not available for ${p.label}'s selected model.`); return; }
        p.fast = on; if (p.provider === 'claude') r.client.setOptions({ fast: on });
        say(`${p.label} fast mode ${on ? 'on; uses additional provider allowance' : 'off'}.`);
      } else if (action === 'compact') {
        if (room.busy[p.id]) { say(`${p.label} is busy.`); return; }
        room.busy[p.id] = true; room.emit('status', { name: p.id, busy: true, since: Date.now() });
        try { await (p.provider === 'claude' ? r.client.compact() : r.client.compact(p.sessionId)); say(`${p.label} compacted its context.`); }
        catch (e) { say(`${p.label} compact failed: ${e.message}`); }
        finally { room.busy[p.id] = false; room.emit('status', { name: p.id, busy: false }); const pending = room.pending[p.id]; room.pending[p.id] = 0; if (pending && !this.disposed) room.deliver(p.id, pending); }
      }
      this.postMeta(); return;
    }
    switch (spec.cmd) {
      case '/help': {
        const lines = []; let g = null;
        for (const s of this.cmdSpecs()) { if (s.group !== g) { g = s.group; lines.push(`${g}:`); } lines.push(`  ${s.cmd}${s.args ? ' <' + s.args.slice(0, 4).join('|') + (s.args.length > 4 ? '|…' : '') + '>' : ''}: ${s.desc}`); }
        say(lines.join('\n')); return;
      }
      case '/stop': room.stopAll(); return;
      case '/history add': await this.addHistorySource(); return;
      case '/history remove': {
        const items = this.history.describe().sources.map((x) => ({ label: `${x.id}: ${x.title}`, description: x.provider, id: x.id }));
        if (!items.length) { say('No history sources to remove.'); return; }
        const pick = await vscode.window.showQuickPick(items, { title: 'Stop sharing a history source' });
        if (pick && this.history.remove(pick.id)) say(`${pick.label} is no longer shared. Passages the agents already read stay in their context.`);
        break;
      }
      case '/history all': {
        const [id, on] = arg.split(' ');
        if (!this.history.setAllHistory(id, on === 'on')) { say(`${id} is not shared.`); break; }
        say(on === 'on' ? `${id}: the agents can read its whole history.` : `${id}: the agents can read only what is said from now on. Passages they already read stay in their context.`);
        break;
      }
      case '/history share': {
        const [source, reader, on] = arg.split(' ');
        if (on) { this.shareHistory(source, reader, on === 'on'); return; }
        if (!this.slots[source]) return;
        this.history.share(source, reader === 'on', { allHistory: true });
        say(`${room.labels[source]}'s history ${reader === 'on' ? 'shared with all current peers' : 'no longer shared'}. Earlier passages remain in sessions that already read them.`); break;
      }
      case '/default': room.defaultTarget = m.defaultTarget = arg; say(arg === 'both' ? 'All participants receive untagged messages.' : `${room.labels[arg]} now leads untagged messages.`); break;
      case '/both': room.bothMode = m.bothMode = arg; say(arg === 'sequential' ? '@both now takes turns: the second agent sees the first answer and builds on it.' : '@both now answers at once; the agents do not see each other\'s replies until later.'); break;

    }
    this.postMeta();
  }

  postInit() {
    if (localUsage.last) this.post({ type: 'localUsage', usage: localUsage.last });
    this.refreshLocalUsage();
    this.post({ type: 'ide', summary: ideContext.summary(ideSnapshot(this.meta.cwd)) });
    if (this.claudeUsage) this.post({ type: 'claudeUsage', usage: this.claudeUsage });
    this.postTask();
    this.post({ type: 'init', meta: this.meta, commands: this.cmdSpecs(), controls: this.room ? this.controls() : null, transcript: this.room ? this.room.state.transcript.map((e) => this.view(e)) : [], busy: this.room ? this.room.busy : {}, quota: this.quota,
      participantUsage: Object.fromEntries(Object.values(this.slots).map((r) => [r.seat.id, r.client?.lastTurnUsage || null])),
      participantCost: Object.fromEntries(Object.values(this.slots).filter((r) => typeof r.client?.totalCostUsd === 'number').map((r) => [r.seat.id, r.client.totalCostUsd])) });
    if (this.refusal && !this.room) this.post({ type: 'notice', text: this.refusal });
  }

  // Webview copy of an attachment: image thumbnails get a webview-safe URL.
  viewAtt(a) { return { ...a, src: a.kind === 'image' && this.panel ? this.panel.webview.asWebviewUri(vscode.Uri.file(a.path)).toString() : null }; }
  view(entry) { return entry.attachments ? { ...entry, attachments: entry.attachments.map((a) => this.viewAtt(a)) } : entry; }

  addAttachment(spec) {
    try {
      const a = attachments.store(this.attDir, spec);
      this.pendingAtts.set(a.id, a);
      this.post({ type: 'attached', att: this.viewAtt(a) });
    } catch (e) { this.post({ type: 'attachError', text: e.message }); }
  }

  dispose() {
    // A session whose boot failed is already disposed, but its panel is closing now: forget it either way.
    if (this.disposed) { sessions.delete(this); this.panel = null; refreshRooms(); return; } // e.g. a room that failed to start
    // Save the closing checkpoint once; late boot/turn/usage completions may never save again.
    try { clearTimeout(this.saveTimer); if (this.room) this.room.denyApprovals('the room was closed'); this.save(); } finally {
      this.disposed = true;
      sessions.delete(this); if (this.scheduler) this.scheduler.dispose();
      this.closeClients(); this.panel = null;
      refreshRooms();
    }
  }
}

const MODE_TEXT = {
  auto: 'Auto. A task starts when an agent asks the other for help; the task keeps turn and time allowances.',
  chat: 'Chat. Each message allows one consultation between the agents, with no task.',
  work: 'Work. Each message starts a task, with its allowances, even before the agents ask each other anything.'
};
const cleanLimits = (l) => {
  const n = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const turns = n(l.turns, 1, 200, 20);
  return { turns, reserve: n(l.reserve, 0, Math.max(0, turns - 1), 2), minutes: n(l.minutes, 1, 24 * 60, 30) };
};

const c_ide = () => config().get('ideContext') !== false;

// Snapshot of the last code editor: file, selection or visible lines, open tabs, problems.
// Only files inside the room's folder are shared automatically; anything else goes in with + (attach).
function ideSnapshot(root) {
  const ed = lastEditor; if (!ed || ed.document.isClosed || !root || !paths.isInside(root, ed.document.uri.fsPath)) return null;
  const doc = ed.document, sel = ed.selection;
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const lineText = (a, b) => doc.getText(new vscode.Range(a, 0, b, doc.lineAt(b).text.length));
  let selection = null, visible = null;
  if (!sel.isEmpty) selection = { start: sel.start.line + 1, end: sel.end.line + 1, text: doc.getText(sel) };
  else {
    const vr = ed.visibleRanges[0] || new vscode.Range(sel.active, sel.active);
    const a = Math.max(0, Math.min(vr.start.line, sel.active.line - 30)), b = Math.min(doc.lineCount - 1, a + ideContext.LIMITS.visibleLines - 1);
    visible = { start: a + 1, end: b + 1, text: lineText(a, b) };
  }
  const sev = ['Error', 'Warning', 'Info', 'Hint'];
  const problems = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.severity <= 1).map((d) => ({ severity: sev[d.severity], line: d.range.start.line + 1, message: d.message.split('\n')[0] }));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input && t.input.uri).filter((u) => u && u.scheme === 'file' && paths.isInside(root, u.fsPath)).map((u) => vscode.workspace.asRelativePath(u, false));
  return { file: rel, language: doc.languageId, cursor: sel.active.line + 1, selection, visible, problems, tabs: [...new Set(tabs)] };
}

let ideTimer = null;
function broadcastIde() {
  clearTimeout(ideTimer);
  ideTimer = setTimeout(() => { for (const x of sessions) x.post({ type: 'ide', summary: ideContext.summary(ideSnapshot(x.meta.cwd)) }); }, 150);
}

// Show a unified diff in VS Code's diff editor: the file as it is, beside the file with the patch applied in memory.
const proposed = new Map();
async function openDiff(text, cwd) {
  const files = diffs.parse(text);
  if (!files.length) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); return vscode.window.showTextDocument(doc, { preview: true }); }
  for (const f of files.slice(0, 5)) {
    const rel = f.newPath || f.oldPath, abs = paths.resolveInside(cwd, rel);
    if (!abs) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); await vscode.window.showTextDocument(doc, { preview: true }); vscode.window.showWarningMessage(`Wagon Wheel: ${rel} is outside the room's folder, so the diff opened as plain text.`); continue; }
    const original = f.oldPath && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const patched = diffs.apply(original, f.hunks);
    if (patched === null) { const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' }); await vscode.window.showTextDocument(doc, { preview: true }); vscode.window.showWarningMessage(`Wagon Wheel: the diff for ${rel} no longer matches the file, so it opened as plain text.`); continue; }
    const key = `/${Date.now()}-${Math.random().toString(36).slice(2)}/${path.basename(rel)}`;
    proposed.set(key, patched);
    const left = fs.existsSync(abs) ? vscode.Uri.file(abs) : vscode.Uri.parse(`wagon-wheel-proposed:/empty/${path.basename(rel)}`);
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.parse(`wagon-wheel-proposed:${key}`), `${path.basename(rel)} ↔ proposed (Wagon Wheel)`);
  }
}

function panelHtml(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'room.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'room.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Wagon Wheel</title></head>
<body data-wc="${require('../package.json').version}"><header id="hdr" tabindex="0" aria-label="Room and account usage"><div><div id="title"></div><div id="ids"></div></div><div id="quota"></div></header>
<main id="log" aria-live="polite"></main>
<footer><div class="dock">
<section id="task" class="task" hidden aria-live="polite"></section>
<div id="menu" role="listbox" hidden></div><div id="pop" class="pop" hidden></div>
<div class="composer"><div class="composer-in">
<div id="tray" hidden></div>
<textarea id="input" rows="1" aria-label="Message" placeholder="Message the room…   @ to mention · / for commands"></textarea>
<div class="tools">
<button id="attach" class="icon" title="Attach files (or paste a screenshot, or Shift-drag files in)" aria-label="Attach files">+</button>
<button id="ide" class="chip ide" title="IDE context: what you are looking at in VS Code is attached to your message. Click to turn off."></button>
<span id="participants"></span>
<button id="lead" class="chip lead" aria-haspopup="true" title="Who leads: messages without an @mention go to the lead"></button>
<button id="tc" class="chip tc" aria-haspopup="true" title="Task controls: mode and allowances"></button>
<span id="who"></span>
<button id="stop" class="round stop" title="Stop all participants" aria-label="Stop" hidden>■</button>
<button id="send" class="round send" title="Send (Enter)" aria-label="Send">↑</button>
</div></div></div>
<div class="hint">Untagged messages go to <span id="deftarget">Claude</span> · @ to mention · / for commands · Enter to send, Shift+Enter for a new line</div>
</div></footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

async function openSession(context, session, opts) {
  const panel = vscode.window.createWebviewPanel('wagonWheel', `Wagon Wheel: ${session.meta.name}`, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.globalStorageUri, 'rooms')]
  });
  panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, 'media', 'wheel-light.svg'), dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'wheel-dark.svg') };
  panel.webview.html = panelHtml(panel.webview, context.extensionUri);
  session.attach(panel);
  refreshRooms();
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Wagon Wheel: starting local sessions…' }, () => session.boot(opts));
    session.postInit();
    session.fillSourceTitles().catch((e) => log(`source titles: ${e.message}`));
    refreshClaudeMenu();
    return true;
  } catch (e) {
    log(`boot failed: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Wagon Wheel could not start: ${e.message}`); // the panel notice was posted by boot()
    return false;
  } finally { refreshRooms(); } // a new room's file exists once it has booted
}

// ---------- Start a Room: one plain-English setup screen (media/start.js) ----------
// Replaces the old chain of quick picks. The page shows setup status, models and recent conversations; this host
// keeps the lists it sent and validates the finished form (startRoom.buildPlan) before any provider process starts.
const startScreen = { panel: null, lists: { claude: [], codex: [] }, codexModels: [], claudeModels: null };

function startHtml(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'start.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'start.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Start a Room</title></head>
<body><main id="app" aria-live="polite"></main><script nonce="${nonce}" src="${js}"></script></body></html>`;
}

const displayPath = (p) => { const home = os.homedir(); return p && home && p.startsWith(home) ? `~${p.slice(home.length)}` : p; };

const setupUnknown = () => { const u = (app) => ({ ready: false, unknown: true, text: `Couldn't check ${app}. It may still work.`, fix: null }); return { type: 'setup', trusted: vscode.workspace.isTrusted, claude: u('Claude Code'), codex: u('Codex') }; };
async function startSetupStatus() {
  if (!vscode.workspace.isTrusted) return { trusted: false, claude: null, codex: null };
  const s = settings();
  const r = await setup.checkSetup({ trusted: true, executionHost: hostLabel(), executables: { claude: s.claude.path, codex: s.codexExe } });
  for (const p of r.providers) log(`start screen setup: ${setupLine(p)}`);
  const by = Object.fromEntries(r.providers.map((p) => [p.provider, startRoom.setupLine(p)]));
  return { trusted: true, claude: by.claude || null, codex: by.codex || null };
}

// Codex models and threads come from a short-lived private Codex process; Claude conversations from its local files.
async function startLists(ctx) {
  const s = settings(), home = os.homedir();
  let codexThreads = [], codexModels = [];
  if (vscode.workspace.isTrusted) {
    const probe = new CodexClient({ exe: s.codexExe, cwd: s.cwd, log });
    try { await probe.start(); codexModels = await probe.listModels(); codexThreads = await probe.listThreads(null, 80); } catch (e) { log(`start screen codex: ${e.message}`); } finally { probe.stop(); }
  }
  let claudeSessions = [];
  try { claudeSessions = claudeHistory.listSessions(80); } catch (e) { log(`start screen claude: ${e.message}`); }
  const made = startRoom.roomMade(roomsView.listRooms(path.join(ctx.globalStorageUri.fsPath, 'rooms')));
  const chats = startRoom.codexChatIds(); // the Codex app's plain chats are not coding sessions
  startScreen.lists = {
    claude: claudeSessions.filter((x) => !startRoom.isRoomConversation('claude', x, made)).slice(0, 40).map((x) => ({ id: x.id, cwd: x.cwd, when: x.mtime, title: x.title || x.preview })),
    codex: codexThreads.filter((t) => !startRoom.isRoomConversation('codex', { ...t, originator: startRoom.codexOriginator(t.path) }, made) && !startRoom.isChatConversation('codex', t, chats)).slice(0, 40).map((t) => ({ id: t.id, cwd: t.cwd, when: t.updatedAt ? t.updatedAt * 1000 : null, title: t.name || t.preview })),
  };
  startScreen.lastLists = null;
  startScreen.codexModels = codexModels.map((m) => ({ id: m.id, name: m.displayName || m.id, note: typeof m.description === 'string' ? m.description.slice(0, 120) : '', efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort) }));
  const v = s.claude.version;
  startScreen.claudeModels = startClaudeModels(v);
  // Remembered so a later resend (Claude Code's menu arriving) never brings back an older list.
  return (startScreen.lastLists = {
    conversations: { claude: startScreen.lists.claude.map((c) => startRoom.conversationRow(c, home)), codex: startScreen.lists.codex.map((c) => startRoom.conversationRow(c, home)) }, // rows carry exists: the folder is still there
    models: { claude: startScreen.claudeModels, codex: startScreen.codexModels },
  });
}

// When was a conversation last written? Read now, not when the list was loaded: the screen can stay open a while.
async function lastWritten(o, fallback) {
  try {
    if (o.provider === 'claude') { const f = claudeHistory.fileFor(o.id); return f ? fs.statSync(f).mtimeMs : fallback; }
    const probe = new CodexClient({ exe: settings().codexExe, cwd: settings().cwd, log });
    try { await probe.start(); const t = (await probe.listThreads(null, 100)).find((x) => x.id === o.id); return t && t.updatedAt ? t.updatedAt * 1000 : fallback; } finally { probe.stop(); }
  } catch { return fallback; }
}

async function startFromForm(context, form) {
  const s = settings();
  const plan = startRoom.buildPlan(form, { lists: startScreen.lists, codexModels: startScreen.codexModels, claudeModels: startScreen.claudeModels, defaultCwd: s.cwd, settings: s });
  // Keeping going in an original: refuse one another room already uses (open in this window, or saved), before the
  // screen closes, so the person can still change the choice.
  const saved = roomsView.listRooms(path.join(context.globalStorageUri.fsPath, 'rooms'));
  for (const o of plan.originals) {
    const room = saved.find((x) => x.seats.some((seat) => seat.provider === o.provider && seat.sessionId === o.id));
    if (sessionClaims.isClaimed(o.provider, o.id) || room) throw new Error(`${o.label}: that conversation is already used by ${room ? `the room "${room.name}"` : 'another room'}. Use a copy instead.`);
  }
  const recent = [];
  for (const o of plan.originals) { const when = await lastWritten(o, o.when); if (when && Date.now() - when < 120000) recent.push(o); }
  if (recent.length) {
    const go = await vscode.window.showWarningMessage(`${recent.map((o) => o.label).join(' and ')} will keep going in a conversation that changed in the last two minutes.`,
      { modal: true, detail: 'It may still be open in Claude Code, Codex or another window. Two apps writing to one conversation can mix up its history. A copy is safer.' }, 'Keep going in the original');
    if (!go) return false;
  }
  const meta = newMeta(plan.name);
  // A separate copy: a new branch of the editing agent's repository in the room's own storage. Every agent whose folder
  // is in that repository works in the copy, so they all see the edits; the person's folder is not touched.
  if (plan.editIn === 'copy') {
    const ed = plan.seats.find((p) => p.access !== 'read');
    const repo = await copyMode.repoRoot(ed.cwd);
    if (!repo) throw new Error(`${ed.label}: its folder isn't in a git repository, so a separate copy can't be made. Choose "Your folder" instead.`);
    try { meta.copy = await copyMode.create({ repo, dir: path.join(context.globalStorageUri.fsPath, 'rooms', meta.id, 'copy'), branch: copyMode.branchName(plan.name, meta.id) }); }
    catch (e) { throw new Error(`A separate copy couldn't be made: ${e.message}.`); }
    for (const p of plan.seats) if (copyMode.within(p.cwd, repo)) p.cwd = copyMode.mapPath(p.cwd, meta.copy);
  }
  meta.cwd = plan.seats.some((p) => p.cwd === s.cwd) ? s.cwd : plan.seats[0].cwd;
  meta.seats = plan.seats; meta.sources = plan.sources;
  const screen = startScreen.panel;
  // A retry closes the tab of the attempt that failed, so failed tries don't pile up.
  if (startScreen.failed && startScreen.failed.panel) startScreen.failed.panel.dispose();
  const session = new RoomSession(context, meta, null);
  const ok = await openSession(context, session, { shareSeed: plan.shareSeed });
  startScreen.failed = ok ? null : session;
  if (!ok) throw new Error('The room could not start. Its tab says why; you can change your choices here and try again.');
  if (screen) screen.dispose();
  return true;
}

async function openStartScreen(context, { existing = false } = {}) {
  if (startScreen.panel) { startScreen.panel.reveal(); startScreen.panel.webview.postMessage({ type: 'mode', existing }); return; }
  const panel = startScreen.panel = vscode.window.createWebviewPanel('wagonWheel.startRoom', 'Wagon Wheel: Start a Room', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
  panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, 'media', 'wheel-light.svg'), dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'wheel-dark.svg') };
  panel.webview.html = startHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => { if (startScreen.panel === panel) startScreen.panel = null; });
  const post = (m) => { if (startScreen.panel === panel) panel.webview.postMessage(m); };
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'ready') {
        const s = settings();
        post({ type: 'init', existing, defaults: { name: `Room ${new Date().toLocaleDateString()}`, folder: s.cwd, folderLabel: displayPath(s.cwd), userName: s.userName }, trusted: vscode.workspace.isTrusted });
        startSetupStatus().then((st) => post({ type: 'setup', ...st }), (e) => { log(`start screen setup: ${e.message}`); post(setupUnknown()); });
        // Lists first; when the Claude CLI reports its own model menu, send them again with it.
        startLists(context).then((l) => {
          post({ type: 'lists', ...l });
          const asked = refreshClaudeMenu(); // then Claude Code's own menu, without asking Codex again
          if (asked) asked.then(() => { startScreen.claudeModels = startClaudeModels(settings().claude.version); const last = startScreen.lastLists || l; post({ type: 'lists', ...last, models: { ...last.models, claude: startScreen.claudeModels } }); }, () => {});
        }, (e) => { log(`start screen lists: ${e.message}`); post({ type: 'lists', conversations: { claude: [], codex: [] }, models: { claude: [], codex: [] } }); });
      } else if (m.type === 'recheck') {
        try { post({ type: 'setup', ...(await startSetupStatus()) }); } catch (e) { log(`start screen setup: ${e.message}`); post(setupUnknown()); }
        // Trusting the folder unlocks the Codex lists, so reload them too.
        startLists(context).then((l) => post({ type: 'lists', ...l }), (e) => log(`start screen lists: ${e.message}`));
      } else if (m.type === 'pickFolder' && Number.isInteger(m.index)) {
        const f = await vscode.window.showOpenDialog({ title: 'Choose the folder this agent works in', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(settings().cwd), openLabel: 'Use this folder' });
        if (f && f[0]) post({ type: 'folder', index: m.index, folder: f[0].fsPath, folderLabel: displayPath(f[0].fsPath) });
      } else if (m.type === 'guide' && Object.hasOwn(setup.GUIDES, m.provider)) {
        vscode.env.openExternal(setup.GUIDES[m.provider]);
      } else if (m.type === 'start') {
        post({ type: 'busy', on: true });
        const ok = await startFromForm(context, m.form);
        if (!ok) post({ type: 'busy', on: false });
      }
    } catch (e) { post({ type: 'error', text: e.message }); post({ type: 'busy', on: false }); }
  });
}

// Side panel: the Start view is always empty so VS Code shows its buttons (viewsWelcome in package.json); the Rooms
// view lists saved rooms, newest activity first. Clicking a room shows it if open, otherwise reopens it.
class RoomsTree {
  constructor(context) {
    this.dir = path.join(context.globalStorageUri.fsPath, 'rooms'); this.cache = new Map();
    this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  getChildren(el) { return el ? [] : roomsView.listRooms(this.dir, this.cache); }
  getTreeItem(room) {
    const open = [...sessions].some((x) => x.meta.id === room.id && x.panel) ? 'here' : roomLock.holder(room.file) ? 'elsewhere' : false;
    const d = roomsView.describe(room, { open });
    const item = new vscode.TreeItem(d.label, vscode.TreeItemCollapsibleState.None);
    item.id = room.id; item.description = d.description; item.tooltip = d.tooltip; item.contextValue = 'wagonWheel.room';
    item.iconPath = new vscode.ThemeIcon(open === 'here' ? 'circle-filled' : open ? 'window' : 'comment-discussion');
    item.command = { command: 'wagonWheel.openRoomById', title: 'Open room', arguments: [room.id] };
    return item;
  }
}
const emptyTree = { getChildren: () => [], getTreeItem: (x) => x };

async function openRoomById(context, id) {
  if (typeof id !== 'string' || !roomsView.ROOM_ID.test(id)) return;
  const live = [...sessions].find((x) => x.meta.id === id && x.panel);
  if (live) { live.panel.reveal(); return; }
  const file = path.join(context.globalStorageUri.fsPath, 'rooms', `${id}.json`);
  if (roomLock.holder(file)) {
    refreshRooms();
    const lock = roomLock.lockPath(file), REVEAL = 'Reveal lock file';
    const pick = await vscode.window.showInformationMessage(`Wagon Wheel: this room is open in another VS Code window. Switch to that window to use it. If no window has it open, delete its lock file: ${lock}`, REVEAL);
    if (pick === REVEAL) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(lock));
    return;
  }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { refreshRooms(); vscode.window.showWarningMessage(`Wagon Wheel: that room could not be read (${e.code || e.message}).`); return; }
  if (!saved || !saved.meta || saved.meta.id !== id) { vscode.window.showWarningMessage('Wagon Wheel: that file is not a saved room.'); return; }
  await openSession(context, new RoomSession(context, saved.meta, saved.state), {});
}

// Launchers outside the side panel: the editor title button is a menu contribution (package.json); the status bar
// item is created here and follows its setting.
function statusBarItem(context) {
  const item = vscode.window.createStatusBarItem('wagonWheel.status', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Wagon Wheel'; item.text = '$(comment-discussion) Wagon Wheel'; item.tooltip = 'Wagon Wheel: New Room'; item.command = 'wagonWheel.newRoom';
  const sync = () => (config().get('showStatusBar') === false ? item.hide() : item.show());
  sync();
  context.subscriptions.push(item, vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('wagonWheel.showStatusBar')) sync(); }));
  return item;
}

// New rooms start on the current rules, so they get no upgrade notice.
function newMeta(name) {
  return { id: crypto.randomUUID(), name, cwd: settings().cwd, createdAt: new Date().toISOString(), codexThreadId: null, claudeSessionId: null, handoffRule: HANDOFF_RULE };
}


// The rename changed the extension id, and with it the storage folder. Copy (never move) rooms saved under the
// old id, so reopening finds them and attachment paths inside them stay valid. The copy is staged and checked,
// then renamed into place in one step: an interrupted copy leaves no half-filled rooms folder, so the next launch
// simply tries again, and an existing rooms folder (newer data) is never touched.
const LEGACY_IDS = ['darkrangerstudios.wagon-circle']; // earlier extension ids, newest first
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name), base) : [[path.relative(base, path.join(dir, d.name)), fs.statSync(path.join(dir, d.name)).size]]));
}
function migrateRooms(context, fsx = fs) {
  const to = path.join(context.globalStorageUri.fsPath, 'rooms'), staging = `${to}.migrating`;
  const from = LEGACY_IDS.map((id) => path.join(path.dirname(context.globalStorageUri.fsPath), id, 'rooms')).find((p) => fs.existsSync(p));
  if (fs.existsSync(to) || !from) return false;
  try {
    fs.rmSync(staging, { recursive: true, force: true }); // leftovers of an interrupted attempt
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fsx.cpSync(from, staging, { recursive: true });
    const want = JSON.stringify(listFiles(from).sort()), got = JSON.stringify(listFiles(staging).sort());
    if (want !== got) throw new Error('copied files do not match the originals');
    fs.renameSync(staging, to);
    log(`copied rooms from ${from}`);
    return true;
  } catch (e) { log(`room migration will retry next launch: ${e.message}`); try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* next launch */ } return false; }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Wagon Wheel');
  context.subscriptions.push(output);
  migrateRooms(context);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('wagon-wheel-proposed', { provideTextDocumentContent: (uri) => proposed.get(uri.path) || '' }));
  const track = (ed) => { if (ed && ed.document.uri.scheme === 'file') { lastEditor = ed; broadcastIde(); } };
  track(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(track), vscode.window.onDidChangeTextEditorSelection((e) => track(e.textEditor)), vscode.window.onDidChangeTextEditorVisibleRanges((e) => track(e.textEditor)));

  context.subscriptions.push(
    vscode.commands.registerCommand('wagonWheel.newRoom', () => openStartScreen(context, {})),
    // Kept for keybindings and old links: the Start a Room screen with "one of your conversations" chosen.
    vscode.commands.registerCommand('wagonWheel.joinExisting', () => openStartScreen(context, { existing: true })));

  // First-run check (setup.js): CLI versions and sign-in on this host. No model calls, no installs, no logins.
  context.subscriptions.push(vscode.commands.registerCommand('wagonWheel.checkSetup', async () => {
    const s = settings();
    const r = await setup.checkSetup({ trusted: vscode.workspace.isTrusted, executionHost: hostLabel(), executables: { claude: s.claude.path, codex: s.codexExe } });
    if (r.state === 'workspace-untrusted') { vscode.window.showWarningMessage('Wagon Wheel: trust this workspace before checking the CLIs.'); return; }
    const W = PROVIDER_NAMES, line = setupLine;
    for (const p of r.providers) log(`setup: ${line(p)} [${p.executable}]`);
    const msg = `Wagon Wheel on ${r.executionHost}: ${r.providers.map(line).join('; ')}. ${r.note}`;
    const bad = r.providers.filter((p) => p.installation !== 'available' || p.authentication !== 'present');
    // The walkthrough step completes only on a passing check, not on running the command.
    vscode.commands.executeCommand('setContext', 'wagonWheel.setupOk', !bad.length && r.providers.length > 0);
    if (!bad.length) vscode.window.showInformationMessage(msg);
    else { const pick = await vscode.window.showWarningMessage(msg, ...bad.map((p) => `Open ${W[p.provider]} guide`)); const hit = bad.find((p) => pick === `Open ${W[p.provider]} guide`); if (hit) vscode.env.openExternal(hit.guide); }
  }));

  roomsTree = new RoomsTree(context);
  context.subscriptions.push(roomsTree.emitter,
    vscode.window.registerTreeDataProvider('wagonWheel.start', emptyTree),
    vscode.window.registerTreeDataProvider('wagonWheel.rooms', roomsTree),
    vscode.commands.registerCommand('wagonWheel.openRoomById', (id) => openRoomById(context, id)),
    vscode.commands.registerCommand('wagonWheel.refreshRooms', () => refreshRooms()));
  statusBarItem(context);

  context.subscriptions.push(vscode.commands.registerCommand('wagonWheel.reportProblem', () => reportProblem().catch((e) => {
    log(`report a problem: ${e.message}`);
    vscode.window.showErrorMessage(`Wagon Wheel: could not build the report (${e.message}). You can still open an issue at ${feedback.ISSUES_URL}.`);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('wagonWheel.openRoom', async () => {
    const dir = path.join(context.globalStorageUri.fsPath, 'rooms');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    const rooms = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.meta.createdAt).localeCompare(String(a.meta.createdAt)));
    if (!rooms.length) { vscode.window.showInformationMessage('No saved rooms yet.'); return; }
    const pick = await vscode.window.showQuickPick(rooms.map((r) => ({ label: r.meta.name, description: new Date(r.meta.createdAt).toLocaleString(), r })));
    if (!pick) return;
    await openSession(context, new RoomSession(context, pick.r.meta, pick.r.state), {});
  }));
}

// Closing the window may skip panel disposal: release this host's room locks so other windows can open them now.
function deactivate() { for (const x of sessions) if (roomClaims.get(x.file) === x) roomLock.release(x.file); }

module.exports = { activate, deactivate, roomPrompt, AGENTS, migrateRooms, RoomSession, newMeta, reportProblem, openRoomById, RoomsTree, openStartScreen, startScreen };
