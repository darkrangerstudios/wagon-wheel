'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeParticipants, SessionClaims } = require('../src/participants');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wagon-participants-'));
const otherCwd = path.join(cwd, 'other');
fs.mkdirSync(otherCwd);
const file = path.join(cwd, 'file.txt');
fs.writeFileSync(file, 'fixture');
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const seat = (overrides = {}) => ({ id: 'app', label: 'App', provider: 'codex', cwd, ...overrides });

test('legacy settings migrate without mutating saved room metadata', () => {
  const meta = { cwd, claudeSessionId: 'c1', codexThreadId: 'x1', claudeModel: null,
    claudeEffort: 'high', codexModel: 'saved-model', codexFast: false,
    claudeFast: true, codexTyped: true, codexTypedThreads: ['x1'],
    forkedFrom: 'x0', claudeForkedFrom: 'c0' };
  const before = structuredClone(meta);
  const settings = { cwd: otherCwd, claudeModel: 'default-claude', codexModel: 'default-codex',
    codexEffort: 'low', codexFast: true };
  const participants = normalizeParticipants(meta, settings);
  assert.deepEqual(participants, [
    { id: 'claude', label: 'Claude', provider: 'claude', cwd, sessionId: 'c1', model: null,
      effort: 'high', fast: true, typed: true, forkFrom: 'c0', access: 'read' },
    { id: 'codex', label: 'Codex', provider: 'codex', cwd, sessionId: 'x1', model: 'saved-model',
      effort: 'low', fast: false, typed: true, typedThreads: ['x1'], forkFrom: 'x0', access: 'read' }
  ]);
  participants[1].typedThreads.push('x2');
  assert.deepEqual(meta, before);
});

test('new legacy rooms inherit provider defaults and preserve a false typed flag', () => {
  const participants = normalizeParticipants({ codexTyped: false }, { cwd, claudeModel: 'c', codexEffort: 'medium' });
  assert.deepEqual(participants.map(({ id, sessionId, model, effort, fast, typed }) => ({ id, sessionId, model, effort, fast, typed })), [
    { id: 'claude', sessionId: null, model: 'c', effort: null, fast: false, typed: true },
    { id: 'codex', sessionId: null, model: null, effort: 'medium', fast: false, typed: false }
  ]);
});

test('same-provider seats retain independent folders, sessions and options', () => {
  const meta = { cwd, codexThreadId: 'obsolete', codexModel: 'legacy-default', seats: [
    seat({ sessionId: 'app-thread', model: 'app-model', effort: 'high', fast: true, typed: true, typedThreads: ['app-thread'] }),
    seat({ id: 'db', label: 'Database', cwd: otherCwd, sessionId: 'db-thread', model: null, effort: 'low', fast: false, typed: false })
  ] };
  const before = structuredClone(meta);
  const normalized = normalizeParticipants(meta, { cwd, codexModel: 'settings-model' });
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].provider, normalized[1].provider);
  assert.equal(normalized[0].model, 'app-model');
  assert.equal(normalized[1].model, null);
  assert.equal(normalized[1].cwd, otherCwd);
  assert.equal(normalized[1].sessionId, 'db-thread');
  normalized[0].typedThreads.push('new-thread');
  normalized[1].label = 'Changed';
  assert.deepEqual(meta, before);
});

test('saved seats may inherit defaults but never inherit a legacy session identity', () => {
  const [record] = normalizeParticipants({ cwd, codexThreadId: 'legacy', codexModel: 'saved', seats: [
    { id: 'app', label: 'App', provider: 'codex' }
  ] }, { codexEffort: 'low' });
  assert.equal(record.cwd, cwd);
  assert.equal(record.model, 'saved');
  assert.equal(record.effort, 'low');
  assert.equal(record.sessionId, null);
});

test('saved roster presence is authoritative, including malformed and empty values', () => {
  for (const seats of [undefined, null, false, {}, [], [null], ['app'], new Array(1), Array.from({ length: 7 }, (_, n) => seat({ id: `a${n}` }))]) {
    assert.throws(() => normalizeParticipants({ cwd, seats }, {}), /Invalid participant/);
  }
  assert.equal(normalizeParticipants({ seats: [seat()] }, {}).length, 1);
  assert.equal(normalizeParticipants({ seats: Array.from({ length: 6 }, (_, n) => seat({ id: `a${n}` })) }, {}).length, 6);
});

test('routing and history reserved ids, prototype ids and duplicate ids are rejected', () => {
  for (const id of ['both', 'all', 'human', 'system', 'constructor', '__proto__', 'toString', 'h1', 'h000', 'App', '1app', 'a b', '', 'a'.repeat(33)]) {
    assert.throws(() => normalizeParticipants({ seats: [seat({ id })] }, {}), /Invalid participant/);
  }
  assert.throws(() => normalizeParticipants({ seats: [seat(), seat({ provider: 'claude' })] }, {}), /Duplicate participant id/);
  assert.equal(normalizeParticipants({ seats: [seat({ id: 'h' }), seat({ id: 'h1-app' })] }, {}).length, 2);
});

test('invalid provider, labels, folders and saved options are rejected before startup', () => {
  for (const overrides of [
    { provider: 'gemini' }, { provider: 'constructor' }, { label: '' }, { label: '  ' },
    { label: 'a'.repeat(61) }, { label: 'line\nbreak' }, { label: 'tab\tlabel' }, { label: 'nul\0label' },
    { cwd: '.' }, { cwd: path.join(cwd, 'missing') }, { cwd: file },
    { sessionId: '' }, { sessionId: '  ' }, { sessionId: 42 }, { sessionId: 'x'.repeat(201) },
    { sessionId: 'bad\nthread' }, { fast: 'false' }, { typed: 1 },
    { model: {} }, { effort: [] }, { typedThreads: 'thread' }, { typedThreads: [null] }, { typedThreads: new Array(1) },
    { forkFrom: '' }, { exe: '/untrusted/command' }, { sandbox: 'danger-full-access' }
  ]) assert.throws(() => normalizeParticipants({ seats: [seat(overrides)] }, {}), /Invalid participant/);
});

test('session claims reject a second writer, allow the same owner and distinguish providers', () => {
  const claims = new SessionClaims(), first = {}, second = {};
  assert.equal(claims.claim('codex', 'thread', first), true);
  assert.equal(claims.claim('codex', 'thread', first), true);
  assert.equal(claims.claim('codex', 'thread', second), false);
  assert.equal(claims.claim('claude', 'thread', second), true);
  assert.equal(claims.claim('codex', 'other-thread', second), true);
  assert.equal(claims.claim('codex', null, first), true);
  assert.equal(claims.claim('codex', null, second), true);
});

test('only the owning token can release a claim and releaseOwner preserves other writers', () => {
  const claims = new SessionClaims(), first = {}, second = {};
  claims.claim('codex', 'x1', first);
  claims.claim('claude', 'c1', first);
  claims.claim('codex', 'x2', second);
  assert.equal(claims.release('codex', 'x1', second), false);
  assert.equal(claims.claim('codex', 'x1', second), false);
  assert.equal(claims.release('codex', 'x1', first), true);
  assert.equal(claims.claim('codex', 'x1', second), true);
  assert.equal(claims.releaseOwner(first), 1);
  assert.equal(claims.claim('claude', 'c1', second), true);
  assert.equal(claims.claim('codex', 'x2', first), false);
  assert.equal(claims.releaseOwner(first), 0);
  assert.equal(claims.releaseOwner(second), 3);
  assert.equal(claims.release('codex', null, first), false);
});

test('claims reject malformed identities and missing owner tokens', () => {
  const claims = new SessionClaims();
  for (const args of [['gemini', 'x', {}], ['codex', '', {}], ['codex', 'x', null], ['claude', 'x', undefined]]) {
    assert.throws(() => claims.claim(...args), /Invalid/);
  }
  assert.throws(() => claims.releaseOwner(null), /Invalid/);
});

test('SessionClaims.isClaimed reports ownership without taking it', () => {
  const { SessionClaims } = require('../src/participants');
  const c = new SessionClaims(), owner = {};
  assert.strictEqual(c.isClaimed('codex', 'th-1'), false);
  c.claim('codex', 'th-1', owner);
  assert.strictEqual(c.isClaimed('codex', 'th-1'), true); assert.strictEqual(c.isClaimed('claude', 'th-1'), false);
  assert.strictEqual(c.claim('codex', 'th-1', owner), true, 'the owner still owns it');
});

test('permission levels: read only by default, validated, and at most one agent above read only', () => {
  const seat = (id, provider, access) => ({ id, label: id, provider, cwd, ...(access === undefined ? {} : { access }) });
  assert.deepEqual(normalizeParticipants({ seats: [seat('a', 'claude'), seat('b', 'codex', 'run')] }).map((p) => p.access), ['read', 'run']);
  assert.throws(() => normalizeParticipants({ seats: [seat('a', 'claude', 'admin')] }), /permission level/);
  assert.throws(() => normalizeParticipants({ seats: [seat('a', 'claude', 'edit'), seat('b', 'codex', 'edit')] }), /Only one agent in a room can edit/);
});
