// Player: a stick figure holding a sword. Movement uses wall-clock dt; animation phase is locked to the beat.
import { PLAYER_SPEED, PLAYER_MAX_HP, COLORS } from './constants.js';
import { beatInfoAt, pulseAt } from '../core/beatMath.js';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t;

export class Player {
  constructor() { this.reset(); }

  reset() {
    this.x = 140;
    this.y = 420;
    this.facing = 1;
    this.hp = PLAYER_MAX_HP;
    this.maxHp = PLAYER_MAX_HP;
    this.moving = 0;
    this.kb = 0;
    this.invUntil = -Infinity; // song time
    this.pose = null; // { kind, stage: 'windup'|'slash'|'recover', p }
    this.hurtT = 0;
  }

  /** dir: -1, 0, 1. busy: attack in progress (speed x0.6). */
  update(dt, dir, level, busy) {
    const speed = PLAYER_SPEED * (busy ? 0.6 : 1);
    this.moving = dir;
    if (dir !== 0) this.facing = dir;
    this.x += dir * speed * dt + this.kb * dt;
    this.kb *= Math.exp(-dt * 9);
    if (Math.abs(this.kb) < 1) this.kb = 0;
    if (this.x < 14) this.x = 14;
    this.y = level.groundY(this.x);
    this.hurtT = Math.max(0, this.hurtT - dt);
  }

  isInvincible(vst) { return vst < this.invUntil; }

  get bodyY() { return this.y - 32; }

  /**
   * Sword pose parameters for the current attack stage (docs/DESIGN-BEATSNAP.md section 5).
   * windup (stretches to fit the gap before the connect tick) -> slash (fixed length, blade tip is farthest on
   * the connect time) -> recover. Look per move: bar = big diagonal chop, half/beat = horizontal sweep,
   * eighth = thrust, sixteenth/thirtysecond = short rapid stab.
   */
  _swordPose() {
    const rest = { th: -40 * DEG, reach: 14, lean: 0 };
    const pose = this.pose;
    if (!pose) return rest;
    const { kind, stage, p } = pose;
    if (kind === 'sub') { // short rapid stab
      if (stage === 'windup') { const e = easeOut(p); return { th: lerp(-40, -12, e) * DEG, reach: lerp(14, 8, e), lean: -0.04 * e }; }
      if (stage === 'slash') { const e = easeOut(p); return { th: -8 * DEG, reach: lerp(8, 24, e), lean: lerp(-0.04, 0.1, e) }; }
      const e = easeIn(p); return { th: lerp(-8, -40, e) * DEG, reach: lerp(24, 14, e), lean: lerp(0.1, 0, e) };
    }
    if (kind === 'back' || kind === 'combo8') { // long thrust
      if (stage === 'windup') { const e = easeOut(p); return { th: lerp(-40, -4, e) * DEG, reach: lerp(14, 3, e), lean: -0.1 * e }; }
      if (stage === 'slash') { const e = easeOut(p); return { th: -4 * DEG, reach: lerp(3, 32, e), lean: lerp(-0.1, 0.22, e) }; }
      const e = easeIn(p); return { th: lerp(-4, -40, e) * DEG, reach: lerp(32, 14, e), lean: lerp(0.22, 0, e) };
    }
    if (kind === 'front') { // horizontal sweep: behind the head down to a level, forward-pointing blade
      const up = -118 * DEG, fwd = 6 * DEG;
      if (stage === 'windup') { const e = easeOut(p); return { th: lerp(-40 * DEG, up, e), reach: lerp(14, 8, e), lean: -0.16 * e }; }
      if (stage === 'slash') { const e = easeOut(p); return { th: lerp(up, fwd, e), reach: lerp(8, 22, e), lean: lerp(-0.16, 0.26, e) }; }
      const e = easeIn(p); return { th: lerp(fwd, -40 * DEG, e), reach: lerp(22, 14, e), lean: lerp(0.26, 0, e) };
    }
    // down / finisher / fill: big overhead diagonal chop
    const up = -168 * DEG, down = 85 * DEG;
    if (stage === 'windup') { const e = easeOut(p); return { th: lerp(-40 * DEG, up, e), reach: lerp(14, 11, e), lean: -0.2 * e }; }
    if (stage === 'slash') { const e = easeOut(p); return { th: lerp(up, down, e), reach: lerp(11, 18, e), lean: lerp(-0.2, 0.3, e) }; }
    const e = easeIn(p); return { th: lerp(down, -40 * DEG, e), reach: lerp(18, 14, e), lean: lerp(0.3, 0, e) };
  }

  draw(ctx, vst, bpm, tileLift = 0) {
    const b = beatInfoAt(vst, bpm);
    const pulse = pulseAt(b.beatPhase, b.beatInBar);
    if (this.isInvincible(vst) && Math.floor(vst / 0.06) % 2 === 0) return;

    const attacking = !!this.pose;
    const walking = this.moving !== 0;
    const bob = pulse * 3.2; // nod on every beat
    const step = Math.sin(b.beatFloat * Math.PI * 2); // one step per half beat

    ctx.save();
    ctx.translate(this.x, this.y - tileLift);
    ctx.scale(this.facing, 1);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(0, 2, 16, 4, 0, 0, Math.PI * 2); ctx.fill();

    const sp = this._swordPose();
    const hipY = -26 + bob * 0.5;
    const col = this.hurtT > 0 ? COLORS.danger : '#7df9ff';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 4.5;
    ctx.shadowColor = col; ctx.shadowBlur = 10;

    // legs
    const stride = walking ? 0.75 : attacking ? 0.28 : 0.12;
    const legA = step * stride;
    const leg = (a) => {
      const kx = Math.sin(a) * 9, ky = hipY + 13;
      const fx = Math.sin(a) * 15;
      ctx.beginPath(); ctx.moveTo(0, hipY); ctx.lineTo(kx, ky); ctx.lineTo(fx, -Math.max(0, Math.cos(a) - 0.9) * 8); ctx.stroke();
    };
    leg(legA); leg(-legA);

    // torso (lean about hip)
    ctx.save();
    ctx.translate(0, hipY);
    ctx.rotate(sp.lean + (walking ? 0.06 : 0));
    const shY = -20 + bob * 0.3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, shY); ctx.stroke();

    // back arm (balance)
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(0, shY + 2); ctx.lineTo(-9 - (attacking ? 3 : 0), shY + 12 + step * 2); ctx.stroke();
    ctx.lineWidth = 4.5;

    // head + scarf
    const hy = shY - 9 + bob * 0.35;
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#12082e';
    ctx.beginPath(); ctx.arc(1, hy, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 10; ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(4.5, hy - 1, 1.6, 0, Math.PI * 2); ctx.fill(); // eye
    ctx.strokeStyle = COLORS.back; ctx.shadowColor = COLORS.back; ctx.lineWidth = 3.5;
    const wave = Math.sin(b.beatFloat * Math.PI * 2 + 1) * 3 + (walking ? 4 : 0);
    ctx.beginPath(); ctx.moveTo(-7, hy + 1); ctx.quadraticCurveTo(-16, hy + wave, -24, hy + 3 - wave * 0.6); ctx.stroke();
    ctx.strokeStyle = col; ctx.shadowColor = col; ctx.lineWidth = 4.5;

    // sword arm
    const sa = sp.th * 0.55;
    const hx = Math.cos(sa) * sp.reach, hyy = shY + 3 + Math.sin(sa) * sp.reach;
    ctx.beginPath(); ctx.moveTo(0, shY + 2); ctx.lineTo(hx, hyy); ctx.stroke();
    // sword
    const L = 38;
    const tx = hx + Math.cos(sp.th) * L, ty = hyy + Math.sin(sp.th) * L;
    const big = this.pose && (this.pose.kind === 'down' || this.pose.kind === 'finisher' || this.pose.kind === 'fill');
    ctx.strokeStyle = big ? '#ffe9a3' : '#f4f9ff'; ctx.shadowColor = big ? COLORS.down : COLORS.front;
    ctx.shadowBlur = big ? 18 : 12; ctx.lineWidth = big ? 5 : 4;
    ctx.beginPath(); ctx.moveTo(hx + Math.cos(sp.th) * 4, hyy + Math.sin(sp.th) * 4); ctx.lineTo(tx, ty); ctx.stroke();
    // guard
    ctx.strokeStyle = COLORS.back; ctx.shadowColor = COLORS.back; ctx.lineWidth = 3.5;
    const gx = hx + Math.cos(sp.th) * 4, gy = hyy + Math.sin(sp.th) * 4;
    ctx.beginPath(); ctx.moveTo(gx - Math.sin(sp.th) * 5, gy + Math.cos(sp.th) * 5); ctx.lineTo(gx + Math.sin(sp.th) * 5, gy - Math.cos(sp.th) * 5); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }
}
