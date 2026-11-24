// Generates the files committed to the temporary repository.
// User files live under context/ so they can never overwrite the workflow.

export const PLATFORMS = ['linux/amd64', 'linux/arm64', 'linux/arm/v7', 'linux/386', 'linux/ppc64le', 'linux/s390x'];
export const WORKFLOW_FILE = 'build-image.yml';
export const ARTIFACT_NAME = 'docker-image';
export const IMAGE_FILE = 'image.tar.gz';

const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
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

export function validateRequest(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Request body must be JSON.');
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
  return { dockerfile, imageName, platform, files: cleanFiles, buildArgs };
}

function yamlString(s) {
  return JSON.stringify(String(s)); // JSON strings are valid YAML double-quoted scalars
}

export function renderWorkflow({ imageName, platform, buildArgs = {} }) {
  const needsQemu = platform !== 'linux/amd64' && platform !== 'linux/386';
  const argNames = Object.keys(buildArgs);
  const envLines = [
    `  IMAGE_NAME: ${yamlString(imageName)}`,
    `  PLATFORM: ${yamlString(platform)}`,
    ...argNames.map((k, i) => `  BUILD_ARG_${i}: ${yamlString(`${k}=${buildArgs[k]}`)}`),
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
${needsQemu ? `      - name: Set up QEMU
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
          echo "### Built \\\`$IMAGE_NAME\\\` for \\\`$PLATFORM\\\`" >> "$GITHUB_STEP_SUMMARY"
      - name: Upload image artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_NAME}
          path: ${IMAGE_FILE}
          compression-level: 0
          retention-days: 1
          if-no-files-found: error
`;
}

export function buildRepoFiles(req) {
  return [
    { path: 'README.md', content: `# Temporary build repository\n\nCreated by material-actions-creator to build \`${req.imageName}\`. It is deleted automatically.\n` },
    { path: 'context/Dockerfile', content: req.dockerfile },
    ...req.files.map((f) => ({ path: `context/${f.path}`, content: f.content })),
    { path: `.github/workflows/${WORKFLOW_FILE}`, content: renderWorkflow(req) },
  ];
}

export function downloadName(imageName) {
  return `${imageName.replace(/[/:]/g, '_')}.tar.gz`;
}
