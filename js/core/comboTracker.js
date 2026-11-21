// Combo / chain / score tracking (DESIGN section 6.4). Pure, no DOM.
import { mod } from './beatMath.js';

export const JUDGE_SCORE_COEF = Object.freeze({ perfect: 1.0, great: 0.8, good: 0.5, auto: 0.2 });
export const COMBO_BONUS = 500;

export function chainMultiplier(chain) {
  return Math.min(4, 1 + Math.floor(chain / 10) * 0.5);
}

export function attackScore(judgment, chain) {
  return 100 * (JUDGE_SCORE_COEF[judgment] ?? 0) * chainMultiplier(chain);
}

export class ComboTracker {
  constructor() { this.reset(); }

  reset() {
    this.slots = new Set();
    this.lastEighthSlot = -Infinity;
    this.chain = 0;
    this.maxChain = 0;
    this.score = 0;
    this.judgments = { perfect: 0, great: 0, good: 0, auto: 0 };
    this.halves = { front: 0, back: 0, downbeat: 0 };
    this.attacks = 0;
    this.eighthCombos = 0;
    this.finishers = 0;
  }

  /** Does attacking slot s complete an eighth-note combo (k, k+1, k+2, k+3 with k even)? */
  _isEighth(s) {
    if (mod(s, 2) !== 1) return false;
    const k = s - 3; // always even when s is odd
    if (k <= this.lastEighthSlot) return false; // do not reuse consumed slots
    return this.slots.has(s - 1) && this.slots.has(s - 2) && this.slots.has(k);
  }

  /** Does attacking slot s complete a bar finisher (four front beats, no back beats in between)? */
  _isFinisher(s) {
    if (mod(s, 8) !== 6) return false;
    const base = s - 6;
    for (let i = 0; i <= 6; i += 2) if (!this.slots.has(base + i)) return false;
    for (let i = 1; i <= 7; i += 2) if (this.slots.has(base + i)) return false;
    return true;
  }

  /**
   * Register a quantized attack.
   * @returns {{eighth:boolean, finisher:boolean, chain:number, scoreGain:number}}
   */
  registerAttack(q) {
    const s = q.slotIndex;
    this.slots.add(s);
    for (const v of this.slots) if (v < s - 24) this.slots.delete(v);

    const eighth = this._isEighth(s);
    if (eighth) { this.lastEighthSlot = s; this.eighthCombos++; }
    const finisher = this._isFinisher(s);
    if (finisher) this.finishers++;

    this.attacks++;
    this.judgments[q.judgment]++;
    if (q.isDownbeat) this.halves.downbeat++;
    else if (q.half === 'front') this.halves.front++;
    else this.halves.back++;

    if (q.judgment === 'auto') this.chain = 0;
    else this.chain++;
    if (this.chain > this.maxChain) this.maxChain = this.chain;

    let scoreGain = attackScore(q.judgment, this.chain);
    if (eighth || finisher) scoreGain += COMBO_BONUS;
    this.score += scoreGain;
    return { eighth, finisher, chain: this.chain, scoreGain };
  }

  addScore(n) { this.score += n; }
  onHurt() { this.chain = 0; }

  /** S/A/B/C rating (DESIGN 9.2). */
  rating(died) {
    if (this.attacks === 0) return 'C';
    const r = (this.judgments.perfect + this.judgments.great) / this.attacks;
    if (r >= 0.85 && !died) return 'S';
    if (r >= 0.70) return 'A';
    if (r >= 0.50) return 'B';
    return 'C';
  }
}
