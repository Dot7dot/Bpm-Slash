// AudioEngine: AudioContext ownership, decoding, song playback, SFX synthesis, metronome scheduler.
import { mod } from '../core/beatMath.js';
import { SfxVoices, makeNoiseBuffer, KIND_TO_DESC } from './sfxVoices.js';

/** Zero-latency soft limiter curve: identity up to `knee`, tanh knee above, output never exceeds 1. */
export function makeLimiterCurve(knee = 0.75, n = 4097) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

const METRO_LOOKAHEAD_SEC = 0.2;
const LATE_CATCHUP_SEC = 0.05;

const DEFAULT_JSON = { title: '預設曲 Neon Pulse', bpm: 88, offsetMs: 0, beatsPerBar: 4, bars: 32 };

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.clickGain = null;
    this.source = null;
    this.noiseBuf = null;
    this.voices = null;
    /** ctx.currentTime read immediately before the latest attack / click was scheduled. */
    this.lastAttackCtxNow = NaN;
    this.lastClickCtxNow = NaN;
    this._metro = null;
    this.volumes = { music: 0.8, sfx: 0.9 };
  }

  get outputLatency() {
    const c = this.ctx;
    if (!c) return 0;
    return c.outputLatency || c.baseLatency || 0;
  }

  /** Create (once) and return the AudioContext. Call from a user gesture when possible. */
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 1;
    // Master soft limiter (linear below 0.75, smooth knee, hard ceiling at 0 dBFS; zero latency).
    this.masterShaper = c.createWaveShaper();
    this.masterShaper.curve = makeLimiterCurve();
    this.master.connect(this.masterShaper);
    this.masterShaper.connect(c.destination);
    this.musicGain = c.createGain();
    this.sfxGain = c.createGain();
    this.clickGain = c.createGain();
    this.musicGain.connect(this.master);
    // Soft clip (tanh, no lookahead / zero latency, so onsets are not shifted) as a safety net on the SFX bus.
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 1.2) / Math.tanh(1.2); }
    this.sfxShaper = c.createWaveShaper();
    this.sfxShaper.curve = curve;
    this.sfxShaper.oversample = 'none';
    this.sfxGain.connect(this.sfxShaper);
    this.sfxShaper.connect(this.master);
    this.clickGain.connect(this.master);
    this.setVolumes(this.volumes);
    // Shared white-noise buffer + synth voices (js/audio/sfxVoices.js).
    this.noiseBuf = makeNoiseBuffer(c);
    this.voices = new SfxVoices(c, { sfx: this.sfxGain, click: this.clickGain }, this.noiseBuf);
    return c;
  }

  async resume() {
    this.ensure();
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }
    return this.ctx.state === 'running';
  }

  async suspend() { if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend(); }

  setVolumes({ music, sfx }) {
    if (music !== undefined) this.volumes.music = music;
    if (sfx !== undefined) this.volumes.sfx = sfx;
    if (!this.ctx) return;
    this.musicGain.gain.value = this.volumes.music;
    this.sfxGain.gain.value = this.volumes.sfx;
    this.clickGain.gain.value = Math.min(1, this.volumes.sfx * 1.1);
  }

  // ---------- Loading ----------

  async decode(arrayBuffer) {
    // Decoding does not need a running context; use an offline one before the first user gesture
    // so that no AudioContext autoplay warnings are produced while the menu is idle.
    const c = this.ctx || new OfflineAudioContext(1, 1, 44100);
    return await c.decodeAudioData(arrayBuffer);
  }

  /** Load the bundled default song. Falls back to an in-memory click track on failure. */
  async loadDefaultSong() {
    let meta = { ...DEFAULT_JSON };
    let metaOk = false;
    try {
      const r = await fetch('assets/audio/default-88bpm.json', { cache: 'no-store' });
      if (r.ok) { meta = { ...meta, ...(await r.json()) }; metaOk = true; }
    } catch (e) { /* use built-in defaults */ }
    try {
      const r = await fetch('assets/audio/default-88bpm.wav');
      if (!r.ok) throw new Error('http ' + r.status);
      const buffer = await this.decode(await r.arrayBuffer());
      return { buffer, meta, fallback: false, metaOk };
    } catch (e) {
      const buffer = this._synthFallback(meta.bpm || 88, meta.bars || 32);
      return { buffer, meta, fallback: true, metaOk };
    }
  }

  /** Temporary in-memory click/drum track used only if the bundled WAV is missing. */
  _synthFallback(bpm, bars) {
    const sr = 22050;
    const beat = 60 / bpm;
    const total = Math.ceil(bars * 4 * beat * sr) + sr;
    const buf = new AudioBuffer({ numberOfChannels: 1, length: total, sampleRate: sr });
    const d = buf.getChannelData(0);
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    const add = (t0, fn, len) => {
      const s0 = Math.floor(t0 * sr);
      for (let i = 0; i < len * sr && s0 + i < total; i++) d[s0 + i] += fn(i / sr);
    };
    for (let b = 0; b < bars * 4; b++) {
      const t = b * beat;
      add(t, (x) => Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9) * 0.7, 0.35);
      if (b % 4 === 1 || b % 4 === 3) add(t, (x) => rnd() * Math.exp(-x * 18) * 0.35, 0.2);
      add(t + beat / 2, (x) => rnd() * Math.exp(-x * 90) * 0.18, 0.08);
      add(t, (x) => Math.sin(2 * Math.PI * (b % 8 < 4 ? 110 : 82.4) * x) * Math.exp(-x * 3) * 0.18, 0.5);
    }
    return buf;
  }

  // ---------- Song playback ----------

  /** Play the buffer so that file position 0 sits at songStartAudioTime (DESIGN 5.2). */
  playSong(buffer, songStartAudioTime) {
    this.stopSong();
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.musicGain);
    const now = ctx.currentTime;
    if (songStartAudioTime >= now) {
      src.start(songStartAudioTime);
    } else {
      const when = now + 0.005;
      src.start(when, when - songStartAudioTime);
    }
    this.source = src;
    src.onended = () => { if (this.source === src) this.source = null; };
    return src;
  }

  stopSong() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) { /* already stopped */ }
      try { this.source.disconnect(); } catch (e) { /* ignore */ }
      this.source = null;
    }
  }

  // ---------- Metronome (lookahead scheduler) ----------

  /**
   * Schedule clicks on beat0 + n * beatDur. Lookahead 200 ms, timer 25 ms. After a main-thread stall,
   * clicks missed by <= LATE_CATCHUP_SEC are still played at `now` (each beat index is visited exactly once, so
   * nothing is ever double-scheduled); clicks missed by more are dropped (a click far off the grid is worse than none).
   * @param {Conductor} cond
   * @param {object} o
   * @param {number} o.startBeat first beat index to consider
   * @param {()=>boolean} o.enabled whether beats >= 0 click
   * @param {boolean} o.forceCountIn beats < 0 always click
   * @param {(beatIndex:number, scheduled:number, expected:number, ctxNowAtSchedule:number)=>void} [o.onClick]
   */
  startMetronome(cond, { startBeat = -4, enabled = () => true, forceCountIn = true, onClick } = {}) {
    this.stopMetronome();
    const ctx = this.ensure();
    const m = { next: startBeat, min: startBeat, ver: cond.paramsVersion, timer: 0 };
    const tick = () => {
      if (ctx.state !== 'running') return;
      const now = ctx.currentTime;
      if (m.ver !== cond.paramsVersion) {
        // Tempo or offset changed live: re-derive the next beat from the new grid.
        m.ver = cond.paramsVersion;
        m.next = Math.max(m.min, Math.ceil((now + 0.002 - cond.beat0AudioTime) / cond.beatDur - 1e-9));
      }
      const horizon = now + METRO_LOOKAHEAD_SEC;
      for (let guard = 0; guard < 64; guard++) {
        const expected = cond.beat0AudioTime + m.next * cond.beatDur;
        if (expected > horizon) break;
        if (expected >= now - LATE_CATCHUP_SEC) {
          if ((m.next < 0 && forceCountIn) || (m.next >= 0 && enabled())) {
            const when = Math.max(expected, now);
            this.lastClickCtxNow = now;
            this.playClick(when, mod(m.next, 4) === 0);
            if (onClick) onClick(m.next, when, expected, now);
          }
        }
        m.next++;
      }
    };
    m.timer = setInterval(tick, 25);
    this._metro = m;
    tick();
  }

  stopMetronome() {
    if (this._metro) { clearInterval(this._metro.timer); this._metro = null; }
  }

  // ---------- SFX synthesis ----------

  _tone(when, o) { this.voices.tone(when, o); }
  _noise(when, o) { this.voices.noise(when, o); }

  playClick(when, accent) { this.voices.click(when, accent); }

  /**
   * v3 hit SFX (drum kit; desc.instrument 'kick'|'snare') scheduled on the audio clock.
   * playHit(desc, expectedAudioTime) -> { scheduledAudioTime, ctxNowAtSchedule, clamped }.
   * Transitional: playHit(boolean) behaves like the old reactive hit (= playConfirmHit).
   */
  playHit(desc, expected) {
    if (typeof desc === 'boolean' || desc === undefined) { this.playConfirmHit(!!desc); return undefined; }
    const ctx = this.ensure();
    const ctxNowAtSchedule = ctx.currentTime;
    const when = expected > ctxNowAtSchedule ? expected : ctxNowAtSchedule;
    this.lastAttackCtxNow = ctxNowAtSchedule;
    this.voices.hit(desc, when);
    return { scheduledAudioTime: when, ctxNowAtSchedule, clamped: expected < ctxNowAtSchedule };
  }

  /** Deprecated: old attack kinds; returns the audio time passed to start(). */
  playAttack(kind, expected) {
    const r = this.playHit(KIND_TO_DESC[kind] || KIND_TO_DESC.front, expected);
    return r.scheduledAudioTime;
  }

  // Reactive confirm sounds (fire at impact time): soft attack, low level, tonal.
  playConfirmHit(big = false) { const c = this.ensure(); this.voices.confirmHit(c.currentTime, big); }
  playConfirmBlock() { const c = this.ensure(); this.voices.confirmBlock(c.currentTime); }
  playConfirmKill() { const c = this.ensure(); this.voices.confirmKill(c.currentTime); }
  playBlock() { this.playConfirmBlock(); }
  /** Parry actually succeeded (Game.onParry): soft-attack tonal clang tail. */
  playConfirmParry() { const c = this.ensure(); this.voices.confirmParry(c.currentTime); }
  /** Player hurt: soft attack (>= 15 ms), tonal, no sharp off-grid transient. */
  playHurt() { const c = this.ensure(); this.voices.hurt(c.currentTime); }
  playKill() { this.playConfirmKill(); }
  playGo() {
    const c = this.ensure(); const t = c.currentTime;
    this._tone(t, { type: 'square', f0: 880, dur: 0.25, gain: 0.12 });
  }
  playResult(win) {
    const c = this.ensure(); const t = c.currentTime;
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63, 196];
    notes.forEach((f, i) => this._tone(t + i * 0.14, { type: 'triangle', f0: f, dur: 0.4, gain: 0.2 }));
  }
}
