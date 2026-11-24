// Writes sample generated workflows to a directory so CI can lint them with actionlint.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWorkflow, validateRequest } from '../src/workflow.js';

const out = process.argv[2] || 'rendered-workflows';
mkdirSync(out, { recursive: true });
const scripts = { kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', ref: 'main', scripts: ['build\\installer.bat', 'tools/pack.ps1', 'tools/x.sh'], outputs: 'dist/**/*.exe, dist/**/*.msi' };
const samples = [
  { name: 'amd64', dockerfile: 'FROM alpine\n', imageName: 'demo:latest', platform: 'linux/amd64' },
  { name: 'arm64-args', dockerfile: 'FROM alpine\n', imageName: 'ghcr.io/acme/demo:1.2.3', platform: 'linux/arm64', buildArgs: { VERSION: '1.0 "quoted"', DEBUG: '$(rm -rf /)' } },
  { name: 'docker-encrypted', dockerfile: 'FROM alpine\n', mode: 'encrypted-public' },
  { name: 'scripts-private', ...scripts },
  { name: 'scripts-encrypted', ...scripts, mode: 'encrypted-public' },
];
for (const s of samples) {
  const req = validateRequest(s);
  writeFileSync(join(out, `${s.name}.yml`), renderWorkflow(req));
  console.log(`wrote ${join(out, `${s.name}.yml`)}`);
}
