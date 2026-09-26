'use strict';
// RoomSession.boot, the path New Room and Reopen take, with the CLIs and VS Code stubbed. Room unit tests do not
// cover it: a new room (no saved state) crashed here in the native run of 572138e.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module');

let experimentalAgents, acpBehavior, allowBypass;
const acpStarts = [];
class FakeAcp {
  constructor(o) { this.o = o; this.capabilities = { loadSession: true }; this.calls = []; this.stops = 0; }
  async start() { acpStarts.push(this.o); this.calls.push('start'); if (!acpBehavior) throw new Error('synthetic missing agent'); acpBehavior.client = this; if (acpBehavior.start) await acpBehavior.start(); }
  async newSession() { this.calls.push('new'); if (acpBehavior.new) await acpBehavior.new(); this.sessionId = 'gemini-new'; }
  async loadSession(id) { this.calls.push('load'); if (acpBehavior.load) await acpBehavior.load(); this.sessionId = id; }
  stop() { this.stops++; }
}
const stubs = {
  vscode: { workspace: { getConfiguration: () => ({ get: (key) => key === 'experimentalAgents' ? experimentalAgents : key === 'allowBypass' ? allowBypass : undefined, inspect: (key) => key === 'experimentalAgents' && experimentalAgents !== undefined ? { workspaceValue: experimentalAgents } : undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: true },
    ConfigurationTarget: { Global: 1 }, window: {}, commands: { executeCommand: async () => {} }, env: {}, Uri: { file: (p) => ({ fsPath: p }) } },
};
let fakeThreadSeq = 0;
let resumeFailure = null; // set by a test: what FakeCodex.resumeThread throws
class FakeCodex { constructor(o) { this.o = o; this.lastTurnUsage = null; } async start() {} on() {} async startThread() { return { id: `th-new-${++fakeThreadSeq}` }; } async resumeThread(id) { if (resumeFailure) throw resumeFailure; return { id }; } async forkThread() { return { id: `th-fork-${++fakeThreadSeq}` }; }
  async recentMessages() { return [{ role: 'human', text: 'CODEX_SEED_PRIVATE' }]; } async setName() {} async listModels() { return []; } async rateLimits() { return null; } async listThreads() { return []; } stop() {} }
class FakeClaude { constructor(o) { Object.assign(this, o); this.totalCostUsd = 0; this.lastUsage = null; this.typed = true; } stop() {} setOptions() {} }
const fakes = {
  [path.join(__dirname, '../src/claudeHistory.js')]: { ROOT: os.tmpdir(), recentMessages: () => [{ role: 'human', text: 'CLAUDE_SEED_PRIVATE' }], fileFor: (id) => `/synthetic/${id}.jsonl`, titleFor: (id) => (id === 'source-claude' ? 'My Claude chat' : null) },
  [path.join(__dirname, '../src/acpClient.js')]: { AcpClient: FakeAcp },
  [path.join(__dirname, '../src/codexClient.js')]: { CodexClient: FakeCodex, FORBIDDEN: new Set() },
  [path.join(__dirname, '../src/claudeClient.js')]: { ClaudeClient: FakeClaude, READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep'] },
  [path.join(__dirname, '../src/claudeBinary.js')]: { findClaude: () => ({ path: 'claude', version: [2, 1, 281] }), atLeast: () => true },
  [path.join(__dirname, '../src/claudeUsage.js')]: { fetch: async () => null, blockFor: () => null },
};
const realLoad = Module._load;
Module._load = function (req, parent, ...a) {
  if (req === 'vscode') return stubs.vscode;
  const file = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
  if (file && fakes[file]) return fakes[file];
  return realLoad.call(this, req, parent, ...a);
};
delete require.cache[require.resolve('../src/extension')];
const { RoomSession, newMeta, deactivate } = require('../src/extension');
Module._load = realLoad;

const context = () => ({ globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'wwboot-')) } });

test('New Room: a room with no saved state boots, starts on the current rules and shows no upgrade notice', async () => {
  const s = new RoomSession(context(), newMeta('fresh'), null);
  await s.boot();
  assert.ok(s.room);
  assert.strictEqual(s.meta.codexTyped, true);
  assert.strictEqual(s.meta.handoffRule, 4);
  assert.ok(!s.room.state.transcript.some((e) => /is now Wagon Wheel/.test(e.text)));
  assert.ok(fs.existsSync(s.file), 'saved');
  s.dispose();
});

test('Reopen: an older room with messages gets the upgrade notice once; an empty older room gets none', async () => {
  const meta = { id: 'old1', name: 'old', cwd: os.tmpdir(), codexThreadId: 'th-old', claudeSessionId: null, handoffRule: 2 };
  const state = { transcript: [{ id: 1, from: 'human', text: 'hi', ts: 1, to: ['claude'] }], cursors: { claude: 1, codex: 0 }, lastTargets: ['claude'], seq: 1 };
  const s = new RoomSession(context(), meta, state);
  await s.boot();
  assert.strictEqual(s.room.state.transcript.filter((e) => /is now Wagon Wheel/.test(e.text)).length, 1);
  assert.strictEqual(s.meta.handoffRule, 4);
  s.dispose();
  const empty = new RoomSession(context(), { id: 'old2', name: 'e', cwd: os.tmpdir(), codexThreadId: 'th-old', claudeSessionId: null }, null);
  await empty.boot();
  assert.strictEqual(empty.room.state.transcript.length, 0);
  empty.dispose();
});

test('experimental profiles: off by default, only known Gemini accepted once, malformed settings ignored', async () => {
  const run = async (value) => {
    experimentalAgents = value; acpStarts.length = 0;
    let s;
    try { s = new RoomSession(context(), newMeta('profile check'), null); await s.boot(); return acpStarts.slice(); }
    finally { if (s) s.dispose(); experimentalAgents = undefined; }
  };
  assert.deepStrictEqual(await run(undefined), []);
  for (const value of ['gemini', {}, ['constructor', 'toString', '__proto__'], [{ id: 'gemini', command: '/unexpected' }]]) {
    assert.deepStrictEqual(await run(value), [], 'invalid profile input cannot start an agent');
  }
  const got = await run(['gemini', 'gemini', 'unknown']);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].exe, 'gemini');
  assert.deepStrictEqual(got[0].args, ['--experimental-acp']);
});


const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

for (const phase of ['start', 'new', 'load']) test(`closing during ACP ${phase} owns and stops the pending client; late completion cannot revive boot`, async () => {
  const entered = deferred(), release = deferred();
  experimentalAgents = ['gemini'];
  acpBehavior = { [phase]: async () => { entered.resolve(); await release.promise; } };
  const meta = newMeta(`close during ${phase}`);
  if (phase === 'load') meta.extra = { gemini: { sessionId: 'gemini-saved' } };
  const s = new RoomSession(context(), meta, null);
  const boot = s.boot();
  try {
    await entered.promise;
    const client = acpBehavior.client;
    s.dispose(); const stoppedAtClose = client.stops;
    // A late boot/save must not overwrite newer data after the room has been disposed.
    fs.writeFileSync(s.file, 'SYNTHETIC_AFTER_CLOSE');
    release.resolve(); await boot;
    await s.boot(); // disposal is permanent, even if a caller tries to boot this object again
    assert.ok(stoppedAtClose > 0, 'the pending client is stopped at close, before its await resolves');
    assert.strictEqual(s.room, undefined);
    assert.strictEqual(s.scheduler, undefined);
    assert.strictEqual(s.extras.length, 0);
    assert.deepStrictEqual(client.calls, phase === 'start' ? ['start'] : ['start', phase]);
    s.save();
    assert.strictEqual(fs.readFileSync(s.file, 'utf8'), 'SYNTHETIC_AFTER_CLOSE');
  } finally {
    release.resolve(); await boot.catch(() => {}); s.dispose();
    experimentalAgents = undefined; acpBehavior = undefined;
  }
});

for (const side of ['codex', 'claude']) test(`bringing in a ${side} conversation: shared messages reach the other agents, never an extra agent; Keep private seeds nothing`, async () => {
  experimentalAgents = ['gemini']; acpBehavior = {};
  const marker = side === 'codex' ? 'CODEX_SEED_PRIVATE' : 'CLAUDE_SEED_PRIVATE';
  const peer = side === 'codex' ? 'claude' : 'codex';
  const opened = [];
  try {
    for (const share of [true, false]) {
      const meta = newMeta('join consent');
      meta.seats = [{ id: 'claude', label: 'Claude', provider: 'claude', cwd: os.tmpdir(), ...(side === 'claude' ? { forkFrom: 'source-claude' } : {}) },
        { id: 'codex', label: 'Codex', provider: 'codex', cwd: os.tmpdir(), ...(side === 'codex' ? { forkFrom: 'source-codex', typed: false } : {}) }];
      const s = new RoomSession(context(), meta, null); opened.push(s);
      await s.boot({ shareSeed: { [side]: share } });
      assert.strictEqual(s.room.payloadFor(peer).text.includes(marker), share);
      assert.ok(!s.room.payloadFor('gemini').text.includes(marker));
      assert.ok(!s.room.payloadFor(side).text.includes(marker));
      if (!share) assert.ok(!JSON.stringify(s.room.state.transcript).includes(marker));
    }
  } finally { for (const s of opened) s.dispose(); experimentalAgents = undefined; acpBehavior = undefined; }
});

test('a booted room holds its cross-window lock until it closes, and a second window is refused meanwhile', async () => {
  const roomLock = require('../src/roomLock');
  const ctx = context(), s = new RoomSession(ctx, newMeta('locked'), null);
  await s.boot();
  const lock = roomLock.lockPath(s.file);
  assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.strictEqual(roomLock.acquire(s.file, { self: process.pid + 100000, kill: () => {} }).ok, false, 'another window sees it held');
  s.dispose();
  assert.ok(!fs.existsSync(lock), 'closing releases it');
});

test('reopen: a Codex thread this room created that was never written starts fresh; spoken, forked or other failures refuse', async () => {
  const roomLock = require('../src/roomLock');
  const noRollout = () => Object.assign(new Error('Codex room permissions could not be verified: thread/resume failed.'), { roomPermission: true, noRollout: true });
  const state = (transcript) => ({ transcript, cursors: { claude: 0, codex: 0 }, lastTargets: ['claude'], seq: transcript.length });
  const refused = async (s) => { const r = await s.boot().then(() => { s.dispose(); return new Error('booted'); }, (e) => e); return r.message; };
  try {
    resumeFailure = noRollout();
    const quiet = new RoomSession(context(), { ...newMeta('closed early'), codexThreadId: 'th-never-written', codexTypedThreads: ['th-never-written'], claudeSessionId: null },
      state([{ id: 1, from: 'human', text: 'hi', ts: 1 }, { id: 2, from: 'codex', kind: 'history', text: 'seeded', ts: 2 }]));
    await quiet.boot();
    const seat = quiet.slots.codex.seat;
    assert.match(seat.sessionId, /^th-new-/, 'a fresh thread replaced the unwritten one');
    assert.deepStrictEqual(seat.typedThreads, ['th-never-written', seat.sessionId]);
    assert.strictEqual(seat.typed, true);
    assert.ok(quiet.room.state.transcript.some((e) => e.from === 'system' && /Codex never saved Codex's earlier conversation because it had no replies yet/.test(e.text)), 'the person is told');
    const again = new RoomSession(context(), { ...newMeta('other room'), codexThreadId: 'th-never-written', codexTypedThreads: ['th-never-written'] }, state([]));
    resumeFailure = null;
    await again.boot(); // the old id was released, so another room may bind it
    again.dispose(); quiet.dispose();

    resumeFailure = noRollout();
    const spokeCtx = context();
    const spoke = new RoomSession(spokeCtx, { ...newMeta('talked'), codexThreadId: 'th-lost', codexTypedThreads: ['th-lost'], claudeSessionId: null },
      state([{ id: 1, from: 'codex', text: 'an answer', ts: 1 }]));
    assert.match(await refused(spoke), /thread\/resume failed/, 'history was expected: refuse instead of starting over');
    assert.ok(!fs.existsSync(roomLock.lockPath(spoke.file)), 'a room that failed to start releases its lock');

    // A copy that was never written is copied again from the same source; the person's original is never touched.
    const forked = new RoomSession(context(), { ...newMeta('forked'), codexThreadId: 'th-fork', forkedFrom: 'th-users-own', claudeSessionId: null }, state([]));
    await forked.boot();
    assert.match(forked.slots.codex.seat.sessionId, /^th-fork-/); assert.strictEqual(forked.slots.codex.seat.forkFrom, 'th-users-own');
    assert.ok(forked.room.state.transcript.some((e) => e.from === 'system' && /starts from a new copy of the same conversation/.test(e.text)));
    forked.dispose();
    const forkedSpoke = new RoomSession(context(), { ...newMeta('forked, talked'), codexThreadId: 'th-fork2', forkedFrom: 'th-users-own', claudeSessionId: null }, state([{ id: 1, from: 'codex', text: 'an answer', ts: 1 }]));
    assert.match(await refused(forkedSpoke), /thread\/resume failed/, 'a copy that had answered is never silently replaced');

    const continued = new RoomSession(context(), { ...newMeta('continued'), codexThreadId: 'th-external', claudeSessionId: null }, state([]));
    assert.match(await refused(continued), /thread\/resume failed/, 'a continued external thread (not created by this room) is never replaced');

    resumeFailure = Object.assign(new Error('Codex room permissions could not be verified: thread/resume failed.'), { roomPermission: true, noRollout: false });
    const other = new RoomSession(context(), { ...newMeta('other'), codexThreadId: 'th-x', codexTypedThreads: ['th-x'], claudeSessionId: null }, state([]));
    assert.match(await refused(other), /thread\/resume failed/, 'other resume failures still fail');
  } finally { resumeFailure = null; }
});

test('closing the window (deactivate) releases the locks of rooms this window has open', async () => {
  const roomLock = require('../src/roomLock');
  const s = new RoomSession(context(), newMeta('open at shutdown'), null);
  await s.boot();
  assert.ok(fs.existsSync(roomLock.lockPath(s.file)));
  // boot() alone does not register the room as open (attach does); register it the way openSession does.
  s.attach({ webview: { onDidReceiveMessage: () => {}, postMessage: () => {} }, onDidDispose: () => {} });
  deactivate();
  assert.ok(!fs.existsSync(roomLock.lockPath(s.file)));
  s.dispose();
});

test('Start a Room: any agent can start from a copy or the original, and sharing reaches every other agent only', async () => {
  const dir = os.tmpdir();
  const meta = { ...newMeta('from the start screen'), seats: [
    { id: 'app', label: 'App', provider: 'codex', cwd: dir, forkFrom: 'th-src', typed: false },
    { id: 'rev', label: 'Reviewer', provider: 'claude', cwd: dir, forkFrom: 'cl-src' },
    { id: 'orig', label: 'Original', provider: 'claude', cwd: dir, sessionId: 'cl-orig' },
    { id: 'fresh', label: 'Fresh', provider: 'codex', cwd: dir }] };
  const s = new RoomSession(context(), meta, null);
  try {
    await s.boot({ shareSeed: { app: true, orig: true } });
    const app = s.slots.app.seat, rev = s.slots.rev, orig = s.slots.orig, fresh = s.slots.fresh.seat;
    assert.match(app.sessionId, /^th-fork-/, 'a copy of the Codex conversation');
    assert.strictEqual(app.forkFrom, 'th-src'); assert.strictEqual(app.typed, false);
    assert.strictEqual(rev.client.forkFrom, 'cl-src', 'Claude starts from a copy');
    assert.strictEqual(orig.client.sessionId, 'cl-orig'); assert.strictEqual(orig.client.forkFrom, null, 'the original is resumed, not copied');
    assert.match(fresh.sessionId, /^th-new-/); assert.strictEqual(fresh.typed, true);
    // Shared: App's copy reaches the three others; Original's reaches the others; Reviewer shared nothing.
    for (const id of ['rev', 'orig', 'fresh']) assert.ok(s.room.payloadFor(id).text.includes('CODEX_SEED_PRIVATE'), `${id} sees App's shared messages`);
    assert.ok(!s.room.payloadFor('app').text.includes('CODEX_SEED_PRIVATE'), 'not echoed to its own agent');
    assert.ok(!s.room.payloadFor('orig').text.includes('CLAUDE_SEED_PRIVATE') && s.room.payloadFor('app').text.includes('CLAUDE_SEED_PRIVATE'));
  } finally { s.dispose(); }
});

test('a saved room exposes each seat\'s conversation id to the rooms list (what the Start screen\'s conflict check reads)', async () => {
  const roomsView = require('../src/roomsView');
  const ctx = context(), meta = newMeta('holds an original');
  meta.seats = [{ id: 'claude', label: 'Claude', provider: 'claude', cwd: os.tmpdir(), sessionId: 'cl-orig' }, { id: 'codex', label: 'Codex', provider: 'codex', cwd: os.tmpdir() }];
  const s = new RoomSession(ctx, meta, null);
  await s.boot(); s.dispose(); // dispose saves the room file the way a real close does
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.ok(Array.isArray(saved.meta.participants) && saved.meta.participants.every((p) => !('sessionId' in p)), 'participants is the display copy, without ids');
  const [room] = roomsView.listRooms(path.dirname(s.file));
  assert.deepStrictEqual(room.seats.find((x) => x.provider === 'claude').sessionId, 'cl-orig');
  assert.match(room.seats.find((x) => x.provider === 'codex').sessionId, /^th-new-/);
});

test('a room made before sources were recorded looks up its copies\' titles once it starts', async () => {
  const meta = { ...newMeta('older room'), claudeForkedFrom: 'source-claude', forkedFrom: 'source-codex', claudeSessionId: null, codexThreadId: null };
  const s = new RoomSession(context(), meta, null);
  try {
    await s.boot();
    s.slots.codex.client.listThreads = async () => [{ id: 'source-codex', name: 'My Codex thread' }];
    await s.fillSourceTitles();
    assert.deepStrictEqual(s.meta.sources, { claude: { kind: 'copy', id: 'source-claude', title: 'My Claude chat' }, codex: { kind: 'copy', id: 'source-codex', title: 'My Codex thread' } });
    assert.deepStrictEqual(s.controls().claude.source, s.meta.sources.claude);
  } finally { s.dispose(); }
});

test('reopening a room: a resumed Codex thread counts as saved (its conversation can be handed over without a new reply)', async () => {
  const s = new RoomSession(context(), { ...newMeta('reopened'), codexThreadId: 'th-resumed-1', codexTypedThreads: ['th-resumed-1'], claudeSessionId: null },
    { transcript: [], cursors: { claude: 0, codex: 0 }, lastTargets: ['claude'], seq: 0 });
  try { await s.boot(); assert.strictEqual(s.ownConversation('codex'), 'th-resumed-1'); } finally { s.dispose(); }
});

test('editing agents: the room asks you, refuses paths outside the folder, keeps one editor, and closing denies', async () => {
  const dir = fs.realpathSync(os.tmpdir());
  const meta = { ...newMeta('edits'), seats: [{ id: 'claude', label: 'Claude', provider: 'claude', cwd: dir, access: 'edit' }, { id: 'codex', label: 'Codex', provider: 'codex', cwd: dir }] };
  const s = new RoomSession(context(), meta, null);
  const asked = []; stubs.vscode.window.showWarningMessage = async (m, o, ...choices) => { asked.push(m); return choices[0]; };
  try {
    await s.boot({});
    const claude = s.slots.claude.client, codex = s.slots.codex.client;
    assert.strictEqual(claude.access, 'edit'); assert.strictEqual(typeof claude.onPermission, 'function');
    assert.strictEqual(codex.o.access, 'read'); assert.strictEqual(typeof codex.o.onApproval, 'function');
    s.room.postFromHuman('@claude go'); await new Promise((res) => setImmediate(res));
    s.room.busy.claude = true; // mid-turn (the fake client has no send)
    assert.strictEqual((await claude.onPermission({ tool: 'Edit', input: { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' } })).allow, false, 'outside the folder: no card');
    const inside = claude.onPermission({ tool: 'Edit', input: { file_path: path.join(dir, 'a.txt'), old_string: 'a', new_string: 'b' } });
    await new Promise((res) => setTimeout(res, 50)); // the host checks the path (and git's folders) before the card
    const card = s.room.state.transcript.filter((e) => e.kind === 'approval').at(-1).approval;
    assert.deepStrictEqual([card.status, card.title], ['pending', 'Edit a.txt']);
    s.room.answerApproval(card.id, 'allow'); assert.strictEqual((await inside).allow, true);
    s.room.busy.claude = false; // its turn is over
    // One editor per room.
    await s.runCommand('/codex access edit');
    assert.match(s.room.state.transcript.at(-1).text, /Only one agent in a room can edit files, and Claude already can/);
    // A standing rule ends when the agent's level changes.
    s.room.state.allowRules = [{ seat: 'claude', scope: s.room._approvalScope() }];
    await s.runCommand('/claude access read'); assert.strictEqual(s.slots.claude.seat.access, 'read');
    assert.deepStrictEqual(s.room.state.allowRules, []);
    await s.runCommand('/codex access run');
    assert.strictEqual(s.slots.codex.seat.access, 'run'); assert.strictEqual(codex.access, 'run'); assert.match(asked.at(-1), /Let Codex edit files and run commands in/);
    // Codex was briefed as read only; its next turn opens with what it can do now, once.
    const turns = []; codex.runTurn = (id, text) => { turns.push(text); return Promise.resolve('ok'); };
    await s.room.agents.codex.send('first', () => {}, () => {}, [], null);
    await s.room.agents.codex.send('second', () => {}, () => {}, [], null);
    assert.match(turns[0], /changed what you can do in this room[\s\S]*apply_patch[\s\S]*first$/);
    assert.strictEqual(turns[1], 'second');
    s.room.busy.codex = true;
    const waiting = codex.o.onApproval({ kind: 'command', command: 'npm test', reason: '' }); void waiting;
    await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(s.room.pendingApprovals.size, 1);
  } finally { s.dispose(); delete stubs.vscode.window.showWarningMessage; }
  assert.strictEqual(s.room.state.transcript.filter((e) => e.kind === 'approval').at(-1).approval.status, 'denied', 'closing the room denied the waiting card');
});

test('modes: auto from the menu; bypass needs the setting and a warning each time; Stop and reopening turn modes off', async () => {
  const dir = fs.realpathSync(os.tmpdir());
  const meta = { ...newMeta('modes'), seats: [{ id: 'codex', label: 'Codex', provider: 'codex', cwd: dir, access: 'run', mode: 'bypass' }, { id: 'claude', label: 'Claude', provider: 'claude', cwd: dir }] };
  const warned = []; stubs.vscode.window.showWarningMessage = async (m, o, ...choices) => { warned.push(m); return choices[0]; };
  allowBypass = false;
  const s = new RoomSession(context(), meta, null);
  try {
    await s.boot({});
    const p = s.slots.codex.seat;
    assert.strictEqual(p.mode, 'ask', 'bypass never survives a reopen');
    assert.ok(s.room.state.transcript.some((e) => /bypass mode ended when the room closed/.test(e.text)));
    await s.runCommand('/codex mode auto'); assert.strictEqual(p.mode, 'auto');
    assert.strictEqual(s.room.modeFor('codex'), 'auto');
    await s.runCommand('/codex mode bypass'); assert.strictEqual(p.mode, 'auto', 'refused while the setting is off');
    assert.match(s.room.state.transcript.at(-1).text, /Bypass is off in your settings/);
    s.options.allowBypass = true;
    await s.runCommand('/codex mode bypass'); assert.strictEqual(p.mode, 'bypass');
    assert.match(warned.at(-1), /Let Codex edit files and run commands without asking you\?/);
    s.room.postFromHuman('@codex go'); s.room.stopAll();
    assert.strictEqual(p.mode, 'ask', 'Stop turns it off');
    assert.ok(s.room.state.transcript.some((e) => /Stop turned off Codex's bypass mode/.test(e.text)));
    await s.runCommand('/claude mode auto');
    assert.match(s.room.state.transcript.at(-1).text, /can only read/);
    p.mode = 'bypass'; s.room.busy.codex = false;
    await s.runCommand('/codex access edit');
    assert.strictEqual(p.mode, 'ask', 'a mode never outlives the level it needs');
  } finally { s.dispose(); delete stubs.vscode.window.showWarningMessage; allowBypass = undefined; }
});
