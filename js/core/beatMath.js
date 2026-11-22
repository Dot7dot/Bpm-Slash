// Pure beat / bar / half-step helpers. No DOM, no Web Audio.
// All times are in seconds of "song time" unless stated otherwise.
// Times are always derived from integer indices times a step (never accumulated).

export const BEATS_PER_BAR = 4;
export const SLOTS_PER_BAR = BEATS_PER_BAR * 2;
export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const DEFAULT_BPM = 88;
/** Epsilon used when flooring so that exact boundaries are not lost to float error. */
export const EPS = 1e-9;

/** Clamp to the legal BPM range and round to 0.1. */
export function clampBpm(bpm) {
  if (!Number.isFinite(bpm)) return DEFAULT_BPM;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * 10) / 10));
}

/** Player-facing BPM: integer in [40, 240] (non-finite -> default). The engine itself still accepts decimals (audits). */
export function roundBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n)) return DEFAULT_BPM;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));
}

export function beatDur(bpm) { return 60 / bpm; }
export function halfStep(bpm) { return 30 / bpm; }

/** Positive modulo. */
export function mod(n, m) { return ((n % m) + m) % m; }

/** Song time of half-beat slot k. Even k = front beat, odd k = back beat. */
export function slotSongTime(k, bpm) { return k * (30 / bpm); }
/** Song time of integer beat index i. */
export function beatSongTime(i, bpm) { return i * (60 / bpm); }

export function beatFloatAt(songTime, bpm) { return songTime / (60 / bpm); }
export function beatIndexAt(songTime, bpm) { return Math.floor(songTime / (60 / bpm) + EPS); }
export function beatPhaseAt(songTime, bpm) {
  const f = songTime / (60 / bpm);
  const i = Math.floor(f + EPS);
  return Math.min(1, Math.max(0, f - i));
}
export function slotIndexAt(songTime, bpm) { return Math.floor(songTime / (30 / bpm) + EPS); }

export function beatInBarOf(beatIndex) { return mod(beatIndex, BEATS_PER_BAR); }
export function barIndexOf(beatIndex) { return Math.floor(beatIndex / BEATS_PER_BAR); }
export function isDownbeatIndex(beatIndex) { return beatInBarOf(beatIndex) === 0; }

/** Beat index that slot k belongs to (floor(k/2), correct for negatives). */
export function slotBeatIndex(k) { return Math.floor(k / 2); }
export function isFrontSlot(k) { return mod(k, 2) === 0; }
export function slotHalf(k) { return isFrontSlot(k) ? 'front' : 'back'; }

/** Describe a half-beat slot. */
export function slotInfo(k, bpm) {
  const beatIndex = slotBeatIndex(k);
  const beatInBar = beatInBarOf(beatIndex);
  const half = slotHalf(k);
  return {
    slotIndex: k,
    slotSongTime: slotSongTime(k, bpm),
    half,
    beatIndex,
    beatInBar,
    barIndex: barIndexOf(beatIndex),
    isDownbeat: half === 'front' && beatInBar === 0,
  };
}

/** Describe the beat position of a song time. */
export function beatInfoAt(songTime, bpm) {
  const beatFloat = beatFloatAt(songTime, bpm);
  const beatIndex = Math.floor(beatFloat + EPS);
  return {
    beatFloat,
    beatIndex,
    beatPhase: Math.min(1, Math.max(0, beatFloat - beatIndex)),
    beatInBar: beatInBarOf(beatIndex),
    barIndex: barIndexOf(beatIndex),
    isDownbeat: beatInBarOf(beatIndex) === 0,
  };
}

/** Pulse envelope used by every beat-synced animation (DESIGN 7.1). */
export function pulseAt(beatPhase, beatInBar) {
  const amp = beatInBar === 0 ? 1 : 0.55;
  return Math.exp(-beatPhase * 5) * amp;
}

/** Convenience: pulse value for a song time. */
export function pulseAtTime(songTime, bpm) {
  const b = beatInfoAt(songTime, bpm);
  return pulseAt(b.beatPhase, b.beatInBar);
}

/** Format "bar : beat" for HUD, 1-based beat, bar counted from 1 (count-in shows as 0). */
export function formatBarBeat(beatIndex) {
  const bar = barIndexOf(beatIndex);
  const beat = beatInBarOf(beatIndex) + 1;
  return { bar: Math.max(0, bar + 1), beat, countIn: beatIndex < 0 };
}
