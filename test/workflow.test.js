import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, renderWorkflow, normalizePath, downloadName, ValidationError } from '../src/workflow.js';

const base = { dockerfile: 'FROM alpine:3.20\nRUN echo hi\n' };
const scripts = { kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', ref: 'main', scripts: ['build\\installer.bat'], outputs: 'dist/**/*.exe, dist/**/*.msi' };

test('dockerfile requests get defaults', () => {
  const r = validateRequest(base);
  assert.equal(r.kind, 'dockerfile');
  assert.equal(r.mode, 'private');
  assert.equal(r.imageName, 'custom-image:latest');
  assert.equal(r.platform, 'linux/amd64');
});

test('allows ARG and comments before FROM', () => {
  assert.ok(validateRequest({ dockerfile: '# syntax=docker/dockerfile:1\nARG V=1\nFROM alpine:$V\n' }));
});

test('rejects bad Dockerfiles, names, platforms, kinds, and modes', () => {
  assert.throws(() => validateRequest({ dockerfile: '' }), ValidationError);
  assert.throws(() => validateRequest({ dockerfile: 'RUN echo\n' }), /FROM/);
  assert.throws(() => validateRequest({ ...base, imageName: 'Bad Name' }), /Image name/);
  assert.throws(() => validateRequest({ ...base, platform: 'windows/amd64' }), /platform/);
  assert.throws(() => validateRequest({ ...base, kind: 'nope' }), /kind/);
  assert.throws(() => validateRequest({ ...base, mode: 'yolo' }), /mode/);
});

test('rejects path traversal in extra files', () => {
  for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a//b', '', 'a\0b']) {
    assert.throws(() => normalizePath(p), ValidationError, p);
  }
  assert.throws(() => validateRequest({ ...base, files: [{ path: 'Dockerfile', content: '' }] }), /Duplicate/);
});

test('blocks expression injection in build args', () => {
  assert.throws(() => validateRequest({ ...base, buildArgs: { X: '${{ secrets.GITHUB_TOKEN }}' } }), /\$\{\{/);
  assert.throws(() => validateRequest({ ...base, buildArgs: { X: 'a\nb' } }), /single line/);
});

test('docker workflow passes user values only through env', () => {
  const yml = renderWorkflow(validateRequest({ ...base, imageName: 'demo:1', platform: 'linux/arm64', buildArgs: { V: '$(id)' } }));
  assert.match(yml, /IMAGE_NAME: "demo:1"/);
  assert.match(yml, /BUILD_ARG_0: "V=\$\(id\)"/);
  assert.match(yml, /setup-qemu-action/);
  assert.ok(!yml.split('run: |').slice(1).join('\n').includes('$(id)'));
  assert.match(yml, /name: lap-sap/);
  assert.doesNotMatch(yml, /MAC_KEY/);
});

test('encrypted docker workflow decrypts the context and seals the image', () => {
  const yml = renderWorkflow(validateRequest({ ...base, mode: 'encrypted-public' }));
  assert.match(yml, /node \.mac\/crypt\.mjs open src\.mac context/);
  assert.match(yml, /node \.mac\/crypt\.mjs seal out\.mac \. "image\.tar\.gz"/);
  assert.match(yml, /MAC_KEY: \$\{\{ secrets\.MAC_KEY \}\}/);
  assert.match(yml, /path: \|\n\s+out\.mac/);
  assert.doesNotMatch(yml, /path: \|\n\s+image\.tar\.gz/);
});

test('script requests validate repo, scripts, runner and outputs', () => {
  const r = validateRequest(scripts);
  assert.equal(r.runner, 'windows-latest');
  assert.deepEqual(r.outputs, ['dist/**/*.exe', 'dist/**/*.msi']);
  assert.equal(validateRequest({ ...scripts, repo: 'https://github.com/Ding-Ding-Projects/map-editor.git' }).repo, 'Ding-Ding-Projects/map-editor');
  assert.throws(() => validateRequest({ ...scripts, repo: 'nope' }), /owner\/name/);
  assert.throws(() => validateRequest({ ...scripts, scripts: [] }), /at least one/);
  assert.throws(() => validateRequest({ ...scripts, scripts: ['..\\evil.bat'] }), /Invalid script/);
  assert.throws(() => validateRequest({ ...scripts, scripts: ['build.bat & del *.bat'] }), /Invalid script/);
  assert.throws(() => validateRequest({ ...scripts, scripts: ['a.exe'] }), /Invalid script/);
  assert.throws(() => validateRequest({ ...scripts, runner: 'ubuntu-latest' }), /Windows runner/);
  assert.throws(() => validateRequest({ ...scripts, runner: 'my-laptop' }), /runner/);
  assert.throws(() => validateRequest({ ...scripts, outputs: '' }), /lap saps/);
  assert.throws(() => validateRequest({ ...scripts, outputs: '../secrets/*' }), /Invalid output/);
  assert.throws(() => validateRequest({ ...scripts, outputs: 'dist/$(whoami)' }), /Invalid output/);
  assert.throws(() => validateRequest({ ...scripts, ref: 'main..evil' }), /branch/);
});

test('script workflow runs each script through env, never inline', () => {
  const yml = renderWorkflow(validateRequest({ ...scripts, scripts: ['build\\installer.bat', 'tools/pack.ps1', 'tools/x.sh'], runner: 'windows-2022' }));
  assert.match(yml, /runs-on: windows-2022/);
  assert.match(yml, /shell: cmd\n\s+working-directory: src\n\s+env:\n\s+SCRIPT: "build\\\\installer\.bat"\n\s+run: \|\n\s+call "%SCRIPT%"/);
  assert.match(yml, /shell: pwsh[\s\S]+SCRIPT: "tools\/pack\.ps1"/);
  assert.match(yml, /shell: bash[\s\S]+SCRIPT: "tools\/x\.sh"\n\s+run: \|\n\s+bash "\.\/\$SCRIPT"/);
  // Plain scalars must never start with YAML indicators such as & or *.
  assert.doesNotMatch(yml, /run: [&*!>'"%@`]/);
  assert.match(yml, /tar -xzf src\.tar\.gz --strip-components=1 -C src/);
  assert.match(yml, /src\/dist\/\*\*\/\*\.exe\n\s+src\/dist\/\*\*\/\*\.msi/);
  assert.doesNotMatch(yml, /MAC_KEY/);
});

test('encrypted script workflow opens sources and seals outputs', () => {
  const yml = renderWorkflow(validateRequest({ ...scripts, mode: 'encrypted-public' }));
  assert.match(yml, /node \.mac\/crypt\.mjs open src\.mac \.mac-src/);
  assert.match(yml, /OUTPUT_GLOBS: "dist\/\*\*\/\*\.exe,dist\/\*\*\/\*\.msi"/);
  assert.match(yml, /node \.mac\/crypt\.mjs seal out\.mac src "\$OUTPUT_GLOBS"/);
  assert.match(yml, /setup-node@v4/);
  // Only the sealed bundle is uploaded from a public repository.
  assert.match(yml, /path: \|\n\s+out\.mac\n/);
  assert.doesNotMatch(yml, /src\/dist/);
});

test('download names are filesystem safe', () => {
  assert.equal(downloadName('ghcr.io/acme/app:1.0'), 'ghcr.io_acme_app_1.0.tar.gz');
});
