// Game session: owns the world (level, player, enemies, effects) and reacts to beat events.
import { Level } from './level.js';
import { Player } from './player.js';
import { Combat } from './combat.js';
import { Camera } from './camera.js';
import { Effects } from './effects.js';
import { Slime, Bat, Guard, waveFor } from './enemies.js';
import { drawBackground } from './background.js';
import { W } from './constants.js';
import { ComboTracker, FeverMeter } from '../core/comboTracker.js';
import { pushLog } from '../debug/debugHook.js';
import { COLORS } from './constants.js';

const MAX_ENEMIES = 6;

export class Game {
  constructor({ settings, conductor, engine, songName, songDurationSec, songMap = null }) {
    this.settings = settings;
    this.conductor = conductor;
    this.engine = engine;
    this.songName = songName;
    this.songDurationSec = songDurationSec;
    this.level = new Level();
    this.player = new Player();
    this.camera = new Camera();
    this.effects = new Effects();
    this.combo = new ComboTracker();
    this.fever = new FeverMeter();
    this.songMap = songMap; // { sections: [{startBar, endBar(excl), intensity}] } and/or { barIntensity: [] }
    this.combat = new Combat(this);
    this.enemies = [];
    this.nextEnemyId = 1;
    this.over = null; // { died: boolean }
    this.invincible = false;
    this.vst = -10;
    this.kills = 0;
    this.hudPulse = 0;
    this.level.ensure(W + 1200);
  }

  /** End-of-song time in song-time domain (file end). */
  get endSongTime() { return this.songDurationSec - this.conductor.offsetSec; }

  logWorld(kind, entityId, ev, extra = null) {
    pushLog('world', {
      kind, entityId, beatIndex: ev.beatIndex, beatInBar: ev.beatInBar,
      beatSongTime: ev.beatSongTime, firedSongTime: this.conductor.lastVisualSongTime,
      ...(extra || {}),
    });
  }

  /** Drummer groove (docs/DESIGN-DRUMMER.md section 4): judge the bar that just ended, on the downbeat event. */
  _checkGroove(ev) {
    const bar = ev.barIndex - 1;
    const gr = this.combat.evaluateBar(bar);
    if (!gr) return;
    this.combo.onGroove(gr);
    this.fever.addBonus(gr.fever);
    this.combat.lastGroove = { ...gr, barIndex: bar, songTime: ev.beatSongTime };
    this.logWorld('groove', gr.id, ev, { pattern: gr.id, name: gr.name, nameEn: gr.nameEn, grooveBar: bar, score: gr.score, fever: gr.fever });
    this.effects.text(this.player.x, this.player.y - 190, `GROOVE! ${gr.name}`, { color: COLORS.back, size: 34, life: 1.3, rise: 36, channel: 'groove' });
    if (!this.settings.reduceFlashing) this.effects.flashScreen(0.25, '#ff4fd8', false);
  }

  onBeat(ev) {
    pushLog('beat', {
      beatIndex: ev.beatIndex, beatInBar: ev.beatInBar, barIndex: ev.barIndex,
      beatSongTime: ev.beatSongTime, firedSongTime: this.conductor.lastVisualSongTime,
    });
    const fv = this.fever.onBeat(ev);
    if (fv === 'start') {
      this.logWorld('fever-start', null, ev); // the HUD shows the FEVER banner
    } else if (fv === 'end') {
      this.logWorld('fever-end', null, ev);
    }
    if (this.over) return;
    if (ev.beatInBar === 0) this._checkGroove(ev);
    this.level.onBeat(ev, this, this.camera.x, this.camera.x + W);
    for (const e of this.enemies) e.onBeat(ev, this);
    if (ev.beatInBar === 0 && ev.barIndex >= 2) this._spawnWave(ev);
  }

  _spawnWave(ev) {
    const types = waveFor(ev.barIndex, this.intensityAtBar(ev.barIndex));
    let n = 0;
    for (const t of types) {
      if (this.enemies.length >= MAX_ENEMIES) break;
      const left = this.camera.x > 400 && ((ev.barIndex + n) % 5 === 4);
      const x = left ? this.camera.x - 70 : this.camera.x + W + 70 + n * 80;
      const id = `${t}-${this.nextEnemyId++}`;
      let e;
      if (t === 'slime') e = new Slime(id, x);
      else if (t === 'bat') e = new Bat(id, x, this.level.groundY(x) - 120 - (n % 2) * 24);
      else e = new Guard(id, x);
      e.facing = left ? 1 : -1;
      this.enemies.push(e);
      this.logWorld('spawn', id, ev);
      n++;
    }
  }

  /** 'low' | 'mid' | 'high' for a bar index (out of range or no map: 'mid'). */
  intensityAtBar(barIndex) {
    const m = this.songMap;
    if (!m || !Number.isFinite(barIndex) || barIndex < 0) return 'mid';
    if (Array.isArray(m.sections) && m.sections.length) {
      for (const s of m.sections) if (barIndex >= s.startBar && barIndex < s.endBar) return s.intensity;
      return 'mid';
    }
    if (Array.isArray(m.barIntensity)) return m.barIntensity[barIndex] || 'mid';
    return 'mid';
  }

  /** Reactive confirm sounds (feature-detected so older engines keep working). */
  confirmHit(big) { const e = this.engine; if (e.playConfirmHit) e.playConfirmHit(big); else e.playHit(big); }
  confirmBlock() { const e = this.engine; (e.playConfirmBlock || e.playBlock).call(e); }
  confirmKill() { const e = this.engine; (e.playConfirmKill || e.playKill).call(e); }

  /** A parry happened (called by an enemy's parry() or detected by Combat). Idempotent per attack. */
  onParry(e, attack) {
    if (!this.combat.markParried(attack)) return;
    this.combo.onParry();
    this.fever.onParry();
    if (typeof this.engine.playConfirmParry === 'function') this.engine.playConfirmParry();
  }

  damageEnemy(e, dmgIn, kbSigned, kind) {
    const fx = this.effects;
    const dmg = e.stunned ? dmgIn * 2 : dmgIn;
    const dead = e.takeHit(dmg);
    const shown = Math.round(dmg * 10) / 10;
    fx.text(e.x, e.y - e.r * 2 - 24, String(shown), { color: kind === 'back' ? COLORS.back : '#fff', size: 18, life: 0.55, rise: 28 });
    fx.burst(e.x, e.cy, 9, { color: e.type === 'slime' ? '#5dff8a' : e.type === 'bat' ? '#c47bff' : '#ffb347', speed: 200, life: 0.45 });
    e.shove(kbSigned);
    if (dead) {
      e.dead = true;
      fx.burst(e.x, e.cy, 24, { color: '#ffffff', speed: 300, life: 0.6, size: 4 });
      fx.ring(e.x, e.cy, 36, '#ffffff', 0.3);
      this.confirmKill();
      this.kills++;
      this.combo.addScore(50);
      this.enemies = this.enemies.filter((x) => x !== e);
    }
  }

  hurtPlayer(dmg, fromX) {
    const p = this.player;
    if (this.over || this.invincible || p.isInvincible(this.vst)) return false;
    p.hp -= dmg;
    p.invUntil = this.vst + this.conductor.beatDur;
    p.kb = (p.x >= fromX ? 1 : -1) * 280;
    p.hurtT = 0.3;
    this.combo.onHurt();
    this.fever.onHurt(this.vst);
    this.effects.burst(p.x, p.bodyY, 14, { color: COLORS.danger, speed: 260 });
    this.effects.flashScreen(0.5, '#ff4d6d', this.settings.reduceFlashing);
    this.camera.addShake(6, this.settings.reduceFlashing);
    this.engine.playHurt();
    if (p.hp <= 0) { p.hp = 0; this.over = { died: true }; }
    return true;
  }

  /** Per-frame update. dir: -1/0/1 from input. */
  update(vst, dt, dir, scene) {
    this.vst = vst;
    this.hudPulse = Math.max(0, this.hudPulse - dt * 5);
    if (!this.over) {
      this.player.update(dt, dir, this.level, this.combat.busy);
      this.combat.update(vst);
      this.fever.update(vst, this.conductor.beatDur);
      for (const e of this.enemies.slice()) e.update(vst, dt, this);
      this.enemies = this.enemies.filter((e) => e.x > this.camera.x - 600 && e.x < this.camera.x + W + 900);
      if (this.level.spikeHits(this.player.x, 8) && this.level.spikeState === 'up') this.hurtPlayer(1, this.player.x - 1);
      if (scene === 'playing' && vst >= this.endSongTime + 0.25) this.over = { died: false };
    } else {
      this.player.pose = null;
    }
    this.effects.update(dt);
    this.camera.update(dt, this.player.x);
    this.level.ensure(this.camera.x + W + 900);
  }

  draw(ctx, vst) {
    const bpm = this.conductor.bpm;
    drawBackground(ctx, this.camera.x, vst, bpm);
    ctx.save();
    ctx.translate(-this.camera.x + this.camera.offsetX, this.camera.offsetY);
    this.level.draw(ctx, this.camera, vst, bpm);
    this.level.drawSpikes(ctx, this.camera, vst, bpm);
    for (const e of this.enemies) e.draw(ctx, vst, bpm);
    const center = Math.floor((this.camera.x + W * 0.4) / 40);
    const lift = this.level.tileBounce(Math.floor(this.player.x / 40), center, vst, bpm).lift;
    this.player.draw(ctx, vst, bpm, lift);
    this.effects.draw(ctx);
    ctx.restore();
  }
}
