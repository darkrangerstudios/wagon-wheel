'use strict';
// Typed room tools at the process boundary, transport faked: Claude's in-process MCP server over stream-json,
// Codex's dynamicTools over app-server JSON-RPC.
const test = require('node:test');
const assert = require('node:assert');
const { ClaudeClient } = require('../src/claudeClient');
const { CodexClient } = require('../src/codexClient');
const { toolSpecs } = require('../src/tasks');
const tick = () => new Promise((r) => setImmediate(r));

function claude(tools = toolSpecs(['codex'])) {
  const writes = [];
  const c = new ClaudeClient({ exe: 'unused', cwd: __dirname, systemPrompt: '', tools });
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } }, kill() {} };
  return { c, writes, mcp: (id, method, params) => c._onLine(JSON.stringify({ type: 'control_request', request_id: `q${id}`, request: { subtype: 'mcp_message', server_name: 'wagon', message: { jsonrpc: '2.0', id, method, params } } })) };
}
const reply = (writes, rid) => writes.find((w) => w.type === 'control_response' && w.response.request_id === rid).response.response.mcp_response;

test('Claude: typed tools are allowed and served in-process; no other MCP server is configured', () => {
  const { c } = claude();
  const a = c._args();
  assert.deepStrictEqual(JSON.parse(a[a.indexOf('--mcp-config') + 1]), { mcpServers: { wagon: { type: 'sdk', name: 'wagon' } } });
  assert.ok(a.includes('--strict-mcp-config'));
  // The user's own settings must not widen the room: restricted mode, and only the read tools built in.
  assert.ok(a.includes('--restricted'));
  assert.strictEqual(a[a.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.strictEqual(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.strictEqual(a[a.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,mcp__wagon__request_assistance,mcp__wagon__read_session_history,mcp__wagon__finish_task');
  const plain = new ClaudeClient({ exe: 'x', cwd: __dirname, systemPrompt: '' })._args();
  assert.strictEqual(plain[plain.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
});

test('Claude: tools/list and tools/call are answered over stdin; the call goes to the open reply', async () => {
  const { c, writes, mcp } = claude();
  mcp(1, 'tools/list'); await tick();
  assert.deepStrictEqual(reply(writes, 'q1').result.tools.map((t) => t.name), ['request_assistance', 'read_session_history', 'finish_task']);
  const seen = [];
  const pending = c.send('go', () => {}, () => {}, [], (name, args) => { seen.push([name, args]); return { ok: true, text: 'accepted r1' }; });
  mcp(2, 'tools/call', { name: 'request_assistance', arguments: { to: 'codex', purpose: 'review', question: 'q' } }); await tick(); await tick();
  assert.deepStrictEqual(seen, [['request_assistance', { to: 'codex', purpose: 'review', question: 'q' }]]);
  assert.deepStrictEqual(reply(writes, 'q2').result, { content: [{ type: 'text', text: 'accepted r1' }] });
  c._onLine(JSON.stringify({ type: 'result', result: 'done' }));
  assert.strictEqual(await pending, 'done');
});

test('Claude: a refused call is an MCP error result; a call with no reply open is refused', async () => {
  const { c, writes, mcp } = claude();
  const pending = c.send('go', () => {}, () => {}, [], () => ({ ok: false, text: 'Not sent: paused' }));
  mcp(3, 'tools/call', { name: 'request_assistance', arguments: {} }); await tick(); await tick();
  assert.strictEqual(reply(writes, 'q3').result.isError, true);
  c._onLine(JSON.stringify({ type: 'result', result: 'x' })); await pending;
  mcp(4, 'tools/call', { name: 'finish_task', arguments: { summary: 's' } }); await tick(); await tick();
  assert.match(reply(writes, 'q4').result.content[0].text, /no reply is open/);
});

function codex() {
  const writes = []; const c = new CodexClient({ exe: 'unused', cwd: __dirname, tools: toolSpecs(['claude']) });
  c.verifiedThreads.add('th'); // transport replay: attachment verification is covered in codex-permissions.test.js
  c.proc = { stdin: { write(s) { writes.push(JSON.parse(s)); } } };
  const call = (id, threadId) => c._onLine(JSON.stringify({ id, method: 'item/tool/call', params: { threadId, turnId: 't1', callId: 'c', tool: 'request_assistance', arguments: { to: 'claude', purpose: 'test', question: 'q' }, namespace: null } }));
  return { c, writes, call };
}

test('Codex: new threads carry the tools; a tool call reaches the running turn on that thread only', async () => {
  const { c, writes, call } = codex(); const sent = [];
  c.request = (method, params) => {
    sent.push({ method, params });
    if (method === 'config/read') return Promise.resolve({ config: {
      features: Object.fromEntries(['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'skill_mcp_dependency_install'].map(k => [k, false])),
      web_search: 'disabled', mcp_servers: {},
    } });
    if (method === 'mcpServerStatus/list') return Promise.resolve({ data: [], nextCursor: null });
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'th' }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } });
    return new Promise(() => {});
  };
  await c.startThread('brief');
  assert.deepStrictEqual(sent.find(x => x.method === 'thread/start').params.dynamicTools.map((t) => [t.type, t.name]), [['function', 'request_assistance'], ['function', 'read_session_history'], ['function', 'finish_task']]);
  c.runTurn('th', 'go', () => {}, () => {}, [], { onTool: (name, args) => ({ ok: true, text: `accepted for ${args.to}` }) });
  call(7, 'th'); await tick(); await tick();
  assert.deepStrictEqual(writes.find((w) => w.id === 7).result, { contentItems: [{ type: 'inputText', text: 'accepted for claude' }], success: true });
  call(8, 'other-thread'); await tick(); await tick();
  assert.strictEqual(writes.find((w) => w.id === 8).result.success, false);
});

test('Codex: at read only an approval request is declined, and other server requests are refused', async () => {
  const { c, writes } = codex();
  c._onLine(JSON.stringify({ id: 9, method: 'item/commandExecution/requestApproval', params: {} }));
  c._onLine(JSON.stringify({ id: 10, method: 'item/fileChange/requestApproval', params: {} }));
  c._onLine(JSON.stringify({ id: 11, method: 'item/tool/requestUserInput', params: {} }));
  await tick();
  assert.deepStrictEqual([writes.find((w) => w.id === 9).result, writes.find((w) => w.id === 10).result], [{ decision: 'decline' }, { decision: 'decline' }]);
  assert.ok(writes.find((w) => w.id === 11).error);
});

test('a tool result that resolves after the reply ended is not handed to the model (both clients)', async () => {
  const { c, writes, mcp } = claude(); let release;
  const pending = c.send('go', () => {}, () => {}, [], () => new Promise((r) => { release = r; }));
  mcp(5, 'tools/call', { name: 'read_session_history', arguments: { source: 'h1' } }); await tick();
  c._onLine(JSON.stringify({ type: 'result', result: 'ended' })); await pending;
  release({ ok: true, text: 'PRIVATE-LATE' }); await tick(); await tick();
  assert.doesNotMatch(JSON.stringify(reply(writes, 'q5')), /PRIVATE/);
  const x = codex(); let rel2;
  x.c.request = (m) => (m === 'turn/start' ? new Promise(() => {}) : Promise.resolve({}));
  x.c.runTurn('th', 'go', () => {}, () => {}, [], { onTool: () => new Promise((r) => { rel2 = r; }) });
  x.call(11, 'th'); await tick();
  x.c.currentTurn.cancelled = true; rel2({ ok: true, text: 'PRIVATE-LATE' }); await tick(); await tick();
  const w = x.writes.find((m) => m.id === 11);
  assert.strictEqual(w.result.success, false); assert.doesNotMatch(JSON.stringify(w), /PRIVATE/);
});

test('turn usage: Claude sums every leg of a steered reply; Codex sums its per-call reports', async () => {
  const { c } = claude();
  const p = c.send('go');
  c.steer('redirect');
  c._onLine(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 } }));
  c._onLine(JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 3, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 4 } }));
  await p;
  assert.deepStrictEqual(c.lastTurnUsage, { fresh: 8, cached: 150, cacheWrite: 10, output: 11 });
  const x = codex(); let started;
  x.c.request = (m) => (m === 'turn/start' ? new Promise((r) => { started = r; }) : Promise.resolve({}));
  const turn = x.c.runTurn('th', 'go');
  started({ turn: { id: 't1' } }); await tick();
  const up = (last) => x.c.emit('notification', 'thread/tokenUsage/updated', { threadId: 'th', turnId: 't1', tokenUsage: { last } });
  up({ inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 20 });
  up({ inputTokens: 1100, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 30 });
  x.c.emit('notification', 'turn/completed', { threadId: 'th', turn: { id: 't1', status: 'completed' } });
  await turn;
  assert.deepStrictEqual(x.c.lastTurnUsage, { fresh: 200, cached: 1900, cacheWrite: 0, output: 50 });
});
