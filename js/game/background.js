// Disco stage backdrop (DESIGN-BEATSNAP section 9): back wall, mirror ball, sweeping spotlights, crowd,
// neon skyline + equalizer bars. Everything animates from the visual song time. Signature unchanged.
import { W, H } from './constants.js';
import { beatInfoAt, pulseAt } from '../core/beatMath.js';
import { hash01 } from '../core/rng.js';
import {
  stageInfo, drawSky, drawHalo, drawBeams, drawCrowd, drawMirrorBall, drawDownbeatFlash,
} from './disco.js';

const STARS = Array.from({ length: 60 }, (_, i) => ({
  x: hash01(i, 1) * 1400, y: hash01(i, 2) * 260, r: 0.6 + hash01(i, 3) * 1.4,
}));

export function drawBackground(ctx, camX, vst, bpm) {
  const info = stageInfo(vst, bpm);
  const b = info.b;
  const pulse = pulseAt(b.beatPhase, b.beatInBar);
  const flash = b.beatInBar === 0 ? Math.exp(-b.beatPhase * 9) : 0;
  const L = info.light;

  drawSky(ctx, H, info);

  // stars
  ctx.fillStyle = '#ffffff';
  for (const s of STARS) {
    const x = ((s.x - camX * 0.04) % 1400 + 1400) % 1400;
    if (x > W) continue;
    ctx.globalAlpha = (0.25 + 0.3 * pulse) * L;
    ctx.fillRect(x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  drawHalo(ctx, info);

  // far skyline (parallax 0.22), seen through the back wall
  const far = camX * 0.22;
  ctx.fillStyle = '#12052e';
  ctx.strokeStyle = `rgba(150,110,255,${(0.16 + 0.22 * pulse) * L + 0.05})`;
  ctx.lineWidth = 1.5;
  const farStart = Math.floor(far / 70) - 1;
  for (let i = farStart; i < farStart + 18; i++) {
    const bw = 50 + hash01(i, 11) * 40;
    const bh = 60 + hash01(i, 12) * 100;
    const bx = i * 70 - far;
    ctx.fillRect(bx, 400 - bh, bw, bh + 30);
    ctx.strokeRect(bx, 400 - bh, bw, bh + 30);
  }

  // spotlights behind the crowd
  drawBeams(ctx, info);

  // equalizer bars (parallax 0.45), lower than before so the crowd reads in front
  const near = camX * 0.45;
  const bi0 = Math.floor(near / 30) - 1;
  for (let i = bi0; i < bi0 + 36; i++) {
    const bx = i * 30 - near;
    const delay = hash01(i, 21) * 0.12;
    const bb = beatInfoAt(vst - delay, bpm);
    const p = pulseAt(bb.beatPhase, bb.beatInBar);
    const base = 14 + hash01(i, 22) * 34;
    const h = base * (0.7 + 0.9 * p * (0.6 + hash01(i, 23) * 0.8));
    const hue = info.fever ? b.beatFloat * 60 + i * 12 : 290 - ((i % 18) / 18) * 110;
    ctx.fillStyle = `hsla(${hue},95%,${46 + 10 * p}%,${0.55 * L + 0.15})`;
    ctx.fillRect(bx, 425 - h, 20, h);
    ctx.fillStyle = `hsla(${hue},100%,80%,${0.8 * L})`;
    ctx.fillRect(bx, 425 - h, 20, 2);
  }

  drawCrowd(ctx, camX, vst, bpm, info);
  drawMirrorBall(ctx, info);
  drawDownbeatFlash(ctx, H, info);

  // neon horizon line
  ctx.save();
  ctx.strokeStyle = `rgba(77,243,255,${0.5 + 0.5 * Math.max(pulse, flash * (info.reduce ? 0.3 : 1))})`;
  ctx.shadowColor = flash > 0.2 && !info.reduce ? '#ffd24d' : '#4df3ff';
  ctx.shadowBlur = 8 + 16 * (info.reduce ? 0 : flash);
  ctx.lineWidth = 2 + 2 * (info.reduce ? 0 : flash);
  ctx.beginPath(); ctx.moveTo(0, 426); ctx.lineTo(W, 426); ctx.stroke();
  ctx.restore();
}
