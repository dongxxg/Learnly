// lib/yaml-parser.js — Minimal YAML Parser (read-only, for harness-rules.yaml)

export function parseYaml(text) {
  const lines = text.split('\n');
  const root = {};
  // Stack entries: { obj, indent, currentKey }
  // For list items, obj is the array element being built
  const stack = [{ obj: root, indent: -1 }];

  function parent() { return stack[stack.length - 1]; }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;

    const indent = raw.search(/\S/);
    let content = raw.trim();

    // Strip inline comment (YAML spec: # must be preceded by whitespace)
    const commentIdx = content.search(/\s+#/);
    if (commentIdx >= 0) content = content.slice(0, commentIdx).trim();
    if (content === '') continue;

    // Pop stack until we find an ancestor with smaller indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const p = parent();

    if (content.startsWith('- ')) {
      // List item — walk up the stack to find the key this list belongs to
      const itemContent = content.slice(2);

      let listKey = undefined;
      let listOwner = undefined;
      for (let si = stack.length - 1; si >= 0; si--) {
        if (stack[si].currentKey !== undefined) {
          listKey = stack[si].currentKey;
          listOwner = stack[si].obj;
          break;
        }
      }

      const colonIdx = itemContent.indexOf(':');
      if (colonIdx !== -1) {
        // List item with nested object
        const newItem = {};
        const itemKey = itemContent.slice(0, colonIdx).trim();
        const itemVal = itemContent.slice(colonIdx + 1).trim();
        newItem[itemKey] = parseScalar(itemVal);

        if (listKey !== undefined) {
          if (!Array.isArray(listOwner[listKey])) listOwner[listKey] = [];
          listOwner[listKey].push(newItem);
        }
        // Push so subsequent key:value lines at deeper indent go into this item
        stack.push({ obj: newItem, indent, currentKey: undefined });
      } else {
        // Simple scalar list item
        if (listKey !== undefined) {
          if (!Array.isArray(listOwner[listKey])) listOwner[listKey] = [];
          listOwner[listKey].push(parseScalar(itemContent));
        }
      }
      continue;
    }

    // Key-value line
    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    const afterColon = content.slice(colonIdx + 1).trim();

    if (afterColon === '' || afterColon === '|' || afterColon === '>') {
      // New nesting level — parent remembers the key for list item routing
      p.obj[key] = {};
      p.currentKey = key;
      stack.push({ obj: p.obj[key], indent, currentKey: undefined });
    } else {
      p.obj[key] = parseScalar(afterColon);
      p.currentKey = key;
    }
  }
  return root;
}

export function parseScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  // Inline array like [architect, developer]
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(v => parseScalar(v.trim()));
  }

  return s;
}
