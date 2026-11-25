import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMATS, NAMED, parse, format, formatAll, convert, detectFormat, gamut, inGamut, mapToGamut,
  contrast, wcag, luminance, toOklch, toLab, toCss, nameOf,
} from '../public/js/ui/color-math.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tolerance ${tol})`);
function sameColor(a, b, msg, tol = 0.006, alphaTol = 0.004) {
  assert.ok(a && b, `${msg}: missing colour`);
  close(a.r, b.r, tol, `${msg} red`);
  close(a.g, b.g, tol, `${msg} green`);
  close(a.b, b.b, tol, `${msg} blue`);
  close(a.alpha, b.alpha, alphaTol, `${msg} alpha`);
}

// Seeded generator so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const SAMPLES = [
  { r: 0, g: 0, b: 0, alpha: 1 },
  { r: 1, g: 1, b: 1, alpha: 1 },
  { r: 0.5, g: 0.5, b: 0.5, alpha: 1 },
  { r: 1, g: 0, b: 0, alpha: 1 },
  { r: 0, g: 1, b: 0, alpha: 0.5 },
  { r: 0, g: 0, b: 1, alpha: 0 },
  { r: 212 / 255, g: 1, b: 58 / 255, alpha: 1 },
  { r: 11 / 255, g: 12 / 255, b: 16 / 255, alpha: 0.25 },
];
const rand = rng(42);
for (let i = 0; i < 24; i++) {
  SAMPLES.push({ r: Math.round(rand() * 255) / 255, g: Math.round(rand() * 255) / 255, b: Math.round(rand() * 255) / 255, alpha: i % 3 === 0 ? Math.round(rand() * 1000) / 1000 : 1 });
}

const PAIR_FORMATS = FORMATS.filter((f) => f !== 'named');

test('every format pair round-trips within tolerance', () => {
  let checked = 0;
  for (const c of SAMPLES) {
    for (const a of PAIR_FORMATS) {
      for (const b of PAIR_FORMATS) {
        const first = format(c, a);
        const viaA = parse(first);
        assert.ok(viaA, `${a} output did not parse: ${first}`);
        const second = format(viaA, b);
        const viaB = parse(second);
        assert.ok(viaB, `${b} output did not parse: ${second}`);
        // hex (without 8) drops nothing: it writes 8 digits when alpha < 1.
        sameColor(viaB, c, `${format(c, 'hex8')} via ${a} -> ${b}`);
        checked++;
      }
    }
  }
  assert.equal(checked, SAMPLES.length * PAIR_FORMATS.length ** 2);
});

test('formats parse back to the format they came from', () => {
  const c = { r: 0.2, g: 0.4, b: 0.6, alpha: 1 };
  for (const f of PAIR_FORMATS) {
    const expected = f === 'hex8' ? 'hex8' : f;
    assert.equal(detectFormat(format(c, f)), expected, f);
  }
});

test('every named colour round-trips through every format', () => {
  for (const [name, hex] of Object.entries(NAMED)) {
    const c = parse(name);
    assert.equal(c.format, 'named');
    assert.equal(format(c, 'hex'), `#${hex}`);
    for (const f of PAIR_FORMATS) sameColor(parse(format(c, f)), c, `${name} via ${f}`);
    // Synonyms (gray/grey, aqua/cyan) map to one of their names.
    assert.equal(format(parse(nameOf(c)), 'hex'), `#${hex}`);
  }
  assert.equal(format(parse('#ff0000'), 'named'), 'red');
  assert.equal(format(parse('#123456'), 'named'), null);
  assert.equal(format(parse('rgb(255 0 0 / .5)'), 'named'), null);
  assert.equal(format(parse('transparent'), 'named'), 'transparent');
  assert.equal(parse('ReBeccaPurple').format, 'named');
});

test('alpha is kept, written and read in each notation', () => {
  const c = parse('rgba(10, 20, 30, 0.4)');
  assert.equal(c.alpha, 0.4);
  assert.equal(format(c, 'hex'), '#0a141e66');
  assert.equal(format(c, 'hex8'), '#0a141e66');
  assert.match(format(c, 'rgb'), /^rgba\(10, 20, 30, 0\.4\)$/);
  assert.match(format(c, 'hsl'), /^hsla\(.*, 0\.4\)$/);
  for (const f of ['hsv', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'cmyk']) assert.match(format(c, f), / \/ 0\.4\)$/, f);
  // Opaque colours carry no alpha except in hex8.
  const o = parse('#0a141e');
  assert.equal(format(o, 'hex8'), '#0a141eff');
  for (const f of ['hex', 'rgb', 'hsl', 'hsv', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'cmyk']) assert.doesNotMatch(format(o, f), /\/|, 1\)/, f);
  // Percent alpha, short hex alpha, clamped alpha.
  assert.equal(parse('rgb(0 0 0 / 25%)').alpha, 0.25);
  close(parse('#0008').alpha, 0x88 / 255, 1e-9, 'short hex alpha');
  assert.equal(parse('hsl(0 0% 0% / 2)').alpha, 1);
  assert.equal(parse('oklch(50% 0.1 30 / 0)').alpha, 0);
});

test('accepts modern and legacy syntax variants', () => {
  const red = { r: 1, g: 0, b: 0, alpha: 1 };
  for (const s of ['red', '#f00', '#ff0000', '#ff0000ff', 'rgb(255,0,0)', 'rgb(100% 0% 0%)', 'rgba(255 0 0 / 1)',
    'hsl(0, 100%, 50%)', 'hsl(0deg 100% 50%)', 'hsl(0turn 100% 50%)', 'hsl(400grad 100% 50%)', 'hsl(6.2832rad 100% 50%)',
    'hsv(0 100% 100%)', 'hsb(0, 100%, 100%)', 'hwb(0 0% 0%)', 'cmyk(0%, 100%, 100%, 0%)', 'device-cmyk(0 1 1 0)',
    'lab(54.29% 80.8 69.89)', 'lch(54.29 106.84 40.85)', 'oklab(62.8% 0.2249 0.1258)', 'oklch(0.628 0.2577 29.23)']) {
    sameColor(parse(s), red, s, 0.01);
  }
  assert.ok(parse('  RGB( 255 , 0 , 0 )  '));
  assert.equal(parse('hsl(none 0% 50%)').r, parse('hsl(0 0% 50%)').r);
});

test('wide-gamut colours keep their values in Lab, LCH, OKLab and OKLCH and report clipping', () => {
  const wide = parse('oklch(70% 0.35 145)');
  assert.equal(inGamut(wide), false);
  const g = gamut(wide);
  assert.equal(g.inGamut, false);
  assert.ok(g.delta > 0.05);
  assert.ok(inGamut(g.clipped));
  assert.ok(inGamut(g.mapped));
  // Perceptual mapping keeps lightness and hue closer than per-channel clipping.
  const target = toOklch(wide);
  const mapped = toOklch(g.mapped);
  close(mapped.l, target.l, 0.01, 'mapped lightness');
  close(mapped.h, target.h, 2, 'mapped hue');
  // Unclipped round trips through the wide notations.
  for (const f of ['lab', 'lch', 'oklab', 'oklch']) {
    const back = toOklch(parse(format(wide, f)));
    close(back.l, 0.7, 0.002, `${f} lightness`);
    close(back.c, 0.35, 0.003, `${f} chroma`);
    close(back.h, 145, 0.3, `${f} hue`);
  }
  // sRGB notations show the clipped colour.
  assert.equal(format(wide, 'hex'), format(g.clipped, 'hex'));
  assert.match(toCss(wide), /^oklch\(/);
  assert.equal(toCss(parse('#336699')), '#336699');
  // In-gamut colours report no clipping.
  const ok = gamut(parse('#336699'));
  assert.equal(ok.inGamut, true);
  assert.equal(ok.delta, 0);
  assert.equal(format(mapToGamut(parse('#336699')), 'hex'), '#336699');
  // Lab outside sRGB.
  assert.equal(gamut(parse('lab(50% 120 -120)')).inGamut, false);
});

test('contrast ratios follow WCAG', () => {
  close(contrast('#000', '#fff'), 21, 1e-9, 'black on white');
  close(contrast('#fff', '#000'), 21, 1e-9, 'white on black');
  close(contrast('#777', '#777'), 1, 1e-9, 'same colour');
  close(contrast('#767676', '#ffffff'), 4.54, 0.01, 'grey on white');
  close(contrast('#0b0c10', '#ffffff'), 19.6, 0.1, 'app ink on white');
  // A fully transparent foreground shows the background.
  close(contrast('rgb(0 0 0 / 0)', '#fff'), 1, 1e-9, 'transparent');
  // Half-transparent black over white is mid grey.
  const half = contrast('rgb(0 0 0 / 0.5)', '#fff');
  assert.ok(half > 3 && half < 5, String(half));
  assert.deepEqual(wcag(21), { aa: true, aaa: true, aaLarge: true, aaaLarge: true });
  assert.deepEqual(wcag(4.5), { aa: true, aaa: false, aaLarge: true, aaaLarge: true });
  assert.deepEqual(wcag(3.2), { aa: false, aaa: false, aaLarge: true, aaaLarge: false });
  assert.deepEqual(wcag(1.5), { aa: false, aaa: false, aaLarge: false, aaaLarge: false });
  assert.equal(luminance(parse('#fff')), 1);
  assert.ok(Number.isNaN(contrast('not a colour', '#fff')));
});

test('invalid input is rejected', () => {
  for (const s of [undefined, null, 42, '', '   ', 'notacolor', '#ff', '#ggg', '#12345', '#1234567', 'rgb()', 'rgb(1, 2)',
    'rgb(1, 2, 3, 4, 5)', 'rgb(a, b, c)', 'hsl(10, 20%)', 'hsl(red 1% 1%)', 'lab(1 2)', 'oklch(1 2 3 4 5)', 'cmyk(1 2 3)',
    'rgb(1 2 3 / )', 'rgb(1 2 3 / 4 / 5)', 'foo(1 2 3)', 'rgb(1 2 3', 'rgb(1px 2 3)', 'x'.repeat(500)]) {
    assert.equal(parse(s), null, String(s));
  }
  assert.equal(convert('nope', 'hex'), null);
  assert.equal(convert('red', 'oklch'), format(parse('red'), 'oklch'));
  assert.throws(() => format(parse('red'), 'bogus'));
});

test('formatAll returns every notation', () => {
  const all = formatAll(parse('#d4ff3a'));
  assert.deepEqual(Object.keys(all), FORMATS);
  assert.equal(all.hex, '#d4ff3a');
  assert.equal(all.named, null);
  assert.ok(toLab(parse('#fff')).l > 99.9);
});
