// Particles, floating texts, slash arcs, rings and screen flash. Uses wall-clock dt.
import { FONT } from './constants.js';

export class Effects {
  constructor() { this.clear(); }
  clear() { this.particles = []; this.texts = []; this.arcs = []; this.rings = []; this.flash = 0; this.flashColor = '#ffffff'; }

  burst(x, y, n, { color = '#fff', speed = 180, angle = null, spread = Math.PI * 2, life = 0.5, size = 3, gravity = 380 } = {}) {
    for (let i = 0; i < n; i++) {
      const a = (angle === null ? Math.random() * Math.PI * 2 : angle + (Math.random() - 0.5) * spread);
      const sp = speed * (0.35 + Math.random() * 0.8);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life * (0.7 + Math.random() * 0.5),
        size: size * (0.6 + Math.random() * 0.9), color, gravity,
      });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  /**
   * Floating text. With `channel`, at most one live text per channel exists: a new one makes the
   * previous one fade out quickly in place, so popups never pile up at fast tempos.
   */
  text(x, y, str, { color = '#fff', size = 22, life = 0.8, rise = 40, sub = null, subColor = null, channel = null } = {}) {
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

  /** Slash arc / thrust streak. kind: front | down | back | combo8 */
  arc(x, y, facing, kind, range) {
    const life = kind === 'back' || kind === 'combo8' ? 0.14 : kind === 'down' ? 0.26 : 0.2;
    this.arcs.push({ x, y, facing, kind, range, life, max: life });
  }

  ring(x, y, maxR, color = '#ffd24d', life = 0.45) { this.rings.push({ x, y, maxR, color, life, max: life }); }

  flashScreen(a, color = '#ffffff', reduce = false) { if (!reduce) { this.flash = Math.max(this.flash, a); this.flashColor = color; } }

  update(dt) {
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
      ctx.beginPath(); ctx.arc(r.x, r.y, r.maxR * (1 - Math.pow(1 - t, 3)), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
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
