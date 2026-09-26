'use strict';
// Room router: who hears what, when. Pure logic over agents that expose send(text, onDelta) -> Promise<string>.
const { EventEmitter } = require('events');
const { TaskLedger } = require('./tasks');

// The original two participants. A room's actual participants come from its agents map (a registry keyed by
// stable participant id, e.g. 'gemini' or 'claude-2'); these defaults keep pre-registry rooms unchanged.
const AGENTS = ['claude', 'codex'];
const LABEL = { claude: 'Claude', codex: 'Codex', system: 'Wagon Wheel' };
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const esc = (n) => n.replace(/[-]/g, '\\-');
const DETAIL_MAX = 4000; // characters of a change kept on its approval card
const nameRe = (names) => names.slice().sort((a, b) => b.length - a.length).map(esc).join('|');

// @name for each participant, plus @both / @all. Ignores e-mail-like text (x@codex.com) by requiring a
// non-word char before '@'.
function mentions(text, names = AGENTS) {
  const found = new Set();
  for (const m of String(text).matchAll(new RegExp(`(^|[^\\w@.])@(${nameRe(names)}|both|all)(?![\\w-])`, 'gi'))) {
    const n = m[2].toLowerCase();
    if (n === 'both' || n === 'all') names.forEach((a) => found.add(a)); else found.add(n);
  }
  return [...found];
}

// An agent's explicit hand-off: a line that STARTS with @claude or @codex, naming the OTHER agent.
// A mention anywhere else is conversation ("I agree with @codex"), not a request; so are mentions inside
// code fences, blockquotes or quotes (talking ABOUT a mention caused the 2026-09-23 runaway).
// Agents cannot use @both / @all. Interim protocol until typed assistance requests replace text routing.
function handoffs(text, from, names = AGENTS) {
  const found = new Set();
  const prose = String(text).replace(/^[ \t]*(```|~~~)[\s\S]*?(^[ \t]*\1|(?![\s\S]))/gm, ' ');
  for (const m of prose.matchAll(new RegExp(`^[ \\t]*@(${nameRe(names)})(?![\\w-])`, 'gim'))) found.add(m[1].toLowerCase());
  return [...found].filter((n) => n !== from);
}

const knows = (e, name) => (Array.isArray(e.knownBy) ? e.knownBy.includes(name) : e.knownBy === name);
const markKnown = (e, name) => { if (!knows(e, name)) e.knownBy = [].concat(e.knownBy || [], name); };
const unmarkKnown = (e, name) => { e.knownBy = [].concat(e.knownBy || []).filter((n) => n !== name); };
// Legacy seeds were consented only to the original two agents. Adding a participant must not broaden that.
const mayRead = (e, name) => e.kind !== 'history' || (Array.isArray(e.recipients) ? e.recipients : AGENTS).includes(name);

// Agent-facing label. `to` is the agent receiving the payload (requests and answers read differently to their parties).
function label(entry, human, to, LABEL = module.exports.LABEL) {
  if (entry.kind === 'request') {
    const who = entry.to === to ? 'you' : LABEL[entry.to];
    return `[Request ${entry.request} from ${LABEL[entry.from]} to ${who} (${entry.purpose})${entry.task ? `, task ${entry.task}` : ''}: relayed by Wagon Wheel, not ${human}.${entry.to === to ? ` Your reply goes back to ${LABEL[entry.from]} automatically.` : ''}]`;
  }
  const mine = (entry.answers || []).filter((a) => a.to === to).map((a) => a.request);
  if (mine.length) return `[${LABEL[entry.from]} — answer to your request ${mine.join(', ')}, relayed by Wagon Wheel, not ${human}]`;
  if (entry.kind === 'history') return `[${entry.from === 'human' ? 'User' : LABEL[entry.from]} — earlier in the forked ${entry.source || 'Codex'} conversation]`;
  if (entry.from === 'human' && entry.kind === 'steer') return `[${human}, to ${entry.steer.map((n) => LABEL[n]).join(' and ')} mid-turn]`;
  if (entry.from === 'human') return `[${human}]`;
  if (entry.from === 'system') return '[Wagon Wheel notice]';
  if (entry.kind === 'post') return `[${LABEL[entry.from]} — posted on its own to ${human}${(entry.jobs || []).length ? ' after a background job finished' : ''}; relayed by Wagon Wheel, not ${human}. Nobody asked you to act on it]`;
  return `[${LABEL[entry.from]} — relayed by Wagon Wheel, not ${human}]`;
}

class Room extends EventEmitter {
  // defaultTarget: who hears a message with no @mention ('claude' | 'codex' | 'both').
  // bothMode: 'sequential' = addressed agents answer one after another, each seeing the previous answer;
  //           'parallel' = all at once, independently.
  // labelFor(name): optional, the model an agent is running (shown on its replies).
  // maxTurns: most replies one agent may give per human message (its answer plus replies to hand-offs).
  // Delivery: an entry counts as seen by an agent only once it was actually handed to that agent
  // (knownBy). The cursor is just the point before which everything is seen, so nothing is skipped when a
  // delivery is capped, rejected or a steer isn't accepted.
  // Runs: each human message starts a run (a number). Stop cancels every run so far; work belonging to a
  // cancelled run (a queued delivery, the rest of an @both sequence, a hand-off) never starts again.
  // Typed agents (agent.typed) ask each other through the request_assistance tool, under a host-owned task
  // (tasks.js). Prose is never a control channel: an untyped agent's line-start @name becomes a displayed
  // suggestion the human can send (DESIGN.md "Structured assistance"). proseHandoffs: true restores the
  // pre-v0.5 automatic routing; the extension never sets it (kept for the legacy router tests).
  // readHistory(requester, args): shared session history (extension glue over sessionHistory.js); optional.
  // postCap: most posts one agent may make on its own (see unprompted) per task, or per human message outside a task.
  // labels: display names by participant id (defaults: Claude, Codex, else the id capitalised).
  constructor({ agents, hopCap = 2, state = null, humanName = 'You', defaultTarget = 'claude', bothMode = 'sequential', labelFor = null, maxTurns = 2, now = Date.now, proseHandoffs = false, readHistory = null, labels = {}, postCap = 3, approvalTimeoutMs = 15 * 60e3, modeFor = null }) {
    super();
    this.agents = agents; this.hopCap = hopCap; this.human = humanName;
    this.names = Object.keys(agents);
    for (const n of this.names) if (!ID.test(n) || n === 'both' || n === 'all' || n === 'human' || n === 'system') throw new Error(`Invalid participant id "${n}"`);
    this.labels = { ...LABEL, ...Object.fromEntries(this.names.map((n) => [n, labels[n] || LABEL[n] || n[0].toUpperCase() + n.slice(1)])) };
    this.defaultTarget = defaultTarget; this.bothMode = bothMode; this.labelFor = labelFor;
    this.maxTurns = maxTurns; this.turns = this._each(0); this.turnNoted = {};
    this.postCap = postCap; this.lastRun = this._each(0); this.posting = new Set(); // agents in a turn they started on their own
    this.approvalTimeoutMs = approvalTimeoutMs; this.pendingApprovals = new Map(); this.now = now;
    this.modeFor = modeFor; // (name) => 'ask' | 'auto' | 'bypass': how an editing agent's requests are answered
    this.state = state || { transcript: [], cursors: this._each(0), lastTargets: [...this.names], seq: 0 };
    // A participant added to an existing room starts at the present: the room's past is not replayed into it.
    for (const n of this.names) if (!Number.isInteger(this.state.cursors[n])) this.state.cursors[n] = this.state.transcript.length;
    this.busy = this._each(false); this.pending = this._each(0);
    this.hopsLeft = hopCap; this.capNoted = false; this.proseHandoffs = proseHandoffs; this.readHistory = readHistory;
    // Saved with the room so a reload can tell cut-off work from work the human stopped.
    this.run = this.state.run || 0; this.cancelledThrough = this.state.cancelledThrough || 0;
    this.tasks = new TaskLedger({ now, agents: this.names, state: this.state.tasks });
    this.state.tasks = this.tasks.state; // saved with the room; rooms from before tasks start empty
    this.held = new Set(); this.heldNoted = null; this.lastHuman = null;
    this._reconcile();
  }

  // After a reload no turn is running. Every delivery that was in flight (a request to answer, an answer to take
  // back, the human's own message) was cut off with its turn: make its input deliverable again and hold the agent.
  // Work the human had stopped stays stopped. The task shows as paused, so Resume is the visible way on; nothing
  // starts on its own and consumed allowances stay consumed.
  _reconcile() {
    // A card still waiting when the room closed belongs to a process that is gone: it can never be answered.
    for (const e of this.state.transcript) if (e.kind === 'approval' && e.approval && e.approval.status === 'pending') e.approval.status = 'expired';
    const inflight = this.state.inflight || {}; this.state.inflight = {};
    for (const [name, f] of Object.entries(inflight)) {
      if (!this.agents[name] || !f || !(f.run > this.cancelledThrough)) continue;
      const entries = this.state.transcript.filter((e) => f.ids.includes(e.id));
      if (entries.length) this._undeliver(name, entries, f.turnStart); else this.tasks.reopen(name);
      this.held.add(name);
    }
    // Rooms saved before in-flight records: a request still marked delivered was cut off the same way.
    for (const r of this.tasks._requests().filter((x) => x.status === 'delivered')) {
      const e = this.state.transcript.find((x) => x.kind === 'request' && x.request === r.id);
      if (e) this._undeliver(r.to, [e], this.state.transcript.length); else r.status = 'open';
      this.held.add(r.to);
    }
    if (!this.held.size) return;
    this.run = this.state.run = Math.max(this.run, this.cancelledThrough + 1); // recovered work gets a live run of its own
    const t = this.tasks.active(); if (t && t.status === 'active') this.tasks.pause('reload');
    const who = [...this.held].map((n) => this.labels[n]).join(' and ');
    this.note(`Reopened: ${who}'s last turn was cut off before it finished. ${t ? 'The task is paused; Resume to continue' : 'Message the agent to continue'}. Nothing restarts on its own.`);
  }

  _each(v) { return Object.fromEntries(this.names.map((n) => [n, v])); }

  _taskChanged() { this.emit('task', this.tasks.summary()); this.emit('changed', this.state); }

  _live(run) { return run > this.cancelledThrough; }

  // quiet: saved soon rather than at once (the host debounces 'dirty'); for records like approval cards, which can
  // come many per turn and never change what a reload must recover.
  _append(from, text, extra = {}, quiet = false) {
    const entry = { id: ++this.state.seq, from, text, ts: Date.now(), ...extra };
    this.state.transcript.push(entry);
    this.emit('message', entry); this.emit(quiet ? 'dirty' : 'changed', this.state);
    return entry;
  }

  // Seed history one agent already has (its forked thread or session) so only the other agent receives it.
  // items: [{role: 'user'|'codex'|'claude', text}]; alreadyKnownBy: 'codex' | 'claude'.
  seedHistory(items, alreadyKnownBy, recipients = AGENTS.filter((n) => n !== alreadyKnownBy)) {
    for (const it of items) this._append(this.names.includes(it.role) ? it.role : 'human', it.text, { kind: 'history', source: this.labels[alreadyKnownBy], knownBy: alreadyKnownBy, recipients: [...recipients] });
  }

  note(text) { return this._append('system', text); }

  postFromHuman(text, attachments = [], ide = null) {
    const addressed = mentions(text, this.names);
    const targets = addressed.length ? addressed : this.defaultTarget === 'both' ? [...this.names] : [this.defaultTarget];
    const run = this.state.run = ++this.run;
    this.hopsLeft = this.hopCap; this.capNoted = false;
    this.turns = this._each(0); this.turnNoted = {};
    const entry = this._append('human', text, { to: targets, ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    this.lastHuman = { id: entry.id, text };
    if (this.tasks.noteHuman(text)) this._taskChanged();
    if (this.tasks.mode === 'work' && !this.tasks.active()) { this.tasks.start({ objective: text, originId: entry.id, lead: targets[0], run }); this._taskChanged(); }
    if (targets.length > 1 && this.bothMode === 'sequential') this._inTurn(targets, run);
    else for (const t of targets) this.deliver(t, run);
    return targets;
  }

  // Steer: send a message INTO a running turn. Goes to the busy agents it @mentions, or to every busy agent
  // if it mentions none. If it only mentions idle agents (or nobody is busy), it is an ordinary message.
  steerFromHuman(text, attachments = [], ide = null) {
    // A post an agent is making on its own isn't steered: the human's message would become part of the post. It waits
    // and is delivered as an ordinary message when the post ends.
    const busyNow = this.names.filter((a) => this.busy[a] && !this.posting.has(a) && this.agents[a] && this.agents[a].steer);
    const named = mentions(text, this.names);
    const targets = named.length ? named.filter((a) => busyNow.includes(a)) : busyNow;
    if (!targets.length) return { steered: [], targets: this.postFromHuman(text, attachments, ide) };
    // Marked seen by a target up front so its current turn's catch-up doesn't repeat it; unmarked if the
    // agent doesn't accept the steer, and then it reaches that agent as a normal message after the turn.
    const entry = this._append('human', text, { kind: 'steer', steer: targets, knownBy: [...targets], ...(attachments.length ? { attachments } : {}), ...(ide ? { ide } : {}) });
    const files = attachments.map((a) => a.name);
    const body = `[${this.human}, steering you mid-turn: follow this now]\n${text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${ide ? `\n(IDE context from ${this.human}'s editor)\n${ide.text}` : ''}`;
    const run = this.run;
    for (const t of targets) {
      let sent; try { sent = Promise.resolve(this.agents[t].steer(body, attachments)); } catch (e) { sent = Promise.reject(e); }
      sent.then((ok) => (ok === false ? 'not accepted' : null), (e) => e.message)
        .then((failed) => {
          if (!failed) return;
          unmarkKnown(entry, t);
          const at = this.state.transcript.indexOf(entry);
          if (at >= 0) this.state.cursors[t] = Math.min(this.state.cursors[t], at);
          this.note(`Couldn't steer ${this.labels[t]} mid-turn (${failed}); it gets your message when its turn ends.`);
          if (this._live(run)) this.deliver(t, run);
        });
    }
    return { steered: targets };
  }

  // One after another: each agent's delivery includes the previous agent's answer.
  async _inTurn(targets, run) {
    for (const t of targets) { if (!this._live(run)) return; await this.deliver(t, run); }
  }

  _fresh(name) {
    return this.state.transcript.slice(this.state.cursors[name]).filter((e) => mayRead(e, name) && e.from !== name && !knows(e, name) && e.kind !== 'error' && e.kind !== 'approval');
  }

  // Move the cursor past everything this agent has seen, its own words and errors.
  _advance(name) {
    const tr = this.state.transcript; let c = this.state.cursors[name];
    // Approval cards are the human's record, never delivered: their titles carry agent-written text (a command line).
    while (c < tr.length && (!mayRead(tr[c], name) || tr[c].from === name || knows(tr[c], name) || tr[c].kind === 'error' || tr[c].kind === 'approval')) c++;
    this.state.cursors[name] = c;
  }

  // Everything this agent missed: labelled text plus the files attached to those messages.
  payloadFor(name, fresh = this._fresh(name)) {
    const text = fresh.map((e) => {
      const files = (e.attachments || []).map((a) => a.name);
      return `${label(e, this.human, name, this.labels)}\n${e.text}${files.length ? `\n(attached: ${files.join(', ')})` : ''}${e.ide ? `\n(IDE context from ${this.human}'s editor)\n${e.ide.text}` : ''}`;
    }).join('\n\n');
    return { text, attachments: fresh.flatMap((e) => e.attachments || []) };
  }

  async deliver(name, run = this.run) {
    if (!this._live(run) || !this.agents[name]) return;
    if (this.busy[name]) { this.pending[name] = Math.max(this.pending[name], run); return; }
    const fresh = this._fresh(name);
    if (!fresh.length) { this._advance(name); return; }
    // Task work (a request to answer, or an answer to take back) is bounded by the task's allowance, not the
    // per-message reply cap. The human's own messages always get through and never spend task turns.
    const requests = fresh.filter((e) => e.kind === 'request' && e.to === name && this.tasks.openFor(name).some((r) => r.id === e.request));
    const answers = fresh.filter((e) => (e.answers || []).some((a) => a.to === name));
    const taskTurn = requests.length > 0 || answers.length > 0;
    // Addressed by the human (entries from before v0.5 carry no recipients: treat them as addressed).
    const humanTurn = fresh.some((e) => e.from === 'human' && e.kind !== 'history' && (e.kind === 'steer' ? e.steer : e.to || [name]).includes(name));
    if (taskTurn && !humanTurn) {
      const adm = this.tasks.admitTurn(name);
      if (!adm.ok) { this._hold(name, adm.reason); return; }
    } else if (!taskTurn && this.turns[name] >= this.maxTurns) {
      // Not delivered, so not marked seen: the next delivery to this agent still carries it.
      if (!this.turnNoted[name]) { this.turnNoted[name] = true; this.note(`${this.labels[name]} has had its ${this.maxTurns} turns for this message; waiting on ${this.human}.`); }
      return;
    }
    this.held.delete(name); this.lastRun[name] = run; // background jobs started in this turn belong to this run
    const payload = this.payloadFor(name, fresh);
    for (const e of fresh) markKnown(e, name);
    this._advance(name);
    if (taskTurn && !humanTurn) this.tasks.recordTurn(name); else this.turns[name] += 1;
    if (requests.length) this.tasks.markDelivered(requests.map((e) => e.request), name);
    // Saved with the room until the turn ends, so a reload mid-turn can recover exactly this delivery.
    (this.state.inflight || (this.state.inflight = {}))[name] = { ids: fresh.map((e) => e.id), run, turnStart: this.state.transcript.length };
    // The room is saved on 'changed': emit it now, for every turn, so the in-flight record is on disk before the
    // provider call starts (a crash mid-turn must find it).
    if (taskTurn) this._taskChanged(); else this.emit('changed', this.state);
    const t = this.tasks.active(); const ctx = { run, taskId: t ? t.id : null, generation: t ? t.generation : 0 };
    this.busy[name] = true; this.emit('status', { name, busy: true, since: Date.now() });
    const steps = []; let diff = null; const started = Date.now(); const turnStart = this.state.transcript.length;
    const onActivity = (a) => { if (a.phase === 'diff') { diff = a.diff; return; } if (a.step) steps.push(a.label); this.emit('activity', { name, ...a }); };
    const onTool = (tool, args) => this._onTool(name, tool, args, ctx);
    try {
      const reply = await this.agents[name].send(payload.text, (partial) => this.emit('draft', { name, text: partial }), onActivity, payload.attachments, onTool);
      const model = this.labelFor ? this.labelFor(name) : null;
      // This reply answers the requests it was handed; the entry id is the next seq.
      const back = this._live(run) ? this.tasks.resolveDelivered(name, this.state.seq + 1) : [];
      const entry = this._append(name, reply || '(no reply)', { took: Date.now() - started, ...(model ? { model } : {}), ...(steps.length ? { steps } : {}), ...(diff ? { diff } : {}), ...(back.length ? { answers: back } : {}) });
      if (back.length) this._taskChanged();
      if (this._live(run)) { // a reply that lands after Stop is shown, never acted on
        if (!this.agents[name].typed) this._relay(name, entry.text, run);
        for (const to of new Set(back.map((b) => b.to))) this.deliver(to, run);
      }
    } catch (e) {
      if (e.stopped) {
        this.note(`${this.labels[name]} stopped.`);
        // Interrupted by a task limit, not by the human's Stop: the turn's input is undelivered again and waits
        // (held) until the human adds allowance and resumes. A human Stop cancels it for good.
        if (this._live(run)) { this._undeliver(name, fresh, turnStart); this.held.add(name); this._taskChanged(); }
      } else {
        // The agent may never have received it: make it deliverable again (a repeat beats a silent loss).
        this._undeliver(name, fresh, turnStart);
        this._append('system', `${this.labels[name]} failed: ${e.message}`, { kind: 'error' });
      }
    } finally {
      // Tokens this turn spent go to the task it belonged to (or the task it started), whatever its outcome.
      const tt = ctx.taskId ? this.tasks.get(ctx.taskId) : (() => { const a = this.tasks.active(); return a && a.run === run ? a : null; })();
      if (tt) this.tasks.addUsage(tt.id, name, this.agents[name].lastTurnUsage || null);
      // Clear the in-flight record BEFORE the save that ends the turn, so a finished turn is never saved as cut off.
      if (this.state.inflight) delete this.state.inflight[name];
      this.denyApprovals('its turn ended', name);
      if (tt) this._taskChanged(); else this.emit('changed', this.state);
      this.busy[name] = false; this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      const next = this.pending[name]; this.pending[name] = 0;
      if (next && this._live(next)) this.deliver(name, next);
    }
  }

  // A turn an agent started on its own: Claude reporting on a background job (Ultracode workflow) that finished after
  // its reply ended. The post is visible to everyone and addressed to the human; it wakes nobody (other agents read
  // it with their next delivery, and only request_assistance asks one to act). Each post is a task turn, at most
  // postCap per agent per task (or per human message outside a task). A paused task holds the post until Resume;
  // Stop discards it. Returns reply handlers for the client, or null to have the turn stopped.
  unprompted(name, { jobs = [] } = {}) {
    if (!this.agents[name] || this.busy[name]) return null;
    const run = this.lastRun[name] || this.run;
    if (!this._live(run)) return null; // the job belonged to work the human stopped
    const L = this.labels[name], t = this.tasks.active(), what = jobs.length ? 'finished a background job' : 'started a reply on its own';
    const key = t ? t.id : `run${this.run}`;
    if (!this.state.posts || this.state.posts.key !== key) this.state.posts = { key, counts: {}, noted: {} };
    const posts = this.state.posts, used = posts.counts[name] || 0;
    const refuse = (why) => { if (!posts.noted[name]) { posts.noted[name] = true; this.note(`${L} ${what}, but ${why}, so its report wasn't posted. Ask ${L} for the result.`); } this.emit('changed', this.state); return null; };
    if (used >= this.postCap) return refuse(this.postCap ? `it has already posted ${this.postCap} update${this.postCap === 1 ? '' : 's'} on its own ${t ? `for task ${t.id}` : 'since your last message'}` : 'agents are set not to post on their own');
    if (t) { this.tasks.checkTime(); if (t.status === 'exhausted' || t.limits.turns - t.used.turns <= 0) return refuse(`task ${t.id} has used its allowance`); }
    posts.counts[name] = used + 1;
    if (t) { this.tasks.recordTurn(name); this._taskChanged(); }
    const ctx = { run, taskId: t ? t.id : null, generation: t ? t.generation : 0 };
    this.busy[name] = true; this.posting.add(name); this.emit('status', { name, busy: true, since: Date.now() });
    const steps = [], started = Date.now();
    const end = () => {
      this.denyApprovals('its turn ended', name);
      const tt = ctx.taskId && this.tasks.get(ctx.taskId);
      if (tt) this.tasks.addUsage(tt.id, name, this.agents[name].lastTurnUsage || null);
      if (tt) this._taskChanged(); else this.emit('changed', this.state);
      this.busy[name] = false; this.posting.delete(name); this.emit('status', { name, busy: false }); this.emit('draft', { name, text: null });
      const next = this.pending[name]; this.pending[name] = 0;
      if (next && this._live(next)) this.deliver(name, next);
    };
    return {
      onDelta: (partial) => this.emit('draft', { name, text: partial }),
      onActivity: (a) => { if (a.phase === 'diff') return; if (a.step) steps.push(a.label); this.emit('activity', { name, ...a }); },
      // A post reports; it can't start or end work. Reading shared history is still allowed.
      onTool: (tool, args) => (tool === 'read_session_history' ? this._onTool(name, tool, args, ctx)
        : { ok: false, text: `Not available in a post you make on your own: ${this.human} decides what happens next. Report what you found.` }),
      resolve: (text) => {
        if (this._live(run) && String(text || '').trim()) {
          const model = this.labelFor ? this.labelFor(name) : null;
          const post = { kind: 'post', to: ['human'], took: Date.now() - started, ...(jobs.length ? { jobs: jobs.map((j) => ({ status: j.status, summary: j.summary })) } : {}), ...(model ? { model } : {}), ...(steps.length ? { steps } : {}) };
          const cur = this.tasks.active();
          if (cur && cur.status === 'paused') { (this.state.heldPosts || (this.state.heldPosts = [])).push({ from: name, text, ...post }); this.note(`${L} ${what}. Its report is held until you resume the task.`); }
          else this._append(name, text, post);
        }
        end();
      },
      reject: (e) => { if (!e || !e.stopped) this._append('system', `${L}'s report failed: ${e ? e.message : 'unknown error'}`, { kind: 'error' }); end(); }
    };
  }

  // ---------- approvals ----------
  // An agent above read only asks before each edit (and, at the "run" level, each command). The card is a transcript
  // entry (kind 'approval') that only the human answers (answerApproval, from the page); agents can't. Stop, a used-up
  // time allowance, the card's own timeout and closing the room all deny. "Allow edits for this task" is a standing
  // rule for that agent's edits until the task (or, outside a task, the human's message) changes, or Stop.
  // req: { kind: 'edit'|'command', title, paths, command, detail, reason, refused, sensitive }. refused: the host's
  // reason to refuse without a card (outside the folder, git's own folder, unknown files). sensitive: why this file
  // needs a card even under "Allow edits for this task". Resolves { allow, why }.
  _approvalScope() { const t = this.tasks.active(); return t ? `task:${t.id}:${t.generation}` : `run:${this.run}`; }

  requestApproval(name, req = {}) {
    const L = this.labels[name] || name, kind = req.kind === 'command' ? 'command' : 'edit';
    // What the card keeps: the change itself up to DETAIL_MAX characters (it says when it was cut), so a long run of
    // edits doesn't grow the saved room without bound.
    const detail = req.detail ? String(req.detail) : null;
    const card = { seat: name, kind, title: String(req.title || '').slice(0, 300), paths: (req.paths || []).slice(0, 20).map((p) => String(p).slice(0, 500)),
      command: req.command ? String(req.command).slice(0, 2000) : null, detail: detail ? detail.slice(0, DETAIL_MAX) : null, ...(detail && detail.length > DETAIL_MAX ? { detailCut: detail.length } : {}),
      reason: req.reason ? String(req.reason).slice(0, 500) : null, ...(req.sensitive ? { sensitive: String(req.sensitive).slice(0, 300) } : {}), ...(req.noRule ? { noRule: true } : {}) };
    const record = (status, extra = {}, quiet = true) => this._append('system', card.title, { kind: 'approval', approval: { id: `a${this.state.seq + 1}`, ...card, status, ...extra } }, quiet);
    if (!this.agents[name] || !this._live(this.run)) { record('denied', { why: 'stopped' }); return Promise.resolve({ allow: false, why: 'stopped' }); }
    if (!this.busy[name]) { record('denied', { why: 'its turn ended' }); return Promise.resolve({ allow: false, why: 'its turn ended' }); } // asked after its turn
    const refused = req.refused || (req.outside ? 'outside its folder' : null);
    if (refused) { record('denied', { why: refused }); return Promise.resolve({ allow: false, why: refused }); }
    // Modes answer for the human, after the host's refusals above: "auto" accepts ordinary edits (commands, sensitive
    // files and folder-wide writes still ask); "bypass" accepts every edit and command. Each is still recorded.
    const mode = this.modeFor ? this.modeFor(name) : 'ask';
    if (mode === 'bypass' || (mode === 'auto' && kind === 'edit' && !card.sensitive && !req.noRule)) {
      record('allowed', { auto: mode, detail: null, detailCut: undefined }); return Promise.resolve({ allow: true });
    }
    const scope = this._approvalScope();
    if (kind === 'edit' && !card.sensitive && !req.noRule && (this.state.allowRules || []).some((r) => r.seat === name && r.scope === scope)) {
      record('allowed', { auto: true, detail: null, detailCut: undefined }); return Promise.resolve({ allow: true });
    }
    const entry = record('pending', { asked: this.now() });
    // The whole change stays in memory while the card waits, so a cut card can still be read in full before answering.
    return new Promise((resolve) => this.pendingApprovals.set(entry.approval.id, { entry, resolve, scope, name, kind, sensitive: !!card.sensitive || !!req.noRule, asked: this.now(), full: card.detailCut ? detail : null }));
  }

  // decision: 'allow' | 'allowTask' (edits only) | 'deny'. Only the human's page calls this.
  answerApproval(id, decision) {
    const p = this.pendingApprovals.get(id); if (!p) return false;
    this.pendingApprovals.delete(id);
    const allow = decision === 'allow' || decision === 'allowTask';
    // The standing rule only when it can apply: an edit, not a sensitive file, still in the task it was asked in.
    const rule = decision === 'allowTask' && p.kind === 'edit' && !p.sensitive && p.scope === this._approvalScope();
    if (rule) this.state.allowRules = (this.state.allowRules || []).filter((r) => r.scope === p.scope).concat({ seat: p.name, scope: p.scope });
    this._settleApproval(p, allow ? (rule ? 'allowedTask' : 'allowed') : 'denied');
    return true;
  }

  _settleApproval(p, status, why = null) {
    Object.assign(p.entry.approval, { status, answered: this.now(), ...(why ? { why } : {}) });
    this.emit('approval', p.entry); this.emit('dirty', this.state);
    p.resolve({ allow: status === 'allowed' || status === 'allowedTask', why });
  }

  // Every waiting card is denied (Stop, closing the room, a used-up allowance), or only one agent's (its turn ended:
  // a card can't outlive the turn that asked, so a late Allow never looks like it did something).
  denyApprovals(why, name = null) {
    const all = [...this.pendingApprovals.entries()].filter(([, p]) => !name || p.name === name);
    for (const [id] of all) this.pendingApprovals.delete(id);
    for (const [, p] of all) this._settleApproval(p, 'denied', why);
    return all.length;
  }

  // What an agent may do changed: any standing "allow edits" rule it had ends.
  clearAllowRules(name) { this.state.allowRules = (this.state.allowRules || []).filter((r) => r.seat !== name); }

  // A turn that did not complete: its input (and steers accepted during it) becomes deliverable again, and the
  // requests it carried go back to open under their original ids.
  _undeliver(name, fresh, turnStart) {
    const steered = this.state.transcript.slice(turnStart).filter((x) => x.kind === 'steer' && x.steer.includes(name));
    for (const x of fresh.concat(steered)) unmarkKnown(x, name);
    const at = this.state.transcript.indexOf(fresh[0]);
    if (at >= 0) this.state.cursors[name] = Math.min(this.state.cursors[name], at);
    this.tasks.reopen(name);
  }

  // Task work that may not start now waits, undelivered, until the human resumes or adds allowance.
  _hold(name, reason) {
    this.held.add(name);
    const t = this.tasks.active(); const key = `${t && t.id}:${reason}`;
    if (this.heldNoted !== key) { this.heldNoted = key; this.note(`Task ${t ? t.id : ''}: ${reason}. ${this.labels[name]}'s pending work waits for ${this.human} (resume, add allowance, or stop).`); }
    this._taskChanged();
  }

  // Typed tool calls from an agent's turn. ctx pins the run, task and generation the turn started under.
  _onTool(name, tool, args, ctx) {
    if (!this._live(ctx.run)) return { ok: false, text: `Not sent: ${this.human} pressed Stop.` };
    if (tool === 'request_assistance') {
      const h = this.lastHuman || { id: null, text: '' };
      const r = this.tasks.requestAssistance(name, args, { originId: h.id, objective: h.text, run: ctx.run, taskId: ctx.taskId, generation: ctx.generation });
      if (r.ok) {
        const q = r.request; const t = q.task && this.tasks.get(q.task);
        const text = [q.question, q.scope && `Scope: ${q.scope}`, q.expected && `Expected answer: ${q.expected}`, t && `Task objective (from ${this.human}): ${t.objective}`].filter(Boolean).join('\n');
        this._append(name, text, { kind: 'request', to: q.to, request: q.id, purpose: q.purpose, ...(q.task ? { task: q.task } : {}) });
        this._taskChanged();
        this.deliver(q.to, ctx.run);
      } else if (r.budget) {
        const t = this.tasks.active(), key = `${t && t.id}:budget`;
        if (this.heldNoted !== key) { this.heldNoted = key; this.note(`Task ${t ? t.id : ''}: ${this.labels[name]} asked ${this.labels[args && args.to] || 'a peer'} for more, but ${r.text.replace(/^Not sent: /, '').replace(/\.$/, '')}. Add turns or time in Task controls to let them continue.`); }
      }
      return r;
    }
    if (tool === 'finish_task') {
      const t = this.tasks.active(); const r = this.tasks.finish(name, args && args.summary, ctx);
      if (r.ok) { this._releaseHeld(); this.note(`Task ${t.id} finished by ${this.labels[name]}: ${t.summary || ''}`); this._taskChanged(); }
      return r;
    }
    if (tool === 'read_session_history') {
      if (!this.readHistory) return { ok: false, text: 'Session history sharing is not available in this room.' };
      // Re-checked after the read: a result that lands after Stop (or after the turn's task moved on) is dropped.
      const stale = () => !this._live(ctx.run) || (ctx.taskId && (!this.tasks.get(ctx.taskId) || this.tasks.get(ctx.taskId).generation !== ctx.generation));
      return Promise.resolve(this.readHistory(name, args || {})).catch((e) => ({ ok: false, text: `Not available: ${e.message}` }))
        .then((r) => (stale() ? { ok: false, text: `Not delivered: ${this.human} pressed Stop.` } : r));
    }
    return { ok: false, text: `Unknown tool ${tool}.` };
  }

  // Posts held while their task was paused are shown once it leaves pause (resumed or finished); Stop discards them.
  _releaseHeld() { for (const p of (this.state.heldPosts || []).splice(0)) { const { from, text, ...rest } = p; this._append(from, text, rest); } }

  pauseTask() { if (this.tasks.pause('human')) { this.note(`Task paused by ${this.human}. Running turns finish; nothing new starts.`); this._taskChanged(); } }

  resumeTask() {
    const resumed = this.tasks.resume('human');
    if (!resumed && !this.held.size) return;
    this.heldNoted = null; if (resumed) this.note(`Task resumed by ${this.human}.`);
    this._releaseHeld(); this._taskChanged();
    const held = [...this.held]; this.held.clear();
    for (const n of held) this.deliver(n, this.run);
  }

  // Adjusting limits never resumes by itself; a raised limit is used when the human resumes.
  setTaskLimits(limits) { if (this.tasks.setLimits(limits)) this._taskChanged(); }

  // The host clock (scheduler.js): a used-up time allowance cancels running task work.
  tick() {
    for (const [id, p] of this.pendingApprovals) if (this.now() - p.asked >= this.approvalTimeoutMs) { this.pendingApprovals.delete(id); this._settleApproval(p, 'denied', 'no answer in time'); }
    if (!this.tasks.checkTime()) return;
    this.denyApprovals('the task used its time allowance');
    this.note(`Task ${this.tasks.active().id} used its time allowance. Running work is stopped; add time to continue, or finish with what we have.`);
    for (const n of this.names) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this._taskChanged();
  }

  _relay(from, text, run) {
    if (!this.proseHandoffs) {
      for (const to of handoffs(text, from, this.names)) this._append('system', `${this.labels[from]} asked for ${this.labels[to]} in its reply. Only you can pass it on.`, { kind: 'suggestion', suggest: { from, to } });
      return;
    }
    for (const to of handoffs(text, from, this.names)) {
      if (!this._live(run)) return;
      if (this.hopsLeft <= 0) {
        if (!this.capNoted) { this.capNoted = true; this.note(`Hop cap (${this.hopCap}) reached. ${this.labels[from]} asked for ${this.labels[to]}; waiting on ${this.human}.`); }
        continue;
      }
      this.hopsLeft -= 1;
      this.deliver(to, run);
    }
  }

  stopAll() {
    this.emit('stop'); // native session changes obey the same Stop boundary as turns
    this.cancelledThrough = this.state.cancelledThrough = this.run; this.pending = this._each(0); this.held.clear();
    const held = (this.state.heldPosts || []).splice(0).length;
    this.denyApprovals('stopped'); this.state.allowRules = [];
    if (this.tasks.stop()) this._taskChanged();
    if (held) this.note(`${held} held report${held === 1 ? '' : 's'} from background jobs discarded.`);
    for (const n of this.names) if (this.busy[n] && this.agents[n] && this.agents[n].interrupt) this.agents[n].interrupt();
    this.note(`Stopped by ${this.human}.`);
  }
}

module.exports = { Room, mentions, handoffs, label, AGENTS, LABEL };
