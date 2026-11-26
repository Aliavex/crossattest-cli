import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/crossattest.js', import.meta.url));
const firstTool = 'crossattest_begin_verification';
const lastTool = 'crossattest_finish_verification';

for (const signed of [false, true]) {
  test('pairing from an MCP chat with ' + (signed ? 'gateway identity and interrupted delivery' : 'a model-bound invite'), { timeout: 20_000 }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'crossattest-join-bridge-'));
    const ticket = randomBytes(32).toString('hex');
    const token = 'xattest_live_' + randomBytes(32).toString('base64url');
    const proof = randomBytes(32).toString('hex');
    const identity = { name: 'Test model', model_provider: 'xai', model_id: 'fixture-model',
      attestation_type: signed ? 'cryptographic_proof' : 'behavioral_fingerprint' };
    const challengeId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const answer = { finding: 'fixture' };
    let url, redeemed = false, acknowledged = false, starts = 0, submissions = 0, acks = 0, clientSecret;
    let releaseAck, receivedAck;
    const allowAck = new Promise(resolve => { releaseAck = resolve; });
    const completedAck = new Promise(resolve => { receivedAck = resolve; });
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      const send = data => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const credential = () => ({ token, agent: { ...identity, id: 'paired-agent', status: 'verified' }, mcp_url: url + '/mcp' });
      if (req.url.startsWith('/api/join/')) {
        assert.equal(body.ticket, ticket);
        assert.match(body.client_secret, /^[a-f0-9]{64}$/);
        clientSecret ??= body.client_secret;
        assert.equal(body.client_secret, clientSecret);
      }
      switch (req.url) {
        case '/api/join/start':
          starts++;
          return send(redeemed ? credential() : { identity, challenge_id: challengeId,
            challenge: { instructions: 'Fixture question' }, expires_at: expiresAt,
            ...(signed ? { signing_payload: 'signed fixture containing private invite value' } : {}) });
        case '/gateway':
          assert.equal(req.headers.authorization, 'Bearer private-gateway-key');
          assert.equal(body.challenge.signing_payload, 'signed fixture containing private invite value');
          return send({ proof });
        case '/api/join/finish':
          submissions++;
          assert.equal(body.challenge_id, challengeId);
          assert.deepEqual(body.answer, answer);
          assert.equal(body.proof, signed ? proof : undefined);
          redeemed = true;
          if (signed) return res.destroy();
          return send(credential());
        case '/api/join/ack':
          acks++;
          if (!signed && acks === 1) return res.destroy();
          if (!signed) await allowAck;
          acknowledged = true;
          receivedAck();
          return send({ state: 'connected' });
        case '/mcp':
          assert.equal(req.headers.authorization, 'Bearer ' + token);
          if (body.method === 'initialize') return send({ jsonrpc: '2.0', id: body.id, result: {
            protocolVersion: body.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } } });
          if (body.method === 'tools/list') return send({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'crossattest_read_feed' }] } });
          return res.writeHead(202).end();
        default: return res.writeHead(404).end();
      }
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    url = 'http://127.0.0.1:' + upstream.address().port;
    const processes = [];
    t.after(async () => {
      releaseAck();
      for (const { child, closed } of processes) { child.stdin.end(); await closed; }
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    });

    function launch() {
      const child = spawn(process.execPath, [cli, 'pair', '--ticket', ticket, '--url', url], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CROSSATTEST_GATEWAY_URL: signed ? url + '/gateway' : '',
          CROSSATTEST_GATEWAY_TOKEN: 'private-gateway-key' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = once(child, 'close');
      processes.push({ child, closed });
      const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      let id = 0;
      async function request(method, params = {}) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
        for (;;) {
          const frame = await reader.next();
          assert.equal(frame.done, false, stderr);
          for (const secret of [token, proof, ticket, 'private-gateway-key', 'private invite value', clientSecret].filter(Boolean)) {
            assert.ok(!frame.value.includes(secret) && !stderr.includes(secret), 'Public protocol and logs must not contain a secret.');
          }
          const response = JSON.parse(frame.value);
          if (response.id !== undefined) { assert.equal(response.id, id); return response.result; }
          assert.equal(response.method, 'notifications/tools/list_changed');
        }
      }
      return { request, async close() { child.stdin.end(); await closed; },
        init: () => request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }),
        tool: (name, args = {}) => request('tools/call', { name, arguments: args }) };
    }
    let bridge = launch();
    const anotherClient = signed ? null : launch();
    await Promise.all([bridge.init(), anotherClient?.init()]);
    assert.deepEqual((await bridge.request('tools/list')).tools.map(tool => tool.name), [firstTool, lastTool]);
    assert.equal(starts, 0, 'Opening the connector does not start the timer.');
    const [task, concurrent] = await Promise.all([bridge.tool(firstTool), anotherClient?.tool(firstTool)]);
    if (anotherClient) assert.deepEqual(concurrent.structuredContent, task.structuredContent);
    assert.equal(task.structuredContent.challenge.instructions, 'Fixture question');
    assert.deepEqual(task.structuredContent.identity, identity);
    const verdict = await bridge.tool(lastTool, { challenge_id: challengeId, answer });
    if (signed) {
      assert.equal(verdict.isError, true);
      await bridge.close();
      bridge = launch();
      await bridge.init();
      assert.equal((await bridge.tool(firstTool)).structuredContent.status, 'connected');
    } else assert.equal(verdict.structuredContent.status, 'connected');
    assert.equal(submissions, 1);
    assert.equal(acknowledged, signed);
    assert.equal((await bridge.request('tools/list')).tools[0].name, 'crossattest_read_feed');
    const path = (await readdir(join(home, '.crossattest'))).find(name => name.endsWith('.json'));
    assert.equal(JSON.parse(await readFile(join(home, '.crossattest', path))).CROSSATTEST_API_KEY, token);
    const reopened = launch();
    await reopened.init();
    assert.equal((await reopened.request('tools/list')).tools[0].name, 'crossattest_read_feed');
    releaseAck(); // The verified MCP session can run while a lost receipt is being retried.
    await completedAck;
    assert.equal(acknowledged, true);
    assert.equal(acks, signed ? 1 : 2);
    assert.equal(starts, 2);
  });
}
