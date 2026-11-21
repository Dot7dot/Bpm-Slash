// Conductor: the single master clock (DESIGN section 5).
// Beat truth comes only from AudioContext time. Never from setTimeout / Date.now / accumulated dt.
import { clampBpm, EPS, beatInBarOf, barIndexOf, slotHalf } from '../core/beatMath.js';

export class Conductor {
  constructor(engine) {
    this.engine = engine;
    this.bpm = 88;
    this.offsetSec = 0;
    this.inputCalibrationSec = 0;
    /** Audio time at which song-file position 0 plays (so beat0 = songStart + offset). */
    this.songStartAudioTime = 0;
    this.paramsVersion = 0;
    this.beatListeners = [];
    this.halfListeners = [];
    this.lastVisualSongTime = 0;
    this._lastBeat = -5;
    this._lastSlot = -9;
    this._lastSmooth = 0;
  }

  setParams({ bpm, offsetSec, inputCalibrationSec } = {}) {
    if (bpm !== undefined) this.bpm = clampBpm(bpm);
    if (offsetSec !== undefined) this.offsetSec = Math.max(0, offsetSec);
    if (inputCalibrationSec !== undefined) this.inputCalibrationSec = inputCalibrationSec;
    this.paramsVersion++;
  }

  get beatDur() { return 60 / this.bpm; }
  get halfStep() { return 30 / this.bpm; }
  get beat0AudioTime() { return this.songStartAudioTime + this.offsetSec; }
  get outputLatency() { return this.engine.outputLatency; }

  /** Place beat 0 at the given audio time. */
  setBeat0(beat0AudioTime) {
    this.songStartAudioTime = beat0AudioTime - this.offsetSec;
    this.paramsVersion++;
  }

  /** Forget beat progress; the next update() emits beats starting after `lastBeat`. */
  resetBeatClock(lastBeat = -5) {
    this._lastBeat = lastBeat;
    this._lastSlot = lastBeat * 2 - 1;
    this._lastSmooth = 0;
  }

  onBeat(fn) { this.beatListeners.push(fn); return () => { this.beatListeners = this.beatListeners.filter((f) => f !== fn); }; }
  onHalf(fn) { this.halfListeners.push(fn); return () => { this.halfListeners = this.halfListeners.filter((f) => f !== fn); }; }
  clearListeners() { this.beatListeners = []; this.halfListeners = []; }

  /** Smoothed audio time (DESIGN 5.1). Falls back to ctx.currentTime when unsupported / suspended. */
  audioNow() {
    const ctx = this.engine.ctx;
    if (!ctx) return 0;
    const cur = ctx.currentTime;
    if (ctx.state !== 'running') return cur;
    const v = this._fromTimestamp(performance.now(), cur);
    // Never go backwards (jitter in getOutputTimestamp).
    if (v < this._lastSmooth && this._lastSmooth - v < 0.05) return this._lastSmooth;
    this._lastSmooth = v;
    return v;
  }

  /** Convert a performance.now()-domain time (e.g. event.timeStamp) to audio time. */
  audioTimeFromPerf(perfMs) {
    const ctx = this.engine.ctx;
    if (!ctx) return 0;
    return this._fromTimestamp(perfMs, ctx.currentTime);
  }

  _fromTimestamp(perfMs, fallback) {
    const ctx = this.engine.ctx;
    let ts = null;
    try { ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null; } catch (e) { ts = null; }
    if (!ts || !(ts.contextTime > 0) || !(ts.performanceTime > 0)) return fallback;
    const v = ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    if (!Number.isFinite(v) || Math.abs(v - fallback) > 0.25) return fallback;
    return v;
  }

  /** Heard-domain song time for an audio time. */
  heardSongTime(audioTime) { return audioTime - this.outputLatency - this.beat0AudioTime; }
  /** Scheduling-domain song time. */
  schedSongTime(audioTime) { return audioTime - this.beat0AudioTime; }
  audioTimeOfSongTime(songTime) { return this.beat0AudioTime + songTime; }

  visualSongTime() { return this.heardSongTime(this.audioNow()); }

  /** Input song time for an event timestamp (performance.now domain). Includes user calibration. */
  inputSongTime(perfMs) {
    return this.heardSongTime(this.audioTimeFromPerf(perfMs)) - this.inputCalibrationSec;
  }

  /**
   * Advance the beat clock. Emits every integer beat / half-beat crossed since the last call,
   * in order, without skipping or repeating. Returns the visual song time.
   */
  update() {
    const vst = this.visualSongTime();
    this.lastVisualSongTime = vst;
    const bd = this.beatDur;
    const hs = this.halfStep;

    const curSlot = Math.floor(vst / hs + EPS);
    if (curSlot - this._lastSlot > 1024) this._lastSlot = curSlot - 1;
    while (this._lastSlot < curSlot) {
      const k = ++this._lastSlot;
      if (this.halfListeners.length) {
        const beatIndex = Math.floor(k / 2);
        const ev = {
          slotIndex: k, half: slotHalf(k), beatIndex, beatInBar: beatInBarOf(beatIndex),
          barIndex: barIndexOf(beatIndex), slotSongTime: k * hs,
        };
        for (const fn of this.halfListeners) fn(ev);
      }
    }

    const curBeat = Math.floor(vst / bd + EPS);
    if (curBeat - this._lastBeat > 512) this._lastBeat = curBeat - 1;
    while (this._lastBeat < curBeat) {
      const i = ++this._lastBeat;
      const biB = beatInBarOf(i);
      const ev = {
        beatIndex: i, beatInBar: biB, barIndex: barIndexOf(i),
        isDownbeat: biB === 0, beatSongTime: i * bd,
      };
      for (const fn of this.beatListeners) fn(ev);
    }
    return vst;
  }
}
