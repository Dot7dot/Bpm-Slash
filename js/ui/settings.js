// Persistent settings (localStorage, always wrapped in try/catch).
import { clampBpm } from '../core/beatMath.js';

const KEY = 'bpmSlash.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  bpm: 88,
  offsetMs: 0,
  inputCalibrationMs: 0,
  lateGraceMs: 40,
  subdivision: 'auto', // 'auto' | 1 | 2 | 4 | 8 (beat divisions: quarter / eighth / sixteenth / thirty-second)
  metronome: true,
  musicVol: 0.8,
  sfxVol: 0.9,
  reduceFlashing: false,
});

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function sanitizeSubdivision(v) {
  if (v === 'auto' || v === undefined || v === null) return 'auto';
  const n = Number(v);
  return n === 1 || n === 2 || n === 4 || n === 8 ? n : 'auto';
}

export function sanitizeSettings(s = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    bpm: clampBpm(num(s.bpm, 40, 240, d.bpm)),
    offsetMs: num(s.offsetMs, 0, 10000, d.offsetMs),
    inputCalibrationMs: num(s.inputCalibrationMs, -150, 150, d.inputCalibrationMs),
    lateGraceMs: num(s.lateGraceMs, 0, 100, d.lateGraceMs),
    subdivision: sanitizeSubdivision(s.subdivision),
    metronome: s.metronome === undefined ? d.metronome : !!s.metronome,
    musicVol: num(s.musicVol, 0, 1, d.musicVol),
    sfxVol: num(s.sfxVol, 0, 1, d.sfxVol),
    reduceFlashing: !!s.reduceFlashing,
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch (e) { /* storage unavailable */ }
  return sanitizeSettings({});
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}
