// Disco stage rendering helpers (DESIGN-BEATSNAP section 9): lit dance floor patterns, mirror ball with
// light specks, sweeping spotlights, bobbing crowd. All animation phases derive from the visual song time
// (beatFloat), never from timers. Cross-module reads (intensity, fever, settings) are feature-checked.
import { beatInfoAt, pulseAt } from '../core/beatMath.js';
import { hash01 } from '../core/rng.js';
import { W } from './constants.js';

export const LEVEL_NAMES = {
  bar: '強拍', half: '半小節', beat: '正拍', eighth: '後拍', sixteenth: '十六分', thirtysecond: '三十二分',
};
export const COMBO_NAMES = { eighth: '八分連斬', bar: '小節終結', fill: '過門重擊' };
export const LEVEL_COLORS = {
  bar: '#ffd24d', half: '#ffa14d', beat: '#4df3ff', eighth: '#ff4fd8', sixteenth: '#b58cff', thirtysecond: '#8f86b8',
};

export const PALETTE = ['#4df3ff', '#ff4fd8', '#ffd24d', '#7dff9a', '#a66bff'];
export const PALETTE_HUE = [186, 316, 46, 135, 265];

/** The game instance the stage reads from (set from Level.onBeat; ignored when stale, e.g. menu idle). */
export const stage = { game: null, light: 1, lightT: 0, intCache: { bar: NaN, v: 'mid' } };
export function bindStage(game) { stage.game = game; }

export function intensityOf(game, barIndex) {
  try {
    const v = game && typeof game.intensityAtBar === 'function' ? game.intensityAtBar(barIndex) : 'mid';
    return v === 'low' || v === 'high' ? v : 'mid';
  } catch { return 'mid'; }
}

/** Snapshot of everything the renderers need for this frame. */
export function stageInfo(vst, bpm) {
  const b = beatInfoAt(vst, bpm);
  const g = stage.game;
  const live = !!g && Math.abs((g.vst ?? -1e9) - vst) < 1;
  let intensity = 'mid'; let fever = false; let armed = false; let reduce = false;
  if (live) {
    const bar = Math.max(0, b.barIndex);
    if (stage.intCache.bar !== bar) { stage.intCache = { bar, v: intensityOf(g, bar) }; }
    intensity = stage.intCache.v;
    fever = !!(g.fever && g.fever.active);
    armed = !!(g.fever && g.fever.armed && !g.fever.active);
    reduce = !!(g.settings && g.settings.reduceFlashing);
  }
  const target = fever ? 1.15 : intensity === 'low' ? 0.55 : intensity === 'high' ? 1.0 : 0.82;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const dt = Math.min(0.1, Math.max(0, (now - stage.lightT) / 1000));
  stage.lightT = now;
  stage.light += (target - stage.light) * Math.min(1, dt * 3);
  return { b, intensity, fever, armed, reduce, light: stage.light, live };
}

const hsl = (h, s, l, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;

// ---------------------------------------------------------------- floor

const PATTERNS = {
  low: ['wave', 'checker'],
  mid: ['checker', 'wave', 'radial', 'checker'],
  high: ['checker', 'radial', 'stripes', 'wave', 'radial', 'checker', 'stripes', 'radial'],
};

export function patternFor(info) {
  const set = PATTERNS[info.intensity] || PATTERNS.mid;
  // low: change once per bar; others: every beat
  const idx = info.intensity === 'low' ? Math.floor(info.b.beatIndex / 4) : info.b.beatIndex;
  return set[((idx % set.length) + set.length) % set.length];
}

/** Light amount 0..1 of floor tile (column i, row j) for the current pattern/beat. */
export function tileLit(i, j, center, pattern, bi) {
  const d = Math.abs(i - center);
  switch (pattern) {
    case 'checker': return ((i + j + bi) & 1) === 0 ? 1 : 0;
    case 'wave': return (((i + j * 2 - bi * 2) % 8) + 8) % 8 < 3 ? 1 : 0;
    case 'radial': return ((d + j * 2 + bi * 3) % 6 + 6) % 6 < 2 ? 1 : 0;
    case 'stripes': return ((i + bi) & 3) === 0 ? 1 : (j === ((bi % 4 + 4) % 4) ? 0.7 : 0);
    default: return 0;
  }
}

export function tileColor(i, j, info, lit) {
  const b = info.b;
  if (info.fever) {
    return { h: b.beatFloat * 70 + i * 24 + j * 38, s: 100, l: 58 };
  }
  const hi = PALETTE_HUE[(((i >> 1) + j + b.beatIndex) % 5 + 5) % 5];
  void lit;
  return { h: hi, s: 100, l: 60 };
}

// ---------------------------------------------------------------- backdrop pieces

let skyCanvas = null;
function skyLayer(H) {
  if (skyCanvas || typeof document === 'undefined') return skyCanvas;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 430);
  sky.addColorStop(0, '#05010f');
  sky.addColorStop(0.5, '#1a0540');
  sky.addColorStop(1, '#5d1263');
  x.fillStyle = sky; x.fillRect(0, 0, W, H);
  // back-wall truss: faint vertical LED strips and horizontal rails
  x.strokeStyle = 'rgba(160,120,255,0.10)'; x.lineWidth = 1;
  for (let px = 0; px <= W; px += 48) { x.beginPath(); x.moveTo(px + 0.5, 0); x.lineTo(px + 0.5, 430); x.stroke(); }
  for (const py of [90, 180, 270]) { x.beginPath(); x.moveTo(0, py + 0.5); x.lineTo(W, py + 0.5); x.stroke(); }
  skyCanvas = c;
  return c;
}

export function drawSky(ctx, H, info) {
  const c = skyLayer(H);
  if (c) ctx.drawImage(c, 0, 0);
  else { ctx.fillStyle = '#1a0540'; ctx.fillRect(0, 0, W, H); }
  void info;
}

export function drawHalo(ctx, info) {
  const b = info.b;
  const p = pulseAt(b.beatPhase, b.beatInBar);
  const cx = W / 2; const cy = 70;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 3; k++) {
    const r = 70 + k * 56 + 10 * p;
    ctx.strokeStyle = info.fever
      ? hsl(b.beatFloat * 60 + k * 70, 100, 60, 0.16 * info.light)
      : `rgba(${k === 1 ? '255,79,216' : '77,243,255'},${0.10 * info.light + 0.06 * p})`;
    ctx.lineWidth = 2 + (k === 0 ? 2 * p : 0);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/** Sweeping spotlight beams; the sweep has a 2-bar (8 beat) period. */
export function drawBeams(ctx, info) {
  const b = info.b;
  const n = info.fever ? 4 : 2;
  const L = 600; const spread = 0.06;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < n; k++) {
    const ox = n === 2 ? (k === 0 ? 150 : W - 150) : (k + 0.5) * (W / n);
    const lean = ox < W / 2 ? 0.18 : -0.18;
    const th = Math.sin((Math.PI * 2 * b.beatFloat) / 8 + k * 2.1) * 0.5 + lean;
    const ex = ox + Math.sin(th) * L; const ey = -10 + Math.cos(th) * L;
    const nx = Math.cos(th); const ny = -Math.sin(th);
    const w = L * spread;
    const col = info.fever ? b.beatFloat * 45 + k * 90 : PALETTE_HUE[(b.barIndex + k * 2 + 5000) % 5];
    const a = 0.34 * info.light;
    const g = ctx.createLinearGradient(ox, -10, ex, ey);
    g.addColorStop(0, hsl(col, 100, 70, a));
    g.addColorStop(1, hsl(col, 100, 60, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(ox - 4, -10); ctx.lineTo(ox + 4, -10);
    ctx.lineTo(ex + nx * w, ey + ny * w); ctx.lineTo(ex - nx * w, ey - ny * w);
    ctx.closePath(); ctx.fill();
    // light pool where the beam meets the stage
    const t = 420 / Math.max(0.2, Math.cos(th));
    const px = ox + Math.sin(th) * t;
    const pg = ctx.createRadialGradient(px, 424, 2, px, 424, 90);
    pg.addColorStop(0, hsl(col, 100, 70, 0.30 * info.light)); pg.addColorStop(1, hsl(col, 100, 60, 0));
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.ellipse(px, 424, 90, 18, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function drawCrowd(ctx, camX, vst, bpm, info) {
  const b = info.b;
  const wild = info.fever || info.intensity === 'high';
  const dim = info.intensity === 'low' ? 0.8 : 1;
  for (let row = 0; row < 2; row++) {
    const par = camX * (row ? 0.62 : 0.5);
    const sp = row ? 52 : 44;
    const i0 = Math.floor(par / sp) - 1;
    const n = Math.ceil(W / sp) + 3;
    const base = row ? 440 : 428;
    const scale = row ? 1.12 : 0.9;
    for (let i = i0; i < i0 + n; i++) {
      const hr = hash01(i + row * 977, 31);
      const bx = i * sp - par + hr * 18;
      const delay = hash01(i + row * 977, 32) * 0.07;
      const bb = beatInfoAt(vst - delay, bpm);
      const p = pulseAt(bb.beatPhase, bb.beatInBar);
      let jump = 0;
      if (wild && bb.beatInBar === 0) jump = Math.exp(-bb.beatPhase * 4.5) * 22;
      else if (info.fever) jump = p * 10;
      const nod = p * 4;
      const hy = base - 46 * scale - nod - jump;
      ctx.save();
      ctx.translate(bx, 0);
      ctx.fillStyle = row ? '#0a0220' : '#14052e';
      // shoulders / torso
      ctx.beginPath();
      ctx.moveTo(-15 * scale, base - jump);
      ctx.quadraticCurveTo(-16 * scale, hy + 16 * scale, 0, hy + 12 * scale);
      ctx.quadraticCurveTo(16 * scale, hy + 16 * scale, 15 * scale, base - jump);
      ctx.closePath(); ctx.fill();
      // head
      ctx.beginPath(); ctx.arc(0, hy, 8.5 * scale, 0, Math.PI * 2); ctx.fill();
      // raised arm(s)
      if (wild && hr > 0.35) {
        const wave = Math.sin(b.beatFloat * Math.PI + i * 1.7) * 6;
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 4 * scale; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-10 * scale, hy + 18 * scale); ctx.lineTo(-18 * scale + wave, hy - 12 * scale); ctx.stroke();
        if (hr > 0.7) { ctx.beginPath(); ctx.moveTo(10 * scale, hy + 18 * scale); ctx.lineTo(18 * scale - wave, hy - 14 * scale); ctx.stroke(); }
      }
      // rim light from the lights above
      const hue = info.fever ? b.beatFloat * 40 + i * 30 : PALETTE_HUE[((i % 5) + 5) % 5];
      ctx.strokeStyle = hsl(hue, 100, 62, (0.35 + 0.35 * p) * info.light * dim);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, hy, 8.5 * scale, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.restore();
    }
  }
}

/** Mirror ball plus the light specks it throws on the walls (positions follow beatFloat). */
export function drawMirrorBall(ctx, info) {
  const b = info.b;
  const cx = W / 2; const cy = 68; const R = 32;
  const rot = b.beatFloat * 0.42;
  const p = pulseAt(b.beatPhase, b.beatInBar);
  ctx.save();
  // rope
  ctx.strokeStyle = 'rgba(200,190,255,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, -4); ctx.lineTo(cx, cy - R); ctx.stroke();
  // glow
  ctx.globalCompositeOperation = 'lighter';
  const gl = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * (2.6 + p * 0.5));
  gl.addColorStop(0, `rgba(255,255,255,${0.28 * info.light})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, R * 3.2, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // body
  const bg = ctx.createRadialGradient(cx - 10, cy - 10, 4, cx, cy, R);
  bg.addColorStop(0, '#e9e4ff'); bg.addColorStop(1, '#3c2a78');
  ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  // facets
  const LAT = 7; const LON = 18;
  for (let j = 0; j < LAT; j++) {
    const phi = ((j + 0.5) / LAT - 0.5) * Math.PI * 0.92;
    const cphi = Math.cos(phi);
    const y = cy + R * Math.sin(phi);
    const h = R * (Math.PI * 0.92 / LAT) * 0.92;
    for (let k = 0; k < LON; k++) {
      const th = (k / LON) * Math.PI * 2 + rot + j * 0.12;
      const c = Math.cos(th);
      if (c <= 0.05) continue;
      const x = cx + R * cphi * Math.sin(th);
      const w = R * cphi * (Math.PI * 2 / LON) * c * 0.9;
      const hh = hash01(k + j * 31, 41);
      const sparkle = hh > 0.82 && ((Math.floor(b.beatFloat * 2) + k) % 3 === 0);
      const l = sparkle ? 96 : 40 + hh * 38 * c;
      ctx.fillStyle = hsl(240 + hh * 80, sparkle ? 20 : 25, l, 0.95);
      ctx.fillRect(x - w / 2, y - h / 2, Math.max(1, w), h);
    }
  }
  ctx.restore();
  // specks
  const count = info.fever ? 70 : info.intensity === 'low' ? 18 : 34;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const a0 = hash01(i, 51) * Math.PI * 2;
    const speed = 0.35 + hash01(i, 52) * 0.5;
    const a = a0 + rot * (hash01(i, 53) > 0.5 ? 1 : -1) * 1.4;
    const dist = 70 + ((hash01(i, 54) * 420 + b.beatFloat * 26 * speed) % 440);
    const x = cx + Math.cos(a) * dist * 1.5; const y = cy + Math.sin(a) * dist * 0.62 + 40;
    if (y < 4 || y > 420 || x < -10 || x > W + 10) continue;
    const tw = 0.5 + 0.5 * Math.sin(b.beatFloat * 3 + i * 1.3);
    const al = Math.max(0, 1 - dist / 520) * (0.35 + 0.65 * tw) * info.light;
    const col = info.fever ? hsl(b.beatFloat * 50 + i * 21, 100, 75, al) : (hash01(i, 55) > 0.5 ? `rgba(255,255,255,${al})` : hsl(PALETTE_HUE[i % 5], 100, 75, al));
    ctx.fillStyle = col;
    const s = 2 + hash01(i, 56) * 3;
    ctx.fillRect(x - s / 2, y - 0.5, s, 1.4);
    ctx.fillRect(x - 0.7, y - s / 2, 1.4, s);
  }
  ctx.restore();
}

/** Full-width flash on the bar downbeat (very low strength when reduceFlashing is on). */
export function drawDownbeatFlash(ctx, H, info) {
  const b = info.b;
  if (b.beatInBar !== 0 || b.beatIndex < 0) return;
  const a = (info.reduce ? 0.05 : 0.22) * Math.exp(-b.beatPhase * 7);
  if (a < 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(255,240,255,${a})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
