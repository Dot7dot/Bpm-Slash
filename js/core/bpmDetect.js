// 自動 BPM 偵測（DESIGN §9.3）。純函式：不碰 DOM / Web Audio，可在瀏覽器與 Node 22 執行。
//
// 演算法概要：
//   1. 取前 maxAnalyzeSec 秒，以 10 ms hop 計算能量包絡（平方均值 + 一階差分能量，略強調高頻）。
//   2. 對數壓縮後取正向差分得到 onset strength，減去局部平均後再以高斯平滑（sigma ≈ 1.5 frame）。
//   3. 梳狀差分（comb difference）粗搜尋：對每個候選週期，取「格點上的平均 onset」減去
//      「格點中點上的平均 onset」，並對第一拍相位取最大。中點項可抑制半速（漏掉奇數拍）與
//      倍速（多出的格點落在空白處）的誤判。格點以四捨五入到最近 frame 計算，避免內插模糊。
//      搜尋範圍預設 60–200 BPM，並加上以 120 BPM 為中心的弱先驗。
//   4. 在粗搜尋結果附近（±0.6 BPM，0.02 步進）做 BPM 與相位的聯合精細搜尋。
//   5. 將 BPM 折疊到 [minBpm, maxBpm]；offsetSec 為第一拍位置，範圍 [0, beatDur)。
//   6. confidence = 1 − 次佳峰值 / 最佳峰值（次佳峰排除最佳值附近 ±6%）。
//
// 無法偵測（靜音、太短、無 onset）時回傳 { bpm: 0, confidence: 0, offsetSec: 0 }，不拋例外。

const HOP_SEC = 0.01;
const MIN_ANALYZE_SEC = 2;
const SCAN_MIN_BPM = 60;
const SCAN_MAX_BPM = 200;
const SCAN_STEP = 0.1;
const SCAN_PHASE_STEP = 0.5;
const REFINE_RANGE = 0.6;
const REFINE_STEP = 0.02;
const REFINE_PHASE_STEP = 0.25;
const PRIOR_CENTER_BPM = 120;
const PRIOR_SIGMA_OCT = 1.5;
const LOG_COMPRESS = 1000;
const LOCAL_MEAN_SEC = 0.5;
const GAUSS_SIGMA_FRAMES = 1.5;
const MIDPOINT_WEIGHT = 0.5;

function zeroResult() {
  return { bpm: 0, confidence: 0, offsetSec: 0 };
}

function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// 一維高斯平滑（邊界鏡射），回傳新陣列。
function gaussianSmooth(arr, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let ksum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    ksum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= ksum;
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      let j = i + k;
      if (j < 0) j = -j;
      if (j >= n) j = 2 * (n - 1) - j;
      if (j < 0) j = 0;
      s += arr[j] * kernel[k + radius];
    }
    out[i] = s;
  }
  return out;
}

// 梳狀差分分數。period 單位為 frame（可為小數），格點以四捨五入取值。
// 回傳最佳分數與對應相位（frame，範圍 [0, period)）。
function combDifference(od, nFrames, period, phaseStep) {
  let best = -Infinity;
  let bestPhase = 0;
  for (let phase = 0; phase < period; phase += phaseStep) {
    let on = 0;
    let onN = 0;
    let off = 0;
    let offN = 0;
    for (let k = 0; ; k++) {
      const g = phase + k * period;
      const gi = Math.round(g);
      if (gi >= nFrames) break;
      on += od[gi];
      onN++;
      const mi = Math.round(g + period / 2);
      if (mi < nFrames) {
        off += od[mi];
        offN++;
      }
    }
    if (onN === 0) continue;
    const s = on / onN - MIDPOINT_WEIGHT * (offN > 0 ? off / offN : 0);
    if (s > best) {
      best = s;
      bestPhase = phase;
    }
  }
  return { score: best, phase: bestPhase };
}

export function detectBpm(samples, sampleRate, opts = {}) {
  if (!samples || !samples.length || !(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    return zeroResult();
  }
  const o = opts || {};
  const minBpm = finiteOr(o.minBpm, 70);
  const maxBpm = finiteOr(o.maxBpm, 180);
  const maxAnalyzeSec = finiteOr(o.maxAnalyzeSec, 60);
  if (!(minBpm > 0) || !(maxBpm >= minBpm) || !(maxAnalyzeSec > 0)) return zeroResult();

  const nSamp = Math.min(samples.length, Math.floor(maxAnalyzeSec * sampleRate));
  if (nSamp < MIN_ANALYZE_SEC * sampleRate) return zeroResult();

  // ---- 1. 能量包絡 ----
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const frameRate = sampleRate / hop;
  const nFrames = Math.floor(nSamp / hop);
  if (nFrames < 8) return zeroResult();

  const env = new Float64Array(nFrames);
  let envMax = 0;
  for (let f = 0; f < nFrames; f++) {
    let acc = 0;
    const start = f * hop;
    const end = start + hop;
    for (let i = start; i < end; i++) {
      const x = Number(samples[i]) || 0;
      const xPrev = i > 0 ? Number(samples[i - 1]) || 0 : x;
      const d = x - xPrev;
      acc += x * x + d * d;
    }
    const e = acc / hop;
    env[f] = e;
    if (e > envMax) envMax = e;
  }
  if (!(envMax > 1e-12)) return zeroResult(); // 靜音

  // ---- 2. onset strength：對數壓縮 → 正向差分 → 減去局部平均 → 平滑 ----
  const logE = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    logE[f] = Math.log1p(LOG_COMPRESS * (env[f] / envMax));
  }
  const diff = new Float64Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    const v = logE[f] - logE[f - 1];
    diff[f] = v > 0 ? v : 0;
  }
  const cum = new Float64Array(nFrames + 1);
  for (let f = 0; f < nFrames; f++) cum[f + 1] = cum[f] + diff[f];
  const half = Math.max(1, Math.round(LOCAL_MEAN_SEC * frameRate));
  const raw = new Float64Array(nFrames);
  let odEnergy = 0;
  for (let f = 0; f < nFrames; f++) {
    const lo = Math.max(0, f - half);
    const hi = Math.min(nFrames, f + half + 1);
    const localMean = (cum[hi] - cum[lo]) / (hi - lo);
    const v = diff[f] - localMean;
    if (v > 0) {
      raw[f] = v;
      odEnergy += v * v;
    }
  }
  if (!(odEnergy > 1e-12)) return zeroResult(); // 沒有明顯 onset（例如純音）
  const od = gaussianSmooth(raw, GAUSS_SIGMA_FRAMES);

  // ---- 3. 粗搜尋：梳狀差分 + 弱先驗 ----
  const prior = (bpm) => {
    const z = (Math.log2(bpm) - Math.log2(PRIOR_CENTER_BPM)) / PRIOR_SIGMA_OCT;
    return Math.exp(-0.5 * z * z);
  };
  const scanLo = Math.min(SCAN_MIN_BPM, minBpm);
  const scanHi = Math.max(SCAN_MAX_BPM, maxBpm);
  const scanN = Math.floor((scanHi - scanLo) / SCAN_STEP + 1e-9);
  const scanBpm = new Float64Array(scanN + 1);
  const scanScore = new Float64Array(scanN + 1);
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i <= scanN; i++) {
    const bpm = scanLo + i * SCAN_STEP;
    const period = (60 * frameRate) / bpm;
    const { score } = combDifference(od, nFrames, period, SCAN_PHASE_STEP);
    const s = Math.max(0, score) * prior(bpm);
    scanBpm[i] = bpm;
    scanScore[i] = s;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || !(bestScore > 0)) return zeroResult();

  // 次佳峰：排除最佳值附近 ±6% 的範圍，作為信心度的比較基準。
  const coarseBpm = scanBpm[bestIdx];
  let secondScore = 0;
  for (let i = 0; i <= scanN; i++) {
    if (Math.abs(scanBpm[i] - coarseBpm) / coarseBpm <= 0.06) continue;
    if (scanScore[i] > secondScore) secondScore = scanScore[i];
  }

  // ---- 4. 精細搜尋：BPM 與第一拍相位聯合搜尋 ----
  let refBpm = coarseBpm;
  let refPhase = 0;
  let refScore = -Infinity;
  const rLo = Math.max(SCAN_MIN_BPM / 2, coarseBpm - REFINE_RANGE);
  const rHi = coarseBpm + REFINE_RANGE;
  const rN = Math.floor((rHi - rLo) / REFINE_STEP + 1e-9);
  for (let i = 0; i <= rN; i++) {
    const bpm = rLo + i * REFINE_STEP;
    const period = (60 * frameRate) / bpm;
    const { score, phase } = combDifference(od, nFrames, period, REFINE_PHASE_STEP);
    if (score > refScore) {
      refScore = score;
      refBpm = bpm;
      refPhase = phase;
    }
  }

  // ---- 5. 折疊到 [minBpm, maxBpm] ----
  let bpm = refBpm;
  while (bpm < minBpm) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;

  // ---- 6. 輸出 bpm（0.1 精度）與 offsetSec（第一拍位置，範圍 [0, 60 / bpm)） ----
  const bpmOut = Math.round(bpm * 10) / 10;
  if (!(bpmOut > 0) || !Number.isFinite(bpmOut)) return zeroResult();
  const beatDur = 60 / bpmOut;
  let offsetSec = (refPhase + 0.5) / frameRate;
  offsetSec = ((offsetSec % beatDur) + beatDur) % beatDur;
  if (offsetSec >= beatDur - 1e-9) offsetSec = 0; // 浮點邊界：等同於下一拍的起點

  // ---- 7. 信心度 ----
  const confidence = Math.max(0, Math.min(1, 1 - secondScore / bestScore));

  return {
    bpm: bpmOut,
    confidence: Math.round(confidence * 1000) / 1000,
    offsetSec,
  };
}
