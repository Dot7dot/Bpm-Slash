// Combo / chain / score / fever tracking (docs/DESIGN-BEATSNAP.md section 6). Pure, no DOM.
import { mod } from './beatMath.js';

export const JUDGE_SCORE_COEF = Object.freeze({ perfect: 1.0, great: 0.8, good: 0.4, off: 0.1 });
export const COMBO_BONUS = 500;
export const PARRY_BONUS = 300;
export const FILL_MIN_RUN = 4;

export function chainMultiplier(chain) {
  return Math.min(4, 1 + Math.floor(chain / 10) * 0.5);
}

export function attackScore(judgment, chain) {
  return 100 * (JUDGE_SCORE_COEF[judgment] ?? 0) * chainMultiplier(chain);
}

export class ComboTracker {
  constructor() { this.reset(); }

  reset() {
    this.ticks = new Set();
    this.lastEighthTick = -Infinity;
    this.lastTick = -Infinity;
    this.run = 0; // consecutive attacks exactly S ticks apart
    this.runStep = 0;
    this.chain = 0;
    this.maxChain = 0;
    this.score = 0;
    this.judgments = { perfect: 0, great: 0, good: 0, off: 0 };
    this.halves = { front: 0, back: 0, downbeat: 0, sub: 0 };
    this.attacks = 0;
    this.eighthCombos = 0;
    this.finishers = 0; // bar finishers (小節終結)
    this.fills = 0; // fill hits (過門重擊)
    this.parries = 0;
  }

  /** Does attacking tick s complete an eighth combo (k, k+4, k+8, k+12 with k mod 8 == 0)? */
  _isEighth(s) {
    if (mod(s, 8) !== 4) return false;
    const k = s - 12;
    if (k <= this.lastEighthTick) return false; // do not reuse consumed ticks
    return this.ticks.has(k) && this.ticks.has(k + 4) && this.ticks.has(k + 8);
  }

  /** Does attacking tick s complete a bar finisher (four beats in one bar, nothing off-beat in between)? */
  _isFinisher(s) {
    if (mod(s, 32) !== 24) return false;
    const base = s - 24;
    if (!this.ticks.has(base) || !this.ticks.has(base + 8) || !this.ticks.has(base + 16)) return false;
    for (const v of this.ticks) if (v >= base && v < s && mod(v, 8) !== 0) return false;
    return true;
  }

  /**
   * Register a snapped attack (result of beatSnap).
   * @param {object} q beatSnap result
   * @param {{fever?: boolean}} [opt]
   * @returns {{combo:null|'eighth'|'bar'|'fill', eighth:boolean, finisher:boolean, fill:boolean, chain:number, scoreGain:number}}
   */
  registerAttack(q, { fever = false } = {}) {
    const s = q.tick;
    // Run of attacks exactly S ticks apart (fill detection).
    if (this.run > 0 && s - this.lastTick === q.stepTicks && this.runStep === q.stepTicks) this.run++;
    else { this.run = 1; this.runStep = q.stepTicks; }
    this.lastTick = s;

    this.ticks.add(s);
    for (const v of this.ticks) if (v < s - 40) this.ticks.delete(v);

    const bar = this._isFinisher(s);
    const fill = !bar && this.run >= FILL_MIN_RUN && mod(s, 32) === 0;
    const eighth = !bar && !fill && this._isEighth(s);
    let combo = null;
    if (bar) { combo = 'bar'; this.finishers++; }
    else if (fill) { combo = 'fill'; this.fills++; this.run = 0; }
    else if (eighth) { combo = 'eighth'; this.lastEighthTick = s; this.eighthCombos++; }

    this.attacks++;
    this.judgments[q.judgment]++;
    if (q.level === 'bar') this.halves.downbeat++;
    else if (q.half === 'front') this.halves.front++;
    else if (q.half === 'back') this.halves.back++;
    else this.halves.sub++;

    if (q.judgment === 'perfect' || q.judgment === 'great') this.chain++;
    else if (q.judgment === 'off' && !fever) this.chain = 0;
    if (this.chain > this.maxChain) this.maxChain = this.chain;

    let scoreGain = attackScore(q.judgment, this.chain);
    if (combo) scoreGain += COMBO_BONUS;
    this.score += scoreGain;
    return { combo, eighth: combo === 'eighth', finisher: combo === 'bar', fill: combo === 'fill', chain: this.chain, scoreGain };
  }

  addScore(n) { this.score += n; }
  onParry() { this.parries++; this.score += PARRY_BONUS; return PARRY_BONUS; }
  onHurt() { this.chain = 0; }

  /** S/A/B/C rating. */
  rating(died) {
    if (this.attacks === 0) return 'C';
    const r = (this.judgments.perfect + this.judgments.great) / this.attacks;
    if (r >= 0.85 && !died) return 'S';
    if (r >= 0.70) return 'A';
    if (r >= 0.50) return 'B';
    return 'C';
  }
}

export const FEVER_GAIN = Object.freeze({ perfect: 0.06, great: 0.04, good: 0, off: -0.05, parry: 0.25, combo: 0.10 });
export const FEVER_DECAY = 0.02;
export const FEVER_DECAY_HURT = 0.05;
export const FEVER_HURT_WINDOW = 2;
export const FEVER_BEATS = 8;

/** FEVER gauge (spec 6). Driven by song-time deltas and downbeat beat events. */
export class FeverMeter {
  constructor() { this.reset(); }

  reset() {
    this.value = 0;
    this.armed = false;
    this.active = false;
    this.endsAtBeat = null;
    this.startSongTime = 0;
    this.durSec = 0;
    this._lastT = null;
    this._hurtUntil = -Infinity;
  }

  get multiplier() { return this.active ? 2 : 1; }

  _add(d) {
    if (this.active || this.armed) return;
    this.value = Math.min(1, Math.max(0, this.value + d));
    if (this.value >= 1) { this.value = 1; this.armed = true; }
  }

  onAttack(judgment, combo) {
    this._add(FEVER_GAIN[judgment] || 0);
    if (combo) this._add(FEVER_GAIN.combo);
  }
  onParry() { this._add(FEVER_GAIN.parry); }
  onHurt(songTime) { this._hurtUntil = songTime + FEVER_HURT_WINDOW; }

  /** Per-frame: decay by the song-time delta (never by frame count). */
  update(songTime, beatDur) {
    const dt = this._lastT === null ? 0 : Math.min(0.25, Math.max(0, songTime - this._lastT));
    this._lastT = songTime;
    if (this.active) {
      this.value = Math.max(0, 1 - (songTime - this.startSongTime) / (FEVER_BEATS * beatDur));
    } else if (!this.armed && this.value > 0) {
      const rate = songTime < this._hurtUntil ? FEVER_DECAY_HURT : FEVER_DECAY;
      this.value = Math.max(0, this.value - rate * dt);
    }
  }

  /**
   * Beat event. Returns 'start' | 'end' | null (fever only starts/ends on a downbeat; an end and a new
   * start never happen in the same call because the meter is empty after an end).
   */
  onBeat(ev) {
    if (ev.beatInBar !== 0) return null;
    if (this.active && ev.beatIndex >= this.endsAtBeat) {
      this.active = false; this.value = 0; this.endsAtBeat = null;
      return 'end';
    }
    if (this.armed && !this.active) {
      this.active = true; this.armed = false; this.value = 1;
      this.endsAtBeat = ev.beatIndex + FEVER_BEATS;
      this.startSongTime = ev.beatSongTime;
      return 'start';
    }
    return null;
  }

  snapshot() { return { value: this.value, armed: this.armed, active: this.active, endsAtBeat: this.endsAtBeat }; }
}
