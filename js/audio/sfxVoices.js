// SfxVoices: synth voices (attack kinds, metronome click) built against an injected
// AudioContext + destinations, so the same code runs in a live context and in an
// OfflineAudioContext (used by tools/rhythm-audit.mjs to measure the true audible onset).
// Every voice starts exactly at `when` (no start-delaying attack ramps; DESIGN 11.8b).

export function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
  return buf;
}

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
  }

  tone(when, { type = 'sine', f0, f1 = f0, dur = 0.1, gain = 0.3, out = this.dest.sfx, attack = 0.0015 }) {
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

  noise(when, { f0, f1 = f0, q = 1, dur = 0.1, gain = 0.3, type = 'bandpass', out = this.dest.sfx, attack = 0.0015 }) {
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
    g.gain.exponentialRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(when, Math.random() * 0.5); s.stop(when + dur + 0.02);
  }

  click(when, accent) {
    const out = this.dest.click;
    this.tone(when, { type: 'sine', f0: accent ? 1760 : 1100, dur: 0.045, gain: accent ? 0.55 : 0.4, out, attack: 0.001 });
    this.tone(when, { type: 'triangle', f0: accent ? 880 : 550, dur: 0.03, gain: 0.2, out, attack: 0.001 });
  }

  /** kind: front | down | back | finisher | combo8. `when` is used verbatim for every start(). */
  attack(kind, when) {
    switch (kind) {
      case 'back':
      case 'combo8':
        this.noise(when, { f0: 5000, f1: 9000, q: 0.8, dur: 0.07, gain: 0.32 });
        this.tone(when, { type: 'sine', f0: 700, f1: 1900, dur: 0.09, gain: 0.3 });
        this.tone(when, { type: 'square', f0: 1400, f1: 2400, dur: 0.05, gain: 0.05 });
        if (kind === 'combo8') {
          this.tone(when, { type: 'triangle', f0: 1318, dur: 0.3, gain: 0.16 });
          this.tone(when + 0.04, { type: 'triangle', f0: 1976, dur: 0.3, gain: 0.12 });
        }
        break;
      case 'down':
      case 'finisher':
        this.noise(when, { f0: 2600, f1: 260, q: 0.7, dur: 0.3, gain: 0.7 });
        this.tone(when, { type: 'sawtooth', f0: 130, f1: 40, dur: 0.32, gain: 0.45 });
        this.tone(when, { type: 'sine', f0: 70, f1: 32, dur: 0.4, gain: 0.8 });
        this.tone(when, { type: 'triangle', f0: 440, dur: 0.32, gain: 0.11 });
        this.tone(when, { type: 'triangle', f0: 660, dur: 0.32, gain: 0.09 });
        if (kind === 'finisher') {
          this.noise(when + 0.02, { f0: 900, f1: 80, q: 0.5, dur: 0.6, gain: 0.7, type: 'lowpass' });
          this.tone(when, { type: 'sine', f0: 55, f1: 24, dur: 0.7, gain: 0.9 });
        }
        break;
      default: // front
        this.noise(when, { f0: 3200, f1: 700, q: 0.9, dur: 0.16, gain: 0.5 });
        this.tone(when, { type: 'sine', f0: 190, f1: 60, dur: 0.14, gain: 0.6 });
        this.tone(when, { type: 'sawtooth', f0: 330, f1: 120, dur: 0.1, gain: 0.07 });
    }
  }
}
