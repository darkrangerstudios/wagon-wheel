// Start a Room: one screen instead of a chain of pop-up questions. Plain English, a short line under every choice.
// Security: everything shown comes from the extension host and is rendered with textContent only (no innerHTML).
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const NAME = { claude: 'Claude', codex: 'Codex' };
  const APP = { claude: 'Claude Code', codex: 'Codex' };
  const MAX = 6;
  // Each app's own words for its effort control (Claude Code 2.1.282; the Codex extension's English labels).
  const EFFORT = {
    claude: { title: 'Effort', hint: 'Set how hard the model tries. Higher takes longer and uses more of your plan.', levels: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultracode: 'Ultracode' } },
    codex: { title: 'Reasoning effort', hint: 'How much Codex reasons before answering. Higher takes longer and uses more of your plan; Ultra consumes usage limits faster.', levels: { none: 'None', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra', persistent: 'Persistent' } },
  };
  const S = { init: false, trusted: true, name: '', folder: '', folderLabel: '', agents: [], setup: null, lists: null, busy: false, error: '', existing: false };

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const help = (text) => el('div', 'help', text);
  const ago = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 172800) return 'yesterday'; if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const agent = (provider, n) => ({ provider, label: n > 1 ? `${NAME[provider]} ${n}` : NAME[provider], model: '', effort: '', start: S.existing ? 'copy' : 'fresh',
    conversation: null, share: false, search: '', folder: S.folder, folderLabel: S.folderLabel, access: 'read' });
  const editor = () => S.agents.find((a) => a.access !== 'read') || null;
  const ACCESS = [['read', 'Can read files only', 'It can read and search files. It can\'t change anything.'],
    ['edit', 'Can edit files (asks you first)', 'It can edit files in its folder. Every edit asks you first, as a card in the room.'],
    ['run', 'Can edit files and run commands (asks you first)', 'It can edit files and run commands in its folder. Every edit and every command asks you first.']];
  const countOf = (p) => S.agents.filter((a) => a.provider === p).length;
  const convs = (p) => (S.lists && S.lists.conversations[p]) || [];
  const models = (p) => (S.lists && S.lists.models[p]) || [];
  const picked = (a) => convs(a.provider).find((c) => c.id === a.conversation) || null;
  const bringsIn = (a) => a.start !== 'fresh';

  // Re-rendering replaces the page; keep the caret where the person was typing.
  function render() {
    const f = document.activeElement, key = f && f.dataset ? f.dataset.key : null, caret = f && typeof f.selectionStart === 'number' ? f.selectionStart : null;
    app.textContent = '';
    if (!S.init) { app.appendChild(el('p', 'muted', 'Loading…')); return; }
    const head = el('header');
    head.appendChild(el('h1', null, 'Start a room'));
    head.appendChild(el('p', 'lede', 'Pick the AI agents you want to talk to together. They can read files in their folder. One of them can also edit, if you choose, and every edit asks you first.'));
    app.appendChild(head);

    const who = el('section'); who.appendChild(el('h2', null, 'Who\'s in the room'));
    S.agents.forEach((a, i) => who.appendChild(card(a, i)));
    const adds = el('div', 'adds');
    for (const p of ['claude', 'codex']) {
      const b = el('button', 'ghost', `+ Add ${NAME[p]}`);
      b.title = `Add another ${NAME[p]}. Each agent has its own separate conversation.`;
      b.disabled = S.agents.length >= MAX;
      b.addEventListener('click', () => { S.agents.push(agent(p, countOf(p) + 1)); render(); });
      adds.appendChild(b);
    }
    if (S.agents.length >= MAX) adds.appendChild(help(`A room holds up to ${MAX} agents.`));
    who.appendChild(adds); app.appendChild(who);
    if (editor()) app.appendChild(whereEdits());

    const nm = el('section'); nm.appendChild(el('h2', null, 'Name the room'));
    const input = el('input', 'text'); input.value = S.name; input.dataset.key = 'room-name'; input.maxLength = 80; input.setAttribute('aria-label', 'Room name');
    input.addEventListener('input', () => { S.name = input.value; });
    nm.appendChild(input); nm.appendChild(help('Rooms are saved. You can reopen this one later from the Wagon Wheel panel on the left.'));
    app.appendChild(nm);

    const foot = el('footer');
    const summary = el('p', 'summary', summaryText()); foot.appendChild(summary);
    if (S.error) { const e = el('div', 'error', S.error); e.setAttribute('role', 'alert'); foot.appendChild(e); }
    const notReady = S.agents.filter((a) => S.setup && S.setup[a.provider] && !S.setup[a.provider].ready && !S.setup[a.provider].unknown).map((a) => a.label); // "couldn't check" is not "not ready"
    if (notReady.length) foot.appendChild(help(`${notReady.join(' and ')} ${notReady.length > 1 ? 'aren\'t' : 'isn\'t'} ready yet and won't be able to answer until ${notReady.length > 1 ? 'they are' : 'it is'}. You can still start the room.`));
    const go = el('button', 'primary', S.busy ? 'Starting…' : 'Start room'); go.disabled = S.busy;
    go.addEventListener('click', start);
    foot.appendChild(go); app.appendChild(foot);

    if (key) { const back = app.querySelector(`[data-key="${CSS.escape(key)}"]`); if (back) { back.focus(); if (caret != null && back.setSelectionRange) try { back.setSelectionRange(caret, caret); } catch { /* not a text field */ } } }
  }

  function statusLine(a) {
    const box = el('div', 'status');
    const st = S.setup && S.setup[a.provider];
    if (!S.trusted) {
      box.appendChild(el('span', 'dot wait')); box.appendChild(el('span', 'muted', `Trust this folder in VS Code to check ${APP[a.provider]}.`));
      const r = el('button', 'link', 'Check again'); r.title = 'Check again after you trust the folder.'; r.addEventListener('click', () => { S.setup = null; render(); vscode.postMessage({ type: 'recheck' }); }); box.appendChild(r);
      return box;
    }
    if (!S.setup) { box.appendChild(el('span', 'dot wait')); box.appendChild(el('span', 'muted', `Checking ${APP[a.provider]}…`)); return box; }
    if (!st) { box.appendChild(el('span', 'dot wait')); box.appendChild(el('span', 'muted', 'Couldn\'t check this app.')); return box; }
    box.appendChild(el('span', `dot ${st.ready ? 'ok' : 'bad'}`));
    box.appendChild(el('span', st.ready ? null : 'warn', st.text));
    if (st.fix) {
      const g = el('button', 'link', st.fix === 'signin' ? 'How to sign in' : 'How to install');
      g.title = `Opens the official ${APP[a.provider]} guide in your browser.`;
      g.addEventListener('click', () => vscode.postMessage({ type: 'guide', provider: a.provider }));
      box.appendChild(g);
      const r = el('button', 'link', 'Check again'); r.title = 'Run the check again after you install or sign in.';
      r.addEventListener('click', () => { S.setup = null; render(); vscode.postMessage({ type: 'recheck' }); });
      box.appendChild(r);
    }
    return box;
  }

  function card(a, i) {
    const c = el('div', `card ${a.provider}`);
    const top = el('div', 'row top');
    top.appendChild(el('span', `badge ${a.provider}`, NAME[a.provider]));
    const name = el('input', 'text name'); name.value = a.label; name.maxLength = 60; name.dataset.key = `label-${i}`; name.setAttribute('aria-label', `${NAME[a.provider]} agent name`);
    name.title = 'What you and the other agents call it. Type @ and this name in the room to talk to it directly.';
    name.addEventListener('input', () => { a.label = name.value; });
    top.appendChild(name);
    if (S.agents.length > 1) { const rm = el('button', 'link', 'Remove'); rm.title = 'Take this agent out of the room.'; rm.addEventListener('click', () => { S.agents.splice(i, 1); render(); }); top.appendChild(rm); }
    c.appendChild(top);
    c.appendChild(statusLine(a));

    // Model and thinking effort.
    const mrow = el('div', 'row');
    // Each app's own model menu and words: Claude Code lists Default (recommended) first; Codex calls its default "Default".
    const ms = el('select'); ms.setAttribute('aria-label', 'Model'); ms.title = `Which model this agent uses, as ${APP[a.provider]} lists them.`;
    const list = models(a.provider), hasDefault = list.some((m) => m.id === 'default');
    if (!hasDefault) ms.appendChild(new Option(a.provider === 'codex' ? 'Model: Default' : 'Model: Default (recommended)', ''));
    const label = (m) => (m.note ? `${m.name} · ${m.note}` : m.name);
    for (const m of list.filter((x) => !x.older)) ms.appendChild(new Option(label(m), m.id === 'default' ? '' : m.id));
    const olderModels = list.filter((x) => x.older);
    if (olderModels.length) { const g = el('optgroup'); g.label = 'Older models'; for (const m of olderModels) g.appendChild(new Option(label(m), m.id)); ms.appendChild(g); }
    ms.value = a.model;
    ms.addEventListener('change', () => { a.model = ms.value; const ok = efforts(a); if (a.effort && !ok.includes(a.effort)) a.effort = ''; render(); });
    const words = EFFORT[a.provider];
    const es = el('select'); es.setAttribute('aria-label', words.title); es.title = words.hint;
    es.appendChild(new Option(`${words.title}: Default`, ''));
    for (const e of efforts(a)) es.appendChild(new Option(`${words.title}: ${words.levels[e] || e}`, e));
    es.value = a.effort; es.addEventListener('change', () => { a.effort = es.value; });
    mrow.appendChild(ms); mrow.appendChild(es); c.appendChild(mrow);
    if (!S.lists) c.appendChild(help('Loading models…'));

    // Where it starts.
    c.appendChild(el('div', 'label', 'Starts with'));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup');
    for (const [v, text, tip] of [['fresh', 'A fresh conversation', 'A brand-new conversation that knows nothing yet.'],
      ['copy', `One of your ${NAME[a.provider]} conversations`, `Bring in a conversation you already had in ${APP[a.provider]}, so this agent picks up where you left off.`]]) {
      const on = v === 'fresh' ? a.start === 'fresh' : a.start !== 'fresh';
      const b = el('button', on ? 'on' : null, text); b.title = tip; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => { a.start = v === 'fresh' ? 'fresh' : (a.start === 'original' ? 'original' : 'copy'); render(); });
      seg.appendChild(b);
    }
    c.appendChild(seg);
    if (bringsIn(a)) c.appendChild(chooser(a, i));

    // Folder.
    const frow = el('div', 'row folder');
    const conv = bringsIn(a) ? picked(a) : null;
    const locked = conv && (a.provider === 'claude' || conv.exists); // Codex falls back to the chosen folder when its own is gone
    frow.appendChild(el('span', 'label inline', 'Works in'));
    frow.appendChild(el('code', null, locked ? conv.folder : a.folderLabel || a.folder));
    if (!locked) { const ch = el('button', 'link', 'Change…'); ch.title = 'Choose a different folder for this agent.'; ch.addEventListener('click', () => vscode.postMessage({ type: 'pickFolder', index: i })); frow.appendChild(ch); }
    c.appendChild(frow);
    c.appendChild(help(locked ? 'Uses the folder where this conversation started, so it can pick up where it left off.' : a.provider === 'codex' ? 'It starts in this folder. Codex can also read files elsewhere on this computer.' : 'It can read files in this folder and its subfolders.'));

    // What it may do. One agent per room above read only.
    const ac = el('select'); ac.setAttribute('aria-label', 'What it can do'); ac.dataset.key = `access-${i}`;
    const other = editor() && editor() !== a ? editor() : null;
    for (const [v, text, tip] of ACCESS) { const o = new Option(text, v); o.title = tip; o.disabled = v !== 'read' && !!other; ac.appendChild(o); }
    ac.value = a.access;
    ac.addEventListener('change', () => { a.access = ac.value; if (a.access !== 'read' && a.effort === 'ultracode') a.effort = ''; render(); });
    const arow = el('div', 'row'); arow.appendChild(el('span', 'label inline', 'It can')); arow.appendChild(ac); c.appendChild(arow);
    c.appendChild(help(other ? `Only one agent in a room can edit files, and ${other.label || NAME[other.provider]} already can.` : ACCESS.find((x) => x[0] === a.access)[2]));
    return c;
  }

  // Where the editing agent's changes land.
  function whereEdits() {
    const sec = el('section'); sec.appendChild(el('h2', null, 'Where edits go'));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup');
    for (const [v, text] of [['folder', 'Your folder'], ['copy', 'A separate copy']]) {
      const on = S.editIn === v, b = el('button', on ? 'on' : null, text); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => { S.editIn = v; render(); }); seg.appendChild(b);
    }
    sec.appendChild(seg);
    sec.appendChild(help(S.editIn === 'copy'
      ? 'The agents work on a new git branch in a folder of its own, so your folder stays exactly as it is until you bring the changes in. The copy starts from your last commit: changes you haven\'t committed aren\'t in it. In a copy, agents use copies of your conversations, never the originals. Needs a folder that is in a git repository.'
      : 'Edits land in your folder directly, like Claude Code or Codex on their own. Each one asks you first, and your usual undo and source control work as normal.'));
    if (S.editIn === 'copy' && S.agents.some((a) => a.start === 'original')) sec.appendChild(el('p', 'warn', 'An agent is set to keep going in your original conversation. In a separate copy, choose a copy for it instead.'));
    return sec;
  }

  function efforts(a) {
    const ms = models(a.provider);
    if (!a.model && a.provider === 'codex') return [...new Set(ms.flatMap((x) => x.efforts || []))]; // Codex's own default model isn't named
    const m = ms.find((x) => x.id === (a.model || 'default')) || ms[0];
    return ((m && m.efforts) || []).filter((e) => a.access === 'read' || e !== 'ultracode'); // Ultracode is for read-only agents
  }

  function chooser(a, i) {
    const box = el('div', 'chooser');
    if (!S.lists) { box.appendChild(help(`Loading your ${NAME[a.provider]} conversations…`)); return box; }
    const all = convs(a.provider);
    if (!all.length) { box.appendChild(help(`No ${NAME[a.provider]} conversations found on this computer. Start fresh instead.`)); return box; }
    const q = el('input', 'text search'); q.placeholder = `Search your ${NAME[a.provider]} conversations`; q.value = a.search; q.dataset.key = `search-${i}`;
    q.setAttribute('aria-label', `Search ${NAME[a.provider]} conversations`);
    q.addEventListener('input', () => { a.search = q.value; render(); });
    box.appendChild(q);
    const needle = a.search.trim().toLowerCase();
    const shown = all.filter((cv) => !needle || cv.title.toLowerCase().includes(needle) || cv.folder.toLowerCase().includes(needle)).slice(0, 40);
    const list = el('div', 'list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${NAME[a.provider]} conversations`);
    for (const cv of shown) {
      const on = a.conversation === cv.id;
      const item = el('button', `item${on ? ' on' : ''}`); item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(on));
      item.appendChild(el('span', 't', cv.title));
      item.appendChild(el('span', 'm', [cv.folder, ago(cv.when)].filter(Boolean).join(' · ')));
      item.addEventListener('click', () => { a.conversation = cv.id; render(); });
      list.appendChild(item);
    }
    if (!shown.length) list.appendChild(help('Nothing matches that search.'));
    box.appendChild(list);
    if (!picked(a)) { box.appendChild(help('Pick a conversation above.')); return box; }

    const how = el('div', 'how'); how.setAttribute('role', 'radiogroup');
    for (const [v, text, sub] of [['copy', 'Work on a copy (recommended)', 'Your original conversation stays exactly as it is. The agent continues from a copy.'],
      ['original', 'Keep going in the original', `Adds to your original conversation. Only choose this if it isn't open in ${APP[a.provider]} or another window right now.`]]) {
      const b = el('button', `opt${a.start === v ? ' on' : ''}`); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(a.start === v));
      b.appendChild(el('span', 'o', text)); b.appendChild(el('span', 's', sub));
      b.addEventListener('click', () => { a.start = v; render(); });
      how.appendChild(b);
    }
    box.appendChild(how);
    const share = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = a.share;
    cb.addEventListener('change', () => { a.share = cb.checked; });
    share.appendChild(cb); share.appendChild(el('span', null, 'Let the other agents read its last few messages'));
    share.title = 'Shares the last 8 exchanges of this conversation with the other agents in the room, so everyone starts on the same page.';
    box.appendChild(share);
    box.appendChild(help('Off by default. Nothing else from the conversation is shared.'));
    if (a.provider === 'codex') box.appendChild(help('A Codex conversation you bring in can\'t use the room\'s built-in hand-off tools, so the other agents reach it with @mentions instead.'));
    return box;
  }

  function summaryText() {
    if (!S.agents.length) return 'Add at least one agent.';
    const part = (a) => {
      if (!bringsIn(a)) return `${a.label || NAME[a.provider]} (fresh)`;
      const cv = picked(a);
      return `${a.label || NAME[a.provider]} (${a.start === 'original' ? 'your original' : 'a copy'} of "${cv ? cv.title.slice(0, 40) : '…'}")`;
    };
    const names = S.agents.map(part);
    const ed = editor();
    return `Starting ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}.${ed ? ` ${ed.label || NAME[ed.provider]} can ${ed.access === 'run' ? 'edit files and run commands' : 'edit files'} in ${S.editIn === 'copy' ? 'a separate copy' : 'your folder'}, asking you first each time.` : ''}`;
  }

  function start() {
    S.error = '';
    vscode.postMessage({ type: 'start', form: { name: S.name, agents: S.agents.map((a) => ({ provider: a.provider, label: a.label, model: a.model || null, effort: a.effort || null,
      start: a.start, conversation: bringsIn(a) ? a.conversation : null, folder: a.folder, share: bringsIn(a) && a.share, access: a.access })), editIn: S.editIn } });
  }

  window.addEventListener('message', ({ data: m }) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') {
      S.init = true; S.existing = !!m.existing; S.trusted = m.trusted !== false; S.name = m.defaults.name; S.folder = m.defaults.folder; S.folderLabel = m.defaults.folderLabel;
      S.agents = [agent('claude', 1), agent('codex', 1)]; S.editIn = 'folder';
    } else if (m.type === 'mode') { if (m.existing) for (const a of S.agents) if (a.start === 'fresh') a.start = 'copy'; }
    else if (m.type === 'setup') { S.setup = { claude: m.claude, codex: m.codex }; if (typeof m.trusted === 'boolean') S.trusted = m.trusted; }
    else if (m.type === 'lists') S.lists = { conversations: m.conversations || { claude: [], codex: [] }, models: m.models || { claude: [], codex: [] } };
    else if (m.type === 'folder' && S.agents[m.index]) { S.agents[m.index].folder = m.folder; S.agents[m.index].folderLabel = m.folderLabel; }
    else if (m.type === 'busy') S.busy = !!m.on;
    else if (m.type === 'error') S.error = String(m.text || 'Something went wrong.');
    else return;
    render();
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
