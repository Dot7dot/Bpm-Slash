// 歌曲地圖（DESIGN-BEATSNAP §8）。純函式：不碰 DOM / Web Audio，可在瀏覽器與 Node 22 執行。
//
// 演算法概要：
//   1. 依 bpm 與 beatsPerBar 切成小節；第 k 小節涵蓋 [offsetSec + k·barDur, offsetSec + (k+1)·barDur)。
//      offsetSec 之前的音訊忽略；最後一個（不完整的）小節也計入。
//   2. 每小節取 RMS，換算為 dB（下限 -100 dB，避免 log(0)）。
//   3. 以「本小節與下一小節」的 2 小節平均平滑（最後一小節保持原值）。向前看可讓段落邊界落在變化開始的那一小節。
//   4. 線性正規化到 0..1（min → 0，max → 1）。
//   5. 以分位數分級：≤ 第 33 百分位 → 'low'，≥ 第 67 百分位 → 'high'，其餘 'mid'。
//   6. 由相同強度的連續小節組成段落；長度不足 2 小節者併入前一段（第一段則併入後一段），
//      併入後若相鄰段落強度相同則合併。
//
// barIntensity 為逐小節的原始分級；sections 為合併後的段落（遊戲以 sections 為準）。
// 輸入無效、靜音、或不足 2 小節時回傳 { bars: 0, barEnergy: [], barIntensity: [], sections: [] }，不拋例外。

const SILENCE_RMS = 1e-4; // 約 -80 dBFS：整段低於此視為靜音
const DB_FLOOR_RMS = 1e-5; // 約 -100 dBFS：dB 計算下限
const MIN_BARS = 2;
const MIN_SECTION_BARS = 2;
const LOW_Q = 0.33;
const HIGH_Q = 0.67;

function emptyResult() {
  return { bars: 0, barEnergy: [], barIntensity: [], sections: [] };
}

// 線性插值分位數（values 須已排序、非空）。
function quantile(sorted, p) {
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 依強度把逐小節分級切成段落（連續相同強度為一段）。
function runsOf(intensity) {
  const runs = [];
  for (let k = 0; k < intensity.length; k++) {
    const last = runs[runs.length - 1];
    if (last && last.intensity === intensity[k]) last.endBar = k + 1;
    else runs.push({ startBar: k, endBar: k + 1, intensity: intensity[k] });
  }
  return runs;
}

// 合併過短段落，並合併相鄰的同強度段落。
function mergeShortSections(runs) {
  let list = runs.map((r) => ({ ...r }));
  const coalesce = (arr) => {
    const out = [];
    for (const r of arr) {
      const last = out[out.length - 1];
      if (last && last.intensity === r.intensity && last.endBar === r.startBar) {
        last.endBar = r.endBar;
      } else out.push({ ...r });
    }
    return out;
  };
  list = coalesce(list);
  for (;;) {
    if (list.length <= 1) break;
    const idx = list.findIndex((s) => s.endBar - s.startBar < MIN_SECTION_BARS);
    if (idx < 0) break;
    if (idx > 0) {
      list[idx - 1].endBar = list[idx].endBar;
      list.splice(idx, 1);
    } else {
      list[1].startBar = list[0].startBar;
      list.splice(0, 1);
    }
    list = coalesce(list);
  }
  return list;
}

/**
 * @param {Float32Array|number[]} samples 單聲道取樣
 * @param {number} sampleRate 取樣率（Hz）
 * @param {{bpm: number, offsetSec?: number, beatsPerBar?: number}} opts
 */
export function analyzeSongMap(samples, sampleRate, { bpm, offsetSec = 0, beatsPerBar = 4 } = {}) {
  if (!samples || typeof samples.length !== 'number' || samples.length === 0) return emptyResult();
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) return emptyResult();
  if (!(Number.isFinite(bpm) && bpm > 0)) return emptyResult();
  const bpb = Number.isFinite(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
  const offset = Number.isFinite(offsetSec) ? offsetSec : 0;
  const barDur = (bpb * 60) / bpm;
  const len = samples.length;
  const sampleAt = (sec) => Math.round(sec * sampleRate);

  // 逐小節 RMS；小節數以「起點取樣仍在音訊內」決定（含結尾不完整小節）。
  const rms = [];
  let peakRms = 0;
  for (let k = 0; ; k++) {
    const s0 = sampleAt(offset + k * barDur);
    if (s0 >= len) break;
    const s1 = Math.min(len, sampleAt(offset + (k + 1) * barDur));
    const from = Math.max(0, s0);
    let sum = 0;
    for (let i = from; i < s1; i++) {
      const v = samples[i];
      sum += v * v;
    }
    const count = Math.max(1, s1 - from);
    let r = Math.sqrt(sum / count);
    if (!Number.isFinite(r)) r = 0;
    rms.push(r);
    if (r > peakRms) peakRms = r;
  }

  const bars = rms.length;
  if (bars < MIN_BARS || peakRms < SILENCE_RMS) return emptyResult();

  // dB → 2 小節平均（第 0 小節保持原值）
  const db = rms.map((r) => 20 * Math.log10(Math.max(r, DB_FLOOR_RMS)));
  const smooth = new Array(bars);
  for (let k = 0; k < bars - 1; k++) smooth[k] = (db[k] + db[k + 1]) / 2;
  smooth[bars - 1] = db[bars - 1];

  // 正規化到 0..1
  let min = Infinity;
  let max = -Infinity;
  for (const v of smooth) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const barEnergy = range > 1e-9 ? smooth.map((v) => (v - min) / range) : smooth.map(() => 0.5);

  // 分位數分級；完全平坦的音訊全部視為 mid
  let barIntensity;
  if (range > 1e-9) {
    const sorted = [...barEnergy].sort((a, b) => a - b);
    const qLow = quantile(sorted, LOW_Q);
    const qHigh = quantile(sorted, HIGH_Q);
    barIntensity = barEnergy.map((v) => (v <= qLow ? 'low' : v >= qHigh ? 'high' : 'mid'));
  } else {
    barIntensity = barEnergy.map(() => 'mid');
  }

  const sections = mergeShortSections(runsOf(barIntensity)).map((s) => ({
    startBar: s.startBar,
    endBar: s.endBar,
    intensity: s.intensity,
  }));

  return { bars, barEnergy, barIntensity, sections };
}
