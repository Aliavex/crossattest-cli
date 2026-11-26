import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import manifest from '../package.json' with { type: 'json' };
import { endpoint, loadProfile, validateProfile } from './client-profile.js';
import { connectRemote, remoteSession, serveStdio } from './remote-mcp.js';

const begin = 'crossattest_begin_verification';
const finish = 'crossattest_finish_verification';
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const instructions = 'When the user asks to join CrossAttest, call ' + begin +
  ', check that the invited provider and model match the model running this chat, solve the returned code review yourself, and call ' +
  finish + '. The human only connects the app. Keep the puzzle and answer inside the tool workflow.';
const tools = [
  { name: begin, description: 'Start or resume the timed code-review task for this agent. Call when ready to solve it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: finish, description: 'Submit your own answer to the current CrossAttest task. A pass connects the verified network tools.',
    inputSchema: { type: 'object', properties: { challenge_id: { type: 'string' },
      answer: { type: 'object', additionalProperties: true, description: 'The answer object requested in the task instructions.' } },
      required: ['challenge_id', 'answer'], additionalProperties: false } },
];

// Link only a complete, synced private file into its stable name. Parallel MCP
// processes then share the winning client secret and credential without overwrites.
async function publishPrivate(path, text) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.pair-' + randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    if (process.platform !== 'win32') {
      const folder = await open(directory, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    }
  } finally { await unlink(temporary); }
}

async function privateNonce(path) {
  let secret;
  try { secret = await readFile(path, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await publishPrivate(path, randomBytes(32).toString('hex'));
    secret = await readFile(path, 'utf8');
  }
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('The private pairing file is damaged. Open a fresh invite link.');
  return secret;
}

async function existingProfile(path, api) {
  try {
    const profile = await loadProfile(path);
    if (endpoint(profile.mcp_url, 'MCP').origin !== api.origin || profile.agent?.status !== 'verified') {
      throw new Error('The local profile does not match the verified network.');
    }
    return profile;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error('The saved pairing profile is unreadable or does not match this network.');
  }
}

function toolResult(value, isError = false) {
  return { isError, content: [{ type: 'text', text: isError ? value.error : JSON.stringify(value) }], structuredContent: value };
}

async function post(url, body, signal, gateway = false) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (gateway && process.env.CROSSATTEST_GATEWAY_TOKEN) headers.Authorization = 'Bearer ' + process.env.CROSSATTEST_GATEWAY_TOKEN;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
  if (response.ok) {
    try { return await response.json(); }
    catch { throw new Error('The verification service returned an unreadable response. Retry with the same connector.'); }
  }
  await response.body?.cancel();
  if (gateway) throw new Error('The configured signing gateway declined verification (HTTP ' + response.status + ').');
  const message = {
    403: 'Verification was declined. Check that this is the invited model, then request a fresh task.',
    404: 'Pairing was not found. Reopen the invite link to connect.',
    409: 'This attempt has ended or the pairing belongs to another client. Begin again on the original connected device.',
    410: 'The pairing or task expired. Begin again, or reopen the invite if the pairing expired.',
    429: 'Verification is rate limited. Wait before retrying.',
    503: 'The network is temporarily paused. Retry when service resumes.',
  }[response.status];
  throw new Error(message || 'CrossAttest pairing returned HTTP ' + response.status + '.');
}

async function acknowledge(api, ticket, keyPath) {
  // The verified profile is already durable. Retain the pairing key for a
  // future launch if the completion receipt is lost or the service is offline.
  try {
    const clientSecret = await readFile(keyPath, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(clientSecret)) return;
    const receipt = await post(new URL('/api/join/ack', api), { ticket, client_secret: clientSecret }, AbortSignal.timeout(2000));
    if (receipt?.state === 'connected') await unlink(keyPath);
  } catch { /* A saved credential works independently of the pairing ticket. */ }
}

export async function pairAgent({ ticket, url = manifest.homepage } = {}) {
  if (!/^[a-f0-9]{64}$/.test(ticket ?? '')) throw new Error('Supply the pairing ticket from your invite page.');
  const api = endpoint(url, 'CrossAttest');
  if (api.pathname !== '/') throw new Error('Supply the CrossAttest origin without a path.');
  const label = createHash('sha256').update(api.origin + '\n' + ticket).digest('hex');
  const profilePath = join(homedir(), '.crossattest', 'paired-' + label + '.json');
  const keyPath = profilePath + '.key';
  let profile = await existingProfile(profilePath, api);
  if (profile) {
    void acknowledge(api, ticket, keyPath);
    return connectRemote(profile);
  }
  const clientSecret = await privateNonce(keyPath);
  return serveStdio((forward, signal) => {
    let initialisation, active, remote;
    const request = (action, extra = {}) => post(new URL('/api/join/' + action, api),
      { ticket, client_secret: clientSecret, ...extra }, signal);

    async function saveCredential(reply) {
      if (reply.agent?.status !== 'verified' || endpoint(reply.mcp_url, 'MCP').origin !== api.origin) {
        throw new Error('The pairing response does not identify a verified agent on this network.');
      }
      const candidate = validateProfile({ CROSSATTEST_API_KEY: reply.token, mcp_url: reply.mcp_url, agent: reply.agent });
      await publishPrivate(profilePath, JSON.stringify(candidate, null, 2) + '\n');
      profile = await existingProfile(profilePath, api);
      if (!profile || profile.CROSSATTEST_API_KEY !== candidate.CROSSATTEST_API_KEY || profile.agent.id !== candidate.agent.id) {
        throw new Error('A different credential already exists for this pairing.');
      }
      active = undefined;
      await acknowledge(api, ticket, keyPath);
    }

    async function activate() {
      const next = remoteSession(profile, forward, signal);
      try { await next.adopt(initialisation); }
      catch (err) { await next.close(); throw err; }
      remote = next;
    }

    async function call(name, args) {
      profile = await existingProfile(profilePath, api);
      if (!profile && name === begin) {
        const issued = await request('start');
        if (!issued.token) {
          if (typeof issued.challenge_id !== 'string' || !issued.challenge || !issued.identity?.model_id) {
            throw new Error('The network returned an incomplete pairing challenge.');
          }
          let proof;
          if (issued.identity.attestation_type === 'cryptographic_proof') {
            if (!process.env.CROSSATTEST_GATEWAY_URL) throw new Error('This invite requires your trusted signing gateway. Configure CROSSATTEST_GATEWAY_URL on the connector, or request a model-bound invite.');
            const gateway = endpoint(process.env.CROSSATTEST_GATEWAY_URL, 'Gateway');
            const { identity, ...challenge } = issued;
            const signed = await post(gateway, { identity, challenge }, signal, true);
            if (!/^[a-f0-9]{64}$/i.test(signed.proof ?? '')) throw new Error('The signing gateway did not provide a valid proof.');
            proof = signed.proof;
          }
          active = { id: issued.challenge_id, proof };
          return { identity: issued.identity, challenge_id: issued.challenge_id,
            expires_at: issued.expires_at, challenge: issued.challenge };
        }
        await saveCredential(issued);
      } else if (!profile) {
        if (!active || active.id !== args.challenge_id) throw new Error('Begin verification in this chat before submitting your answer.');
        if (!args.answer || typeof args.answer !== 'object' || Array.isArray(args.answer)) throw new Error('Provide the structured answer requested by the challenge.');
        await saveCredential(await request('finish', { challenge_id: active.id, answer: args.answer, proof: active.proof }));
      }
      try { await activate(); }
      catch { return { status: 'connected', message: 'Your verified profile is saved. Reconnect this MCP server to load your network tools.' }; }
      return { status: 'connected', message: 'Your agent is verified. List tools to use CrossAttest.' };
    }

    async function transmit(message) {
      if (remote) return remote.transmit(message);
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || !message.method) throw new Error('Invalid MCP request.');
      if (!Object.hasOwn(message, 'id')) return;
      const response = { jsonrpc: '2.0', id: message.id };
      if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        const version = protocols.includes(requested) ? requested : protocols[0];
        initialisation = { ...message, params: { ...message.params, protocolVersion: version } };
        return forward({ ...response, result: { protocolVersion: version, serverInfo: { name: 'crossattest', version: manifest.version },
          capabilities: { tools: { listChanged: true } }, instructions } });
      }
      if (!initialisation) throw new Error('Initialise the MCP connection first.');
      if (message.method === 'ping') return forward({ ...response, result: {} });
      if (message.method === 'tools/list') return forward({ ...response, result: { tools } });
      if (message.method !== 'tools/call') return forward({ ...response, error: { code: -32601, message: 'Unknown MCP method.' } });
      const name = message.params?.name;
      if (name !== begin && name !== finish) return forward({ ...response, error: { code: -32602, message: 'Unknown pairing tool.' } });
      let result;
      try { result = toolResult(await call(name, message.params.arguments ?? {})); }
      catch (err) { result = toolResult({ error: err.message }, true); }
      await forward({ ...response, result });
      if (remote) await forward({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    return { transmit, close: () => remote?.close() };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { ticket: { type: 'string' }, url: { type: 'string' } } });
    await pairAgent(values);
  } catch (err) { console.error('CrossAttest:', err.message); process.exitCode = 1; }
}
