// Line-based checks on workflow YAML. No dependencies, so it also works when
// copied out of the app as a starting point for your own extension.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const lines = String(payload.workflow?.yaml || '').split('\n');
const findings = [];
const add = (level, line, message) => findings.push({ level, line, message });

let jobsIndent = -1;
let job = null;
const jobs = [];
lines.forEach((raw, i) => {
  const line = raw.replace(/\s+#.*$/, '');
  const n = i + 1;
  const uses = line.match(/^\s*-?\s*uses:\s*["']?([^"'\s]+)/);
  if (uses) {
    const ref = uses[1];
    if (!ref.startsWith('./') && !ref.startsWith('docker://')) {
      const at = ref.split('@')[1];
      if (!at) add('error', n, `"${ref}" has no version. Pin it to a commit.`);
      else if (!/^[0-9a-f]{40}$/.test(at)) add('warning', n, `"${ref}" follows a tag or branch that can move. Pin it to a full commit SHA.`);
    }
  }
  if (/^\s*permissions:\s*write-all\s*$/.test(line)) add('error', n, 'permissions: write-all gives the run every permission. List only what it needs.');
  if (/^\s*[a-z-]+:\s*write\s*$/.test(line) && !/^\s*id-token:/.test(line)) add('info', n, `Write permission: ${line.trim()}. Check that the run needs it.`);
  if (/\$\{\{\s*github\.event\.(issue|pull_request|comment|head_commit)\.[^}]*(title|body|message)[^}]*\}\}/.test(line) && !/^\s*[A-Z_]+:/.test(line)) add('warning', n, 'Untrusted text from the event is placed straight into a command. Pass it through an environment variable.');
  if (/^jobs:\s*$/.test(line)) { jobsIndent = 0; return; }
  if (jobsIndent === 0) {
    const m = raw.match(/^( +)([A-Za-z0-9_-]+):\s*$/);
    if (m && (job === null || m[1].length === job.indent)) { job = { name: m[2], line: n, indent: m[1].length, timeout: false, reusable: false }; jobs.push(job); }
    else if (job && /^\s*timeout-minutes:/.test(line) && raw.search(/\S/) === job.indent + 2) job.timeout = true;
    else if (job && /^\s*uses:/.test(line) && raw.search(/\S/) === job.indent + 2) job.reusable = true;
    else if (/^\S/.test(raw) && raw.trim()) jobsIndent = -1;
  }
});
for (const j of jobs) if (!j.timeout && !j.reusable) add('warning', j.line, `Job "${j.name}" has no timeout-minutes, so a stuck run can use up to 6 hours.`);

const count = (l) => findings.filter((f) => f.level === l).length;
console.log(JSON.stringify({ ok: true, result: {
  title: findings.length ? `${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes` : 'No problems found',
  findings,
} }));
