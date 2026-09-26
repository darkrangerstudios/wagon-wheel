'use strict';
// Minimal DOM for running the actual webview script (media/room.js) under node: enough for rendering,
// clicks and postMessage, no layout. Shared by the webview tests.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; this.attrs = {}; this.className = ''; this.hidden = false; this.value = ''; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this.selectionStart = 0; this._text = ''; this.classList = { add: x => { this.className += ' ' + x; }, toggle: (x, on) => { this.className = this.className.split(' ').filter(c => c !== x).concat(on ? [x] : []).join(' '); } }; }
  set textContent(x) { this._text = String(x); this.children = []; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  get lastChild() { return this.children.at(-1); }
  appendChild(e) { e.parent = this; this.children.push(e); return e; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(k, e = {}) { for (const fn of this.events[k] || []) fn({ preventDefault() {}, ...e }); }
  // Simple selectors, plus descendant combinators ("#quota .btn") for closest().
  matches(sel) {
    const parts = sel.trim().split(/\s+/); let node = this;
    if (!node._one(parts.pop())) return false;
    while (parts.length) { const p = parts.pop(); node = node.parent; while (node && !(node._one && node._one(p))) node = node.parent; if (!node) return false; }
    return true;
  }
  _one(s) { if (s.startsWith('.')) return s.slice(1).split('.').every(c => this.className.split(' ').includes(c)); if (s.startsWith('#')) return this.id === s.slice(1); return this.tagName === s; }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; }
  querySelector(s) { return walk(this).find(e => e.matches(s)) || null; }
  focus() {} scrollIntoView() {}
  setSelectionRange(a) { this.selectionStart = a; }
  remove() { this.parent.children = this.parent.children.filter(e => e !== this); }
  replaceWith(e) { const i = this.parent.children.indexOf(this); e.parent = this.parent; this.parent.children[i] = e; }
}
function walk(e) { return e.children.flatMap(c => [c, ...walk(c)]); }
// Loads the webview with a three-seat fixture room. Returns the elements by id, the messages the page posted,
// receive(msg) to deliver a host message, and click(root, label) for buttons by text or aria-label.
function setup({ participants: given } = {}) {
  const ids = Object.fromEntries(['log','input','participants','ide','deftarget','lead','quota','who','stop','send','task','tc','pop','tray','menu','title','ids','attach'].map(id => { const e = new Element(); e.id = id; return [id, e]; }));
  ids.pop.hidden = true;
  const body = new Element('body'); body.dataset.wc = require('../../package.json').version; Object.values(ids).forEach(e => body.appendChild(e));
  const listeners = {}, docListeners = {}, sent = [];
  const document = { body, createElement: t => new Element(t), getElementById: id => walk(body).find(e => e.id === id), addEventListener: (k, fn) => { (docListeners[k] ||= []).push(fn); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../media/room.js'), 'utf8'), { document, window: { innerHeight: 800, addEventListener: (k, fn) => { listeners[k] = fn; } }, navigator: { platform: 'Mac' }, acquireVsCodeApi: () => ({ postMessage: m => sent.push(JSON.parse(JSON.stringify(m))) }), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1 });
  const participants = given || [{ id: 'codex', label: 'Builder', provider: 'codex', cwd: '/fixture/app' }, { id: 'codex-2', label: 'Checker', provider: 'codex', cwd: '/fixture/review' }, { id: 'claude', label: 'Research', provider: 'claude', cwd: '/fixture/research' }];
  const controls = Object.fromEntries(participants.map(p => [p.id, { ...p, model: 'fixture-model', models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['low', 'high'] }], effort: 'low', efforts: ['low', 'max'], session: p.id + '-thread', typed: true, readers: participants.filter(r => r.id !== p.id).map(r => ({ id: r.id, label: r.label, shared: false })) }]));
  const meta = { name: 'Fixture', participants, defaultTarget: participants[1] ? participants[1].id : participants[0].id };
  const receive = m => listeners.message({ data: m }); receive({ type: 'init', meta, controls, transcript: [] });
  const click = (root, label) => { const b = walk(root).find(e => e.tagName === 'button' && (e.textContent === label || e.attrs['aria-label'] === label)); if (!b) throw new Error(`no button ${label}`); b.fire('click'); };
  // docFire(kind, target): a document-level event as it would bubble from `target` (e.g. the outside-click handler).
  const docFire = (k, target) => { for (const fn of docListeners[k] || []) fn({ target, preventDefault() {} }); };
  return { ids, body, sent, receive, meta, controls, click, docFire };
}
module.exports = { Element, walk, setup };
