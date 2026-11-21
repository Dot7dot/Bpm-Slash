// SfxVoices: synth voices (attack kinds, metronome click) built against an injected
// AudioContext + destinations, so the same code runs in a live context and in an
// OfflineAudioContext (used by tools/rhythm-audit.mjs to measure the true audible onset).
// Every voice starts exactly at `when` (<= 1.5 ms linear attack from silence; DESIGN 11.8b).
// v2: hit(desc, when) = accompanying drum kit (docs/DESIGN-BEATSNAP.md section 4).

export function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
  return buf;
}

export const HIT_LEVELS = ['bar', 'half', 'beat', 'eighth', 'sixteenth', 'thirtysecond'];
/** Relative loudness per level (DESIGN-BEATSNAP section 4). */
export const LEVEL_GAIN = { bar: 1.0, half: 0.85, beat: 0.8, eighth: 0.6, sixteenth: 0.42, thirtysecond: 0.3 };
/** Deprecated old attack kind -> hit descriptor. */
export const KIND_TO_DESC = {
  front: { level: 'beat', onBeat: true },
  down: { level: 'half', onBeat: true },
  back: { level: 'eighth', onBeat: false },
  combo8: { level: 'eighth', onBeat: true, combo: 'eighth' },
  finisher: { level: 'bar', onBeat: true, combo: 'bar' },
};

/** Trim so the stacked worst case stays under 0 dBFS on its own (mix sanity). */
export const HIT_TRIM = 0.2;

export class SfxVoices {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{sfx: AudioNode, click: AudioNode}} dest
   * @param {AudioBuffer} [noiseBuf]
   */
  constructor(ctx, dest, noiseBuf) {
    this.ctx = ctx;
    this.dest = dest;
    this.noiseBuf = noiseBuf || makeNoiseBuffer(ctx);
    this._gm = 1; // gain multiplier (HIT_TRIM while rendering a drum-kit hit)
  }

  tone(when, { type = 'sine', f0, f1 = f0, dur = 0.1, gain = 0.3, out = this.dest.sfx, attack = 0.0015 }) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), when + attack + dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain * this._gm, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + dur);
    o.connect(g); g.connect(out);
    o.start(when); o.stop(when + attack + dur + 0.02);
  }

  noise(when, { f0, f1 = f0, q = 1, dur = 0.1, gain = 0.3, type = 'bandpass', out = this.dest.sfx, attack = 0.0015 }) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + attack + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain * this._gm, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(when, (this._nz = ((this._nz || 0) + 0.137) % 0.5)); s.stop(when + attack + dur + 0.02);
  }

  click(when, accent) {
    const out = this.dest.click;
    this.tone(when, { type: 'sine', f0: accent ? 1760 : 1100, dur: 0.045, gain: accent ? 0.55 : 0.4, out, attack: 0.001 });
    this.tone(when, { type: 'triangle', f0: accent ? 880 : 550, dur: 0.03, gain: 0.2, out, attack: 0.001 });
  }

  // ---------- drum-kit pieces (all transients: attack <= 1.5 ms, start exactly at `when`) ----------

  kick(w, g, o = {}) {
    this.tone(w, { type: 'sine', f0: o.f0 || 150, f1: o.f1 || 48, dur: o.dur || 0.2, gain: 0.85 * g, attack: 0.001 });
    this.noise(w, { f0: 3500, q: 0.7, dur: 0.012, gain: 0.5 * g, type: 'lowpass', attack: 0.0008 }); // beater click
  }
  tom(w, g) {
    this.tone(w, { type: 'sine', f0: 190, f1: 95, dur: 0.22, gain: 0.7 * g, attack: 0.001 });
    this.tone(w, { type: 'triangle', f0: 285, f1: 140, dur: 0.1, gain: 0.2 * g, attack: 0.001 });
  }
  snare(w, g, bright) {
    this.noise(w, { f0: bright ? 4200 : 2600, q: 0.6, dur: 0.16, gain: 0.7 * g, type: 'highpass', attack: 0.001 });
    this.tone(w, { type: 'triangle', f0: bright ? 260 : 200, f1: 150, dur: 0.09, gain: 0.5 * g, attack: 0.001 });
  }
  clap(w, g) {
    this.noise(w, { f0: 1500, q: 1.2, dur: 0.14, gain: 0.7 * g, attack: 0.001 });
    this.noise(w + 0.011, { f0: 1700, q: 1.2, dur: 0.1, gain: 0.5 * g, attack: 0.001 });
  }
  hat(w, g, open, bright = 1) {
    this.noise(w, { f0: 7500 * bright, q: 0.9, dur: open ? 0.26 : 0.045, gain: 0.55 * g, type: 'highpass', attack: 0.0008 });
    this.tone(w, { type: 'square', f0: 6200 * bright, dur: open ? 0.12 : 0.03, gain: 0.05 * g, attack: 0.0008 });
  }
  rim(w, g) {
    this.tone(w, { type: 'triangle', f0: 1700, f1: 1500, dur: 0.03, gain: 0.45 * g, attack: 0.0008 });
    this.noise(w, { f0: 3000, q: 3, dur: 0.02, gain: 0.3 * g, attack: 0.0008 });
  }
  crash(w, g, dur = 0.7) {
    this.noise(w, { f0: 5500, q: 0.5, dur, gain: 0.5 * g, type: 'highpass', attack: 0.001 });
    this.noise(w, { f0: 9000, q: 0.5, dur: dur * 0.6, gain: 0.3 * g, type: 'highpass', attack: 0.001 });
  }
  /** Meaty on-beat layer: 55-70 Hz sub thump + noise smack. */
  meat(w, g) {
    this.tone(w, { type: 'sine', f0: 70, f1: 55, dur: 0.14, gain: 0.7 * g, attack: 0.0012 });
    this.noise(w, { f0: 1200, f1: 400, q: 0.8, dur: 0.05, gain: 0.4 * g, attack: 0.001 });
  }

  /**
   * Accompanying drum-kit hit. `when` is used verbatim for every start().
   * @param {{level:string,onBeat?:boolean,fever?:boolean,combo?:(null|'eighth'|'bar'|'fill'),parry?:boolean}} desc
   */
  hit(desc, when) {
    this._gm = HIT_TRIM;
    try { this._hit(desc, when); } finally { this._gm = 1; }
  }

  _hit(desc, when) {
    const d = desc || {};
    const level = LEVEL_GAIN[d.level] !== undefined ? d.level : 'beat';
    const meaty = !!(d.onBeat || d.fever);
    const w = when;
    const L = LEVEL_GAIN[level];
    const g = meaty ? L : L * 0.7;       // off-beat: x0.7
    const br = meaty ? 1 : 1.25;         // off-beat: brighter / thinner
    switch (level) {
      case 'bar':
        this.kick(w, g);
        this.crash(w, g * 0.75, 0.8);
        this.tone(w, { type: 'sine', f0: 62, f1: 38, dur: 0.5, gain: 0.7 * g, attack: 0.0015 }); // low boom
        break;
      case 'half':
        this.kick(w, g * 0.95);
        this.tom(w, g * 0.9);
        break;
      case 'beat':
        this.snare(w, g, !meaty);
        this.clap(w, g * 0.55);
        break;
      case 'eighth':
        this.hat(w, g * 1.1, false, br);
        this.rim(w, g * 0.9);
        break;
      case 'sixteenth':
        this.noise(w, { f0: 8500 * br, q: 0.8, dur: 0.05, gain: 0.5 * g * 1.5, type: 'highpass', attack: 0.0008 });
        break;
      default: // thirtysecond
        this.tone(w, { type: 'triangle', f0: 2800 * br, dur: 0.012, gain: 0.4 * g, attack: 0.0006 });
        this.noise(w, { f0: 6000, q: 1, dur: 0.008, gain: 0.25 * g, type: 'highpass', attack: 0.0006 });
    }
    if (meaty) this.meat(w, L * (level === 'thirtysecond' ? 0.3 : level === 'sixteenth' ? 0.5 : 1));
    if (d.fever) {
      this.tone(w, { type: 'sine', f0: 4186, dur: 0.18, gain: 0.07 * L + 0.02, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 6272, dur: 0.14, gain: 0.05 * L + 0.015, attack: 0.001 });
      this.noise(w, { f0: 10000, q: 0.7, dur: 0.1, gain: 0.12 * L, type: 'highpass', attack: 0.001 });
    }
    if (d.combo === 'fill') this.crash(w, 0.45, 0.55);
    else if (d.combo === 'bar') {
      this.crash(w, 0.8, 1.1);
      this.tone(w, { type: 'sine', f0: 196, dur: 1.0, gain: 0.2, attack: 0.001 });          // gong body
      this.tone(w, { type: 'sine', f0: 196 * 1.52, dur: 0.9, gain: 0.12, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 196 * 2.76, dur: 0.7, gain: 0.08, attack: 0.001 });
    } else if (d.combo === 'eighth') {
      this.hat(w, 0.55, true, 1);
      this.clap(w, 0.5);
    }
    if (d.parry) {
      this.noise(w, { f0: 2200, q: 1.0, dur: 0.12, gain: 0.7, attack: 0.001 });
      this.noise(w + 0.009, { f0: 2400, q: 1.0, dur: 0.1, gain: 0.5, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 3520, dur: 0.35, gain: 0.22, attack: 0.001 });       // metallic ting
      this.tone(w, { type: 'sine', f0: 3520 * 2.41, dur: 0.22, gain: 0.1, attack: 0.001 });
    }
  }

  // ---------- reactive confirm sounds: soft attack (>= 15 ms), low level, tonal tails ----------

  _soft(when, { f0, f1 = f0, dur = 0.3, gain = 0.1, attack = 0.02, type = 'sine' }) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), when + attack + dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + dur);
    o.connect(g); g.connect(this.dest.sfx);
    o.start(when); o.stop(when + attack + dur + 0.02);
  }
  confirmHit(when, big) {
    this._soft(when, { f0: big ? 196 : 262, f1: big ? 150 : 200, dur: 0.22, gain: big ? 0.13 : 0.09, attack: 0.018 });
    this._soft(when, { f0: big ? 392 : 523, dur: 0.18, gain: 0.04, attack: 0.02, type: 'triangle' });
  }
  confirmBlock(when) {
    this._soft(when, { f0: 880, dur: 0.3, gain: 0.07, attack: 0.02, type: 'triangle' });
    this._soft(when, { f0: 1320, dur: 0.25, gain: 0.04, attack: 0.02 });
  }
  confirmKill(when) {
    this._soft(when, { f0: 523, f1: 784, dur: 0.3, gain: 0.08, attack: 0.025, type: 'triangle' });
    this._soft(when, { f0: 1046, dur: 0.28, gain: 0.03, attack: 0.03 });
  }

  /** Deprecated: old attack kinds mapped to hit(). */
  attack(kind, when) { this.hit(KIND_TO_DESC[kind] || KIND_TO_DESC.front, when); }
}
