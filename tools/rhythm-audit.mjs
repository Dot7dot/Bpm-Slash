#!/usr/bin/env node
// BPM Slash 節奏對拍稽核工具 / Rhythm sync audit tool
//
// 用法 / Usage:
//   node tools/rhythm-audit.mjs [--url <baseUrl>] [--wav <path>] [--bpm 88]
//        [--skip-browser] [--skip-wav] [--json <reportPath>] [--quick]
//        [--shots <dir>] [--bars 4] [--seed 12345] [--headed]
//
// Part A：離線分析 WAV（onset 對 8 分音符網格的誤差 + 獨立估計 tempo）。
// Part B：以 Playwright 開啟遊戲，透過 window.__BPM_SLASH_DEBUG__ 驗證
//         BeatSnap 攻擊量化、拍點事件、世界事件、節拍器、鼓組音效（DESIGN-BEATSNAP.md §3–§11 與 DESIGN.md §5 §7）。
// 結束碼：沒有任何 FAIL 才是 0。
//
// 零相依（Playwright 為預先安裝的全域套件，找不到時會 SKIPPED，不會 crash）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 參數解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    url: null, wav: null, bpm: null, skipBrowser: false, skipWav: false,
    json: null, only: null, quick: false, shots: null, bars: 4, seed: 20240607, headed: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': o.url = next(); break;
      case '--wav': o.wav = next(); break;
      case '--bpm': o.bpm = Number(next()); break;
      case '--skip-browser': o.skipBrowser = true; break;
      case '--skip-wav': o.skipWav = true; break;
      case '--json': o.json = next(); break;
      case '--only': o.only = next().split(',').map(Number); break;
      case '--quick': o.quick = true; break;
      case '--shots': o.shots = next(); break;
      case '--bars': o.bars = Number(next()); break;
      case '--seed': o.seed = Number(next()); break;
      case '--headed': o.headed = true; break;
      case '-h': case '--help': o.help = true; break;
      default: console.error(`未知參數 / unknown argument: ${a}`); o.help = true;
    }
  }
  return o;
}

const HELP = `rhythm-audit：BPM Slash 節奏對拍稽核
  --url <baseUrl>   使用已啟動的伺服器（預設自動啟動 tools/serve.mjs）
  --wav <path>      要分析的 WAV（預設 assets/audio/default-88bpm.wav）
  --bpm <n>         Part A 的標稱 BPM（預設讀同名 .json，否則 88）
  --skip-browser    略過 Part B
  --skip-wav        略過 Part A
  --json <path>     輸出機器可讀的 JSON 報告
  --only <bpm,..>   Part B 只跑指定 BPM 的設定（例：--only 240）
  --quick           Part B 只跑 88 auto、150 auto、120 strict
  --shots <dir>     每個設定存一張截圖
  --bars <n>        每個設定連按的小節數（預設 4）
  --seed <n>        PRNG 種子
  --headed          顯示瀏覽器視窗`;

// ---------------------------------------------------------------------------
// 工具函式
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: NaN, p50: NaN, p95: NaN, max: NaN, min: NaN };
  const sum = v.reduce((s, x) => s + x, 0);
  return { n: v.length, mean: sum / v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95), max: v[v.length - 1], min: v[0] };
}

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const ms = (sec, d = 2) => (Number.isFinite(sec) ? (sec * 1000).toFixed(d) : 'n/a');

/** 收集檢查結果的小容器 */
class Checks {
  constructor() { this.items = []; }
  add(id, name, status, detail = '', metrics = undefined) {
    this.items.push({ id, name, status, detail, metrics });
  }
  /** ok 為 true → PASS，false → FAIL（warnOnly 時降為 WARN） */
  check(id, name, ok, detail = '', metrics, warnOnly = false) {
    this.add(id, name, ok ? 'PASS' : (warnOnly ? 'WARN' : 'FAIL'), detail, metrics);
  }
  get failed() { return this.items.some((i) => i.status === 'FAIL'); }
}

function firstN(list, n = 3) {
  return list.slice(0, n).join('; ') + (list.length > n ? ` …(共 ${list.length} 筆)` : '');
}

// ---------------------------------------------------------------------------
// Part A：WAV 分析
// ---------------------------------------------------------------------------
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 檔案');
  }
  let pos = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      if (body + size > buf.length) size = buf.length - body; // 容忍截斷或 streaming 檔頭
      dataLen = size;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!fmt) throw new Error('找不到 fmt chunk');
  if (dataStart < 0) throw new Error('找不到 data chunk');
  if (fmt.tag !== 1 && fmt.tag !== 0xfffe) throw new Error(`不支援的 WAV 格式 tag=${fmt.tag}（僅支援 PCM）`);
  if (fmt.bits !== 16) throw new Error(`僅支援 16-bit PCM（此檔為 ${fmt.bits}-bit）`);
  const frames = Math.floor(dataLen / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(dataStart + (i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels / 32768;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, durationSec: frames / fmt.sampleRate, samples: mono };
}

/** 偵測打擊樂 onset，回傳 { onsets: 秒[], tempoEnv } */
export function detectOnsets(x, sr) {
  const win = Math.max(2, Math.round(0.004 * sr));
  const hop = Math.max(1, Math.round(0.002 * sr));
  const n = x.length;
  // 差分訊號（強調高頻瞬態）；原始訊號（保留低頻如大鼓）
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = x[i] - x[i - 1];
  let maxRaw = 1e-9;
  let maxDiff = 1e-9;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]); if (a > maxRaw) maxRaw = a;
    const b = Math.abs(d[i]); if (b > maxDiff) maxDiff = b;
  }
  const nFrames = Math.max(0, Math.floor((n - win) / hop));
  const env = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let sr2 = 0; let sd2 = 0;
    const s = i * hop;
    for (let k = 0; k < win; k++) { sr2 += x[s + k] * x[s + k]; sd2 += d[s + k] * d[s + k]; }
    const er = Math.sqrt(sr2 / win) / maxRaw;
    const ed = Math.sqrt(sd2 / win) / maxDiff;
    env[i] = Math.max(er, ed);
  }
  const envDb = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) envDb[i] = Math.max(-70, 20 * Math.log10(env[i] + 1e-9));

  const span = 3; // 約 6 ms
  const recentFrames = Math.round(0.03 / (hop / sr));
  const minGap = Math.round(0.06 / (hop / sr));
  const onsets = [];
  let last = -1e9;
  // 樣本級精修用差分訊號：低頻貝斯/鋪底的殘響在差分後很小，不會被誤認為起音
  const sampleScore = (i) => Math.abs(d[i]);
  for (let i = span; i < nFrames; i++) {
    if (i - last < minGap) continue;
    // 與「前 6~30 ms 的最大值」比較：衰減尾巴上的雜訊起伏不會超過它，真正的新起音才會
    let recentMax = -Infinity;
    for (let j = Math.max(0, i - recentFrames); j <= i - span; j++) if (envDb[j] > recentMax) recentMax = envDb[j];
    const rise = envDb[i] - recentMax;
    if (rise >= 6 && envDb[i] > -50) {
      // 往後找這次上升的峰值再回頭做樣本級精修
      // 起音一定落在「被偵測到的那個窗」之內或剛好之前；縮小搜尋範圍避免抓到鄰近的其他聲音
      const s0 = Math.max(0, (i - 1) * hop);
      const s1 = Math.min(n, i * hop + win);
      let peak = 0;
      for (let k = s0; k < s1; k++) { const v = sampleScore(k); if (v > peak) peak = v; }
      let onsetSample = s0;
      for (let k = s0; k < s1; k++) { if (sampleScore(k) >= 0.2 * peak) { onsetSample = k; break; } }
      onsets.push(onsetSample / sr);
      last = i;
    }
  }
  // tempo 用的 onset strength（log 能量正向差分）
  const flux = new Float32Array(nFrames);
  for (let i = 1; i < nFrames; i++) flux[i] = Math.max(0, envDb[i] - envDb[i - 1]);
  return { onsets, flux, hopSec: hop / sr };
}

/** 以 onset strength 自相關獨立估計 tempo（折疊到 70–180） */
export function estimateTempo(flux, hopSec) {
  const N = Math.min(flux.length, Math.floor(60 / hopSec));
  let mean = 0;
  for (let i = 0; i < N; i++) mean += flux[i];
  mean /= Math.max(1, N);
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = flux[i] - mean;
  const minLag = Math.floor(0.3 / hopSec) - 2; // 200 BPM
  const maxLag = Math.ceil(1.0 / hopSec) * 8 + 12; // 容納 4× 週期與倍週期修正
  const R = new Float64Array(maxLag + 2);
  for (let L = minLag; L <= maxLag && L < N - 1; L++) {
    let s = 0;
    for (let i = 0; i + L < N; i++) s += a[i] * a[i + L];
    R[L] = s / (N - L);
  }
  const r0 = (() => { let s = 0; for (let i = 0; i < N; i++) s += a[i] * a[i]; return s / N || 1; })();
  let bestL = -1; let bestS = -Infinity;
  const lo = Math.floor(0.3 / hopSec); const hi = Math.ceil(1.0 / hopSec);
  for (let L = lo; L <= hi; L++) {
    const S = R[L] + 0.5 * (R[2 * L] || 0) + 0.25 * (R[4 * L] || 0);
    if (S > bestS) { bestS = S; bestL = L; }
  }
  if (bestL < 0) return { bpm: NaN, confidence: 0 };
  // 八分音符為主的曲子會讓「半個拍長」的自相關和拍長一樣高 → 若兩倍週期的自相關夠高（≥75%）且仍在 70 BPM 以上，取較慢者當拍
  if (60 / (2 * bestL * hopSec) >= 70 && 2 * bestL <= maxLag / 2) {
    let r2 = -Infinity;
    for (let L = 2 * bestL - 2; L <= 2 * bestL + 2; L++) r2 = Math.max(r2, R[L]);
    if (r2 >= 0.75 * R[bestL]) bestL *= 2;
  }
  // 用四倍週期的峰值提高精度
  const center = 4 * bestL;
  let pk = center;
  for (let L = center - 4; L <= center + 4; L++) if (L < R.length && R[L] > R[pk]) pk = L;
  let period = pk;
  if (pk > 0 && pk + 1 < R.length) {
    const y0 = R[pk - 1]; const y1 = R[pk]; const y2 = R[pk + 1];
    const den = y0 - 2 * y1 + y2;
    if (den !== 0) period = pk + (0.5 * (y0 - y2)) / den;
  }
  let bpm = 60 / ((period / 4) * hopSec);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm, confidence: R[bestL] / r0 };
}

function analyzeWav(opts) {
  const c = new Checks();
  const wavPath = path.resolve(opts.wav || path.join(REPO_ROOT, 'assets/audio/default-88bpm.wav'));
  const report = { path: wavPath };
  if (!fs.existsSync(wavPath)) {
    c.add('A0', 'WAV 檔案存在', 'SKIPPED', `找不到 ${wavPath}（尚未產生？）`);
    return { checks: c.items, report };
  }
  let bpm = Number.isFinite(opts.bpm) ? opts.bpm : null;
  let offsetSec = 0;
  const jsonPath = wavPath.replace(/\.wav$/i, '.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (bpm == null && Number.isFinite(Number(meta.bpm))) bpm = Number(meta.bpm);
      if (Number.isFinite(Number(meta.offsetSec))) offsetSec = Number(meta.offsetSec);
      else if (Number.isFinite(Number(meta.offsetMs))) offsetSec = Number(meta.offsetMs) / 1000;
      report.meta = meta;
    } catch (e) { c.add('A0', '讀取 sibling .json', 'WARN', `解析失敗：${e.message}`); }
  }
  if (bpm == null) bpm = 88;
  report.bpm = bpm; report.offsetSec = offsetSec;

  let wav;
  try {
    wav = parseWav(fs.readFileSync(wavPath));
  } catch (e) {
    c.add('A1', 'WAV 解析', 'FAIL', e.message);
    return { checks: c.items, report };
  }
  report.sampleRate = wav.sampleRate; report.channels = wav.channels; report.durationSec = wav.durationSec;
  c.add('A1', 'WAV 解析', 'PASS', `${wav.sampleRate} Hz / ${wav.channels} ch / ${f(wav.durationSec, 2)} s`);

  const { onsets, flux, hopSec } = detectOnsets(wav.samples, wav.sampleRate);
  const half = 30 / bpm;
  const errs = onsets.map((t) => {
    const k = Math.round((t - offsetSec) / half);
    return t - (k * half + offsetSec);
  });
  const abs = errs.map(Math.abs);
  const st = stats(abs);
  const within10 = abs.filter((e) => e <= 0.010).length / (abs.length || 1);
  // 以圓周平均估計實際網格偏移（供參考）
  let sx = 0; let sy = 0;
  for (const t of onsets) { const ph = (2 * Math.PI * (t / half)); sx += Math.cos(ph); sy += Math.sin(ph); }
  let fitOffset = (Math.atan2(sy, sx) / (2 * Math.PI)) * half; // 範圍 (-half/2, half/2]
  report.onsets = { count: onsets.length, meanAbsMs: st.mean * 1000, p95Ms: st.p95 * 1000, maxMs: st.max * 1000, within10msFraction: within10, fitOffsetMs: fitOffset * 1000 };
  c.check('A2', `onset 對齊 8 分音符網格（平均誤差 ≤ 5 ms）`,
    onsets.length >= 8 && st.mean <= 0.005,
    `onset=${onsets.length}，平均 |誤差|=${ms(st.mean)} ms，p95=${ms(st.p95)} ms，max=${ms(st.max)} ms，±10 ms 內=${f(within10 * 100, 1)}%（網格偏移 ${f(offsetSec * 1000, 1)} ms；擬合偏移 ${ms(fitOffset, 1)} ms）`,
    report.onsets);
  const tempo = estimateTempo(flux, hopSec);
  report.tempo = tempo;
  c.check('A3', `獨立估計 tempo = ${bpm} ± 0.5 BPM`,
    Number.isFinite(tempo.bpm) && Math.abs(tempo.bpm - bpm) <= 0.5,
    `估計 ${f(tempo.bpm, 3)} BPM（信心 ${f(tempo.confidence, 2)}）`, tempo);
  return { checks: c.items, report };
}

// ---------------------------------------------------------------------------
// Part B：BeatSnap 演算法（DESIGN-BEATSNAP.md §3.2 的獨立再實作，不 import 遊戲程式碼）
// ---------------------------------------------------------------------------
const modInt = (a, n) => ((a % n) + n) % n;
const LEVEL_OF = (k) => (modInt(k, 32) === 0 ? 'bar' : modInt(k, 16) === 0 ? 'half' : modInt(k, 8) === 0 ? 'beat' : modInt(k, 4) === 0 ? 'eighth' : modInt(k, 2) === 0 ? 'sixteenth' : 'thirtysecond');
const WEIGHT_OF = { bar: 5, half: 4, beat: 3, eighth: 2, sixteenth: 1, thirtysecond: 0 };
const HALF_OF = { bar: 'front', half: 'front', beat: 'front', eighth: 'back', sixteenth: 'sub', thirtysecond: 'sub' };

/** 自動切分（§3.1）：回傳步長 S（tick）。 */
export function autoStepRef(bpm) {
  const beatDur = 60 / bpm;
  for (const d of [8, 4, 2]) if (beatDur / d >= 0.11 - 1e-9) return 8 / d;
  return 8;
}
export function stepRef(subdivision, bpm) {
  return [1, 2, 4, 8].includes(Number(subdivision)) ? 8 / Number(subdivision) : autoStepRef(bpm);
}

export function judgmentOf(deltaSec) {
  const a = Math.abs(deltaSec) - 1e-9;
  return a <= 0.045 ? 'perfect' : a <= 0.09 ? 'great' : a <= 0.14 ? 'good' : 'off';
}

/** §3.2 參考實作。p: { t, s, bpm, subdivision, lateGraceSec, minTick, strict } */
export function snapRef({ t, s, bpm, subdivision = 'auto', lateGraceSec = 0.04, minTick = -Infinity, strict = false }) {
  const tickDur = 60 / bpm / 8;
  const time = (k) => (k * 60 / bpm) / 8;
  const S = stepRef(subdivision, bpm);
  const J = Math.max(4, S);
  const schedMin = Math.ceil((s + 0.005) / tickDur - 1e-9);
  const aim = Math.min(0.09, J * tickDur / 2);
  const pJ = Math.floor(t / (J * tickDur) + 1e-9) * J;
  const nJ = pJ + J;
  let tick; let rule; let magnet = false;
  if (!strict && t - time(pJ) <= lateGraceSec + 1e-9 && pJ >= minTick) { tick = pJ; rule = 'late'; }
  else if (time(nJ) - t <= aim + 1e-9 && nJ >= minTick && (!strict || nJ >= schedMin)) { tick = nJ; rule = 'aimed'; }
  else {
    const earliest = Math.max(t + 0.05, s + 0.005);
    let c0 = Math.ceil(earliest / tickDur - 1e-9);
    c0 = Math.max(c0, minTick, schedMin);
    c0 = Math.ceil(c0 / S) * S;
    const c1 = c0 + S;
    if (WEIGHT_OF[LEVEL_OF(c1)] >= 3 && WEIGHT_OF[LEVEL_OF(c1)] > WEIGHT_OF[LEVEL_OF(c0)] && time(c1) - time(c0) <= 0.2 + 1e-9) { tick = c1; magnet = true; }
    else tick = c0;
    rule = 'snap';
  }
  const a = Math.round(t / (J * tickDur)) * J;
  const judgeDeltaSec = t - time(a);
  return { tick, rule, magnet, judgeTick: a, judgeDeltaSec, judgment: judgmentOf(judgeDeltaSec), S, J };
}

/** 連段參考偵測（§6）：回傳每一擊應有的 combo（null | 'eighth' | 'bar' | 'fill'）。 */
export function combosRef(attacks) {
  const out = [];
  const ticks = new Set();
  let lastEighth = -Infinity; let run = 0; let runStep = 0; let lastTick = -Infinity;
  for (const a of attacks) {
    const s = a.tick;
    if (run > 0 && s - lastTick === a.stepTicks && runStep === a.stepTicks) run++; else { run = 1; runStep = a.stepTicks; }
    lastTick = s;
    ticks.add(s);
    let bar = false;
    if (modInt(s, 32) === 24) {
      const base = s - 24;
      bar = ticks.has(base) && ticks.has(base + 8) && ticks.has(base + 16);
      if (bar) for (const v of ticks) if (v >= base && v < s && modInt(v, 8) !== 0) bar = false;
    }
    const fill = !bar && run >= 4 && modInt(s, 32) === 0;
    let eighth = false;
    if (!bar && !fill && modInt(s, 8) === 4) {
      const k = s - 12;
      eighth = k > lastEighth && ticks.has(k) && ticks.has(k + 4) && ticks.has(k + 8);
    }
    if (fill) run = 0;
    if (eighth) lastEighth = s;
    out.push(bar ? 'bar' : fill ? 'fill' : eighth ? 'eighth' : null);
  }
  return out;
}

// §7 / §10 世界事件允許的 beatInBar（null = 任意拍）
const WORLD_RULES = {
  'spike-telegraph': [2], 'spike-up': [3], 'spike-down': [0], spawn: [0],
  'bat-telegraph': [2], 'bat-swoop': [3],
  'guard-step': [0, 2], 'guard-telegraph': [2], 'guard-strike': [3],
  'slime-hop': [0, 1, 2, 3],
  'fever-start': [0], 'fever-end': [0], parry: null, 'enemy-stun': null,
};

// ---------------------------------------------------------------------------
// Part B：單一設定的分析（純資料，方便離線測試）
// ---------------------------------------------------------------------------
export function analyzeRun(data, cfg) {
  const c = new Checks();
  const bpm = cfg.bpm;
  const beatDur = 60 / bpm;
  const tickDur = beatDur / 8;
  const grace = (cfg.lateGraceMs ?? 40) / 1000;
  const subdivision = cfg.subdivision ?? 'auto';
  const expectStep = stepRef(subdivision, bpm);
  const expectJudge = Math.max(4, expectStep);
  const { attacks = [], beats = [], world = [], metro = [], state = {}, errors = [] } = data;
  const LAG = 0.040;
  const strict = grace === 0;
  const outLat = Number.isFinite(state && state.outputLatency) ? state.outputLatency : 0;

  // 0. 設定是否生效
  if (state && Number.isFinite(state.bpm)) {
    const stepOk = state.stepTicks === undefined || state.stepTicks === expectStep;
    c.check('B0', '設定已套用（bpm / 落點切分 / stepTicks）', Math.abs(state.bpm - bpm) < 1e-6 && stepOk && (state.judgeStepTicks === undefined || state.judgeStepTicks === expectJudge),
      `state.bpm=${state.bpm}，subdivision=${state.subdivision}，stepTicks=${state.stepTicks}（預期 ${expectStep}），judgeStepTicks=${state.judgeStepTicks}（預期 ${expectJudge}），lateGraceMs=${state.lateGraceMs}`);
  }

  // 1. 網格規則
  {
    const bad = [];
    let maxErr = 0;
    const ruleCount = {}; const levelCount = {};
    for (const a of attacks) {
      const problems = [];
      const err = Math.abs(a.connectSongTime - (a.tick * beatDur) / 8);
      maxErr = Math.max(maxErr, err);
      if (!Number.isInteger(a.tick)) problems.push('tick 非整數');
      if (!(err < 1e-6)) problems.push(`connectSongTime 與 tick×beatDur/8 差 ${ms(err, 4)}ms`);
      if (a.stepTicks !== expectStep) problems.push(`stepTicks=${a.stepTicks} 應為 ${expectStep}`);
      if (a.judgeStepTicks !== expectJudge) problems.push(`judgeStepTicks=${a.judgeStepTicks} 應為 ${expectJudge}`);
      if (a.rule === 'snap' && modInt(a.tick, expectStep) !== 0) problems.push(`snap 的 tick ${a.tick} 不是 stepTicks(${expectStep}) 的倍數`);
      if ((a.rule === 'late' || a.rule === 'aimed') && modInt(a.tick, expectJudge) !== 0) problems.push(`${a.rule} 的 tick ${a.tick} 不是 judgeStepTicks(${expectJudge}) 的倍數`);
      if (!['late', 'aimed', 'snap'].includes(a.rule)) problems.push(`未知 rule=${a.rule}`);
      if (!!a.late !== (a.rule === 'late')) problems.push(`late=${a.late} 與 rule=${a.rule} 不符`);
      const lv = LEVEL_OF(a.tick);
      if (a.level !== lv) problems.push(`level=${a.level} 應為 ${lv}`);
      if (a.weight !== WEIGHT_OF[lv]) problems.push(`weight=${a.weight} 應為 ${WEIGHT_OF[lv]}`);
      if (a.half !== HALF_OF[lv]) problems.push(`half=${a.half} 應為 ${HALF_OF[lv]}`);
      if (a.isDownbeat !== undefined && !!a.isDownbeat !== (modInt(a.tick, 32) === 0)) problems.push(`isDownbeat=${a.isDownbeat} 不符`);
      if (a.beatInBar !== undefined && a.beatInBar !== modInt(Math.floor(a.tick / 8), 4)) problems.push(`beatInBar=${a.beatInBar} 不符`);
      ruleCount[a.rule] = (ruleCount[a.rule] || 0) + 1;
      levelCount[lv] = (levelCount[lv] || 0) + 1;
      if (problems.length) bad.push(`#${a.id}(tick ${a.tick}): ${problems.join(', ')}`);
    }
    c.check('B1', '網格規則：tick 整數、connect=tick×beatDur/8、snap∈stepTicks 倍數、late/aimed∈judgeStep 倍數、level/half/weight 正確', attacks.length > 0 && bad.length === 0,
      attacks.length === 0 ? '攻擊 log 為空（沒有任何攻擊被記錄）' : `共 ${attacks.length} 次，最大誤差 ${ms(maxErr, 6)} ms；rule：${Object.entries(ruleCount).map(([k, v]) => `${k}=${v}`).join(' ')}；level：${Object.entries(levelCount).map(([k, v]) => `${k}=${v}`).join(' ')}${bad.length ? '；' + firstN(bad) : ''}`,
      { ruleCount, levelCount });
  }

  // 2. 排程時間 / clamping（依 rule 分類）/ 判定
  {
    const bad = []; const schedErr = []; const lateClamped = []; const aimedClamped = [];
    let nClamped = 0; let nMissingFlag = 0;
    for (const a of attacks) {
      const problems = [];
      const diff = a.scheduledAudioTime - a.expectedAudioTime;
      const hasFlag = typeof a.sfxClamped === 'boolean';
      if (!hasFlag) nMissingFlag++;
      // 判定與 judgeDelta
      const jd = a.inputSongTime - a.judgeTick * tickDur;
      if (Math.abs(a.judgeDeltaSec - jd) > 1e-6) problems.push(`judgeDeltaSec=${ms(a.judgeDeltaSec, 3)}ms ≠ input-judgeTick=${ms(jd, 3)}ms`);
      if (a.judgment !== judgmentOf(a.judgeDeltaSec)) problems.push(`judgment=${a.judgment} 與 |Δ|=${ms(Math.abs(a.judgeDeltaSec), 2)}ms 不符(應為 ${judgmentOf(a.judgeDeltaSec)})`);
      if (a.onBeat !== (a.judgment === 'perfect' || a.judgment === 'great')) problems.push(`onBeat=${a.onBeat} 與 judgment=${a.judgment} 不符`);
      const clamped = hasFlag && a.sfxClamped;
      if (clamped) nClamped++;
      if (a.rule === 'snap') {
        if (clamped) problems.push('rule=snap 但 sfxClamped=true');
        if (!(Math.abs(diff) <= 0.001)) problems.push(`snap：|scheduled-expected|=${ms(Math.abs(diff), 3)}ms > 1ms`);
        else schedErr.push(Math.abs(diff));
      } else if (a.rule === 'aimed') {
        if (clamped) {
          aimedClamped.push(diff);
          if (strict) problems.push('嚴格模式 aimed 不得 clamped');
          else if (!(diff >= -1e-9 && diff <= outLat + grace + 0.005)) problems.push(`aimed clamped 但 sched-expected=${ms(diff, 3)}ms 不在 [0, ${ms(outLat + grace + 0.005, 1)}ms]`);
        } else if (!(Math.abs(diff) <= 0.001)) problems.push(`aimed：|scheduled-expected|=${ms(Math.abs(diff), 3)}ms > 1ms`);
        else schedErr.push(Math.abs(diff));
      } else { // late
        if (clamped) {
          lateClamped.push(diff);
          if (strict) problems.push('嚴格模式不應有 late');
          else if (!(diff >= -1e-9 && diff <= outLat + grace + 0.005)) problems.push(`late clamped 但 sched-expected=${ms(diff, 3)}ms 不在 [0, ${ms(outLat + grace + 0.005, 1)}ms]`);
        } else if (!(Math.abs(diff) <= 0.001)) problems.push(`late(未 clamp)：|scheduled-expected|=${ms(Math.abs(diff), 3)}ms > 1ms`);
        else schedErr.push(Math.abs(diff));
        if (!(a.inputSongTime - a.connectSongTime > -1e-9 && a.inputSongTime - a.connectSongTime <= grace + 1e-6)) problems.push(`late 但 input-connect=${ms(a.inputSongTime - a.connectSongTime, 3)}ms 不在 (0, ${ms(grace, 1)}ms]`);
      }
      if (problems.length) bad.push(`#${a.id}(${a.rule}): ${problems.join(', ')}`);
    }
    const st = stats(schedErr);
    const nAimed = attacks.filter((a) => a.rule === 'aimed').length;
    c.check('B2', '音效排程：snap/aimed 未 clamp 且 ≤ 1 ms（aimed 的 clamp 僅在非嚴格模式容許並有上限）；late 可 clamp ≤ outputLatency+grace+5ms；判定窗口', attacks.length > 0 && bad.length === 0,
      `未 clamp ${schedErr.length} 次：|scheduled-expected| 平均 ${ms(st.mean, 4)} / max ${ms(st.max, 4)} ms；late clamped ${lateClamped.length}、aimed clamped ${aimedClamped.length}/${nAimed}（總 clamped ${nClamped}），outputLatency=${ms(outLat, 2)} ms${bad.length ? '；' + firstN(bad) : ''}`,
      { schedErrMaxMs: st.max * 1000, schedErrMeanMs: st.mean * 1000, lateClamped: lateClamped.length, aimedClamped: aimedClamped.length, nAimed, outputLatencyMs: outLat * 1000 });
    if (nMissingFlag) c.add('B2f', 'attack log 含 sfxClamped 欄位', 'FAIL', `${nMissingFlag} 筆缺少 sfxClamped`);
    if (aimedClamped.length) c.add('B2a', 'aimed 攻擊的音效 clamp（§11.3 期望 0）', 'WARN', `${aimedClamped.length}/${nAimed} 筆 aimed 被 clamp（最大 ${ms(Math.max(...aimedClamped), 2)} ms；原因：輸入時間為聽覺域，排程時鐘比輸入晚約 outputLatency）`);
  }

  // 2s. 嚴格模式
  if (strict) {
    const clamped = attacks.filter((a) => a.sfxClamped === true);
    const late = attacks.filter((a) => a.late === true);
    c.check('B2s', '嚴格模式：所有攻擊都不得 clamped、沒有 late 攻擊', attacks.length > 0 && clamped.length === 0 && late.length === 0,
      `攻擊 ${attacks.length} 次，sfxClamped=${clamped.length}，late=${late.length}${clamped.length ? '；' + firstN(clamped.map((a) => '#' + a.id)) : ''}`,
      { attacks: attacks.length, clamped: clamped.length, late: late.length });
  }

  // 2t. 排程領先量
  {
    const leads = []; const bad = []; let missing = 0;
    for (const a of attacks) {
      if (a.sfxClamped === true) continue;
      if (!Number.isFinite(a.ctxNowAtSchedule)) { missing++; continue; }
      const lead = a.scheduledAudioTime - a.ctxNowAtSchedule;
      leads.push(lead);
      if (!(lead >= -1e-9)) bad.push(`attack#${a.id}: lead=${ms(lead, 3)}ms < 0`);
    }
    const mleads = [];
    let mMissing = 0;
    for (const m of metro) {
      if (!Number.isFinite(m.ctxNowAtSchedule)) { mMissing++; continue; }
      const lead = m.scheduledAudioTime - m.ctxNowAtSchedule;
      mleads.push(lead);
      if (!(lead >= -1e-9)) bad.push(`click beat ${m.beatIndex}: lead=${ms(lead, 3)}ms < 0`);
    }
    const sa = stats(leads); const sm = stats(mleads);
    const detail = `未 clamp 攻擊 n=${leads.length}：最小領先 ${ms(sa.min, 2)} ms（p50 ${ms(sa.p50, 1)}）；節拍器 n=${mleads.length}：最小領先 ${ms(sm.min, 2)} ms（p50 ${ms(sm.p50, 1)}）${bad.length ? '；' + firstN(bad) : ''}`;
    const metrics = { attackMinLeadMs: sa.min * 1000, metroMinLeadMs: sm.min * 1000, nAttack: leads.length, nMetro: mleads.length };
    if (missing || mMissing || (!leads.length && !mleads.length)) c.add('B2t', 'scheduledAudioTime − ctxNowAtSchedule ≥ 0', 'WARN', `缺少 ctxNowAtSchedule 欄位（攻擊 ${missing} 筆、節拍器 ${mMissing} 筆）；${detail}`, metrics);
    else c.check('B2t', 'scheduledAudioTime − ctxNowAtSchedule ≥ 0（非 clamped 攻擊與節拍器）', bad.length === 0, detail, metrics);
  }

  // 3. 以 §3.2 參考實作重算每一擊；tick 嚴格遞增；pending ≤ 3；連段
  {
    const bad = []; const warn = [];
    let minTick = -Infinity; let prevTick = -Infinity;
    const comboExp = combosRef(attacks);
    let nMagnet = 0;
    for (let i = 0; i < attacks.length; i++) {
      const a = attacks[i];
      const ref = snapRef({ t: a.inputSongTime, s: a.schedNowSongTime, bpm, subdivision, lateGraceSec: grace, minTick, strict });
      const problems = [];
      if (ref.tick !== a.tick || ref.rule !== a.rule || ref.magnet !== !!a.magnet) {
        // 邊界（late 40 ms / aimWindow ± 0.02 ms）的浮點差異以 WARN 揭露
        const edge = Math.min(
          Math.abs((a.inputSongTime - Math.floor(a.inputSongTime / (ref.J * tickDur)) * ref.J * tickDur) - grace),
          Math.abs((Math.ceil(a.inputSongTime / (ref.J * tickDur)) * ref.J * tickDur - a.inputSongTime) - Math.min(0.09, ref.J * tickDur / 2)));
        const msg = `#${a.id}: input=${f(a.inputSongTime, 4)}s sched=${f(a.schedNowSongTime, 4)}s minTick=${minTick} 遊戲 tick=${a.tick}/${a.rule}/magnet=${a.magnet}，參考 tick=${ref.tick}/${ref.rule}/magnet=${ref.magnet}`;
        (edge < 2e-5 ? warn : bad).push(msg);
      }
      if (ref.judgment !== a.judgment) problems.push(`judgment=${a.judgment} 參考=${ref.judgment}`);
      if (a.magnet) nMagnet++;
      if (a.minTick !== undefined && a.minTick !== null && a.minTick !== minTick && Number.isFinite(minTick)) problems.push(`log.minTick=${a.minTick} 應為 ${minTick}`);
      if (!(a.tick > prevTick)) problems.push(`tick ${a.tick} 未嚴格遞增(前一個 ${prevTick})`);
      let pending = 0;
      for (let j = 0; j < i; j++) if (attacks[j].connectSongTime > a.inputSongTime + 0.05) pending++;
      if (pending >= 3) problems.push(`輸入當下已有 ${pending} 個未命中攻擊（上限 3，新的不應被接受）`);
      if ((a.combo ?? null) !== comboExp[i]) problems.push(`combo=${a.combo} 參考=${comboExp[i]}`);
      if (problems.length) bad.push(`#${a.id}: ${problems.join(', ')}`);
      prevTick = a.tick;
      minTick = Math.max(minTick, a.tick + 1);
    }
    const nCombo = comboExp.filter(Boolean).length;
    c.check('B3', 'tick/rule/magnet/judgment 與 §3.2 參考實作逐筆一致（含 minTick 佇列、嚴格遞增、≤3 pending、連段偵測）', attacks.length > 0 && bad.length === 0,
      `${attacks.length} 次攻擊逐一比對${bad.length ? '；' + firstN(bad) : '，全部一致'}；magnet ${nMagnet} 次；連段 ${nCombo} 次（${['eighth', 'bar', 'fill'].map((k) => `${k}=${comboExp.filter((x) => x === k).length}`).join(' ')}）${warn.length ? `；另有 ${warn.length} 筆落在邊界 ±0.02ms，略過` : ''}`,
      { nMagnet, nCombo });
  }

  // 4. impact 時機
  {
    const bad = []; const lags = []; const hitches = []; let unresolved = 0;
    const songNow = Number.isFinite(state.songTime) ? state.songTime : Infinity;
    for (const a of attacks) {
      if (a.impactSongTime == null) {
        if (a.connectSongTime < songNow - 0.15) bad.push(`#${a.id}: connect ${f(a.connectSongTime, 3)}s 已過但沒有 impactSongTime`);
        else unresolved++;
        continue;
      }
      const lag = a.impactSongTime - a.connectSongTime;
      lags.push(lag);
      if (lag > LAG && lag <= LAG + 0.020) hitches.push(`#${a.id}: ${ms(lag)}ms`); // headless 偶發掉幀（≤3 幀）
      else if (!(lag >= -1e-6 && lag <= LAG)) bad.push(`#${a.id}: impact−connect=${ms(lag)}ms 不在 [0,40ms]`);
    }
    // 無頭 Chromium 在高 BPM 連打時偶爾掉 2–3 幀（rAF 間隔 33–50 ms，已獨立量測）；容許 ≤ 15% 的攻擊落在 (40,60] ms，並以 WARN 揭露。
    if (hitches.length > Math.max(1, Math.floor(0.15 * lags.length))) bad.push(`掉幀離群值過多：${firstN(hitches)}`);
    const st = stats(lags);
    const within20 = lags.filter((l) => l <= 0.020 + 1e-6).length;
    c.check('B4', 'impact 延遲 0 ≤ impact−connect ≤ 40 ms（headless 容許）', lags.length > 0 && bad.length === 0,
      `n=${lags.length}：p50=${ms(st.p50)} p95=${ms(st.p95)} max=${ms(st.max)} ms；≤20ms 者 ${within20}/${lags.length}${unresolved ? `；${unresolved} 筆尚未命中（略過）` : ''}${bad.length ? '；' + firstN(bad) : ''}`,
      { p50Ms: st.p50 * 1000, p95Ms: st.p95 * 1000, maxMs: st.max * 1000, within20ms: within20, n: lags.length });
    if (hitches.length) c.add('B4h', 'impact 離群值（headless 掉幀）', 'WARN', `${hitches.length} 筆 impact−connect 介於 40–60 ms：${firstN(hitches)}（約 2–3 幀，非邏輯錯誤）`);
    if (lags.length && st.max > 0.020 + 1e-6 && st.max <= LAG) {
      c.add('B4b', 'impact 延遲 ≤ 20 ms（60 fps 一幀）', 'WARN', `max=${ms(st.max)} ms 超過 1 幀，但在 headless 容許範圍內`);
    } else if (lags.length) c.add('B4b', 'impact 延遲 ≤ 20 ms（60 fps 一幀）', 'PASS', `max=${ms(st.max)} ms`);
  }

  // 5. 拍點事件
  {
    const bad = []; const lags = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      const problems = [];
      if (i > 0 && b.beatIndex !== beats[i - 1].beatIndex + 1) problems.push(`beatIndex ${beats[i - 1].beatIndex}→${b.beatIndex} 漏拍或重複`);
      if (Math.abs(b.beatSongTime - b.beatIndex * beatDur) > 1e-6) problems.push(`beatSongTime=${f(b.beatSongTime, 6)} ≠ ${f(b.beatIndex * beatDur, 6)}`);
      const lag = b.firedSongTime - b.beatSongTime;
      lags.push(lag);
      if (!(lag >= -1e-6 && lag <= LAG)) problems.push(`延遲 ${ms(lag)}ms 不在 [0,40ms]`);
      if (b.beatInBar !== modInt(b.beatIndex, 4)) problems.push(`beatInBar=${b.beatInBar} 應為 ${modInt(b.beatIndex, 4)}`);
      if (b.barIndex !== Math.floor(b.beatIndex / 4)) problems.push(`barIndex=${b.barIndex} 應為 ${Math.floor(b.beatIndex / 4)}`);
      if (problems.length) bad.push(`beat ${b.beatIndex}: ${problems.join(', ')}`);
    }
    const st = stats(lags);
    const expected = Math.floor((cfg.bars || 4) * 4 * 0.8);
    c.check('B5', '拍點事件連續、拍/小節索引正確、延遲 ≤ 40 ms', beats.length >= expected && bad.length === 0,
      `n=${beats.length}（至少需 ${expected}），延遲 p50=${ms(st.p50)} p95=${ms(st.p95)} max=${ms(st.max)} ms${bad.length ? '；' + firstN(bad) : ''}`,
      { n: beats.length, lagP95Ms: st.p95 * 1000, lagMaxMs: st.max * 1000 });
  }

  // 6. 世界事件
  {
    if (world.length === 0) {
      c.add('B6', '世界事件只在規定拍點觸發', 'FAIL', '世界 log 為空（沒有任何 spawn / spike / 敵人事件）');
    } else {
      const bad = []; const unknown = new Set(); const lags = []; const counts = {};
      for (const w of world) {
        counts[w.kind] = (counts[w.kind] || 0) + 1;
        const problems = [];
        if (!(w.kind in WORLD_RULES)) { unknown.add(w.kind); continue; }
        const rule = WORLD_RULES[w.kind];
        if (modInt(w.beatIndex, 4) !== w.beatInBar) problems.push(`beatInBar=${w.beatInBar} 與 beatIndex=${w.beatIndex} 不一致`);
        if (rule && !rule.includes(w.beatInBar)) problems.push(`${w.kind} 出現在 beatInBar ${w.beatInBar}（允許 ${rule.join('/')}）`);
        if (Math.abs(w.beatSongTime - w.beatIndex * beatDur) > 1e-6) problems.push(`beatSongTime 不是 beatIndex×beatDur`);
        const lag = w.firedSongTime - w.beatSongTime;
        lags.push(lag);
        if (!(lag >= -1e-6 && lag <= LAG)) problems.push(`延遲 ${ms(lag)}ms 不在 [0,40ms]`);
        if (problems.length) bad.push(`${w.kind}#${w.entityId}@beat${w.beatIndex}: ${problems.join(', ')}`);
      }
      const st = stats(lags);
      c.check('B6', '世界事件只在規定拍點觸發（fever 只在 beatInBar 0；parry / enemy-stun 任意拍）、延遲 ≤ 40 ms', bad.length === 0,
        `n=${world.length}，延遲 max=${ms(st.max)} ms；各類：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}${bad.length ? '；' + firstN(bad) : ''}`,
        { counts, lagMaxMs: st.max * 1000 });
      if (unknown.size) c.add('B6u', '未知的世界事件種類', 'WARN', [...unknown].join(', '));
      if (!counts.spawn) c.add('B6s', '觀察到 spawn 事件', 'WARN', '稽核期間沒有 spawn 事件（無法驗證生怪鎖拍）');

      // 6f. fever 成對：start → end 剛好 8 拍後
      const fev = world.filter((w) => w.kind === 'fever-start' || w.kind === 'fever-end');
      const fbad = [];
      for (let i = 0; i < fev.length; i++) {
        if (fev[i].kind === 'fever-start') {
          const nx = fev[i + 1];
          if (nx) {
            if (nx.kind !== 'fever-end') fbad.push(`beat ${fev[i].beatIndex}: start 後面不是 end`);
            else if (nx.beatIndex - fev[i].beatIndex !== 8) fbad.push(`beat ${fev[i].beatIndex}→${nx.beatIndex}: 持續 ${nx.beatIndex - fev[i].beatIndex} 拍（應為 8）`);
          }
        } else if (i === 0 || fev[i - 1].kind !== 'fever-start') fbad.push(`beat ${fev[i].beatIndex}: end 沒有對應的 start`);
      }
      c.check('B6f', 'fever-start / fever-end 成對、相隔 8 拍、只在小節強拍', fbad.length === 0,
        `fever-start=${counts['fever-start'] || 0}，fever-end=${counts['fever-end'] || 0}${fbad.length ? '；' + firstN(fbad) : ''}${fev.length === 0 ? '（本輪沒有進入狂熱，僅驗證無誤報）' : ''}`);

      // 6p. 招架只在攻擊 tick == strikeTick（= beatIndex×8）時發生
      const parries = world.filter((w) => w.kind === 'parry');
      const pbad = [];
      for (const w of parries) {
        if (!attacks.some((a) => a.tick === w.beatIndex * 8)) pbad.push(`parry@beat${w.beatIndex}: 沒有 tick=${w.beatIndex * 8} 的攻擊`);
      }
      c.check('B6p', '招架只在有攻擊 tick 等於敵人出招 tick 時發生', pbad.length === 0, `parry=${parries.length}${pbad.length ? '；' + firstN(pbad) : ''}`);
    }
  }

  // 7. 節拍器
  {
    const bad = []; const errs = [];
    const b0 = state.beat0AudioTime;
    for (let i = 0; i < metro.length; i++) {
      const m = metro[i];
      const problems = [];
      if (i > 0 && m.beatIndex !== metro[i - 1].beatIndex + 1) problems.push(`beatIndex ${metro[i - 1].beatIndex}→${m.beatIndex} 漏拍或重複`);
      const e = Math.abs(m.scheduledAudioTime - m.expectedAudioTime);
      errs.push(e);
      if (!(e <= 0.001)) problems.push(`|scheduled-expected|=${ms(e, 3)}ms > 1ms`);
      if (Number.isFinite(b0)) {
        const e2 = Math.abs(m.expectedAudioTime - (b0 + m.beatIndex * beatDur));
        if (e2 > 1e-4) problems.push(`expected 與 beat0+n×beatDur 差 ${ms(e2, 3)}ms`);
      }
      if (problems.length) bad.push(`beat ${m.beatIndex}: ${problems.join(', ')}`);
    }
    const st = stats(errs);
    c.check('B7', '節拍器排程誤差 ≤ 1 ms 且連續', metro.length > 0 && bad.length === 0,
      `n=${metro.length}，|scheduled-expected| 平均 ${ms(st.mean, 4)} / max ${ms(st.max, 4)} ms${metro.length === 0 ? '；節拍器 log 為空' : ''}${bad.length ? '；' + firstN(bad) : ''}`,
      { n: metro.length, errMaxMs: st.max * 1000 });
  }

  // 8. console / page error
  c.check('B8', '無 console error / page error', errors.length === 0, errors.length ? firstN(errors, 4) : '乾淨');
  return c.items;
}

// ---------------------------------------------------------------------------
// Part B：瀏覽器驅動
// ---------------------------------------------------------------------------
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (e1) {
    try { return createRequire(path.join(process.cwd(), 'x.js'))('playwright'); } catch (e2) { return null; }
  }
}

const withTimeout = (p, msec, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`逾時(${msec}ms): ${label}`)), msec)),
]);

/** 在頁面內等到歌曲時間到達目標網格點才按（以 getState().songTime 計時，誤差約 1–2 ms）。 */
function pressSequenceInPage({ startGrid, offsetsTicks, jitterMs }) {
  const h = window.__BPM_SLASH_DEBUG__;
  const st0 = h.getState();
  const tickDur = 60 / st0.bpm / 8;
  const gridDur = startGrid * tickDur;
  const base = (Math.floor((st0.songTime + 0.18) / gridDur) + 1) * gridDur; // 下一個 startGrid 對齊點，至少 180 ms 之後
  const waitUntil = (t) => new Promise((resolve) => {
    const t0 = performance.now();
    const loop = () => {
      if (h.getState().songTime >= t || performance.now() - t0 > 4000) resolve();
      else setTimeout(loop, 1);
    };
    loop();
  });
  return (async () => {
    const pressed = [];
    for (let i = 0; i < offsetsTicks.length; i++) {
      const target = base + offsetsTicks[i] * tickDur + (jitterMs[i] || 0) / 1000;
      await waitUntil(target);
      const e = h.pressAttack();
      pressed.push(e ? e.id : null);
    }
    return pressed;
  })();
}

async function runConfig(browser, baseUrl, cfg, opts) {
  const result = { config: cfg, checks: [], data: null, fatal: null };
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/favicon/i.test(url) || /favicon/i.test(m.text())) return;
    errors.push(`console.error: ${m.text()}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const call = (name, ...args) => page.evaluate(async ({ name, args }) => {
    const h = window.__BPM_SLASH_DEBUG__;
    if (!h) throw new Error('window.__BPM_SLASH_DEBUG__ 不存在');
    if (typeof h[name] !== 'function') throw new Error(`__BPM_SLASH_DEBUG__.${name} 不是函式`);
    return await h[name](...args);
  }, { name, args });

  try {
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
    try {
      await page.waitForFunction(() => !!window.__BPM_SLASH_DEBUG__, null, { timeout: 15000 });
    } catch { throw new Error('頁面載入後 15 秒內沒有出現 window.__BPM_SLASH_DEBUG__'); }

    await call('setInvincible', true);
    await call('clearLogs');
    await withTimeout(call('start', { bpm: cfg.bpm, subdivision: cfg.subdivision ?? 'auto', lateGraceMs: cfg.lateGraceMs ?? 40 }), 30000, 'start()');
    const beatDur = 60 / cfg.bpm;

    // 等待進入 playing
    const t0 = Date.now();
    let scene = '';
    while (Date.now() - t0 < (4 * beatDur + 8) * 1000) {
      const st = await call('getState');
      scene = st.scene;
      if (scene === 'playing') break;
      if (scene === 'results' || scene === 'menu') throw new Error(`尚未進入 playing 場景就變成 ${scene}`);
      await sleep(60);
    }
    if (scene !== 'playing') throw new Error(`等不到 playing 場景（最後 scene=${scene}）`);

    // 機器人：準拍按鍵（用 songTime 對準）、隨機離拍按鍵、連打、整小節四拍 / 八分四連 / 過門連打
    const rnd = mulberry32(opts.seed + Math.round(cfg.bpm * 10) + (cfg.subdivision === 'auto' || cfg.subdivision === undefined ? 0 : 7 * Number(cfg.subdivision)) + (cfg.lateGraceMs === 0 ? 3 : 0));
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + opts.bars * 4 * beatDur * 1000;
    let pressCount = 0;
    const kinds = {};
    const note = (k, n = 1) => { kinds[k] = (kinds[k] || 0) + n; };
    const S = Math.max(1, cfg.expectStep || 2);
    const jit = (amp) => (rnd() * 2 - 1) * amp;
    const seq = async (startGrid, offsetsTicks, amp, tag) => {
      const jitterMs = offsetsTicks.map(() => jit(amp));
      const r = await withTimeout(page.evaluate(pressSequenceInPage, { startGrid, offsetsTicks, jitterMs }), 20000, tag);
      pressCount += offsetsTicks.length; note(tag, offsetsTicks.length);
      return r;
    };
    while (Date.now() < deadline) {
      const r = rnd();
      if (r < 0.28) { // 準拍單擊（後拍 / 十六分 / 正拍），含輕微抖動
        const g = [4, 8, 2, 16][Math.floor(rnd() * 4)];
        await seq(g, [0], 30, 'on-beat');
      } else if (r < 0.45) { // 隨機離拍單擊
        pressCount++; note('random');
        if (rnd() < 0.5) await page.keyboard.press('j'); else await call('pressAttack');
      } else if (r < 0.60) { // 連打
        const n = 3 + Math.floor(rnd() * 3);
        for (let i = 0; i < n && Date.now() < deadline; i++) {
          pressCount++; note('burst');
          if (rnd() < 0.5) await page.keyboard.press('j'); else await call('pressAttack');
          await sleep(25 + rnd() * 65);
        }
      } else if (r < 0.75) { await seq(32, [0, 8, 16, 24], 12, 'bar-run'); }
      else if (r < 0.88) { await seq(8, [0, 4, 8, 12], 12, 'eighth-run'); }
      else { await seq(32, [-3 * S, -2 * S, -S, 0], 8, 'fill-mash'); }
      await sleep(120 + rnd() * 500);
    }
    // 等最後的攻擊命中
    await sleep((2 * beatDur + 0.3) * 1000);

    const state = await call('getState');
    const attacks = await call('getAttackLog');
    const beats = await call('getBeatLog');
    const world = await call('getWorldLog');
    const metro = await call('getMetronomeLog');
    if (opts.shots) {
      try {
        fs.mkdirSync(opts.shots, { recursive: true });
        await page.screenshot({ path: path.join(opts.shots, `rhythm-${cfg.bpm}-${cfg.subdivision ?? 'auto'}${cfg.lateGraceMs === 0 ? '-strict' : ''}.png`) });
      } catch (e) { errors.push(`screenshot 失敗：${e.message}`); }
    }
    await call('stop').catch((e) => errors.push(`stop() 失敗：${e.message}`));
    result.data = { attacks, beats, world, metro, state, errors, pressCount };
    result.checks = analyzeRun({ ...result.data }, { ...cfg, bars: opts.bars });
    result.checks.unshift({ id: 'B-info', name: '輸入統計', status: 'INFO', detail: `按鍵 ${pressCount} 次（${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(' ')}），記錄到攻擊 ${attacks.length}、beat ${beats.length}、world ${world.length}、metronome ${metro.length}` });
  } catch (e) {
    result.fatal = e.message;
    result.checks = [{ id: 'B-fatal', name: '執行稽核', status: 'FAIL', detail: e.message }];
    if (errors.length) result.checks.push({ id: 'B8', name: '無 console error / page error', status: 'FAIL', detail: firstN(errors, 4) });
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------
// Part B 的離線渲染驗證（B9 / B9b / B10）：用 OfflineAudioContext 渲染遊戲自己的音效，量測真實發聲 onset 與響度
// ---------------------------------------------------------------------------
/** 在頁面內執行：每個變體各用獨立的 OfflineAudioContext 渲染（避免殘響互相污染），回傳樣本。 */
async function renderHitsInPage({ baseUrl }) {
  const mod = await import(new URL('js/audio/sfxVoices.js', baseUrl).href);
  const { SfxVoices } = mod;
  const LEVELS = mod.HIT_LEVELS || ['bar', 'half', 'beat', 'eighth', 'sixteenth', 'thirtysecond'];
  const SR = 44100;
  const variants = [];
  for (const level of LEVELS) for (const onBeat of [true, false]) variants.push({ name: `${level}/${onBeat ? 'on' : 'off'}`, desc: { level, onBeat, fever: false, combo: null, parry: false } });
  variants.push({ name: 'combo-fill', desc: { level: 'bar', onBeat: true, fever: false, combo: 'fill', parry: false } });
  variants.push({ name: 'combo-bar', desc: { level: 'beat', onBeat: true, fever: false, combo: 'bar', parry: false } });
  variants.push({ name: 'combo-eighth', desc: { level: 'eighth', onBeat: true, fever: false, combo: 'eighth', parry: false } });
  variants.push({ name: 'parry', desc: { level: 'beat', onBeat: true, fever: false, combo: null, parry: true } });
  variants.push({ name: 'fever/beat', desc: { level: 'beat', onBeat: false, fever: true, combo: null, parry: false } });
  variants.push({ name: 'click-accent', click: true, accent: true });
  variants.push({ name: 'click-normal', click: true, accent: false });
  const out = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const t = 0.1 + 0.00037 * (i + 1);
    const off = new OfflineAudioContext(1, Math.ceil(SR * (t + 1.0)), SR);
    const voices = new SfxVoices(off, { sfx: off.destination, click: off.destination });
    if (v.click) voices.click(t, v.accent); else voices.hit(v.desc, t);
    const buf = await off.startRendering();
    out.push({ name: v.name, t, samples: Array.from(buf.getChannelData(0)) });
  }
  return { sr: SR, levels: LEVELS, items: out };
}

/** B9b：預設曲 + 節拍器（beat0 = 0）。回傳 mix 與純音樂兩份渲染（click = mix − music）。 */
async function renderMixInPage({ baseUrl, bpm, offsetMs, seconds }) {
  const { SfxVoices } = await import(new URL('js/audio/sfxVoices.js', baseUrl).href);
  const resp = await fetch(new URL('assets/audio/default-88bpm.wav', baseUrl).href);
  const arr = await resp.arrayBuffer();
  const SR = 44100;
  const dec = await new OfflineAudioContext(1, 1, SR).decodeAudioData(arr);
  const beatDur = 60 / bpm;
  const nBeats = Math.floor(seconds / beatDur);
  const render = async (withClicks) => {
    const off = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const src = off.createBufferSource();
    src.buffer = dec; src.connect(off.destination);
    src.start(0 - offsetMs / 1000, offsetMs / 1000 > 0 ? 0 : 0); // beat0AudioTime=0 → source.start(beat0 - offset)
    if (withClicks) {
      const v = new SfxVoices(off, { sfx: off.destination, click: off.destination });
      for (let n = 0; n < nBeats; n++) v.click(n * beatDur, n % 4 === 0);
    }
    return Array.from((await off.startRendering()).getChannelData(0));
  };
  const mix = await render(true);
  const music = await render(false);
  return { sr: SR, bpm, nBeats, beatDur, mix, music };
}

/** 偵測 onset：視窗 [t−3ms, t+60ms]，第一個 |x| ≥ frac × 視窗峰值 的樣本時間。回傳秒。 */
export function detectOnset(x, sr, t, frac = 0.1, pre = 0.003, post = 0.06) {
  const i0 = Math.max(0, Math.floor((t - pre) * sr));
  const i1 = Math.min(x.length, Math.ceil((t + post) * sr));
  let peak = 0;
  for (let i = i0; i < i1; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak < 1e-4) return NaN;
  const thr = frac * peak;
  for (let i = i0; i < i1; i++) if (Math.abs(x[i]) >= thr) return i / sr;
  return NaN;
}

/** 前 windowSec 秒（自排定時間起）的 RMS。 */
function rmsFrom(x, sr, t, windowSec = 0.06) {
  const i0 = Math.max(0, Math.floor(t * sr));
  const i1 = Math.min(x.length, Math.floor((t + windowSec) * sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
}

async function runOfflineAudit(browser, baseUrl) {
  const checks = [];
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
    // B9 + B10
    let r = null;
    try { r = await page.evaluate(renderHitsInPage, { baseUrl }); } catch (e) {
      checks.push({ id: 'B9', name: 'SfxVoices#hit 離線渲染', status: 'FAIL', detail: `渲染失敗：${e.message}（sfxVoices.js 是否已提供 hit() 與 HIT_LEVELS？）` });
    }
    if (r) {
      const rows = r.items.map((e) => {
        const on = detectOnset(e.samples, r.sr, e.t);
        return { name: e.name, errMs: (on - e.t) * 1000, rms: rmsFrom(e.samples, r.sr, e.t) };
      });
      const bad = rows.filter((x) => !(Math.abs(x.errMs) <= 2));
      checks.push({
        id: 'B9', name: 'OfflineAudioContext 渲染：SfxVoices#hit 每個 level×{onBeat,off}、連段 fill/bar/eighth、招架、狂熱與節拍器 click 的真實 onset 與排定時間差 ≤ 2 ms（10% 峰值偵測）',
        status: bad.length === 0 ? 'PASS' : 'FAIL',
        detail: rows.map((x) => `${x.name}=${f(x.errMs, 3)}ms`).join('  ') + (bad.length ? `；超標：${bad.map((x) => x.name).join(',')}` : ''),
        metrics: { onsetErrMs: Object.fromEntries(rows.map((x) => [x.name, x.errMs])) },
      });

      // B10：響度順序（§4）
      const rms = Object.fromEntries(rows.map((x) => [x.name, x.rms]));
      const order = ['bar', 'half', 'beat', 'eighth', 'sixteenth', 'thirtysecond'];
      const problems = [];
      for (const side of ['on', 'off']) {
        for (let i = 0; i + 1 < order.length; i++) {
          const hi = rms[`${order[i]}/${side}`]; const lo = rms[`${order[i + 1]}/${side}`];
          const halfBeat = order[i] === 'half' && order[i + 1] === 'beat';
          const ok = halfBeat ? hi >= lo * 0.95 : hi > lo * 1.02;
          if (!ok) problems.push(`${order[i]}/${side}(${f(hi, 4)}) ${halfBeat ? '≥' : '>'} ${order[i + 1]}/${side}(${f(lo, 4)}) 不成立`);
        }
      }
      for (const lv of order) {
        const on = rms[`${lv}/on`]; const off = rms[`${lv}/off`];
        if (!(on > off)) problems.push(`${lv}: onBeat(${f(on, 4)}) 應大於 off(${f(off, 4)})`);
      }
      checks.push({
        id: 'B10', name: '響度順序（前 60 ms RMS）：bar > half ≥ beat > eighth > sixteenth > thirtysecond（half≥beat 容許 5%），且每個 level onBeat > off',
        status: problems.length === 0 ? 'PASS' : 'FAIL',
        detail: `onBeat：${order.map((l) => `${l}=${f(rms[`${l}/on`], 4)}`).join(' ')}；off：${order.map((l) => `${l}=${f(rms[`${l}/off`], 4)}`).join(' ')}${problems.length ? '；' + firstN(problems, 5) : ''}`,
        metrics: { rms },
      });
    }
    // B9b
    const bpm = 88;
    const m = await page.evaluate(renderMixInPage, { baseUrl, bpm, offsetMs: 0, seconds: 4.2 });
    const resid = new Float32Array(m.mix.length);
    for (let i = 0; i < resid.length; i++) resid[i] = m.mix[i] - m.music[i];
    const errs = [];
    for (let n = 0; n < m.nBeats; n++) errs.push((detectOnset(resid, m.sr, n * m.beatDur, 0.1, 0, 0.04) - n * m.beatDur) * 1000);
    const st = stats(errs.map((e) => Math.abs(e)));
    const mErrs = [];
    for (let n = 0; n < m.nBeats; n++) {
      const on = detectOnset(m.music, m.sr, n * m.beatDur, 0.1, 0, 0.03);
      if (Number.isFinite(on)) mErrs.push((on - n * m.beatDur) * 1000);
    }
    const ms2 = stats(mErrs.map((e) => Math.abs(e)));
    checks.push({
      id: 'B9b', name: '預設曲 + 節拍器（beat0=0, offset 0）混音渲染：每個 click onset 與排定拍點差 ≤ 2 ms（click = mix − music）',
      status: errs.length > 0 && errs.every((e) => Number.isFinite(e) && Math.abs(e) <= 2) ? 'PASS' : 'FAIL',
      detail: `${errs.length} 個 click：|onset−beat| 平均 ${f(st.mean, 3)} / max ${f(st.max, 3)} ms；同一時間線上的音樂拍點 onset（參考）：n=${mErrs.length} 平均 ${f(ms2.mean, 2)} / max ${f(ms2.max, 2)} ms`,
      metrics: { clickErrMaxMs: st.max, clickErrMeanMs: st.mean, musicOnsetMeanMs: ms2.mean },
    });
  } catch (e) {
    checks.push({ id: 'B9', name: '離線渲染驗證', status: 'FAIL', detail: e.message });
  } finally {
    await context.close().catch(() => {});
  }
  return { config: { bpm: 'n/a', subdivision: 'offline-render', lateGraceMs: '-' }, checks, data: null, fatal: null };
}

async function runBrowserPart(opts, baseUrl) {
  const pw = loadPlaywright();
  if (!pw) {
    return { status: 'SKIPPED', reason: '找不到 playwright。請執行：npm i -D playwright && npx playwright install chromium', configs: [] };
  }
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: !opts.headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  } catch (e) {
    return { status: 'SKIPPED', reason: `無法啟動 Chromium：${e.message.split('\n')[0]}（可試 npx playwright install chromium）`, configs: [] };
  }
  const matrix = opts.quick
    ? [{ bpm: 88 }, { bpm: 150 }, { bpm: 120, lateGraceMs: 0 }]
    : [{ bpm: 88 }, { bpm: 88, subdivision: 2 }, { bpm: 120 }, { bpm: 150 }, { bpm: 40 }, { bpm: 240 }, { bpm: 120, lateGraceMs: 0 }];
  const configs = [];
  try {
    for (const cfg of matrix.filter((c) => !opts.only || opts.only.includes(c.bpm))) {
      // 慢速曲（40 BPM）縮減小節數，但至少 2 小節；窗口上限約 24 秒
      const bars = Math.max(2, Math.min(opts.bars, Math.floor(24 / (4 * 60 / cfg.bpm))));
      const lg = cfg.lateGraceMs ?? 40;
      const full = { subdivision: 'auto', ...cfg, lateGraceMs: lg };
      full.expectStep = stepRef(full.subdivision, full.bpm);
      console.error(`… 執行 bpm=${full.bpm} subdivision=${full.subdivision}（stepTicks ${full.expectStep}）lateGraceMs=${lg}（${bars} 小節，約 ${Math.round(bars * 4 * 60 / cfg.bpm + 4 * 60 / cfg.bpm + 4)} 秒）`);
      configs.push(await runConfig(browser, baseUrl, full, { ...opts, bars }));
    }
    configs.push(await runOfflineAudit(browser, baseUrl));
  } finally {
    await browser.close().catch(() => {});
  }
  return { status: 'RAN', configs };
}

// ---------------------------------------------------------------------------
// 報告輸出
// ---------------------------------------------------------------------------
function printChecks(items, indent = '  ') {
  for (const it of items) {
    console.log(`${indent}[${it.status.padEnd(7)}] ${it.id} ${it.name}`);
    if (it.detail) console.log(`${indent}          ${it.detail}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(process.argv.includes('--help') || process.argv.includes('-h') ? 0 : 2); }

  const full = { startedAt: new Date().toISOString(), parts: {}, summary: {} };
  let anyFail = false;

  console.log('==================== BPM Slash 節奏對拍稽核 ====================');

  // Part A
  console.log('\n## Part A：預設曲 WAV 離線分析');
  if (opts.skipWav) {
    console.log('  [SKIPPED] 使用 --skip-wav');
    full.parts.wav = { status: 'SKIPPED', reason: '--skip-wav' };
  } else {
    try {
      const a = analyzeWav(opts);
      printChecks(a.checks);
      full.parts.wav = { status: a.checks.some((x) => x.status === 'FAIL') ? 'FAIL' : a.checks.every((x) => x.status === 'SKIPPED') ? 'SKIPPED' : 'PASS', checks: a.checks, report: a.report };
      if (a.checks.some((x) => x.status === 'FAIL')) anyFail = true;
    } catch (e) {
      console.log(`  [FAIL   ] A 分析時發生例外：${e.stack || e.message}`);
      full.parts.wav = { status: 'FAIL', error: e.message };
      anyFail = true;
    }
  }

  // Part B
  console.log('\n## Part B：遊戲執行期稽核（headless Chromium）');
  if (opts.skipBrowser) {
    console.log('  [SKIPPED] 使用 --skip-browser');
    full.parts.browser = { status: 'SKIPPED', reason: '--skip-browser' };
  } else {
    let server = null;
    let baseUrl = opts.url;
    try {
      if (!baseUrl) {
        try {
          const mod = await import(pathToFileURL(path.join(__dirname, 'serve.mjs')).href);
          server = await mod.startServer({ port: 0, root: REPO_ROOT });
          baseUrl = server.url;
          console.log(`  已啟動內建伺服器：${baseUrl}`);
        } catch (e) {
          console.log(`  [FAIL   ] 無法載入或啟動 tools/serve.mjs：${e.message}`);
          full.parts.browser = { status: 'FAIL', error: `server: ${e.message}` };
          anyFail = true;
        }
      }
      if (baseUrl) {
        const b = await runBrowserPart(opts, baseUrl);
        if (b.status === 'SKIPPED') {
          console.log(`  [SKIPPED] ${b.reason}`);
          full.parts.browser = { status: 'SKIPPED', reason: b.reason };
        } else {
          let partFail = false;
          for (const r of b.configs) {
            const cfgFail = r.checks.some((x) => x.status === 'FAIL');
            if (cfgFail) partFail = true;
            console.log(`\n### bpm=${r.config.bpm}  subdivision=${r.config.subdivision}  grace=${r.config.lateGraceMs}ms  → ${cfgFail ? 'FAIL' : 'PASS'}`);
            printChecks(r.checks);
          }
          full.parts.browser = {
            status: partFail ? 'FAIL' : 'PASS',
            configs: b.configs.map((r) => ({ config: r.config, status: r.checks.some((x) => x.status === 'FAIL') ? 'FAIL' : 'PASS', checks: r.checks, counts: r.data ? { attacks: r.data.attacks.length, beats: r.data.beats.length, world: r.data.world.length, metronome: r.data.metro.length, presses: r.data.pressCount } : null, fatal: r.fatal })),
          };
          if (partFail) anyFail = true;
        }
      }
    } finally {
      if (server) await Promise.resolve(server.close()).catch(() => {});
    }
  }

  // 總結
  console.log('\n==================== 總結 ====================');
  for (const [k, v] of Object.entries(full.parts)) {
    console.log(`  ${k === 'wav' ? 'Part A (WAV)' : 'Part B (browser)'}: ${v.status}${v.reason ? ` — ${v.reason}` : ''}`);
    if (v.configs) for (const c of v.configs) console.log(`      bpm=${c.config.bpm} 切分=${c.config.subdivision}${c.config.expectStep ? `(step ${c.config.expectStep})` : ''} grace=${c.config.lateGraceMs}: ${c.status}`);
  }
  full.summary = { result: anyFail ? 'FAIL' : 'PASS', exitCode: anyFail ? 1 : 0 };
  console.log(`  結果：${anyFail ? 'FAIL（有失敗項目）' : 'PASS（沒有 FAIL）'}`);

  if (opts.json) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
      fs.writeFileSync(opts.json, JSON.stringify(full, null, 2));
      console.log(`  JSON 報告：${path.resolve(opts.json)}`);
    } catch (e) { console.log(`  無法寫入 JSON：${e.message}`); }
  }
  process.exit(anyFail ? 1 : 0);
}

// 只有直接執行時才跑 main（方便被測試 import）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('稽核工具內部錯誤：', e); process.exit(2); });
}
