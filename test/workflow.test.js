import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, renderWorkflow, buildRepoFiles, normalizePath, downloadName, ValidationError } from '../src/workflow.js';

const base = { dockerfile: 'FROM alpine:3.20\nRUN echo hi\n' };

test('accepts a minimal request with defaults', () => {
  const r = validateRequest(base);
  assert.equal(r.imageName, 'custom-image:latest');
  assert.equal(r.platform, 'linux/amd64');
  assert.deepEqual(r.files, []);
});

test('allows ARG and comments before FROM', () => {
  assert.ok(validateRequest({ dockerfile: '# syntax=docker/dockerfile:1\nARG V=1\nFROM alpine:$V\n' }));
});

test('rejects bad Dockerfiles, names, and platforms', () => {
  assert.throws(() => validateRequest({ dockerfile: '' }), ValidationError);
  assert.throws(() => validateRequest({ dockerfile: 'RUN echo\n' }), /FROM/);
  assert.throws(() => validateRequest({ ...base, imageName: 'Bad Name' }), /Image name/);
  assert.throws(() => validateRequest({ ...base, platform: 'windows/amd64' }), /platform/);
});

test('rejects path traversal and workflow overwrite attempts', () => {
  for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a//b', '', 'a\0b']) {
    assert.throws(() => normalizePath(p), ValidationError, p);
  }
  // Even ".github/..." stays inside context/, so it can never replace the workflow.
  const r = validateRequest({ ...base, files: [{ path: '.github/workflows/build-image.yml', content: 'x' }] });
  const paths = buildRepoFiles(r).map((f) => f.path);
  assert.ok(paths.includes('context/.github/workflows/build-image.yml'));
  assert.equal(paths.filter((p) => p === '.github/workflows/build-image.yml').length, 1);
});

test('rejects duplicate paths and Dockerfile overrides', () => {
  assert.throws(() => validateRequest({ ...base, files: [{ path: 'Dockerfile', content: '' }] }), /Duplicate/);
  assert.throws(() => validateRequest({ ...base, files: [{ path: 'a', content: '' }, { path: './a', content: '' }] }), /Duplicate/);
});

test('blocks expression injection in build args', () => {
  assert.throws(() => validateRequest({ ...base, buildArgs: { X: '${{ secrets.GITHUB_TOKEN }}' } }), /\$\{\{/);
  assert.throws(() => validateRequest({ ...base, buildArgs: { X: 'a\nb' } }), /single line/);
  assert.throws(() => validateRequest({ ...base, buildArgs: { 'BAD-NAME': '1' } }), /build arg/);
});

test('workflow passes user values only through env, never inline in run scripts', () => {
  const r = validateRequest({ ...base, imageName: 'demo:1', platform: 'linux/arm64', buildArgs: { V: '$(id)' } });
  const yml = renderWorkflow(r);
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /IMAGE_NAME: "demo:1"/);
  assert.match(yml, /BUILD_ARG_0: "V=\$\(id\)"/);
  assert.match(yml, /setup-qemu-action/);
  const runBlocks = yml.split('run: |').slice(1).join('\n');
  assert.ok(!runBlocks.includes('$(id)'), 'user value leaked into a run script');
  assert.match(yml, /upload-artifact@v4/);
  assert.match(yml, /compression-level: 0/);
});

test('amd64 builds skip QEMU', () => {
  assert.doesNotMatch(renderWorkflow(validateRequest(base)), /qemu/);
});

test('download names are filesystem safe', () => {
  assert.equal(downloadName('ghcr.io/acme/app:1.0'), 'ghcr.io_acme_app_1.0.tar.gz');
});
