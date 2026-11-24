// Rewrites a source repository's own GitHub Actions workflows so they can run
// inside the temporary build repository.
//
// What changes:
//   - triggers: only workflow_dispatch (+ workflow_call for reusable workflows),
//     so committing files never starts anything by itself
//   - permissions: read-only for the workflow and every job, so GITHUB_TOKEN
//     cannot publish releases, push commits or deploy pages
//   - after each checkout of the repository itself, the real sources are
//     unpacked over the workspace (decrypted first in encrypted mode)
//   - encrypted mode: every upload-artifact is sealed with mac-crypt before
//     upload, and every download-artifact is opened after download, so jobs
//     still pass artifacts to each other but nothing readable is uploaded
//   - known publishing steps (releases, pages, registry pushes) are removed
// Everything that changes is reported as a warning for the UI and CLI.
import YAML from 'yaml';
import { SEALED_SOURCE, SOURCE_TARBALL, CRYPT_PATH } from './workflow.js';

export const LAP_PREFIX = 'lap-sap-';
const PUBLISH_RE = /^(softprops\/action-gh-release|actions\/create-release|actions\/upload-release-asset|ncipollo\/release-action|marvinpinto\/action-automatic-releases|svenstaro\/upload-release-action|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|actions\/deploy-pages|actions\/upload-pages-artifact|pypa\/gh-action-pypi-publish|JS-DevTools\/npm-publish|stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|peter-evans\/create-pull-request|actions\/attest-build-provenance)@/i;
const READ_ONLY = { contents: 'read', actions: 'read' };
const CRYPT_TMP = '"$RUNNER_TEMP/mac-crypt.mjs"';

function isSelfCheckout(step) {
  if (typeof step?.uses !== 'string' || !/^actions\/checkout@/i.test(step.uses)) return false;
  const repo = step.with?.repository;
  return !repo || /^\$\{\{\s*github\.repository\s*\}\}$/.test(String(repo).trim());
}

function quoteSh(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function unpackStep(path, enc) {
  const dir = path && path !== '.' ? path : '.';
  const lines = enc
    ? [
      `cp ${quoteSh(`${dir}/${CRYPT_PATH}`)} ${CRYPT_TMP}`,
      `node ${CRYPT_TMP} open ${quoteSh(`${dir}/${SEALED_SOURCE}`)} "$RUNNER_TEMP/mac-src"`,
      `tar -xzf "$RUNNER_TEMP/mac-src/${SOURCE_TARBALL}" --strip-components=1 -C ${quoteSh(dir)}`,
      `rm -rf "$RUNNER_TEMP/mac-src" ${quoteSh(`${dir}/${SEALED_SOURCE}`)} ${quoteSh(`${dir}/.mac`)}`,
    ]
    : [
      `tar -xzf ${quoteSh(`${dir}/${SOURCE_TARBALL}`)} --strip-components=1 -C ${quoteSh(dir)}`,
      `rm -f ${quoteSh(`${dir}/${SOURCE_TARBALL}`)}`,
    ];
  return {
    name: enc ? 'mac: decrypt and unpack sources' : 'mac: unpack sources',
    shell: 'bash',
    ...(enc ? { env: { MAC_KEY: '${{ secrets.MAC_KEY }}' } } : {}),
    run: `${lines.join('\n')}\n`,
  };
}

function sealSteps(step, k) {
  const out = `\${{ runner.temp }}/mac-out-${k}.mac`;
  const name = step.with?.name ? String(step.with.name) : 'artifact';
  const seal = {
    name: `mac: seal ${step.name || name}`,
    shell: 'bash',
    env: { MAC_KEY: '${{ secrets.MAC_KEY }}', MAC_GLOBS: String(step.with?.path ?? '') },
    run: `node ${CRYPT_TMP} seal "$RUNNER_TEMP/mac-out-${k}.mac" . "$MAC_GLOBS"\n`,
  };
  if (step.if) seal.if = step.if;
  const upload = {
    ...step,
    name: `mac: upload sealed ${step.name || name}`,
    with: {
      ...Object.fromEntries(Object.entries(step.with || {}).filter(([key]) => ['retention-days', 'overwrite', 'if-no-files-found'].includes(key))),
      name: `${LAP_PREFIX}${name}`,
      path: out,
      'compression-level': 0,
    },
  };
  return [seal, upload];
}

function openSteps(step, k) {
  const dl = `\${{ runner.temp }}/mac-dl-${k}`;
  const target = step.with?.path ? String(step.with.path) : '.';
  const named = step.with?.name;
  const download = {
    ...step,
    name: `mac: download sealed ${step.name || named || 'artifacts'}`,
    with: {
      ...Object.fromEntries(Object.entries(step.with || {}).filter(([key]) => !['name', 'path', 'pattern', 'merge-multiple'].includes(key))),
      ...(named ? { name: `${LAP_PREFIX}${named}` } : { pattern: `${LAP_PREFIX}*` }),
      path: dl,
    },
  };
  const open = {
    name: `mac: open ${step.name || named || 'artifacts'}`,
    shell: 'bash',
    env: { MAC_KEY: '${{ secrets.MAC_KEY }}', MAC_TARGET: target },
    run: named || step.with?.['merge-multiple']
      ? `for f in "$RUNNER_TEMP/mac-dl-${k}"/*.mac "$RUNNER_TEMP/mac-dl-${k}"/*/*.mac; do [ -e "$f" ] || continue; node ${CRYPT_TMP} open "$f" "$MAC_TARGET"; done\n`
      : `for d in "$RUNNER_TEMP/mac-dl-${k}"/${LAP_PREFIX}*; do n=$(basename "$d"); n=\${n#${LAP_PREFIX}}; for f in "$d"/*.mac; do node ${CRYPT_TMP} open "$f" "$MAC_TARGET/$n"; done; done\n`,
  };
  if (step.if) open.if = step.if;
  return [download, open];
}

function normalizeOn(on) {
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [t, null]));
  return on && typeof on === 'object' ? on : {};
}

export function transformWorkflow(text, { mode = 'private', file = 'workflow.yml' } = {}) {
  const enc = mode === 'encrypted-public';
  const warnings = [];
  let wf;
  try {
    wf = YAML.parse(text, { maxAliasCount: 100 });
  } catch (err) {
    throw new Error(`${file}: not valid YAML (${err.message.split('\n')[0]})`);
  }
  if (!wf || typeof wf !== 'object' || !wf.jobs || typeof wf.jobs !== 'object') throw new Error(`${file}: no jobs.`);

  const on = normalizeOn(wf.on ?? wf.true); // YAML 1.1 parsers read a bare `on` as true
  delete wf.true;
  const reusable = Object.prototype.hasOwnProperty.call(on, 'workflow_call');
  const triggers = Object.keys(on);
  const dispatchable = !reusable || triggers.some((t) => t !== 'workflow_call');
  const dropped = triggers.filter((t) => !['workflow_dispatch', 'workflow_call'].includes(t));
  if (dropped.length) warnings.push(`Triggers replaced by a manual start: ${dropped.join(', ')}.`);
  const newOn = {};
  if (dispatchable) {
    newOn.workflow_dispatch = on.workflow_dispatch && typeof on.workflow_dispatch === 'object' ? on.workflow_dispatch : null;
    const inputs = on.workflow_dispatch?.inputs || {};
    for (const [name, def] of Object.entries(inputs)) {
      if (def?.required && def.default === undefined) warnings.push(`Input "${name}" is required and has no default; the run may not start.`);
    }
  }
  if (reusable) newOn.workflow_call = on.workflow_call;
  wf.on = newOn;

  wf.permissions = { ...READ_ONLY };
  let k = 0;
  const secrets = new Set();
  for (const m of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (!['GITHUB_TOKEN', 'MAC_KEY'].includes(m[1])) secrets.add(m[1]);
  if (secrets.size) warnings.push(`Secrets not available in the temporary repository: ${[...secrets].join(', ')}.`);
  if (/github\.event_name|github\.event\.(release|pull_request|push)/.test(text)) warnings.push('Some steps check the triggering event; they may be skipped on a manual start.');

  for (const [id, job] of Object.entries(wf.jobs)) {
    if (!job || typeof job !== 'object') continue;
    if (job.permissions !== undefined) job.permissions = { ...READ_ONLY };
    if (job.environment) {
      warnings.push(`Job "${id}" used environment "${typeof job.environment === 'object' ? job.environment.name : job.environment}"; removed.`);
      delete job.environment;
    }
    if (job.uses) continue; // calls a reusable workflow, which is transformed on its own
    if (job.container && enc) warnings.push(`Job "${id}" runs in a container; mac-crypt needs node inside it.`);
    if (!Array.isArray(job.steps)) continue;
    const steps = [];
    let sawCheckout = false;
    for (const step of job.steps) {
      const uses = typeof step?.uses === 'string' ? step.uses : '';
      if (PUBLISH_RE.test(uses)) {
        warnings.push(`Job "${id}": removed publishing step ${step.name ? `"${step.name}" ` : ''}(${uses.split('@')[0]}).`);
        continue;
      }
      if (/^docker\/build-push-action@/i.test(uses) && step.with?.push) {
        step.with = { ...step.with, push: false };
        warnings.push(`Job "${id}": docker/build-push-action no longer pushes.`);
      }
      if (isSelfCheckout(step)) {
        sawCheckout = true;
        steps.push(step, unpackStep(step.with?.path, enc));
        continue;
      }
      if (enc && /^actions\/upload-artifact@/i.test(uses)) {
        const p = String(step.with?.path ?? '');
        if (/(^|\n)\s*!/.test(p)) warnings.push(`Job "${id}": exclude patterns (!) in artifact paths are ignored when sealing.`);
        if (/(^|\n)\s*(\/|[A-Za-z]:\\|~)/.test(p)) warnings.push(`Job "${id}": absolute artifact paths cannot be sealed; use paths inside the workspace.`);
        if (!sawCheckout) warnings.push(`Job "${id}" uploads an artifact without checking out the repository; sealing needs a checkout first.`);
        steps.push(...sealSteps(step, k++));
        continue;
      }
      if (enc && /^actions\/download-artifact@/i.test(uses)) {
        steps.push(...openSteps(step, k++));
        continue;
      }
      steps.push(step);
    }
    job.steps = steps;
  }

  const yaml = `# Rewritten by material-actions-creator from ${file}\n${YAML.stringify(wf, { lineWidth: 0 })}`;
  return { yaml, dispatchable, warnings: [...new Set(warnings)] };
}

// Friendly name of a workflow file (its `name:` or the file name).
export function workflowName(text, file) {
  try {
    const wf = YAML.parse(text);
    if (wf && typeof wf.name === 'string' && wf.name.trim()) return wf.name.trim();
  } catch { /* fall through */ }
  return file.replace(/^.*\//, '');
}
