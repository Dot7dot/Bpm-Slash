// Combat: attack queue, quantized impact frames, hit resolution, combos (DESIGN section 6).
import { quantizeAttack, JUDGE_MULTIPLIER } from '../core/quantizer.js';
import { COLORS, JUDGE_COLORS } from './constants.js';
import { pushLog } from '../debug/debugHook.js';

export const MOVES = {
  front: { dmg: 2, range: 78, kb: 40, label: '前拍斬' },
  down: { dmg: 3, range: 96, kb: 52, label: '強拍斬' },
  back: { dmg: 1, range: 92, kb: 18, label: '後拍刺' },
  combo8: { dmg: 2, range: 160, kb: 24, label: '八分連斬' },
  finisher: { dmg: 4, range: 260, kb: 60, label: '小節終結' },
};
const FRONT_BEAT_KINDS = new Set(['front', 'down']);
const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', auto: 'AUTO' };

const clamp01 = (t) => Math.min(1, Math.max(0, t));

export class Combat {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.queue = [];
    this.lastSlot = -Infinity;
    this.nextId = 1;
  }

  get busy() { return this.queue.length > 0; }
  get pendingCount() { return this.queue.filter((a) => a.state === 'pending').length; }

  /** Same code path for keyboard, touch and the debug hook. perfMs is in the performance.now() domain. */
  pressAttack(perfMs) {
    const g = this.game;
    if (g.over) return null;
    if (this.pendingCount >= 2) return null; // third press ignored
    const cond = g.conductor;
    const input = cond.inputSongTime(perfMs);
    const q = quantizeAttack({
      inputSongTime: input,
      bpm: cond.bpm,
      mode: g.settings.quantizeMode,
      lateGraceSec: g.settings.lateGraceMs / 1000,
      minSlotIndex: this.lastSlot + 1,
    });
    this.lastSlot = q.slotIndex;
    const res = g.combo.registerAttack(q);

    let kind = q.half === 'back' ? 'back' : (q.isDownbeat ? 'down' : 'front');
    if (res.finisher) kind = 'finisher';
    else if (res.eighth) kind = 'combo8';

    const expectedAudioTime = cond.beat0AudioTime + q.slotSongTime;
    const sfxKind = kind;
    const scheduledAudioTime = g.engine.playAttack(sfxKind, expectedAudioTime);

    const prev = this.queue.length ? this.queue[this.queue.length - 1] : null;
    const attack = {
      id: this.nextId++, kind, q, combo: res,
      inputSongTime: input, slotSongTime: q.slotSongTime, slotIndex: q.slotIndex,
      state: 'pending', impactSongTime: null,
      windupStart: Math.max(input, prev ? prev.slotSongTime : -Infinity),
      log: null,
    };
    const entry = {
      id: attack.id, inputSongTime: input, slotIndex: q.slotIndex, slotSongTime: q.slotSongTime,
      half: q.half, isDownbeat: q.isDownbeat, deltaSec: q.deltaSec, judgment: q.judgment, late: q.late,
      scheduledAudioTime, expectedAudioTime, impactSongTime: null,
    };
    attack.log = entry;
    pushLog('attack', entry);
    this.queue.push(attack);

    // Judgment popup above the player's head.
    const label = q.isDownbeat ? '強拍' : q.half === 'front' ? '前拍' : '後拍';
    const early = q.deltaSec < -0.045 ? ' 快' : q.deltaSec > 0.045 ? ' 慢' : '';
    const slotY = (attack.id % 3) * 16;
    g.effects.text(g.player.x + ((attack.id % 2) ? 18 : -18), g.player.y - 96 - slotY, JUDGE_TEXT[q.judgment], {
      color: JUDGE_COLORS[q.judgment], size: q.judgment === 'perfect' ? 26 : 22, life: 0.62, rise: 30,
      sub: label + early, subColor: q.isDownbeat ? COLORS.down : q.half === 'front' ? COLORS.front : COLORS.back,
    });
    g.hudPulse = 1;
    return entry;
  }

  /** Per-frame: detect impact frames, drive the player's pose. */
  update(vst) {
    const g = this.game;
    const hs = g.conductor.halfStep;
    const swing = Math.min(0.07, hs * 0.4);
    const recover = Math.min(0.12, hs * 0.8);

    for (const a of this.queue) {
      if (a.state === 'pending' && vst >= a.slotSongTime) this._impact(a, vst);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const a = this.queue[i];
      if (a.state === 'impact' && vst >= a.impactSongTime + recover) this.queue.splice(i, 1);
    }

    // Pose: earliest pending attack wins; otherwise the recovering one.
    let pose = null;
    const pend = this.queue.find((a) => a.state === 'pending');
    if (pend) {
      const tw = pend.slotSongTime - swing;
      if (vst < tw) {
        const span = tw - pend.windupStart;
        pose = { kind: pend.kind, stage: 'windup', p: span > 1e-6 ? clamp01((vst - pend.windupStart) / span) : 1 };
      } else {
        pose = { kind: pend.kind, stage: 'slash', p: clamp01((vst - tw) / swing) };
      }
    } else {
      const rec = this.queue.find((a) => a.state === 'impact');
      if (rec) pose = { kind: rec.kind, stage: 'recover', p: clamp01((vst - rec.impactSongTime) / recover) };
    }
    g.player.pose = pose;
  }

  _impact(a, vst) {
    const g = this.game;
    a.state = 'impact';
    a.impactSongTime = vst;
    a.log.impactSongTime = vst;
    const p = g.player;
    const f = p.facing;
    const move = MOVES[a.kind];
    const mult = JUDGE_MULTIPLIER[a.q.judgment];
    const cx = p.x + f * 8;
    const cy = p.bodyY;
    const big = a.kind === 'down' || a.kind === 'finisher';
    const fx = g.effects;
    const reduce = g.settings.reduceFlashing;

    fx.arc(cx, cy, f, a.kind, a.kind === 'finisher' ? MOVES.down.range : move.range);
    const col = a.kind === 'back' ? COLORS.back : big ? COLORS.down : COLORS.front;
    fx.burst(cx + f * 30, cy, big ? 22 : 10, { color: col, speed: big ? 320 : 220, angle: f > 0 ? 0 : Math.PI, spread: 1.6, size: big ? 4 : 3 });
    if (a.kind === 'down') { g.camera.addShake(5, reduce); fx.flashScreen(0.35, '#ffd24d', reduce); }
    if (a.kind === 'finisher') {
      g.camera.addShake(9, reduce); fx.flashScreen(0.7, '#ffffff', reduce);
      fx.ring(p.x, p.y - 8, move.range, COLORS.down); fx.ring(p.x, p.y - 8, move.range * 0.7, COLORS.front, 0.35);
      fx.text(p.x, p.y - 130, '小節終結!', { color: COLORS.down, size: 34, life: 1.1, rise: 40 });
    }
    if (a.kind === 'combo8') {
      g.camera.addShake(3, reduce);
      fx.text(p.x, p.y - 130, '八分連斬!', { color: COLORS.back, size: 30, life: 1.0, rise: 36 });
    }

    let hitAny = false;
    const targets = g.enemies.slice();
    for (const e of targets) {
      const dx = (e.x - p.x) * f;
      const dy = e.cy - p.bodyY;
      let hit = false;
      if (a.kind === 'finisher') {
        hit = Math.hypot(e.x - p.x, dy) - e.r <= move.range;
      } else if (a.kind === 'back' || a.kind === 'combo8') {
        hit = dx + e.r >= -4 && dx - e.r <= move.range && Math.abs(dy) <= 20 + e.r * 0.7;
      } else {
        const dist = Math.hypot(dx, dy) - e.r;
        hit = dx + e.r >= 0 && dist <= move.range && (dx <= e.r || Math.abs(Math.atan2(dy, dx)) <= 1.08);
      }
      if (!hit) continue;
      if (e.type === 'guard' && FRONT_BEAT_KINDS.has(a.kind) && e.blocks(p.x)) {
        e.blockT = 0.18;
        fx.text(e.x, e.y - 90, 'BLOCK', { color: '#9fd8ff', size: 20, life: 0.6, rise: 24 });
        fx.burst(e.x + e.facing * 22, e.cy - 6, 8, { color: '#bfe9ff', speed: 200, angle: f > 0 ? Math.PI : 0, spread: 1.4 });
        g.engine.playBlock();
        g.camera.addShake(2, reduce);
        continue;
      }
      let dmg = move.dmg * mult;
      if (a.kind === 'combo8') dmg = 1 * 2 * mult;
      g.damageEnemy(e, dmg, move.kb * (a.kind === 'finisher' ? Math.sign(e.x - p.x) || 1 : f), a.kind);
      hitAny = true;
    }
    if (hitAny) g.engine.playHit(big);
  }
}
