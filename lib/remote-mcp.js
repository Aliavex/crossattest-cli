import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

// Desktop stdio carries one JSON-RPC message per line. Forward each message to
// the issuing network, retaining its negotiated transport session and version.
export async function connectRemote(profile) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const controller = new AbortController();
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + profile.CROSSATTEST_API_KEY,
  };
  let handshake;
  async function forward(message) {
    if (!process.stdout.write(JSON.stringify(message) + '\n')) await once(process.stdout, 'drain');
  }

  async function receive(response, deliver = forward) {
    if (response.status === 202 || response.status === 204) return;
    const mime = response.headers.get('content-type')?.split(';')[0].trim();
    if (mime === 'application/json') return deliver(await response.json());
    if (mime !== 'text/event-stream' || !response.body) throw new Error('Unexpected MCP response format.');
    const events = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
    let data = [];
    for await (const line of events) {
      if (!line) {
        const payload = data.join('\n');
        if (payload.trim()) await deliver(JSON.parse(payload));
        data = [];
      } else if (line === 'data' || line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  async function post(message, checkSession = false) {
    const response = await fetch(profile.mcp_url, {
      method: 'POST', headers, body: JSON.stringify(message), redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    });
    if (response.ok) return response;
    if (checkSession && response.status === 404 && headers['Mcp-Session-Id'] && handshake) {
      const failure = await response.json().catch(() => null);
      // This error is generated before dispatch. Other failures can occur after
      // a mutating tool completed; replaying those could duplicate a post.
      if (failure?.jsonrpc === '2.0' && failure.id === (message.id ?? null) &&
          failure.error?.code === -32000 && failure.error.message === 'Unknown MCP session for this agent.') return null;
    } else await response.body?.cancel();
    throw new Error('CrossAttest MCP returned HTTP ' + response.status + '.');
  }

  async function initialise(message, recovering = false) {
    const previousVersion = headers['MCP-Protocol-Version'];
    delete headers['Mcp-Session-Id'];
    delete headers['MCP-Protocol-Version'];
    handshake = undefined;
    const response = await post(message);
    let negotiated;
    await receive(response, async frame => {
      if (frame.id === message.id && frame.result?.protocolVersion) negotiated = frame.result.protocolVersion;
      if (!recovering) await forward(frame);
    });
    if (recovering && (!negotiated || negotiated !== previousVersion)) throw new Error('Remote protocol changed. Reconnect your MCP client.');
    if (negotiated) {
      headers['MCP-Protocol-Version'] = negotiated;
      const session = response.headers.get('mcp-session-id');
      if (session) headers['Mcp-Session-Id'] = session;
      handshake = { ...message, params: { ...message.params, protocolVersion: negotiated } };
    }
  }

  async function transmit(message) {
    if (message.method === 'initialize') return initialise(message);
    let response = await post(message, true);
    if (!response) {
      await initialise(handshake, true);
      if (message.method !== 'notifications/initialized') {
        await receive(await post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      }
      response = await post(message);
    }
    await receive(response);
  }
  function stop() { controller.abort(); input.close(); }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
        await transmit(message);
      } catch (err) {
        if (controller.signal.aborted) break;
        if (!message || Object.hasOwn(message, 'id')) {
          await forward({ jsonrpc: '2.0', id: message?.id ?? null, error: {
            code: message ? -32000 : -32700, message: message ? err.message : 'Invalid JSON-RPC message.',
          } });
        }
      }
    }
  } finally {
    stop();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (headers['Mcp-Session-Id']) {
      await fetch(profile.mcp_url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(1500) })
        .then(response => response.body?.cancel()).catch(() => {});
    }
  }
}
