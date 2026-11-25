import { isAbsolute, basename } from 'node:path';
// Validates build requests and generates the workflow + files committed to the
// temporary repository. Two kinds of build:
//   - "dockerfile": Dockerfile instructions in, Docker image (.tar.gz) out
//   - "scripts":    a source repository's build scripts (.bat/.cmd/.ps1/.sh) in, installer files out
// Two run modes:
//   - "private":          throwaway private repository, plain files
//   - "encrypted-public": throwaway public repository; sources and outputs are
//                         encrypted with mac-crypt and the key is an Actions secret

export const PLATFORMS = ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/386', 'linux/ppc64le', 'linux/s390x'];
export const RUNNERS = ['windows-latest', 'windows-2025', 'windows-2022', 'windows-11-arm', 'ubuntu-latest', 'ubuntu-24.04-arm', 'macos-latest'];
export const MODES = ['private', 'encrypted-public', 'local'];
export const KINDS = ['dockerfile', 'scripts'];
export const WORKFLOW_FILE = 'mac-build.yml';
export const ARTIFACT_NAME = 'mac-output';
export const IMAGE_FILE = 'image.tar.gz';
export const SEALED_SOURCE = 'src.mac';
export const SEALED_OUTPUT = 'out.mac';
export const SOURCE_TARBALL = 'src.tar.gz';
export const CRYPT_PATH = '.mac/crypt.mjs';

const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._\-/]{1,200}$/;
const SCRIPT_RE = /^[A-Za-z0-9._\-/\\ ()]+\.(bat|cmd|ps1|sh)$/i;
const GLOB_RE = /^[A-Za-z0-9._\-/\\*? ()]+$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 50;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export function normalizePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new ValidationError('Every extra file needs a path.');
  const clean = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = clean.split('/');
  if (clean.startsWith('/') || parts.some((s) => s === '' || s === '.' || s === '..')) {
    throw new ValidationError(`Invalid file path: ${p}`);
  }
  if (!/^[A-Za-z0-9._\-/ ]+$/.test(clean)) throw new ValidationError(`Unsupported characters in path: ${p}`);
  if (clean.length > 200) throw new ValidationError(`Path too long: ${p}`);
  return clean;
}

function validateMode(body) {
  const mode = body.mode || 'private';
  if (!MODES.includes(mode)) throw new ValidationError(`Unknown mode: ${mode}`);
  return mode;
}

function validateDockerfile(body) {
  const dockerfile = body.dockerfile;
  if (typeof dockerfile !== 'string' || !dockerfile.trim()) throw new ValidationError('Dockerfile instructions are required.');
  if (!/^\s*(#.*\n\s*)*(ARG|FROM)\b/i.test(dockerfile)) throw new ValidationError('Dockerfile must start with FROM (or ARG before FROM).');
  if (Buffer.byteLength(dockerfile) > MAX_FILE_BYTES) throw new ValidationError('Dockerfile is too large (512 KB max).');

  const imageName = (body.imageName || 'custom-image:latest').trim();
  if (!IMAGE_RE.test(imageName)) throw new ValidationError('Image name must look like name[:tag] (lowercase).');

  const platform = body.platform || 'linux/amd64';
  if (!PLATFORMS.includes(platform)) throw new ValidationError(`Unsupported platform: ${platform}`);

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES) throw new ValidationError(`Too many extra files (${MAX_FILES} max).`);
  const seen = new Set(['Dockerfile']);
  const cleanFiles = files.map((f) => {
    const path = normalizePath(f && f.path);
    if (seen.has(path)) throw new ValidationError(`Duplicate file path: ${path}`);
    seen.add(path);
    const content = typeof f.content === 'string' ? f.content : '';
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ValidationError(`${path} is too large (512 KB max).`);
    return { path, content };
  });

  const buildArgs = {};
  for (const [k, v] of Object.entries(body.buildArgs || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ValidationError(`Invalid build arg name: ${k}`);
    const value = String(v);
    // Values land in the workflow env block, where ${{ }} would be evaluated by Actions.
    if (value.includes('${{')) throw new ValidationError(`Build arg ${k} cannot contain "\${{".`);
    if (/[\r\n]/.test(value)) throw new ValidationError(`Build arg ${k} must be a single line.`);
    buildArgs[k] = value;
  }
  return { kind: 'dockerfile', mode: validateMode(body), dockerfile, imageName, platform, files: cleanFiles, buildArgs };
}

function validateScripts(body) {
  // A local run may build a folder on this computer instead of a repository.
  let localPath = null;
  if (body.localPath !== undefined && body.localPath !== null && String(body.localPath).trim()) {
    if ((body.mode || 'private') !== 'local') throw new ValidationError('A folder on this computer can only be built in local mode.');
    localPath = String(body.localPath).trim();
    if (localPath.length > 1000 || /[\r\n\0]/.test(localPath) || !isAbsolute(localPath)) throw new ValidationError('The folder must be a full path on this computer.');
  }
  const repo = localPath ? `local/${basename(localPath).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'folder'}` : String(body.repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!REPO_RE.test(repo)) throw new ValidationError('Repository must look like owner/name.');
  const ref = String(body.ref || '').trim() || 'HEAD';
  if (!REF_RE.test(ref) || ref.includes('..')) throw new ValidationError('Invalid branch, tag or commit.');
  const runner = body.runner || 'windows-latest';
  if (!RUNNERS.includes(runner)) throw new ValidationError(`Unsupported runner: ${runner}`);
  const scripts = (Array.isArray(body.scripts) ? body.scripts : []).map((s) => String(s).trim()).filter(Boolean);
  const workflows = (Array.isArray(body.workflows) ? body.workflows : []).map((s) => String(s).trim()).filter(Boolean);
  for (const w of workflows) {
    if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(w)) throw new ValidationError(`Invalid workflow path: ${w}`);
  }
  if (new Set(workflows).size !== workflows.length) throw new ValidationError('Duplicate workflow.');
  if (workflows.length > 20) throw new ValidationError('At most 20 workflows.');
  if (!scripts.length && !workflows.length) throw new ValidationError('Pick at least one build script or workflow.');
  if (scripts.length > 20) throw new ValidationError('At most 20 build scripts.');
  for (const s of scripts) {
    if (!SCRIPT_RE.test(s) || s.split(/[\\/]/).includes('..') || /^[\\/]/.test(s)) throw new ValidationError(`Invalid script path: ${s}`);
    if (/\.(bat|cmd)$/i.test(s) && !runner.startsWith('windows') && body.mode !== 'local') throw new ValidationError(`${s} needs a Windows runner.`);
  }
  const outputs = (Array.isArray(body.outputs) ? body.outputs : String(body.outputs || '').split(/[\n,]/)).map((g) => g.trim()).filter(Boolean);
  if (scripts.length && !outputs.length) throw new ValidationError('Say which files are the outputs (for example dist/**/*.exe).');
  for (const g of outputs) {
    if (!GLOB_RE.test(g) || g.split(/[\\/]/).includes('..') || /^[\\/]/.test(g)) throw new ValidationError(`Invalid output pattern: ${g}`);
  }
  const name = String(body.name || '').trim() || `${repo.split('/')[1]} build`;
  if (name.length > 80 || /[\r\n]/.test(name)) throw new ValidationError('Name is too long.');
  return { kind: 'scripts', mode: validateMode(body), repo, ref, runner, scripts, workflows, outputs, name, ...(localPath ? { localPath } : {}) };
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Request body must be JSON.');
  const kind = body.kind || 'dockerfile';
  if (!KINDS.includes(kind)) throw new ValidationError(`Unknown build kind: ${kind}`);
  return kind === 'scripts' ? validateScripts(body) : validateDockerfile(body);
}

function q(s) {
  return JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars
}

const SETUP_NODE = `      - name: Set up Node for mac-crypt
        uses: actions/setup-node@v4
        with:
          node-version: 22
`;

// globsArg is inserted inside double quotes in bash: either "$VAR" or a literal.
const sealStep = (base, globsArg) => `      - name: Encrypt outputs
        shell: bash
        env:
          MAC_KEY: \${{ secrets.MAC_KEY }}
        run: node ${CRYPT_PATH} seal ${SEALED_OUTPUT} ${base} "${globsArg}"
`;

function uploadStep(paths) {
  return `      - name: Upload output
        uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_NAME}
          path: |
${paths.map((p) => `            ${p}`).join('\n')}
          compression-level: 0
          retention-days: 1
          if-no-files-found: error
`;
}

export function renderDockerWorkflow({ imageName, platform, buildArgs = {}, mode = 'private' }) {
  const enc = mode === 'encrypted-public';
  const needsQemu = platform !== 'linux/amd64' && platform !== 'linux/386';
  const argNames = Object.keys(buildArgs);
  const envLines = [
    `  IMAGE_NAME: ${q(imageName)}`,
    `  PLATFORM: ${q(platform)}`,
    ...argNames.map((k, i) => `  BUILD_ARG_${i}: ${q(`${k}=${buildArgs[k]}`)}`),
  ];
  const argFlags = argNames.map((_, i) => ` --build-arg "$BUILD_ARG_${i}"`).join('');
  return `name: Build Docker image
on:
  workflow_dispatch:
permissions:
  contents: read
env:
${envLines.join('\n')}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - name: Check out build context
        uses: actions/checkout@v4
${enc ? `${SETUP_NODE}      - name: Decrypt build context
        env:
          MAC_KEY: \${{ secrets.MAC_KEY }}
        run: node ${CRYPT_PATH} open ${SEALED_SOURCE} context
` : ''}${needsQemu ? `      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
` : ''}      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Build image
        run: |
          docker buildx build --platform "$PLATFORM" --tag "$IMAGE_NAME"${argFlags} \\
            --file context/Dockerfile --output "type=docker,dest=image.tar" context
      - name: Compress image
        run: |
          gzip -1 image.tar
          ls -lh ${IMAGE_FILE}
${enc ? `${sealStep('.', IMAGE_FILE)}${uploadStep([SEALED_OUTPUT])}` : uploadStep([IMAGE_FILE])}`;
}

function scriptStep(script, i) {
  const ext = script.split('.').pop().toLowerCase();
  const shell = ext === 'ps1' ? 'pwsh' : ext === 'sh' ? 'bash' : 'cmd';
  const call = ext === 'ps1' ? '& "./$env:SCRIPT"' : ext === 'sh' ? 'bash "./$SCRIPT"' : 'call "%SCRIPT%"';
  const p = ext === 'sh' || ext === 'ps1' ? script.replace(/\\/g, '/') : script.replace(/\//g, '\\');
  return `      - name: Run script ${i + 1}
        shell: ${shell}
        working-directory: src
        env:
          SCRIPT: ${q(p)}
        run: |
          ${call}
`;
}

export function renderScriptWorkflow({ name, runner, scripts, outputs, mode = 'private' }) {
  const enc = mode === 'encrypted-public';
  const globs = outputs.map((g) => g.replace(/\\/g, '/'));
  return `name: ${q(name)}
on:
  workflow_dispatch:
permissions:
  contents: read
env:
  OUTPUT_GLOBS: ${q(globs.join(','))}
jobs:
  build:
    runs-on: ${runner}
    timeout-minutes: 180
    steps:
      - name: Check out sources
        uses: actions/checkout@v4
${enc ? SETUP_NODE : ''}      - name: Unpack sources
        shell: bash
${enc ? `        env:
          MAC_KEY: \${{ secrets.MAC_KEY }}
` : ''}        run: |
${enc ? `          node ${CRYPT_PATH} open ${SEALED_SOURCE} .mac-src
          mv .mac-src/${SOURCE_TARBALL} ${SOURCE_TARBALL}
` : ''}          mkdir -p src
          tar -xzf ${SOURCE_TARBALL} --strip-components=1 -C src
          rm -f ${SOURCE_TARBALL}
${scripts.map(scriptStep).join('')}${enc ? `${sealStep('src', '$OUTPUT_GLOBS')}${uploadStep([SEALED_OUTPUT])}` : uploadStep(globs.map((g) => `src/${g}`))}`;
}

export function renderWorkflow(req) {
  return req.kind === 'scripts' ? renderScriptWorkflow(req) : renderDockerWorkflow(req);
}

export function readme(req) {
  const what = req.kind === 'scripts' ? `${req.repo}@${req.ref}` : `\`${req.imageName}\``;
  const enc = req.mode === 'encrypted-public'
    ? '\n\nEverything here is encrypted with mac-crypt. Sources and outputs cannot be read without the per-run key.\n'
    : '\n';
  return `# Temporary build repository\n\nCreated by material-actions-creator to build ${what}. It is deleted automatically.${enc}`;
}

export function downloadName(imageName) {
  return `${imageName.replace(/[/:]/g, '_')}.tar.gz`;
}

export function describe(req) {
  const parts = [];
  if (req.scripts?.length) parts.push(req.runner);
  if (req.workflows?.length) parts.push(`${req.workflows.length} workflow${req.workflows.length === 1 ? '' : 's'}`);
  if (req.mode === 'local' && req.kind === 'scripts') {
    const what = [req.scripts?.length ? `${req.scripts.length} script${req.scripts.length === 1 ? '' : 's'}` : '', req.workflows?.length ? `${req.workflows.length} workflow${req.workflows.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ');
    return { title: req.name, subtitle: `${req.localPath || `${req.repo} @ ${req.ref}`} → ${what} on this computer` };
  }
  return req.kind === 'scripts'
    ? { title: req.name, subtitle: `${req.repo} @ ${req.ref} → ${parts.join(' + ')}` }
    : { title: req.imageName, subtitle: req.platform };
}
