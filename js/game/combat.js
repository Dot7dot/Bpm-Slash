// Combat: BeatSnap attack queues (one per drum), scheduled drum hits, impact frames, hit resolution, parry
// (docs/DESIGN-BEATSNAP.md sections 3, 6, 7; docs/DESIGN-DRUMMER.md section 2).
//
// HUD contract (read by js/ui/hud.js), all derived from `game.combat`:
//   combat.barHits        -> Array<{ id, tick, instrument: 'kick'|'snare', level, judgment, barIndex }>
//                            hits that already CONNECTED (impact frame passed) in the bar currently playing and the
//                            previous bar, in connect order. barIndex = floor(tick / 32); tick - 32 * barIndex is the
//                            position in the bar (0..31; 0 / 8 / 16 / 24 are beats 1..4).
//   combat.queued         -> Array<{ id, tick, connectSongTime, instrument, level, judgment, unison }>
//                            attacks pressed but not yet connected (state 'pending'), up to 3 per instrument.
//                            connectSongTime is the exact song time (s) the hit will land: draw it there.
//   combat.pendingCountBy -> { kick: n, snare: n }
//   combat.hitsInBar(b)   -> connected + queued hits of bar b, [{ id, tick, instrument, level, judgment }] (groove eval)
//   combat.lastGroove     -> null | { id, name, nameEn, fever, score, barIndex, songTime } of the latest groove
//   combat.stepTicks      -> current connect-grid step in ticks
import { beatSnap, JUDGE_MULTIPLIER, stepTicksFor, TICKS_PER_BAR } from '../core/beatSnap.js';
import { COLORS } from './constants.js';
import { evaluateGroove } from '../core/groove.js';
import { pushLog } from '../debug/debugHook.js';

export const MAX_PENDING = 3; // per instrument
export const INSTRUMENTS = Object.freeze(['kick', 'snare']);
/** Instrument modifiers (v3 section 2): kick = heavy + big knockback (blockable); snare = quick, +20 px, pierces guards. */
export const INSTRUMENT_STATS = Object.freeze({
  kick: { dmg: 1.25, kb: 1.6, reach: 0, label: '咚' },
  snare: { dmg: 0.8, kb: 0.6, reach: 20, label: '啪' },
});
export const UNISON_MULT = 1.5;

export const MOVES = {
  down: { dmg: 3, range: 96, kb: 52, label: '強拍斬' },
  front: { dmg: 2, range: 78, kb: 40, label: '前拍斬' },
  back: { dmg: 1.5, range: 92, kb: 18, label: '後拍刺' },
  sub: { dmg: 0.75, range: 72, kb: 12, label: '碎拍連刺' },
  combo8: { dmg: 3, range: 160, kb: 24, label: '八分連斬' }, // eighth thrust x2
  finisher: { dmg: 4, range: 260, kb: 60, label: '小節終結' },
  fill: { dmg: 3, range: 200, kb: 50, label: '過門重擊' },
};
/** Moves a guard's shield can block from the front when thrown by the KICK (snare, combos and shockwaves pierce). */
const BLOCKABLE = new Set(['down', 'front', 'back', 'sub']);
const RADIAL = new Set(['finisher', 'fill']);
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
    this.lastTickBy = { kick: -Infinity, snare: -Infinity }; // independent queues: each has its own minTick
    this.hits = []; // connected hits (pruned to the last few bars)
    this.lastGroove = null;
    this.nextId = 1;
    this._parryWatch = null;
  }

  /** Current connect-grid step in ticks (for the HUD). */
  get stepTicks() { return stepTicksFor(this.game.settings.subdivision, this.game.conductor.bpm); }

  get busy() { return this.queue.length > 0; }
  get pendingCount() { return this.queue.filter((a) => a.state === 'pending').length; }
  pendingOf(instrument) { let n = 0; for (const a of this.queue) if (a.state === 'pending' && a.instrument === instrument) n++; return n; }
  get pendingCountBy() { return { kick: this.pendingOf('kick'), snare: this.pendingOf('snare') }; }

  /** Bar index of the visual song time (HUD). */
  get currentBar() { return Math.floor(this.game.vst / (this.game.conductor.beatDur * 4)); }

  /** Connected hits of the current and previous bar, in connect order (HUD two-lane score). */
  get barHits() {
    const cur = this.currentBar;
    return this.hits.filter((h) => h.barIndex >= cur - 1 && h.barIndex <= cur);
  }

  /** Pending attacks with their exact connect time (HUD). */
  get queued() {
    return this.queue.filter((a) => a.state === 'pending').map((a) => ({
      id: a.id, tick: a.tick, connectSongTime: a.connectSongTime, instrument: a.instrument, level: a.level,
      judgment: a.judgment, unison: !!a.unison,
    }));
  }

  /** Connected + queued hits in one bar (used for groove evaluation, which runs on the next downbeat). */
  hitsInBar(barIndex) {
    const out = [];
    const seen = new Set();
    const lo = barIndex * TICKS_PER_BAR;
    const hi = lo + TICKS_PER_BAR;
    for (const h of this.hits) if (h.tick >= lo && h.tick < hi && !seen.has(h.id)) { seen.add(h.id); out.push(h); }
    for (const a of this.queue) {
      if (a.tick >= lo && a.tick < hi && !seen.has(a.id)) {
        seen.add(a.id);
        out.push({ id: a.id, tick: a.tick, instrument: a.instrument, level: a.level, judgment: a.judgment, barIndex });
      }
    }
    return out;
  }

  /** Groove check for the bar that just ended (called by Game on each downbeat beat event). */
  evaluateBar(barIndex) { return evaluateGroove(this.hitsInBar(barIndex), barIndex); }

  /** Parry geometry check shared by the audio prediction and findParry (spec 7). */
  _canParry(e) {
    const p = this.game.player;
    const reach = e.strikeRange ?? e.attackRange ?? e.reach ?? 70;
    return Math.abs(e.x - p.x) <= reach + 30 && (e.x - p.x) * p.facing >= 0;
  }

  /**
   * Parry (spec 7): a queued attack (either drum; pending OR already impacted, since the strike is resolved up to
   * lateGrace after its beat) whose tick equals the enemy's strikeTick. Independent of update order.
   */
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
    attack.parry = true;
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

  /**
   * Same code path for keyboard, touch and the debug hook. perfMs is in the performance.now() domain.
   * instrument: 'kick' (default) | 'snare'. Each instrument has its own queue (<= 3 pending, own minTick).
   */
  pressAttack(perfMs, instrument = 'kick') {
    const g = this.game;
    if (g.over) return null;
    if (!INSTRUMENT_STATS[instrument]) instrument = 'kick';
    if (this.pendingOf(instrument) >= MAX_PENDING) return null; // fourth press ignored
    const cond = g.conductor;
    const input = cond.inputSongTime(perfMs);
    const ctx = g.engine.ensure();
    const schedNow = ctx.currentTime - cond.beat0AudioTime;
    const strict = g.settings.lateGraceMs === 0;
    const minTick = this.lastTickBy[instrument] + 1;
    const snap = beatSnap({
      inputSongTime: input,
      schedNowSongTime: schedNow,
      bpm: cond.bpm,
      subdivision: g.settings.subdivision,
      lateGraceSec: g.settings.lateGraceMs / 1000,
      minTick,
      strict,
    });
    this.lastTickBy[instrument] = snap.tick;
    // Unison: the other drum already holds this very tick (queued or just connected).
    const partner = this.queue.find((a) => a.instrument !== instrument && a.tick === snap.tick) || null;
    const unison = !!partner;
    const feverActive = g.fever.active;
    const res = g.combo.registerAttack(snap, { fever: feverActive, instrument });
    g.fever.onAttack(snap.judgment, unison ? (res.combo || 'unison') : res.combo);

    const kind = moveKindFor(snap.level, res.combo);
    const expectedAudioTime = cond.beat0AudioTime + snap.connectSongTime;
    const desc = {
      instrument, level: snap.level, onBeat: snap.onBeat, fever: feverActive,
      combo: unison ? 'unison' : res.combo, parry: this._predictParry(snap.tick),
    };
    const sfx = this._schedule(desc, expectedAudioTime, kind);

    let prev = null; // latest earlier-connecting attack: this windup starts after it
    for (const q of this.queue) if (q.state === 'pending' && q.connectSongTime <= snap.connectSongTime && (!prev || q.connectSongTime > prev.connectSongTime)) prev = q;
    const tickDur = cond.beatDur / 8;
    const attack = {
      id: this.nextId++, kind, instrument, unison, level: snap.level, tick: snap.tick, q: snap, combo: res.combo, comboRes: res,
      fever: feverActive,
      inputSongTime: input, connectSongTime: snap.connectSongTime, slotSongTime: snap.connectSongTime,
      state: 'pending', impactSongTime: null, parried: false, parry: false,
      judgment: snap.judgment, onBeat: snap.onBeat,
      swingSec: Math.min(0.07, snap.stepTicks * tickDur * 0.6),
      windupStart: Math.max(input, prev ? prev.connectSongTime : -Infinity),
      log: null,
    };
    const entry = {
      id: attack.id, inputSongTime: input, tick: snap.tick, connectSongTime: snap.connectSongTime,
      level: snap.level, weight: snap.weight, half: snap.half, rule: snap.rule, magnet: snap.magnet, late: snap.late,
      judgeTick: snap.judgeTick, judgeDeltaSec: snap.judgeDeltaSec, judgment: snap.judgment, onBeat: snap.onBeat,
      kind, instrument, unison, combo: res.combo, parry: false, fever: feverActive,
      stepTicks: snap.stepTicks, judgeStepTicks: snap.judgeStepTicks,
      sfxClamped: sfx.clamped, scheduledAudioTime: sfx.scheduledAudioTime, expectedAudioTime,
      ctxNowAtSchedule: sfx.ctxNowAtSchedule, impactSongTime: null,
      // extra fields so the audit can re-run the algorithm exactly
      schedNowSongTime: schedNow, minTick: Number.isFinite(minTick) ? minTick : null, strict,
      pendingBefore: this.pendingOf(instrument),
      isDownbeat: snap.isDownbeat, beatIndex: snap.beatIndex, beatInBar: snap.beatInBar,
      predictedParry: desc.parry,
    };
    attack.log = entry;
    pushLog('attack', entry);
    this.queue.push(attack);
    if (partner) {
      // Both hits of a unison pair are x1.5; flag the partner (and its log) too.
      const wasUnison = partner.unison;
      partner.unison = true;
      if (partner.log) partner.log.unison = true;
      // The partner already connected (e.g. by the late rule) before this press: it dealt its damage without the
      // unison bonus, so top it up now (x1.5 total) on the enemies it struck that are still alive.
      if (!wasUnison && partner.state === 'impact' && partner.struck) {
        for (const s of partner.struck) {
          if (g.enemies.includes(s.e) && !s.e.dead) g.damageEnemy(s.e, s.base * (UNISON_MULT - 1), 0, partner.kind);
        }
        partner.struck = [];
        if (partner.log) partner.log.unisonTopUp = true;
      }
    }
    if (unison) {
      g.combo.onUnison();
      const fxp = g.effects;
      fxp.text(g.player.x, g.player.y - 172, '齊奏!', { color: COLORS.down, size: 32, life: 1.0, rise: 36, channel: 'combo' });
    }

    // Judgment popup above the player's head (single place that shows judgment).
    const fxj = g.effects;
    if (typeof fxj.judge === 'function') {
      fxj.judge(g.player.x, g.player.y - 96, { judgment: snap.judgment, onBeat: snap.onBeat, level: snap.level });
    } else {
      fxj.text(g.player.x, g.player.y - 96, snap.judgment.toUpperCase(), { channel: 'judge', life: 0.62, rise: 30 });
    }
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
    let pend = null;
    for (const a of this.queue) if (a.state === 'pending' && (!pend || a.connectSongTime < pend.connectSongTime)) pend = a;
    if (pend) {
      const tw = pend.connectSongTime - pend.swingSec;
      if (vst < tw) {
        const span = tw - pend.windupStart;
        pose = { kind: pend.kind, level: pend.level, stage: 'windup', p: span > 1e-6 ? clamp01((vst - pend.windupStart) / span) : 1 };
      } else {
        pose = { kind: pend.kind, level: pend.level, stage: 'slash', p: clamp01((vst - tw) / pend.swingSec) };
      }
    } else {
      let rec = null;
      for (const a of this.queue) if (a.state === 'impact' && (!rec || a.impactSongTime > rec.impactSongTime)) rec = a;
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
    const inst = INSTRUMENT_STATS[a.instrument] || INSTRUMENT_STATS.kick;
    const radial = RADIAL.has(a.kind);
    const range = move.range + (radial ? 0 : inst.reach);
    const mult = JUDGE_MULTIPLIER[a.q.judgment] * g.fever.multiplier * inst.dmg * (a.unison ? UNISON_MULT : 1);
    a.struck = []; // enemies this hit damaged, with the damage before the unison bonus (for a late-arriving partner)
    this.hits.push({ id: a.id, tick: a.tick, instrument: a.instrument, level: a.level, judgment: a.judgment, barIndex: Math.floor(a.tick / TICKS_PER_BAR) });
    const keepFrom = Math.floor(a.tick / TICKS_PER_BAR) - 3;
    while (this.hits.length && this.hits[0].barIndex < keepFrom) this.hits.shift();
    const cx = p.x + f * 8;
    const cy = p.bodyY;
    const big = a.kind === 'down' || a.kind === 'finisher' || a.kind === 'fill';
    const fx = g.effects;
    const reduce = g.settings.reduceFlashing;
    const onBeat = a.q.onBeat;

    fx.arc(cx, cy, f, ARC_KIND[a.kind], radial ? MOVES.down.range : range);
    const col = a.kind === 'back' || a.kind === 'sub' || a.kind === 'combo8' ? COLORS.back : big ? COLORS.down : COLORS.front;
    fx.burst(cx + f * 30, cy, big ? 22 : a.kind === 'sub' ? 5 : 10, { color: col, speed: big ? 320 : 220, angle: f > 0 ? 0 : Math.PI, spread: 1.6, size: big ? 4 : 3 });
    if (a.kind === 'down') { g.camera.addShake(5, reduce); fx.flashScreen(0.35, '#ffd24d', reduce); }
    else if (onBeat && a.kind !== 'sub') g.camera.addShake(2, reduce); // on-beat hits thump
    if (a.kind === 'finisher') {
      g.camera.addShake(9, reduce); fx.flashScreen(0.7, '#ffffff', reduce);
      fx.ring(p.x, p.y - 8, move.range, COLORS.down); fx.ring(p.x, p.y - 8, move.range * 0.7, COLORS.front, 0.35);
      // Director's ruling: when the bar's beat hits already form rock / four-on-the-floor, the GROOVE banner on the
      // next downbeat announces it, so the popup text is dropped (shockwave + sound stay).
      const gr = this.evaluateBar(Math.floor(a.tick / TICKS_PER_BAR));
      const grooveBar = !!gr && (gr.id === 'rock' || gr.id === 'fourOnFloor');
      a.log.finisherTextSuppressed = grooveBar;
      if (!grooveBar) fx.text(p.x, p.y - 172, '小節終結!', { color: COLORS.down, size: 34, life: 1.1, rise: 40, channel: 'combo' });
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
      if (radial) {
        hit = Math.hypot(e.x - p.x, dy) - e.r <= move.range;
      } else if (a.kind === 'back' || a.kind === 'combo8') {
        hit = dx + e.r >= -4 && dx - e.r <= range && Math.abs(dy) <= 20 + e.r * 0.7;
      } else {
        const dist = Math.hypot(dx, dy) - e.r;
        hit = dx + e.r >= 0 && dist <= range && (dx <= e.r || Math.abs(Math.atan2(dy, dx)) <= 1.08);
      }
      if (!hit) continue;
      if (e.type === 'guard' && a.instrument !== 'snare' && BLOCKABLE.has(a.kind) && e.blocks(p.x)) {
        e.blockT = 0.18;
        fx.text(e.x, e.y - 90, 'BLOCK', { color: '#9fd8ff', size: 20, life: 0.6, rise: 24 });
        fx.burst(e.x + e.facing * 22, e.cy - 6, 8, { color: '#bfe9ff', speed: 200, angle: f > 0 ? Math.PI : 0, spread: 1.4 });
        g.confirmBlock();
        g.camera.addShake(2, reduce);
        continue;
      }
      const dmg = move.dmg * mult;
      if (!a.unison) a.struck.push({ e, base: dmg });
      g.damageEnemy(e, dmg, move.kb * inst.kb * (radial ? Math.sign(e.x - p.x) || 1 : f), a.kind);
      hitAny = true;
    }
    if (hitAny) g.confirmHit(big);
  }
}
