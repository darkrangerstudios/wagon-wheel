'use strict';
const fs = require('fs');
const path = require('path');

const PROVIDERS = new Set(['claude', 'codex']);
const RESERVED = new Set(['both', 'all', 'human', 'system', ...Object.getOwnPropertyNames(Object.prototype)]);
const FIELDS = new Set(['id', 'label', 'provider', 'cwd', 'sessionId', 'model', 'effort', 'fast', 'typed', 'typedThreads', 'forkFrom', 'access', 'briefAccess', 'mode']);
const MODES = ['ask', 'auto', 'bypass'];
// What an agent may do. Read only unless the person chose more for it; at most one agent per room above read only.
const LEVELS = ['read', 'edit', 'run'];
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const own = (value, key) => Object.hasOwn(value, key);
const plain = (value) => value !== null && typeof value === 'object'
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const invalid = (detail) => { throw new Error(`Invalid participant ${detail}`); };

function providerName(value) {
  if (!PROVIDERS.has(value)) invalid('provider');
  return value;
}

function sessionId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || CONTROL.test(value)) invalid('session id');
  return value;
}

function setting(value, key) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || CONTROL.test(value)) invalid(key);
  return value.trim() || null;
}

function boolean(value, fallback, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(key);
  return value;
}

function folder(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || CONTROL.test(value)) invalid('working folder; choose an absolute existing directory');
  try { if (fs.statSync(value).isDirectory()) return value; } catch { /* absent or inaccessible */ }
  invalid('working folder; choose an absolute existing directory');
}

// Undefined means inherit; null remains an explicit model/effort default.
function fallback(source, key, next, nextKey = key) {
  return source[key] === undefined ? next[nextKey] : source[key];
}

function normalizeParticipants(meta = {}, settings = {}) {
  if (!plain(meta) || !plain(settings)) invalid('room settings');
  let seats;
  if (own(meta, 'seats')) {
    seats = meta.seats;
  } else {
    seats = ['claude', 'codex'].map((provider) => {
      const record = { id: provider, label: provider === 'claude' ? 'Claude' : 'Codex', provider,
        sessionId: meta[provider === 'claude' ? 'claudeSessionId' : 'codexThreadId'],
        fast: fallback(meta, `${provider}Fast`, settings),
        typed: fallback(meta, `${provider}Typed`, settings) };
      if (meta[`${provider}TypedThreads`] !== undefined) record.typedThreads = meta[`${provider}TypedThreads`];
      const origin = provider === 'claude' ? 'claudeForkedFrom' : 'forkedFrom';
      if (meta[origin] !== undefined) record.forkFrom = meta[origin];
      return record;
    });
  }
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > 6) invalid('roster; choose between one and six participants');
  const seen = new Set();
  const out = Array.from(seats).map((seat) => {
    if (!plain(seat) || Object.keys(seat).some((key) => !FIELDS.has(key))) invalid('record');
    const { id, label } = seat;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || RESERVED.has(id) || /^h[0-9]+$/.test(id)) invalid('id');
    if (seen.has(id)) throw new Error(`Duplicate participant id: ${id}`);
    seen.add(id);
    if (typeof label !== 'string' || !label.trim() || label.length > 60 || CONTROL.test(label)) invalid('label');
    const provider = providerName(seat.provider);
    const record = { id, label: label.trim(), provider,
      cwd: folder(fallback(seat, 'cwd', { cwd: fallback(meta, 'cwd', settings) })),
      sessionId: sessionId(seat.sessionId),
      model: setting(fallback(seat, 'model', { model: fallback(meta, `${provider}Model`, settings) }), 'model'),
      effort: setting(fallback(seat, 'effort', { effort: fallback(meta, `${provider}Effort`, settings) }), 'effort'),
      fast: boolean(seat.fast, false, 'fast mode'),
      typed: boolean(seat.typed, provider === 'claude', 'typed tools flag') };
    if (own(seat, 'typedThreads')) {
      if (!Array.isArray(seat.typedThreads) || Array.from(seat.typedThreads).some((id) => sessionId(id) === null)) invalid('typed threads');
      record.typedThreads = [...new Set(seat.typedThreads)];
    }
    if (own(seat, 'forkFrom')) record.forkFrom = sessionId(seat.forkFrom);
    const access = seat.access === undefined || seat.access === null ? 'read' : seat.access;
    if (!LEVELS.includes(access)) invalid('permission level');
    record.access = access;
    // How its requests are answered. Auto needs an agent that edits; bypass one that also runs commands. Bypass never
    // survives a reopen (bootSeats resets it): it is turned on per session, with a warning each time.
    const mode = seat.mode === undefined || seat.mode === null ? 'ask' : seat.mode;
    if (!MODES.includes(mode)) invalid('mode');
    record.mode = access === 'read' || (mode === 'bypass' && access !== 'run') ? 'ask' : mode;
    if (seat.briefAccess !== undefined) { if (!LEVELS.includes(seat.briefAccess)) invalid('permission level'); record.briefAccess = seat.briefAccess; }
    return record;
  });
  if (out.filter((s) => s.access !== 'read').length > 1) throw new Error('Only one agent in a room can edit files. Set the others to read only.');
  return out;
}

// Only coordinates clients in this extension-host process. It cannot detect external CLI writers or other windows.
class SessionClaims {
  constructor() { this.claims = new Map(); }

  key(provider, id, owner) {
    providerName(provider);
    if (owner === null || owner === undefined) throw new Error('Invalid session claim owner');
    const checked = sessionId(id);
    return checked === null ? null : JSON.stringify([provider, checked]);
  }

  claim(provider, id, owner) {
    const key = this.key(provider, id, owner);
    if (key === null) return true;
    if (this.claims.has(key)) return this.claims.get(key) === owner;
    this.claims.set(key, owner);
    return true;
  }

  // Read-only: is this conversation owned by any seat or room in this extension host?
  isClaimed(provider, id) { const key = this.key(provider, id, {}); return key !== null && this.claims.has(key); }

  release(provider, id, owner) {
    const key = this.key(provider, id, owner);
    if (key === null || this.claims.get(key) !== owner) return false;
    return this.claims.delete(key);
  }

  releaseOwner(owner) {
    if (owner === null || owner === undefined) throw new Error('Invalid session claim owner');
    let released = 0;
    for (const [key, current] of this.claims) if (current === owner) { this.claims.delete(key); released++; }
    return released;
  }
}

module.exports = { normalizeParticipants, SessionClaims, LEVELS, MODES };
