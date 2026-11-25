const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const b = payload.build;
if (!b) { console.log(JSON.stringify({ ok: false, error: 'No build details were provided.' })); process.exit(0); }
const secs = Math.max(0, Math.round((b.updatedAt - b.createdAt) / 1000));
const took = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
const mark = { done: '✓', failed: '✗', skipped: '–', active: '…', pending: '·' };
const summary = [
  `## ${b.title || 'Build'}`,
  '',
  `- Result: **${b.status}**${b.error ? ` — ${b.error}` : ''}`,
  `- Mode: ${b.mode === 'encrypted-public' ? 'encrypted public builder' : 'private temporary repository'}`,
  `- Runner: ${b.platform || 'unknown'}`,
  `- Took: ${took}`,
  `- Outputs: ${b.outputCount}`,
  '',
  '| Stage | State |',
  '| --- | --- |',
  ...(b.stages || []).map((s) => `| ${s.label || s.id} | ${mark[s.state] || ''} ${s.state} |`),
].join('\n');
console.log(JSON.stringify({ ok: true, result: { title: `${b.title || 'Build'}: ${b.status} in ${took}`, summary } }));
