// bpmDetect 單元測試：合成節拍軌（底鼓 + 重音 + 八分音符嗶聲）與預設曲 WAV。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectBpm } from '../js/core/bpmDetect.js';
import { renderSong } from '../tools/generate-default-song.mjs';

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

// 無鼓的八分音符貝斯線：每個八分音符一個指數衰減的音（小節內拍點較重），每小節換和弦根音，
// 小節開頭加一個緩慢衰減的和弦鋪底（小節級能量變化）。八分音符的 onset 強度與拍點接近，
// 用來重現「只有 8 分音符」造成的倍速（2 倍）誤判。
function synthBassLine({ bpm, offsetSec, sampleRate, durationSec = 30, seed = 7 }) {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const beatDur = 60 / bpm;
  const eighth = beatDur / 2;
  const roots = [55, 43.65, 65.41, 49]; // A1 F1 C2 G1
  const addNote = (t0, freq, amp, decay, len) => {
    const i0 = Math.floor(t0 * sampleRate);
    const m = Math.floor(len * sampleRate);
    for (let k = 0; k < m && i0 + k < n; k++) {
      const t = k / sampleRate;
      const att = Math.min(1, t / 0.004);
      const ph = 2 * Math.PI * freq * t;
      const tone = Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph);
      out[i0 + k] += amp * att * Math.exp(-t / decay) * tone;
    }
  };
  for (let e = 0; ; e++) {
    const t = offsetSec + e * eighth;
    if (t >= durationSec) break;
    const bar = Math.floor(e / 8);
    const slot = e % 8;
    const root = roots[bar % 4] * (slot === 6 && bar % 2 === 1 ? 2 : 1);
    const amp = slot % 2 === 0 ? 0.6 : 0.42;
    addNote(t, root, amp, 0.12, eighth * 0.95);
  }
  // 小節級鋪底：每小節開頭的和弦（根音 + 三度 + 五度），衰減 1.2 秒
  for (let bar = 0; ; bar++) {
    const t = offsetSec + bar * 4 * beatDur;
    if (t >= durationSec) break;
    const r = roots[bar % 4];
    for (const mult of [1, 1.26, 1.5]) addNote(t, r * 2 * mult, 0.09, 0.5, 1.2);
  }
  return out;
}

// 16 分音符帽子為主的節奏：每拍一個底鼓，每個十六分音符一個短噪音嗶聲（八分音符處較重）。
function synthSixteenthHats({ bpm, offsetSec, sampleRate, durationSec = 30, seed = 11 }) {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const beatDur = 60 / bpm;
  const rng = makeRng(seed);
  const addKick = (t0, amp) => {
    const len = Math.floor(0.2 * sampleRate);
    const i0 = Math.floor(t0 * sampleRate);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sampleRate;
      out[i0 + k] += amp * Math.exp(-t * 25) * Math.sin(2 * Math.PI * (60 + 40 * Math.exp(-t * 40)) * t);
    }
  };
  const addHat = (t0, amp) => {
    const len = Math.floor(0.02 * sampleRate);
    const i0 = Math.floor(t0 * sampleRate);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const t = k / sampleRate;
      out[i0 + k] += amp * Math.exp(-t * 250) * (rng() * 2 - 1);
    }
  };
  for (let s = 0; ; s++) {
    const t = offsetSec + s * (beatDur / 4);
    if (t >= durationSec) break;
    const beat = Math.floor(s / 4);
    const sub = s % 4;
    if (sub === 0) addKick(t, beat % 4 === 0 ? 0.9 : 0.6);
    addHat(t, sub === 2 ? 0.2 : 0.12);
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

for (const sampleRate of RATES) {
  for (const bpm of [88, 96, 120]) {
    test(`8th-note bass line without drums, ${bpm} BPM (quarter tempo, not double), ${sampleRate} Hz`, () => {
      const samples = synthBassLine({ bpm, offsetSec: 0.05, sampleRate });
      const r = detectBpm(samples, sampleRate);
      assert.ok(Math.abs(r.bpm - bpm) <= 0.5, `bpm ${r.bpm} vs truth ${bpm}`);
      const od = circDiff(r.offsetSec, 0.05, 60 / bpm);
      assert.ok(od <= 0.015, `offset ${r.offsetSec} vs truth 0.05 (diff ${od.toFixed(4)} s)`);
    });
  }
  test(`16th-note hat-heavy track at 128 BPM (not halved/doubled), ${sampleRate} Hz`, () => {
    const samples = synthSixteenthHats({ bpm: 128, offsetSec: 0.1, sampleRate });
    const r = detectBpm(samples, sampleRate);
    assert.ok(Math.abs(r.bpm - 128) <= 0.5, `bpm ${r.bpm} vs 128`);
    const od = circDiff(r.offsetSec, 0.1, 60 / 128);
    assert.ok(od <= 0.015, `offset ${r.offsetSec} vs truth 0.1 (diff ${od.toFixed(4)} s)`);
  });
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

// 預設曲的兩種版本。含鼓版在記憶體中渲染（與舊 WAV 逐取樣相同），去鼓版讀取實際的 WAV 檔。
// 渲染結果快取於本檔案內，避免重複合成。
let drumsSamplesCache = null;
function defaultDrumsSamples() {
  if (!drumsSamplesCache) drumsSamplesCache = Float32Array.from(renderSong({ drums: true }));
  return drumsSamplesCache;
}

test('default 88 BPM song with drums (rendered in memory): 88 BPM and grid offset 0', () => {
  const samples = defaultDrumsSamples();
  const r = detectBpm(samples, 22050);
  assert.ok(Math.abs(r.bpm - 88) <= 0.5, `bpm ${r.bpm} vs 88`);
  const beatDur = 60 / 88;
  const od = circDiff(r.offsetSec, 0, beatDur);
  assert.ok(od <= 0.015, `offset ${r.offsetSec} (diff ${od.toFixed(4)} s)`);
});

test('default 88 BPM drumless WAV (skipped if not generated yet): 88 BPM and grid offset 0', (t) => {
  if (!existsSync(DEFAULT_WAV)) {
    t.skip('assets/audio/default-88bpm.wav 尚未產生');
    return;
  }
  const { samples, sampleRate } = parseWav16(readFileSync(DEFAULT_WAV));
  const r = detectBpm(samples, sampleRate);
  // 去鼓伴奏只有八分音符的貝斯與主旋律，偵測必須落在四分音符速度 88（不可為 176 或 44）。
  assert.ok(Math.abs(r.bpm - 88) <= 0.5, `bpm ${r.bpm} vs 88`);
  const beatDur = 60 / 88;
  assert.ok(r.offsetSec >= 0 && r.offsetSec < beatDur, `offset ${r.offsetSec} out of range`);
  const od = circDiff(r.offsetSec, 0, beatDur);
  assert.ok(od <= 0.02, `offset ${r.offsetSec} (diff ${od.toFixed(4)} s)`);
});
