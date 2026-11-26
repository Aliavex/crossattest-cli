// Keep unrelated TOML (including comments, multiline instructions and nested
// permission tables) byte-for-byte. Only transport keys belong to this installer.
const transportKeys = new Set(['command', 'args', 'cwd', 'env', 'env_vars', 'url', 'http_headers', 'env_http_headers', 'bearer_token_env_var']);

function* syntax(source) {
  let quote = '', comment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
    } else if (quote) {
      if (char === '\\' && quote[0] === '"') i++;
      else if (source.startsWith(quote, i)) {
        i += quote.length - 1;
        if (quote.length === 3) while (source[i + 1] === quote[0]) i++;
        quote = '';
      }
      continue;
    } else if (char === '"' || char === "'") {
      quote = source.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += quote.length - 1;
      continue;
    } else if (char === '#') { comment = true; continue; }
    yield [i, char];
  }
  if (quote) throw new Error('Unterminated string in Codex TOML.');
}

function statements(source) {
  const parts = [];
  let start = 0, depth = 0;
  for (const [i, char] of syntax(source)) {
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    if (depth < 0) throw new Error('Unbalanced Codex TOML. Correct the config and retry.');
    if (char === '\n' && !depth) {
      parts.push(source.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (depth) throw new Error('Unterminated value in Codex TOML.');
  if (start < source.length) parts.push(source.slice(start));
  return parts;
}

// An inline table seals its keys in TOML. Expand only the inline ancestor of
// the target server into dotted assignments, preserving each sibling value.
function expandInline(prefix, raw, newline) {
  const value = raw.trimStart();
  if (!value.startsWith('{')) throw new Error('Expected an MCP server table in Codex config.');
  let depth = 0, start = 1;
  const lines = [];
  for (const [i, char] of syntax(value)) {
    if (char === '[' || char === '{') depth++;
    if (depth === 1 && (char === ',' || char === '}')) {
      const member = value.slice(start, i).trim();
      const leading = /^(?:(?:#[^\n]*\n)|\s)*/.exec(member)[0];
      if (leading.trim()) lines.push(leading);
      const field = member.slice(leading.length);
      if (field && !field.startsWith('#')) lines.push(prefix + '.' + field + newline);
      else if (field) lines.push(field + newline);
      start = i + 1;
      if (char === '}') {
        const tail = value.slice(start).trim();
        if (tail && !tail.startsWith('#')) throw new Error('Unexpected text after an MCP inline table.');
        if (tail) lines.push(tail + newline);
        return lines;
      }
    }
    if (char === ']' || char === '}') depth--;
  }
  throw new Error('Unterminated MCP inline table.');
}

// TOML keys can be bare, quoted or dotted. Nested permissions may themselves
// contain dots inside quoted tool names.
function keys(input) {
  const parts = [];
  const token = /\s*("(?:\\.|[^"\\])*"|'[^']*'|[a-zA-Z0-9_-]+)\s*/y;
  let i = 0;
  while (i < input.length) {
    token.lastIndex = i;
    const match = token.exec(input);
    if (!match) return [];
    const raw = match[1];
    parts.push(raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw);
    i = token.lastIndex;
    if (i < input.length && input[i++] !== '.') return [];
  }
  return parts;
}

export function updateCodex(source, profile) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const settings = (prefix = '') => [
    prefix + 'url = ' + JSON.stringify(profile.mcp_url),
    prefix + 'http_headers = { Authorization = ' + JSON.stringify('Bearer ' + profile.CROSSATTEST_API_KEY) + ' }',
  ].join(newline) + newline;
  let section = [], added = false;
  const lines = [];
  const pending = statements(source);
  for (let i = 0; i < pending.length; i++) {
    const statement = pending[i];
    const text = statement.trimStart();
    const table = /^\[(\[?)(.+?)\](\]?)\s*(?:#[^\r\n]*)?$/s.exec(text.trimEnd());
    if (table) {
      if (Boolean(table[1]) !== Boolean(table[3])) throw new Error('Invalid Codex TOML table header.');
      section = keys(table[2]);
      if (section[0] === 'mcp_servers' && section[1] === 'crossattest') {
        if (section.length === 2) {
          if (table[1]) throw new Error('Expected a single CrossAttest MCP configuration table.');
          if (added) throw new Error('Duplicate CrossAttest tables in Codex config.');
          lines.push(statement.trimEnd() + newline, settings());
          added = true;
          continue;
        }
        if (transportKeys.has(section[2])) continue;
      }
      lines.push(statement);
      continue;
    }
    if (section[0] === 'mcp_servers' && section[1] === 'crossattest' && transportKeys.has(section[2])) continue;
    const assignment = /^((?:"(?:\\.|[^"\\])*"|'[^']*'|[a-zA-Z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[a-zA-Z0-9_-]+))*)\s*=/.exec(text);
    if (assignment) {
      const path = [...section, ...keys(assignment[1])];
      if (path[0] === 'mcp_servers') {
        if (path.length === 1 || (path[1] === 'crossattest' && path.length === 2)) {
          const children = expandInline(assignment[1], text.slice(assignment[0].length), newline);
          pending.splice(i + 1, 0, ...children);
          if (!added) {
            lines.push(settings(section.length ? 'crossattest.' : 'mcp_servers.crossattest.'));
            added = true;
          }
          continue;
        }
        if (path[1] === 'crossattest') {
          // TOML forbids declaring a table again after defining it with
          // dotted keys. Write the connection in the existing key style.
          if (section.length < 2 && !added) {
            lines.push(settings(section.length ? 'crossattest.' : 'mcp_servers.crossattest.'));
            added = true;
          }
          if (transportKeys.has(path[2])) continue;
        }
      }
    }
    lines.push(statement);
  }
  const result = lines.join('');
  return added ? result : result + (result && !result.endsWith('\n') ? newline : '') +
    (result ? newline : '') + '[mcp_servers.crossattest]' + newline + settings();
}
