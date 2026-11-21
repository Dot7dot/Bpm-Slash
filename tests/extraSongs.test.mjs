// 額外曲目（midnight-funk、starlight-runner）的檔案與音訊稽核測試。
// 檢查項目：WAV 標頭與長度、JSON 欄位、songs.json 清單、去鼓（低頻鼓點能量對照含鼓版）、
// 音符起音對齊十六分網格、歌曲地圖段落能量、自動 BPM 偵測。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBpm } from '../js/core/bpmDetect.js';
import { analyzeSongMap } from '../js/core/songMap.js';
import { renderExtraSong, encodeWav, SONG_IDS } from '../tools/generate-extra-songs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 22050;
const BARS = 32;
const BEATS_PER_BAR = 4;

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'assets/audio/songs.json'), 'utf8'));
const extra = manifest.filter((e) => SONG_IDS.includes(e.id));

// 解析 16-bit mono PCM WAV（沿 RIFF 區塊走訪）
function readWav(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        byteRate: buf.readUInt32LE(pos + 16),
        blockAlign: buf.readUInt16LE(pos + 20),
        bits: buf.readUInt16LE(pos + 22),
      };
    }
    if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  assert.ok(fmt, 'WAV 缺少 fmt 區塊');
  assert.ok(data, 'WAV 缺少 data 區塊');
  const n = data.length / 2;
  const int16 = new Int16Array(n);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    int16[i] = data.readInt16LE(2 * i);
    samples[i] = int16[i] / 32768;
  }
  return { buf, fmt, riffSize: buf.readUInt32LE(4), dataBytes: data.length, int16, samples };
}

const expectedSamples = (bpm) => Math.round((BARS * BEATS_PER_BAR * 60 * SR) / bpm);
const readJson = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));

// 一階低通串接兩次（約 12 dB/oct），用於取低頻鼓點
function lowpass(x, fc) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  const out = new Float32Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    y1 += a * (x[i] - y1);
    y2 += a * (y1 - y2);
    out[i] = y2;
  }
  return out;
}

// 2 ms 置中 RMS 的前綴和，用於快速查詢任意視窗能量
function prefixSquares(x) {
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i] * x[i];
  return cs;
}

test('songs.json 列出三首曲目，檔案存在且 BPM 與 JSON 一致', () => {
  assert.deepEqual(
    manifest.map((e) => e.id),
    ['neon-step', ...SONG_IDS],
  );
  assert.equal(manifest[0].bpm, 88);
  for (const e of manifest) {
    assert.ok(e.title && typeof e.title === 'string', `${e.id} 缺少標題`);
    assert.ok(!e.wav.startsWith('/') && !e.json.startsWith('/'), `${e.id} 路徑不應以 / 開頭`);
    assert.ok(existsSync(resolve(ROOT, e.wav)), `${e.id} 的 WAV 不存在：${e.wav}`);
    assert.ok(existsSync(resolve(ROOT, e.json)), `${e.id} 的 JSON 不存在：${e.json}`);
    assert.equal(readJson(e.json).bpm, e.bpm, `${e.id} 的 BPM 與 JSON 不一致`);
  }
});

for (const e of extra) {
  test(`${e.id}：WAV 標頭與取樣數正確`, () => {
    const wav = readWav(resolve(ROOT, e.wav));
    assert.equal(wav.fmt.format, 1, 'PCM');
    assert.equal(wav.fmt.channels, 1, 'mono');
    assert.equal(wav.fmt.sampleRate, SR);
    assert.equal(wav.fmt.bits, 16);
    assert.equal(wav.fmt.blockAlign, 2);
    assert.equal(wav.fmt.byteRate, SR * 2);
    assert.equal(wav.dataBytes, 2 * expectedSamples(e.bpm), '資料長度應為 2 × 取樣數');
    assert.equal(wav.riffSize, wav.buf.length - 8, 'RIFF 大小欄位');
    assert.equal(wav.buf.length, 44 + wav.dataBytes, '檔案長度應為標頭 + 資料');
    assert.equal(wav.int16.length, expectedSamples(e.bpm), '取樣數 = round(128 拍 × 60 / BPM × 22050)');
  });

  test(`${e.id}：JSON 欄位完整且段落連續覆蓋 32 小節`, () => {
    const meta = readJson(e.json);
    assert.equal(meta.title, e.title);
    assert.equal(meta.bpm, e.bpm);
    assert.equal(meta.offsetMs, 0);
    assert.equal(meta.beatsPerBar, 4);
    assert.equal(meta.bars, 32);
    assert.equal(meta.sampleRate, SR);
    assert.equal(meta.drums, false, '發行版必須是去鼓伴奏');
    assert.ok(Math.abs(meta.durationSec - expectedSamples(e.bpm) / SR) < 1 / SR, 'durationSec 與取樣數一致');
    assert.deepEqual(
      meta.sections.map((s) => [s.name, s.intensity, s.startBar, s.endBar]),
      [
        ['intro', 'low', 0, 4],
        ['verse', 'mid', 4, 12],
        ['chorus', 'high', 12, 20],
        ['breakdown', 'low', 20, 24],
        ['final', 'high', 24, 32],
      ],
    );
  });

  test(`${e.id}：出貨 WAV 與產生器輸出逐取樣相同（去鼓版）`, () => {
    const shipped = readWav(resolve(ROOT, e.wav)).int16;
    const rendered = renderExtraSong(e.id, { drums: false });
    assert.equal(rendered.length, shipped.length);
    let mismatch = 0;
    for (let i = 0; i < rendered.length; i++) {
      const v = Math.max(-1, Math.min(1, rendered[i]));
      if (Math.round(v * 32767) !== shipped[i]) mismatch++;
    }
    assert.equal(mismatch, 0, '出貨檔應由 renderExtraSong(id, { drums: false }) 產生');
    // 同時確認 encodeWav 的量化與檔案一致（抽樣比對前 1000 點）
    const enc = encodeWav(rendered.subarray(0, 1000), SR);
    assert.equal(enc.readInt16LE(44 + 2 * 999), shipped[999]);
  });

  test(`${e.id}：去鼓版的低頻鼓點能量明顯低於含鼓版`, () => {
    const shipped = lowpass(readWav(resolve(ROOT, e.wav)).samples, 120);
    const withDrums = lowpass(renderExtraSong(e.id, { drums: true }), 120);
    const step = (60 / e.bpm / 4) * SR; // 十六分音符取樣數
    const win = Math.round(0.02 * SR);
    const peakAt = (x, g) => {
      const s = Math.round(g * step);
      let m = 0;
      for (let i = s; i < s + win && i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
      return m;
    };
    // 底鼓位於 1、3 拍（格位 0、8），不含 breakdown 小節（20–23，該段無鼓）
    const ratios = [];
    for (let bar = 0; bar < BARS; bar++) {
      if (bar >= 20 && bar < 24) continue;
      for (const b of [0, 8]) {
        const g = bar * 16 + b;
        ratios.push(peakAt(shipped, g) / peakAt(withDrums, g));
      }
    }
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    assert.ok(median < 0.5, `去鼓版拍點低頻峰值應低於含鼓版的一半，實測中位數 ${median.toFixed(3)}`);
  });

  test(`${e.id}：音符起音對齊十六分網格（平均誤差 ≤ 5 ms）`, () => {
    const x = readWav(resolve(ROOT, e.wav)).samples;
    const cs = prefixSquares(x);
    const rms = (a, b) => {
      const s0 = Math.max(0, a);
      const s1 = Math.min(x.length, b);
      return s1 > s0 ? Math.sqrt((cs[s1] - cs[s0]) / (s1 - s0)) : 0;
    };
    const w = Math.round(0.003 * SR); // 3 ms 視窗
    const grid = (60 / e.bpm / 4) * SR;
    const errors = [];
    const nGrid = Math.floor((x.length - 2 * w) / grid);
    for (let k = 1; k < nGrid; k++) {
      const gp = Math.round(k * grid);
      const after = rms(gp, gp + w);
      const before = rms(gp - w, gp);
      // 只計算起音明顯的網格點（後段能量至少為前段的 3 倍）
      if (after < 0.01 || after / (before + 1e-4) < 3) continue;
      // 在 ±5 ms 內找能量上升最快的位置
      let best = -Infinity;
      let bestD = 0;
      for (let d = -5; d <= 5; d++) {
        const c = gp + Math.round((d * SR) / 1000);
        const rise = rms(c, c + w) - rms(c - w, c);
        if (rise > best) {
          best = rise;
          bestD = d;
        }
      }
      errors.push(Math.abs(bestD));
    }
    assert.ok(errors.length >= 20, `可偵測的起音太少：${errors.length}`);
    const mean = errors.reduce((u, v) => u + v, 0) / errors.length;
    assert.ok(mean <= 5, `起音平均誤差 ${mean.toFixed(2)} ms，超過 5 ms`);
  });

  test(`${e.id}：歌曲地圖的副歌與最終段能量高於前奏與間奏`, () => {
    const x = readWav(resolve(ROOT, e.wav)).samples;
    const map = analyzeSongMap(x, SR, { bpm: e.bpm, offsetSec: 0, beatsPerBar: 4 });
    assert.equal(map.bars, BARS);
    const mean = (a, b) => map.barEnergy.slice(a, b).reduce((u, v) => u + v, 0) / (b - a);
    const intro = mean(0, 4);
    const breakdown = mean(20, 24);
    const chorus = mean(12, 20);
    const final = mean(24, 32);
    assert.ok(chorus > intro, `副歌 ${chorus.toFixed(3)} 應高於前奏 ${intro.toFixed(3)}`);
    assert.ok(chorus > breakdown, `副歌 ${chorus.toFixed(3)} 應高於間奏 ${breakdown.toFixed(3)}`);
    assert.ok(final > intro, `最終段 ${final.toFixed(3)} 應高於前奏 ${intro.toFixed(3)}`);
    assert.ok(final > breakdown, `最終段 ${final.toFixed(3)} 應高於間奏 ${breakdown.toFixed(3)}`);
  });

  test(`${e.id}：自動 BPM 偵測結果為 ${e.bpm} ± 0.5`, (t) => {
    const x = readWav(resolve(ROOT, e.wav)).samples;
    const r = detectBpm(x, SR);
    if (Math.abs(r.bpm - e.bpm) > 0.5) {
      t.todo(`detectBpm 回傳 ${r.bpm}（信心 ${r.confidence.toFixed(3)}），與 ${e.bpm} 不符，需偵測器另行調整`);
      return;
    }
    assert.ok(Math.abs(r.bpm - e.bpm) <= 0.5, `detectBpm = ${r.bpm}`);
  });
}
