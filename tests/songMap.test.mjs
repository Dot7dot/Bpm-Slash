import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSongMap } from '../js/core/songMap.js';
import { renderSong } from '../tools/generate-default-song.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// 確定性的雜訊（LCG），讓合成訊號可重現
function makeNoise(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

// 依 [秒數, 振幅] 區段產生單聲道訊號（220 Hz 正弦波，每區段 RMS 恆定，便於斷言段落邊界）
function synth(sr, segments) {
  const total = segments.reduce((a, [sec]) => a + Math.round(sec * sr), 0);
  const out = new Float32Array(total);
  let p = 0;
  for (const [sec, amp] of segments) {
    const n = Math.round(sec * sr);
    for (let i = 0; i < n; i++) out[p] = amp * Math.sin((2 * Math.PI * 220 * p) / sr), p++;
  }
  return out;
}

// 120 BPM、4/4 → 每小節 2 秒。16 小節：0–3 安靜、4–11 響、12–15 安靜。
const SR = 22050;
const BAR = 2;
function quietLoudQuiet() {
  return synth(SR, [
    [4 * BAR, 0.05],
    [8 * BAR, 0.8],
    [4 * BAR, 0.05],
  ]);
}

function sectionAt(result, bar) {
  return result.sections.find((s) => bar >= s.startBar && bar < s.endBar);
}

// 解析 16-bit PCM 單聲道 WAV，回傳 { sampleRate, samples: Float32Array }
function parseWav16Mono(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(p + 8),
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        bits: buf.readUInt16LE(p + 22),
      };
    } else if (id === 'data') {
      data = { start: p + 8, size: Math.min(size, buf.length - (p + 8)) };
      break;
    }
    p += 8 + size + (size & 1);
  }
  assert.ok(fmt && data, 'WAV 缺少 fmt 或 data 區塊');
  assert.equal(fmt.format, 1);
  assert.equal(fmt.channels, 1);
  assert.equal(fmt.bits, 16);
  const n = data.size >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(data.start + 2 * i) / 32768;
  return { sampleRate: fmt.sampleRate, samples };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const regionMean = (r, from, to) => mean(r.barEnergy.slice(from, to));

test('quiet / loud / quiet blocks yield low / high / low sections at the right bars', () => {
  const r = analyzeSongMap(quietLoudQuiet(), SR, { bpm: 120 });
  assert.equal(r.bars, 16);
  assert.equal(r.barEnergy.length, 16);
  assert.equal(r.barIntensity.length, 16);
  for (const e of r.barEnergy) assert.ok(e >= 0 && e <= 1);
  assert.deepEqual(r.sections, [
    { startBar: 0, endBar: 4, intensity: 'low' },
    { startBar: 4, endBar: 12, intensity: 'high' },
    { startBar: 12, endBar: 16, intensity: 'low' },
  ]);
  assert.equal(r.barIntensity[1], 'low');
  assert.equal(r.barIntensity[8], 'high');
  assert.equal(r.barIntensity[14], 'low');
});

test('barEnergy is normalized so min is 0 and max is 1', () => {
  const r = analyzeSongMap(quietLoudQuiet(), SR, { bpm: 120 });
  assert.equal(Math.min(...r.barEnergy), 0);
  assert.equal(Math.max(...r.barEnergy), 1);
});

test('offsetSec skips audio before the offset and shifts bar times', () => {
  const lead = synth(SR, [[1, 0.9]]); // 1 秒的大聲前奏
  const base = quietLoudQuiet();
  const withLead = new Float32Array(lead.length + base.length);
  withLead.set(lead, 0);
  withLead.set(base, lead.length);

  const plain = analyzeSongMap(base, SR, { bpm: 120 });
  const shifted = analyzeSongMap(withLead, SR, { bpm: 120, offsetSec: 1 });
  assert.equal(shifted.bars, plain.bars);
  assert.deepEqual(shifted.sections, plain.sections);

  // 不設 offset 時，前奏會被當成第 0 小節的一部分，結果應不同
  const unshifted = analyzeSongMap(withLead, SR, { bpm: 120 });
  assert.notDeepEqual(unshifted.sections, plain.sections);
});

test('offsetSec beyond the audio returns an empty result', () => {
  const r = analyzeSongMap(quietLoudQuiet(), SR, { bpm: 120, offsetSec: 999 });
  assert.deepEqual(r, { bars: 0, barEnergy: [], barIntensity: [], sections: [] });
});

test('silence returns an empty result', () => {
  const silent = new Float32Array(SR * 20);
  assert.deepEqual(analyzeSongMap(silent, SR, { bpm: 120 }), {
    bars: 0,
    barEnergy: [],
    barIntensity: [],
    sections: [],
  });
  const faint = synth(SR, [[20, 1e-6]]);
  assert.equal(analyzeSongMap(faint, SR, { bpm: 120 }).bars, 0);
});

test('invalid or too-short input returns an empty result without throwing', () => {
  const empty = { bars: 0, barEnergy: [], barIntensity: [], sections: [] };
  const sig = quietLoudQuiet();
  assert.deepEqual(analyzeSongMap(new Float32Array(0), SR, { bpm: 120 }), empty);
  assert.deepEqual(analyzeSongMap(null, SR, { bpm: 120 }), empty);
  assert.deepEqual(analyzeSongMap(undefined, SR, {}), empty);
  assert.deepEqual(analyzeSongMap(sig, SR, { bpm: 0 }), empty);
  assert.deepEqual(analyzeSongMap(sig, SR, { bpm: -120 }), empty);
  assert.deepEqual(analyzeSongMap(sig, SR, { bpm: NaN }), empty);
  assert.deepEqual(analyzeSongMap(sig, SR, {}), empty);
  assert.deepEqual(analyzeSongMap(sig, 0, { bpm: 120 }), empty);
  assert.deepEqual(analyzeSongMap(sig, NaN, { bpm: 120 }), empty);
  // 不到 1 小節（1.5 秒 < 一小節 2 秒）
  assert.deepEqual(analyzeSongMap(synth(SR, [[1.5, 0.5]]), SR, { bpm: 120 }), empty);
  // 一個不完整的小節不足以分級
  assert.equal(analyzeSongMap(synth(SR, [[2.5, 0.5]]), SR, { bpm: 120 }).bars, 2);
});

test('the final partial bar is included', () => {
  // 5 小節 = 10 秒，再加 1 秒（半小節）
  const r = analyzeSongMap(synth(SR, [[11, 0.5]]), SR, { bpm: 120 });
  assert.equal(r.bars, 6);
});

test('short runs (< 2 bars) are merged into the previous section', () => {
  // 安靜 8 小節、1 小節的爆發、安靜 7 小節：爆發不應形成獨立的過短段落
  const sig = synth(SR, [
    [8 * BAR, 0.05],
    [1 * BAR, 0.9],
    [7 * BAR, 0.05],
  ]);
  const r = analyzeSongMap(sig, SR, { bpm: 120 });
  assert.equal(r.bars, 16);
  assert.ok(r.sections.length >= 1);
  let cursor = 0;
  for (const s of r.sections) {
    assert.equal(s.startBar, cursor, '段落需首尾相接');
    cursor = s.endBar;
  }
  assert.equal(cursor, r.bars, '段落需涵蓋所有小節');
  if (r.sections.length > 1) {
    for (const s of r.sections) assert.ok(s.endBar - s.startBar >= 2, `段落過短：${JSON.stringify(s)}`);
    for (let i = 1; i < r.sections.length; i++) {
      assert.notEqual(r.sections[i].intensity, r.sections[i - 1].intensity, '相鄰段落強度應不同');
    }
  }
});

test('a single very short first block is merged forward, not kept alone', () => {
  const sig = synth(SR, [
    [1 * BAR, 0.9],
    [15 * BAR, 0.05],
  ]);
  const r = analyzeSongMap(sig, SR, { bpm: 120 });
  assert.equal(r.bars, 16);
  for (const s of r.sections) assert.ok(s.endBar - s.startBar >= 2 || r.sections.length === 1);
  assert.equal(sectionAt(r, 0).startBar, 0);
});

test('a 5-minute 44.1 kHz song analyzes well under 200 ms', () => {
  const sr = 44100;
  const n = sr * 300;
  const x = new Float32Array(n);
  const rnd = makeNoise(7);
  for (let i = 0; i < n; i++) x[i] = 0.3 * rnd();
  analyzeSongMap(x, sr, { bpm: 120 }); // 暖機（JIT）
  let ms = Infinity;
  let r;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    r = analyzeSongMap(x, sr, { bpm: 120 });
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.equal(r.bars, Math.ceil(300 / 2));
  assert.ok(ms < 200, `耗時 ${ms.toFixed(1)} ms`);
});

// 預設曲的段落斷言：排序斷言（不要求精確標籤）。含鼓版與去鼓版都應成立。
function assertDefaultArrangement(r) {
  assert.equal(r.bars, 32);
  const intro = regionMean(r, 0, 4);
  const verse = regionMean(r, 4, 12);
  const chorus = regionMean(r, 12, 20);
  const breakdown = regionMean(r, 20, 24);
  const final = regionMean(r, 24, 32);
  assert.ok(intro < chorus, `intro ${intro} < chorus ${chorus}`);
  assert.ok(breakdown < chorus, `breakdown ${breakdown} < chorus ${chorus}`);
  assert.ok(intro < final, `intro ${intro} < final ${final}`);
  assert.ok(breakdown < final, `breakdown ${breakdown} < final ${final}`);
  assert.ok(intro < verse, `intro ${intro} < verse ${verse}`);

  // 高能量段落的主要分級應為 high，低能量段落應為 low
  assert.equal(r.barIntensity[1], 'low');
  assert.equal(r.barIntensity[22], 'low');
  assert.equal(r.barIntensity[14], 'high');
  assert.equal(r.barIntensity[28], 'high');
}

// 含鼓版：在記憶體中渲染（與舊 WAV 逐取樣相同），不依賴檔案
test('default song with drums (rendered in memory): analysis roughly matches the arrangement', () => {
  const samples = Float32Array.from(renderSong({ drums: true }));
  const r = analyzeSongMap(samples, 22050, { bpm: 88, offsetSec: 0, beatsPerBar: 4 });
  assertDefaultArrangement(r);
});

// 去鼓版（assets 內的 WAV）：段落與能量排序仍應成立，因為鼓被移除而旋律、鋪底與貝斯保留
test('default song drumless WAV: analysis roughly matches the arrangement', () => {
  const { sampleRate, samples } = parseWav16Mono(readFileSync(resolve(ROOT, 'assets/audio/default-88bpm.wav')));
  const r = analyzeSongMap(samples, sampleRate, { bpm: 88, offsetSec: 0, beatsPerBar: 4 });
  assertDefaultArrangement(r);
  // 去鼓後 breakdown 仍應低於 chorus（上方排序斷言已涵蓋，此處明示）
  assert.ok(regionMean(r, 20, 24) < regionMean(r, 12, 20));
});

test('default song JSON sections cover all 32 bars contiguously', () => {
  const meta = JSON.parse(readFileSync(resolve(ROOT, 'assets/audio/default-88bpm.json'), 'utf8'));
  assert.equal(meta.bpm, 88);
  assert.equal(meta.bars, 32);
  assert.ok(Array.isArray(meta.sections));
  let cursor = 0;
  for (const s of meta.sections) {
    assert.equal(s.startBar, cursor);
    assert.ok(s.endBar > s.startBar);
    assert.ok(['low', 'mid', 'high'].includes(s.intensity));
    cursor = s.endBar;
  }
  assert.equal(cursor, meta.bars);
});
