import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { transformWorkflow, workflowName } from '../src/transform.js';
import { SOURCE_WORKFLOWS } from './helpers.js';

const release = SOURCE_WORKFLOWS['.github/workflows/release.yml'];

test('triggers become manual-only and permissions read-only', () => {
  const { yaml, dispatchable, warnings } = transformWorkflow(release, { mode: 'private', file: 'release.yml' });
  const wf = YAML.parse(yaml);
  assert.equal(dispatchable, true);
  assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepEqual(wf.permissions, { contents: 'read', actions: 'read' });
  assert.ok(warnings.some((w) => /push/.test(w)));
});

test('publishing steps are removed, checkouts are followed by unpacking', () => {
  const { yaml, warnings } = transformWorkflow(release, { mode: 'private', file: 'release.yml' });
  const steps = YAML.parse(yaml).jobs.build.steps;
  assert.ok(!steps.some((s) => /action-gh-release/.test(s.uses || '')));
  assert.ok(warnings.some((w) => /removed publishing step/.test(w)));
  const i = steps.findIndex((s) => /actions\/checkout/.test(s.uses || ''));
  assert.match(steps[i + 1].run, /tar -xzf '\.\/src\.tar\.gz' --strip-components=1/);
  // Private mode keeps normal artifact uploads.
  assert.ok(steps.some((s) => /upload-artifact/.test(s.uses || '') && s.with.name === 'installers'));
});

test('encrypted mode decrypts after checkout and seals every upload', () => {
  const { yaml } = transformWorkflow(release, { mode: 'encrypted-public', file: 'release.yml' });
  const steps = YAML.parse(yaml).jobs.build.steps;
  const unpack = steps.find((s) => s.name === 'mac: decrypt and unpack sources');
  assert.match(unpack.run, /mac-crypt\.mjs" open '\.\/src\.mac'/);
  assert.equal(unpack.env.MAC_KEY, '${{ secrets.MAC_KEY }}');
  const seal = steps.find((s) => /^mac: seal/.test(s.name));
  assert.equal(seal.env.MAC_GLOBS, 'dist/*.exe');
  const up = steps.find((s) => /upload-artifact/.test(s.uses || ''));
  assert.equal(up.with.name, 'lap-sap-installers');
  assert.equal(up.with.path, '${{ runner.temp }}/mac-out-0.mac');
  assert.ok(!yaml.includes('path: dist/*.exe'), 'plain artifact path must not be uploaded');
});

test('downloads between jobs are opened again', () => {
  const src = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with: { name: bin, path: out/** }
  b:
    needs: a
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: bin, path: out }
      - uses: actions/download-artifact@v4
`;
  const wf = YAML.parse(transformWorkflow(src, { mode: 'encrypted-public' }).yaml);
  const b = wf.jobs.b.steps;
  const dl = b.find((s) => /download-artifact/.test(s.uses || '') && s.with.name);
  assert.equal(dl.with.name, 'lap-sap-bin');
  const open = b.find((s) => s.name === 'mac: open bin');
  assert.equal(open.env.MAC_TARGET, 'out');
  const all = b.find((s) => /download-artifact/.test(s.uses || '') && s.with.pattern);
  assert.equal(all.with.pattern, 'lap-sap-*');
});

test('reusable-only workflows are kept but not started on their own', () => {
  const r = transformWorkflow(SOURCE_WORKFLOWS['.github/workflows/reusable.yml'], { mode: 'encrypted-public' });
  assert.equal(r.dispatchable, false);
  assert.deepEqual(Object.keys(YAML.parse(r.yaml).on), ['workflow_call']);
});

test('warnings cover secrets, environments, event checks and pushes', () => {
  const src = `on: { push: {}, workflow_dispatch: { inputs: { v: { required: true } } } }
jobs:
  x:
    runs-on: ubuntu-latest
    environment: production
    permissions: write-all
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with: { push: true }
      - run: echo \${{ secrets.NPM_TOKEN }}
`;
  const { yaml, warnings } = transformWorkflow(src, { mode: 'private' });
  const wf = YAML.parse(yaml);
  assert.deepEqual(wf.jobs.x.permissions, { contents: 'read', actions: 'read' });
  assert.equal(wf.jobs.x.environment, undefined);
  assert.equal(wf.jobs.x.steps.find((s) => /build-push/.test(s.uses || '')).with.push, false);
  const all = warnings.join('\n');
  assert.match(all, /NPM_TOKEN/);
  assert.match(all, /environment/);
  assert.match(all, /triggering event/);
  assert.match(all, /required and has no default/);
  assert.match(all, /no longer pushes/);
});

test('checkout into a sub-path unpacks there', () => {
  const src = `on: workflow_dispatch
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { path: app }
      - uses: actions/checkout@v4
        with: { repository: other/repo, path: lib }
`;
  const steps = YAML.parse(transformWorkflow(src, { mode: 'encrypted-public' }).yaml).jobs.x.steps;
  assert.equal(steps.length, 3, 'only the self checkout gets an unpack step');
  assert.match(steps[1].run, /'app\/src\.mac'/);
  assert.match(steps[1].run, /-C 'app'/);
});

test('bad YAML and job-less files are rejected with the file name', () => {
  assert.throws(() => transformWorkflow('on: [', { file: 'x.yml' }), /x\.yml: not valid YAML/);
  assert.throws(() => transformWorkflow('name: hi', { file: 'y.yml' }), /y\.yml: no jobs/);
});

test('workflow names come from name: or the file', () => {
  assert.equal(workflowName(release, '.github/workflows/release.yml'), 'Release');
  assert.equal(workflowName('on: push', '.github/workflows/ci.yml'), 'ci.yml');
});
