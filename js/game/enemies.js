// Enemies. Every discrete action (hop, telegraph, swoop, step, strike) is triggered ONLY by beat events.
// Smooth motion between those actions is interpolated from the visual song time.
import { beatInfoAt, pulseAt } from '../core/beatMath.js';
import { hash01 } from '../core/rng.js';
import { FONT, COLORS } from './constants.js';
import { stage, intensityOf } from './disco.js';
import { roundRectPath } from './effects.js';

// the 「出手招架」 hint is shown for the first few telegraphs of each game (counter lives on the game object)
const HINT_MAX = 4;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

class Enemy {
  constructor(id, type, x, hp, r) {
    this.id = id; this.type = type; this.x = x; this.y = 400;
    this.hp = hp; this.maxHp = hp; this.r = r;
    this.facing = -1; this.flash = 0; this.dead = false; this.shake = 0;
    this.strikeRange = type === 'bat' ? 110 : 70; // parry reach used by Combat.findParry
    this.strikeTick = null; // tick (32nd note) of the strike beat while telegraphing; null otherwise
    this.stunned = false; this.stunSince = 0; this.curEv = null; this.showHint = false; this.bd = 0.68;
  }
  /** Set the strike tick for the beat after the telegraph beat. */
  armStrike(ev, g) {
    this.strikeTick = (ev.beatIndex + 1) * 8;
    if (g) {
      g.parryHintCount ??= 0;
      this.showHint = g.parryHintCount < HINT_MAX;
      if (this.showHint) g.parryHintCount++;
    }
  }
  /**
   * Strike beat event: do not resolve yet. The strike resolves in update() at song time
   * strikeTick * beatDur / 8 + lateGraceSec, so a press up to lateGrace after the beat (snapped onto the
   * same tick by the late rule) can still parry. Keyed to song time, never to dt.
   */
  beginStrike(g, ev, onHit) {
    const grace = Math.min(0.4 * g.conductor.beatDur, Math.max(0, (g.settings && g.settings.lateGraceMs != null ? g.settings.lateGraceMs : 25) / 1000));
    this.pending = { resolveAt: this.strikeTick * g.conductor.beatDur / 8 + grace, ev, onHit };
  }
  /** Called from update(): resolve a pending strike (parry check, else the attack). Returns true when it resolved. */
  resolvePending(g, vst) {
    const pd = this.pending;
    if (!pd || vst < pd.resolveAt) return false;
    this.pending = null;
    this.tele = false;
    const atk = g.combat && typeof g.combat.findParry === 'function' ? g.combat.findParry(this) : null;
    if (atk) { this.parry(g, atk, pd.ev); return true; }
    this.strikeTick = null;
    pd.onHit();
    return true;
  }
  /** Ask the combat system whether the player's queued attack lands on this strike beat. */
  tryParry(g, ev) {
    const atk = this.strikeTick !== null && g.combat && typeof g.combat.findParry === 'function' ? g.combat.findParry(this) : null;
    if (atk) { this.parry(g, atk, ev); return true; }
    return false;
  }
  /** Parried: cancel the strike, stun until the next bar downbeat beat event (Game applies the x2 damage). */
  parry(g, attack, ev = this.curEv) {
    this.strikeTick = null; this.showHint = false; this.pending = null;
    this.stunned = true; this.stunSince = g.vst ?? 0;
    if (this.state === 'strike' || this.state === 'tele' || this.state === 'swoop') this.state = this.type === 'bat' ? 'hover' : 'idle';
    this.tele = false;
    const fx = g.effects;
    const top = this.y - this.r * 2 - 40; // anchored on the enemy (effects.js keeps it off the player's text column)
    fx.text(this.x, top, 'PARRY!', { color: '#ffe45e', size: 34, life: 1.0, rise: 30, channel: 'parry' });
    fx.parryBurst(this.x, this.cy);
    if (ev) { g.logWorld('parry', this.id, ev); g.logWorld('enemy-stun', this.id, ev); }
    if (typeof g.onParry === 'function') g.onParry(this, attack);
  }
  /** Stunned enemies skip the beat; they wake on the next bar downbeat (and still act on that beat). */
  skipStunned(ev) {
    this.curEv = ev;
    if (!this.stunned) return false;
    if (ev.beatInBar === 0) { this.stunned = false; return false; }
    return true;
  }
  /** Shrinking ring that reaches its minimum exactly at strikeTick's song time (derived from vst). */
  drawTelegraph(ctx, vst, cy, minR) {
    if (this.strikeTick === null) return;
    const remain = this.strikeTick * this.bd / 8 - vst;
    const u = clamp01(remain / this.bd);
    const R = minR + 46 * u * u + 8 * u;
    const near = remain < this.bd * 0.12;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,228,94,0.35)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(this.x, cy, minR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = near ? 5 : 3.5;
    ctx.strokeStyle = near ? '#ffffff' : '#ffe45e';
    ctx.shadowColor = '#ffe45e'; ctx.shadowBlur = near ? 20 : 10;
    ctx.globalAlpha = 0.45 + 0.55 * (1 - u);
    ctx.beginPath(); ctx.arc(this.x, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    if (this.showHint) {
      ctx.save(); ctx.textAlign = 'center'; ctx.font = `800 14px ${FONT}`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,2,28,0.9)'; ctx.fillStyle = '#ffe45e'; ctx.lineJoin = 'round';
      ctx.strokeText('出手招架', this.x, this.y + 24); ctx.fillText('出手招架', this.x, this.y + 24);
      ctx.restore();
    }
  }
  drawStun(ctx, vst, top) {
    if (!this.stunned) return;
    ctx.save();
    ctx.fillStyle = '#ffe45e'; ctx.shadowColor = '#ffe45e'; ctx.shadowBlur = 8;
    for (let k = 0; k < 3; k++) {
      const a = vst * 6 + k * Math.PI * 2 / 3;
      const sx = this.x + Math.cos(a) * 16; const sy = top + Math.sin(a) * 4;
      ctx.beginPath();
      for (let m = 0; m < 8; m++) { const rr = m % 2 ? 2.2 : 5; const aa = m * Math.PI / 4 - Math.PI / 2; ctx.lineTo(sx + Math.cos(aa) * rr, sy + Math.sin(aa) * rr); }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  get cy() { return this.y - this.r; } // body centre
  shove(dx) { this.x += dx; }
  takeHit(dmg) { this.hp -= dmg; this.flash = 0.12; return this.hp <= 0; }
  drawHp(ctx) {
    if (this.hp >= this.maxHp) return;
    const w = 28;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(this.x - w / 2, this.y - this.r * 2 - 16, w, 4);
    ctx.fillStyle = '#ff4d6d'; ctx.fillRect(this.x - w / 2, this.y - this.r * 2 - 16, w * Math.max(0, this.hp / this.maxHp), 4);
  }
}

export class Slime extends Enemy {
  constructor(id, x) { super(id, 'slime', x, 2, 17); this.hop = { t0: -1e9, from: x, to: x }; this.bd = 0.68; this.air = 0; this.landT = 0; }
  onBeat(ev, g) {
    if (this.skipStunned(ev)) return;
    const dx = g.player.x - this.x;
    const dir = Math.sign(dx) || 1;
    this.facing = dir;
    const dist = Math.min(44, Math.abs(dx));
    this.hop = { t0: ev.beatSongTime, from: this.x, to: this.x + dir * dist };
    g.logWorld('slime-hop', this.id, ev);
  }
  shove(dx) { super.shove(dx); this.hop.from += dx; this.hop.to += dx; }
  update(vst, dt, g) {
    this.bd = g.conductor.beatDur;
    const phase = (vst - this.hop.t0) / this.bd;
    if (phase >= 0 && phase < 0.45) {
      const u = phase / 0.45;
      this.x = lerp(this.hop.from, this.hop.to, easeInOut(u));
      this.air = Math.sin(Math.PI * u) * 24;
      this.landT = 0;
    } else {
      this.x = this.hop.to;
      this.air = 0;
      this.landT = phase >= 0.45 ? clamp01((phase - 0.45) / 0.22) : 1;
    }
    this.y = g.level.groundY(this.x) - this.air;
    this.flash = Math.max(0, this.flash - dt);
    // contact damage
    if (this.air < 16 && Math.abs(this.x - g.player.x) < 26) g.hurtPlayer(1, this.x, 'slime');
  }
  draw(ctx, vst, bpm) {
    const b = beatInfoAt(vst, bpm); const pulse = pulseAt(b.beatPhase, b.beatInBar);
    const squash = (1 - this.landT) * 0.32 * (this.landT < 1 && this.air === 0 ? 1 : 0);
    let sy = 1 - squash - pulse * 0.1 + (this.air > 0 ? 0.18 : 0);
    let sx = 1 + squash + pulse * 0.08 - (this.air > 0 ? 0.1 : 0);
    ctx.save();
    ctx.translate(this.x, this.y); ctx.scale(sx, sy);
    const col = this.flash > 0 ? '#ffffff' : '#5dff8a';
    ctx.fillStyle = col; ctx.shadowColor = '#5dff8a'; ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(-18, 0); ctx.bezierCurveTo(-20, -26, -8, -36, 0, -36); ctx.bezierCurveTo(8, -36, 20, -26, 18, 0); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-7, -26, 5, 3, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0a2a1a';
    const ex = this.facing * 4;
    ctx.beginPath(); ctx.arc(ex - 6, -17, 3.4, 0, Math.PI * 2); ctx.arc(ex + 6, -17, 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    this.drawStun(ctx, vst, this.y - 46);
    this.drawHp(ctx);
  }
}

export class Bat extends Enemy {
  constructor(id, x, baseY) {
    super(id, 'bat', x, 1, 13);
    this.baseY = baseY; this.state = 'hover'; this.amp = 14;
    this.mv = { t0: -1e9, dur: 0.5, from: x, to: x };
    this.sw = { t0: 0, fx: x, fy: baseY, tx: x, ty: baseY };
    this.ret = { t0: 0, fx: x, fy: baseY };
    this.y = baseY; this.tele = false; this.bd = 0.68;
  }
  get cy() { return this.y; }
  onBeat(ev, g) {
    if (this.skipStunned(ev)) return;
    const bi = ev.beatInBar;
    const inten = intensityOf(g, ev.barIndex);
    // low sections: swoop only every 2nd bar; mid/high: every bar (high also hovers faster)
    const attackBar = inten !== 'low' || ev.barIndex % 2 === 1;
    this.fast = inten === 'high';
    if (bi === 2 && attackBar) {
      this.state = 'tele'; this.tele = true; this.armStrike(ev, g);
      g.logWorld('bat-telegraph', this.id, ev);
    } else if (bi === 3 && this.state === 'tele') {
      // logged on the beat; resolved (parry or swoop) in update() at strikeTick + lateGrace
      this.beginStrike(g, ev, () => {
        this.state = 'swoop';
        const tx = Math.min(this.x + 200, Math.max(this.x - 200, g.player.x));
        this.sw = { t0: ev.beatSongTime, fx: this.x, fy: this.y, tx, ty: g.player.y - 30 };
      });
      g.logWorld('bat-swoop', this.id, ev);
    } else {
      if (this.state === 'swoop') { this.state = 'return'; this.ret = { t0: ev.beatSongTime, fx: this.x, fy: this.y }; }
      else if (this.state === 'return') this.state = 'hover';
      if (this.state === 'hover' && bi <= 1) {
        const dir = Math.sign(g.player.x - this.x) || 1;
        this.facing = dir;
        const dist = Math.min(150, Math.max(0, Math.abs(g.player.x - this.x) - 30));
        this.mv = { t0: ev.beatSongTime, dur: this.fast ? 0.35 : 0.5, from: this.x, to: this.x + dir * dist };
      }
    }
  }
  shove(dx) { super.shove(dx); this.mv.from += dx; this.mv.to += dx; this.sw.fx += dx; this.ret.fx += dx; }
  update(vst, dt, g) {
    this.bd = g.conductor.beatDur;
    const bpm = g.conductor.bpm;
    const bf = vst / this.bd;
    const hoverY = this.baseY + Math.sin(bf * Math.PI) * this.amp;
    this.resolvePending(g, vst);
    if (this.state === 'swoop') {
      const u = clamp01((vst - this.sw.t0) / (this.bd * 0.55));
      const e = u * u;
      this.x = lerp(this.sw.fx, this.sw.tx, easeOut(u));
      this.y = lerp(this.sw.fy, this.sw.ty, e);
      this.facing = Math.sign(this.sw.tx - this.sw.fx) || this.facing;
      const pc = { x: g.player.x, y: g.player.y - 30 };
      if (Math.hypot(pc.x - this.x, pc.y - this.y) < 26) g.hurtPlayer(1, this.x, 'bat');
    } else if (this.state === 'return') {
      const u = easeInOut(clamp01((vst - this.ret.t0) / this.bd));
      this.y = lerp(this.ret.fy, hoverY, u);
      this.x = lerp(this.ret.fx, this.ret.fx, u);
    } else {
      this.y = hoverY;
      const u = clamp01((vst - this.mv.t0) / (this.bd * this.mv.dur));
      this.x = lerp(this.mv.from, this.mv.to, easeOut(u));
    }
    // keep above the ground
    const gy = g.level.groundY(this.x) - 14;
    if (this.y > gy) this.y = gy;
    this.flash = Math.max(0, this.flash - dt);
    void bpm;
  }
  draw(ctx, vst, bpm) {
    const b = beatInfoAt(vst, bpm); const pulse = pulseAt(b.beatPhase, b.beatInBar);
    const flap = Math.sin(b.beatFloat * Math.PI * 4);
    ctx.save();
    ctx.translate(this.x, this.y);
    const s = 1 + pulse * 0.16;
    ctx.scale(s * (this.facing || 1), s * (1 - pulse * 0.06));
    const col = this.flash > 0 ? '#ffffff' : (this.tele ? '#ff6a8a' : '#c47bff');
    ctx.fillStyle = col; ctx.shadowColor = this.tele ? '#ff4d6d' : '#b455ff'; ctx.shadowBlur = this.tele ? 20 : 12;
    // wings
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sgn * 4, -2);
      ctx.quadraticCurveTo(sgn * 20, -16 - flap * 10, sgn * 30, -4 - flap * 12);
      ctx.quadraticCurveTo(sgn * 22, 0, sgn * 18, 6);
      ctx.quadraticCurveTo(sgn * 12, 0, sgn * 4, 6);
      ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.ellipse(0, 0, 9, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-7, -8); ctx.lineTo(-5, -17); ctx.lineTo(-1, -9); ctx.moveTo(7, -8); ctx.lineTo(5, -17); ctx.lineTo(1, -9); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = this.tele ? '#fff' : '#ffe45e';
    ctx.beginPath(); ctx.arc(-3.5, -2, 2.2, 0, Math.PI * 2); ctx.arc(3.5, -2, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    this.drawTelegraph(ctx, vst, this.y, 26);
    if (this.tele) this.drawBang(ctx, this.x, this.y - 30);
    this.drawStun(ctx, vst, this.y - 24);
  }
  drawBang(ctx, x, y) {
    ctx.save(); ctx.textAlign = 'center'; ctx.font = `900 24px ${FONT}`;
    ctx.fillStyle = '#ff4d6d'; ctx.strokeStyle = '#1a0630'; ctx.lineWidth = 4;
    ctx.strokeText('!', x, y); ctx.fillText('!', x, y); ctx.restore();
  }
}

export class Guard extends Enemy {
  constructor(id, x) {
    super(id, 'guard', x, 4, 22);
    this.step = { t0: -1e9, from: x, to: x }; this.state = 'idle';
    this.strikeT0 = -1e9; this.strikeDone = true; this.blockT = 0; this.bd = 0.68;
  }
  onBeat(ev, g) {
    if (this.skipStunned(ev)) return;
    const bi = ev.beatInBar;
    const inten = intensityOf(g, ev.barIndex);
    const attackBar = inten !== 'low' || ev.barIndex % 2 === 1; // calm sections: guards strike every 2nd bar
    this.state = this.state === 'strike' ? 'idle' : this.state;
    const dx = g.player.x - this.x;
    if (bi === 0 || bi === 2) {
      this.facing = Math.sign(dx) || this.facing;
      const dist = Math.abs(dx) > 72 ? 56 : 0;
      this.step = { t0: ev.beatSongTime, from: this.x, to: this.x + this.facing * dist };
      g.logWorld('guard-step', this.id, ev);
    }
    if (bi === 2 && attackBar) { this.state = 'tele'; this.armStrike(ev, g); g.logWorld('guard-telegraph', this.id, ev); }
    else if (bi === 3 && this.state === 'tele') {
      this.beginStrike(g, ev, () => { this.state = 'strike'; this.strikeT0 = ev.beatSongTime; this.strikeDone = false; });
      g.logWorld('guard-strike', this.id, ev);
    }
  }
  shove(dx) { super.shove(dx); this.step.from += dx; this.step.to += dx; }
  /** Is a hit coming from playerX blocked by the shield? (front-beat only; caller checks the move) */
  blocks(playerX) { if (this.stunned) return false; return Math.sign(playerX - this.x) === this.facing; }
  update(vst, dt, g) {
    this.bd = g.conductor.beatDur;
    const u = clamp01((vst - this.step.t0) / (this.bd * 0.4));
    this.x = lerp(this.step.from, this.step.to, easeOut(u));
    this.y = g.level.groundY(this.x);
    this.flash = Math.max(0, this.flash - dt);
    this.blockT = Math.max(0, this.blockT - dt);
    this.resolvePending(g, vst);
    if (this.state === 'strike' && !this.strikeDone && vst - this.strikeT0 < this.bd * 0.3) {
      const dx = (g.player.x - this.x) * this.facing;
      if (vst >= this.strikeT0 && dx > -6 && dx < 60 + 10 && Math.abs(g.player.y - this.y) < 40) {
        this.strikeDone = true; g.hurtPlayer(1, this.x, 'guard');
      }
    }
  }
  draw(ctx, vst, bpm) {
    const b = beatInfoAt(vst, bpm); const pulse = pulseAt(b.beatPhase, b.beatInBar);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.facing || 1, 1);
    ctx.scale(1 + pulse * 0.06, 1 - pulse * 0.08);
    const col = this.flash > 0 ? '#ffffff' : '#ffb347';
    ctx.strokeStyle = col; ctx.fillStyle = '#1a0d33'; ctx.shadowColor = '#ffb347'; ctx.shadowBlur = 10;
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // body armour
    ctx.beginPath(); roundRectPath(ctx, -14, -50, 28, 34, 6); ctx.fill(); ctx.stroke();
    // legs
    ctx.beginPath(); ctx.moveTo(-7, -16); ctx.lineTo(-8, 0); ctx.moveTo(7, -16); ctx.lineTo(8, 0); ctx.stroke();
    // helmet
    ctx.beginPath(); ctx.arc(0, -58, 12, Math.PI, 0); ctx.lineTo(12, -52); ctx.lineTo(-12, -52); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ff4d6d'; ctx.shadowBlur = 0; ctx.fillRect(2, -57, 8, 3);
    // sword (raised on telegraph, swung on strike)
    ctx.strokeStyle = '#e8f3ff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 8; ctx.lineWidth = 4;
    let ang = -0.5;
    if (this.state === 'tele') ang = -2.3;
    else if (this.state === 'strike') ang = lerp(-2.3, 1.1, easeOut(clamp01((vst - this.strikeT0) / (this.bd * 0.25))));
    ctx.beginPath(); ctx.moveTo(8, -38); ctx.lineTo(8 + Math.cos(ang) * 44, -38 + Math.sin(ang) * 44); ctx.stroke();
    // shield on the front side
    const flashShield = this.blockT > 0;
    ctx.fillStyle = flashShield ? '#ffffff' : '#2a1a55'; ctx.strokeStyle = flashShield ? '#ffffff' : '#4df3ff';
    ctx.shadowColor = '#4df3ff'; ctx.shadowBlur = flashShield ? 24 : 10; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(14, -54); ctx.lineTo(26, -48); ctx.lineTo(26, -22); ctx.lineTo(14, -12); ctx.lineTo(8, -30); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    this.drawTelegraph(ctx, vst, this.y - 34, 34);
    this.drawStun(ctx, vst, this.y - 76);
    if (this.state === 'tele') {
      ctx.save(); ctx.textAlign = 'center'; ctx.font = `900 26px ${FONT}`;
      ctx.fillStyle = '#ff4d6d'; ctx.strokeStyle = '#1a0630'; ctx.lineWidth = 4;
      ctx.strokeText('!', this.x, this.y - 82); ctx.fillText('!', this.x, this.y - 82); ctx.restore();
    }
    this.drawHp(ctx);
  }
}

/**
 * Wave table: which enemies spawn on the downbeat of bar `bar` (deterministic).
 * Intensity (spec section 8) defaults to the running game's section map: low = fewer, high = more/harder.
 */
export function waveFor(bar, intensity) {
  if (bar < 2) return [];
  if (!intensity) intensity = intensityOf(stage.game, bar);
  const t = bar - 2;
  const r = hash01(bar, 5);
  const tier = Math.min(4, Math.floor(t / 8) + (intensity === 'high' ? 1 : 0));
  let out = [];
  if (tier === 0) { if (t % 2 === 0) out.push('slime'); if (t === 4) out.push('slime'); }
  else if (tier === 1) { if (t % 2 === 0) out.push(r < 0.5 ? 'slime' : 'bat'); else if (r < 0.35) out.push('slime'); }
  else if (tier === 2) { out.push(r < 0.5 ? 'slime' : 'bat'); if (t % 4 === 0) out.push('guard'); }
  else { out.push(r < 0.4 ? 'slime' : 'bat'); if (t % 2 === 0) out.push('guard'); if (r > 0.75) out.push('slime'); }
  if (intensity === 'low') out = t % 2 === 0 ? out.slice(0, 1) : [];
  else if (intensity === 'high') {
    out.push(t % 2 ? 'bat' : 'slime');
    if (t % 3 === 0 && !out.includes('guard')) out.push('guard');
  }
  return out;
}

export { COLORS };
