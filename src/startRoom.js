'use strict';
// Start a Room: the plain-English setup screen. This module is pure: it turns what the screen sends into a validated
// room plan, and turns setup checks into the sentences the screen shows. The screen is our own page, but everything
// it sends is still checked here: a conversation must be one the host listed, folders must exist, the roster must
// pass normalizeParticipants.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeParticipants } = require('./participants');
const { CLAUDE_MODELS, CLAUDE_EFFORTS } = require('./commands');

const PROVIDERS = ['claude', 'codex'];
const NAMES = { claude: 'Claude', codex: 'Codex' };
const APPS = { claude: 'Claude Code', codex: 'Codex' };
const MAX_AGENTS = 6;
const STARTS = ['fresh', 'copy', 'original'];
const RESERVED = new Set(['both', 'all', 'human', 'system', ...Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase())]);

// Setup check result -> { ready, text, fix } in plain English for one provider card.
function setupLine(p) {
  if (!p) return { ready: false, text: 'Not checked yet.', fix: null };
  if (p.installation === 'missing' || p.issue === 'missing') return { ready: false, text: `${APPS[p.provider]} isn't installed on this computer.`, fix: 'install' };
  if (p.issue === 'not-executable') return { ready: false, text: `${APPS[p.provider]} is installed but can't be started.`, fix: 'install' };
  if (p.installation !== 'available') return { ready: false, unknown: true, text: `Couldn't check ${APPS[p.provider]}. It may still work.`, fix: 'install' };
  if (p.authentication === 'signed-out') return { ready: false, text: `${APPS[p.provider]} ${p.version} is installed, but you're signed out.`, fix: 'signin' };
  if (p.authentication === 'present') return { ready: true, text: `Ready: ${APPS[p.provider]} ${p.version}, signed in.`, fix: null };
  return { ready: true, text: `${APPS[p.provider]} ${p.version} is installed. Sign-in couldn't be confirmed.`, fix: null };
}

// A conversation row for the screen: title, folder (home shortened to ~) and when it was last used.
function conversationRow(c, home = os.homedir()) {
  const clean = (v, max) => String(v || '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max);
  const folder = typeof c.cwd === 'string' ? (home && c.cwd.startsWith(home) ? `~${c.cwd.slice(home.length)}` : c.cwd) : '';
  return { id: c.id, title: clean(c.title, 120) || 'Untitled conversation', folder: clean(folder, 200), when: Number.isFinite(c.when) ? c.when : null, exists: typeof c.cwd === 'string' && isDir(c.cwd) };
}

function slug(label, provider, taken) {
  let s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  if (!/^[a-z]/.test(s) || RESERVED.has(s) || /^h[0-9]+$/.test(s)) s = provider;
  let id = s, n = 2;
  while (taken.has(id)) id = `${s}-${n++}`;
  taken.add(id);
  return id;
}

const isDir = (p) => { try { return path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

// form: { name, agents: [{ provider, label, model, effort, start, conversation, folder, share }] }
// lists: { claude: [{ id, cwd, when }], codex: [...] } exactly as the host sent them; codexModels: [{ id, efforts }].
// Returns { name, seats, shareSeed, originals } or throws an Error whose message the screen shows as is.
function buildPlan(form, { lists = {}, codexModels = [], claudeModels = null, defaultCwd, settings = {} } = {}) {
  const fail = (m) => { throw new Error(m); };
  if (!form || typeof form !== 'object' || !Array.isArray(form.agents)) fail('Something went wrong reading the form. Close this tab and try again.');
  const name = typeof form.name === 'string' && form.name.trim() ? form.name.trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80) : '';
  if (!name) fail('Give the room a name.');
  if (form.agents.length < 1) fail('Add at least one agent.');
  if (form.agents.length > MAX_AGENTS) fail(`A room can have up to ${MAX_AGENTS} agents.`);
  const taken = new Set(), originals = new Set(), seats = [], shareSeed = {}, picked = [], sources = {};
  form.agents.forEach((a, i) => {
    const n = i + 1;
    if (!a || !PROVIDERS.includes(a.provider)) fail(`Agent ${n}: choose Claude or Codex.`);
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    if (!label || label.length > 60 || /[\x00-\x1f\x7f-\x9f]/.test(label)) fail(`Agent ${n}: give it a name of 1 to 60 characters.`);
    const start = STARTS.includes(a.start) ? a.start : fail(`${label}: choose how it starts.`);
    let cwd = typeof a.folder === 'string' && a.folder ? a.folder : defaultCwd, conv = null;
    if (start !== 'fresh') {
      conv = (lists[a.provider] || []).find((c) => c.id === a.conversation);
      if (!conv) fail(`${label}: pick one of your ${NAMES[a.provider]} conversations, or start fresh.`);
      if (start === 'original') {
        const key = `${a.provider}:${conv.id}`;
        if (originals.has(key)) fail(`${label}: two agents can't both keep going in the same original conversation. Use a copy for one of them.`);
        originals.add(key);
      }
      // Claude reopens a conversation only from the folder it started in; Codex keeps its own folder when it has one.
      if (a.provider === 'claude') { if (!isDir(conv.cwd)) fail(`${label}: the folder that conversation started in no longer exists, so Claude can't reopen it. Pick another conversation or start fresh.`); cwd = conv.cwd; }
      else if (conv.cwd && isDir(conv.cwd)) cwd = conv.cwd;
    }
    if (!isDir(cwd)) fail(`${label}: its folder no longer exists. Choose another folder.`);
    const claudeList = Array.isArray(claudeModels) && claudeModels.length ? claudeModels : null;
    const models = a.provider === 'claude' ? (claudeList ? claudeList.map((m) => m.id) : CLAUDE_MODELS) : codexModels.map((m) => m.id);
    const model = a.model == null || a.model === '' ? null : models.includes(a.model) ? a.model : fail(`${label}: that model isn't available.`);
    // No model chosen means Codex's own default, which the host can't name: accept any effort a listed model offers.
    const efforts = a.provider === 'claude' ? ((claudeList && (claudeList.find((m) => m.id === (model || 'default')) || {}).efforts) || CLAUDE_EFFORTS) : model ? (codexModels.find((m) => m.id === model).efforts || []) : [...new Set(codexModels.flatMap((m) => m.efforts || []))];
    const effort = a.effort == null || a.effort === '' ? null : efforts.includes(a.effort) ? a.effort : fail(`${label}: that thinking effort isn't available for this model.`);
    const access = a.access === undefined || a.access === null ? 'read' : ['read', 'edit', 'run'].includes(a.access) ? a.access : fail(`${label}: choose what it can do.`);
    if (access !== 'read' && effort === 'ultracode') fail(`${label}: Ultracode is for agents that can only read. Choose another effort, or set it to read only.`);
    if (access !== 'read' && seats.some((x) => x.access !== 'read')) fail(`Only one agent in a room can edit files. Set ${label} or ${seats.find((x) => x.access !== 'read').label} to read only.`);
    if (form.editIn === 'copy' && start === 'original' && form.agents.some((x) => x && x.access && x.access !== 'read')) fail(`${label}: in a separate copy, agents work on copies of your conversations. Choose a copy for it.`);
    const id = slug(label, a.provider, taken);
    const seat = { id, label, provider: a.provider, cwd, model, effort, access };
    if (start === 'original') seat.sessionId = conv.id;
    if (start === 'copy') seat.forkFrom = conv.id;
    if (a.provider === 'codex' && start !== 'fresh') seat.typed = false; // a Codex thread's request tools are fixed when it is created
    seats.push(seat);
    if (start !== 'fresh' && a.share === true) shareSeed[id] = true;
    if (start === 'original') picked.push({ label, provider: a.provider, id: conv.id, when: conv.when });
    // Which of the person's conversations this agent started from, so the room can say so later.
    if (start !== 'fresh') sources[id] = { kind: start, id: conv.id, title: typeof conv.title === 'string' ? conv.title.slice(0, 120) : null };
  });
  const editIn = form.editIn === 'copy' && seats.some((x) => x.access !== 'read') ? 'copy' : 'folder';
  return { name, seats: normalizeParticipants({ seats }, settings), shareSeed, originals: picked, sources, editIn };
}

// Wagon Wheel's own room conversations don't belong in "your conversations". Claude: sessions Wagon Wheel ran (the
// dontAsk mode it always uses). Codex: threads whose session file says Wagon Wheel created them (originator, from the
// name it gives Codex on connect, including the product's earlier names), threads it named, and any thread a saved
// room records as its own. A person's original that a room kept going in stays listed: its file names their app.
const ROOM_NAME = /^(Wagon Wheel|Wagon Circle|Campfire): /;
const ROOM_ORIGINATORS = new Set(['wagon-wheel', 'wagon-circle', 'campfire']);

// The app that created a Codex thread, from the first line (session_meta) of its session file. null when unreadable.
function codexOriginator(file, fsx = fs) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    fd = fsx.openSync(file, 'r');
    const buf = Buffer.alloc(262144), n = fsx.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const r = JSON.parse(first);
    const o = r && r.payload && r.payload.originator;
    return typeof o === 'string' ? o : null;
  } catch { return null; } finally { if (fd !== undefined) try { fsx.closeSync(fd); } catch { /* closed */ } }
}
function roomMade(rooms) {
  const out = new Set();
  for (const r of rooms || []) for (const s of r.seats || []) for (const id of s.made || []) out.add(`${s.provider}:${id}`);
  return out;
}
function isRoomConversation(provider, c, made = new Set()) {
  if (made.has(`${provider}:${c.id}`)) return true;
  // dontAsk is only a hint: Claude Desktop sessions can run in it too. Rooms' own ids (recorded since 0.6.1) are the proof.
  if (provider === 'claude') return c.mode === 'dontAsk' && c.entrypoint !== 'claude-desktop';
  return ROOM_ORIGINATORS.has(c.originator) || (typeof c.name === 'string' && ROOM_NAME.test(c.name));
}

// Coding sessions only: the Codex app also keeps plain chats. It records them as "projectless" in its own state file
// and gives each a dated workspace under ~/Documents/Codex. Read-only; an unreadable file just means no ids.
function codexChatIds({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), fsx = fs } = {}) {
  try {
    const st = JSON.parse(fsx.readFileSync(path.join(codexHome, '.codex-global-state.json'), 'utf8'));
    return new Set(Array.isArray(st['projectless-thread-ids']) ? st['projectless-thread-ids'].filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function isChatConversation(provider, c, chatIds = new Set(), home = os.homedir()) {
  if (provider !== 'codex') return false; // every Claude Code session is a coding session; claude.ai chats are not on disk
  if (chatIds.has(c.id)) return true;
  const chatRoot = path.join(home, 'Documents', 'Codex') + path.sep;
  return typeof c.cwd === 'string' && c.cwd.startsWith(chatRoot) && /^\d{4}-\d{2}-\d{2}(\/|$)/.test(c.cwd.slice(chatRoot.length));
}

module.exports = { buildPlan, setupLine, conversationRow, slug, isDir, roomMade, isRoomConversation, codexOriginator, codexChatIds, isChatConversation, MAX_AGENTS, NAMES };
