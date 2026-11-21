// BPM Slash entry point: scene state machine, main loop, input.
import { AudioEngine } from './audio/audioEngine.js';
import { Conductor } from './audio/conductor.js';
import { Game } from './game/game.js';
import { Level } from './game/level.js';
import { Player } from './game/player.js';
import { drawBackground } from './game/background.js';
import { drawHud } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { showResults, hideResults } from './ui/results.js';
import { loadSettings, saveSettings } from './ui/settings.js';
import { installDebugHook, pushLog } from './debug/debugHook.js';
import { clampBpm } from './core/beatMath.js';
import { sanitizeSubdivision } from './ui/settings.js';
import { W, H } from './game/constants.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.canvas = $('game');
    this.ctx = this.canvas.getContext('2d');
    this.settings = loadSettings();
    this.engine = new AudioEngine();
    this.engine.setVolumes({ music: this.settings.musicVol, sfx: this.settings.sfxVol });
    this.conductor = new Conductor(this.engine);
    this.scene = 'menu'; // menu | countin | playing | paused | results
    this.prevScene = 'menu';
    this.song = null;
    this.game = null;
    this.previewing = false;
    this.invincible = false;
    this.starting = false;
    this.keys = new Set();
    this.touchDir = 0;
    this.lastFrame = performance.now();
    this.idleLevel = new Level();
    this.idlePlayer = new Player();
    this.idlePlayer.x = 300;
    this.idlePlayer.y = this.idleLevel.groundY(300);
    this.dpr = 1;

    this.menu = new Menu(this);
    installDebugHook(this);
    this._bindInput();
    this._bindUi();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.resize());
    document.body.classList.toggle('has-touch', 'ontouchstart' in window || navigator.maxTouchPoints > 0);
    // Push saved settings into the conductor now (no AudioContext needed), so the
    // debug state and the UI agree right after a reload.
    this.applyParams();
    this.useDefaultSong(false);
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- layout ----------
  resize() {
    // Use the visual viewport when available so the canvas fills the full visible width
    // (portrait phones: scale is width-limited, so this is the largest size possible).
    const vv = window.visualViewport;
    const vw = Math.floor((vv && vv.width) || window.innerWidth);
    const vh = Math.floor((vv && vv.height) || window.innerHeight);
    const scale = Math.min(vw / W, vh / H);
    const cssW = Math.floor(W * scale), cssH = Math.floor(H * scale);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
    this.pxScale = this.canvas.width / W;
  }

  toast(msg, ms = 4000) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- songs ----------
  async useDefaultSong(applyMeta) {
    this.stopPreview();
    this.menu.setSongStatus('載入預設曲中…');
    const r = await this.engine.loadDefaultSong();
    this.song = { name: r.meta.title || '預設曲', buffer: r.buffer, isDefault: true, meta: r.meta };
    if (applyMeta) {
      this.settings.bpm = clampBpm(r.meta.bpm || 88);
      this.settings.offsetMs = r.meta.offsetMs || 0;
      this.settingsChanged();
      this.menu.syncInputs();
    }
    this.menu.setSongStatus(`目前歌曲：${this.song.name}（${this._fmtDur(r.buffer.duration)}）`);
    this.menu.message(r.fallback ? '找不到預設曲檔案，已改用內建簡易節拍音軌（僅供測試）' : '', r.fallback);
  }

  async loadUploadedFile(file) {
    this.stopPreview();
    this.menu.message('解碼中…');
    try {
      const buffer = await this.engine.decode(await file.arrayBuffer());
      this.song = { name: file.name, buffer, isDefault: false };
      this.menu.setSongStatus(`目前歌曲：${file.name}（${this._fmtDur(buffer.duration)}）`);
      this.menu.message('已載入。請設定 BPM 與第一拍偏移，並用「試聽對拍」確認是否對齊。');
    } catch (e) {
      this.menu.message('無法解碼此檔案，請改用 WAV 或 AAC 編碼的 MP4', true);
    }
  }

  _fmtDur(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

  /**
   * Song map (intensity per bar). Default song: hand-made `sections` from its JSON; uploaded songs: analyzed
   * with analyzeSongMap (dynamic import, any failure falls back to null = all 'mid'). Cached per song/BPM/offset.
   */
  async getSongMap() {
    const song = this.song;
    if (!song) return null;
    const s = this.settings;
    if (song.isDefault && song.meta && Array.isArray(song.meta.sections) && song.meta.sections.length) {
      return { sections: song.meta.sections };
    }
    const key = `${s.bpm}|${s.offsetMs}`;
    if (song.mapKey === key) return song.map;
    let map = null;
    try {
      const buf = song.buffer;
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      const mod = await import('./core/songMap.js');
      const r = mod.analyzeSongMap(mono, buf.sampleRate, { bpm: s.bpm, offsetSec: s.offsetMs / 1000, beatsPerBar: 4 });
      if (r && Array.isArray(r.sections) && r.sections.length) map = r;
    } catch (e) { map = null; }
    song.map = map; song.mapKey = key;
    return map;
  }

  // ---------- settings ----------
  settingsChanged() {
    saveSettings(this.settings);
    this.engine.setVolumes({ music: this.settings.musicVol, sfx: this.settings.sfxVol });
    this.applyParams();
  }

  applyParams() {
    const s = this.settings;
    this.conductor.setParams({
      bpm: s.bpm, offsetSec: s.offsetMs / 1000, inputCalibrationSec: s.inputCalibrationMs / 1000,
    });
  }

  // ---------- preview ----------
  async togglePreview() {
    if (this.previewing) { this.stopPreview(); return; }
    if (!this.song) { this.menu.message('尚未載入歌曲', true); return; }
    await this.engine.resume();
    const ctx = this.engine.ctx;
    this.applyParams();
    this.conductor.songStartAudioTime = ctx.currentTime + 0.12;
    const src = this.engine.playSong(this.song.buffer, this.conductor.songStartAudioTime);
    this.engine.startMetronome(this.conductor, { startBeat: 0, enabled: () => true, forceCountIn: false });
    this.previewing = true;
    src.addEventListener('ended', () => { if (this.engine.source === null || this.engine.source === src) this.stopPreview(); });
    this.menu.setPreviewActive(true);
  }

  stopPreview() {
    if (!this.previewing) return;
    this.previewing = false;
    this.engine.stopMetronome();
    this.engine.stopSong();
    this.menu.setPreviewActive(false);
  }

  // ---------- game flow ----------
  async startGame(opts = {}) {
    if (this.starting) return;
    this.starting = true;
    try {
      this.stopPreview();
      const s = this.settings;
      if (opts.bpm !== undefined) s.bpm = clampBpm(opts.bpm);
      if (opts.offsetMs !== undefined) s.offsetMs = Math.max(0, opts.offsetMs);
      if (opts.subdivision !== undefined) s.subdivision = sanitizeSubdivision(opts.subdivision);
      if (opts.lateGraceMs !== undefined) s.lateGraceMs = Math.max(0, opts.lateGraceMs);
      if (!opts.fromDebug) saveSettings(s);
      if (!this.song) await this.useDefaultSong(false);
      await this.engine.resume();
      const ctx = this.engine.ctx;
      const cond = this.conductor;
      this.engine.setVolumes({ music: s.musicVol, sfx: s.sfxVol });
      this.applyParams();
      cond.clearListeners();
      this.engine.stopMetronome();
      this.engine.stopSong();
      const songMap = await this.getSongMap(); // may take a moment for uploaded songs; do it before beat 0 is placed

      // DESIGN 5.4: one bar of count-in.
      const beat0 = ctx.currentTime + 0.15 + 4 * cond.beatDur;
      cond.setBeat0(beat0);
      cond.resetBeatClock(-5);
      this.engine.playSong(this.song.buffer, cond.songStartAudioTime);

      const game = new Game({
        settings: s, conductor: cond, engine: this.engine,
        songName: this.song.name, songDurationSec: this.song.buffer.duration, songMap,
      });
      game.invincible = this.invincible;
      this.game = game;
      cond.onBeat((ev) => game.onBeat(ev));
      this.engine.startMetronome(cond, {
        startBeat: -4, forceCountIn: true, enabled: () => this.settings.metronome,
        onClick: (beatIndex, scheduledAudioTime, expectedAudioTime) => pushLog('metronome', { beatIndex, scheduledAudioTime, expectedAudioTime }),
      });

      this.menu.hide();
      hideResults();
      $('pause').classList.add('hidden');
      document.body.classList.add('in-game');
      this.scene = 'countin';
    } finally {
      this.starting = false;
    }
  }

  async stopToMenu() {
    this.stopPreview();
    this.engine.stopMetronome();
    this.engine.stopSong();
    this.conductor.clearListeners();
    this.game = null;
    this.scene = 'menu';
    document.body.classList.remove('in-game');
    $('pause').classList.add('hidden');
    hideResults();
    this.menu.show();
    if (this.engine.ctx && this.engine.ctx.state === 'suspended') await this.engine.resume();
  }

  async pause() {
    if (this.scene !== 'countin' && this.scene !== 'playing') return;
    this.prevScene = this.scene;
    this.scene = 'paused';
    $('pause').classList.remove('hidden');
    await this.engine.suspend();
  }

  async resume() {
    if (this.scene !== 'paused') return;
    await this.engine.resume();
    $('pause').classList.add('hidden');
    this.scene = this.prevScene;
  }

  endGame() {
    const game = this.game;
    this.scene = 'results';
    this.engine.stopMetronome();
    this.engine.stopSong();
    this.conductor.clearListeners();
    document.body.classList.remove('in-game');
    this.engine.playResult(!game.over.died);
    showResults(game, game.over.died);
  }

  pressAttack(perfMs) {
    if ((this.scene !== 'countin' && this.scene !== 'playing') || !this.game) return null;
    return this.game.combat.pressAttack(perfMs);
  }

  // ---------- input ----------
  _bindInput() {
    const isTyping = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); };
    window.addEventListener('keydown', (e) => {
      const inGame = this.scene === 'countin' || this.scene === 'playing';
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (inGame) { e.preventDefault(); this.pause(); }
        else if (this.scene === 'paused') { e.preventDefault(); this.resume(); }
        return;
      }
      if (!inGame || isTyping(e)) return;
      if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'KeyK') {
        e.preventDefault();
        if (!e.repeat) this.pressAttack(e.timeStamp);
      } else if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) {
        e.preventDefault();
        this.keys.add(e.code);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.touchDir = 0; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.pause(); if (this.previewing) this.stopPreview(); } });
  }

  _bindUi() {
    $('btn-resume').addEventListener('click', () => this.resume());
    $('btn-quit').addEventListener('click', () => this.stopToMenu());
    $('btn-menu').addEventListener('click', () => this.stopToMenu());
    $('btn-again').addEventListener('click', () => this.startGame({}));

    const hold = (id, dir) => {
      const el = $(id);
      const down = (e) => { e.preventDefault(); this.touchDir = dir; el.classList.add('down'); try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } };
      const up = () => { if (this.touchDir === dir) this.touchDir = 0; el.classList.remove('down'); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    };
    hold('t-left', -1);
    hold('t-right', 1);
    const atk = $('t-attack');
    atk.addEventListener('pointerdown', (e) => { e.preventDefault(); atk.classList.add('down'); this.pressAttack(e.timeStamp); });
    const atkUp = () => atk.classList.remove('down');
    atk.addEventListener('pointerup', atkUp); atk.addEventListener('pointercancel', atkUp); atk.addEventListener('pointerleave', atkUp);
    $('t-pause').addEventListener('click', () => this.pause());
    $('rotate-tip-close').addEventListener('click', () => document.body.classList.add('tip-dismissed'));
  }

  get moveDir() {
    const k = this.keys;
    const kd = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    return kd !== 0 ? kd : this.touchDir;
  }

  // ---------- main loop ----------
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const g = this.game;
    let vst = 0;

    if (g && (this.scene === 'countin' || this.scene === 'playing')) {
      vst = this.conductor.update(); // emits beat events in order
      if (this.scene === 'countin' && vst >= 0) this.scene = 'playing';
      g.update(vst, dt, this.moveDir, this.scene);
      if (g.over) this.endGame();
    } else if (g) {
      vst = g.vst;
    }
    this.render(vst, now);
  }

  render(vst, now) {
    const ctx = this.ctx;
    ctx.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    const g = this.game;
    if (g) {
      g.draw(ctx, vst);
      drawHud(ctx, g, this.conductor, vst, this.scene, g.songName);
      g.effects.drawFlash(ctx, W, H);
    } else {
      // Decorative idle scene for the menu (not used for any gameplay timing).
      const bpm = this.settings.bpm;
      let t = now / 1000;
      if (this.previewing) t = this.conductor.visualSongTime();
      drawBackground(ctx, 0, t, bpm);
      this.idleLevel.draw(ctx, { x: 0 }, t, bpm);
      this.idlePlayer.draw(ctx, t, bpm, 0);
    }
  }
}

const app = new App();
void app;
