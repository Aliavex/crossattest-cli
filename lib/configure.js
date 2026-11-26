import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { callout, launchCommand } from './client-profile.js';
import { updateCodex } from './codex-config.js';
import { updateJson } from './json-config.js';

function locations() {
  const home = homedir();
  const desktop = process.platform === 'win32' ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    { client: 'claude', path: join(home, '.claude.json'), directory: join(home, '.claude') },
    { client: 'claude', desktop: true, path: join(desktop, 'Claude', 'claude_desktop_config.json') },
    { client: 'cursor', path: join(home, '.cursor', 'mcp.json') },
    { client: 'codex', path: join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml') },
  ];
}

async function readConfig(path) {
  try { return await readFile(path); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
}

async function updateFile(file, build) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // Preserve a dotfile manager's symlink when replacing the underlying file.
  const path = existsSync(file) ? await realpath(file) : resolve(file);
  const lock = path + '.crossattest.lock';
  const lockFile = await open(lock, 'wx', 0o600).catch(err => {
    if (err.code === 'EEXIST') throw new Error('Another configuration update holds ' + lock + '.');
    throw err;
  });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const before = await readConfig(path);
    const after = build(before?.toString('utf8') || '');
    if (before?.equals(Buffer.from(after))) return;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(after); await handle.sync(); }
    finally { await handle.close(); }
    let backup;
    if (before) {
      backup = path + '.crossattest-' + randomUUID() + '.bak';
      await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
      if (!before.equals((await readConfig(path)) ?? Buffer.alloc(0))) throw new Error('Client configuration changed while installing. Retry.');
      await rename(temporary, path);
    } else {
      // A hard link installs a complete file without replacing a concurrent creation.
      await link(temporary, path);
    }
    return backup;
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await lockFile.close(); await rm(lock, { force: true }); }
  }
}

export async function configureClient(profilePath, profile, client) {
  const remote = { type: 'http', url: profile.mcp_url, headers: { Authorization: 'Bearer ' + profile.CROSSATTEST_API_KEY } };
  if (client === 'json') {
    console.log(JSON.stringify({ mcpServers: { crossattest: remote } }, null, 2));
    console.error('This configuration contains your private agent credential.\n' + callout);
    return;
  }
  const choices = locations();
  const known = choices.filter(choice => existsSync(choice.path));
  for (const choice of choices) {
    if (!known.some(item => item.client === choice.client) && existsSync(choice.directory || dirname(choice.path))) known.push(choice);
  }
  let target;
  if (client) {
    target = known.find(choice => choice.client === client) || choices.find(choice => choice.client === client);
  } else {
    const preferred = { openai: 'codex', anthropic: 'claude' }[profile.agent?.model_provider];
    target = known.find(choice => choice.client === preferred) || (known.length === 1 ? known[0] : undefined);
  }
  if (!target) {
    // The portable stdio form points to the private profile; auto-detection
    // should never print a plaintext key or choose among ambiguous identities.
    console.log(JSON.stringify({ mcpServers: { crossattest: launchCommand(profilePath) } }, null, 2));
    console.error('Private profile: ' + profilePath + '\nChoose a client with config --credentials FILE --client CLIENT.\n' + callout);
    return;
  }
  const entry = target.desktop ? launchCommand(profilePath) : remote;
  const backup = await updateFile(target.path, source => target.client === 'codex' ? updateCodex(source, profile) : updateJson(source, entry));
  console.log('CrossAttest configured in ' + target.path + '.');
  if (backup) console.log('Prior configuration backed up to ' + backup);
  console.log('Private profile: ' + profilePath + '\n' + callout);
}
