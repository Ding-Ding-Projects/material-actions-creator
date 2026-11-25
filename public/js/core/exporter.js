// Exports any list of records in every faithful format we can produce locally.
// Formats that cannot carry nesting say so (lossy) before the file is written.
export const FORMATS = [
  { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', lossy: false },
  { id: 'ndjson', label: 'NDJSON', ext: 'ndjson', mime: 'application/x-ndjson', lossy: false },
  { id: 'yaml', label: 'YAML', ext: 'yaml', mime: 'text/yaml', lossy: false },
  { id: 'xml', label: 'XML', ext: 'xml', mime: 'application/xml', lossy: false },
  { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv', lossy: true },
  { id: 'tsv', label: 'TSV', ext: 'tsv', mime: 'text/tab-separated-values', lossy: true },
  { id: 'md', label: 'Markdown table', ext: 'md', mime: 'text/markdown', lossy: true },
  { id: 'html', label: 'HTML table', ext: 'html', mime: 'text/html', lossy: true },
  { id: 'txt', label: 'Plain text', ext: 'txt', mime: 'text/plain', lossy: true },
];

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function columns(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}

const csvCell = (v, sep) => {
  const s = v == null ? '' : String(v);
  return new RegExp(`["\\n\\r${sep === '\t' ? '\\t' : sep}]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const htmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xmlName = (k) => (/^[A-Za-z_][\w.-]*$/.test(k) ? k : `field_${k.replace(/[^\w.-]/g, '_')}`);

function yaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((v) => `\n${pad}- ${yaml(v, indent + 1).replace(/^\n\s*/, '')}`).join('');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys.map((k) => `\n${pad}${JSON.stringify(k)}: ${yaml(value[k], indent + 1)}`).join('');
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function xml(value, name) {
  const tag = xmlName(name);
  if (value === null || value === undefined) return `<${tag}/>`;
  if (Array.isArray(value)) return `<${tag}>${value.map((v) => xml(v, 'item')).join('')}</${tag}>`;
  if (typeof value === 'object') return `<${tag}>${Object.entries(value).map(([k, v]) => xml(v, k)).join('')}</${tag}>`;
  return `<${tag}>${htmlEsc(value)}</${tag}>`;
}

export function serialize(rows, format, { title = 'export' } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  switch (format) {
    case 'json': return JSON.stringify(list, null, 2);
    case 'ndjson': return list.map((r) => JSON.stringify(r)).join('\n') + '\n';
    case 'yaml': return `# ${title}${yaml(list)}\n`;
    case 'xml': return `<?xml version="1.0" encoding="UTF-8"?>\n${xml(list, title.replace(/\W+/g, '_') || 'export')}\n`;
  }
  const flat = list.map((r) => flatten(r));
  const cols = columns(flat);
  switch (format) {
    case 'csv': return [cols.map((c) => csvCell(c, ',')).join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c], ',')).join(','))].join('\r\n') + '\r\n';
    case 'tsv': return [cols.join('\t'), ...flat.map((r) => cols.map((c) => csvCell(r[c], '\t')).join('\t'))].join('\n') + '\n';
    case 'md': return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...flat.map((r) => `| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n') + '\n';
    case 'html': return `<!doctype html><meta charset="utf-8"><title>${htmlEsc(title)}</title><table border="1"><thead><tr>${cols.map((c) => `<th>${htmlEsc(c)}</th>`).join('')}</tr></thead><tbody>${flat.map((r) => `<tr>${cols.map((c) => `<td>${htmlEsc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>\n`;
    case 'txt': return flat.map((r) => cols.map((c) => `${c}: ${r[c] ?? ''}`).join('\n')).join('\n\n') + '\n';
    default: throw new Error(`Unknown format ${format}`);
  }
}

export function download(rows, format, title = 'export') {
  const f = FORMATS.find((x) => x.id === format);
  const text = serialize(rows, format, { title });
  const blob = new Blob([text], { type: `${f.mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.${f.ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return a.download;
}
