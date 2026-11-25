// Recipes: a saved build request with a name and an optional schedule.
// Stored in one JSON file so schedules keep working while the browser is closed.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_RECIPES = 200;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function validateSchedule(raw) {
  if (!raw || raw.type === 'manual' || raw.type === undefined) return { type: 'manual' };
  if (raw.type === 'interval') {
    const hours = Number(raw.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) fail('An interval schedule needs a whole number of hours from 1 to 168.');
    return { type: 'interval', hours };
  }
  if (raw.type === 'daily') {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(raw.time || ''));
    if (!m) fail('A daily schedule needs a time like 02:30.');
    return { type: 'daily', time: m[0] };
  }
  return fail('Unknown schedule type.');
}

// When a schedule next falls due after `from` (server local time for daily).
export function nextRun(schedule, from) {
  if (schedule.type === 'interval') return from + schedule.hours * 3_600_000;
  if (schedule.type === 'daily') {
    const [h, m] = schedule.time.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

export class RecipeBook extends EventEmitter {
  // validate(body) -> normalised build request (throws on bad input)
  // start(request) -> build view
  constructor({ file, validate, start, now = () => Date.now() }) {
    super();
    Object.assign(this, { file, validate, start, now });
    this.recipes = [];
    this.timer = null;
  }

  async load() {
    try { const d = JSON.parse(await readFile(this.file, 'utf8')); this.recipes = Array.isArray(d.recipes) ? d.recipes : []; } catch { this.recipes = []; }
    return this;
  }

  // Writes are queued so overlapping saves cannot fight over the temporary file.
  persist() {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, recipes: this.recipes }, null, 1));
      await rename(tmp, this.file);
    };
    this.saving = (this.saving || Promise.resolve()).then(write, write);
    return this.saving.then(() => { this.emit('change'); });
  }

  list() { return this.recipes.map((r) => ({ ...r })); }
  get(idOrName) { return this.recipes.find((r) => r.id === idOrName) || this.recipes.find((r) => r.name.toLowerCase() === String(idOrName).toLowerCase()) || null; }

  async save({ id, name, request, schedule }) {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 60) fail('A recipe needs a name of 60 characters or fewer.');
    const existing = id ? this.recipes.find((r) => r.id === id) : null;
    if (id && !existing) fail('Recipe not found.', 404);
    if (this.recipes.some((r) => r.id !== id && r.name.toLowerCase() === clean.toLowerCase())) fail(`Another recipe is already called "${clean}".`, 409);
    if (!existing && this.recipes.length >= MAX_RECIPES) fail(`There can be at most ${MAX_RECIPES} recipes.`, 409);
    const req = request === undefined && existing ? existing.request : this.validate(request || {});
    const sched = schedule === undefined && existing ? existing.schedule : validateSchedule(schedule);
    const now = this.now();
    const recipe = { id: existing?.id || randomUUID(), name: clean, request: req, schedule: sched, createdAt: existing?.createdAt || now, updatedAt: now, nextAt: nextRun(sched, now), lastRun: existing?.lastRun || null };
    if (existing) this.recipes[this.recipes.indexOf(existing)] = recipe; else this.recipes.push(recipe);
    await this.persist();
    return { ...recipe };
  }

  async remove(id) {
    const i = this.recipes.findIndex((r) => r.id === id);
    if (i < 0) fail('Recipe not found.', 404);
    this.recipes.splice(i, 1);
    await this.persist();
  }

  async run(idOrName, { scheduled = false } = {}) {
    const r = this.get(idOrName);
    if (!r) fail('Recipe not found.', 404);
    const at = this.now();
    let build = null;
    let error = null;
    try { build = await this.start(this.validate(r.request)); } catch (err) { error = err.message; }
    r.lastRun = { at, scheduled, buildId: build?.id || null, error };
    if (scheduled) r.nextAt = nextRun(r.schedule, at);
    await this.persist();
    if (error && !scheduled) fail(error, 409);
    return { recipe: { ...r }, build };
  }

  // Remembers how each recipe's last build ended.
  async noteBuild(job) {
    const r = this.recipes.find((x) => x.lastRun?.buildId === job.id);
    if (!r || !['ready', 'failed'].includes(job.status) || r.lastRun.status === job.status) return;
    r.lastRun = { ...r.lastRun, status: job.status, ms: job.updatedAt - job.createdAt };
    await this.persist();
  }

  async tick() {
    const now = this.now();
    const ran = [];
    for (const r of this.recipes) {
      if (r.schedule.type === 'manual' || !r.nextAt || r.nextAt > now) continue;
      ran.push(await this.run(r.id, { scheduled: true }));
    }
    return ran;
  }

  startClock(everyMs = 30_000) {
    this.stopClock();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, everyMs);
    this.timer.unref?.();
  }

  stopClock() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
