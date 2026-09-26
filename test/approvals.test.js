'use strict';
// v0.8.0: agents that can edit ask first. Room cards, both clients' request paths, and the card wording.
const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../src/room');
const { ClaudeClient } = require('../src/claudeClient');
const { CodexClient } = require('../src/codexClient');
const { claudeCard, codexCard } = require('../src/approvalCards');
const tick = () => new Promise((r) => setImmediate(r));
const flag = (a, name) => a[a.indexOf(name) + 1];

function busyAgent() { const a = { typed: true, inbox: [] }; a.send = (t) => { a.inbox.push(t); return new Promise(() => {}); }; a.interrupt = () => {}; return a; }
function room(opts = {}) { let t = 1000; const r = new Room({ agents: { claude: busyAgent(), codex: busyAgent() }, now: () => t, bothMode: 'parallel', ...opts }); r.advance = (ms) => { t += ms; }; return r; }
const edit = (title = 'Edit a.txt') => ({ kind: 'edit', title, paths: ['/w/a.txt'], detail: '- a\n+ b' });

test('a card waits for the human; Allow and Deny resolve it and are recorded', async () => {
  const r = room(); r.postFromHuman('@claude go');
  const p1 = r.requestApproval('claude', edit());
  const card = r.state.transcript.at(-1);
  assert.deepStrictEqual([card.kind, card.approval.status, card.approval.kind, card.approval.seat], ['approval', 'pending', 'edit', 'claude']);
  assert.ok(r.answerApproval(card.approval.id, 'allow'));
  assert.deepStrictEqual(await p1, { allow: true, why: null });
  assert.strictEqual(card.approval.status, 'allowed');
  assert.strictEqual(r.answerApproval(card.approval.id, 'deny'), false, 'answered once');
  const p2 = r.requestApproval('claude', { kind: 'command', title: 'Run: rm -rf x', command: 'rm -rf x' });
  r.answerApproval(r.state.transcript.at(-1).approval.id, 'deny');
  assert.strictEqual((await p2).allow, false);
});

test('"Allow edits for this task" covers later edits by that agent in the same task only; commands still ask', async () => {
  const r = room(); r.tasks.mode = 'work'; r.postFromHuman('@claude @codex big job'); // both at work
  const first = r.requestApproval('claude', edit());
  r.answerApproval(r.state.transcript.at(-1).approval.id, 'allowTask'); await first;
  assert.deepStrictEqual(await r.requestApproval('claude', edit('Edit b.txt')), { allow: true });
  assert.strictEqual(r.state.transcript.at(-1).approval.auto, true);
  r.requestApproval('claude', { kind: 'command', title: 'Run: ls', command: 'ls' });
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'a command still asks');
  r.requestApproval('codex', edit());
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'another agent still asks');
  r.stopAll(); r.postFromHuman('@claude @codex next job');
  r.requestApproval('claude', edit('Edit c.txt'));
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'Stop ended the standing rule');
});

test('Stop, a used-up time allowance, no answer in time, and closing the room all deny', async () => {
  const r = room({ approvalTimeoutMs: 60e3 }); r.postFromHuman('@claude go');
  const a = r.requestApproval('claude', edit()); r.stopAll();
  assert.deepStrictEqual(await a, { allow: false, why: 'stopped' });
  r.postFromHuman('@claude again');
  const b = r.requestApproval('claude', edit()); r.advance(61e3); r.tick();
  assert.deepStrictEqual(await b, { allow: false, why: 'no answer in time' });
  const c = r.requestApproval('claude', edit());
  assert.strictEqual(r.denyApprovals('the room was closed'), 1);
  assert.strictEqual((await c).why, 'the room was closed');
  const t = room(); t.tasks.mode = 'work'; t.postFromHuman('@claude job'); t.tasks.active().limits.minutes = 1;
  const d = t.requestApproval('claude', edit()); t.advance(2 * 60e3); t.tick();
  assert.strictEqual((await d).why, 'the task used its time allowance');
});

test('a path outside the agent\'s folder is refused without a card; after Stop nothing can ask', async () => {
  const r = room(); r.postFromHuman('@claude go');
  assert.strictEqual((await r.requestApproval('claude', { ...edit(), outside: true })).allow, false);
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'denied');
  r.stopAll();
  assert.strictEqual((await r.requestApproval('claude', edit())).why, 'stopped');
});

test('a card still waiting when the room closed shows as not answered after reload', () => {
  const r = room(); r.postFromHuman('@claude go'); r.requestApproval('claude', edit());
  const again = new Room({ agents: { claude: busyAgent(), codex: busyAgent() }, state: JSON.parse(JSON.stringify(r.state)) });
  assert.strictEqual(again.state.transcript.find((e) => e.kind === 'approval').approval.status, 'expired');
});

// ---------- Claude ----------
function fakeClaude(opts) {
  const writes = [];
  const c = new ClaudeClient({ exe: 'x', cwd: '/w', systemPrompt: '', ...opts });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); }, end() {} }, kill() {} };
  return { c, writes, line: (m) => c._onLine(JSON.stringify(m)) };
}
const canUse = (tool, input, id = 'p1') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } });
const answer = (writes, id) => writes.find((w) => w.type === 'control_response' && w.response.request_id === id).response.response;

test('Claude launch flags by level: write tools are added but never pre-allowed, and asking goes to the room', () => {
  const read = new ClaudeClient({ exe: 'x', cwd: '/', systemPrompt: '' })._args();
  assert.strictEqual(flag(read, '--tools'), 'Read,Glob,Grep'); assert.strictEqual(flag(read, '--permission-mode'), 'dontAsk'); assert.ok(!read.includes('--permission-prompt-tool'));
  const ed = new ClaudeClient({ exe: 'x', cwd: '/', systemPrompt: '', access: 'edit', effort: 'ultracode' })._args();
  assert.strictEqual(flag(ed, '--tools'), 'Read,Glob,Grep,Edit,Write,NotebookEdit');
  assert.deepStrictEqual([flag(ed, '--permission-mode'), flag(ed, '--permission-prompt-tool')], ['default', 'stdio']);
  assert.ok(!/Edit|Write|Bash/.test(flag(ed, '--allowedTools')), 'nothing that writes runs without asking');
  assert.ok(ed.includes('--restricted'));
  assert.ok(!ed.includes('--settings') && !flag(ed, '--tools').includes('Workflow'), 'no Ultracode for an agent that edits');
  const run = new ClaudeClient({ exe: 'x', cwd: '/', systemPrompt: '', access: 'run' })._args();
  assert.strictEqual(flag(run, '--tools'), 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash');
});

test('Claude: a permission request goes to the room and its answer goes back; the wrong level or no reply is a no', async () => {
  const asked = [];
  const { c, writes, line } = fakeClaude({ access: 'edit', onPermission: async (req) => { asked.push(req.tool); return { allow: req.input.file_path === '/w/a.txt' }; } });
  const reply = c.send('go');
  line(canUse('Edit', { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' }, 'p1')); await tick(); await tick();
  assert.deepStrictEqual(answer(writes, 'p1'), { behavior: 'allow', updatedInput: { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' } });
  line(canUse('Write', { file_path: '/w/z.txt', content: 'x' }, 'p2')); await tick(); await tick();
  assert.strictEqual(answer(writes, 'p2').behavior, 'deny');
  line(canUse('Bash', { command: 'ls' }, 'p3')); await tick();
  assert.strictEqual(answer(writes, 'p3').behavior, 'deny'); assert.deepStrictEqual(asked, ['Edit', 'Write'], 'Bash at the edit level is refused without asking');
  line({ type: 'result', result: 'ok' }); await reply;
  line(canUse('Edit', { file_path: '/w/a.txt' }, 'p4')); await tick();
  assert.strictEqual(answer(writes, 'p4').behavior, 'deny', 'no reply open');
  assert.match(answer(writes, 'p4').message, /Don't retry it another way/);
});

test('Claude: a card answered after Stop ended the reply is still a no', async () => {
  let release;
  const { c, writes, line } = fakeClaude({ access: 'edit', onPermission: () => new Promise((r) => { release = r; }) });
  const reply = c.send('go');
  line(canUse('Edit', { file_path: '/w/a.txt' }, 'p1')); await tick();
  line({ type: 'result', result: 'ended' }); await reply;
  release({ allow: true }); await tick(); await tick();
  assert.strictEqual(answer(writes, 'p1').behavior, 'deny');
});

// ---------- Codex ----------
function fakeCodex(opts) {
  const writes = [];
  const c = new CodexClient({ exe: 'x', cwd: '/w', ...opts });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } } };
  return { c, writes, line: (m) => c._onLine(JSON.stringify(m)) };
}

test('Codex: file changes ask with their paths and diff; commands ask only at "run"; each turn carries the policy', async () => {
  const asked = [], refused = [];
  const { c, writes, line } = fakeCodex({ access: 'edit', onApproval: async (req) => { asked.push(req); return { allow: true }; }, onRefused: (x) => refused.push(x) });
  c.currentTurn = { threadId: 't1', turnId: 'u1', started: true, cancelled: false };
  line({ method: 'item/started', params: { threadId: 't1', item: { id: 'i1', type: 'fileChange', changes: [{ path: '/w/a.txt', diff: '@@ -1 +1 @@\n-a\n+b' }] } } });
  line({ id: 5, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1' } }); await tick(); await tick();
  assert.deepStrictEqual(writes.find((w) => w.id === 5).result, { decision: 'accept' });
  assert.deepStrictEqual([asked[0].kind, asked[0].paths, asked[0].diff], ['edit', ['/w/a.txt'], '@@ -1 +1 @@\n-a\n+b']);
  line({ id: 6, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i2', command: 'touch b' } }); await tick();
  assert.deepStrictEqual(writes.find((w) => w.id === 6).result, { decision: 'decline' });
  assert.strictEqual(refused[0].command, 'touch b'); assert.strictEqual(asked.length, 1);
  line({ id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 'other', turnId: 'u1', itemId: 'i1' } }); await tick();
  assert.deepStrictEqual(writes.find((w) => w.id === 7).result, { decision: 'decline' }, 'only the running turn\'s thread');
  // The policy rides on every turn.
  const sent = []; c.verifiedThreads.add('t1'); c.request = (m, p) => { sent.push([m, p]); return new Promise(() => {}); };
  c.runTurn('t1', 'hi'); assert.strictEqual(sent[0][1].approvalPolicy, 'on-request');
  c.access = 'read'; c.runTurn('t1', 'hi'); assert.strictEqual(sent[1][1].approvalPolicy, 'never');
});

// ---------- card wording ----------
test('cards say what will change, with paths relative to the agent\'s folder', () => {
  const rel = (p) => p.replace('/w/', '');
  assert.deepStrictEqual(claudeCard({ tool: 'Edit', input: { file_path: '/w/src/a.js', old_string: 'x', new_string: 'y' } }, rel), { kind: 'edit', paths: ['/w/src/a.js'], title: 'Edit src/a.js', detail: '- x\n+ y' });
  assert.strictEqual(claudeCard({ tool: 'Write', input: { file_path: '/w/n.md', content: 'hi' } }, rel).title, 'Create or replace n.md');
  assert.deepStrictEqual(claudeCard({ tool: 'Bash', input: { command: 'npm   test' }, description: 'Run tests' }, rel), { kind: 'command', command: 'npm   test', reason: 'Run tests', title: 'Run: npm test', paths: [] });
  assert.deepStrictEqual(claudeCard({ tool: 'Write', input: { file_path: '/w/a' }, blockedPath: '/elsewhere/b' }, rel).paths, ['/w/a', '/elsewhere/b'], 'the path Claude Code names is checked too');
  assert.strictEqual(codexCard({ kind: 'command', command: 'touch b' }, rel).title, 'Run outside the sandbox: touch b');
  assert.deepStrictEqual(codexCard({ kind: 'edit', paths: ['/w/a.txt'], grantRoot: '/etc', diff: 'd' }, rel).paths, ['/w/a.txt', '/etc'], 'a folder Codex wants to write to is checked like a path');
  assert.strictEqual(codexCard({ kind: 'edit', paths: ['/w/a', '/x/b', '/w/c', '/w/d'], changes: [{ path: '/w/a', type: 'update', to: '/x/b' }, { path: '/w/c', type: 'delete' }, { path: '/w/d', type: 'add' }] }, rel).title, 'Move a to /x/b, Delete c, Create d');
});

// ---------- Kestrel findings on 0254210 ----------
test('a sensitive file always gets a card, even under "Allow edits for this task", and never creates the rule', async () => {
  const r = room(); r.tasks.mode = 'work'; r.postFromHuman('@claude job');
  const a = r.requestApproval('claude', { ...edit('Edit package.json'), sensitive: 'package.json can run code' });
  r.answerApproval(r.state.transcript.at(-1).approval.id, 'allowTask'); await a;
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'allowed', 'recorded as allowed once, not for the task');
  r.requestApproval('claude', edit('Edit src/a.js'));
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'no standing rule was made');
  r.answerApproval(r.state.transcript.at(-1).approval.id, 'allowTask');
  r.requestApproval('claude', { ...edit('Edit .vscode/tasks.json'), sensitive: 'x' });
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'the rule never covers a sensitive file');
});

test('a card can\'t outlive its turn; cards are never delivered to agents; long changes are cut and say so', async () => {
  const claude = { typed: true, inbox: [] }; let finish; claude.send = (t) => { claude.inbox.push(t); return new Promise((res) => { finish = res; }); };
  const codex = { typed: true, inbox: [], send: (t) => { codex.inbox.push(t); return Promise.resolve('ok'); } };
  const r = new Room({ agents: { claude, codex } });
  r.postFromHuman('@claude go');
  const p = r.requestApproval('claude', { ...edit(), detail: 'x'.repeat(9000) });
  const card = r.state.transcript.at(-1).approval;
  assert.deepStrictEqual([card.detail.length, card.detailCut], [4000, 9000]);
  assert.strictEqual(r.pendingApprovals.get(card.id).full.length, 9000, 'the whole change can be read before answering');
  finish('done'); await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual(await p, { allow: false, why: 'its turn ended' });
  assert.strictEqual(r.answerApproval(card.id, 'allow'), false, 'a late Allow does nothing');
  r.postFromHuman('@codex anything new?'); await new Promise((res) => setTimeout(res, 10));
  assert.doesNotMatch(codex.inbox[0], /Edit a\.txt/, 'the card title (agent-written text) never reaches another agent');
  assert.match(codex.inbox[0], /anything new/);
});

test('refusals from the host are recorded with their reason and never shown as a question', async () => {
  const r = room(); r.postFromHuman('@claude go');
  assert.deepStrictEqual(await r.requestApproval('claude', { ...edit(), refused: 'inside git\'s own folder, where an edit can run commands' }), { allow: false, why: 'inside git\'s own folder, where an edit can run commands' });
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'denied');
  assert.strictEqual(r.pendingApprovals.size, 0);
});

test('Codex: a moved file\'s destination is checked; a change the room never saw has no paths', async () => {
  const asked = [];
  const { c, line } = fakeCodex({ access: 'edit', onApproval: async (req) => { asked.push(req); return { allow: false }; } });
  c.currentTurn = { threadId: 't1', turnId: 'u1', started: true, cancelled: false };
  line({ method: 'item/started', params: { threadId: 't1', item: { id: 'i1', type: 'fileChange', changes: [{ path: '/w/a.txt', diff: 'd', kind: { type: 'update', move_path: '/outside/a.txt' } }] } } });
  line({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1' } }); await tick();
  line({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'never-seen' } }); await tick();
  assert.deepStrictEqual(asked[0].paths, ['/w/a.txt', '/outside/a.txt']);
  assert.deepStrictEqual(asked[0].changes[0], { path: '/w/a.txt', type: 'update', to: '/outside/a.txt', diff: 'd' });
  assert.deepStrictEqual(asked[1].paths, [], 'no paths: editPolicy.check refuses it');
});

test('Claude: a turn Claude started on its own can\'t ask to edit', async () => {
  const { c, writes, line } = fakeClaude({ access: 'edit', onPermission: async () => ({ allow: true }), onUnprompted: () => ({ resolve() {}, reject() {} }) });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'report' }] } });
  line(canUse('Edit', { file_path: '/w/a.txt' }, 'u1')); await tick();
  assert.strictEqual(answer(writes, 'u1').behavior, 'deny');
});

test('a card asked for after the agent\'s turn ended is refused at once', async () => {
  const claude = { typed: true, send: () => Promise.resolve('done') }, r = new Room({ agents: { claude, codex: claude } });
  r.postFromHuman('@claude go'); await tick(); await tick();
  assert.deepStrictEqual(await r.requestApproval('claude', edit()), { allow: false, why: 'its turn ended' });
  assert.strictEqual(r.pendingApprovals.size, 0);
});

test('a Codex request to write to a whole folder never falls under "Allow edits for this task"; an unseen change is refused', async () => {
  const r = room(); r.tasks.mode = 'work'; r.postFromHuman('@claude @codex job');
  const a = r.requestApproval('codex', edit()); r.answerApproval(r.state.transcript.at(-1).approval.id, 'allowTask'); await a;
  const card = codexCard({ kind: 'edit', paths: [], grantRoot: '/w', changes: [] }, (x) => x);
  assert.match(card.refused, /couldn't see which files/);
  const b = codexCard({ kind: 'edit', paths: ['/w/a'], grantRoot: '/w', changes: [{ path: '/w/a', type: 'update' }] }, (x) => x);
  r.requestApproval('codex', b);
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'pending', 'grantRoot always asks');
  r.answerApproval(r.state.transcript.at(-1).approval.id, 'allowTask');
  assert.strictEqual(r.state.transcript.at(-1).approval.status, 'allowed', 'and never becomes the rule');
});
