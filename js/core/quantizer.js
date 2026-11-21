// Attack quantizer (DESIGN section 6.1). Pure function.
import { EPS, slotInfo } from './beatMath.js';

export const JUDGE_WINDOWS = Object.freeze({ perfect: 0.045, great: 0.09, good: 0.14 });
export const DEFAULT_LATE_GRACE = 0.04;
export const JUDGE_MULTIPLIER = Object.freeze({ perfect: 1.5, great: 1.25, good: 1.0, auto: 0.75 });

/** Judgment for an absolute timing error in seconds. */
export function judgeDelta(absDeltaSec) {
  const a = absDeltaSec - EPS;
  if (a <= JUDGE_WINDOWS.perfect) return 'perfect';
  if (a <= JUDGE_WINDOWS.great) return 'great';
  if (a <= JUDGE_WINDOWS.good) return 'good';
  return 'auto';
}

/**
 * Snap an input time to the half-beat grid.
 * @param {object} p
 * @param {number} p.inputSongTime heard-domain song time of the input (s)
 * @param {number} p.bpm
 * @param {'half'|'beat'} [p.mode='half']
 * @param {number} [p.lateGraceSec=0.04] 0 = strict mode (always snap forward)
 * @param {number} [p.minSlotIndex=-Infinity] queueing: chosen slot must be >= this
 */
export function quantizeAttack({
  inputSongTime,
  bpm,
  mode = 'half',
  lateGraceSec = DEFAULT_LATE_GRACE,
  minSlotIndex = -Infinity,
}) {
  const halfStep = 30 / bpm;
  const step = mode === 'beat' ? 2 : 1;

  // Largest usable slot whose time is <= input.
  let prev = Math.floor(inputSongTime / halfStep + EPS);
  if (step === 2 && Math.abs(prev % 2) === 1) prev -= 1;
  const next = prev + step;

  const prevDelta = inputSongTime - prev * halfStep;
  let chosen;
  let usedPrev = false;
  if (prevDelta <= lateGraceSec + EPS && prev >= minSlotIndex) {
    chosen = prev;
    usedPrev = true;
  } else {
    chosen = next;
  }

  if (chosen < minSlotIndex) {
    let m = Math.ceil(minSlotIndex);
    if (step === 2 && Math.abs(m % 2) === 1) m += 1;
    chosen = m;
    usedPrev = false;
  }

  const slotTime = chosen * halfStep;
  const deltaSec = inputSongTime - slotTime;
  const info = slotInfo(chosen, bpm);
  return {
    slotIndex: chosen,
    slotSongTime: slotTime,
    half: info.half,
    beatIndex: info.beatIndex,
    beatInBar: info.beatInBar,
    isDownbeat: info.isDownbeat,
    deltaSec,
    judgment: judgeDelta(Math.abs(deltaSec)),
    late: usedPrev && deltaSec > EPS,
  };
}
