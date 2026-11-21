// Particles, floating texts, slash arcs, rings and screen flash. Uses wall-clock dt.
import { FONT } from './constants.js';
import { LEVEL_NAMES, LEVEL_COLORS, COMBO_NAMES, stage } from './disco.js';

/** Rounded-rect path with a manual fallback for browsers without CanvasRenderingContext2D.roundRect. */
export function roundRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Vertical rows (px above the player's feet) for channelled popups, so callers never hardcode y and
 * the rows can never overlap: judgment (closest to the head), score bonus, combo names, groove banner.
 * The 'parry' channel is anchored on the enemy instead and pushed sideways away from the player.
 */
export const CHANNEL_ROWS = { judge: 96, bonus: 130, combo: 168, groove: 208 };
const INSTR_NAME = { kick: '大鼓', snare: '小鼓' };

export class Effects {
  constructor() { this.clear(); }
  clear() {
    this.particles = []; this.texts = []; this.arcs = []; this.rings = []; this.flash = 0; this.flashColor = '#ffffff';
    this.lastKick = null; // { vst, level, unison } read by the floor renderer (thump) and crowd
    this.lastSnare = null; this.cheerVst = -1e9; this._seen = new Set(); this._groove = null; this._lastVst = -1e9;
  }

  burst(x, y, n, { color = '#fff', speed = 180, angle = null, spread = Math.PI * 2, life = 0.5, size = 3, gravity = 380, shape = 'rect' } = {}) {
    for (let i = 0; i < n; i++) {
      const a = (angle === null ? Math.random() * Math.PI * 2 : angle + (Math.random() - 0.5) * spread);
      const sp = speed * (0.35 + Math.random() * 0.8);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life * (0.7 + Math.random() * 0.5),
        size: size * (0.6 + Math.random() * 0.9), color, gravity, shape,
      });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  /**
   * Floating text. With `channel`, at most one live text per channel exists: a new one makes the
   * previous one fade out quickly in place, so popups never pile up at fast tempos.
   */
  text(x, y, str, { color = '#fff', size = 22, life = 0.8, rise = 40, sub = null, subColor = null, channel = null } = {}) {
    if (!channel && typeof str === 'string' && /^\+\d+$/.test(str)) channel = 'bonus'; // parry score bonus
    const pl = stage.game && stage.game.player;
    if (channel && pl) {
      if (CHANNEL_ROWS[channel]) { x = pl.x; y = pl.y - CHANNEL_ROWS[channel]; rise = Math.min(rise, 14); }
      else if (channel === 'parry') {
        // stay on the enemy, but never above the player's own text column
        const side = x >= pl.x ? 1 : -1;
        x = pl.x + side * Math.max(Math.abs(x - pl.x), 130);
        rise = Math.min(rise, 20);
      }
    }
    if (channel) {
      for (const t of this.texts) {
        if (t.channel === channel && t.frozenK === undefined) {
          t.frozenK = 1 - t.life / t.max; t.life = 0.09; t.fadeMax = 0.09;
        }
      }
    }
    this.texts.push({ x, y, str, color, size, life, max: life, rise, sub, subColor: subColor || color, channel });
    if (this.texts.length > 40) this.texts.shift();
  }

  /** PARRY stars + gold rings. */
  parryBurst(x, y) {
    this.burst(x, y, 14, { color: '#ffe45e', speed: 260, life: 0.7, size: 7, shape: 'star', gravity: 120 });
    this.burst(x, y, 8, { color: '#ffffff', speed: 180, life: 0.5, size: 3 });
    this.ring(x, y, 54, '#ffe45e', 0.4); this.ring(x, y, 34, '#ffffff', 0.28);
  }

  /**
   * Judgment popup on its own channel: row 1 = 準拍/離拍 + judgment word, row 2 = level name.
   * Combo names go to the 'combo' channel above it (see comboText) so the rows never overlap.
   */
  judge(x, y, { judgment = 'good', onBeat = false, level = null, size = null, instrument = null, early = '' } = {}) {
    const col = { perfect: '#ffe45e', great: '#5cf2ff', good: '#7dff9a' }[judgment] || '#e0dcff';
    const word = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', off: 'OFF' }[judgment] || String(judgment).toUpperCase();
    const parts = [onBeat ? '準拍' : '離拍'];
    if (instrument) parts.push(INSTR_NAME[instrument] || instrument);
    if (level) parts.push(LEVEL_NAMES[level] || level);
    this.text(x, y, word, {
      color: onBeat ? col : '#a6a1c4', size: size || (judgment === 'perfect' ? 26 : 22), life: 0.62, rise: 26, channel: 'judge',
      sub: parts.join('・') + early, subColor: LEVEL_COLORS[level] || '#e0dcff',
    });
  }

  /** Groove banner (「GROOVE! 搖滾節奏」) on its own row above the combo row. */
  grooveText(str, color = '#ffd24d') {
    this.text(0, 0, str, { color, size: 30, life: 1.5, rise: 10, channel: 'groove' });
  }

  /**
   * Drummer feedback. kick: low wide orange shockwave at the player's feet + floor thump;
   * snare: sharp white/cyan burst at sword height; unison: both + crash flash.
   */
  drumHit({ instrument = 'kick', level = 'beat', unison = false, vst = 0, x = 0, feetY = 0, swordX = x, swordY = feetY - 40, reduce = false, facing = 1 } = {}) {
    const big = level === 'bar' || level === 'half';
    const weight = { bar: 1.3, half: 1.15, beat: 1, eighth: 0.8, sixteenth: 0.6, thirtysecond: 0.5 }[level] || 0.8;
    if (instrument === 'kick' || unison) {
      this.lastKick = { vst, level, unison, weight };
      this.shock(x, feetY - 2, 70 * weight + (big ? 30 : 0), '#ff9a3d', 0.42);
      if (big || unison) this.shock(x, feetY - 2, 110 * weight, '#ffd24d', 0.55);
      this.burst(x, feetY - 4, Math.round(8 * weight), { color: '#ff9a3d', speed: 160, angle: -Math.PI / 2, spread: 2.4, life: 0.4, size: 3, gravity: 500 });
    }
    if (instrument === 'snare' || unison) {
      this.lastSnare = { vst, level, unison };
      this.burst(swordX, swordY, Math.round(14 * weight), { color: '#ffffff', speed: 360, angle: facing > 0 ? 0 : Math.PI, spread: 2.6, life: 0.28, size: 2.5, gravity: 80 });
      this.burst(swordX, swordY, Math.round(8 * weight), { color: '#5cf2ff', speed: 260, life: 0.3, size: 3, gravity: 40 });
      this.ring(swordX, swordY, 34 * weight, '#bff9ff', 0.2);
    }
    if (unison) this.flashScreen(0.4, '#fff4c2', reduce);
  }

  /** Flat (squashed) ring used for floor shockwaves. */
  shock(x, y, maxR, color, life = 0.4) { this.rings.push({ x, y, maxR, color, life, max: life, flat: 0.28 }); }

  /**
   * Called every frame from update(): turns newly impacted attacks in game.combat.queue into drum feedback
   * (no dependency on Combat calling drumHit) and notices new grooves (game.lastGroove) for the crowd cheer.
   */
  _observe() {
    const g = stage.game;
    if (!g || !g.combat || !g.player) return;
    const vst = g.vst ?? 0;
    if (vst < this._lastVst - 1) this._seen.clear();
    this._lastVst = vst;
    const q = g.combat.queue || [];
    const fresh = q.filter((a) => a.state === 'impact' && !this._seen.has(a.id));
    for (const a of fresh) {
      this._seen.add(a.id);
      const ins = (a.instrument || (a.q && a.q.instrument)) === 'snare' ? 'snare' : 'kick';
      const uni = !!(a.unison || (a.q && a.q.unison)) || q.some((o) => o !== a && o.tick === a.tick && (o.instrument || 'kick') !== ins);
      const p = g.player;
      const f = p.facing || 1;
      this.drumHit({
        instrument: ins, level: a.level || 'beat', unison: uni, vst, x: p.x, feetY: p.y,
        swordX: p.x + f * 40, swordY: p.bodyY ?? p.y - 40, reduce: !!(g.settings && g.settings.reduceFlashing), facing: f,
      });
    }
    if (this._seen.size > 200) { const keep = new Set(q.map((a) => a.id)); this._seen = keep; }
    const lg = g.lastGroove;
    if (lg && lg !== this._groove) { this._groove = lg; this.cheerVst = vst; }
  }

  comboText(x, y, combo) {
    const name = COMBO_NAMES[combo];
    if (name) this.text(x, y, `${name}!`, { color: combo === 'bar' ? '#ffd24d' : combo === 'fill' ? '#ff9f4d' : '#ff4fd8', size: 30, life: 1.0, rise: 36, channel: 'combo' });
  }

  /** Slash arc / thrust streak. kind: front | down | back | combo8 */
  arc(x, y, facing, kind, range) {
    const life = kind === 'back' || kind === 'combo8' ? 0.14 : kind === 'down' ? 0.26 : 0.2;
    this.arcs.push({ x, y, facing, kind, range, life, max: life });
  }

  ring(x, y, maxR, color = '#ffd24d', life = 0.45) { this.rings.push({ x, y, maxR, color, life, max: life }); }

  flashScreen(a, color = '#ffffff', reduce = false) { if (!reduce) { this.flash = Math.max(this.flash, a); this.flashColor = color; } }

  update(dt) {
    this._observe();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (const arr of [this.texts, this.arcs, this.rings]) {
      for (let i = arr.length - 1; i >= 0; i--) { arr[i].life -= dt; if (arr[i].life <= 0) arr.splice(i, 1); }
    }
    this.flash = Math.max(0, this.flash - dt * 4);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // arcs
    for (const a of this.arcs) {
      const t = 1 - a.life / a.max; // 0..1
      const alpha = 1 - t;
      ctx.save();
      ctx.translate(a.x, a.y); ctx.scale(a.facing, 1);
      if (a.kind === 'back' || a.kind === 'combo8') {
        const len = a.range * (0.5 + 0.5 * Math.min(1, t * 3));
        const col = a.kind === 'combo8' ? '255,210,77' : '255,79,216';
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.7, `rgba(${col},${0.7 * alpha})`); g.addColorStop(1, `rgba(255,255,255,${alpha})`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, -5 * alpha - 1); ctx.lineTo(len, 0); ctx.lineTo(0, 5 * alpha + 1); ctx.closePath(); ctx.fill();
      } else {
        const col = a.kind === 'down' ? '255,210,77' : '77,243,255';
        const R = a.range;
        const sweep = Math.min(1, t * 4);
        const a0 = -Math.PI / 3, a1 = a0 + (2 * Math.PI / 3) * sweep;
        ctx.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          ctx.strokeStyle = `rgba(${i === 0 ? '255,255,255' : col},${alpha * (i === 0 ? 0.95 : 0.5)})`;
          ctx.lineWidth = (a.kind === 'down' ? 18 : 12) * (1 - t * 0.6) - i * 3.5;
          ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 14;
          ctx.beginPath(); ctx.arc(0, 0, R * (0.82 + i * 0.07), a0, a1); ctx.stroke();
        }
      }
      ctx.restore();
    }
    // rings
    for (const r of this.rings) {
      const t = 1 - r.life / r.max;
      ctx.strokeStyle = r.color; ctx.globalAlpha = 1 - t; ctx.lineWidth = 6 * (1 - t) + 1;
      const rad = r.maxR * (1 - Math.pow(1 - t, 3));
      ctx.beginPath();
      if (r.flat) ctx.ellipse(r.x, r.y, rad * 1.5, rad * r.flat, 0, 0, Math.PI * 2); else ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.color;
      if (p.shape === 'star') {
        ctx.beginPath();
        for (let m = 0; m < 8; m++) { const rr = m % 2 ? p.size * 0.4 : p.size; const aa = m * Math.PI / 4 - Math.PI / 2 + p.life * 3; ctx.lineTo(p.x + Math.cos(aa) * rr, p.y + Math.sin(aa) * rr); }
        ctx.closePath(); ctx.fill();
      } else ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // texts (normal blending)
    ctx.save();
    ctx.textAlign = 'center';
    for (const t of this.texts) {
      const dying = t.frozenK !== undefined;
      const k = dying ? t.frozenK : 1 - t.life / t.max;
      const pop = k < 0.12 ? 0.7 + (k / 0.12) * 0.5 : 1.2 - Math.min(0.2, (k - 0.12) * 0.5);
      ctx.globalAlpha = (k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1) * (dying ? t.life / t.fadeMax : 1);
      const y = t.y - t.rise * (1 - Math.pow(1 - k, 2));
      ctx.font = `800 ${Math.round(t.size * pop)}px ${FONT}`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,2,28,0.85)'; ctx.lineJoin = 'round';
      ctx.strokeText(t.str, t.x, y); ctx.fillStyle = t.color; ctx.fillText(t.str, t.x, y);
      if (t.sub) {
        ctx.font = `700 ${Math.round(t.size * 0.58 * pop)}px ${FONT}`;
        ctx.strokeText(t.sub, t.x, y + t.size * 0.72); ctx.fillStyle = t.subColor; ctx.fillText(t.sub, t.x, y + t.size * 0.72);
      }
    }
    ctx.restore();
  }

  drawFlash(ctx, w, h) {
    if (this.flash <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = Math.min(0.5, this.flash * 0.5);
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
