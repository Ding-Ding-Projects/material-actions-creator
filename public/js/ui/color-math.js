// Pure colour maths: parsing, formatting and conversion between CSS colour
// notations, sRGB gamut checks and WCAG contrast. No DOM access, so it can be
// imported from Node tests as well as the browser.
//
// Internal colour: { r, g, b, alpha } in gamma-encoded sRGB, channels 0..1.
// Channels may fall outside 0..1 when a wide-gamut notation (Lab, LCH, OKLab,
// OKLCH) describes a colour sRGB cannot show; formatting to an sRGB-based
// notation clips it, and gamut() reports the clipping.

export const FORMATS = ['named', 'hex', 'hex8', 'rgb', 'hsl', 'hsv', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'cmyk'];

export const FORMAT_LABELS = {
  named: 'Named', hex: 'HEX', hex8: 'HEX8', rgb: 'RGB', hsl: 'HSL', hsv: 'HSV / HSB', hwb: 'HWB',
  lab: 'CIE Lab', lch: 'CIE LCH', oklab: 'OKLab', oklch: 'OKLCH', cmyk: 'CMYK',
};

// ---------- named colours (CSS Color Module Level 4) ----------
export const NAMED = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
  bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50',
  cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b',
  darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
  darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
  darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969',
  dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
  lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
  maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db',
  mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500',
  orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
  powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f',
  royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
  seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
  slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080',
  thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
  whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
};

// ---------- small helpers ----------
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const mod360 = (h) => ((h % 360) + 360) % 360;
const EPS = 1e-9;

function round(x, digits) {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
// Number to short text: no trailing zeros, no "-0".
const num = (x, digits) => String(round(x, digits));

function mul(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// ---------- matrices (CSS Color Module Level 4 sample code) ----------
const LIN_SRGB_TO_XYZ = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const XYZ_TO_LIN_SRGB = invert(LIN_SRGB_TO_XYZ);
const D65_TO_D50 = [
  [1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
  [0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
  [-0.009243040646204504, 0.015055191490298152, 0.7518742814281371],
];
const D50_TO_D65 = invert(D65_TO_D50);
const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const XYZ_TO_LMS = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_XYZ = invert(XYZ_TO_LMS);
const LMS_TO_OKLAB = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757660377118],
];
const OKLAB_TO_LMS = invert(LMS_TO_OKLAB);

// ---------- channel transfer ----------
function toLinear(c) {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
}
function fromLinear(c) {
  const a = Math.abs(c);
  return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055);
}

// ---------- space conversions (all take/return plain arrays) ----------
function rgbToXyz({ r, g, b }) { return mul(LIN_SRGB_TO_XYZ, [toLinear(r), toLinear(g), toLinear(b)]); }
function xyzToRgb(xyz, alpha = 1) {
  const [r, g, b] = mul(XYZ_TO_LIN_SRGB, xyz).map(fromLinear);
  return { r, g, b, alpha };
}

const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

function xyzToLab(xyz65) {
  const xyz = mul(D65_TO_D50, xyz65).map((v, i) => v / D50_WHITE[i]);
  const f = xyz.map((v) => (v > LAB_E ? Math.cbrt(v) : (LAB_K * v + 16) / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
function labToXyz([L, a, b]) {
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > LAB_E ? f0 ** 3 : (116 * f0 - 16) / LAB_K;
  const y = L > LAB_K * LAB_E ? f1 ** 3 : L / LAB_K;
  const z = f2 ** 3 > LAB_E ? f2 ** 3 : (116 * f2 - 16) / LAB_K;
  return mul(D50_TO_D65, [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]]);
}
function xyzToOklab(xyz) { return mul(LMS_TO_OKLAB, mul(XYZ_TO_LMS, xyz).map(Math.cbrt)); }
function oklabToXyz(lab) { return mul(LMS_TO_XYZ, mul(OKLAB_TO_LMS, lab).map((v) => v ** 3)); }

function toPolar([L, a, b]) {
  const C = Math.hypot(a, b);
  const H = C < 1e-6 ? 0 : mod360((Math.atan2(b, a) * 180) / Math.PI);
  return [L, C, H];
}
function fromPolar([L, C, H]) {
  const rad = (H * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

// HSV / HSL / HWB (hue in degrees, other channels 0..1). Inputs are clipped to sRGB.
export function rgbToHsv({ r, g, b }) {
  [r, g, b] = [clamp(r), clamp(g), clamp(b)];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > EPS) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = mod360(h * 60);
  }
  return { h, s: max < EPS ? 0 : d / max, v: max };
}
export function hsvToRgb({ h, s, v }, alpha = 1) {
  h = mod360(h);
  s = clamp(s); v = clamp(v);
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5), g: f(3), b: f(1), alpha };
}
function hsvToHsl({ h, s, v }) {
  const l = v * (1 - s / 2);
  const sl = l < EPS || l > 1 - EPS ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s: sl, l };
}
function hslToHsv({ h, s, l }) {
  s = clamp(s); l = clamp(l);
  const v = l + s * Math.min(l, 1 - l);
  return { h, s: v < EPS ? 0 : 2 * (1 - l / v), v };
}

// ---------- public conversions ----------
// Every to* function takes the internal colour and returns plain channels.
export function toHsv(c) { return { ...rgbToHsv(c), alpha: c.alpha }; }
export function toHsl(c) { return { ...hsvToHsl(rgbToHsv(c)), alpha: c.alpha }; }
export function toHwb(c) {
  const { h, s, v } = rgbToHsv(c);
  return { h, w: (1 - s) * v, b: 1 - v, alpha: c.alpha };
}
export function toLab(c) { const [l, a, b] = xyzToLab(rgbToXyz(c)); return { l, a, b, alpha: c.alpha }; }
export function toLch(c) { const [l, ch, h] = toPolar(xyzToLab(rgbToXyz(c))); return { l, c: ch, h, alpha: c.alpha }; }
export function toOklab(c) { const [l, a, b] = xyzToOklab(rgbToXyz(c)); return { l, a, b, alpha: c.alpha }; }
export function toOklch(c) { const [l, ch, h] = toPolar(xyzToOklab(rgbToXyz(c))); return { l, c: ch, h, alpha: c.alpha }; }
export function toCmyk(c) {
  const r = clamp(c.r), g = clamp(c.g), b = clamp(c.b);
  const k = 1 - Math.max(r, g, b);
  if (k > 1 - EPS) return { c: 0, m: 0, y: 0, k: 1, alpha: c.alpha };
  return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k, alpha: c.alpha };
}

export function fromHsv({ h, s, v, alpha = 1 }) { return hsvToRgb({ h, s, v }, alpha); }
export function fromHsl({ h, s, l, alpha = 1 }) { return hsvToRgb(hslToHsv({ h, s, l }), alpha); }
export function fromHwb({ h, w, b, alpha = 1 }) {
  w = clamp(w); b = clamp(b);
  if (w + b >= 1) { const g = w / (w + b); return { r: g, g, b: g, alpha }; }
  const v = 1 - b;
  return hsvToRgb({ h, s: 1 - w / v, v }, alpha);
}
export function fromLab({ l, a, b, alpha = 1 }) { return xyzToRgb(labToXyz([l, a, b]), alpha); }
export function fromLch({ l, c, h, alpha = 1 }) { return xyzToRgb(labToXyz(fromPolar([l, c, h])), alpha); }
export function fromOklab({ l, a, b, alpha = 1 }) { return xyzToRgb(oklabToXyz([l, a, b]), alpha); }
export function fromOklch({ l, c, h, alpha = 1 }) { return xyzToRgb(oklabToXyz(fromPolar([l, c, h])), alpha); }
export function fromCmyk({ c, m, y, k, alpha = 1 }) {
  [c, m, y, k] = [clamp(c), clamp(m), clamp(y), clamp(k)];
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k), alpha };
}

// ---------- gamut ----------
const GAMUT_EPS = 1e-4;

export function inGamut(c) {
  return [c.r, c.g, c.b].every((v) => v >= -GAMUT_EPS && v <= 1 + GAMUT_EPS);
}

// Per-channel clip (what a browser shows for an out-of-gamut sRGB value).
export function clip(c) {
  return { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b), alpha: clamp(c.alpha ?? 1) };
}

// Perceptual mapping: lower OKLCH chroma, keeping lightness and hue, until the
// colour fits sRGB (the CSS Color 4 approach, simplified to a binary search).
export function mapToGamut(c) {
  if (inGamut(c)) return clip(c);
  const { l, c: chroma, h, alpha } = toOklch(c);
  if (l >= 1) return { r: 1, g: 1, b: 1, alpha };
  if (l <= 0) return { r: 0, g: 0, b: 0, alpha };
  let lo = 0, hi = chroma;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(fromOklch({ l, c: mid, h, alpha }))) lo = mid; else hi = mid;
  }
  return clip(fromOklch({ l, c: lo, h, alpha }));
}

// Reports whether the colour fits sRGB, the clipped value, and how far each
// channel had to move (0 when in gamut).
export function gamut(c) {
  const clipped = clip(c);
  const delta = Math.max(Math.abs(c.r - clipped.r), Math.abs(c.g - clipped.g), Math.abs(c.b - clipped.b));
  return { inGamut: inGamut(c), clipped, mapped: mapToGamut(c), delta };
}

// ---------- contrast (WCAG 2.x) ----------
export function luminance(c) {
  const { r, g, b } = clip(c);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

// Composites a translucent colour over an opaque background.
export function over(fg, bg) {
  const f = clip(fg), b = clip({ ...bg, alpha: 1 });
  const a = f.alpha;
  return { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), alpha: 1 };
}

// Contrast ratio 1..21. Accepts colour objects or strings.
export function contrast(fg, bg) {
  const back = typeof bg === 'string' ? parse(bg) : bg;
  const front = typeof fg === 'string' ? parse(fg) : fg;
  if (!front || !back) return NaN;
  const l1 = luminance(over(front, back));
  const l2 = luminance(back);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Pass/fail for normal and large text.
export function wcag(ratio) {
  return { aa: ratio >= 4.5, aaa: ratio >= 7, aaLarge: ratio >= 3, aaaLarge: ratio >= 4.5 };
}

// ---------- parsing ----------
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';

function hexToColor(hex) {
  let h = hex.toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), alpha: h.length === 8 ? n(6) : 1 };
}

// Splits function arguments: commas or spaces, optional "/ alpha".
// count: channels expected before the alpha (legacy comma syntax puts alpha last).
function splitArgs(body, count) {
  const slash = body.split('/');
  if (slash.length > 2) return null;
  const parts = slash[0].trim().split(/\s*,\s*|\s+/).filter(Boolean);
  let alpha = slash[1]?.trim();
  if (alpha === '') return null;
  if (alpha === undefined && body.includes(',') && parts.length === count + 1) alpha = parts.pop();
  return { parts, alpha };
}

// A token with optional unit/percent. pctScale: what 100% means.
function value(token, { pctScale = 1, allowPct = true, allowNum = true } = {}) {
  if (token === undefined) return NaN;
  const t = token.trim().toLowerCase();
  if (t === 'none') return 0;
  const m = t.match(new RegExp(`^(${NUM})(%?)$`));
  if (!m) return NaN;
  const n = Number(m[1]);
  if (m[2] === '%') return allowPct ? (n / 100) * pctScale : NaN;
  return allowNum ? n : NaN;
}

function hue(token) {
  if (token === undefined) return NaN;
  const t = token.trim().toLowerCase();
  if (t === 'none') return 0;
  const m = t.match(new RegExp(`^(${NUM})(deg|rad|grad|turn)?$`));
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2] || 'deg';
  return unit === 'deg' ? n : unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : n * 360;
}

function alphaValue(token) {
  if (token === undefined) return 1;
  const a = value(token);
  return Number.isFinite(a) ? clamp(a) : NaN;
}

const allFinite = (...xs) => xs.every(Number.isFinite);

// Parses any supported notation. Returns { r, g, b, alpha, format } or null.
export function parse(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s || s.length > 200) return null;

  if (s === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0, format: 'named' };
  if (NAMED[s]) return { ...hexToColor(NAMED[s]), format: 'named' };

  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const c = hexToColor(hex[1]);
    return { ...c, format: hex[1].length === 4 || hex[1].length === 8 ? 'hex8' : 'hex' };
  }

  const fn = s.match(/^([a-z-]+)\(\s*(.*?)\s*\)$/);
  if (!fn) return null;
  const name = fn[1];
  const args = splitArgs(fn[2], /cmyk/.test(name) ? 4 : 3);
  if (!args) return null;
  const { parts } = args;
  const alpha = alphaValue(args.alpha);
  if (!Number.isFinite(alpha)) return null;
  let c = null;
  let format = name;

  switch (name) {
    case 'rgb': case 'rgba': {
      if (parts.length !== 3) return null;
      const ch = parts.map((p) => value(p, { pctScale: 255 }) / 255);
      if (!allFinite(...ch)) return null;
      c = { r: clamp(ch[0]), g: clamp(ch[1]), b: clamp(ch[2]), alpha };
      format = 'rgb';
      break;
    }
    case 'hsl': case 'hsla': {
      if (parts.length !== 3) return null;
      const h = hue(parts[0]);
      const sat = value(parts[1], { pctScale: 100 }) / 100;
      const l = value(parts[2], { pctScale: 100 }) / 100;
      if (!allFinite(h, sat, l)) return null;
      c = fromHsl({ h, s: sat, l, alpha });
      format = 'hsl';
      break;
    }
    case 'hsv': case 'hsva': case 'hsb': case 'hsba': {
      if (parts.length !== 3) return null;
      const h = hue(parts[0]);
      const sat = value(parts[1], { pctScale: 100 }) / 100;
      const v = value(parts[2], { pctScale: 100 }) / 100;
      if (!allFinite(h, sat, v)) return null;
      c = fromHsv({ h, s: sat, v, alpha });
      format = 'hsv';
      break;
    }
    case 'hwb': {
      if (parts.length !== 3) return null;
      const h = hue(parts[0]);
      const w = value(parts[1], { pctScale: 100 }) / 100;
      const b = value(parts[2], { pctScale: 100 }) / 100;
      if (!allFinite(h, w, b)) return null;
      c = fromHwb({ h, w, b, alpha });
      break;
    }
    case 'lab': {
      if (parts.length !== 3) return null;
      const l = value(parts[0], { pctScale: 100 });
      const a = value(parts[1], { pctScale: 125 });
      const b = value(parts[2], { pctScale: 125 });
      if (!allFinite(l, a, b)) return null;
      c = fromLab({ l: Math.max(0, l), a, b, alpha });
      break;
    }
    case 'lch': {
      if (parts.length !== 3) return null;
      const l = value(parts[0], { pctScale: 100 });
      const ch = value(parts[1], { pctScale: 150 });
      const h = hue(parts[2]);
      if (!allFinite(l, ch, h)) return null;
      c = fromLch({ l: Math.max(0, l), c: Math.max(0, ch), h, alpha });
      break;
    }
    case 'oklab': {
      if (parts.length !== 3) return null;
      const l = value(parts[0], { pctScale: 1 });
      const a = value(parts[1], { pctScale: 0.4 });
      const b = value(parts[2], { pctScale: 0.4 });
      if (!allFinite(l, a, b)) return null;
      c = fromOklab({ l: clamp(l), a, b, alpha });
      break;
    }
    case 'oklch': {
      if (parts.length !== 3) return null;
      const l = value(parts[0], { pctScale: 1 });
      const ch = value(parts[1], { pctScale: 0.4 });
      const h = hue(parts[2]);
      if (!allFinite(l, ch, h)) return null;
      c = fromOklch({ l: clamp(l), c: Math.max(0, ch), h, alpha });
      break;
    }
    case 'cmyk': case 'cmyka': case 'device-cmyk': {
      if (parts.length !== 4) return null;
      const ch = parts.map((p) => value(p, { pctScale: 1 }));
      if (!allFinite(...ch)) return null;
      c = fromCmyk({ c: ch[0], m: ch[1], y: ch[2], k: ch[3], alpha });
      format = 'cmyk';
      break;
    }
    default:
      return null;
  }
  if (!c || !allFinite(c.r, c.g, c.b, c.alpha)) return null;
  return { r: c.r, g: c.g, b: c.b, alpha: c.alpha, format };
}

// Which notation a string uses, or null when it is not a colour.
export function detectFormat(input) {
  return parse(input)?.format ?? null;
}

// ---------- formatting ----------
const byte = (x) => Math.round(clamp(x) * 255);
const hex2 = (x) => byte(x).toString(16).padStart(2, '0');
const pct = (x, d = 1) => `${num(x * 100, d)}%`;
const alphaSuffix = (a) => (a < 1 ? ` / ${num(a, 3)}` : '');

export function nameOf(c) {
  if (c.alpha === 0) return 'transparent';
  if (c.alpha < 1 || !inGamut(c)) return null;
  const hex = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  for (const [name, value] of Object.entries(NAMED)) if (value === hex) return name;
  return null;
}

// Formats the colour in one notation. Returns null only for "named" when no
// CSS name matches exactly.
export function format(color, fmt = 'hex') {
  const c = { alpha: 1, ...color };
  const s = clip(c);
  switch (fmt) {
    case 'named': return nameOf(c);
    case 'hex': return `#${hex2(s.r)}${hex2(s.g)}${hex2(s.b)}${s.alpha < 1 ? hex2(s.alpha) : ''}`;
    case 'hex8': return `#${hex2(s.r)}${hex2(s.g)}${hex2(s.b)}${hex2(s.alpha)}`;
    case 'rgb': return s.alpha < 1
      ? `rgba(${byte(s.r)}, ${byte(s.g)}, ${byte(s.b)}, ${num(s.alpha, 3)})`
      : `rgb(${byte(s.r)}, ${byte(s.g)}, ${byte(s.b)})`;
    case 'hsl': {
      const { h, s: sat, l } = toHsl(s);
      return s.alpha < 1
        ? `hsla(${num(h, 1)}, ${pct(sat)}, ${pct(l)}, ${num(s.alpha, 3)})`
        : `hsl(${num(h, 1)}, ${pct(sat)}, ${pct(l)})`;
    }
    case 'hsv': {
      const { h, s: sat, v } = toHsv(s);
      return `hsv(${num(h, 1)} ${pct(sat)} ${pct(v)}${alphaSuffix(s.alpha)})`;
    }
    case 'hwb': {
      const { h, w, b } = toHwb(s);
      return `hwb(${num(h, 1)} ${pct(w)} ${pct(b)}${alphaSuffix(s.alpha)})`;
    }
    case 'lab': { const { l, a, b } = toLab(c); return `lab(${num(l, 2)}% ${num(a, 2)} ${num(b, 2)}${alphaSuffix(s.alpha)})`; }
    case 'lch': { const { l, c: ch, h } = toLch(c); return `lch(${num(l, 2)}% ${num(ch, 2)} ${num(h, 2)}${alphaSuffix(s.alpha)})`; }
    case 'oklab': { const { l, a, b } = toOklab(c); return `oklab(${pct(l, 2)} ${num(a, 4)} ${num(b, 4)}${alphaSuffix(s.alpha)})`; }
    case 'oklch': { const { l, c: ch, h } = toOklch(c); return `oklch(${pct(l, 2)} ${num(ch, 4)} ${num(h, 2)}${alphaSuffix(s.alpha)})`; }
    case 'cmyk': {
      const { c: cy, m, y, k } = toCmyk(s);
      return `device-cmyk(${pct(cy)} ${pct(m)} ${pct(y)} ${pct(k)}${alphaSuffix(s.alpha)})`;
    }
    default: throw new Error(`Unknown colour format: ${fmt}`);
  }
}

// Every notation at once: { named, hex, hex8, ... }.
export function formatAll(color) {
  const out = {};
  for (const f of FORMATS) out[f] = format(color, f);
  return out;
}

// Converts a string from any notation to another. Returns null on invalid input.
export function convert(input, fmt) {
  const c = parse(input);
  return c ? format(c, fmt) : null;
}

// A CSS value a browser can render: sRGB hex when it fits, otherwise OKLCH so
// wide-gamut colours survive on capable displays.
export function toCss(color) {
  return inGamut(color) ? format(color, 'hex') : format(color, 'oklch');
}
