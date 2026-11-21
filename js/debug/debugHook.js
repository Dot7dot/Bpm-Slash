// Debug hook contract (DESIGN section 10): window.__BPM_SLASH_DEBUG__
import { stepTicksFor, judgeStepFor } from '../core/beatSnap.js';

const MAX_LOG = 5000;

const logs = { attack: [], beat: [], world: [], metronome: [] };

let appRef = null;

/** Append to a log, dropping the oldest entries beyond MAX_LOG. */
export function pushLog(name, entry) {
  // Metronome entries are pushed synchronously from the engine's onClick right after the click was
  // scheduled; attach the ctx.currentTime the engine read for that click if the caller did not.
  if (name === 'metronome' && entry.ctxNowAtSchedule === undefined && appRef && appRef.engine) {
    entry.ctxNowAtSchedule = appRef.engine.lastClickCtxNow;
  }
  const arr = logs[name];
  arr.push(entry);
  if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
}

export function clearLogs() {
  for (const k of Object.keys(logs)) logs[k].length = 0;
}

const copy = (arr) => arr.map((e) => ({ ...e }));

export function installDebugHook(app) {
  appRef = app;
  const hook = {
    version: 3,
    getState() {
      const c = app.conductor;
      const hasCtx = !!app.engine.ctx;
      const stepTicks = stepTicksFor(app.settings.subdivision, c.bpm);
      const dur = app.song ? app.song.buffer.duration : 0;
      return {
        scene: app.scene,
        bpm: c.bpm,
        offsetMs: Math.round(c.offsetSec * 1000 * 1000) / 1000,
        subdivision: app.settings.subdivision,
        stepTicks,
        judgeStepTicks: judgeStepFor(stepTicks),
        fever: app.game ? app.game.fever.snapshot() : { value: 0, armed: false, active: false, endsAtBeat: null },
        lateGraceMs: app.settings.lateGraceMs,
        inputCalibrationMs: app.settings.inputCalibrationMs,
        songTime: hasCtx ? c.visualSongTime() : 0,
        beatFloat: hasCtx ? c.visualSongTime() / c.beatDur : 0,
        beat0AudioTime: c.beat0AudioTime,
        audioNow: hasCtx ? c.audioNow() : 0,
        outputLatency: app.engine.outputLatency,
        songName: app.song ? app.song.name : '',
        songDuration: dur,
      };
    },
    async start(opts = {}) {
      clearLogs();
      await app.startGame({ ...opts, fromDebug: true });
    },
    stop() { app.stopToMenu(); },
    /** instrument: 'kick' (default) | 'snare'. Attack log entries carry `instrument` and `unison`. */
    pressAttack(instrument = 'kick') { return app.pressAttack(performance.now(), instrument === 'snare' ? 'snare' : 'kick'); },
    /** The live Game (or null) so tests can inspect combat.barHits / combat.queued / combo etc. */
    getGame() { return app.game || null; },
    setInvincible(v) { app.invincible = !!v; if (app.game) app.game.invincible = !!v; },
    getAttackLog() { return copy(logs.attack); },
    getBeatLog() { return copy(logs.beat); },
    getWorldLog() { return copy(logs.world); },
    getMetronomeLog() { return copy(logs.metronome); },
    clearLogs,
  };
  window.__BPM_SLASH_DEBUG__ = hook;
  return hook;
}
