// bpmDetect 單元測試：合成節拍軌（底鼓 + 重音 + 八分音符嗶聲）與預設曲 WAV。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectBpm } from '../js/core/bpmDetect.js';

const here = dirname(fileURLToPath(import.meta.url));

// 決定性偽隨機數（LCG），讓測試每次結果一致。
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 合成節拍軌：每拍一個 60 Hz 指數衰減的底鼓；小節第 1 拍加重；每個八分音符加一個短噪音嗶聲。
function synthTrack({ bpm, offsetSec, sampleRate, durationSec = 30, hats = true, seed = 1 }) {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const beatDur = 60 / bpm;
  const rng = makeRng(seed);

  const addKick = (t0, amp) => {
    const len = Math.floor(0.2 * sampleRate);
    const i0 = Math.floor(t0 * sampleRate);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sampleRate;
      const env = Math.exp(-t * 25);
      const f = 60 + 40 * Math.exp(-t * 40); // 音高下掃
      out[i0 + k] += amp * env * Math.sin(2 * Math.PI * f * t);
    }
  };
  const addHat = (t0, amp) => {
    const len = Math.floor(0.03 * sampleRate);
    const i0 = Math.floor(t0 * sampleRate);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sampleRate;
      out[i0 + k] += amp * Math.exp(-t * 180) * (rng() * 2 - 1);
    }
  };

  for (let b = 0; ; b++) {
    const t = offsetSec + b * beatDur;
    if (t >= durationSec) break;
    addKick(t, b % 4 === 0 ? 1.0 : 0.7);
    if (hats) {
      addHat(t + beatDur / 2, 0.12);
    }
  }
  return out;
}

// 將偵測到的第一拍位置與真值比較（模 beatDur，處理環繞）。
function circDiff(a, b, period) {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

const TEMPOS = [88, 72.5, 100, 120, 128, 150, 174];
const OFFSETS = [0, 0.137, 0.5];
const RATES = [22050, 44100];

for (const sampleRate of RATES) {
  for (const bpm of TEMPOS) {
    for (const offsetSec of OFFSETS) {
      test(`synthetic ${bpm} BPM, offset ${offsetSec}s, ${sampleRate} Hz`, () => {
        const samples = synthTrack({ bpm, offsetSec, sampleRate, seed: Math.round(bpm * 10 + offsetSec * 1000) });
        const t0 = performance.now();
        const r = detectBpm(samples, sampleRate);
        const ms = performance.now() - t0;
        const beatDur = 60 / bpm;
        assert.ok(Math.abs(r.bpm - bpm) <= 0.5, `bpm ${r.bpm} vs truth ${bpm}`);
        const od = circDiff(r.offsetSec, offsetSec, beatDur);
        assert.ok(od <= 0.015, `offset ${r.offsetSec} vs truth ${offsetSec} (diff ${od.toFixed(4)} s)`);
        assert.ok(r.offsetSec >= 0 && r.offsetSec < beatDur, 'offsetSec out of [0, beatDur)');
        assert.ok(r.confidence >= 0 && r.confidence <= 1, 'confidence out of [0,1]');
        assert.ok(ms < 1000, `too slow: ${ms.toFixed(0)} ms`);
      });
    }
  }
}

test('silence returns bpm 0 without throwing', () => {
  const r = detectBpm(new Float32Array(44100 * 10), 44100);
  assert.deepEqual(r, { bpm: 0, confidence: 0, offsetSec: 0 });
});

test('too-short input returns bpm 0 without throwing', () => {
  const short = synthTrack({ bpm: 120, offsetSec: 0, sampleRate: 44100, durationSec: 0.5 });
  assert.deepEqual(detectBpm(short, 44100), { bpm: 0, confidence: 0, offsetSec: 0 });
  assert.deepEqual(detectBpm(new Float32Array(0), 44100), { bpm: 0, confidence: 0, offsetSec: 0 });
  assert.deepEqual(detectBpm(new Float32Array(1), 44100), { bpm: 0, confidence: 0, offsetSec: 0 });
});

test('bad sample rate returns bpm 0 without throwing', () => {
  const s = synthTrack({ bpm: 120, offsetSec: 0, sampleRate: 44100, durationSec: 5 });
  assert.deepEqual(detectBpm(s, 0), { bpm: 0, confidence: 0, offsetSec: 0 });
});

// 解析 16-bit PCM WAV（RIFF），多聲道時取平均成單聲道。
function parseWav16(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buf.length - body) };
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error(`unsupported WAV: format ${fmt.format}, ${fmt.bits}-bit`);
  }
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      acc += buf.readInt16LE(data.start + (i * fmt.channels + c) * 2);
    }
    mono[i] = acc / fmt.channels / 32768;
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

const DEFAULT_WAV = join(here, '..', 'assets', 'audio', 'default-88bpm.wav');

test('default 88 BPM song WAV (skipped if not generated yet)', (t) => {
  if (!existsSync(DEFAULT_WAV)) {
    t.skip('assets/audio/default-88bpm.wav 尚未產生');
    return;
  }
  const { samples, sampleRate } = parseWav16(readFileSync(DEFAULT_WAV));
  const r = detectBpm(samples, sampleRate);
  assert.ok(Math.abs(r.bpm - 88) <= 0.5, `bpm ${r.bpm} vs 88`);
  const beatDur = 60 / 88;
  const od = circDiff(r.offsetSec, 0, beatDur);
  assert.ok(od <= 0.015, `offset ${r.offsetSec} (diff ${od.toFixed(4)} s)`);
});
