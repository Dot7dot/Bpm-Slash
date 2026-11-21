#!/usr/bin/env node
// 預設曲合成腳本 / Default song synthesizer
// 產生原創 88 BPM 歌曲「霓虹步伐 Neon Step」：A 小調、4/4、32 小節（128 拍）。
// 零相依；噪音來自固定種子的 mulberry32，輸出可重現。
// 輸出：assets/audio/default-88bpm.wav（16-bit mono 22050 Hz）與 default-88bpm.json。
//
// 時間規則：每個事件的時間 = 整數 index × 步長（不累加），取樣位置 = round(t × SR)。
// Beat 0 位於 sample 0；鼓的 transient 直接從其 sample index 開始（無預衰減）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'assets', 'audio');
const WAV_PATH = resolve(OUT_DIR, 'default-88bpm.wav');
const JSON_PATH = resolve(OUT_DIR, 'default-88bpm.json');

const SR = 22050;
const BPM = 88;
const BEATS_PER_BAR = 4;
const BARS = 32;
const SLOTS_PER_BAR = 8; // 每小節 8 個八分音符 slot（前拍 / 後拍）
const TOTAL_BEATS = BARS * BEATS_PER_BAR;
const HALF_STEP = 30 / BPM; // 半拍（八分音符）秒數
const BAR_SEC = (4 * 60) / BPM;
const TOTAL_SEC = (TOTAL_BEATS * 60) / BPM;
const TOTAL_SAMPLES = Math.round(TOTAL_SEC * SR);
const PEAK = 10 ** (-1 / 20); // -1 dBFS
const DRIVE = 1.4; // tanh soft-clip 強度
const SEED = 0x88b0a5;

const slotSec = (e) => e * HALF_STEP;
const sampleOf = (sec) => Math.round(sec * SR);
const barStartSample = (bar) => sampleOf(slotSec(bar * SLOTS_PER_BAR));

// ---------- PRNG（mulberry32）----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// PRNG 狀態於 renderMix() 內重設（見下方）
let rand = null;
const noise = () => rand() * 2 - 1;

// ---------- 濾波器（單極點）----------
const hpAlpha = (fc) => 1 / (1 + (2 * Math.PI * fc) / SR);
const lpAlpha = (fc) => 1 - Math.exp((-2 * Math.PI * fc) / SR);
function makeHP(fc) {
  const a = hpAlpha(fc);
  let y = 0;
  let px = 0;
  return (x) => {
    y = a * (y + x - px);
    px = x;
    return y;
  };
}
function makeLP(fc) {
  const a = lpAlpha(fc);
  let y = 0;
  return (x) => (y += a * (x - y));
}

// ---------- 混音緩衝與音符工具 ----------
// 混音緩衝與打擊樂開關（於 renderMix() 內設定）
let mix = null;
let drumsOn = true;

// render(t) 的 t 為相對於本音的秒數（由整數 sample 計算）
function voice(startSample, durSec, render) {
  const n = Math.ceil(durSec * SR);
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx >= TOTAL_SAMPLES) break;
    mix[idx] += render(i / SR);
  }
}

// 打擊樂專用：關閉時仍呼叫 render 以消耗相同的 PRNG 序列，使其他樂器的隨機值與含鼓版逐位元相同
function drumVoice(startSample, durSec, render) {
  const n = Math.ceil(durSec * SR);
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx >= TOTAL_SAMPLES) break;
    const v = render(i / SR);
    if (drumsOn) mix[idx] += v;
  }
}

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name) {
  const m = name.match(/^([A-G])(\d)$/);
  const midi = (Number(m[2]) + 1) * 12 + SEMI[m[1]];
  return 440 * 2 ** ((midi - 69) / 12);
}

// ---------- 樂器 ----------
function kick(start, gain) {
  let phase = 0;
  drumVoice(start, 0.3, (t) => {
    const f = 45 + 105 * Math.exp(-t * 28); // 150 Hz → 45 Hz 的頻率掃掠
    phase += (2 * Math.PI * f) / SR;
    const body = Math.sin(phase) * Math.exp(-t * 14);
    const click = noise() * Math.exp(-t * 900) * 0.25;
    return gain * (body + click);
  });
}

function snare(start, gain) {
  const hp = makeHP(900);
  drumVoice(start, 0.25, (t) => {
    const n = hp(noise());
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.05);
    return gain * (0.6 * n * Math.exp(-t / 0.055) + 0.5 * tone);
  });
}

function hat(start, gain, open = false) {
  const hp = makeHP(6000);
  const decay = open ? 0.045 : 0.008;
  const len = open ? 0.15 : 0.03;
  drumVoice(start, len, (t) => gain * hp(noise()) * Math.exp(-t / decay));
}

function clap(start, gain) {
  const hp = makeHP(900);
  const lp = makeLP(4000);
  drumVoice(start, 0.2, (t) => {
    const n = lp(hp(noise()));
    let env = 0;
    for (const off of [0, 0.011, 0.022]) {
      if (t >= off) env += Math.exp(-(t - off) / 0.005);
    }
    if (t >= 0.022) env += 0.7 * Math.exp(-(t - 0.022) / 0.08);
    return gain * n * env;
  });
}

function bass(start, freq, durSec, gain) {
  const lp = makeLP(380);
  let phase = 0;
  voice(start, durSec + 0.05, (t) => {
    phase += freq / SR;
    phase -= Math.floor(phase);
    const saw = 2 * phase - 1;
    const attack = Math.min(1, t / 0.006);
    const rel = Math.min(1, Math.max(0, (durSec - t) / 0.04));
    const env = attack * rel * (0.6 + 0.4 * Math.exp(-t / 0.18));
    return gain * lp(saw) * env;
  });
}

// 每個和弦音三支微失諧鋸齒波，低通後以慢起音鋪底
function pad(start, durSec, freqs, gain, relSec) {
  const oscs = [];
  for (const f of freqs) {
    for (const detune of [1, 1.0035, 0.9965]) {
      oscs.push({ f: f * detune, ph: rand() });
    }
  }
  const lp = makeLP(1400);
  voice(start, durSec, (t) => {
    let s = 0;
    for (const o of oscs) {
      o.ph += o.f / SR;
      o.ph -= Math.floor(o.ph);
      s += 2 * o.ph - 1;
    }
    const env =
      Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (durSec - t) / relSec));
    return gain * lp(s / oscs.length) * env;
  });
}

// 主音：三角波與方波混合，短釋放
function lead(start, freq, durSec, gain, soft) {
  let phase = 0;
  voice(start, durSec, (t) => {
    phase += freq / SR;
    phase -= Math.floor(phase);
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    const sq = phase < 0.5 ? 1 : -1;
    const wave = soft ? tri : 0.6 * tri + 0.3 * sq;
    const attack = Math.min(1, t / 0.01);
    const rel = Math.min(1, Math.max(0, (durSec - t) / 0.06));
    const env = attack * rel * (1 - (0.25 * t) / durSec);
    return gain * wave * env;
  });
}

// 小節 23 的上升噪音掃掠：高通截止頻率由 200 Hz 指數上升到 8 kHz，音量漸強
function sweep(startSample, endSample, gain) {
  const n = endSample - startSample;
  let y = 0;
  let px = 0;
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx >= TOTAL_SAMPLES) break;
    const u = i / n;
    const a = hpAlpha(200 * 40 ** u);
    const x = noise();
    y = a * (y + x - px);
    px = x;
    mix[idx] += gain * u * u * y;
  }
}

function crash(start, gain) {
  const hp = makeHP(2500);
  drumVoice(start, 2.0, (t) => gain * hp(noise()) * Math.exp(-t / 0.7));
}

// ---------- 編曲資料 ----------
// 和弦循環：Am – F – C – G（每小節一個和弦）
const CHORDS = [
  { root: 'A1', tones: ['A3', 'C4', 'E4'] }, // Am
  { root: 'F1', tones: ['F3', 'A3', 'C4'] }, // F
  { root: 'C2', tones: ['C4', 'E4', 'G4'] }, // C
  { root: 'G1', tones: ['G3', 'B3', 'D4'] }, // G
];

// 主旋律 4 小節樂句，每小節 8 個八分音符 slot；'.' = 延續前一音（sustain）
const PHRASE = [
  'A4 . C5 E5 . D5 C5 .'.split(' '), // Am
  'A4 . C5 F5 . E5 C5 .'.split(' '), // F
  'G4 . C5 E5 . G5 E5 D5'.split(' '), // C
  'D5 . B4 G4 . A4 B4 .'.split(' '), // G
];

function sectionOf(bar) {
  if (bar < 4) return 'intro';
  if (bar < 12) return 'verse';
  if (bar < 20) return 'chorus';
  if (bar < 24) return 'breakdown';
  return 'final';
}

const hasDrums = (sec) => sec !== 'breakdown';
const hasBackbeat = (sec) => sec === 'verse' || sec === 'chorus' || sec === 'final';
const hasClap = (sec) => sec === 'chorus' || sec === 'final';
const hasBass = (sec) => sec === 'verse' || sec === 'chorus' || sec === 'final';
const hasOpenHat = (sec) => sec === 'verse' || sec === 'chorus' || sec === 'final';

// 結尾：小節 31 的第 3、4 拍不再有新的鼓點、貝斯與主旋律起音，只讓餘音衰減
const LAST_BAR = BARS - 1;
const isActive = (bar, s) => !(bar === LAST_BAR && s >= 4);

function playLead(bar, sec) {
  const phrase = PHRASE[bar % 4];
  const base = bar * SLOTS_PER_BAR;
  for (let s = 0; s < SLOTS_PER_BAR; s++) {
    const tok = phrase[s];
    if (tok === '.' || !isActive(bar, s)) continue;
    let len = 1;
    while (s + len < SLOTS_PER_BAR && phrase[s + len] === '.') len++;
    const start = sampleOf(slotSec(base + s));
    const gain = sec === 'breakdown' ? 0.2 : 0.22;
    lead(start, hz(tok), len * HALF_STEP, gain, sec === 'breakdown');
  }
}

function playBar(bar) {
  const sec = sectionOf(bar);
  const chord = CHORDS[bar % 4];
  const base = bar * SLOTS_PER_BAR;
  const at = (s) => sampleOf(slotSec(base + s));

  // 鋪底（每小節一個和弦，前後略為重疊以交叉淡化）
  const isLast = bar === LAST_BAR;
  const padGain = sec === 'verse' ? 0.3 : 0.45;
  pad(
    barStartSample(bar),
    isLast ? BAR_SEC : BAR_SEC + 0.6,
    chord.tones.map(hz),
    padGain,
    isLast ? 0.8 : 0.6,
  );

  // 踢鼓、軍鼓、拍手
  for (let s = 0; s < SLOTS_PER_BAR; s++) {
    if (!isActive(bar, s)) continue;
    if (hasDrums(sec)) {
      if (s === 0 || s === 4) kick(at(s), 0.95); // 1 & 3
      if (s === 5 && sec !== 'intro') kick(at(s), 0.5); // "&" of 3，較輕
    }
    if (hasBackbeat(sec) && (s === 2 || s === 6)) {
      snare(at(s), 0.55); // 2 & 4
      if (hasClap(sec)) clap(at(s), 0.35);
    }
  }

  // 踩拍與八分音符踩鈸
  for (let s = 0; s < SLOTS_PER_BAR; s++) {
    if (!isActive(bar, s)) continue;
    if (s === 7 && hasOpenHat(sec)) {
      hat(at(s), 0.22, true); // "&" of 4：開放式踩鈸
      continue;
    }
    const soft = sec === 'breakdown' ? 0.75 : 1;
    const g = (s % 2 === 1 ? 0.2 : 0.13) * soft; // 後拍稍加重
    hat(at(s), g, false);
  }

  // 貝斯：八分音符，根音為主，偶爾跳八度
  if (hasBass(sec)) {
    const root = hz(chord.root);
    for (let s = 0; s < SLOTS_PER_BAR; s++) {
      if (!isActive(bar, s)) continue;
      const octave = s === 6 && bar % 2 === 1;
      bass(at(s), octave ? root * 2 : root, HALF_STEP, 0.3);
    }
  }

  if (sec === 'chorus' || sec === 'final' || sec === 'breakdown') playLead(bar, sec);

  if (bar === 23) sweep(barStartSample(23), barStartSample(24), 0.35);
  if (bar === LAST_BAR) crash(barStartSample(LAST_BAR), 0.6);
}

// ---------- 合成與輸出 ----------
// 單次渲染（PRNG 每次從同一種子開始，輸出可重現）
function renderMix(drums) {
  mix = new Float64Array(TOTAL_SAMPLES);
  rand = mulberry32(SEED);
  drumsOn = drums;
  for (let bar = 0; bar < BARS; bar++) playBar(bar);

  // 結尾淡出 30 ms，避免截斷爆音
  const fadeLen = Math.round(0.03 * SR);
  for (let i = 0; i < fadeLen; i++) {
    mix[TOTAL_SAMPLES - 1 - i] *= i / fadeLen;
  }
  return mix;
}

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

// 渲染成品取樣（mono、22050 Hz）。
// 正規化到峰值 → tanh 軟削波 → 峰值 -1 dBFS。
// drums:false 沿用含鼓版的增益（以含鼓版峰值為除數），讓兩版的響度關係一致。
export function renderSong({ drums = true } = {}) {
  const fullMix = renderMix(true);
  const peak = peakOf(fullMix);
  const src = drums ? fullMix : renderMix(false);
  const norm = Math.tanh(DRIVE);
  const out = new Float32Array(TOTAL_SAMPLES);
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    out[i] = (Math.tanh((DRIVE * src[i]) / peak) / norm) * PEAK;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + 2 * i);
  }
  return buf;
}

// 僅在直接執行時寫檔（import 時不產生任何副作用）
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = renderSong({ drums: false });

  const meta = {
    title: '霓虹步伐 Neon Step（去鼓伴奏版）',
    bpm: BPM,
    offsetMs: 0,
    beatsPerBar: BEATS_PER_BAR,
    bars: BARS,
    durationSec: TOTAL_BEATS * 60 / BPM,
    sampleRate: SR,
    drums: false,
    // 人工標註的段落（小節為單位，endBar 不含）；遊戲優先採用（DESIGN-BEATSNAP §8）
    sections: [
      { startBar: 0, endBar: 4, intensity: 'low', name: 'intro' },
      { startBar: 4, endBar: 12, intensity: 'mid', name: 'verse' },
      { startBar: 12, endBar: 20, intensity: 'high', name: 'chorus' },
      { startBar: 20, endBar: 24, intensity: 'low', name: 'breakdown' },
      { startBar: 24, endBar: 32, intensity: 'high', name: 'final' },
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(WAV_PATH, encodeWav(out, SR));
  writeFileSync(JSON_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  console.log(`wrote ${WAV_PATH}`);
  console.log(`wrote ${JSON_PATH}`);
  console.log(`samples=${TOTAL_SAMPLES} duration=${(TOTAL_SAMPLES / SR).toFixed(6)}s peak=${peakOf(out).toFixed(4)} (drums=false)`);
}
