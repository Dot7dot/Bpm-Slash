// Level: procedural terrain (bouncing tiles) and beat spikes. Deterministic via seeded RNG.
import { mulberry32 } from '../core/rng.js';
import { pulseAt, beatInfoAt } from '../core/beatMath.js';
import { TILE, H, W } from './constants.js';

const CHUNK_W = TILE * 16;

function smooth(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

export class Level {
  constructor(seed = 20240611) {
    this.seed = seed;
    this.chunks = new Map(); // chunk index -> { spikes: [] }
    this.maxChunk = -1;
    this.spikeState = 'down'; // down | tele | up (driven only by beat events)
    this.spikeSince = 0;
  }

  /** Walkable ground height: flat start, then gentle slopes. */
  groundY(x) {
    const ramp = smooth((x - 500) / 800);
    return 420 - ramp * (15 * Math.sin(x / 310 + 0.7) + 8 * Math.sin(x / 131 + 2.1));
  }

  /** Generate chunks up to x. */
  ensure(rightX) {
    const need = Math.floor(rightX / CHUNK_W);
    while (this.maxChunk < need) this._genChunk(++this.maxChunk);
  }

  _genChunk(c) {
    const rnd = mulberry32(this.seed + c * 7919);
    const spikes = [];
    const roll = rnd();
    const startTile = 3 + Math.floor(rnd() * 8); // 3..10 so adjacent chunk groups keep a gap
    const len = c < 6 ? 1 : (rnd() < 0.55 ? 2 : 3);
    if (c >= 2 && roll < Math.min(0.6, 0.3 + c * 0.02)) {
      for (let j = 0; j < len; j++) {
        spikes.push({ id: `spike-${c}-${j}`, x: c * CHUNK_W + (startTile + j) * TILE, w: TILE });
      }
    }
    this.chunks.set(c, { spikes });
  }

  spikesInRange(x0, x1) {
    const out = [];
    const c0 = Math.max(0, Math.floor(x0 / CHUNK_W));
    const c1 = Math.floor(x1 / CHUNK_W);
    for (let c = c0; c <= c1; c++) {
      const ch = this.chunks.get(c);
      if (!ch) continue;
      for (const s of ch.spikes) if (s.x + s.w >= x0 && s.x <= x1) out.push(s);
    }
    return out;
  }

  /** Beat event: advance spike state (telegraph on 3rd beat, up on 4th, down on 1st). */
  onBeat(ev, game, viewX0, viewX1) {
    let kind = null;
    if (ev.beatInBar === 2) { this.spikeState = 'tele'; kind = 'spike-telegraph'; }
    else if (ev.beatInBar === 3) { this.spikeState = 'up'; kind = 'spike-up'; }
    else if (ev.beatInBar === 0) { this.spikeState = 'down'; kind = 'spike-down'; }
    if (!kind) return;
    this.spikeSince = ev.beatSongTime;
    for (const s of this.spikesInRange(viewX0 - 300, viewX1 + 300)) game.logWorld(kind, s.id, ev);
  }

  /** Is the player's x-range overlapping a raised spike? */
  spikeHits(x, halfW) {
    if (this.spikeState !== 'up') return false;
    for (const s of this.spikesInRange(x - halfW - 2, x + halfW + 2)) {
      if (x + halfW > s.x + 4 && x - halfW < s.x + s.w - 4) return true;
    }
    return false;
  }

  // ---------- drawing ----------

  /** Tile bounce in px for tile i at song time t (ripple expands from the centre tile). */
  tileBounce(i, centerTile, vst, bpm) {
    const delay = Math.abs(i - centerTile) * 0.012;
    const b = beatInfoAt(vst - delay, bpm);
    const edge = pulseAt(b.beatPhase, b.beatInBar);
    return { lift: edge * 9, glow: edge, down: b.beatInBar === 0 };
  }

  draw(ctx, cam, vst, bpm) {
    const x0 = cam.x - 10;
    const first = Math.floor(x0 / TILE);
    const last = Math.floor((cam.x + W + 10) / TILE);
    const center = Math.floor((cam.x + W * 0.4) / TILE);
    const grad = ctx.createLinearGradient(0, 380, 0, H);
    grad.addColorStop(0, '#2a0f55');
    grad.addColorStop(1, '#0c0524');
    ctx.fillStyle = grad;
    for (let i = first; i <= last; i++) {
      const xa = i * TILE;
      const tb = this.tileBounce(i, center, vst, bpm);
      const ya = this.groundY(xa) - tb.lift;
      const yb = this.groundY(xa + TILE) - tb.lift;
      ctx.beginPath();
      ctx.moveTo(xa, ya); ctx.lineTo(xa + TILE, yb);
      ctx.lineTo(xa + TILE, H + 20); ctx.lineTo(xa, H + 20);
      ctx.closePath();
      ctx.fill();
    }
    // neon top edge
    ctx.save();
    ctx.lineWidth = 2.5;
    for (let i = first; i <= last; i++) {
      const xa = i * TILE;
      const tb = this.tileBounce(i, center, vst, bpm);
      const ya = this.groundY(xa) - tb.lift;
      const yb = this.groundY(xa + TILE) - tb.lift;
      const g = tb.glow;
      ctx.strokeStyle = tb.down ? `rgba(255,210,77,${0.45 + 0.55 * g})` : `rgba(77,243,255,${0.45 + 0.55 * g})`;
      ctx.shadowColor = tb.down ? '#ffd24d' : '#4df3ff';
      ctx.shadowBlur = 4 + 14 * g;
      ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xa + TILE, yb); ctx.stroke();
      // tile seam
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(180,120,255,0.18)';
      ctx.beginPath(); ctx.moveTo(xa, ya + 2); ctx.lineTo(xa, H); ctx.stroke();
    }
    ctx.restore();
    // grid lines under the ground
    ctx.strokeStyle = 'rgba(255,79,216,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 470; y < H; y += 24) { ctx.moveTo(cam.x - 10, y); ctx.lineTo(cam.x + W + 10, y); }
    ctx.stroke();
  }

  drawSpikes(ctx, cam, vst, bpm) {
    const spikes = this.spikesInRange(cam.x - 60, cam.x + W + 60);
    if (!spikes.length) return;
    const phaseT = (vst - this.spikeSince) / (60 / bpm);
    const center = Math.floor((cam.x + W * 0.4) / TILE);
    for (const s of spikes) {
      const i = Math.floor(s.x / TILE);
      const tb = this.tileBounce(i, center, vst, bpm);
      const gy = this.groundY(s.x + s.w / 2) - tb.lift;
      let h = 5; let color = '#7a3a8a'; let glow = 0;
      if (this.spikeState === 'tele') {
        const fl = 0.5 + 0.5 * Math.sin(phaseT * Math.PI * 2 * 2);
        h = 7 + 3 * fl; color = '#ffb347'; glow = 8 + 10 * fl;
      } else if (this.spikeState === 'up') {
        const e = 1 - Math.pow(1 - Math.min(1, phaseT / 0.18), 3);
        h = 5 + 27 * e; color = '#ff3d6e'; glow = 16;
      } else {
        const e = Math.max(0, 1 - phaseT / 0.18);
        h = 5 + 6 * e;
        if (e > 0) { color = '#ff3d6e'; glow = 6; }
      }
      ctx.save();
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = glow;
      const n = 2; const sw = s.w / n;
      for (let k = 0; k < n; k++) {
        const bx = s.x + k * sw;
        ctx.beginPath();
        ctx.moveTo(bx + 2, gy + 2); ctx.lineTo(bx + sw / 2, gy - h); ctx.lineTo(bx + sw - 2, gy + 2);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  }
}
