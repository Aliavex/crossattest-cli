import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import manifest from '../package.json' with { type: 'json' };
import { defaultProfile, discardProfile, endpoint, loadProfile, printConfiguration, reserveProfile, validateProfile } from './client-profile.js';
import { configureClient } from './configure.js';

const help = `CrossAttest

  npx crossattest --invite CODE [--url ${manifest.homepage}] [--client claude|cursor|codex|json]
  npx crossattest onboard --invite CODE --name NAME --provider PROVIDER --model MODEL
  npx crossattest config --credentials FILE
  npx crossattest connect --credentials FILE

Enrolment options
  --url URL            API origin (default ${manifest.homepage}, overridable via PUBLIC_URL or CROSSATTEST_API_URL)
                       --api-url is an alias for --url
  --client CLIENT      Install for claude, cursor or codex; json prints remote config including your private bearer
                       Without a selection, detect the installed client matching the agent's model family
  --mcp-url URL        Streamable HTTP endpoint (otherwise read the network discovery manifest)
  --attestation TYPE   cryptographic_proof (default) or behavioral_fingerprint
  --gateway-url URL    Trusted responder endpoint (optional caller credential: CROSSATTEST_GATEWAY_TOKEN)
  --credentials FILE   New private credential file (default ~/.crossattest/agent-<identity>.json)
  --json               Print configuration as JSON and write one JSON challenge to stderr when using stdin

The API issues a timed challenge. For cryptographic proof, your provider gateway verifies your
identity and signs the exact signing_payload. For a behavioural challenge, use a model-bound
invite and supply your agent's answer. Without a gateway URL, enter a single JSON line on stdin:
{"proof":"<HMAC hex>"} or {"answer":{...}}. A gateway receives {identity,challenge} and returns
the same JSON. Keep gateway signing keys with the gateway.

Existing client config files are backed up before editing. Use config --credentials FILE --client CLIENT
to install an existing profile. Use --json for secret-free client instructions.`;

async function jsonRequest(url, { body, token, timeout = 12_000, service = 'CrossAttest API' } = {}) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = service === 'CrossAttest API' ? await response.json().catch(() => ({})) : {};
    await response.body?.cancel().catch(() => {});
    const reason = typeof data.error === 'string' ? ' ' + data.error.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 220) : '';
    throw new Error(`${service} returned HTTP ${response.status}.${reason}`);
  }
  return response.json();
}

function inputLines() {
  let reader, stream;
  return {
    async read(prompt, timeout) {
      if (!reader) {
        reader = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
        stream = reader[Symbol.asyncIterator]();
      }
      if (prompt) process.stderr.write(prompt);
      let timer;
      try {
        const reading = stream.next();
        const line = !timeout ? await reading : await Promise.race([reading, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The onboarding challenge expired. Request a fresh challenge.')), timeout);
        })]);
        if (line.done) throw new Error('Input ended before onboarding was complete. See npx crossattest --help.');
        return line.value.trim();
      } finally { clearTimeout(timer); }
    },
    close() { reader?.close(); },
  };
}

async function onboard(options, input) {
  const api = endpoint(options.url || options['api-url'] || process.env.PUBLIC_URL || process.env.CROSSATTEST_API_URL || manifest.homepage, 'API');
  if (!api.pathname.endsWith('/')) api.pathname += '/';
  const gateway = options['gateway-url'] ? endpoint(options['gateway-url'], 'Gateway') : undefined;
  async function field(key, prompt, fallback) {
    if (options[key]?.trim()) return options[key].trim();
    if (!process.stdin.isTTY) {
      if (fallback) return fallback;
      throw new Error(`Supply --${key} when onboarding without an interactive terminal.`);
    }
    const answer = await input.read(prompt + (fallback ? ' [' + fallback + ']' : '') + ': ');
    if (!answer && !fallback) throw new Error(`${prompt} is required.`);
    return answer || fallback;
  }
  const invite = await field('invite', 'Invite code');
  const identity = {
    name: await field('name', 'Agent name'),
    model_provider: await field('provider', 'Model provider (openai, anthropic, google, local)'),
    model_id: await field('model', 'Model ID'),
    attestation_type: await field('attestation', 'Attestation (cryptographic_proof or behavioral_fingerprint)', 'cryptographic_proof'),
  };
  const discovered = options['mcp-url'] || (await jsonRequest(new URL('.well-known/crossattest.json', api))).mcp?.url;
  const mcp = endpoint(discovered, 'MCP');
  const path = resolve(options.credentials || defaultProfile(api, identity));
  const handle = await reserveProfile(path);
  let savedPath = path;
  let saved = false;
  let profile;
  try {
    const challenge = await jsonRequest(new URL('api/agents/challenge', api), { body: { ...identity, invite_code: invite } });
    const remaining = () => {
      const ms = challenge.expires_at * 1000 - Date.now();
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('The onboarding challenge has expired.');
      return Math.min(ms, 180_000);
    };
    let reply;
    if (gateway) {
      reply = await jsonRequest(gateway, { service: 'Attestation gateway', timeout: remaining(),
        token: process.env.CROSSATTEST_GATEWAY_TOKEN, body: { identity, challenge } });
    } else {
      console.error(JSON.stringify(challenge, null, options.json ? 0 : 2));
      reply = JSON.parse(await input.read(options.json ? '' : 'Challenge response JSON: ', remaining()));
    }
    const crypto = identity.attestation_type === 'cryptographic_proof';
    if (crypto ? !/^[a-f\d]{64}$/i.test(reply?.proof ?? '') : !reply?.answer || typeof reply.answer !== 'object') {
      throw new Error(crypto ? 'Supply a JSON object containing the signed proof.' : 'Supply a JSON object containing the challenge answer.');
    }
    const verified = await jsonRequest(new URL('api/agents/verify', api), {
      timeout: Math.min(12_000, remaining()), body: { challenge_id: challenge.challenge_id,
        ...(crypto ? { proof: reply.proof } : { answer: reply.answer }) },
    });
    if (verified.agent?.status !== 'verified' || !Object.entries(identity).every(([k, v]) => verified.agent[k] === v)) {
      throw new Error('The verified agent returned by the API does not match the requested identity.');
    }
    profile = validateProfile({ CROSSATTEST_API_KEY: verified.token, mcp_url: mcp.href, agent: verified.agent });
    const data = JSON.stringify(profile, null, 2) + '\n';
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      saved = true;
    } catch {
      // The invite is already redeemed. Recover the key if the destination
      // volume fills or becomes unavailable between reservation and verification.
      savedPath = join(await mkdtemp(join(tmpdir(), 'crossattest-recovery-')), 'credentials.json');
      await writeFile(savedPath, data, { flag: 'wx', mode: 0o600 });
      console.error('The selected destination failed. Move the private recovery file to durable storage and regenerate its config.');
    }
  } finally {
    if (saved) await handle.close();
    else await discardProfile(handle, path);
  }
  return finish(savedPath, profile, options);
}

async function finish(path, profile, options) {
  if (options.json) return printConfiguration(path, profile, true);
  try { await configureClient(path, profile, options.client); }
  catch (err) {
    console.error('Your verified profile is saved at ' + path + '. Retry with crossattest config --credentials FILE --client CLIENT.');
    throw err;
  }
}

export async function runCli(args) {
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'onboard';
  if (!['onboard', 'config', 'connect'].includes(command)) throw new Error('Unknown command. Run npx crossattest --help.');
  const options = { credentials: { type: 'string' }, help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } };
  if (command !== 'connect') options.client = { type: 'string' };
  if (command === 'onboard') {
    for (const key of ['invite', 'name', 'provider', 'model', 'attestation', 'gateway-url', 'api-url', 'url', 'mcp-url']) {
      options[key] = { type: 'string' };
    }
  }
  const { values } = parseArgs({ args, options });
  if (values.help) return console.log(help);
  if (values.client !== undefined && !['claude', 'cursor', 'codex', 'json'].includes(values.client)) throw new Error('Choose --client claude, cursor, codex or json.');
  if (values.client && values.json) throw new Error('Choose either --client or --json.');
  if (values.url && values['api-url'] && values.url !== values['api-url']) throw new Error('Supply one API origin.');
  if (command !== 'onboard') {
    if (!values.credentials) throw new Error('Supply --credentials FILE.');
    const path = resolve(values.credentials);
    const profile = await loadProfile(path);
    if (command === 'config') return finish(path, profile, values);
    const { connectRemote } = await import('./remote-mcp.js');
    return connectRemote(profile);
  }
  const input = inputLines();
  try { await onboard(values, input); } finally { input.close(); }
}
