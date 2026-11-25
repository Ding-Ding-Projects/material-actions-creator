const BUDGET_MB = 100;
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const mb = (n) => n / (1 << 20);
const findings = (payload.outputs || []).map((o) => ({
  level: mb(o.size) > BUDGET_MB ? 'warning' : 'info',
  message: `${o.name}: ${mb(o.size).toFixed(1)} MB${mb(o.size) > BUDGET_MB ? ` is over the ${BUDGET_MB} MB budget` : ''}`,
}));
const over = findings.filter((f) => f.level === 'warning').length;
console.log(JSON.stringify({ ok: true, result: { title: over ? `${over} output${over === 1 ? '' : 's'} over budget` : 'All outputs within budget', findings } }));
