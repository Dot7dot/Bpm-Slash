// Canvas HUD (DESIGN section 8): beat track, hearts, score, chain, BPM, bar:beat, progress, count-in.
import { W, H, FONT, COLORS } from '../game/constants.js';
import { beatInfoAt, pulseAt, formatBarBeat } from '../core/beatMath.js';
import { chainMultiplier } from '../core/comboTracker.js';

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
  const kmin = Math.ceil((vst - 0.1) / hs);
  const kmax = Math.floor((vst + span) / hs);
  const beatMode = game.settings.quantizeMode === 'beat';
  for (let k = kmin; k <= kmax; k++) {
    const delta = k * hs - vst;
    const off = (delta / span) * half;
    const isFront = k % 2 === 0;
    const isDown = ((k % 8) + 8) % 8 === 0;
    let h = 20, w = 4, color = COLORS.back;
    if (isDown) { h = 46; w = 8; color = COLORS.down; }
    else if (isFront) { h = 32; w = 6; color = COLORS.front; }
    let alpha = Math.min(1, (span - delta) / 0.3);
    if (delta < 0) alpha *= Math.max(0, 1 + delta / 0.1);
    if (!isFront && beatMode) alpha *= 0.25;
    alpha *= Math.min(1, Math.max(0, (Math.abs(off) - 16) / 22)); // fade out under the centre ring
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = isDown ? 14 : 8;
    for (const sgn of [-1, 1]) ctx.fillRect(cx + sgn * off - w / 2, cy - h / 2, w, h);
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // queued attack markers (sword icons at the scheduled slot)
  for (const a of game.combat.queue) {
    if (a.state !== 'pending') continue;
    const delta = a.slotSongTime - vst;
    if (delta > span) continue;
    const off = (delta / span) * half;
    const col = a.q.isDownbeat ? COLORS.down : a.q.half === 'front' ? COLORS.front : COLORS.back;
    for (const sgn of [-1, 1]) drawSwordIcon(ctx, cx + sgn * off, cy - 36, col);
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
  text(ctx, '前拍', cx - half - 6, cy + 34, { size: 11, color: COLORS.front, align: 'left', weight: 600, stroke: false });
  text(ctx, '後拍', cx - half + 38, cy + 34, { size: 11, color: COLORS.back, align: 'left', weight: 600, stroke: false });
  text(ctx, '強拍', cx - half + 82, cy + 34, { size: 11, color: COLORS.down, align: 'left', weight: 600, stroke: false });

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
