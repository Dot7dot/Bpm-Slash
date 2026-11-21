// Tap tempo calculator. Pure: caller passes timestamps in seconds.
import { clampBpm } from './beatMath.js';

export class TapTempo {
  constructor({ maxIntervals = 8, resetSec = 2 } = {}) {
    this.maxIntervals = maxIntervals;
    this.resetSec = resetSec;
    this.taps = [];
  }

  reset() { this.taps = []; }
  get count() { return this.taps.length; }

  /** Register a tap at time t (s). Returns BPM or null if not enough data yet. */
  tap(t) {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && t - last > this.resetSec) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > this.maxIntervals + 1) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    const avg = span / (this.taps.length - 1);
    if (!(avg > 0)) return null;
    return clampBpm(60 / avg);
  }
}
