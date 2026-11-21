// AudioEngine: AudioContext ownership, decoding, song playback, SFX synthesis, metronome scheduler.
import { mod } from '../core/beatMath.js';

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
    this.master.connect(c.destination);
    this.musicGain = c.createGain();
    this.sfxGain = c.createGain();
    this.clickGain = c.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this.clickGain.connect(this.master);
    this.setVolumes(this.volumes);
    // Shared white-noise buffer for slashes etc.
    const len = c.sampleRate;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
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
    this.ensure();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  /** Load the bundled default song. Falls back to an in-memory click track on failure. */
  async loadDefaultSong() {
    this.ensure();
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
    const buf = this.ctx.createBuffer(1, total, sr);
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
   * Schedule clicks on beat0 + n * beatDur. Lookahead 100 ms, timer 25 ms.
   * @param {Conductor} cond
   * @param {object} o
   * @param {number} o.startBeat first beat index to consider
   * @param {()=>boolean} o.enabled whether beats >= 0 click
   * @param {boolean} o.forceCountIn beats < 0 always click
   * @param {(beatIndex:number, scheduled:number, expected:number)=>void} [o.onClick]
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
      const horizon = now + 0.1;
      for (let guard = 0; guard < 64; guard++) {
        const expected = cond.beat0AudioTime + m.next * cond.beatDur;
        if (expected > horizon) break;
        if (expected >= now - 0.01) {
          if ((m.next < 0 && forceCountIn) || (m.next >= 0 && enabled())) {
            const when = Math.max(expected, now);
            this.playClick(when, mod(m.next, 4) === 0);
            if (onClick) onClick(m.next, when, expected);
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

  _tone(when, { type = 'sine', f0, f1 = f0, dur = 0.1, gain = 0.3, out = this.sfxGain, attack = 0.002 }) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(out);
    o.start(when); o.stop(when + dur + 0.02);
  }

  _noise(when, { f0, f1 = f0, q = 1, dur = 0.1, gain = 0.3, type = 'bandpass', out = this.sfxGain }) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(when, Math.random() * 0.5); s.stop(when + dur + 0.02);
  }

  playClick(when, accent) {
    this._tone(when, { type: 'sine', f0: accent ? 1760 : 1100, dur: 0.045, gain: accent ? 0.55 : 0.4, out: this.clickGain, attack: 0.001 });
    this._tone(when, { type: 'triangle', f0: accent ? 880 : 550, dur: 0.03, gain: 0.2, out: this.clickGain, attack: 0.001 });
  }

  /**
   * Attack SFX scheduled on the audio clock. Returns the audio time actually used.
   * kind: front | down | back | finisher | combo8
   */
  playAttack(kind, expected) {
    const ctx = this.ensure();
    const now = ctx.currentTime;
    const when = expected > now ? expected : now;
    switch (kind) {
      case 'back':
      case 'combo8':
        this._noise(when, { f0: 5000, f1: 9000, q: 0.8, dur: 0.07, gain: 0.32 });
        this._tone(when, { type: 'sine', f0: 700, f1: 1900, dur: 0.09, gain: 0.3 });
        this._tone(when, { type: 'square', f0: 1400, f1: 2400, dur: 0.05, gain: 0.05 });
        if (kind === 'combo8') {
          this._tone(when, { type: 'triangle', f0: 1318, dur: 0.3, gain: 0.16 });
          this._tone(when + 0.04, { type: 'triangle', f0: 1976, dur: 0.3, gain: 0.12 });
        }
        break;
      case 'down':
      case 'finisher':
        this._noise(when, { f0: 2600, f1: 260, q: 0.7, dur: 0.3, gain: 0.7 });
        this._tone(when, { type: 'sawtooth', f0: 130, f1: 40, dur: 0.32, gain: 0.45 });
        this._tone(when, { type: 'sine', f0: 70, f1: 32, dur: 0.4, gain: 0.8 });
        this._tone(when, { type: 'triangle', f0: 440, dur: 0.32, gain: 0.11 });
        this._tone(when, { type: 'triangle', f0: 660, dur: 0.32, gain: 0.09 });
        if (kind === 'finisher') {
          this._noise(when + 0.02, { f0: 900, f1: 80, q: 0.5, dur: 0.6, gain: 0.7, type: 'lowpass' });
          this._tone(when, { type: 'sine', f0: 55, f1: 24, dur: 0.7, gain: 0.9 });
        }
        break;
      default: // front
        this._noise(when, { f0: 3200, f1: 700, q: 0.9, dur: 0.16, gain: 0.5 });
        this._tone(when, { type: 'sine', f0: 190, f1: 60, dur: 0.14, gain: 0.6 });
        this._tone(when, { type: 'sawtooth', f0: 330, f1: 120, dur: 0.1, gain: 0.07 });
    }
    return when;
  }

  playHit(strong = false) {
    const c = this.ensure(); const t = c.currentTime;
    this._noise(t, { f0: 1800, f1: 400, q: 0.8, dur: 0.1, gain: strong ? 0.5 : 0.35 });
    this._tone(t, { type: 'square', f0: strong ? 260 : 380, f1: 90, dur: 0.12, gain: strong ? 0.28 : 0.18 });
  }
  playBlock() {
    const c = this.ensure(); const t = c.currentTime;
    this._tone(t, { type: 'square', f0: 1500, f1: 900, dur: 0.09, gain: 0.2 });
    this._noise(t, { f0: 7000, q: 2, dur: 0.06, gain: 0.3, type: 'highpass' });
    this._tone(t, { type: 'triangle', f0: 3000, f1: 2200, dur: 0.12, gain: 0.1 });
  }
  playHurt() {
    const c = this.ensure(); const t = c.currentTime;
    this._tone(t, { type: 'sawtooth', f0: 320, f1: 70, dur: 0.3, gain: 0.4 });
    this._noise(t, { f0: 600, f1: 150, dur: 0.25, gain: 0.35, type: 'lowpass' });
  }
  playKill() {
    const c = this.ensure(); const t = c.currentTime;
    this._tone(t, { type: 'triangle', f0: 500, f1: 1400, dur: 0.14, gain: 0.25 });
    this._noise(t, { f0: 2500, f1: 800, dur: 0.12, gain: 0.25 });
  }
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
