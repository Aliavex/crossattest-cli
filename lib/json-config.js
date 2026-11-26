
// Locate a member in a validated JSON object while retaining source offsets.
// This lets an install preserve other entries, comments and formatting.
function member(tokens, object, key) {
  let found;
  for (let i = object + 1; tokens[i].text !== '}';) {
    const name = JSON.parse(tokens[i].text);
    const start = i + 2;
    let end = start, depth = 0;
    do {
      const text = tokens[end++].text;
      if (text === '{' || text === '[') depth++;
      else if (text === '}' || text === ']') depth--;
    } while (depth > 0);
    if (name === key) {
      if (found) throw new Error('Duplicate ' + key + ' keys in client configuration.');
      found = { start, end: end - 1 };
    }
    i = end + Number(tokens[end].text === ',');
  }
  return found;
}

export function updateJson(source, entry) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (!source.trim()) return JSON.stringify({ mcpServers: { crossattest: entry } }, null, 2) + newline;
  const lexer = /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\s+|[{}\[\],:]|[^{}\[\],:\s"/]+|./gs;
  const tokens = [];
  for (const token of source.matchAll(lexer)) {
    if (!token[0].trim() || token[0].startsWith('//') || token[0].startsWith('/*')) continue;
    tokens.push({ text: token[0], start: token.index, end: token.index + token[0].length });
  }
  let config;
  try {
    // Cursor accepts comments and trailing commas. Strings containing a comment
    // marker remain a single token, including quoted HTTPS URLs.
    const json = tokens.filter((token, i) => token.text !== ',' || !['}', ']'].includes(tokens[i+1]?.text));
    config = JSON.parse(json.map(token => token.text).join(' '));
  } catch { throw new Error('Invalid JSON in the client configuration. Correct it and retry.'); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || ('mcpServers' in config && !object(config.mcpServers))) {
    throw new Error('Expected a JSON client configuration object containing an mcpServers object.');
  }
  const servers = member(tokens, 0, 'mcpServers');
  const target = servers && member(tokens, servers.start, 'crossattest');
  const existing = config.mcpServers?.crossattest;
  if (target && object(existing)) {
    // Keep client-specific controls, e.g. auto-approved tools, when the
    // connection switches between an old stdio launcher and native HTTP.
    const retained = { ...existing };
    for (const key of ['type', 'url', 'headers', 'command', 'args', 'env', 'envFile', 'cwd', 'auth', 'oauth']) delete retained[key];
    entry = { ...retained, ...entry };
    if (JSON.stringify(existing) === JSON.stringify(entry)) return source;
  }
  const parent = servers?.start ?? 0;
  const anchor = target ? tokens[target.start].start : tokens[parent].end;
  const lineStart = source.lastIndexOf('\n', anchor - 1) + 1;
  const indent = /^[\t ]*/.exec(source.slice(lineStart))[0] + (target ? '' : '  ');
  const value = JSON.stringify(servers ? entry : { crossattest: entry }, null, 2).replaceAll('\n', newline + indent);
  if (target) return source.slice(0, anchor) + value + source.slice(tokens[target.end].end);
  const key = servers ? 'crossattest' : 'mcpServers';
  const comma = tokens[parent + 1].text === '}' ? '' : ',';
  return source.slice(0, anchor) + newline + indent + JSON.stringify(key) + ': ' + value + comma + newline + source.slice(anchor);
}
