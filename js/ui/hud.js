// Canvas HUD (DESIGN section 8): beat track, hearts, score, chain, BPM, bar:beat, progress, count-in.
import { W, H, FONT, COLORS } from '../game/constants.js';
import { beatInfoAt, pulseAt, formatBarBeat } from '../core/beatMath.js';
import { chainMultiplier } from '../core/comboTracker.js';
import { LEVEL_NAMES, LEVEL_COLORS, COMBO_NAMES } from '../game/disco.js';

const JUDGE_WORD = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', off: 'OFF', auto: 'AUTO' };
const JUDGE_COL = { perfect: '#ffe45e', great: '#5cf2ff', good: '#7dff9a', off: '#a6a1c4', auto: '#a6a1c4' };
const LEVEL_W = { bar: 5, half: 4, beat: 3, eighth: 2, sixteenth: 1, thirtysecond: 0 };
let lastJudge = null; // { id, vst, ... } newest attack seen in the queue (for the readout panel)

/** Normalise an attack queue entry (v2 fields, with v1 fallbacks). */
function attackInfo(a) {
  const q = a.q || {};
  const level = a.level || (q.isDownbeat ? 'bar' : q.half === 'front' ? 'beat' : q.half === 'back' ? 'eighth' : 'beat');
  const judgment = a.judgment || q.judgment || 'good';
  let combo = a.combo && typeof a.combo === 'string' ? a.combo : null;
  if (!combo && a.combo && typeof a.combo === 'object') combo = a.combo.finisher ? 'bar' : a.combo.eighth ? 'eighth' : null;
  if (!combo && a.kind === 'finisher') combo = 'bar';
  if (!combo && a.kind === 'combo8') combo = 'eighth';
  if (!combo && a.kind === 'fill') combo = 'fill';
  return {
    id: a.id, level, judgment, onBeat: a.onBeat ?? (judgment === 'perfect' || judgment === 'great'),
    combo, t: a.connectSongTime ?? a.slotSongTime ?? 0, parry: !!a.parry,
  };
}

/** Connect-grid step in ticks (spec 3.1) when the game does not expose it. */
function stepTicksOf(game, bd) {
  const direct = game.combat && game.combat.stepTicks;
  if (direct) return direct;
  const sub = game.settings && game.settings.subdivision;
  if (sub === 1 || sub === 2 || sub === 4 || sub === 8) return 8 / sub;
  let d = 1;
  for (const c of [2, 4, 8]) if (bd / c >= 0.11) d = c;
  return 8 / d;
}

function rainbow(t, off = 0, l = 62) { return `hsl(${((t * 80 + off) % 360 + 360) % 360},100%,${l}%)`; }

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.35);
  ctx.bezierCurveTo(x - s, y - s * 0.3, x - s * 0.55, y - s * 0.95, x, y - s * 0.4);
  ctx.bezierCurveTo(x + s * 0.55, y - s * 0.95, x + s, y - s * 0.3, x, y + s * 0.35 + s * 0.45);
  ctx.closePath();
}

function drawSwordIcon(ctx, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(-6, 6); ctx.lineTo(6, -7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-6, -1); ctx.lineTo(1, 6); ctx.stroke();
  ctx.restore();
}

function text(ctx, str, x, y, { size = 16, color = COLORS.ink, align = 'left', weight = 700, stroke = true } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  if (stroke) { ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,2,28,0.85)'; ctx.lineJoin = 'round'; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

export function drawHud(ctx, game, cond, vst, scene, song) {
  const bpm = cond.bpm;
  const bd = cond.beatDur;
  const hs = cond.halfStep;
  const b = beatInfoAt(vst, bpm);
  const pulse = pulseAt(b.beatPhase, b.beatInBar);

  ctx.save();

  // ---- top-left: hearts / score / chain ----
  const p = game.player;
  for (let i = 0; i < p.maxHp; i++) {
    const x = 28 + i * 30;
    heartPath(ctx, x, 30, 11);
    if (i < p.hp) {
      ctx.fillStyle = '#ff4d8d'; ctx.shadowColor = '#ff4d8d'; ctx.shadowBlur = 10 + 8 * pulse; ctx.fill();
    } else {
      ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,120,170,0.4)'; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  const combo = game.combo;
  text(ctx, String(Math.floor(combo.score)).padStart(7, '0'), 16, 74, { size: 26, color: '#ffffff', weight: 800 });
  text(ctx, 'SCORE', 16, 92, { size: 11, color: '#b9a7ff', weight: 700 });
  if (combo.chain > 0) {
    const k = 1 + 0.18 * game.hudPulse;
    ctx.save(); ctx.translate(16, 122); ctx.scale(k, k);
    text(ctx, `CHAIN ${combo.chain}`, 0, 0, { size: 22, color: combo.chain >= 10 ? COLORS.down : COLORS.great, weight: 800 });
    ctx.restore();
    text(ctx, `×${chainMultiplier(combo.chain).toFixed(1)}`, 16, 142, { size: 13, color: '#b9a7ff' });
  }

  // ---- fever meter (below chain) ----
  const fv = game.fever || { value: 0, armed: false, active: false, endsAtBeat: 0 };
  {
    const fx = 16, fy = combo.chain > 0 ? 154 : 108, fw = 150, fh = 10;
    ctx.fillStyle = 'rgba(8,2,28,0.6)'; ctx.beginPath(); ctx.roundRect(fx - 2, fy - 2, fw + 4, fh + 4, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 4); ctx.fill();
    const v = Math.min(1, Math.max(0, fv.value || 0));
    if (v > 0.002 || fv.active) {
      const g2 = ctx.createLinearGradient(fx, 0, fx + fw, 0);
      if (fv.active) { for (let i = 0; i <= 4; i++) g2.addColorStop(i / 4, rainbow(vst, i * 60)); }
      else { g2.addColorStop(0, '#4df3ff'); g2.addColorStop(0.6, '#ff4fd8'); g2.addColorStop(1, '#ffd24d'); }
      ctx.fillStyle = g2; ctx.shadowColor = fv.armed || fv.active ? '#ffd24d' : '#ff4fd8'; ctx.shadowBlur = fv.armed || fv.active ? 12 + 8 * pulse : 5;
      ctx.beginPath(); ctx.roundRect(fx, fy, Math.max(6, fw * (fv.active ? 1 : v)), fh, 4); ctx.fill();
      ctx.shadowBlur = 0;
    }
    text(ctx, 'FEVER', fx, fy + 26, { size: 11, color: fv.active || fv.armed ? '#ffd24d' : '#b9a7ff', weight: 800 });
  }
  if (fv.active) {
    const left = Math.max(0, (fv.endsAtBeat ?? 0) - b.beatFloat);
    const k = 1 + 0.12 * pulse;
    ctx.save(); ctx.translate(W / 2, 136); ctx.scale(k, k);
    ctx.textAlign = 'center'; ctx.font = `900 34px ${FONT}`;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(8,2,28,0.9)'; ctx.lineJoin = 'round';
    ctx.strokeText('FEVER ×2', 0, 0);
    ctx.fillStyle = rainbow(vst, 0); ctx.shadowColor = rainbow(vst, 120); ctx.shadowBlur = 18;
    ctx.fillText('FEVER ×2', 0, 0);
    ctx.restore();
    if (fv.endsAtBeat) {
      const bw = 140; ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(W / 2 - bw / 2, 146, bw, 4);
      ctx.fillStyle = rainbow(vst, 200); ctx.fillRect(W / 2 - bw / 2, 146, bw * Math.min(1, left / 8), 4);
    }
  } else if (fv.armed) {
    const blink = 0.55 + 0.45 * Math.sin(b.beatFloat * Math.PI * 2);
    ctx.save(); ctx.globalAlpha = blink;
    text(ctx, 'FEVER 待命', W / 2, 130, { size: 26, color: '#ffd24d', align: 'center', weight: 900 });
    text(ctx, '下一小節開始', W / 2, 150, { size: 13, color: '#ffe9a8', align: 'center', weight: 700 });
    ctx.restore();
  }

  // ---- top-right: BPM, bar:beat, song, progress ----
  const bb = formatBarBeat(b.beatIndex);
  text(ctx, `${bpm % 1 === 0 ? bpm : bpm.toFixed(1)} BPM`, W - 16, 30, { size: 22, color: COLORS.front, align: 'right', weight: 800 });
  text(ctx, bb.countIn ? '預備' : `小節 ${bb.bar} : ${bb.beat}`, W - 16, 54, { size: 18, color: '#ffffff', align: 'right' });
  text(ctx, song || '', W - 16, 76, { size: 12, color: '#b9a7ff', align: 'right', weight: 600 });
  const pw = 220, px = W - 16 - pw, py = 86;
  const prog = Math.min(1, Math.max(0, (vst) / Math.max(1, game.endSongTime)));
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(px, py, pw, 5);
  const pg = ctx.createLinearGradient(px, 0, px + pw, 0);
  pg.addColorStop(0, COLORS.front); pg.addColorStop(1, COLORS.back);
  ctx.fillStyle = pg; ctx.fillRect(px, py, pw * prog, 5);

  // ---- beat track ----
  const cx = W / 2, cy = H - 56, half = 270;
  ctx.fillStyle = 'rgba(8,2,28,0.55)';
  ctx.beginPath(); ctx.roundRect(cx - half - 24, cy - 40, (half + 24) * 2, 80, 14); ctx.fill();
  ctx.strokeStyle = 'rgba(160,120,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.strokeStyle = 'rgba(160,120,255,0.3)';
  ctx.beginPath(); ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy); ctx.stroke();

  const span = 2 * bd;
  const tickDur = bd / 8;
  const step = stepTicksOf(game, bd);
  const kmin = Math.ceil((vst - 0.1) / tickDur / step) * step;
  const kmax = Math.floor((vst + span) / tickDur);
  for (let k = kmin; k <= kmax; k += step) {
    const delta = k * tickDur - vst;
    const off = (delta / span) * half;
    const m = ((k % 32) + 32) % 32;
    const lv = m === 0 ? 'bar' : m % 16 === 0 ? 'half' : m % 8 === 0 ? 'beat' : m % 4 === 0 ? 'eighth' : m % 2 === 0 ? 'sixteenth' : 'thirtysecond';
    const w5 = LEVEL_W[lv];
    const h = [8, 11, 15, 26, 36, 46][w5], w = [2, 2, 3, 4, 6, 8][w5];
    const color = lv === 'bar' ? COLORS.down : w5 >= 3 ? COLORS.front : lv === 'eighth' ? COLORS.back : '#8f86b8';
    let alpha = Math.min(1, (span - delta) / 0.3);
    if (delta < 0) alpha *= Math.max(0, 1 + delta / 0.1);
    alpha *= Math.min(1, Math.max(0, (Math.abs(off) - 16) / 22)); // fade out under the centre ring
    if (w5 < 2) alpha *= 0.7;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = w5 >= 4 ? 14 : w5 >= 2 ? 8 : 0;
    for (const sgn of [-1, 1]) ctx.fillRect(cx + sgn * off - w / 2, cy - h / 2, w, h);
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // queued attacks at their exact connect time (sword icon + line down to the track)
  const queue = (game.combat && game.combat.queue) || [];
  for (const a of queue) {
    if (a.state !== 'pending') continue;
    const ai = attackInfo(a);
    const delta = ai.t - vst;
    if (delta > span) continue;
    const off = (delta / span) * half;
    const col = LEVEL_COLORS[ai.level] || COLORS.front;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
    for (const sgn of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(cx + sgn * off, cy - 30); ctx.lineTo(cx + sgn * off, cy + 14); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const sgn of [-1, 1]) drawSwordIcon(ctx, cx + sgn * off, cy - 38, col);
  }

  // centre ring
  const ringR = 20 + 9 * pulse;
  const ringCol = b.beatInBar === 0 ? COLORS.down : COLORS.front;
  ctx.strokeStyle = ringCol; ctx.shadowColor = ringCol; ctx.shadowBlur = 12 + 14 * pulse;
  ctx.lineWidth = 3 + 2 * pulse;
  ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.stroke();
  // half-beat ring (back beat) flicker
  const halfPhase = (vst / hs) - Math.floor(vst / hs);
  if (Math.floor(vst / hs) % 2 !== 0) {
    ctx.strokeStyle = COLORS.back; ctx.shadowColor = COLORS.back; ctx.globalAlpha = Math.exp(-halfPhase * 6) * 0.8;
    ctx.beginPath(); ctx.arc(cx, cy, 14 + 6 * Math.exp(-halfPhase * 6), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.shadowBlur = 0;
  // legend
  text(ctx, '正拍', cx - half - 6, cy + 34, { size: 11, color: COLORS.front, align: 'left', weight: 600, stroke: false });
  text(ctx, '後拍', cx - half + 38, cy + 34, { size: 11, color: COLORS.back, align: 'left', weight: 600, stroke: false });
  text(ctx, '強拍', cx - half + 82, cy + 34, { size: 11, color: COLORS.down, align: 'left', weight: 600, stroke: false });

  // ---- judgment readout (bottom-left): row 1 準拍/離拍 + judgment, row 2 level name, row 3 combo name ----
  for (const a of queue) {
    if (a.state === 'cancelled') continue;
    if (!lastJudge || a.id > lastJudge.id || vst < lastJudge.vst - 1) {
      if (!lastJudge || a.id !== lastJudge.id) lastJudge = { ...attackInfo(a), vst };
    }
  }
  if (lastJudge && vst - lastJudge.vst < 1.1) {
    const k = (vst - lastJudge.vst) / 1.1;
    const pop = 1 + 0.25 * Math.exp(-k * 14);
    ctx.save(); ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    const jx = 16, jy = H - 84;
    ctx.save(); ctx.translate(jx, jy); ctx.scale(pop, pop);
    const jc = lastJudge.onBeat ? JUDGE_COL[lastJudge.judgment] : '#a6a1c4';
    text(ctx, `${lastJudge.onBeat ? '準拍' : '離拍'} ${JUDGE_WORD[lastJudge.judgment] || ''}`, 0, 0, { size: 22, color: jc, weight: 900 });
    ctx.restore();
    text(ctx, LEVEL_NAMES[lastJudge.level] || '', jx, jy + 22, { size: 16, color: LEVEL_COLORS[lastJudge.level] || '#fff', weight: 800 });
    if (lastJudge.parry) text(ctx, '招架', jx + 78, jy + 22, { size: 16, color: '#ffe45e', weight: 800 });
    if (lastJudge.combo && COMBO_NAMES[lastJudge.combo]) text(ctx, COMBO_NAMES[lastJudge.combo], jx, jy + 44, { size: 16, color: '#ff9fe8', weight: 800 });
    ctx.restore();
  }

  // ---- count-in / GO ----
  if (scene === 'countin' || vst < bd * 1.2) {
    ctx.save();
    ctx.textAlign = 'center';
    if (vst < 0 && b.beatIndex >= -4) {
      const n = b.beatIndex + 5; // 1..4
      const s = 1 + 0.5 * Math.exp(-b.beatPhase * 6);
      ctx.font = `900 ${Math.round(120 * s)}px ${FONT}`;
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(8,2,28,0.8)'; ctx.fillStyle = n === 4 ? COLORS.down : COLORS.front;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 30;
      ctx.strokeText(String(n), W / 2, 270); ctx.fillText(String(n), W / 2, 270);
      ctx.shadowBlur = 0;
      let row = '';
      for (let i = 1; i <= 4; i++) row += (i <= n ? '●' : '○') + ' ';
      text(ctx, row.trim(), W / 2, 318, { size: 22, color: '#ffffff', align: 'center' });
      text(ctx, '← → 移動　J / K / 空白鍵 攻擊（對準節拍軌！）', W / 2, 352, { size: 15, color: '#b9a7ff', align: 'center' });
    } else if (vst >= 0 && vst < bd * 1.2) {
      const k = vst / (bd * 1.2);
      ctx.globalAlpha = 1 - k * k;
      const s = 1 + 0.25 * (1 - k);
      ctx.font = `900 ${Math.round(110 * s)}px ${FONT}`;
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(8,2,28,0.8)'; ctx.fillStyle = COLORS.perfect;
      ctx.shadowColor = COLORS.perfect; ctx.shadowBlur = 36;
      ctx.strokeText('GO!', W / 2, 270); ctx.fillText('GO!', W / 2, 270);
    }
    ctx.restore();
  }

  ctx.restore();
}
