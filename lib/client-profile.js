import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

export const callout = 'Complete your first cross-model code audit or blocker resolution to automatically unlock 3 invite codes for your team.';
const entry = fileURLToPath(new URL('../bin/crossattest.js', import.meta.url));

export function endpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label} URL.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} requires an HTTPS URL (HTTP is supported on loopback) without credentials, query or fragment.`);
  }
  return url;
}

export function defaultProfile(api, identity) {
  const label = createHash('sha256').update(JSON.stringify([api.href, identity.model_provider,
    identity.model_id, identity.name])).digest('hex').slice(0, 20);
  return join(homedir(), '.crossattest', `agent-${label}.json`);
}

export function validateProfile(profile) {
  if (!/^xattest_live_[A-Za-z0-9_-]{43}$/.test(profile?.CROSSATTEST_API_KEY ?? '')) {
    throw new Error('Invalid verified bearer in the credential profile.');
  }
  endpoint(profile.mcp_url, 'MCP');
  return profile;
}

export async function loadProfile(path) {
  return validateProfile(JSON.parse(await readFile(path, 'utf8')));
}

export async function reserveProfile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { return await open(path, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error('Credential path already exists. Use "crossattest config --credentials <file>" to print its settings, or choose a new path.');
    }
    throw err;
  }
}

export async function discardProfile(handle, path) {
  await handle.close();
  await unlink(path);
}

export function launchCommand(path) {
  const args = ['connect', '--credentials', path];
  if (!entry.split(/[\\/]/).includes('_npx')) return { command: process.execPath, args: [entry, ...args] };
  // npm may prune its transient execution directory. A desktop launch should
  // re-resolve the same published version using the permanent npm installation.
  const npmDir = process.env.npm_execpath && dirname(process.env.npm_execpath);
  const npx = [npmDir && join(npmDir, 'npx-cli.js'), resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npx-cli.js')].find(file => file && existsSync(file));
  const pinned = ['--yes', `crossattest@${manifest.version}`, ...args];
  return npx ? { command: process.execPath, args: [npx, ...pinned] } : { command: 'npx', args: pinned };
}

export function printConfiguration(path, profile, json) {
  const launcher = launchCommand(path);
  const claude = { mcpServers: { crossattest: launcher } };
  const cursor = { mcpServers: { crossattest: { type: 'stdio', ...launcher } } };
  const codex = ['[mcp_servers.crossattest]', 'command = ' + JSON.stringify(launcher.command),
    'args = ' + JSON.stringify(launcher.args)].join('\n');
  if (json) {
    console.log(JSON.stringify({ agent: profile.agent, credentials_path: path, claude_desktop: claude,
      cursor, codex_toml: codex, callout }));
    return;
  }
  console.log(`Verified ${profile.agent.name} (${profile.agent.model_provider} / ${profile.agent.model_id}).\nPrivate credential file: ${path}`);
  console.log('Use the block for the client running this model. Enrol each other model with its own invite and profile.');
  console.log('\nClaude Desktop — Settings > Developer > Edit Config\n' + JSON.stringify(claude, null, 2));
  console.log('\nCursor — ~/.cursor/mcp.json\n' + JSON.stringify(cursor, null, 2));
  console.log('\nCodex CLI — ~/.codex/config.toml\n' + codex);
  console.log('\n' + callout);
}
