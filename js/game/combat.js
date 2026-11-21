// Combat: BeatSnap attack queue, scheduled drum hits, impact frames, hit resolution, parry
// (docs/DESIGN-BEATSNAP.md sections 3, 6, 7).
import { beatSnap, JUDGE_MULTIPLIER, LEVEL_NAMES, tickSongTime } from '../core/beatSnap.js';
import { COLORS, JUDGE_COLORS } from './constants.js';
import { pushLog } from '../debug/debugHook.js';

export const MAX_PENDING = 3;

export const MOVES = {
  down: { dmg: 3, range: 96, kb: 52, label: '強拍斬' },
  front: { dmg: 2, range: 78, kb: 40, label: '前拍斬' },
  back: { dmg: 1.5, range: 92, kb: 18, label: '後拍刺' },
  sub: { dmg: 0.75, range: 72, kb: 12, label: '碎拍連刺' },
  combo8: { dmg: 3, range: 160, kb: 24, label: '八分連斬' }, // eighth thrust x2
  finisher: { dmg: 4, range: 260, kb: 60, label: '小節終結' },
  fill: { dmg: 3, range: 200, kb: 50, label: '過門重擊' },
};
/** Moves a shield guard blocks from the front (eighth thrusts and shockwaves pierce). */
const BLOCKABLE = new Set(['down', 'front', 'sub']);
const RADIAL = new Set(['finisher', 'fill']);
const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', off: 'OFF' };
const ARC_KIND = { down: 'down', front: 'front', sub: 'back', back: 'back', combo8: 'combo8', finisher: 'down', fill: 'down' };

const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Move kind for a snapped hit + combo. */
export function moveKindFor(level, combo) {
  if (combo === 'bar') return 'finisher';
  if (combo === 'fill') return 'fill';
  if (combo === 'eighth') return 'combo8';
  if (level === 'bar') return 'down';
  if (level === 'half' || level === 'beat') return 'front';
  if (level === 'eighth') return 'back';
  return 'sub';
}

export class Combat {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.queue = [];
    this.lastTick = -Infinity;
    this.nextId = 1;
    this._parryWatch = null;
  }

  get busy() { return this.queue.length > 0; }
  get pendingCount() { return this.queue.filter((a) => a.state === 'pending').length; }

  /** Parry geometry check shared by the audio prediction and findParry (spec 7). */
  _canParry(e) {
    const p = this.game.player;
    const reach = e.strikeRange ?? e.attackRange ?? e.reach ?? 70;
    return Math.abs(e.x - p.x) <= reach + 30 && (e.x - p.x) * p.facing >= 0;
  }

  /** Parry (spec 7): a queued attack whose tick equals the enemy's strikeTick. Independent of update order. */
  findParry(e) {
    if (!e || e.strikeTick === null || e.strikeTick === undefined) return null;
    for (const a of this.queue) {
      if (a.tick === e.strikeTick && this._canParry(e)) {
        this._parryWatch = { e, attack: a };
        return a;
      }
    }
    return null;
  }

  /** Called (by Game.onParry or by the post-hoc watch below) once an enemy was actually parried. */
  markParried(attack) {
    if (!attack || attack.parried) return false;
    attack.parried = true;
    attack.log.parry = true;
    return true;
  }

  _predictParry(tick) {
    for (const e of this.game.enemies) {
      if (e.strikeTick === tick && this._canParry(e)) return true;
    }
    return false;
  }

  _schedule(desc, expected, kind) {
    const eng = this.game.engine;
    if (typeof eng.playConfirmHit === 'function') {
      const r = eng.playHit(desc, expected);
      if (r && typeof r === 'object') return r;
    }
    // Legacy engine (pre drum kit): same shape.
    const scheduledAudioTime = eng.playAttack(kind, expected);
    const ctxNowAtSchedule = eng.lastAttackCtxNow;
    return { scheduledAudioTime, ctxNowAtSchedule, clamped: expected < ctxNowAtSchedule };
  }

  /** Same code path for keyboard, touch and the debug hook. perfMs is in the performance.now() domain. */
  pressAttack(perfMs) {
    const g = this.game;
    if (g.over) return null;
    if (this.pendingCount >= MAX_PENDING) return null; // fourth press ignored
    const cond = g.conductor;
    const input = cond.inputSongTime(perfMs);
    const ctx = g.engine.ensure();
    const schedNow = ctx.currentTime - cond.beat0AudioTime;
    const strict = g.settings.lateGraceMs === 0;
    const minTick = this.lastTick + 1;
    const snap = beatSnap({
      inputSongTime: input,
      schedNowSongTime: schedNow,
      bpm: cond.bpm,
      subdivision: g.settings.subdivision,
      lateGraceSec: g.settings.lateGraceMs / 1000,
      minTick,
      strict,
    });
    this.lastTick = snap.tick;
    const feverActive = g.fever.active;
    const res = g.combo.registerAttack(snap, { fever: feverActive });
    g.fever.onAttack(snap.judgment, res.combo);

    const kind = moveKindFor(snap.level, res.combo);
    const expectedAudioTime = cond.beat0AudioTime + snap.connectSongTime;
    const desc = { level: snap.level, onBeat: snap.onBeat, fever: feverActive, combo: res.combo, parry: this._predictParry(snap.tick) };
    const sfx = this._schedule(desc, expectedAudioTime, kind);

    const prev = this.queue.length ? this.queue[this.queue.length - 1] : null;
    const tickDur = cond.beatDur / 8;
    const attack = {
      id: this.nextId++, kind, level: snap.level, tick: snap.tick, q: snap, combo: res.combo, comboRes: res,
      fever: feverActive,
      inputSongTime: input, connectSongTime: snap.connectSongTime, slotSongTime: snap.connectSongTime,
      state: 'pending', impactSongTime: null, parried: false,
      swingSec: Math.min(0.07, snap.stepTicks * tickDur * 0.6),
      windupStart: Math.max(input, prev ? prev.connectSongTime : -Infinity),
      log: null,
    };
    const entry = {
      id: attack.id, inputSongTime: input, tick: snap.tick, connectSongTime: snap.connectSongTime,
      level: snap.level, weight: snap.weight, half: snap.half, rule: snap.rule, magnet: snap.magnet, late: snap.late,
      judgeTick: snap.judgeTick, judgeDeltaSec: snap.judgeDeltaSec, judgment: snap.judgment, onBeat: snap.onBeat,
      kind, combo: res.combo, parry: false, fever: feverActive,
      stepTicks: snap.stepTicks, judgeStepTicks: snap.judgeStepTicks,
      sfxClamped: sfx.clamped, scheduledAudioTime: sfx.scheduledAudioTime, expectedAudioTime,
      ctxNowAtSchedule: sfx.ctxNowAtSchedule, impactSongTime: null,
      // extra fields so the audit can re-run the algorithm exactly
      schedNowSongTime: schedNow, minTick: Number.isFinite(minTick) ? minTick : null, strict,
      isDownbeat: snap.isDownbeat, beatIndex: snap.beatIndex, beatInBar: snap.beatInBar,
      predictedParry: desc.parry,
    };
    attack.log = entry;
    pushLog('attack', entry);
    this.queue.push(attack);

    // Judgment popup above the player's head: judgment + on/off beat + beat position name.
    const early = snap.judgeDeltaSec < -0.045 ? ' 快' : snap.judgeDeltaSec > 0.045 ? ' 慢' : '';
    const col = snap.level === 'bar' ? COLORS.down : snap.half === 'front' ? COLORS.front : COLORS.back;
    g.effects.text(g.player.x, g.player.y - 96, JUDGE_TEXT[snap.judgment], {
      color: JUDGE_COLORS[snap.judgment], size: snap.judgment === 'perfect' ? 26 : 22, life: 0.62, rise: 30, channel: 'judge',
      sub: `${snap.onBeat ? '準拍' : '離拍'}・${LEVEL_NAMES[snap.level]}${early}`, subColor: col,
    });
    g.hudPulse = 1;
    return entry;
  }

  /** Per-frame: detect impact frames (first frame with visualSongTime >= connect), drive the player's pose. */
  update(vst) {
    const g = this.game;

    // Resolve a parry that findParry handed out (works whether or not the enemy calls Game.onParry).
    if (this._parryWatch) {
      const { e, attack } = this._parryWatch;
      this._parryWatch = null;
      if (e.stunned && !attack.parried) g.onParry(e, attack);
    }

    for (const a of this.queue) {
      if (a.state === 'pending' && vst >= a.connectSongTime) this._impact(a, vst);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const a = this.queue[i];
      if (a.state === 'impact' && vst >= a.impactSongTime + this._recoverLen(a)) this.queue.splice(i, 1);
    }

    // Pose: earliest pending attack wins; otherwise the recovering one.
    let pose = null;
    const pend = this.queue.find((a) => a.state === 'pending');
    if (pend) {
      const tw = pend.connectSongTime - pend.swingSec;
      if (vst < tw) {
        const span = tw - pend.windupStart;
        pose = { kind: pend.kind, level: pend.level, stage: 'windup', p: span > 1e-6 ? clamp01((vst - pend.windupStart) / span) : 1 };
      } else {
        pose = { kind: pend.kind, level: pend.level, stage: 'slash', p: clamp01((vst - tw) / pend.swingSec) };
      }
    } else {
      const rec = this.queue.find((a) => a.state === 'impact');
      if (rec) pose = { kind: rec.kind, level: rec.level, stage: 'recover', p: clamp01((vst - rec.impactSongTime) / this._recoverLen(rec)) };
    }
    g.player.pose = pose;
  }

  _recoverLen() { return 0.12; }

  _impact(a, vst) {
    const g = this.game;
    a.state = 'impact';
    a.impactSongTime = vst;
    a.log.impactSongTime = vst;
    const p = g.player;
    const f = p.facing;
    const move = MOVES[a.kind];
    const mult = JUDGE_MULTIPLIER[a.q.judgment] * g.fever.multiplier;
    const cx = p.x + f * 8;
    const cy = p.bodyY;
    const big = a.kind === 'down' || a.kind === 'finisher' || a.kind === 'fill';
    const fx = g.effects;
    const reduce = g.settings.reduceFlashing;
    const onBeat = a.q.onBeat;

    fx.arc(cx, cy, f, ARC_KIND[a.kind], RADIAL.has(a.kind) ? MOVES.down.range : move.range);
    const col = a.kind === 'back' || a.kind === 'sub' || a.kind === 'combo8' ? COLORS.back : big ? COLORS.down : COLORS.front;
    fx.burst(cx + f * 30, cy, big ? 22 : a.kind === 'sub' ? 5 : 10, { color: col, speed: big ? 320 : 220, angle: f > 0 ? 0 : Math.PI, spread: 1.6, size: big ? 4 : 3 });
    if (a.kind === 'down') { g.camera.addShake(5, reduce); fx.flashScreen(0.35, '#ffd24d', reduce); }
    else if (onBeat && a.kind !== 'sub') g.camera.addShake(2, reduce); // on-beat hits thump
    if (a.kind === 'finisher') {
      g.camera.addShake(9, reduce); fx.flashScreen(0.7, '#ffffff', reduce);
      fx.ring(p.x, p.y - 8, move.range, COLORS.down); fx.ring(p.x, p.y - 8, move.range * 0.7, COLORS.front, 0.35);
      fx.text(p.x, p.y - 172, '小節終結!', { color: COLORS.down, size: 34, life: 1.1, rise: 40, channel: 'combo' });
    }
    if (a.kind === 'fill') {
      g.camera.addShake(7, reduce); fx.flashScreen(0.5, '#ff4fd8', reduce);
      fx.ring(p.x, p.y - 8, move.range, COLORS.back); fx.ring(p.x, p.y - 8, move.range * 0.6, COLORS.down, 0.35);
      fx.text(p.x, p.y - 172, '過門重擊!', { color: COLORS.back, size: 32, life: 1.05, rise: 38, channel: 'combo' });
    }
    if (a.kind === 'combo8') {
      g.camera.addShake(3, reduce);
      fx.text(p.x, p.y - 172, '八分連斬!', { color: COLORS.back, size: 30, life: 1.0, rise: 36, channel: 'combo' });
    }

    let hitAny = false;
    const targets = g.enemies.slice();
    for (const e of targets) {
      const dx = (e.x - p.x) * f;
      const dy = e.cy - p.bodyY;
      let hit = false;
      if (RADIAL.has(a.kind)) {
        hit = Math.hypot(e.x - p.x, dy) - e.r <= move.range;
      } else if (a.kind === 'back' || a.kind === 'combo8') {
        hit = dx + e.r >= -4 && dx - e.r <= move.range && Math.abs(dy) <= 20 + e.r * 0.7;
      } else {
        const dist = Math.hypot(dx, dy) - e.r;
        hit = dx + e.r >= 0 && dist <= move.range && (dx <= e.r || Math.abs(Math.atan2(dy, dx)) <= 1.08);
      }
      if (!hit) continue;
      if (e.type === 'guard' && BLOCKABLE.has(a.kind) && e.blocks(p.x)) {
        e.blockT = 0.18;
        fx.text(e.x, e.y - 90, 'BLOCK', { color: '#9fd8ff', size: 20, life: 0.6, rise: 24 });
        fx.burst(e.x + e.facing * 22, e.cy - 6, 8, { color: '#bfe9ff', speed: 200, angle: f > 0 ? Math.PI : 0, spread: 1.4 });
        g.confirmBlock();
        g.camera.addShake(2, reduce);
        continue;
      }
      const dmg = move.dmg * mult;
      g.damageEnemy(e, dmg, move.kb * (RADIAL.has(a.kind) ? Math.sign(e.x - p.x) || 1 : f), a.kind);
      hitAny = true;
    }
    if (hitAny) g.confirmHit(big);
  }
}
