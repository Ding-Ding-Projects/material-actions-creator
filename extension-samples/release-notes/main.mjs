const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const b = payload.build || {};
const size = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const outputs = payload.outputs || [];
const summary = [
  `## ${b.title || 'Build'}`,
  '',
  b.status === 'ready' ? 'Built on a temporary runner and downloaded automatically.' : `The build ended as **${b.status}**.`,
  '',
  '### Downloads',
  '',
  ...(outputs.length ? outputs.map((o) => `- \`${o.name.split('/').pop()}\` (${size(o.size)})`) : ['- none']),
].join('\n');
console.log(JSON.stringify({ ok: true, result: { title: `Release notes for ${outputs.length} download${outputs.length === 1 ? '' : 's'}`, summary } }));
