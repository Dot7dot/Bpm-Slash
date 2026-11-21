// Parallax neon background that pulses with the beat (DESIGN 7.2).
import { W, H } from './constants.js';
import { beatInfoAt, pulseAt } from '../core/beatMath.js';
import { hash01 } from '../core/rng.js';

const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: hash01(i, 1) * 1400, y: hash01(i, 2) * 300, r: 0.6 + hash01(i, 3) * 1.4,
}));

export function drawBackground(ctx, camX, vst, bpm) {
  const b = beatInfoAt(vst, bpm);
  const pulse = pulseAt(b.beatPhase, b.beatInBar);
  const flash = b.beatInBar === 0 ? Math.exp(-b.beatPhase * 9) : 0;

  const sky = ctx.createLinearGradient(0, 0, 0, 430);
  sky.addColorStop(0, '#080220');
  sky.addColorStop(0.55, '#26084a');
  sky.addColorStop(1, '#8a1b72');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // stars
  ctx.fillStyle = '#ffffff';
  for (const s of STARS) {
    const x = ((s.x - camX * 0.04) % 1400 + 1400) % 1400;
    if (x > W) continue;
    ctx.globalAlpha = 0.35 + 0.3 * pulse;
    ctx.fillRect(x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  // striped sun
  const sunR = 112 * (1 + 0.035 * pulse);
  const sx = W * 0.62 - camX * 0.02, sy = 300;
  const sg = ctx.createLinearGradient(0, sy - sunR, 0, sy + sunR);
  sg.addColorStop(0, '#ffe45e'); sg.addColorStop(0.5, '#ff7ac8'); sg.addColorStop(1, '#a43bff');
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, sunR, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = sg; ctx.fillRect(sx - sunR, sy - sunR, sunR * 2, sunR * 2);
  ctx.fillStyle = '#26084a';
  for (let i = 0; i < 6; i++) {
    const y = sy + 10 + i * 17;
    ctx.fillRect(sx - sunR, y, sunR * 2, 2 + i * 1.6);
  }
  ctx.restore();

  // far skyline (parallax 0.22)
  const far = camX * 0.22;
  ctx.fillStyle = '#150636';
  ctx.strokeStyle = `rgba(150,110,255,${0.25 + 0.3 * pulse})`;
  ctx.lineWidth = 1.5;
  const farStart = Math.floor(far / 70) - 1;
  for (let i = farStart; i < farStart + 18; i++) {
    const bw = 50 + hash01(i, 11) * 40;
    const bh = 70 + hash01(i, 12) * 120;
    const bx = i * 70 - far;
    ctx.fillRect(bx, 400 - bh, bw, bh + 30);
    ctx.strokeRect(bx, 400 - bh, bw, bh + 30);
  }

  // equalizer bars (parallax 0.45), heights follow a delayed pulse per bar
  const near = camX * 0.45;
  const bi0 = Math.floor(near / 30) - 1;
  for (let i = bi0; i < bi0 + 36; i++) {
    const bx = i * 30 - near;
    const delay = (hash01(i, 21) * 0.12);
    const bb = beatInfoAt(vst - delay, bpm);
    const p = pulseAt(bb.beatPhase, bb.beatInBar);
    const base = 22 + hash01(i, 22) * 50;
    const h = base * (0.75 + 1.0 * p * (0.6 + hash01(i, 23) * 0.8));
    const hue = 290 - ((i % 18) / 18) * 110;
    ctx.fillStyle = `hsla(${hue},95%,${52 + 10 * p}%,0.82)`;
    ctx.fillRect(bx, 425 - h, 20, h);
    ctx.fillStyle = `hsla(${hue},100%,80%,0.9)`;
    ctx.fillRect(bx, 425 - h, 20, 2);
  }

  // neon horizon line
  ctx.save();
  ctx.strokeStyle = `rgba(77,243,255,${0.5 + 0.5 * Math.max(pulse, flash)})`;
  ctx.shadowColor = flash > 0.2 ? '#ffd24d' : '#4df3ff';
  ctx.shadowBlur = 8 + 24 * flash;
  ctx.lineWidth = 2 + 2 * flash;
  ctx.beginPath(); ctx.moveTo(0, 426); ctx.lineTo(W, 426); ctx.stroke();
  ctx.restore();
}
