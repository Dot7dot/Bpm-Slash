// Canvas HUD (DESIGN section 8): beat track, hearts, score, chain, BPM, bar:beat, progress, count-in.
import { W, H, FONT, COLORS } from '../game/constants.js';
import { beatInfoAt, pulseAt, formatBarBeat } from '../core/beatMath.js';
import { chainMultiplier } from '../core/comboTracker.js';
import { LEVEL_COLORS } from '../game/disco.js';
import { roundRectPath } from '../game/effects.js';

const LEVEL_W = { bar: 5, half: 4, beat: 3, eighth: 2, sixteenth: 1, thirtysecond: 0 };
const INSTR = {
  snare: { name: '小鼓', color: '#8ff3ff' },
  kick: { name: '大鼓', color: '#ff9a3d' },
};
const NOTE_R = { bar: 11, half: 10, beat: 9, eighth: 7.5, sixteenth: 6, thirtysecond: 5 };
/** Ghost target patterns (tick within the bar -> instrument). Rock beat on most bars, four on the floor every 4th. */
const GHOSTS = {
  rock: { name: '搖滾節奏', kick: [0, 16], snare: [8, 24] },
  four: { name: '四拍大鼓', kick: [0, 8, 16, 24], snare: [] },
};
let hist = []; // this frame's drum-score items: { id, tick, instr, level, judgment, state, impactVst }
const seenAt = new Map(); // hit id -> visual song time it was first seen connected (for the pop animation)
let histLast = -1e9;

const instrOf = (a) => (a && (a.instrument || (a.q && a.q.instrument))) === 'snare' ? 'snare' : 'kick';
const levelOfTick = (m) => (m === 0 ? 'bar' : m % 16 === 0 ? 'half' : m % 8 === 0 ? 'beat' : m % 4 === 0 ? 'eighth' : m % 2 === 0 ? 'sixteenth' : 'thirtysecond');

/** Build this frame's drum hits: connected hits (combat.barHits) + queued attacks (combat.queued). */
function collectHits(game, vst, tickDur) {
  if (vst < histLast - 1) seenAt.clear();
  histLast = vst;
  const c = game.combat;
  const out = [];
  if (!c) { hist = out; return; }
  const connected = Array.isArray(c.barHits) ? c.barHits : [];
  const queued = Array.isArray(c.queued) ? c.queued : (c.queue || []).filter((a) => a.state === 'pending');
  for (const h of connected) {
    if (!Number.isFinite(h.tick)) continue;
    if (!seenAt.has(h.id)) seenAt.set(h.id, vst);
    out.push({ id: h.id, tick: h.tick, instr: instrOf(h), level: h.level || levelOfTick(((h.tick % 32) + 32) % 32), judgment: h.judgment || 'good', state: 'impact', impactVst: seenAt.get(h.id) });
  }
  for (const a of queued) {
    const tick = Number.isFinite(a.tick) ? a.tick : Math.round((a.connectSongTime ?? 0) / tickDur);
    if (out.some((o) => o.id === a.id)) continue;
    out.push({ id: a.id, tick, instr: instrOf(a), level: a.level || levelOfTick(((tick % 32) + 32) % 32), judgment: a.judgment || (a.q && a.q.judgment) || 'good', state: 'pending', unison: !!a.unison });
  }
  if (seenAt.size > 300) { const ids = new Set(out.map((o) => o.id)); for (const k of seenAt.keys()) if (!ids.has(k)) seenAt.delete(k); }
  hist = out;
}

/** Normalise an attack queue entry (v2 fields, with v1 fallbacks). */
function attackInfo(a) {
  const q = a.q || {};
  const level = a.level || (q.isDownbeat ? 'bar' : q.half === 'front' ? 'beat' : q.half === 'back' ? 'eighth' : 'beat');
  const judgment = a.judgment || q.judgment || 'good';
  return { id: a.id, level, judgment, t: a.connectSongTime ?? a.slotSongTime ?? 0 };
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

let SC = 1; // HUD text scale: grows on small (phone) canvases so text stays legible
function text(ctx, str, x, y, { size = 16, color = COLORS.ink, align = 'left', weight = 700, stroke = true } = {}) {
  ctx.font = `${weight} ${Math.round(size * SC)}px ${FONT}`;
  ctx.textAlign = align;
  if (stroke) { ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,2,28,0.85)'; ctx.lineJoin = 'round'; ctx.strokeText(str, x, y); }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

function drawNote(ctx, x, y, r, instr, fill, hollow, alpha, judgment, pop = 1) {
  const rr = r * pop;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    if (instr === 'kick') ctx.arc(x, y, rr, 0, Math.PI * 2);
    else { ctx.moveTo(x, y - rr * 1.2); ctx.lineTo(x + rr * 1.2, y); ctx.lineTo(x, y + rr * 1.2); ctx.lineTo(x - rr * 1.2, y); ctx.closePath(); }
  };
  if (!hollow && (judgment === 'perfect' || judgment === 'great')) {
    ctx.shadowColor = judgment === 'perfect' ? '#ffe45e' : '#5cf2ff'; ctx.shadowBlur = 12;
  }
  path();
  if (hollow) {
    ctx.fillStyle = 'rgba(8,2,28,0.55)'; ctx.fill();
    ctx.strokeStyle = fill; ctx.lineWidth = 2.5; ctx.stroke();
  } else {
    ctx.fillStyle = fill; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = judgment === 'perfect' ? '#ffe45e' : judgment === 'great' ? '#5cf2ff' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = judgment === 'perfect' || judgment === 'great' ? 2.5 : 1.5; ctx.stroke();
  }
  ctx.restore();
}

/** Two-lane drum score (DESIGN-DRUMMER section 5): top SNARE, bottom KICK, one bar plus a 4-tick overhang. */
function drawDrumScore(ctx, game, cond, vst, b, pulse, cs) {
  const bd = cond.beatDur;
  const tickDur = bd / 8;
  const phone = cs < 0.7;
  const k = Math.min(1.25, SC);
  const panelW = phone ? 920 : 680;
  const px0 = (W - panelW) / 2;
  const labelW = 58 * (phone ? 1.15 : 1);
  const headH = 20 * k, laneH = 36 * k;
  const ph = headH + laneH * 2 + 8;
  const top = H - 10 - ph;
  const nx0 = px0 + labelW + 6, nx1 = px0 + panelW - 14;
  const OVER = 4;
  const ppt = (nx1 - nx0) / (32 + OVER);
  const tf = vst / tickDur;
  const bar0 = Math.floor(tf / 32);
  const base = bar0 * 32;
  const xOf = (tick) => nx0 + (tick - base) * ppt;
  const laneY = { snare: top + headH + laneH * 0.5, kick: top + headH + laneH * 1.5 };

  collectHits(game, vst, tickDur);

  // panel
  ctx.fillStyle = 'rgba(8,2,28,0.8)';
  ctx.beginPath(); roundRectPath(ctx, px0, top, panelW, ph, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(160,120,255,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
  // lane bands
  for (const [name, y] of Object.entries(laneY)) {
    ctx.fillStyle = name === 'snare' ? 'rgba(143,243,255,0.07)' : 'rgba(255,154,61,0.09)';
    ctx.fillRect(nx0 - 4, y - laneH / 2 + 2, nx1 - nx0 + 8, laneH - 4);
    text(ctx, INSTR[name].name, px0 + 10, y + 6 * k, { size: 16, color: INSTR[name].color, weight: 900 });
  }
  // overhang (next bar) shading
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(xOf(base + 32), top + headH, OVER * ppt + 6, laneH * 2);

  // grid
  const step = stepTicksOf(game, bd);
  const gTop = top + headH - 2, gBot = top + headH + laneH * 2 + 2;
  for (let t = 0; t <= 32 + OVER; t += step) {
    const m = t % 32;
    const x = xOf(base + t);
    let a = 0.16, w = 1, col = '255,255,255', ext = 0;
    if (m === 0) { a = 0.85; w = 3; col = '255,210,77'; ext = 4; }
    else if (m % 8 === 0) { a = 0.5; w = 2; col = '77,243,255'; }
    else if (m % 4 === 0) { a = 0.3; w = 1.5; col = '255,79,216'; }
    ctx.strokeStyle = `rgba(${col},${a})`; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, gTop - ext); ctx.lineTo(x, gBot); ctx.stroke();
  }
  // beat numbers in the header
  for (let n = 0; n < 4; n++) {
    const x = xOf(base + n * 8);
    const active = Math.floor((tf - base) / 8) === n;
    text(ctx, String(n + 1), x + 4, top + headH - 4, { size: 13, color: n === 0 ? COLORS.down : active ? '#ffffff' : '#b9a7ff', weight: 800, stroke: true });
  }

  // ghost target notes
  const ghostOn = !(game.settings && game.settings.drumGhost === false);
  const gh = ((bar0 % 4) + 4) % 4 === 3 ? GHOSTS.four : GHOSTS.rock;
  if (ghostOn && b.beatIndex >= -1) {
    const cur = hist.filter((h) => h.tick >= base && h.tick < base + 32 + OVER);
    for (const inst of ['snare', 'kick']) {
      for (const m of gh[inst]) {
        if (cur.some((h) => h.instr === inst && h.tick === base + m)) continue;
        const x = xOf(base + m), y = laneY[inst];
        ctx.save();
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1.8; ctx.strokeStyle = INSTR[inst].color; ctx.globalAlpha = 0.4;
        ctx.beginPath();
        if (inst === 'kick') ctx.arc(x, y, 9 * k, 0, Math.PI * 2);
        else { const r = 9 * k * 1.2; ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
        ctx.stroke(); ctx.restore();
      }
    }
    text(ctx, `目標：${gh.name}`, nx0, top - 6, { size: 13, color: '#d9ccff', weight: 700 });
  }

  // played + queued hits
  const items = hist.filter((h) => h.tick >= base && h.tick < base + 32 + OVER);
  // unison connectors
  for (const h of items) {
    if (h.instr !== 'kick') continue;
    if (items.some((o) => o.instr === 'snare' && o.tick === h.tick)) {
      const x = xOf(h.tick);
      ctx.strokeStyle = 'rgba(255,228,94,0.9)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, laneY.snare); ctx.lineTo(x, laneY.kick); ctx.stroke();
    }
  }
  for (const h of items) {
    const x = xOf(h.tick), y = laneY[h.instr];
    const r = (NOTE_R[h.level] || 7) * k;
    const col = LEVEL_COLORS[h.level] || '#fff';
    if (h.state === 'pending') {
      const near = Math.max(0, 1 - (h.tick * tickDur - vst) / bd);
      drawNote(ctx, x, y, r, h.instr, col, true, 0.65 + 0.35 * near, h.judgment);
    } else {
      const age = h.impactVst === undefined ? 1 : Math.max(0, vst - h.impactVst);
      const pop = 1 + 0.6 * Math.exp(-age * 14);
      drawNote(ctx, x, y, r, h.instr, col, false, h.judgment === 'off' ? 0.4 : 1, h.judgment, pop);
    }
  }

  // playhead
  const phx = Math.min(nx1 + 8, Math.max(nx0, xOf(tf)));
  ctx.save();
  ctx.strokeStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 8 + 10 * pulse; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(phx, top + 4); ctx.lineTo(phx, gBot + 2); ctx.stroke();
  const ringCol = b.beatInBar === 0 ? COLORS.down : COLORS.front;
  ctx.strokeStyle = ringCol; ctx.shadowColor = ringCol; ctx.lineWidth = 3 + 2 * pulse;
  ctx.beginPath(); ctx.arc(phx, top + 4, 5 + 4 * pulse, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

export function drawHud(ctx, game, cond, vst, scene, song) {
  const bpm = cond.bpm;
  const bd = cond.beatDur;
  const b = beatInfoAt(vst, bpm);
  const pulse = pulseAt(b.beatPhase, b.beatInBar);
  const cw = ctx.canvas && ctx.canvas.clientWidth;
  const cs = cw ? Math.max(0.2, Math.min(1.5, cw / W)) : 1;
  SC = Math.min(1.6, Math.max(1, 0.66 / cs));
  const s1 = Math.min(1.35, SC);

  ctx.save();

  // ---- top-left: hearts / score / chain / fever meter ----
  const p = game.player;
  const hr = 11 * s1;
  let y = 12 + hr * 1.4;
  for (let i = 0; i < p.maxHp; i++) {
    const x = 18 + hr + i * (hr * 2.7);
    heartPath(ctx, x, y, hr);
    if (i < p.hp) {
      ctx.fillStyle = '#ff4d8d'; ctx.shadowColor = '#ff4d8d'; ctx.shadowBlur = 10 + 8 * pulse; ctx.fill();
    } else {
      ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,120,170,0.4)'; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  const combo = game.combo;
  y += 14 + 26 * SC;
  text(ctx, String(Math.floor(combo.score)).padStart(7, '0'), 16, y, { size: 26, color: '#ffffff', weight: 800 });
  y += 17 * SC;
  text(ctx, 'SCORE', 16, y, { size: 13, color: '#b9a7ff', weight: 700 });
  if (combo.chain > 0) {
    y += 30 * SC;
    const k = 1 + 0.18 * game.hudPulse;
    ctx.save(); ctx.translate(16, y); ctx.scale(k, k);
    text(ctx, `CHAIN ${combo.chain}`, 0, 0, { size: 22, color: combo.chain >= 10 ? COLORS.down : COLORS.great, weight: 800 });
    ctx.restore();
    y += 19 * SC;
    text(ctx, `×${chainMultiplier(combo.chain).toFixed(1)}`, 16, y, { size: 14, color: '#b9a7ff' });
  }

  const fv = game.fever || { value: 0, armed: false, active: false, endsAtBeat: 0 };
  {
    const fx = 16, fy = y + 14, fw = 150, fh = 10 * s1;
    ctx.fillStyle = 'rgba(8,2,28,0.6)'; ctx.beginPath(); roundRectPath(ctx, fx - 2, fy - 2, fw + 4, fh + 4, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); roundRectPath(ctx, fx, fy, fw, fh, 4); ctx.fill();
    const v = Math.min(1, Math.max(0, fv.value || 0));
    if (v > 0.002 || fv.active) {
      const g2 = ctx.createLinearGradient(fx, 0, fx + fw, 0);
      if (fv.active) { for (let i = 0; i <= 4; i++) g2.addColorStop(i / 4, rainbow(vst, i * 60)); }
      else { g2.addColorStop(0, '#4df3ff'); g2.addColorStop(0.6, '#ff4fd8'); g2.addColorStop(1, '#ffd24d'); }
      ctx.fillStyle = g2; ctx.shadowColor = fv.armed || fv.active ? '#ffd24d' : '#ff4fd8'; ctx.shadowBlur = fv.armed || fv.active ? 12 + 8 * pulse : 5;
      ctx.beginPath(); roundRectPath(ctx, fx, fy, Math.max(6, fw * (fv.active ? 1 : v)), fh, 4); ctx.fill();
      ctx.shadowBlur = 0;
    }
    text(ctx, 'FEVER', fx, fy + fh + 16 * SC, { size: 13, color: fv.active || fv.armed ? '#ffd24d' : '#b9a7ff', weight: 800 });
  }
  const bannerY = 136 + (s1 - 1) * 40;
  if (fv.active) {
    const left = Math.max(0, (fv.endsAtBeat ?? 0) - b.beatFloat);
    const k = (1 + 0.12 * pulse) * Math.min(1.3, s1);
    ctx.save(); ctx.translate(W / 2, bannerY); ctx.scale(k, k);
    ctx.textAlign = 'center'; ctx.font = `900 34px ${FONT}`;
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(8,2,28,0.9)'; ctx.lineJoin = 'round';
    ctx.strokeText('FEVER ×2', 0, 0);
    ctx.fillStyle = rainbow(vst, 0); ctx.shadowColor = rainbow(vst, 120); ctx.shadowBlur = 18;
    ctx.fillText('FEVER ×2', 0, 0);
    ctx.restore();
    if (fv.endsAtBeat) {
      const bw = 140; ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(W / 2 - bw / 2, bannerY + 10, bw, 4);
      ctx.fillStyle = rainbow(vst, 200); ctx.fillRect(W / 2 - bw / 2, bannerY + 10, bw * Math.min(1, left / 8), 4);
    }
  } else if (fv.armed) {
    const blink = 0.55 + 0.45 * Math.sin(b.beatFloat * Math.PI * 2);
    ctx.save(); ctx.globalAlpha = blink;
    text(ctx, 'FEVER 待命', W / 2, bannerY - 6, { size: 26, color: '#ffd24d', align: 'center', weight: 900 });
    text(ctx, '下一小節開始', W / 2, bannerY + 16 * SC, { size: 14, color: '#ffe9a8', align: 'center', weight: 700 });
    ctx.restore();
  }

  // ---- top-right: BPM, bar:beat, song, progress ----
  const bb = formatBarBeat(b.beatIndex);
  let ry = 12 + 22 * SC;
  text(ctx, `${bpm % 1 === 0 ? bpm : bpm.toFixed(1)} BPM`, W - 16, ry, { size: 22, color: COLORS.front, align: 'right', weight: 800 });
  ry += 24 * SC;
  text(ctx, bb.countIn ? '預備' : `小節 ${bb.bar} : ${bb.beat}`, W - 16, ry, { size: 18, color: '#ffffff', align: 'right' });
  ry += 20 * SC;
  text(ctx, song || '', W - 16, ry, { size: 13, color: '#b9a7ff', align: 'right', weight: 600 });
  const pw = 220, px = W - 16 - pw, py = ry + 10;
  const prog = Math.min(1, Math.max(0, (vst) / Math.max(1, game.endSongTime)));
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(px, py, pw, 5);
  const pg = ctx.createLinearGradient(px, 0, px + pw, 0);
  pg.addColorStop(0, COLORS.front); pg.addColorStop(1, COLORS.back);
  ctx.fillStyle = pg; ctx.fillRect(px, py, pw * prog, 5);

  // ---- drum score ----
  drawDrumScore(ctx, game, cond, vst, b, pulse, cs);

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
      text(ctx, '你就是鼓手！J／空白鍵＝大鼓「咚」　K＝小鼓「啪」', W / 2, 352, { size: 15, color: '#b9a7ff', align: 'center' });
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
