// SfxVoices: synth voices (drum kit, confirm sounds, metronome click) built against an injected
// AudioContext + destinations, so the same code runs in a live context and in an
// OfflineAudioContext (used by tools/rhythm-audit.mjs to measure the true audible onset).
// Every drum voice starts exactly at `when` (<= 1.5 ms linear attack from silence; DESIGN 11.8b).
// v3: the player IS the drummer (docs/DESIGN-DRUMMER.md section 3). hit(desc, when) renders one of
// two complete drum families chosen by desc.instrument: 'kick' (attack A) or 'snare' (attack B).

export function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
  return buf;
}

export const HIT_INSTRUMENTS = ['kick', 'snare'];
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

/**
 * Drum-kit trim. The backing track has no drums, so the kit is the rhythm section: prominent,
 * but the stacked worst case (unison + fever + parry on a bar downbeat) still stays below 0 dBFS
 * on the SFX bus (tanh safety) and the master soft limiter (see audioEngine.js).
 */
export const HIT_TRIM = 0.5;

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

  /** Kick: pitched body (sine sweep 120 -> 48 Hz), beater click, short sub tail. */
  kick(w, g, o = {}) {
    const len = o.len || 1;
    this.tone(w, { type: 'sine', f0: o.f0 || 120, f1: o.f1 || 48, dur: 0.11 * len, gain: 0.95 * g, attack: 0.001 });  // pitched body
    this.tone(w, { type: 'sine', f0: 52, f1: 42, dur: 0.22 * len, gain: 0.5 * g, attack: 0.0012 });                   // sub tail
    this.noise(w, { f0: 4200, q: 0.7, dur: 0.01, gain: 0.55 * g, type: 'lowpass', attack: 0.0008 });                  // beater click
    this.tone(w, { type: 'triangle', f0: 1800, f1: 400, dur: 0.006, gain: 0.35 * g, attack: 0.0006 });                // click pitch
  }
  /** Tom: tuned sine + triangle overtone + stick noise. */
  tom(w, g, f = 190) {
    this.tone(w, { type: 'sine', f0: f, f1: f * 0.5, dur: 0.24, gain: 0.8 * g, attack: 0.001 });
    this.tone(w, { type: 'triangle', f0: f * 1.5, f1: f * 0.75, dur: 0.1, gain: 0.2 * g, attack: 0.001 });
    this.noise(w, { f0: 2500, q: 0.8, dur: 0.012, gain: 0.25 * g, type: 'bandpass', attack: 0.0008 });
  }
  /** Snare: tuned shell (~200 Hz) + bright rattle (band/high-passed noise) + crisp attack. */
  snare(w, g, o = {}) {
    const len = o.len || 1, bright = o.bright || 1;
    this.tone(w, { type: 'triangle', f0: 210 * (o.tune || 1), f1: 175 * (o.tune || 1), dur: 0.1 * len, gain: 0.6 * g, attack: 0.001 }); // shell
    this.tone(w, { type: 'sine', f0: 330, f1: 260, dur: 0.05 * len, gain: 0.22 * g, attack: 0.001 });                                   // overtone
    this.noise(w, { f0: 1800 * bright, q: 0.5, dur: 0.17 * len, gain: 0.7 * g, type: 'highpass', attack: 0.001 });                      // rattle
    this.noise(w, { f0: 5200 * bright, q: 0.9, dur: 0.09 * len, gain: 0.45 * g, type: 'bandpass', attack: 0.0008 });                    // sizzle
    this.noise(w, { f0: 2500, q: 0.7, dur: 0.008, gain: 0.5 * g, type: 'highpass', attack: 0.0006 });                                   // crack
  }
  clap(w, g) {
    this.noise(w, { f0: 1500, q: 1.2, dur: 0.14, gain: 0.7 * g, attack: 0.001 });
    this.noise(w + 0.011, { f0: 1700, q: 1.2, dur: 0.1, gain: 0.5 * g, attack: 0.001 });
  }
  hat(w, g, open, bright = 1) {
    this.noise(w, { f0: 7500 * bright, q: 0.9, dur: open ? 0.26 : 0.045, gain: 0.55 * g, type: 'highpass', attack: 0.0008 });
    this.tone(w, { type: 'square', f0: 6200 * bright, dur: open ? 0.12 : 0.03, gain: 0.05 * g, attack: 0.0008 });
    this.tone(w, { type: 'square', f0: 8300 * bright, dur: open ? 0.1 : 0.025, gain: 0.035 * g, attack: 0.0008 });
  }
  /** Rimshot: short woody click (tuned body + band noise). */
  rim(w, g) {
    this.tone(w, { type: 'triangle', f0: 1700, f1: 1450, dur: 0.03, gain: 0.5 * g, attack: 0.0008 });
    this.tone(w, { type: 'sine', f0: 480, f1: 400, dur: 0.035, gain: 0.35 * g, attack: 0.0008 });
    this.noise(w, { f0: 3200, q: 3, dur: 0.02, gain: 0.35 * g, attack: 0.0008 });
  }
  /** Crash: long shimmering noise tail (two high-passed layers + a slowly decaying metallic wash). */
  crash(w, g, dur = 0.7) {
    this.noise(w, { f0: 5500, q: 0.5, dur, gain: 0.5 * g, type: 'highpass', attack: 0.001 });
    this.noise(w, { f0: 9000, q: 0.5, dur: dur * 0.6, gain: 0.3 * g, type: 'highpass', attack: 0.001 });
    this.noise(w, { f0: 7200, f1: 5200, q: 1.6, dur: dur * 1.15, gain: 0.22 * g, type: 'bandpass', attack: 0.0012 });
    this.tone(w, { type: 'square', f0: 3470, dur: dur * 0.5, gain: 0.03 * g, attack: 0.001 });
    this.tone(w, { type: 'square', f0: 5130, dur: dur * 0.45, gain: 0.025 * g, attack: 0.001 });
  }
  /** Meaty on-beat layer: kick = 55-70 Hz sub thump + smack; snare = chest punch + smack (no muddy sub). */
  meat(w, g, instrument) {
    if (instrument === 'snare') {
      this.tone(w, { type: 'sine', f0: 140, f1: 100, dur: 0.1, gain: 0.45 * g, attack: 0.0012 });
      this.noise(w, { f0: 1800, f1: 700, q: 0.8, dur: 0.05, gain: 0.35 * g, attack: 0.001 });
    } else {
      this.tone(w, { type: 'sine', f0: 70, f1: 55, dur: 0.14, gain: 0.7 * g, attack: 0.0012 });
      this.noise(w, { f0: 1200, f1: 400, q: 0.8, dur: 0.05, gain: 0.4 * g, attack: 0.001 });
    }
  }

  /**
   * Drum-kit hit. `when` is used verbatim for every start().
   * @param {{instrument?:('kick'|'snare'),level:string,onBeat?:boolean,fever?:boolean,combo?:(null|'eighth'|'bar'|'fill'|'unison'),parry?:boolean}} desc
   */
  hit(desc, when) {
    this._gm = HIT_TRIM;
    try { this._hit(desc, when); } finally { this._gm = 1; }
  }

  _hit(desc, when) {
    const d = desc || {};
    const level = LEVEL_GAIN[d.level] !== undefined ? d.level : 'beat';
    const inst = d.instrument === 'snare' ? 'snare' : 'kick';
    const meaty = !!(d.onBeat || d.fever);
    const w = when;
    const L = LEVEL_GAIN[level];
    const g = meaty ? L : L * 0.7;       // off-beat: x0.7 (still exactly on time)
    const br = meaty ? 1 : 1.25;         // off-beat: brighter / thinner
    if (inst === 'kick') this._kickFamily(level, w, g, br);
    else this._snareFamily(level, w, g, br);
    if (meaty) this.meat(w, L * (level === 'thirtysecond' ? 0.3 : level === 'sixteenth' ? 0.5 : 1) * (inst === 'snare' ? 0.8 : 1), inst);
    if (d.fever) {
      this.tone(w, { type: 'sine', f0: 4186, dur: 0.18, gain: 0.07 * L + 0.02, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 6272, dur: 0.14, gain: 0.05 * L + 0.015, attack: 0.001 });
      this.noise(w, { f0: 10000, q: 0.7, dur: 0.1, gain: 0.12 * L, type: 'highpass', attack: 0.001 });
    }
    if (d.combo === 'fill') {
      if (inst === 'snare') this.tom(w, 0.5, 280);        // high tom
      else this.tom(w, 0.55, 105);                        // floor tom
      this.crash(w, 0.4, 0.55);
    } else if (d.combo === 'bar') {
      this.crash(w, 0.8, 1.1);
      this.tone(w, { type: 'sine', f0: 196, dur: 1.0, gain: 0.2, attack: 0.001 });          // gong body
      this.tone(w, { type: 'sine', f0: 196 * 1.52, dur: 0.9, gain: 0.12, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 196 * 2.76, dur: 0.7, gain: 0.08, attack: 0.001 });
    } else if (d.combo === 'eighth') {
      this.hat(w, 0.55, true, 1);
      this.clap(w, 0.5);
    } else if (d.combo === 'unison') {
      // Crash + both drums stacked: the whole kit hits at once.
      this.crash(w, 0.75, 1.0);
      if (inst === 'kick') this.snare(w, 0.6); else this.kick(w, 0.65);
      if (inst === 'kick') this.kick(w, 0.45); else this.snare(w, 0.45);
    }
    if (d.parry) {
      this.noise(w, { f0: 2200, q: 1.0, dur: 0.12, gain: 0.7, attack: 0.001 });
      this.noise(w + 0.009, { f0: 2400, q: 1.0, dur: 0.1, gain: 0.5, attack: 0.001 });
      this.tone(w, { type: 'sine', f0: 3520, dur: 0.35, gain: 0.22, attack: 0.001 });       // metallic ting
      this.tone(w, { type: 'sine', f0: 3520 * 2.41, dur: 0.22, gain: 0.1, attack: 0.001 });
    }
  }

  _kickFamily(level, w, g, br) {
    switch (level) {
      case 'bar':       // kick + crash + low boom
        this.kick(w, g);
        this.crash(w, g * 0.75, 0.8);
        this.tone(w, { type: 'sine', f0: 62, f1: 38, dur: 0.5, gain: 0.7 * g, attack: 0.0015 });
        break;
      case 'half':      // full-bodied kick (longer tail)
        this.kick(w, g * 0.95, { len: 1.35 });
        break;
      case 'beat':
        this.kick(w, g);
        break;
      case 'eighth':    // lighter kick
        this.kick(w, g * 0.95, { f0: 110 * (br > 1 ? 1.15 : 1), len: 0.8 });
        break;
      case 'sixteenth': // double-kick ghost: soft kick + a softer echo
        this.kick(w, g * 0.95, { f0: 105, len: 0.55 });
        this.kick(w + 0.032, g * 0.5, { f0: 100, len: 0.4 });
        break;
      default:          // thirtysecond: tiny tick
        this.tone(w, { type: 'sine', f0: 100, f1: 60, dur: 0.03, gain: 0.7 * g, attack: 0.0008 });
        this.noise(w, { f0: 4000, q: 0.7, dur: 0.008, gain: 0.5 * g, type: 'lowpass', attack: 0.0006 });
    }
  }

  _snareFamily(level, w, g, br) {
    switch (level) {
      case 'bar':       // snare + crash
        this.snare(w, g);
        this.crash(w, g * 0.75, 0.8);
        break;
      case 'half':      // full snare + clap
        this.snare(w, g * 0.95, { len: 1.15 });
        this.clap(w, g * 0.5);
        break;
      case 'beat':      // backbeat crack
        this.snare(w, g, { bright: br > 1 ? 1.1 : 1 });
        break;
      case 'eighth':    // rimshot
        this.rim(w, g * 1.3);
        break;
      case 'sixteenth': // ghost snare: soft, short, higher tuned
        this.snare(w, g * 0.85, { len: 0.5, tune: 1.12, bright: 1.1 });
        break;
      default:          // thirtysecond: hat tick
        this.hat(w, g * 1.1, false, br);
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
  /** Parry actually succeeded: soft-attack tonal "clang tail" (inharmonic bell partials, long decay). */
  confirmParry(when) {
    this._soft(when, { f0: 1568, dur: 0.5, gain: 0.07, attack: 0.02 });
    this._soft(when, { f0: 1568 * 2.41, dur: 0.38, gain: 0.04, attack: 0.02 });
    this._soft(when, { f0: 1568 * 3.76, dur: 0.26, gain: 0.02, attack: 0.022 });
    this._soft(when, { f0: 784, dur: 0.55, gain: 0.05, attack: 0.022, type: 'triangle' });
  }
  /** Player took damage: low, tonal, soft attack (>= 15 ms), no sharp off-grid transient. */
  hurt(when) {
    this._soft(when, { f0: 220, f1: 130, dur: 0.3, gain: 0.1, attack: 0.025 });
    this._soft(when, { f0: 165, f1: 98, dur: 0.28, gain: 0.07, attack: 0.03, type: 'triangle' });
  }

  /** Deprecated: old attack kinds mapped to hit(). */
  attack(kind, when) { this.hit(KIND_TO_DESC[kind] || KIND_TO_DESC.front, when); }
}
