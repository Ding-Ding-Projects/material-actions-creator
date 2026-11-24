// Writes sample generated workflows to a directory so CI can lint them with actionlint.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWorkflow, validateRequest } from '../src/workflow.js';
import { transformWorkflow } from '../src/transform.js';

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

// A source repository's own workflow, rewritten both ways, must stay valid too.
const sourceWorkflow = `name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: build\\installer.bat
        shell: cmd
      - uses: actions/upload-artifact@v4
        with:
          name: installers
          path: dist/*.exe
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
  package:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: installers
          path: dist
      - uses: actions/download-artifact@v4
`;
for (const mode of ['private', 'encrypted-public']) {
  const file = join(out, `source-${mode}.yml`);
  writeFileSync(file, transformWorkflow(sourceWorkflow, { mode, file: 'release.yml' }).yaml);
  console.log(`wrote ${file}`);
}
