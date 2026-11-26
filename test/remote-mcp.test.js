import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the stdio bridge renews only confirmed lost MCP sessions once', { timeout: 15_000 }, async () => {
  const key = 'xattest_live_' + randomBytes(32).toString('base64url');
  const requests = [];
  let phase = 'ok', session = 0, writes = 0;
  const upstream = createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks));
    const header = req.headers['mcp-session-id'];
    requests.push({ method: msg.method, header, authenticated: req.headers.authorization === 'Bearer ' + key });
    res.setHeader('Content-Type', 'application/json');
    function sendError(status, reason) {
      res.writeHead(status).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: reason } }));
    }
    if (msg.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'session-' + ++session);
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: {} } }));
    }
    if (msg.method === 'notifications/initialized') return res.writeHead(202).end();
    if (phase === 'gone' || phase === 'always-gone') {
      if (phase === 'gone') phase = 'ok';
      return sendError(404, 'Unknown MCP session for this agent.');
    }
    if (phase === 'other-404') return sendError(404, 'Record not found.');
    if (phase === 'suspended') return sendError(401, 'Credential expired.');
    writes++;
    if (phase === 'ambiguous') return res.destroy();
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { writes } }));
  });
  const temp = await mkdtemp(join(tmpdir(), 'crossattest-bridge-'));
  let bridge, stopped;
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const profile = join(temp, 'agent.json');
    await writeFile(profile, JSON.stringify({ CROSSATTEST_API_KEY: key, mcp_url: 'http://127.0.0.1:' + upstream.address().port + '/mcp' }), { mode: 0o600 });
    bridge = spawn(process.execPath, [fileURLToPath(new URL('../bin/crossattest.js', import.meta.url)), 'connect', '--credentials', profile],
      { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    stopped = once(bridge, 'close');
    const reader = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
    let nextId = 0;
    async function request(method, params = {}) {
      const id = ++nextId;
      bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const reply = JSON.parse((await reader.next()).value);
      assert.equal(reply.id, id);
      return reply;
    }
    const init = () => request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, capabilities: {} });
    await init();
    phase = 'gone';
    assert.equal((await request('tools/call')).result.writes, 1);
    assert.deepEqual(requests.slice(-4).map(r => r.method), ['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(session, 2);
    for (const mode of ['other-404', 'suspended', 'ambiguous']) {
      phase = mode;
      const attempts = requests.length;
      assert.ok((await request('tools/call')).error);
      assert.equal(requests.length, attempts + 1);
    }
    assert.equal(writes, 2, 'The ambiguous write was executed exactly once.');
    phase = 'always-gone';
    const before = requests.length;
    assert.ok((await request('tools/call')).error);
    assert.equal(requests.length, before + 4, 'An expired replacement causes a single renewal.');
    await init();
    assert.ok(requests.filter(r => r.method === 'initialize').every(r => r.header === undefined));
    assert.ok(requests.every(r => r.authenticated));
  } finally {
    bridge?.stdin.end();
    if (stopped) await stopped;
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
});
