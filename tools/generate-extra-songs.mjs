#!/usr/bin/env node
// 額外原創曲目合成腳本 / Extra original songs synthesizer（Haiku-Songs）
// 產生兩首去鼓伴奏歌曲，皆為 4/4、32 小節（128 拍）：
//   midnight-funk     100 BPM，E 多利安放克   → assets/audio/song-100bpm.wav / .json
//   starlight-runner  112 BPM，D 大調合成器流行 → assets/audio/song-112bpm.wav / .json
// 並寫出曲目清單 assets/audio/songs.json（第一筆為預設曲 neon-step，資料取自 default-88bpm.json）。
// 零相依；噪音來自固定種子的 mulberry32，輸出可重現。
//
// 時間規則：事件時間 = 整數格位 index × 步長（不累加），取樣位置 = round(t × SR)。
// 格位單位為十六分音符（每小節 16 格）；八分音符 slot 佔 2 格。Beat 0 位於 sample 0。
//
// renderExtraSong(id, { drums })：drums:true 會加上底鼓、軍鼓與八分踩鈸，僅供測試與稽核；
// CLI 只寫出去鼓版。鼓使用獨立的 PRNG，其餘聲部在兩版之間逐位元相同。
// 兩版使用相同增益（以含鼓版的峰值正規化），因此響度關係一致。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'assets', 'audio');
const DEFAULT_JSON = resolve(OUT_DIR, 'default-88bpm.json');

const SR = 22050;
const BARS = 32;
const BEATS_PER_BAR = 4;
const TOTAL_BEATS = BARS * BEATS_PER_BAR;
const SIXTEENTHS = 16; // 每小節的十六分格數
const LAST_BAR = BARS - 1;
const PEAK = 10 ** (-1 / 20); // -1 dBFS
const DRIVE = 1.4; // tanh 軟削波強度
const FADE_SEC = 0.03; // 結尾淡出，避免截斷爆音

const SECTIONS = [
  { startBar: 0, endBar: 4, intensity: 'low', name: 'intro' },
  { startBar: 4, endBar: 12, intensity: 'mid', name: 'verse' },
  { startBar: 12, endBar: 20, intensity: 'high', name: 'chorus' },
  { startBar: 20, endBar: 24, intensity: 'low', name: 'breakdown' },
  { startBar: 24, endBar: 32, intensity: 'high', name: 'final' },
];

// 各段落的聲部倍率（0 表示不出現）
const LEVEL = {
  intro: { pad: 0.85, bass: 0.55, lead: 0, arp: 0, stab: 0 },
  verse: { pad: 0.9, bass: 1, lead: 0, arp: 0.9, stab: 1 },
  chorus: { pad: 1, bass: 1, lead: 1, arp: 1, stab: 1 },
  breakdown: { pad: 0.7, bass: 0, lead: 0.5, arp: 0.6, stab: 0 },
  final: { pad: 1.05, bass: 1.05, lead: 1.1, arp: 1.05, stab: 1.05 },
};

// ---------- 曲目設定 ----------
const MIDNIGHT_BASS_EM7 = 'E2 . . E3 . . D3 . E2 . G2 . A2 . B2 .'.split(' ');
const MIDNIGHT_BASS_A7 = 'A1 . . A2 . . G2 . A1 . C#2 . E2 . G2 .'.split(' ');
const STARLIGHT_CYCLE = ['D', 'A', 'Bm', 'G'];
const PLUCK_PATTERN = ['R2', 'R2', 'R3', 'R2', 'R2', 'R2', 'R3', 'R2']; // 每小節 8 個八分音符
const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 0, 1]; // 根音、三度、五度、八度、五度、三度、根音、三度

const SONGS = {
  'midnight-funk': {
    id: 'midnight-funk',
    title: '午夜放克 Midnight Funk（去鼓伴奏版）',
    bpm: 100,
    file: 'song-100bpm',
    seed: 0x1a2b3c,
    introPad: 'rhodes',
    bassStyle: 'funk',
    glide: false,
    cycles: {
      intro: ['Em7', 'Em7', 'A7', 'A7'],
      verse: ['Em7', 'Em7', 'A7', 'A7'],
      chorus: ['Cmaj7', 'D', 'Em7', 'Em7'],
      breakdown: ['Cmaj7', 'D', 'Em7', 'Em7'],
      final: ['Cmaj7', 'D', 'Em7', 'Em7'],
    },
    chords: {
      Em7: { root: 'E', pad: ['E3', 'G3', 'B3', 'D4'], stab: ['E4', 'G4', 'B4', 'D5'] },
      A7: { root: 'A', pad: ['A3', 'C#4', 'E4', 'G4'], stab: ['A4', 'C#5', 'E5', 'G5'] },
      Cmaj7: { root: 'C', pad: ['C4', 'E4', 'G4', 'B4'], stab: ['C5', 'E5', 'G5', 'B5'] },
      D: { root: 'D', pad: ['D4', 'F#4', 'A4'], stab: ['D5', 'F#5', 'A5'] },
    },
    bassTemplates: { Em7: MIDNIGHT_BASS_EM7, A7: MIDNIGHT_BASS_A7 },
    leads: [
      'E5 . G5 . B5 A5 G5 .', // Cmaj7
      'F#5 . A5 . D6 C#6 A5 .', // D
      'G5 . E5 . D5 E5 . .', // Em7
      'B4 . D5 E5 . . . .', // Em7
    ],
    leadWave: 'saw',
    leadVibrato: 0.006,
    padGain: 0.2,
    bassGain: 0.3,
    leadGain: 0.2,
    stabGain: 0.12,
    arpGain: 0,
    stabSections: ['verse', 'chorus', 'final'],
  },
  'starlight-runner': {
    id: 'starlight-runner',
    title: '星光跑者 Starlight Runner（去鼓伴奏版）',
    bpm: 112,
    file: 'song-112bpm',
    seed: 0x5ca1ab,
    introPad: 'pad',
    bassStyle: 'pluck',
    glide: true,
    cycles: {
      intro: STARLIGHT_CYCLE,
      verse: STARLIGHT_CYCLE,
      chorus: STARLIGHT_CYCLE,
      breakdown: STARLIGHT_CYCLE,
      final: STARLIGHT_CYCLE,
    },
    chords: {
      D: { root: 'D', pad: ['D4', 'F#4', 'A4'], arp: ['D3', 'F#3', 'A3', 'D4'] },
      A: { root: 'A', pad: ['A3', 'C#4', 'E4'], arp: ['A3', 'C#4', 'E4', 'A4'] },
      Bm: { root: 'B', pad: ['B3', 'D4', 'F#4'], arp: ['B3', 'D4', 'F#4', 'B4'] },
      G: { root: 'G', pad: ['G3', 'B3', 'D4'], arp: ['G3', 'B3', 'D4', 'G4'] },
    },
    bassTemplates: {},
    leads: [
      'F#5 . A5 . D6 . A5 .', // D
      'E5 . A5 . C#6 . B5 A5', // A
      'D6 . C#6 . B5 . F#5 .', // Bm
      'G5 . B5 . A5 . F#5 E5', // G
    ],
    leadWave: 'bright',
    leadVibrato: 0,
    padGain: 0.22,
    bassGain: 0.3,
    leadGain: 0.2,
    stabGain: 0,
    arpGain: 0.08,
    stabSections: [],
  },
};

export const SONG_IDS = Object.keys(SONGS);

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

// ---------- 渲染狀態（於 renderMix() 內設定）----------
let mix = null;
let rng = null; // 非鼓聲部專用
let drumRng = null; // 鼓專用，確保兩版的非鼓聲部相同
let drumsOn = false;
let STEP = 0; // 十六分音符秒數 = 60 / bpm / 4
let TOTAL = 0; // 總取樣數

const sampleAt = (g) => Math.round(g * STEP * SR); // g 為整數格位

// ---------- 濾波器（單極點）----------
function makeHP(fc) {
  const a = 1 / (1 + (2 * Math.PI * fc) / SR);
  let y = 0;
  let px = 0;
  return (x) => {
    y = a * (y + x - px);
    px = x;
    return y;
  };
}
function makeLP(fc) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  return (x) => (y += a * (x - y));
}

// 音名（如 E2、C#4）轉頻率，A4 = 440 Hz
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name) {
  const m = name.match(/^([A-G])(#?)(\d)$/);
  if (!m) throw new Error(`音名格式錯誤：${name}`);
  const midi = (Number(m[3]) + 1) * 12 + SEMI[m[1]] + (m[2] ? 1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

// 寫入一段聲音：render(t) 的 t 為相對於起點的秒數
function voice(startSample, durSec, render) {
  const n = Math.ceil(durSec * SR);
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx >= TOTAL) break;
    mix[idx] += render(i / SR);
  }
}

// 把一小節的 token 陣列展開成事件；'.' 表示延續前一個 token。
// unit 為每個 token 佔的十六分格數，g 為小節內格位，lenG 為延續格數。
function expandBar(tokens, unit) {
  const events = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok === '.') continue;
    let run = 1;
    while (k + run < tokens.length && tokens[k + run] === '.') run++;
    events.push({ g: k * unit, lenG: run * unit, tok });
  }
  return events;
}

// ---------- 鼓（僅 drums:true 時呼叫，使用獨立 PRNG）----------
const dNoise = () => drumRng() * 2 - 1;

function kick(start, gain) {
  let phase = 0;
  voice(start, 0.3, (t) => {
    const f = 45 + 105 * Math.exp(-t * 28);
    phase += (2 * Math.PI * f) / SR;
    const body = Math.sin(phase) * Math.exp(-t * 14);
    const click = dNoise() * Math.exp(-t * 900) * 0.25;
    return gain * (body + click);
  });
}

function snare(start, gain) {
  const hp = makeHP(900);
  voice(start, 0.25, (t) => {
    const n = hp(dNoise());
    const tone = Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.05);
    return gain * (0.6 * n * Math.exp(-t / 0.055) + 0.5 * tone);
  });
}

function hat(start, gain) {
  const hp = makeHP(6000);
  voice(start, 0.03, (t) => gain * hp(dNoise()) * Math.exp(-t / 0.008));
}

// ---------- 旋律與伴奏聲部（僅使用 rng；鼓不消耗此 PRNG）----------

// 鋪底：每個和弦音三支微失諧鋸齒波，低通後鋪底，起音 3 ms
function pad(start, durSec, freqs, gain, relSec) {
  const oscs = [];
  for (const f of freqs) {
    for (const d of [1, 1.0035, 0.9965]) oscs.push({ f: f * d, ph: rng() });
  }
  const lp = makeLP(1500);
  voice(start, durSec, (t) => {
    let s = 0;
    for (const o of oscs) {
      o.ph += o.f / SR;
      o.ph -= Math.floor(o.ph);
      s += 2 * o.ph - 1;
    }
    const env = Math.min(1, t / 0.003) * Math.min(1, Math.max(0, (durSec - t) / relSec));
    return gain * lp(s / oscs.length) * env;
  });
}

// 溫暖電鋼琴（正弦加泛音，指數衰減）
function rhodes(start, durSec, freqs, gain) {
  voice(start, durSec, (t) => {
    let s = 0;
    for (const f of freqs) {
      s +=
        Math.sin(2 * Math.PI * f * t) +
        0.35 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t / 0.4) +
        0.12 * Math.sin(2 * Math.PI * 4 * f * t) * Math.exp(-t / 0.1);
    }
    const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.9) * Math.min(1, Math.max(0, (durSec - t) / 0.08));
    return gain * (s / freqs.length) * env;
  });
}

// 放克 clav 和弦點：窄脈衝波、低通、極短衰減
function stab(start, freqs, gain) {
  const lp = makeLP(2600);
  const ph = freqs.map(() => 0);
  voice(start, 0.15, (t) => {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] += freqs[k] / SR;
      ph[k] -= Math.floor(ph[k]);
      s += ph[k] < 0.25 ? 1 : -1;
    }
    const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.045);
    return gain * lp(s / freqs.length) * env;
  });
}

// 低音：過驅動的鋸齒加方波，短起音、以 punchy 包絡收尾
function bass(start, freq, durSec, gain) {
  const lp = makeLP(650);
  let phase = 0;
  voice(start, durSec, (t) => {
    phase += freq / SR;
    phase -= Math.floor(phase);
    const x = lp(0.7 * (2 * phase - 1) + 0.3 * (phase < 0.5 ? 1 : -1));
    const driven = Math.tanh(2.2 * x) / Math.tanh(2.2);
    const attack = Math.min(1, t / 0.003);
    const rel = Math.min(1, Math.max(0, (durSec - t) / 0.03));
    const env = attack * rel * (0.55 + 0.45 * Math.exp(-t / 0.2));
    return gain * driven * env;
  });
}

// 主旋律：鋸齒或亮色（鋸齒＋方波）或三角波；可選微顫音與短滑音（從前一音滑到目標音）
function lead(start, fromHz, toHz, durSec, gain, wave, vibrato) {
  let phase = 0;
  voice(start, durSec, (t) => {
    const f = fromHz + (toHz - fromHz) * Math.min(1, t / 0.03);
    const v = vibrato ? 1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.2) : 1;
    phase += (f * v) / SR;
    phase -= Math.floor(phase);
    const saw = 2 * phase - 1;
    const sq = phase < 0.5 ? 1 : -1;
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    const w = wave === 'tri' ? tri : wave === 'bright' ? 0.5 * saw + 0.5 * sq : saw;
    const env =
      Math.min(1, t / 0.002) *
      Math.min(1, Math.max(0, (durSec - t) / 0.06)) *
      (1 - (0.2 * t) / durSec);
    return gain * w * env;
  });
}

// 琶音：短促的脈衝與三角波混合，指數衰減
function arp(start, freq, gain) {
  const lp = makeLP(3000);
  let phase = 0;
  voice(start, 0.14, (t) => {
    phase += freq / SR;
    phase -= Math.floor(phase);
    const sq = phase < 0.5 ? 1 : -1;
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    const env = Math.min(1, t / 0.001) * Math.exp(-t / 0.07);
    return gain * lp(0.5 * sq + 0.5 * tri) * env;
  });
}

// 小節 23 的上升噪音掃掠：高通截止由 200 Hz 指數上升到約 8 kHz，音量漸強
function sweep(startSample, endSample, gain) {
  const n = endSample - startSample;
  let y = 0;
  let px = 0;
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx >= TOTAL) break;
    const u = i / n;
    const a = 1 / (1 + (2 * Math.PI * 200 * 40 ** u) / SR);
    const x = rng() * 2 - 1;
    y = a * (y + x - px);
    px = x;
    mix[idx] += gain * u * u * y;
  }
}

// ---------- 編曲 ----------
function sectionOf(bar) {
  for (const s of SECTIONS) if (bar >= s.startBar && bar < s.endBar) return s.name;
  throw new Error(`小節超出範圍：${bar}`);
}

// 低音事件：funk 的 intro/verse 用和弦自己的節奏型；chorus/final 用 Em7 節奏型但換成該和弦的根音
function bassEvents(cfg, chordName, sec) {
  const chord = cfg.chords[chordName];
  if (cfg.bassStyle === 'funk') {
    const own = sec === 'intro' || sec === 'verse';
    const tokens = own
      ? cfg.bassTemplates[chordName]
      : cfg.bassTemplates.Em7.map((t) => (t === '.' ? '.' : chord.root + t.slice(-1)));
    return expandBar(tokens, 1);
  }
  // pluck：八分音符根音，偶爾跳八度
  return expandBar(
    PLUCK_PATTERN.map((t) => chord.root + t.slice(-1)),
    2,
  );
}

function playBar(cfg, bar, beatSec, barSec) {
  const sec = sectionOf(bar);
  const L = LEVEL[sec];
  const ci = bar % 4;
  const chordName = cfg.cycles[sec][ci];
  const chord = cfg.chords[chordName];
  const G0 = bar * SIXTEENTHS;
  const isLast = bar === LAST_BAR;
  // 最後小節第 3、4 拍不再起音，只讓和弦餘韻響到結束
  const ok = (g) => !(isLast && g >= 8);
  const at = (g) => sampleAt(G0 + g);

  // 鋪底：intro 為電鋼琴（拍 1、3）或鋪底，其餘為鋸齒波鋪底
  const padFreqs = chord.pad.map(hz);
  if (sec === 'intro' && cfg.introPad === 'rhodes') {
    for (const g of [0, 8]) rhodes(at(g), 2 * beatSec + 0.4, padFreqs, cfg.padGain * L.pad);
  } else if (L.pad > 0) {
    const dur = isLast ? (TOTAL - at(0)) / SR : barSec + 0.6;
    pad(at(0), dur, padFreqs, cfg.padGain * L.pad, isLast ? 0.9 : 0.5);
  }

  // 低音
  if (L.bass > 0) {
    for (const ev of bassEvents(cfg, chordName, sec)) {
      if (ok(ev.g)) bass(at(ev.g), hz(ev.tok), ev.lenG * STEP, cfg.bassGain * L.bass);
    }
  }

  // clav 和弦點：每小節 4 個「&」
  if (cfg.stabSections.includes(sec) && cfg.stabGain > 0) {
    for (const g of [2, 6, 10, 14]) {
      if (ok(g)) stab(at(g), chord.stab.map((n) => hz(n) * 2), cfg.stabGain * L.stab);
    }
  }

  // 主旋律
  if (L.lead > 0) {
    let prev = null;
    for (const ev of expandBar(cfg.leads[ci].split(' '), 2)) {
      if (!ok(ev.g)) continue;
      const f = hz(ev.tok);
      const from = cfg.glide && prev !== null ? prev : f;
      const wave = sec === 'breakdown' ? 'tri' : cfg.leadWave;
      lead(at(ev.g), from, f, ev.lenG * STEP, cfg.leadGain * L.lead, wave, cfg.leadVibrato);
      prev = f;
    }
  }

  // 琶音：十六分音符，每小節兩組八音型
  if (L.arp > 0 && cfg.arpGain > 0) {
    for (let g = 0; g < SIXTEENTHS; g++) {
      if (!ok(g)) continue;
      arp(at(g), hz(chord.arp[ARP_PATTERN[g % 8]]), cfg.arpGain * L.arp);
    }
  }

  // 鼓（僅測試）：底鼓 1、3 拍，軍鼓 2、4 拍，八分踩鈸；breakdown 無鼓
  if (drumsOn && sec !== 'breakdown') {
    for (let g = 0; g < SIXTEENTHS; g++) {
      if (!ok(g)) continue;
      if (g === 0 || g === 8) kick(at(g), 0.95);
      if ((g === 4 || g === 12) && sec !== 'intro') snare(at(g), 0.55);
      if (g % 2 === 0) hat(at(g), g % 4 === 2 ? 0.2 : 0.13);
    }
  }

  if (bar === 23) sweep(at(0), sampleAt((bar + 1) * SIXTEENTHS), 0.3);
}

// 單次渲染（PRNG 每次從同一種子開始，輸出可重現）
function renderMix(cfg, drums) {
  STEP = 60 / cfg.bpm / 4;
  const beatSec = 60 / cfg.bpm;
  const barSec = 4 * beatSec;
  TOTAL = Math.round((TOTAL_BEATS * 60 * SR) / cfg.bpm);
  mix = new Float64Array(TOTAL);
  rng = mulberry32(cfg.seed);
  drumRng = mulberry32((cfg.seed ^ 0x5eed5eed) >>> 0);
  drumsOn = drums;
  for (let bar = 0; bar < BARS; bar++) playBar(cfg, bar, beatSec, barSec);

  // 結尾淡出，避免截斷爆音
  const fadeLen = Math.round(FADE_SEC * SR);
  for (let i = 0; i < fadeLen; i++) mix[TOTAL - 1 - i] *= i / fadeLen;
  return mix;
}

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

// 渲染成品取樣（mono、22050 Hz，Float64Array，值域約 -1..1）。
// 以含鼓版的峰值正規化，再經 tanh 軟削波，峰值 -1 dBFS；drums:false 沿用同一增益。
export function renderExtraSong(id, { drums = true } = {}) {
  const cfg = SONGS[id];
  if (!cfg) throw new Error(`未知曲目：${id}`);
  const full = renderMix(cfg, true);
  const peak = peakOf(full);
  const src = drums ? full : renderMix(cfg, false);
  const norm = Math.tanh(DRIVE);
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = (Math.tanh((DRIVE * src[i]) / peak) / norm) * PEAK;
  }
  return out;
}

export function buildMeta(id) {
  const cfg = SONGS[id];
  if (!cfg) throw new Error(`未知曲目：${id}`);
  return {
    title: cfg.title,
    bpm: cfg.bpm,
    offsetMs: 0,
    beatsPerBar: BEATS_PER_BAR,
    bars: BARS,
    durationSec: (TOTAL_BEATS * 60) / cfg.bpm,
    sampleRate: SR,
    sections: SECTIONS.map((s) => ({ ...s })),
    drums: false,
  };
}

// 曲目清單：預設曲（資料取自既有的 default-88bpm.json）加上兩首新曲
export function buildSongsManifest() {
  const def = JSON.parse(readFileSync(DEFAULT_JSON, 'utf8'));
  const list = [
    {
      id: 'neon-step',
      title: def.title,
      bpm: def.bpm,
      json: 'assets/audio/default-88bpm.json',
      wav: 'assets/audio/default-88bpm.wav',
    },
  ];
  for (const id of SONG_IDS) {
    const cfg = SONGS[id];
    list.push({
      id,
      title: cfg.title,
      bpm: cfg.bpm,
      json: `assets/audio/${cfg.file}.json`,
      wav: `assets/audio/${cfg.file}.wav`,
    });
  }
  return list;
}

export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
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
  mkdirSync(OUT_DIR, { recursive: true });
  for (const id of SONG_IDS) {
    const cfg = SONGS[id];
    const samples = renderExtraSong(id, { drums: false });
    const wavPath = resolve(OUT_DIR, `${cfg.file}.wav`);
    const jsonPath = resolve(OUT_DIR, `${cfg.file}.json`);
    writeFileSync(wavPath, encodeWav(samples, SR));
    writeFileSync(jsonPath, JSON.stringify(buildMeta(id), null, 2) + '\n', 'utf8');
    let p = 0;
    for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i]));
    console.log(`wrote ${wavPath}`);
    console.log(`wrote ${jsonPath}`);
    console.log(`${id}: samples=${samples.length} duration=${(samples.length / SR).toFixed(6)}s peak=${p.toFixed(4)} (drums=false)`);
  }
  const manifestPath = resolve(OUT_DIR, 'songs.json');
  writeFileSync(manifestPath, JSON.stringify(buildSongsManifest(), null, 2) + '\n', 'utf8');
  console.log(`wrote ${manifestPath}`);
}
