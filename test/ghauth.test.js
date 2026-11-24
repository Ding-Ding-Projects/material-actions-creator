import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { GhAuth, parseDeviceOutput, missingScopes } from '../src/ghauth.js';

// A fake `gh` that mimics the device-flow output and records its arguments.
async function fakeGh({ exitCode = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-'));
  const bin = join(dir, 'gh');
  await writeFile(bin, `#!/bin/sh
echo "$@" >> "${dir}/args.log"
echo "GH_TOKEN=\${GH_TOKEN:-unset}" >> "${dir}/args.log"
case "$1 $2" in
  "--version ") echo "gh version 9.9.9 (fake)";;
  "auth token") [ -f "${dir}/loggedin" ] && echo "gho_faketoken" || exit 1;;
  "auth login"|"auth refresh")
    echo "! First copy your one-time code: AB12-CD34" >&2
    echo "Press Enter to open https://github.com/login/device in your browser..." >&2
    read _line
    touch "${dir}/loggedin"
    echo "✓ Logged in as swiftie" >&2
    exit ${exitCode};;
  "auth logout") rm -f "${dir}/loggedin";;
esac
`);
  await chmod(bin, 0o755);
  return { bin, dir };
}

test('parses device codes from gh output', () => {
  assert.deepEqual(parseDeviceOutput('! First copy your one-time code: 1A2B-3C4D\nOpen https://github.com/login/device'), { code: '1A2B-3C4D', url: 'https://github.com/login/device' });
  assert.deepEqual(parseDeviceOutput('nothing yet'), { code: null, url: null });
});

test('reports missing scopes', () => {
  assert.deepEqual(missingScopes(['repo']), ['workflow', 'delete_repo']);
  assert.deepEqual(missingScopes(['repo', 'workflow', 'delete_repo', 'gist']), []);
});

test('runs the device flow with the extra scopes and yields a token', async () => {
  const { bin, dir } = await fakeGh();
  const auth = new GhAuth({ ghBin: bin, env: { ...process.env, GH_TOKEN: 'should-be-stripped' } });
  assert.match(await auth.available(), /9\.9\.9/);
  assert.equal(await auth.token(), null);

  const states = [];
  auth.on('update', (s) => states.push(s));
  auth.start('login');
  while (!states.some((s) => s.state === 'done' || s.state === 'error')) await once(auth, 'update');

  const waiting = states.find((s) => s.state === 'waiting');
  assert.equal(waiting.code, 'AB12-CD34');
  assert.equal(waiting.url, 'https://github.com/login/device');
  assert.equal(auth.status().state, 'done');
  assert.equal(await auth.token(), 'gho_faketoken');

  const log = await readFile(join(dir, 'args.log'), 'utf8');
  assert.match(log, /auth login --hostname github.com --git-protocol https --web --scopes repo,workflow,delete_repo,read:org/);
  assert.doesNotMatch(log, /should-be-stripped/);
});

test('refresh mode uses gh auth refresh', async () => {
  const { bin, dir } = await fakeGh();
  const auth = new GhAuth({ ghBin: bin });
  auth.start('refresh');
  while (!['done', 'error'].includes(auth.status().state)) await once(auth, 'update');
  assert.match(await readFile(join(dir, 'args.log'), 'utf8'), /auth refresh --hostname github.com --scopes repo,workflow,delete_repo/);
});

test('surfaces gh failures', async () => {
  const { bin } = await fakeGh({ exitCode: 1 });
  const auth = new GhAuth({ ghBin: bin });
  auth.start('login');
  while (!['done', 'error'].includes(auth.status().state)) await once(auth, 'update');
  assert.equal(auth.status().state, 'error');
});

test('missing gh binary is reported', async () => {
  const auth = new GhAuth({ ghBin: '/nonexistent/gh' });
  assert.equal(await auth.available(), null);
  auth.start('login');
  while (auth.status().state !== 'error') await once(auth, 'update');
  assert.match(auth.status().error, /Could not run/);
});
