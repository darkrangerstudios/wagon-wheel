'use strict';
// Start a Room: the plan builder's rules, the screen's host messages, and the screen itself (media/start.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const Module = require('module');
const startRoom = require('../src/startRoom');
const { Element, walk } = require('./fixtures/webview-dom');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wwstart-'));
const A = (provider, extra = {}) => ({ provider, label: provider === 'claude' ? 'Claude' : 'Codex', model: null, effort: null, start: 'fresh', conversation: null, folder: null, share: false, ...extra });

test('plan: the default pair gets the familiar ids; names become unique ids; nothing starts yet', () => {
  const cwd = dir();
  const p = startRoom.buildPlan({ name: ' Review ', agents: [A('claude'), A('codex')] }, { defaultCwd: cwd });
  assert.strictEqual(p.name, 'Review');
  assert.deepStrictEqual(p.seats.map(({ id, label, provider, cwd: c }) => ({ id, label, provider, c })), [
    { id: 'claude', label: 'Claude', provider: 'claude', c: cwd }, { id: 'codex', label: 'Codex', provider: 'codex', c: cwd }]);
  const two = startRoom.buildPlan({ name: 'x', agents: [A('codex', { label: 'Application' }), A('codex', { label: 'Application' }), A('claude', { label: 'Both' }), A('claude', { label: '9 lives' })] }, { defaultCwd: cwd });
  assert.deepStrictEqual(two.seats.map((s) => s.id), ['application', 'application-2', 'claude', 'claude-2'], 'duplicates numbered; reserved or non-letter names fall back to the app');
  assert.deepStrictEqual(two.shareSeed, {}); assert.deepStrictEqual(two.originals, []);
});

test('plan: a copy or the original must be one of the listed conversations; Claude uses the conversation\'s folder', () => {
  const home = dir(), convFolder = dir(), codexFolder = dir();
  const lists = { claude: [{ id: 'cl-1', cwd: convFolder, when: 1 }], codex: [{ id: 'th-1', cwd: codexFolder, when: 2 }, { id: 'th-gone', cwd: '/no/such/folder', when: 3 }] };
  const p = startRoom.buildPlan({ name: 'r', agents: [
    A('claude', { start: 'copy', conversation: 'cl-1', folder: home, share: true }),
    A('codex', { start: 'original', conversation: 'th-1', folder: home }),
    A('codex', { label: 'Old', start: 'copy', conversation: 'th-gone', folder: home, share: true })] }, { lists, defaultCwd: home });
  const [cl, cx, old] = p.seats;
  assert.strictEqual(cl.cwd, convFolder, 'Claude reopens a conversation only from the folder it started in');
  assert.strictEqual(cl.forkFrom, 'cl-1'); assert.strictEqual(cl.sessionId, null);
  assert.strictEqual(cx.sessionId, 'th-1'); assert.strictEqual(cx.cwd, codexFolder); assert.strictEqual(cx.typed, false);
  assert.strictEqual(old.cwd, home, 'a Codex conversation whose folder is gone keeps the chosen folder'); assert.strictEqual(old.forkFrom, 'th-gone');
  assert.deepStrictEqual(p.shareSeed, { claude: true, 'old': true });
  assert.deepStrictEqual(p.originals, [{ label: 'Codex', provider: 'codex', id: 'th-1', when: 2 }]);
  assert.deepStrictEqual(p.sources, { claude: { kind: 'copy', id: 'cl-1', title: null }, codex: { kind: 'original', id: 'th-1', title: null }, old: { kind: 'copy', id: 'th-gone', title: null } }, 'each agent remembers where it started');
});

test('plan: refuses what the screen should never send, with a sentence a person can act on', () => {
  const cwd = dir(), lists = { claude: [{ id: 'cl-1', cwd, when: 1 }], codex: [] };
  const bad = (form, re, ctx = {}) => assert.throws(() => startRoom.buildPlan(form, { lists, defaultCwd: cwd, codexModels: [{ id: 'gpt-x', efforts: ['low', 'high'] }], ...ctx }), re);
  bad({ name: '', agents: [A('claude')] }, /Give the room a name/);
  bad({ name: 'r', agents: [] }, /at least one agent/);
  bad({ name: 'r', agents: Array.from({ length: 7 }, () => A('claude')) }, /up to 6 agents/);
  bad({ name: 'r', agents: [A('gemini')] }, /choose Claude or Codex/);
  bad({ name: 'r', agents: [A('claude', { label: ' ' })] }, /name of 1 to 60/);
  bad({ name: 'r', agents: [A('claude', { start: 'copy', conversation: 'not-listed' })] }, /pick one of your Claude conversations/);
  bad({ name: 'r', agents: [A('claude', { start: 'original', conversation: 'cl-1' }), A('claude', { label: 'Two', start: 'original', conversation: 'cl-1' })] }, /can't both keep going in the same original/);
  bad({ name: 'r', agents: [A('claude', { folder: '/no/such/folder' })] }, /folder no longer exists/);
  bad({ name: 'r', agents: [A('claude', { model: 'gpt-4' })] }, /model isn't available/);
  bad({ name: 'r', agents: [A('codex', { model: 'gpt-x', effort: 'max' })] }, /thinking effort isn't available/);
  bad({ name: 'r', agents: [A('claude', { start: 'sideways' })] }, /choose how it starts/);
  bad(null, /Something went wrong/);
  bad({ name: 'r', agents: [A('claude', { start: 'copy', conversation: 'cl-gone' })] }, /folder that conversation started in no longer exists/, { lists: { claude: [{ id: 'cl-gone', cwd: '/no/such/folder', when: 1 }], codex: [] } });
  // No model means Codex's own default: any effort a listed model offers is accepted.
  const models2 = [{ id: 'a', efforts: ['low'] }, { id: 'b', efforts: ['low', 'xhigh'] }];
  assert.strictEqual(startRoom.buildPlan({ name: 'r', agents: [A('codex', { effort: 'xhigh' })] }, { defaultCwd: cwd, codexModels: models2 }).seats[0].effort, 'xhigh');
  // Names that collide with JavaScript object keys fall back to the app name instead of failing validation.
  assert.strictEqual(startRoom.buildPlan({ name: 'r', agents: [A('claude', { label: 'Constructor' })] }, { defaultCwd: cwd }).seats[0].id, 'claude');
  // Two copies of one conversation are fine; only a second writer on the original is refused.
  assert.strictEqual(startRoom.buildPlan({ name: 'r', agents: [A('claude', { start: 'copy', conversation: 'cl-1' }), A('claude', { label: 'Two', start: 'copy', conversation: 'cl-1' })] }, { lists, defaultCwd: cwd }).seats.length, 2);
});

test('setup lines and conversation rows read as plain English and carry no control characters', () => {
  assert.deepStrictEqual(startRoom.setupLine({ provider: 'claude', installation: 'available', version: '2.1.282', authentication: 'present' }), { ready: true, text: 'Ready: Claude Code 2.1.282, signed in.', fix: null });
  assert.deepStrictEqual(startRoom.setupLine({ provider: 'codex', installation: 'missing', issue: 'missing' }), { ready: false, text: 'Codex isn\'t installed on this computer.', fix: 'install' });
  assert.strictEqual(startRoom.setupLine({ provider: 'claude', installation: 'available', version: '2.1.0', authentication: 'signed-out' }).fix, 'signin');
  assert.strictEqual(startRoom.setupLine({ provider: 'codex', installation: 'available', version: '0.1.0', authentication: 'unknown' }).ready, true);
  const row = startRoom.conversationRow({ id: 'x', cwd: '/home/alex/code/app', when: 5, title: 'Fix‮ the\nbug' }, '/home/alex');
  assert.deepStrictEqual(row, { id: 'x', title: 'Fix  the bug', folder: '~/code/app', when: 5, exists: false });
  assert.strictEqual(startRoom.conversationRow({ id: 'z', cwd: os.tmpdir() }).exists, true);
  assert.strictEqual(startRoom.conversationRow({ id: 'y', cwd: null }, '/h').title, 'Untitled conversation');
});

// The host side of the screen, with VS Code, the CLIs and their histories stubbed.
function loadHost({ lists = {}, recentMs = null, answer, fileFor = null, rooms = [], bootFails = null, claudeSessions = null, codexThreads = null, menu = null } = {}) {
  const disposable = { dispose() {} };
  const rec = { panels: [], warnings: [], opened: [] };
  const convDir = dir();
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }), workspaceFolders: undefined, isTrusted: true,
      registerTextDocumentContentProvider: () => disposable, onDidChangeConfiguration: () => disposable },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable, onDidChangeTextEditorVisibleRanges: () => disposable,
      registerTreeDataProvider: () => disposable, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage: async (m, o, ...b) => { rec.warnings.push({ m, o, b }); return answer; },
      showOpenDialog: async () => [{ fsPath: convDir }],
      createWebviewPanel: (type, title) => {
        const p = { type, title, sent: [], disposed: false, revealed: 0, webview: { html: '', cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: (fn) => { p.recv = fn; }, postMessage: (m) => { p.sent.push(m); } },
          onDidDispose: (fn) => { p.onClose = fn; }, reveal() { p.revealed++; }, dispose() { p.disposed = true; if (p.onClose) p.onClose(); } };
        rec.panels.push(p); return p;
      },
      withProgress: async () => { if (bootFails && bootFails.on) throw new Error('synthetic boot failure'); },
      showErrorMessage: async () => {},
    },
    commands: { registerCommand: (id, fn) => { (rec.cmd ||= {})[id] = fn; return disposable; }, executeCommand: async () => {} },
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} },
    TreeItem: class {}, ThemeIcon: class {}, TreeItemCollapsibleState: { None: 0 }, StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
    Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }), file: (p) => ({ fsPath: p }), parse: (u) => u },
    env: { openExternal: (u) => rec.opened.push(u) }, version: '1.104.0',
  };
  class FakeCodex { async start() {} async listModels() { return [{ id: 'gpt-x', displayName: 'GPT X', description: 'Frontier coding model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }]; }
    async listThreads() { return codexThreads ? codexThreads(convDir) : [{ id: 'th-1', name: 'Codex chat', cwd: convDir, updatedAt: 100 }]; } stop() {} on() {} }
  const now = Date.now();
  const fakes = {
    [require.resolve('../src/codexClient')]: { CodexClient: FakeCodex, FORBIDDEN: new Set() },
    [require.resolve('../src/claudeHistory')]: { ROOT: os.tmpdir(), listSessions: () => (claudeSessions ? claudeSessions(convDir) : null) || lists.claude || [{ id: 'cl-1', path: '/x', cwd: convDir, mtime: recentMs ? now - recentMs : now - 3600e3, title: 'Old chat', preview: 'hi' }], recentMessages: () => [], fileFor: () => fileFor },
    [require.resolve('../src/claudeBinary')]: { findClaude: () => ({ path: menu ? process.execPath : 'claude', version: [2, 1, 282] }), atLeast: () => true }, // an absolute path only when a test supplies a fake menu
    ...(menu ? { [require.resolve('../src/claudeModels')]: { ...require('../src/claudeModels'), query: () => menu.promise } } : {}),
    [require.resolve('../src/setup')]: { ...require('../src/setup'), checkSetup: async ({ executables }) => ({ executionHost: 'this computer', providers: Object.keys(executables).map((p) => ({ provider: p, installation: 'available', version: '1.0.0', authentication: p === 'codex' ? 'signed-out' : 'present' })) }) },
  };
  const realLoad = Module._load;
  Module._load = function (req, parent, ...a) {
    if (req === 'vscode') return vscode;
    const file = (() => { try { return Module._resolveFilename(req, parent); } catch { return null; } })();
    return file && fakes[file] ? fakes[file] : realLoad.call(this, req, parent, ...a);
  };
  let ext;
  try { delete require.cache[require.resolve('../src/extension')]; ext = require('../src/extension'); } finally { Module._load = realLoad; }
  const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, globalStorageUri: { fsPath: dir() }, extensionUri: { fsPath: path.join(__dirname, '..') } };
  const roomDir = path.join(context.globalStorageUri.fsPath, 'rooms'); fs.mkdirSync(roomDir, { recursive: true });
  for (const r of rooms) fs.writeFileSync(path.join(roomDir, `${r.meta.id}.json`), JSON.stringify(r));
  ext.activate(context);
  return { ext, rec, convDir };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('host: every launcher opens one Start a Room screen with status, models and conversations; Join Existing preselects conversations', async () => {
  const { rec } = loadHost();
  await rec.cmd['wagonWheel.newRoom']();
  assert.strictEqual(rec.panels.length, 1); const p = rec.panels[0];
  assert.strictEqual(p.title, 'Wagon Wheel: Start a Room');
  assert.match(p.webview.html, /script-src 'nonce-[^']+'/); assert.doesNotMatch(p.webview.html, /unsafe-inline/);
  await p.recv({ type: 'ready' }); await settle();
  const init = p.sent.find((m) => m.type === 'init'), st = p.sent.find((m) => m.type === 'setup'), lists = p.sent.find((m) => m.type === 'lists');
  assert.strictEqual(init.existing, false);
  assert.strictEqual(st.claude.ready, true); assert.strictEqual(st.codex.fix, 'signin');
  assert.deepStrictEqual(lists.conversations.claude.map((c) => c.title), ['Old chat']);
  assert.deepStrictEqual(lists.conversations.codex.map((c) => c.title), ['Codex chat']);
  assert.deepStrictEqual(lists.models.codex, [{ id: 'gpt-x', name: 'GPT X', note: 'Frontier coding model', efforts: ['low', 'high'] }], 'Codex\'s own names and descriptions');
  assert.ok(!JSON.stringify(lists).includes('"path"'), 'no file paths of conversation logs go to the page');
  await rec.cmd['wagonWheel.joinExisting']();
  assert.strictEqual(rec.panels.length, 1, 'one screen at a time'); assert.strictEqual(p.revealed, 1);
  assert.deepStrictEqual(p.sent.at(-1), { type: 'mode', existing: true });
  await p.recv({ type: 'guide', provider: 'codex' }); await p.recv({ type: 'guide', provider: 'https://evil.example' });
  assert.deepStrictEqual(rec.opened, [require('../src/setup').GUIDES.codex], 'only the known guide links open');
});

test('host: Start builds the room from the form, closes the screen and opens the room; a bad form gets a sentence back', async () => {
  const { rec, convDir } = loadHost();
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'Bad', agents: [{ provider: 'claude', label: 'Claude', start: 'copy', conversation: 'forged-id' }] } });
  assert.deepStrictEqual(p.sent.slice(-2), [{ type: 'error', text: 'Claude: pick one of your Claude conversations, or start fresh.' }, { type: 'busy', on: false }]);
  assert.strictEqual(rec.panels.length, 1);
  await p.recv({ type: 'start', form: { name: 'My room', agents: [{ provider: 'claude', label: 'Claude', start: 'copy', conversation: 'cl-1', share: true }, { provider: 'codex', label: 'Codex', start: 'fresh', model: 'gpt-x', effort: 'high' }] } });
  assert.strictEqual(p.disposed, true, 'the screen closes');
  assert.strictEqual(rec.panels.length, 2); assert.strictEqual(rec.panels[1].title, 'Wagon Wheel: My room');
  void convDir;
});

test('host: keeping going in an original that changed in the last two minutes asks first; declining starts nothing', async () => {
  const { rec } = loadHost({ recentMs: 30e3, answer: undefined });
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'r', agents: [{ provider: 'claude', label: 'Claude', start: 'original', conversation: 'cl-1' }] } });
  assert.strictEqual(rec.warnings.length, 1); assert.ok(rec.warnings[0].o.modal);
  assert.match(rec.warnings[0].m, /changed in the last two minutes/);
  assert.deepStrictEqual(p.sent.at(-1), { type: 'busy', on: false });
  assert.strictEqual(rec.panels.length, 1, 'no room opened');
});

// The page itself, run against a minimal DOM.
function loadPage() {
  const app = new Element('main'); app.id = 'app';
  const body = new Element('body'); body.appendChild(app);
  const sent = []; let listener;
  const document = { body, activeElement: null, createElement: (t) => new Element(t), getElementById: (id) => (id === 'app' ? app : null) };
  function Option(text, value) { const o = new Element('option'); o.textContent = text; o.value = value; return o; }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/start.js'), 'utf8'), { document, Option, CSS: { escape: (s) => s }, Date,
    window: { addEventListener: (k, fn) => { if (k === 'message') listener = fn; } }, acquireVsCodeApi: () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) }) }); // plain objects: the page runs in another realm
  const receive = (m) => listener({ data: m });
  const buttons = () => walk(app).filter((e) => e.tagName === 'button');
  const click = (text) => { const b = buttons().find((e) => e.textContent === text || walk(e).some((c) => c.textContent === text && ['o', 't'].includes(c.className))); if (!b) throw new Error(`no button ${text}`); b.fire('click'); };
  return { app, sent, receive, click, buttons, text: () => app.textContent };
}
const pageLists = { type: 'lists', conversations: { claude: [{ id: 'cl-1', title: 'Fix the parser', folder: '~/code/p', when: Date.now() - 3600e3 }], codex: [] }, models: { claude: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Most capable', efforts: ['low', 'high'] }], codex: [] } };

test('page: plain-English choices, a copy recommended by default, and the form it sends', () => {
  const pg = loadPage();
  assert.deepStrictEqual(pg.sent, [{ type: 'ready' }]);
  pg.receive({ type: 'init', existing: false, defaults: { name: 'Room 9/25/2026', folder: '/w', folderLabel: '~/w' }, trusted: true });
  pg.receive({ type: 'setup', claude: { ready: true, text: 'Ready: Claude Code 2.1.282, signed in.', fix: null }, codex: { ready: false, text: 'Codex 0.1.0 is installed, but you\'re signed out.', fix: 'signin' } });
  pg.receive(pageLists);
  const t = pg.text();
  for (const phrase of ['Start a room', 'Who\'s in the room', 'A fresh conversation', 'One of your Claude conversations', 'How to sign in', 'Works in', '~/w', 'Name the room', 'Start room',
    'Codex isn\'t ready yet and won\'t be able to answer until it is.']) assert.ok(t.includes(phrase), phrase);
  for (const jargon of ['seat', 'fork', 'Fork', 'working session', 'roster', 'participant']) assert.ok(!t.includes(jargon), `no "${jargon}" on the screen`);
  pg.click('One of your Claude conversations');
  assert.ok(pg.text().includes('Fix the parser'));
  pg.click('Fix the parser');
  const t2 = pg.text();
  assert.ok(t2.includes('Work on a copy (recommended)') && t2.includes('Keep going in the original') && t2.includes('Uses the folder where this conversation started'));
  assert.ok(t2.includes('Starting Claude (a copy of "Fix the parser") and Codex (fresh).'));
  pg.click('How to sign in'); assert.deepStrictEqual(pg.sent.at(-1), { type: 'guide', provider: 'codex' });
  pg.click('Start room');
  assert.deepStrictEqual(pg.sent.at(-1), { type: 'start', form: { name: 'Room 9/25/2026', agents: [
    { provider: 'claude', label: 'Claude', model: null, effort: null, start: 'copy', conversation: 'cl-1', folder: '/w', share: false, access: 'read' },
    { provider: 'codex', label: 'Codex', model: null, effort: null, start: 'fresh', conversation: null, folder: '/w', share: false, access: 'read' }], editIn: 'folder' } });
});

test('page: add and remove agents up to six, change a folder, and show the host\'s error', () => {
  const pg = loadPage();
  pg.receive({ type: 'init', existing: true, defaults: { name: 'R', folder: '/w', folderLabel: '~/w' }, trusted: true });
  pg.receive(pageLists);
  assert.ok(pg.text().includes('Pick a conversation above.'), 'Join Existing opens with conversations chosen');
  pg.click('+ Add Claude'); pg.click('+ Add Claude'); pg.click('+ Add Codex'); pg.click('+ Add Codex');
  assert.ok(pg.text().includes('A room holds up to 6 agents.'));
  assert.ok(pg.buttons().filter((b) => b.textContent.startsWith('+ Add')).every((b) => b.disabled));
  pg.click('Remove');
  assert.ok(!pg.text().includes('A room holds up to 6 agents.'));
  pg.receive({ type: 'folder', index: 1, folder: '/other', folderLabel: '~/other' });
  assert.ok(pg.text().includes('~/other'));
  pg.receive({ type: 'error', text: 'Claude: pick one of your Claude conversations, or start fresh.' });
  assert.ok(pg.text().includes('Claude: pick one of your Claude conversations, or start fresh.'));
  pg.receive({ type: 'busy', on: true });
  assert.ok(pg.buttons().find((b) => b.textContent === 'Starting…').disabled);
});

test('host: an original another saved room already uses is refused while the screen is still open', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  // The shape a room saves: meta.seats carries each seat's conversation id; meta.participants is a display copy without it.
  const { rec } = loadHost({ rooms: [{ meta: { id, name: 'Earlier room', seats: [{ id: 'claude', label: 'Claude', provider: 'claude', cwd: os.tmpdir(), sessionId: 'cl-1' }],
    participants: [{ id: 'claude', label: 'Claude', provider: 'claude', cwd: os.tmpdir() }] }, state: { transcript: [] } }] });
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'r', agents: [{ provider: 'claude', label: 'Claude', start: 'original', conversation: 'cl-1' }] } });
  assert.deepStrictEqual(p.sent.slice(-2), [{ type: 'error', text: 'Claude: that conversation is already used by the room "Earlier room". Use a copy instead.' }, { type: 'busy', on: false }]);
  assert.strictEqual(p.disposed, false); assert.strictEqual(rec.panels.length, 1);
});

test('host: the two-minute warning reads the conversation\'s time at Start, not from the list loaded earlier', async () => {
  const fresh = path.join(dir(), 'cl-1.jsonl'); fs.writeFileSync(fresh, '{}\n'); // written just now
  const { rec } = loadHost({ fileFor: fresh, answer: undefined }); // the list says an hour ago
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  await p.recv({ type: 'start', form: { name: 'r', agents: [{ provider: 'claude', label: 'Claude', start: 'original', conversation: 'cl-1' }] } });
  assert.strictEqual(rec.warnings.length, 1); assert.match(rec.warnings[0].m, /changed in the last two minutes/);
  assert.strictEqual(rec.panels.length, 1);
});

test('page: an untrusted folder says why it can\'t check, and a Codex conversation whose folder is gone keeps the chosen folder', () => {
  const pg = loadPage();
  pg.receive({ type: 'init', existing: false, defaults: { name: 'R', folder: '/w', folderLabel: '~/w' }, trusted: false });
  assert.ok(pg.text().includes('Trust this folder in VS Code to check Claude Code.'));
  pg.receive({ type: 'lists', conversations: { claude: [], codex: [{ id: 'th-1', title: 'Old Codex chat', folder: '/gone', when: 1, exists: false }] }, models: { claude: [], codex: [] } });
  pg.click('One of your Codex conversations'); pg.click('Old Codex chat');
  const t = pg.text();
  assert.ok(t.includes('~/w') && !t.includes('Uses the folder where this conversation started'), 'the folder shown is the one that will be used');
  assert.ok(t.includes('Codex can also read files elsewhere on this computer'), 'Codex\'s read scope is stated plainly');
});

test('host: a room that fails to start sends a sentence back, keeps the screen, and a retry closes the failed tab', async () => {
  const bootFails = { on: true };
  const { rec } = loadHost({ bootFails });
  await rec.cmd['wagonWheel.newRoom'](); const screen = rec.panels[0];
  await screen.recv({ type: 'ready' }); await settle();
  const form = { name: 'r', agents: [{ provider: 'claude', label: 'Claude', start: 'fresh' }] };
  await screen.recv({ type: 'start', form });
  assert.match(screen.sent.at(-2).text, /The room could not start/); assert.strictEqual(screen.disposed, false);
  const failedTab = rec.panels[1];
  bootFails.on = false;
  await screen.recv({ type: 'start', form });
  assert.strictEqual(failedTab.disposed, true, 'the failed attempt\'s tab is closed');
  assert.strictEqual(screen.disposed, true); assert.strictEqual(rec.panels.length, 3);
});

test('page: "couldn\'t check" is not called "not ready", and trusting the folder then Check again updates the card', () => {
  const pg = loadPage();
  pg.receive({ type: 'init', existing: false, defaults: { name: 'R', folder: '/w', folderLabel: '~/w' }, trusted: false });
  pg.click('Check again');
  assert.deepStrictEqual(pg.sent.at(-1), { type: 'recheck' });
  pg.receive({ type: 'setup', trusted: true, claude: { ready: false, unknown: true, text: 'Couldn\'t check Claude Code. It may still work.', fix: null }, codex: { ready: true, text: 'Ready: Codex 1.0.0, signed in.', fix: null } });
  const t = pg.text();
  assert.ok(t.includes('Couldn\'t check Claude Code. It may still work.') && !t.includes('Trust this folder'));
  assert.ok(!t.includes('won\'t be able to answer'), 'an unknown check does not claim the agent is broken');
});

test('Wagon Wheel\'s own room conversations are recognised; a person\'s original that a room kept going in is not', () => {
  const made = startRoom.roomMade([{ seats: [
    { provider: 'codex', sessionId: 'th-new', made: ['th-new'] },          // a thread the room started
    { provider: 'codex', sessionId: 'th-copy', made: ['th-copy'] },        // a copy the room is working on
    { provider: 'codex', sessionId: 'th-person', made: [] }] }]);          // the person's original, kept going in
  assert.ok(startRoom.isRoomConversation('codex', { id: 'th-new' }, made));
  assert.ok(startRoom.isRoomConversation('codex', { id: 'th-copy' }, made));
  assert.ok(!startRoom.isRoomConversation('codex', { id: 'th-person', name: 'Plan the trip' }, made));
  for (const name of ['Wagon Wheel: Review · Codex', 'Wagon Circle: Test Room', 'Campfire: old room']) assert.ok(startRoom.isRoomConversation('codex', { id: 'x', name }), name);
  assert.ok(!startRoom.isRoomConversation('codex', { id: 'x', name: 'Find Wagon Circle handoff' }), 'a person\'s thread that mentions the name is kept');
  assert.ok(!startRoom.isRoomConversation('codex', { id: 'x', name: null, preview: 'Wagon Wheel: in the preview only' }));
  assert.ok(startRoom.isRoomConversation('claude', { id: 'c', mode: 'dontAsk' }));
  for (const mode of ['auto', 'default', 'plan', 'bypassPermissions', null]) assert.ok(!startRoom.isRoomConversation('claude', { id: 'c', mode }), String(mode));
  assert.ok(!startRoom.isRoomConversation('claude', { id: 'c', mode: 'dontAsk', entrypoint: 'claude-desktop' }), 'a Claude Desktop session in dontAsk is the person\'s');
  assert.ok(startRoom.isRoomConversation('claude', { id: 'c-made', mode: 'auto' }, startRoom.roomMade([{ seats: [{ provider: 'claude', made: ['c-made'] }] }])), 'a room copy keeps the person\'s mode but is recorded as the room\'s');
});

const rollout = (d, originator) => { const f = path.join(d, `rollout-${originator.replace(/\W/g, '')}-${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(f, `${JSON.stringify({ type: 'session_meta', payload: { originator, cli_version: '0.153.1' } })}\n`); return f; };

test('codexOriginator reads the app that created a thread from its session file, and is null when it can\'t', () => {
  const d = dir();
  assert.strictEqual(startRoom.codexOriginator(rollout(d, 'wagon-wheel')), 'wagon-wheel');
  assert.strictEqual(startRoom.codexOriginator(rollout(d, 'Codex Desktop')), 'Codex Desktop');
  const bad = path.join(d, 'bad.jsonl'); fs.writeFileSync(bad, 'not json\n');
  assert.strictEqual(startRoom.codexOriginator(bad), null);
  assert.strictEqual(startRoom.codexOriginator(path.join(d, 'missing.jsonl')), null);
  assert.strictEqual(startRoom.codexOriginator(undefined), null);
  assert.ok(startRoom.isRoomConversation('codex', { id: 'x', originator: 'wagon-circle' }), 'earlier product names count');
  assert.ok(!startRoom.isRoomConversation('codex', { id: 'x', originator: 'codex_vscode' }));
});

test('host: the start screen lists leave out room conversations and keep the person\'s own', async () => {
  const id = '22222222-3333-4444-8555-666666666666';
  const { rec, convDir } = loadHost({
    lists: { claude: null },
    claudeSessions: (cwd) => [
      { id: 'cl-mine', path: '/x', cwd, mtime: 1, title: 'My chat', preview: 'hi', mode: 'auto' },
      { id: 'cl-room', path: '/y', cwd, mtime: 2, title: null, preview: '[Dean] @claude review', mode: 'dontAsk' }],
    codexThreads: (cwd) => [
      { id: 'th-unnamed-room', name: null, preview: 'Count from 1 to 300', cwd, updatedAt: 0, path: rollout(cwd, 'wagon-wheel') },
      { id: 'th-old-product', name: null, preview: 'old room', cwd, updatedAt: 0, path: rollout(cwd, 'wagon-circle') },
      { id: 'th-mine', name: 'Plan the trip', cwd, updatedAt: 1, path: rollout(cwd, 'Codex Desktop') },
      { id: 'th-named', name: 'Wagon Wheel: Review · Codex', cwd, updatedAt: 2 },
      { id: 'th-made', name: null, preview: 'room thread without a name', cwd, updatedAt: 3 },
      { id: 'th-kept', name: 'My original', cwd, updatedAt: 4 }],
    rooms: [{ meta: { id, name: 'Old room', seats: [
      { id: 'codex', label: 'Codex', provider: 'codex', cwd: os.tmpdir(), sessionId: 'th-made', typedThreads: ['th-made'] },
      { id: 'codex-2', label: 'Codex 2', provider: 'codex', cwd: os.tmpdir(), sessionId: 'th-kept' }] }, state: { transcript: [] } }],
  });
  void convDir;
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  const lists = p.sent.find((m) => m.type === 'lists');
  assert.deepStrictEqual(lists.conversations.claude.map((c) => c.title), ['My chat']);
  assert.deepStrictEqual(lists.conversations.codex.map((c) => c.title), ['Plan the trip', 'My original']);
});

test('Claude history records each session\'s first permission mode, which is how room sessions are recognised', () => {
  const home = dir(), oldHome = process.env.HOME;
  const proj = path.join(home, '.claude', 'projects', '-work'); fs.mkdirSync(proj, { recursive: true });
  const line = (mode, text) => JSON.stringify({ type: 'user', cwd: '/work', permissionMode: mode, message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(proj, 'mine.jsonl'), `${line('auto', 'Plan the trip')}\n${line('dontAsk', 'later a room kept going in it')}\n`);
  fs.writeFileSync(path.join(proj, 'room.jsonl'), `${line('dontAsk', '[Dean] @claude review this')}\n`);
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve('../src/claudeHistory')];
    const sessions = require('../src/claudeHistory').listSessions(10);
    const byId = Object.fromEntries(sessions.map((x) => [x.id, x.mode]));
    assert.deepStrictEqual(byId, { mine: 'auto', room: 'dontAsk' });
    assert.deepStrictEqual(sessions.filter((x) => !startRoom.isRoomConversation('claude', x)).map((x) => x.id), ['mine']);
  } finally { process.env.HOME = oldHome; delete require.cache[require.resolve('../src/claudeHistory')]; }
});

test('Claude\'s native model list: tier order with Default first, older models grouped, and validation uses it', () => {
  const claudeModels = require('../src/claudeModels');
  const native = [
    { value: 'default', resolvedModel: 'claude-fable-5-1', displayName: 'Default (recommended)', description: 'Fable 5.1', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
    { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable for your hardest and longest-running tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
    { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
    { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable…' },
  ];
  const list = claudeModels.fromCli(native);
  assert.deepStrictEqual(list.map((m) => [m.name, !!m.older]), [['Default (recommended)', false], ['Fable 5.1', false], ['Opus 5.5', false], ['Sonnet 5', false], ['Haiku 4.5', false], ['Fable 5', true], ['Opus 4.8', true]]);
  assert.strictEqual(list[2].fast, true); assert.deepStrictEqual(list[1].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(claudeModels.FALLBACK.map((m) => m.name), ['Default (recommended)', 'Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5']);
  assert.strictEqual(claudeModels.fromCli([]), null);
  const cwd = dir();
  const plan = startRoom.buildPlan({ name: 'r', agents: [A('claude', { model: 'claude-opus-4-8', effort: 'xhigh' })] }, { defaultCwd: cwd, claudeModels: list });
  assert.strictEqual(plan.seats[0].model, 'claude-opus-4-8'); assert.strictEqual(plan.seats[0].effort, 'xhigh');
  assert.throws(() => startRoom.buildPlan({ name: 'r', agents: [A('claude', { model: 'claude-haiku-4-5-20251001', effort: 'high' })] }, { defaultCwd: cwd, claudeModels: list }), /thinking effort isn't available/, 'Haiku has no effort levels');
});

test('the Claude CLI is asked for its model menu with an initialize request and no model call', async () => {
  const claudeModels = require('../src/claudeModels');
  const { EventEmitter } = require('events'), { PassThrough } = require('stream');
  let args = null, written = '';
  const spawnFn = (exe, a) => {
    args = a; const p = new EventEmitter(); p.stdout = new PassThrough(); p.kill = () => {};
    p.stdin = { write: (line) => { written += line; const req = JSON.parse(line);
      setImmediate(() => p.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: req.request_id, response: { models: [{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' }] } } }) + '\n')); } };
    return p;
  };
  const list = await claudeModels.query('/fake/claude', { spawnFn });
  assert.deepStrictEqual(list.map((m) => m.name), ['Haiku 4.5']);
  assert.match(written, /"subtype":"initialize"/); assert.doesNotMatch(written, /"type":"user"/, 'no message is sent, so no model runs');
  assert.ok(args.includes('--restricted') && args.includes('dontAsk'));
  assert.strictEqual(await claudeModels.query('/fake/claude', { spawnFn: () => { throw new Error('ENOENT'); } }), null);
});

test('"Default (recommended)" starts Claude without --model, so Claude Code picks its own default; xhigh is passed through', () => {
  const { ClaudeClient } = require('../src/claudeClient');
  const make = (model, effort) => new ClaudeClient({ exe: 'claude', cwd: os.tmpdir(), model, effort, systemPrompt: 'x', tools: [], addDirs: [] })._args();
  assert.ok(!make('default', null).includes('--model'));
  const a = make('claude-fable-5-1', 'xhigh');
  assert.deepStrictEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'claude-fable-5-1']);
  assert.deepStrictEqual(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2), ['--effort', 'xhigh']);
});

test('coding sessions only: the Codex app\'s plain chats (projectless, or in its dated chat workspace) are left out', async () => {
  const codexHome = dir(), oldHome = process.env.CODEX_HOME;
  fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({ 'projectless-thread-ids': ['th-chat'], 'thread-project-assignments': {} }));
  process.env.CODEX_HOME = codexHome;
  try {
    const ids = startRoom.codexChatIds();
    assert.deepStrictEqual([...ids], ['th-chat']);
    const home = '/Users/alex';
    assert.ok(startRoom.isChatConversation('codex', { id: 'th-chat', cwd: '/w' }, ids, home));
    assert.ok(startRoom.isChatConversation('codex', { id: 'x', cwd: '/Users/alex/Documents/Codex/2026-07-13/plan-a-trip' }, ids, home));
    assert.ok(!startRoom.isChatConversation('codex', { id: 'x', cwd: '/Users/alex/Documents/Codex/my-repo' }, ids, home), 'a real project folder that happens to live there stays');
    assert.ok(!startRoom.isChatConversation('codex', { id: 'x', cwd: '/Users/alex/code/app' }, ids, home));
    assert.ok(!startRoom.isChatConversation('claude', { id: 'th-chat' }, ids, home), 'Claude Code sessions are all coding sessions');
    assert.deepStrictEqual([...startRoom.codexChatIds({ codexHome: path.join(codexHome, 'missing') })], [], 'no state file: nothing is treated as a chat');
    const { rec } = loadHost({ codexThreads: (cwd) => [{ id: 'th-chat', name: 'Plan a trip', cwd, updatedAt: 2 }, { id: 'th-code', name: 'Fix the parser', cwd, updatedAt: 1 }] });
    await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
    await p.recv({ type: 'ready' }); await settle();
    assert.deepStrictEqual(p.sent.find((m) => m.type === 'lists').conversations.codex.map((c) => c.title), ['Fix the parser']);
  } finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; }
});

test('a room\'s Claude process does not inherit the launching app\'s entrypoint (so its sessions never look like Claude Desktop\'s)', () => {
  const cp = require('child_process'), real = cp.spawn;
  let env = null;
  cp.spawn = (exe, args, opts) => { env = opts.env; const { EventEmitter } = require('events'); const p = new EventEmitter(); p.stdout = new (require('stream').PassThrough)(); p.stderr = new (require('stream').PassThrough)(); p.stdin = { write() {}, end() {} }; p.kill = () => {}; return p; };
  const old = process.env.CLAUDE_CODE_ENTRYPOINT; process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  try {
    delete require.cache[require.resolve('../src/claudeClient')];
    const { ClaudeClient } = require('../src/claudeClient');
    new ClaudeClient({ exe: 'claude', cwd: os.tmpdir(), systemPrompt: 'x', tools: [], addDirs: [] })._spawn();
    assert.ok(env && !('CLAUDE_CODE_ENTRYPOINT' in env)); assert.strictEqual(env.PATH, process.env.PATH, 'everything else is inherited');
  } finally { cp.spawn = real; if (old === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = old; delete require.cache[require.resolve('../src/claudeClient')]; }
});

test('host: when Claude Code\'s own menu arrives late, the screen gets it on top of the latest lists, not an older snapshot', async () => {
  let release; const menu = { promise: new Promise((r) => { release = r; }) };
  let threads = [{ id: 'th-old', name: 'First list', cwd: os.tmpdir(), updatedAt: 1 }];
  const { rec } = loadHost({ menu, codexThreads: () => threads });
  await rec.cmd['wagonWheel.newRoom'](); const p = rec.panels[0];
  await p.recv({ type: 'ready' }); await settle();
  threads = [{ id: 'th-new', name: 'Newer list', cwd: os.tmpdir(), updatedAt: 2 }];
  await p.recv({ type: 'recheck' }); await settle(); // posts newer lists
  release([{ id: 'default', name: 'Default (recommended)', note: 'from the CLI', efforts: [], older: false }]); await settle();
  const last = p.sent.filter((m) => m.type === 'lists').at(-1);
  assert.deepStrictEqual(last.models.claude.map((m) => m.note), ['from the CLI']);
  assert.deepStrictEqual(last.conversations.codex.map((c) => c.title), ['Newer list']);
});

test('page: one agent can be allowed to edit; where its edits go is asked, and the form carries both', () => {
  const pg = loadPage();
  pg.receive({ type: 'init', existing: false, defaults: { name: 'R', folder: '/w', folderLabel: '~/w' }, trusted: true });
  pg.receive(pageLists);
  assert.ok(!pg.text().includes('Where edits go'));
  const selects = () => walk(pg.app).filter((e) => e.tagName === 'select' && e.attrs['aria-label'] === 'What it can do');
  const codex = selects()[1]; codex.value = 'edit'; codex.fire('change');
  const t = pg.text();
  assert.ok(t.includes('Where edits go') && t.includes('Your folder') && t.includes('A separate copy'));
  assert.ok(t.includes('Only one agent in a room can edit files, and Codex already can.'));
  assert.ok(selects()[0].children.filter((o) => o.value !== 'read').every((o) => o.disabled), 'the other agent can only read');
  pg.click('A separate copy');
  assert.ok(pg.text().includes('starts from your last commit'));
  assert.ok(pg.text().includes('Codex can edit files in a separate copy, asking you first each time.'));
  pg.click('Start room');
  const form = pg.sent.at(-1).form;
  assert.deepStrictEqual([form.agents.map((a) => a.access), form.editIn], [['read', 'edit'], 'copy']);
});

test('plan: levels are validated; one editor; Ultracode and originals are refused where they can\'t work', () => {
  const dir = fs.realpathSync(os.tmpdir());
  const base = { lists: { claude: [{ id: 'c1', cwd: dir }], codex: [] }, codexModels: [], defaultCwd: dir, claudeModels: [{ id: 'default', efforts: ['high', 'xhigh', 'ultracode'] }] };
  const ag = (x) => ({ provider: 'claude', label: 'C', start: 'fresh', ...x });
  const plan = startRoom.buildPlan({ name: 'r', agents: [ag({ access: 'edit' }), ag({ label: 'D' })], editIn: 'copy' }, base);
  assert.deepStrictEqual([plan.seats.map((x) => x.access), plan.editIn], [['edit', 'read'], 'copy']);
  assert.strictEqual(startRoom.buildPlan({ name: 'r', agents: [ag({})], editIn: 'copy' }, base).editIn, 'folder', 'no editor, no copy');
  assert.throws(() => startRoom.buildPlan({ name: 'r', agents: [ag({ access: 'edit' }), ag({ label: 'D', access: 'run' })] }, base), /Only one agent in a room can edit/);
  assert.throws(() => startRoom.buildPlan({ name: 'r', agents: [ag({ access: 'root' })] }, base), /choose what it can do/);
  assert.throws(() => startRoom.buildPlan({ name: 'r', agents: [ag({ access: 'edit', effort: 'ultracode' })] }, base), /Ultracode is for agents that can only read/);
  assert.throws(() => startRoom.buildPlan({ name: 'r', agents: [ag({ access: 'edit' }), ag({ label: 'D', start: 'original', conversation: 'c1' })], editIn: 'copy' }, base), /copies of your conversations/);
});
