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
//         攻擊量化、拍點事件、世界事件、節拍器（DESIGN.md §6 §7 §10 §11）。
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
    json: null, quick: false, shots: null, bars: 4, seed: 20240607, headed: false, help: false,
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
  --quick           Part B 只跑 88 half、120 half、120 strict
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
// Part B：§6.1 量化演算法（獨立再實作）
// ---------------------------------------------------------------------------
export function quantizeRef({ inputSongTime, bpm, mode = 'half', lateGraceSec = 0.04, minSlotIndex = -Infinity }) {
  const halfStep = 30 / bpm;
  const step = mode === 'beat' ? 2 : 1;
  const fl = Math.floor(inputSongTime / halfStep + 1e-9);
  const prev = mode === 'beat' ? fl - (((fl % 2) + 2) % 2) : fl;
  const next = prev + step;
  let chosen; let late = false;
  if (inputSongTime - prev * halfStep <= lateGraceSec && prev >= minSlotIndex) { chosen = prev; late = true; } else chosen = next;
  if (chosen < minSlotIndex) {
    chosen = mode === 'beat' ? minSlotIndex + (((minSlotIndex % 2) + 2) % 2) : minSlotIndex;
    late = false;
  }
  const slotSongTime = chosen * halfStep;
  const deltaSec = inputSongTime - slotSongTime;
  const a = Math.abs(deltaSec);
  const judgment = a <= 0.045 + 1e-9 ? 'perfect' : a <= 0.09 + 1e-9 ? 'great' : a <= 0.14 + 1e-9 ? 'good' : 'auto';
  const beatIndex = Math.floor(chosen / 2);
  const beatInBar = ((beatIndex % 4) + 4) % 4;
  return { slotIndex: chosen, slotSongTime, half: chosen % 2 === 0 ? 'front' : 'back', beatIndex, beatInBar, isDownbeat: chosen % 2 === 0 && beatInBar === 0, deltaSec, judgment, late };
}

quantizeRef.judgmentOf = (delta) => {
  const a = Math.abs(delta);
  return a <= 0.045 + 1e-9 ? 'perfect' : a <= 0.09 + 1e-9 ? 'great' : a <= 0.14 + 1e-9 ? 'good' : 'auto';
};

// §7 世界事件允許的 beatInBar
const WORLD_RULES = {
  'spike-telegraph': [2], 'spike-up': [3], 'spike-down': [0], spawn: [0],
  'bat-telegraph': [2], 'bat-swoop': [3],
  'guard-step': [0, 2], 'guard-telegraph': [2], 'guard-strike': [3],
  'slime-hop': [0, 1, 2, 3],
};

const modInt = (a, n) => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// Part B：單一設定的分析（純資料，方便離線測試）
// ---------------------------------------------------------------------------
export function analyzeRun(data, cfg) {
  const c = new Checks();
  const bpm = cfg.bpm;
  const beatDur = 60 / bpm;
  const halfStep = beatDur / 2;
  const grace = (cfg.lateGraceMs ?? 40) / 1000;
  const { attacks = [], beats = [], world = [], metro = [], state = {}, errors = [] } = data;
  const LAG = 0.040;
  const strict = grace === 0;

  // 0. 設定是否生效
  if (state && Number.isFinite(state.bpm)) {
    c.check('B0', '設定已套用（bpm / 量化模式）', Math.abs(state.bpm - bpm) < 1e-6 && (!state.quantizeMode || state.quantizeMode === cfg.quantizeMode),
      `state.bpm=${state.bpm}，quantizeMode=${state.quantizeMode}，lateGraceMs=${state.lateGraceMs}`);
  }

  // 1. slot 對齊半拍
  {
    const bad = [];
    let maxErr = 0;
    for (const a of attacks) {
      const err = Math.abs(a.slotSongTime - a.slotIndex * halfStep);
      const mult = a.slotSongTime / halfStep;
      const errMult = Math.abs(mult - Math.round(mult)) * halfStep;
      maxErr = Math.max(maxErr, err, errMult);
      const problems = [];
      if (!(err < 1e-6) || !(errMult < 1e-6)) problems.push(`slotSongTime 非 halfStep 整數倍(${ms(Math.max(err, errMult), 4)}ms)`);
      if (!Number.isInteger(a.slotIndex)) problems.push('slotIndex 非整數');
      if (cfg.quantizeMode === 'beat' && modInt(a.slotIndex, 2) !== 0) problems.push('beat 模式出現奇數 slot');
      const expHalf = modInt(a.slotIndex, 2) === 0 ? 'front' : 'back';
      if (a.half !== expHalf) problems.push(`half=${a.half} 應為 ${expHalf}`);
      const beatIndex = Math.floor(a.slotIndex / 2);
      const expDown = expHalf === 'front' && modInt(beatIndex, 4) === 0;
      if (!!a.isDownbeat !== expDown) problems.push(`isDownbeat=${a.isDownbeat} 應為 ${expDown}`);
      if (problems.length) bad.push(`#${a.id}(slot ${a.slotIndex}): ${problems.join(', ')}`);
    }
    c.check('B1', '攻擊 slot 為半拍整數倍、模式/half/isDownbeat 正確', attacks.length > 0 && bad.length === 0,
      attacks.length === 0 ? '攻擊 log 為空（沒有任何攻擊被記錄）' : `共 ${attacks.length} 次，最大誤差 ${ms(maxErr, 6)} ms${bad.length ? '；' + firstN(bad) : ''}`);
  }

  // 2. 排程時間與 late / delta / 判定
  {
    const bad = []; const schedErr = []; const clampedErr = [];
    let nLate = 0; let nClamped = 0; let nNonLate = 0; let nMissingFlag = 0;
    const outLat = Number.isFinite(state && state.outputLatency) ? state.outputLatency : 0;
    for (const a of attacks) {
      const problems = [];
      const d = a.inputSongTime - a.slotSongTime;
      if (Math.abs(a.deltaSec - d) > 1e-6) problems.push(`deltaSec=${ms(a.deltaSec, 3)}ms ≠ input-slot=${ms(d, 3)}ms`);
      const diff = a.scheduledAudioTime - a.expectedAudioTime;
      const hasFlag = typeof a.sfxClamped === 'boolean';
      if (!hasFlag) nMissingFlag++;
      if (a.late) {
        nLate++;
        if (!(a.deltaSec > -1e-9 && a.deltaSec <= grace + 1e-6)) problems.push(`late 但 deltaSec=${ms(a.deltaSec, 3)}ms 不在 (0, ${ms(grace, 1)}ms]`);
      } else {
        nNonLate++;
        if (a.deltaSec > 1e-6) problems.push(`非 late 但 deltaSec=${ms(a.deltaSec, 3)}ms > 0`);
        if (hasFlag && a.sfxClamped) {
          nClamped++;
          clampedErr.push(diff);
          const lim = outLat + grace + 0.005;
          if (!(diff >= -1e-9 && diff <= lim)) problems.push(`sfxClamped 但 sched-expected=${ms(diff, 3)}ms 不在 [0, ${ms(lim, 1)}ms]`);
        } else {
          const e = Math.abs(diff);
          schedErr.push(e);
          if (!(e <= 0.001)) problems.push(`|scheduled-expected|=${ms(e, 3)}ms > 1ms`);
        }
      }
      if (a.judgment !== quantizeRef.judgmentOf(a.deltaSec)) problems.push(`judgment=${a.judgment} 與 |delta|=${ms(Math.abs(a.deltaSec), 2)}ms 不符(應為 ${quantizeRef.judgmentOf(a.deltaSec)})`);
      if (problems.length) bad.push(`#${a.id}: ${problems.join(', ')}`);
    }
    const st = stats(schedErr);
    const clampShare = nNonLate ? nClamped / nNonLate : 0;
    c.check('B2', '音效排程誤差（未 clamp ≤ 1 ms；clamped ≤ outputLatency+grace+5ms）、late 條件、delta、判定窗口', attacks.length > 0 && bad.length === 0,
      `未 clamp ${schedErr.length} 次：|scheduled-expected| 平均 ${ms(st.mean, 4)} / max ${ms(st.max, 4)} ms；clamped ${nClamped}/${nNonLate} 次（${(clampShare * 100).toFixed(1)}%），outputLatency=${ms(outLat, 2)} ms；late ${nLate} 次${bad.length ? '；' + firstN(bad) : ''}`,
      { schedErrMaxMs: st.max * 1000, schedErrMeanMs: st.mean * 1000, nLate, nClamped, clampedShare: clampShare, outputLatencyMs: outLat * 1000 });
    if (nMissingFlag) c.add('B2f', 'attack log 含 sfxClamped 欄位', 'WARN', `${nMissingFlag} 筆缺少 sfxClamped，以舊規則（≤1 ms）檢查（缺欄位者一律視為未 clamp）`);
    if (clampShare > 0.25) c.add('B2c', 'sfxClamped 比例偏高', 'WARN', `非 late 攻擊中 ${(clampShare * 100).toFixed(1)}% 被 clamp（> 25%）`);
  }

  // 2s. 嚴格模式：不得 clamp、不得 late（§5.2 / §11.8）
  if (strict) {
    const clamped = attacks.filter((a) => a.sfxClamped === true);
    const late = attacks.filter((a) => a.late === true);
    c.check('B2s', '嚴格模式：sfxClamped 永遠為 false、沒有 late 攻擊', attacks.length > 0 && clamped.length === 0 && late.length === 0,
      `攻擊 ${attacks.length} 次，sfxClamped=${clamped.length}，late=${late.length}${clamped.length ? '；' + firstN(clamped.map((a) => '#' + a.id)) : ''}`,
      { attacks: attacks.length, clamped: clamped.length, late: late.length });
  }

  // 2t. 排程領先量：scheduledAudioTime − ctxNowAtSchedule ≥ 0（排在未來 → Web Audio 取樣精準播放）
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

  // 3. slot 選擇正確性（重跑 §6.1）與佇列
  {
    const bad = []; const warn = [];
    let minSlot = -Infinity; let prevSlot = -Infinity;
    for (let i = 0; i < attacks.length; i++) {
      const a = attacks[i];
      const ref = quantizeRef({ inputSongTime: a.inputSongTime, bpm, mode: cfg.quantizeMode, lateGraceSec: grace, minSlotIndex: minSlot });
      if (strict && a.slotIndex > ref.slotIndex && !a.late) {
        // 嚴格模式：為了保證音效不被 clamp，slot 可以比純量化結果更晚（§5.2），由 B2s/B2t 驗證其排程。
      } else if (ref.slotIndex !== a.slotIndex) {
        const edge = Math.abs((a.inputSongTime - Math.floor(a.inputSongTime / halfStep) * halfStep) - grace);
        const msg = `#${a.id}: input=${f(a.inputSongTime, 4)}s 遊戲 slot=${a.slotIndex}，參考 slot=${ref.slotIndex}(minSlot=${minSlot})`;
        (edge < 2e-5 ? warn : bad).push(msg);
      } else if (ref.late !== !!a.late && Math.abs(a.deltaSec) > 1e-6) {
        bad.push(`#${a.id}: late=${a.late} 參考=${ref.late}`);
      }
      if (!(a.slotIndex > prevSlot)) bad.push(`#${a.id}: slot ${a.slotIndex} 未嚴格遞增(前一個 ${prevSlot})`);
      // 同時未命中的數量（取 slot 時間在輸入之後 50 ms 以上者，避免邊界誤判）
      let pending = 0;
      for (let j = 0; j < i; j++) if (attacks[j].slotSongTime > a.inputSongTime + 0.05) pending++;
      if (pending >= 2) bad.push(`#${a.id}: 輸入當下已有 ${pending} 個未命中攻擊（上限 2，含新的應 ≤ 1 個舊的）`);
      prevSlot = a.slotIndex;
      minSlot = Math.max(minSlot, a.slotIndex + 1);
    }
    c.check('B3', 'slot 選擇符合 §6.1（含 minSlotIndex 佇列、嚴格遞增、同 slot 不重複、≤2 pending）', attacks.length > 0 && bad.length === 0,
      `${attacks.length} 次攻擊逐一比對${bad.length ? '；' + firstN(bad) : '，全部一致'}${warn.length ? `（另有 ${warn.length} 筆落在 late 邊界 ±0.02ms，略過）` : ''}`);
  }

  // 4. impact 時機
  {
    const bad = []; const lags = []; let unresolved = 0;
    const songNow = Number.isFinite(state.songTime) ? state.songTime : Infinity;
    for (const a of attacks) {
      if (a.impactSongTime == null) {
        if (a.slotSongTime < songNow - 0.15) bad.push(`#${a.id}: slot ${f(a.slotSongTime, 3)}s 已過但沒有 impactSongTime`);
        else unresolved++;
        continue;
      }
      const lag = a.impactSongTime - a.slotSongTime;
      lags.push(lag);
      if (!(lag >= -1e-6 && lag <= LAG)) bad.push(`#${a.id}: impact−slot=${ms(lag)}ms 不在 [0,40ms]`);
    }
    const st = stats(lags);
    const within20 = lags.filter((l) => l <= 0.020 + 1e-6).length;
    c.check('B4', 'impact 延遲 0 ≤ impact−slot ≤ 40 ms（headless 容許）', lags.length > 0 && bad.length === 0,
      `n=${lags.length}：p50=${ms(st.p50)} p95=${ms(st.p95)} max=${ms(st.max)} ms；≤20ms 者 ${within20}/${lags.length}${unresolved ? `；${unresolved} 筆尚未命中（略過）` : ''}${bad.length ? '；' + firstN(bad) : ''}`,
      { p50Ms: st.p50 * 1000, p95Ms: st.p95 * 1000, maxMs: st.max * 1000, within20ms: within20, n: lags.length });
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
        const rule = WORLD_RULES[w.kind];
        if (!rule) { unknown.add(w.kind); continue; }
        if (modInt(w.beatIndex, 4) !== w.beatInBar) problems.push(`beatInBar=${w.beatInBar} 與 beatIndex=${w.beatIndex} 不一致`);
        if (!rule.includes(w.beatInBar)) problems.push(`${w.kind} 出現在 beatInBar ${w.beatInBar}（允許 ${rule.join('/')}）`);
        if (Math.abs(w.beatSongTime - w.beatIndex * beatDur) > 1e-6) problems.push(`beatSongTime 不是 beatIndex×beatDur`);
        const lag = w.firedSongTime - w.beatSongTime;
        lags.push(lag);
        if (!(lag >= -1e-6 && lag <= LAG)) problems.push(`延遲 ${ms(lag)}ms 不在 [0,40ms]`);
        if (problems.length) bad.push(`${w.kind}#${w.entityId}@beat${w.beatIndex}: ${problems.join(', ')}`);
      }
      const st = stats(lags);
      c.check('B6', '世界事件只在規定拍點觸發、延遲 ≤ 40 ms', bad.length === 0,
        `n=${world.length}，延遲 max=${ms(st.max)} ms；各類：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}${bad.length ? '；' + firstN(bad) : ''}`,
        { counts, lagMaxMs: st.max * 1000 });
      if (unknown.size) c.add('B6u', '未知的世界事件種類', 'WARN', [...unknown].join(', '));
      if (!counts.spawn) c.add('B6s', '觀察到 spawn 事件', 'WARN', '稽核期間沒有 spawn 事件（無法驗證生怪鎖拍）');
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
    await withTimeout(call('start', { bpm: cfg.bpm, quantizeMode: cfg.quantizeMode, lateGraceMs: cfg.lateGraceMs ?? 40 }), 30000, 'start()');
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

    // 產生攻擊按鍵（種子 PRNG；真實鍵盤 + pressAttack 交替；含連發）
    const rnd = mulberry32(opts.seed + Math.round(cfg.bpm * 10) + (cfg.quantizeMode === 'beat' ? 7 : 0));
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + opts.bars * 4 * beatDur * 1000;
    let pressCount = 0;
    const press = async () => {
      pressCount++;
      if (rnd() < 0.5) await page.keyboard.press('j');
      else await call('pressAttack');
    };
    while (Date.now() < deadline) {
      if (rnd() < 0.3) {
        const n = 3 + Math.floor(rnd() * 3);
        for (let i = 0; i < n && Date.now() < deadline; i++) { await press(); await sleep(25 + rnd() * 65); }
      } else {
        await press();
      }
      await sleep(80 + rnd() * 520);
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
        await page.screenshot({ path: path.join(opts.shots, `rhythm-${cfg.bpm}-${cfg.quantizeMode}.png`) });
      } catch (e) { errors.push(`screenshot 失敗：${e.message}`); }
    }
    await call('stop').catch((e) => errors.push(`stop() 失敗：${e.message}`));
    result.data = { attacks, beats, world, metro, state, errors, pressCount };
    result.checks = analyzeRun({ ...result.data }, { ...cfg, bars: opts.bars });
    result.checks.unshift({ id: 'B-info', name: '輸入統計', status: 'INFO', detail: `按鍵 ${pressCount} 次，記錄到攻擊 ${attacks.length}、beat ${beats.length}、world ${world.length}、metronome ${metro.length}` });
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
// Part B 的離線渲染驗證（B9 / B9b）：用 OfflineAudioContext 渲染遊戲自己的音效，量測真實發聲 onset
// ---------------------------------------------------------------------------
/** 在頁面內執行：渲染各攻擊種類與 click，回傳原始樣本供 Node 端偵測 onset。 */
async function renderSfxInPage({ baseUrl }) {
  const { SfxVoices } = await import(new URL('js/audio/sfxVoices.js', baseUrl).href);
  const SR = 44100;
  const kinds = ['front', 'down', 'back', 'combo8', 'finisher', 'click-accent', 'click-normal'];
  const t0 = 0.5; const gap = 0.7;
  const off = new OfflineAudioContext(1, Math.ceil(SR * (t0 + gap * kinds.length + 0.5)), SR);
  const v = new SfxVoices(off, { sfx: off.destination, click: off.destination });
  const events = kinds.map((k, i) => ({ kind: k, t: t0 + gap * i + 0.00037 * (i + 1) }));
  for (const e of events) {
    if (e.kind === 'click-accent') v.click(e.t, true);
    else if (e.kind === 'click-normal') v.click(e.t, false);
    else v.attack(e.kind, e.t);
  }
  const buf = await off.startRendering();
  return { sr: SR, events, samples: Array.from(buf.getChannelData(0)) };
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

async function runOfflineAudit(browser, baseUrl) {
  const checks = [];
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
    // B9
    const r = await page.evaluate(renderSfxInPage, { baseUrl });
    const rows = r.events.map((e) => {
      const on = detectOnset(r.samples, r.sr, e.t);
      return { kind: e.kind, errMs: (on - e.t) * 1000 };
    });
    const bad = rows.filter((x) => !(Math.abs(x.errMs) <= 2));
    checks.push({
      id: 'B9', name: 'OfflineAudioContext 渲染：各攻擊音效與節拍器 click 的真實 onset 與排定時間差 ≤ 2 ms（10% 峰值偵測）',
      status: bad.length === 0 ? 'PASS' : 'FAIL',
      detail: rows.map((x) => `${x.kind}=${f(x.errMs, 3)}ms`).join('  ') + (bad.length ? `；超標：${bad.map((x) => x.kind).join(',')}` : ''),
      metrics: { onsetErrMs: Object.fromEntries(rows.map((x) => [x.kind, x.errMs])) },
    });
    // B9b
    const bpm = 88;
    const m = await page.evaluate(renderMixInPage, { baseUrl, bpm, offsetMs: 0, seconds: 4.2 });
    const resid = new Float32Array(m.mix.length);
    for (let i = 0; i < resid.length; i++) resid[i] = m.mix[i] - m.music[i];
    const errs = [];
    for (let n = 0; n < m.nBeats; n++) errs.push((detectOnset(resid, m.sr, n * m.beatDur, 0.1, 0, 0.04) - n * m.beatDur) * 1000);
    const st = stats(errs.map((e) => Math.abs(e)));
    // 音樂本身：鼓的 onset 與 beat 網格（混音內，beat0=0）— 取每一拍視窗內的第一個 10% 峰值樣本
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
  return { config: { bpm: 'n/a', quantizeMode: 'offline-render', lateGraceMs: '-' }, checks, data: null, fatal: null };
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
    ? [{ bpm: 88, quantizeMode: 'half' }, { bpm: 120, quantizeMode: 'half' }, { bpm: 120, quantizeMode: 'half', lateGraceMs: 0 }]
    : [{ bpm: 88, quantizeMode: 'half' }, { bpm: 88, quantizeMode: 'beat' }, { bpm: 72.5, quantizeMode: 'half' }, { bpm: 120, quantizeMode: 'half' }, { bpm: 150, quantizeMode: 'half' },
      { bpm: 40, quantizeMode: 'half' }, { bpm: 240, quantizeMode: 'half' }, { bpm: 120, quantizeMode: 'half', lateGraceMs: 0 }];
  const configs = [];
  try {
    for (const cfg of matrix) {
      // 慢速曲（40 BPM）縮減小節數，但至少 2 小節；窗口上限約 24 秒
      const bars = Math.max(2, Math.min(opts.bars, Math.floor(24 / (4 * 60 / cfg.bpm))));
      const lg = cfg.lateGraceMs ?? 40;
      console.error(`… 執行 bpm=${cfg.bpm} mode=${cfg.quantizeMode} lateGraceMs=${lg}（${bars} 小節，約 ${Math.round(bars * 4 * 60 / cfg.bpm + 4 * 60 / cfg.bpm + 4)} 秒）`);
      configs.push(await runConfig(browser, baseUrl, { ...cfg, lateGraceMs: lg }, { ...opts, bars }));
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
            console.log(`\n### bpm=${r.config.bpm}  mode=${r.config.quantizeMode}  grace=${r.config.lateGraceMs}ms  → ${cfgFail ? 'FAIL' : 'PASS'}`);
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
    if (v.configs) for (const c of v.configs) console.log(`      bpm=${c.config.bpm} ${c.config.quantizeMode} grace=${c.config.lateGraceMs}: ${c.status}`);
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
