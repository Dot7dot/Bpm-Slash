// BeatSnap: adaptive-subdivision hit quantizer (docs/DESIGN-BEATSNAP.md section 3). Pure functions.
// All hit times are integer ticks (1 tick = 1/32 note = beatDur / 8); time(k) = k * beatDur / 8.
import { mod } from './beatMath.js';

export const TICKS_PER_BEAT = 8;
export const TICKS_PER_BAR = 32;
export const EPS = 1e-9;

export const JUDGE_WINDOWS = Object.freeze({ perfect: 0.045, great: 0.09, good: 0.14 });
export const JUDGE_MULTIPLIER = Object.freeze({ perfect: 1.5, great: 1.25, good: 0.6, off: 0.4 });
export const DEFAULT_LATE_GRACE = 0.025;
export const DEFAULT_MIN_WINDUP = 0.05;
export const DEFAULT_MARGIN = 0.005;
export const DEFAULT_MAGNET_MAX_WAIT = 0.2;
/** v3 F2: the magnet wait cap is relative: max(magnetMaxWaitSec, MAGNET_BEAT_FRACTION * beatDur). */
export const MAGNET_BEAT_FRACTION = 0.35;
export const AUTO_MIN_SUBDIV_SEC = 0.11;
export const SUBDIVISIONS = Object.freeze([1, 2, 4, 8]);
export const LEVELS = Object.freeze(['bar', 'half', 'beat', 'eighth', 'sixteenth', 'thirtysecond']);

/** Level name of a tick (spec section 2). Correct for negative ticks. */
export function levelOfTick(k) {
  if (mod(k, 32) === 0) return 'bar';
  if (mod(k, 16) === 0) return 'half';
  if (mod(k, 8) === 0) return 'beat';
  if (mod(k, 4) === 0) return 'eighth';
  if (mod(k, 2) === 0) return 'sixteenth';
  return 'thirtysecond';
}

const WEIGHTS = { bar: 5, half: 4, beat: 3, eighth: 2, sixteenth: 1, thirtysecond: 0 };
export function weightOfLevel(level) { return WEIGHTS[level]; }
export function weightOfTick(k) { return WEIGHTS[levelOfTick(k)]; }

/** Compat half field: 'front' (bar/half/beat), 'back' (eighth), 'sub' (finer). */
export function halfOfLevel(level) {
  if (level === 'bar' || level === 'half' || level === 'beat') return 'front';
  return level === 'eighth' ? 'back' : 'sub';
}

/** Largest d in {8,4,2,1} with beatDur / d >= 0.11 s. */
export function autoSubdivision(bpm) {
  const bd = 60 / bpm;
  for (const d of [8, 4, 2]) if (bd / d >= AUTO_MIN_SUBDIV_SEC - EPS) return d;
  return 1;
}

/** Resolve a setting ('auto' | 1 | 2 | 4 | 8) to a concrete d. */
export function resolveSubdivision(subdivision, bpm) {
  const n = Number(subdivision);
  if (subdivision === 'auto' || !SUBDIVISIONS.includes(n)) return autoSubdivision(bpm);
  return n;
}

/** Connect-grid step in ticks (8 / d). */
export function stepTicksFor(subdivision, bpm) { return TICKS_PER_BEAT / resolveSubdivision(subdivision, bpm); }

/** Judge-grid step in ticks: max(4, S). */
export function judgeStepFor(stepTicks) { return Math.max(4, stepTicks); }

/** Judgment for an absolute timing error (seconds). */
export function judgeDelta(absDeltaSec) {
  const a = absDeltaSec - EPS;
  if (a <= JUDGE_WINDOWS.perfect) return 'perfect';
  if (a <= JUDGE_WINDOWS.great) return 'great';
  if (a <= JUDGE_WINDOWS.good) return 'good';
  return 'off';
}

/** Song time of tick k (integer multiply, never accumulated). */
export function tickSongTime(k, bpm) { return (k * (60 / bpm)) / 8; }

/** Display names. */
export const LEVEL_NAMES = Object.freeze({
  bar: '強拍', half: '半小節', beat: '正拍', eighth: '後拍', sixteenth: '十六分', thirtysecond: '三十二分',
});
export const SUBDIVISION_NAMES = Object.freeze({ 1: '四分', 2: '八分', 4: '十六分', 8: '三十二分' });

/**
 * BeatSnap (spec 3.2).
 * @param {object} p
 * @param {number} p.inputSongTime heard-domain input time (s)
 * @param {number} p.schedNowSongTime scheduling-domain "now" (ctx.currentTime - beat0AudioTime)
 * @param {number} p.bpm
 * @param {'auto'|1|2|4|8} [p.subdivision='auto']
 * @param {number} [p.lateGraceSec]
 * @param {number} [p.minWindupSec]
 * @param {number} [p.marginSec]
 * @param {number} [p.magnetMaxWaitSec]
 * @param {number} [p.minTick=-Infinity] queueing: chosen tick must be >= this
 * @param {boolean} [p.strict=false]
 */
export function beatSnap({
  inputSongTime,
  schedNowSongTime,
  bpm,
  subdivision = 'auto',
  lateGraceSec = DEFAULT_LATE_GRACE,
  minWindupSec = DEFAULT_MIN_WINDUP,
  marginSec = DEFAULT_MARGIN,
  magnetMaxWaitSec = DEFAULT_MAGNET_MAX_WAIT,
  minTick = -Infinity,
  strict = false,
}) {
  const t = inputSongTime;
  const s = schedNowSongTime;
  const beatDur = 60 / bpm;
  const tickDur = beatDur / 8;
  const time = (k) => (k * beatDur) / 8;
  const S = stepTicksFor(subdivision, bpm);
  const J = judgeStepFor(S);

  const schedMinTick = Math.ceil((s + marginSec) / tickDur - EPS);
  const aimWindowSec = Math.min(0.09, (J * tickDur) / 2);

  const pJ = Math.floor(t / (J * tickDur) + EPS) * J;
  const nJ = pJ + J;

  let tick;
  let rule;
  let magnet = false;
  if (!strict && t - time(pJ) <= lateGraceSec + EPS && pJ >= minTick) {
    tick = pJ; rule = 'late';
  } else if (time(nJ) - t <= aimWindowSec + EPS && nJ >= minTick && (!strict || nJ >= schedMinTick)) {
    tick = nJ; rule = 'aimed';
  } else {
    const earliest = Math.max(t + minWindupSec, s + marginSec);
    const lo = Math.max(Math.ceil(earliest / tickDur - EPS), minTick, schedMinTick);
    const c0 = Math.ceil(lo / S) * S;
    const c1 = c0 + S;
    const magnetCap = Math.max(magnetMaxWaitSec, MAGNET_BEAT_FRACTION * beatDur);
    if (weightOfTick(c1) >= 3 && weightOfTick(c1) > weightOfTick(c0) && time(c1) - time(c0) <= magnetCap + EPS) {
      tick = c1; magnet = true;
    } else {
      tick = c0;
    }
    rule = 'snap';
  }

  const a = Math.round(t / (J * tickDur)) * J;
  const judgeDeltaSec = t - time(a);
  const judgment = judgeDelta(Math.abs(judgeDeltaSec));
  const level = levelOfTick(tick);
  const beatIndex = Math.floor(tick / 8);
  return {
    tick,
    connectSongTime: time(tick),
    level,
    weight: WEIGHTS[level],
    half: halfOfLevel(level),
    rule,
    magnet,
    late: rule === 'late',
    judgeTick: a,
    judgeDeltaSec,
    judgment,
    onBeat: judgment === 'perfect' || judgment === 'great',
    beatIndex,
    beatInBar: mod(beatIndex, 4),
    barIndex: Math.floor(tick / 32),
    isDownbeat: mod(tick, 32) === 0,
    stepTicks: S,
    judgeStepTicks: J,
  };
}
