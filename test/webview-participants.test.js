'use strict';
// Actual renderer under a minimal DOM, to exercise seat routing rather than duplicate it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walk, setup } = require('./fixtures/webview-dom');
test('same-provider controls route model, session and history to the named seat', () => {
  const h = setup(); assert.equal(h.ids.participants.children.length, 3);
  h.click(h.ids.participants, 'Checker controls'); assert.match(h.ids.pop.textContent, /Codex on this computer/); assert.match(h.ids.pop.textContent, /\/fixture\/review/);
  h.click(h.ids.pop, 'High'); assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/codex-2 effort high' }); // Codex's own label, the CLI's own value
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Switch to one of your conversations…'); assert.deepEqual(h.sent.at(-1), { type: 'session', vendor: 'codex-2', action: 'switch' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Share Checker history with Research'); assert.deepEqual(h.sent.at(-1), { type: 'historyShare', source: 'codex-2', reader: 'claude', on: true });
  h.receive({ type: 'status', name: 'codex-2', busy: true }); h.click(h.ids.participants, 'Checker controls');
  const sw = walk(h.ids.pop).filter(e => ['Start over', 'Switch to one of your conversations…'].includes(e.textContent));
  assert.equal(sw.length, 2); assert.ok(sw.every(e => e.disabled));
});
test('mentions and lead selection use IDs while labels stay inert text', () => {
  const h = setup(); h.ids.input.value = '@codex-'; h.ids.input.selectionStart = 7; h.ids.input.fire('input');
  assert.equal(h.ids.menu.querySelector('.mlabel').textContent, '@codex-2'); h.ids.input.fire('keydown', { key: 'Tab' }); assert.equal(h.ids.input.value, '@codex-2 ');
  h.ids.lead.fire('click'); const b = walk(h.ids.pop).find(e => e.tagName === 'button' && e.textContent.includes('@codex-2 leads')); b.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/default codex-2' });
  h.meta.participants[1].label = '<img src=x onerror=bad()> '; h.controls['codex-2'].label = h.meta.participants[1].label;
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls }); assert.match(h.ids.participants.textContent, /<img src=x/); assert.equal(walk(h.ids.participants).filter(e => e.tagName === 'img').length, 0);
});
test('account quota stays singular and last-turn usage remains seat-specific', () => {
  const h = setup(); h.receive({ type: 'quota', quota: { primary: { usedPercent: 25, windowDurationMins: 300 } } });
  h.receive({ type: 'status', name: 'codex', busy: false, participantUsage: { fresh: 10, cached: 20, cacheWrite: 0, output: 5 } });
  h.receive({ type: 'status', name: 'codex-2', busy: false, participantUsage: { fresh: 30, cached: 40, cacheWrite: 0, output: 6 } });
  const open = () => { h.ids.pop.hidden = true; walk(h.ids.quota).find(e => e.tagName === 'button').fire('click'); return h.ids.pop.textContent; };
  assert.equal(walk(h.ids.quota).filter(e => e.tagName === 'button').length, 1);
  let t = open();
  assert.equal((t.match(/Codex · 5 hours/g) || []).length, 1, 'the account limit appears once, not per seat');
  assert.match(t, /BuilderLast reply read 30 tokens, 67% reused/i); assert.match(t, /CheckerLast reply read 70 tokens, 57% reused/i);
  h.receive({ type: 'init', meta: h.meta, controls: h.controls, participantUsage: { 'codex-2': { fresh: 50, cached: 60, cacheWrite: 0, output: 7 } } });
  t = open();
  assert.match(t, /CheckerLast reply read 110 tokens, 55% reused/i); assert.doesNotMatch(t, /Builder/);
  h.receive({ type: 'message', entry: { from: 'codex-2', text: 'Independent answer', ts: Date.now() } });
  assert.equal(h.ids.log.children.at(-1).dataset.participant, 'codex-2'); assert.match(h.ids.log.children.at(-1).className, /codex/); assert.match(h.ids.log.textContent, /Checker/);
});

test('the agent menu says which conversation it is on and offers safe ways to take it with you', () => {
  const h = setup();
  h.controls['codex-2'] = { ...h.controls['codex-2'], source: { kind: 'copy', id: 'th-users-own-1234', title: 'Plan the trip' }, own: 'th-copy-9999', session: 'th-copy-9999', typed: false };
  h.controls.claude = { ...h.controls.claude, source: { kind: 'copy', id: 'cl-src-1111', title: 'My chat' }, own: null, session: 'cl-src-1111' }; // a Claude copy before its first reply
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Checker controls');
  let t = h.ids.pop.textContent;
  assert.match(t, /Working on a copy of your conversation“Plan the trip”Your original stays exactly as it was\./);
  assert.match(t, /id: original th-users · this agent's copy th-copy-/);
  h.click(h.ids.pop, 'Copy command to open your original'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'copyResume', which: 'source' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Continue a copy yourself'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'copyResume', which: 'fork' });
  h.click(h.ids.participants, 'Checker controls'); h.click(h.ids.pop, 'Move it out of the room'); assert.deepEqual(h.sent.at(-1), { vendor: 'codex-2', type: 'moveOut' });
  h.click(h.ids.participants, 'Research controls');
  t = h.ids.pop.textContent;
  assert.match(t, /Working on a copy of your conversation“My chat”/);
  assert.match(t, /id: original cl-src-1/); assert.doesNotMatch(t, /this agent's copy/, 'the source id is never shown as the agent\'s own');
  assert.ok(walk(h.ids.pop).filter((e) => ['Continue a copy yourself', 'Move it out of the room'].includes(e.textContent)).every((e) => e.disabled), 'no id yet: nothing to take');
  assert.match(t, /saves a new conversation after its first reply/);
  h.controls.codex = { ...h.controls.codex, source: null, own: 'th-fresh-7777' };
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Builder controls');
  t = h.ids.pop.textContent;
  assert.match(t, /A fresh conversation started in this room\./); assert.doesNotMatch(t, /open your original/);
  assert.match(t, /id: conversation th-fresh/);
});

test('model and effort controls use each app\'s own words, tier order and an Older models group', () => {
  const h = setup();
  const claudeModels = [
    { id: 'default', name: 'Default (recommended)', note: 'Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', note: 'Most capable for your hardest and longest-running tasks' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'Best for everyday, complex tasks', fast: true, fastOk: true },
    { id: 'claude-opus-5', name: 'Opus 5', note: 'Best for everyday, complex tasks', older: true }];
  h.controls.claude = { ...h.controls.claude, provider: 'claude', model: null, effort: 'xhigh', models: claudeModels, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
  h.controls.codex = { ...h.controls.codex, provider: 'codex', model: 'gpt-x', effort: 'low', models: [{ id: 'gpt-x', name: 'GPT-X', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' }] };
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  assert.match(h.ids.participants.textContent, /ResearchDefault · Extra high/, 'Claude\'s chip: its default model and Claude Code\'s word for xhigh');
  assert.match(h.ids.participants.textContent, /BuilderGPT-X · Light/, 'Codex calls low "Light"');
  h.click(h.ids.participants, 'Research controls');
  let t = h.ids.pop.textContent;
  assert.ok(t.indexOf('Default (recommended)') < t.indexOf('Fable 5.1') && t.indexOf('Fable 5.1') < t.indexOf('Opus 5.5'), 'tier order, Default first');
  assert.match(t, /Older models/); assert.match(t, /EffortSet how hard the model triesLowMediumHighExtra highMax/);
  assert.ok(walk(h.ids.pop).some((e) => e.tagName === 'button' && /opt on/.test(e.className) && /Default \(recommended\)/.test(e.textContent)), 'no model chosen means Default is selected');
  h.click(h.ids.participants, 'Builder controls');
  t = h.ids.pop.textContent;
  assert.match(t, /Reasoning effort · default Medium/); assert.match(t, /LightMediumHighExtra HighMaxUltra/); assert.match(t, /⚡ Fast/);
  assert.strictEqual(walk(h.ids.pop).find((e) => e.tagName === 'button' && e.textContent === 'Ultra').title, 'Consumes usage limits faster');
});

test('while another agent keeps going in the original, the menu disables opening it and says why', () => {
  const h = setup();
  h.controls['codex-2'] = { ...h.controls['codex-2'], source: { kind: 'copy', id: 'th-users-own-1234', title: 'Plan the trip' }, own: 'th-copy-9999', sourceInUse: true };
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Checker controls');
  const b = walk(h.ids.pop).find((e) => e.tagName === 'button' && e.textContent === 'Copy command to open your original');
  assert.strictEqual(b.disabled, true);
  assert.match(h.ids.pop.textContent, /Another agent is keeping going in your original, so only a copy can be opened/);
});

test('when another room\'s file can\'t be read, the menu says Wagon Wheel can\'t confirm, not that an agent is using it', () => {
  const h = setup();
  h.controls['codex-2'] = { ...h.controls['codex-2'], source: { kind: 'copy', id: 'th-users-own-1234', title: 'Plan the trip' }, own: 'th-copy-9999', sourceInUse: 'unknown' };
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  h.click(h.ids.participants, 'Checker controls');
  assert.match(h.ids.pop.textContent, /can't confirm nothing is writing to your original right now/);
  assert.doesNotMatch(h.ids.pop.textContent, /Another agent is keeping going/);
});

test('an approval card: Allow, Allow edits for this task and Deny; the answer replaces it; the agent shows as waiting', () => {
  const { setup, walk } = require('./fixtures/webview-dom');
  const h = setup();
  const entry = { id: 7, from: 'system', kind: 'approval', ts: Date.now(), text: 'Edit a.txt', approval: { id: 'a7', seat: 'codex', kind: 'edit', title: 'Edit a.txt', paths: ['/fixture/app/a.txt'], detail: '-a\n+b', status: 'pending' } };
  h.receive({ type: 'message', entry }); h.receive({ type: 'status', name: 'codex', busy: true });
  assert.match(h.ids.log.textContent, /Builder wants to edit/);
  assert.match(h.ids.who.textContent, /waiting for you to allow or deny/);
  h.click(h.ids.log, 'Allow edits for this task');
  assert.deepEqual(h.sent.at(-1), { type: 'approval', id: 'a7', decision: 'allowTask' });
  assert.ok(walk(h.ids.log).filter((e) => e.tagName === 'button').every((b) => b.disabled), 'answered once');
  h.receive({ type: 'approval', entry: { ...entry, approval: { ...entry.approval, status: 'allowedTask' } } });
  assert.match(h.ids.log.textContent, /Allowed, with its other edits for this task/);
  assert.ok(!walk(h.ids.log).some((e) => e.tagName === 'button' && e.textContent === 'Deny'));
  // A command card has no "for this task" choice.
  h.receive({ type: 'message', entry: { ...entry, id: 8, approval: { ...entry.approval, id: 'a8', kind: 'command', title: 'Run outside the sandbox: touch b', detail: null, command: 'touch b' } } });
  assert.ok(!walk(h.ids.log).some((e) => e.tagName === 'button' && e.textContent === 'Allow edits for this task'));
  h.click(h.ids.log, 'Deny'); assert.deepEqual(h.sent.at(-1), { type: 'approval', id: 'a8', decision: 'deny' });
  h.receive({ type: 'message', entry: { ...entry, id: 9, approval: { ...entry.approval, id: 'a9', title: 'Edit package.json', sensitive: 'package.json can run code or change how your tools behave', detail: 'x'.repeat(4000), detailCut: 9000 } } });
  assert.match(h.ids.log.textContent, /Look closely: package.json can run code/);
  assert.match(h.ids.log.textContent, /Showing the first 4,000 of 9,000 characters/);
  h.click(h.ids.log, 'Show the full change'); assert.deepEqual(h.sent.at(-1), { type: 'approvalFull', id: 'a9' });
  const row9 = walk(h.ids.log).find((e) => e.dataset && e.dataset.approval === 'a9');
  assert.ok(!walk(row9).some((e) => e.tagName === 'button' && e.textContent === 'Allow edits for this task'), 'no task-wide choice on a sensitive card');
});

test('what an agent can do: set from its menu; only one agent can edit', () => {
  const { setup } = require('./fixtures/webview-dom');
  const h = setup();
  h.controls.codex.access = 'edit'; h.controls['codex-2'].editorElsewhere = true;
  h.receive({ type: 'meta', meta: h.meta, controls: h.controls });
  assert.match(h.ids.participants.textContent, /can edit/);
  h.click(h.ids.participants, 'Checker controls');
  assert.match(h.ids.pop.textContent, /Only one agent in a room can edit files/);
  h.click(h.ids.participants, 'Research controls');
  h.controls['codex-2'].editorElsewhere = false;
  h.click(h.ids.participants, 'Builder controls'); h.click(h.ids.pop, 'Read only');
  assert.deepEqual(h.sent.at(-1), { type: 'command', text: '/codex access read' });
});

test('a room in a separate copy says so, counts changes, and offers open / bring in / remove', () => {
  const { setup } = require('./fixtures/webview-dom');
  const h = setup();
  const meta = { ...h.meta, copy: { repo: '/r', dir: '/s/copy', branch: 'wagon-wheel/x-1', base: 'abc' } };
  h.receive({ type: 'init', meta, controls: h.controls, transcript: [] });
  assert.deepEqual(h.sent.at(-1), { type: 'copy', action: 'refresh' });
  h.receive({ type: 'copyChanges', changes: { files: ['a', 'b'], commits: 1 } });
  assert.match(h.ids.ids.textContent, /Working in a separate copy · branch wagon-wheel\/x-1 · 2 changed files, 1 commit/);
  h.click(h.ids.ids, 'Bring changes into your folder'); assert.deepEqual(h.sent.at(-1), { type: 'copy', action: 'bringIn' });
});
