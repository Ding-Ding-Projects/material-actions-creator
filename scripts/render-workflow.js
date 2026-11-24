// Writes sample generated workflows to a directory so CI can lint them with actionlint.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWorkflow, validateRequest } from '../src/workflow.js';

const out = process.argv[2] || 'rendered-workflows';
mkdirSync(out, { recursive: true });
const samples = [
  { name: 'amd64', imageName: 'demo:latest', platform: 'linux/amd64' },
  { name: 'arm64-args', imageName: 'ghcr.io/acme/demo:1.2.3', platform: 'linux/arm64', buildArgs: { VERSION: '1.0 "quoted"', DEBUG: '$(rm -rf /)' } },
];
for (const s of samples) {
  const req = validateRequest({ dockerfile: 'FROM alpine\n', ...s });
  writeFileSync(join(out, `${s.name}.yml`), renderWorkflow(req));
  console.log(`wrote ${join(out, `${s.name}.yml`)}`);
}
