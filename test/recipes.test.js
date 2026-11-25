import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeBook, validateSchedule, nextRun } from '../src/recipes.js';
import { validateRequest } from '../src/workflow.js';

const request = { kind: 'scripts', repo: 'owner/repo', scripts: ['build.sh'], runner: 'ubuntu-latest', outputs: 'dist/**' };

async function book() {
  const dir = await mkdtemp(join(tmpdir(), 'recipes-'));
  let clock = new Date(2026, 10, 25, 10, 0, 0).getTime();
  const started = [];
  const b = new RecipeBook({ file: join(dir, 'recipes.json'), validate: validateRequest, now: () => clock, start: async (req) => { if (req.repo === 'owner/broken') throw new Error('Not signed in.'); const build = { id: `b${started.length + 1}`, req }; started.push(build); return build; } });
  await b.load();
  return { b, dir, started, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('schedules validate and compute the next run', () => {
  assert.deepEqual(validateSchedule(undefined), { type: 'manual' });
  assert.deepEqual(validateSchedule({ type: 'interval', hours: 6 }), { type: 'interval', hours: 6 });
  assert.throws(() => validateSchedule({ type: 'interval', hours: 0 }), /1 to 168/);
  assert.throws(() => validateSchedule({ type: 'daily', time: '25:00' }), /02:30/);
  assert.throws(() => validateSchedule({ type: 'cron' }), /Unknown schedule/);
  const at = new Date(2026, 10, 25, 10, 0, 0).getTime();
  assert.equal(nextRun({ type: 'manual' }, at), null);
  assert.equal(nextRun({ type: 'interval', hours: 2 }, at), at + 7_200_000);
  assert.equal(new Date(nextRun({ type: 'daily', time: '02:00' }, at)).getDate(), 26);
  assert.equal(new Date(nextRun({ type: 'daily', time: '23:30' }, at)).getHours(), 23);
});

test('save, rename, run by name, and survive a restart', async () => {
  const { b, dir, started } = await book();
  const r = await b.save({ name: 'Nightly', request, schedule: { type: 'daily', time: '02:00' } });
  assert.equal(r.request.repo, 'owner/repo');
  assert.equal(r.request.mode, 'private', 'the request is stored normalised');
  await assert.rejects(b.save({ name: 'nightly', request }), /already called/);
  await assert.rejects(b.save({ name: '', request }), /needs a name/);
  await assert.rejects(b.save({ name: 'Bad', request: { kind: 'scripts', repo: 'nope' } }), (e) => e.status === 400);
  const renamed = await b.save({ id: r.id, name: 'Nightly installer' });
  assert.deepEqual(renamed.schedule, { type: 'daily', time: '02:00' }, 'unchanged parts are kept');
  const { build, recipe } = await b.run('nightly installer');
  assert.equal(build.id, 'b1');
  assert.equal(recipe.lastRun.buildId, 'b1');
  assert.equal(started[0].req.repo, 'owner/repo');
  await b.noteBuild({ id: 'b1', status: 'ready', createdAt: 0, updatedAt: 42_000 });
  const again = await new RecipeBook({ file: join(dir, 'recipes.json'), validate: validateRequest, start: async () => ({}) }).load();
  assert.equal(again.list()[0].lastRun.status, 'ready');
  assert.equal(again.list()[0].lastRun.ms, 42_000);
  assert.equal(JSON.parse(await readFile(join(dir, 'recipes.json'), 'utf8')).version, 1);
  await b.remove(r.id);
  assert.deepEqual(b.list(), []);
  await assert.rejects(b.run('gone'), (e) => e.status === 404);
});

test('the clock starts due recipes once and schedules the next run', async () => {
  const { b, started, advance, now } = await book();
  await b.save({ name: 'Every two hours', request, schedule: { type: 'interval', hours: 2 } });
  await b.save({ name: 'Manual', request });
  assert.deepEqual(await b.tick(), [], 'nothing is due yet');
  advance(2 * 3_600_000 + 1000);
  assert.equal((await b.tick()).length, 1);
  assert.equal(started.length, 1);
  assert.equal(b.get('Every two hours').lastRun.scheduled, true);
  assert.equal(b.get('Every two hours').nextAt, now() + 2 * 3_600_000);
  assert.deepEqual(await b.tick(), [], 'it does not start twice');
});

test('a scheduled run that cannot start is recorded and tried again next time', async () => {
  const { b, advance } = await book();
  await b.save({ name: 'Broken', request: { ...request, repo: 'owner/broken' }, schedule: { type: 'interval', hours: 1 } });
  advance(3_600_001);
  const [ran] = await b.tick();
  assert.equal(ran.build, null);
  assert.equal(b.get('Broken').lastRun.error, 'Not signed in.');
  assert.ok(b.get('Broken').nextAt > 0);
  await assert.rejects(b.run('Broken'), /Not signed in/);
});
