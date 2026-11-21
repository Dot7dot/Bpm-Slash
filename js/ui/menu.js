// HTML menu wiring (DESIGN section 9.1).
import { TapTempo } from '../core/tapTempo.js';
import { clampBpm, beatInfoAt, pulseAt } from '../core/beatMath.js';

const $ = (id) => document.getElementById(id);

export class Menu {
  constructor(app) {
    this.app = app;
    this.tap = new TapTempo();
    this.detected = null;
    this._rafId = 0;
    this._bind();
    this.syncInputs();
  }

  show() { $('menu').classList.remove('hidden'); this.syncInputs(); }
  hide() { $('menu').classList.add('hidden'); }

  message(text, isErr = false) {
    const el = $('song-msg');
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
  }

  setSongStatus(text) { $('song-status').textContent = text; }

  /** Push the current settings into the form controls. */
  syncInputs() {
    const s = this.app.settings;
    $('bpm-num').value = String(s.bpm);
    $('bpm-range').value = String(s.bpm);
    $('offset-num').value = String(Math.round(s.offsetMs));
    $('calib-num').value = String(Math.round(s.inputCalibrationMs));
    $('grace-num').value = String(Math.round(s.lateGraceMs));
    for (const r of document.querySelectorAll('input[name="quant"]')) r.checked = r.value === s.quantizeMode;
    $('chk-metronome').checked = s.metronome;
    $('chk-reduce').checked = s.reduceFlashing;
    $('music-vol').value = String(s.musicVol);
    $('sfx-vol').value = String(s.sfxVol);
  }

  _changed() { this.app.settingsChanged(); }

  _bind() {
    const app = this.app;
    const s = () => app.settings;

    $('btn-default-song').addEventListener('click', () => app.useDefaultSong(true));
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) app.loadUploadedFile(f);
      e.target.value = '';
    });

    const setBpm = (v) => {
      s().bpm = clampBpm(v);
      $('bpm-num').value = String(s().bpm);
      $('bpm-range').value = String(s().bpm);
      this._changed();
    };
    $('bpm-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 40 && v <= 240) { s().bpm = clampBpm(v); $('bpm-range').value = String(s().bpm); this._changed(); } });
    $('bpm-num').addEventListener('change', (e) => setBpm(parseFloat(e.target.value)));
    $('bpm-range').addEventListener('input', (e) => setBpm(parseFloat(e.target.value)));

    $('btn-tap').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const bpm = this.tap.tap(e.timeStamp / 1000);
      if (bpm === null) $('tap-info').textContent = '再點一次…';
      else { $('tap-info').textContent = `已點擊 ${this.tap.count} 次 → ${bpm} BPM`; setBpm(bpm); }
    });
    $('btn-tap').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); });

    $('btn-detect').addEventListener('click', () => this.detect());
    $('btn-apply-detect').addEventListener('click', () => {
      if (!this.detected) return;
      setBpm(this.detected.bpm);
      s().offsetMs = Math.max(0, Math.min(10000, Math.round((this.detected.offsetSec || 0) * 1000)));
      $('offset-num').value = String(s().offsetMs);
      this._changed();
      $('btn-apply-detect').classList.add('hidden');
      $('detect-result').textContent = '已套用建議值';
    });

    const setOffset = (v) => {
      s().offsetMs = Math.max(0, Math.min(10000, Math.round(v)));
      $('offset-num').value = String(s().offsetMs);
      this._changed();
    };
    $('offset-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setOffset(v); });
    $('offset-minus').addEventListener('click', () => setOffset(s().offsetMs - 10));
    $('offset-plus').addEventListener('click', () => setOffset(s().offsetMs + 10));

    $('calib-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { s().inputCalibrationMs = Math.max(-150, Math.min(150, v)); this._changed(); } });
    $('grace-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { s().lateGraceMs = Math.max(0, Math.min(100, v)); this._changed(); } });
    for (const r of document.querySelectorAll('input[name="quant"]')) r.addEventListener('change', () => { if (r.checked) { s().quantizeMode = r.value; this._changed(); } });
    $('chk-metronome').addEventListener('change', (e) => { s().metronome = e.target.checked; this._changed(); });
    $('chk-reduce').addEventListener('change', (e) => { s().reduceFlashing = e.target.checked; this._changed(); });
    $('music-vol').addEventListener('input', (e) => { s().musicVol = parseFloat(e.target.value); this._changed(); });
    $('sfx-vol').addEventListener('input', (e) => { s().sfxVol = parseFloat(e.target.value); this._changed(); });

    $('btn-preview').addEventListener('click', () => app.togglePreview());
    $('btn-start').addEventListener('click', () => app.startGame({}));
  }

  async detect() {
    const app = this.app;
    const out = $('detect-result');
    $('btn-apply-detect').classList.add('hidden');
    if (!app.song) { out.textContent = '請先載入歌曲'; return; }
    out.textContent = '分析中…';
    await new Promise((r) => setTimeout(r, 30)); // let the label paint
    try {
      const buf = app.song.buffer;
      const sr = buf.sampleRate;
      const n = Math.min(buf.length, Math.floor(sr * 60));
      const mono = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      const mod = await import('../core/bpmDetect.js');
      const r = mod.detectBpm(mono, sr);
      if (!r || !Number.isFinite(r.bpm)) throw new Error('no result');
      this.detected = r;
      const conf = r.confidence <= 1 ? Math.round(r.confidence * 100) : Math.round(r.confidence);
      out.textContent = `建議：${(Math.round(r.bpm * 10) / 10)} BPM，第一拍 ${Math.round((r.offsetSec || 0) * 1000)} ms（信心 ${conf}%）`;
      $('btn-apply-detect').classList.remove('hidden');
    } catch (e) {
      out.textContent = '自動偵測失敗，請改用 Tap Tempo 或手動輸入';
    }
  }

  // ---------- preview indicator ----------
  setPreviewActive(on) {
    $('btn-preview').textContent = on ? '■ 停止試聽' : '▶ 試聽對拍';
    const dot = $('preview-dot');
    dot.classList.toggle('on', on);
    cancelAnimationFrame(this._rafId);
    if (!on) {
      $('preview-state').textContent = '從頭播放歌曲並疊加節拍器；調整 BPM 或偏移會即時生效';
      dot.style.setProperty('--pulse', '0');
      return;
    }
    const loop = () => {
      const app = this.app;
      if (!app.previewing) return;
      const c = app.conductor;
      const t = c.visualSongTime();
      if (t >= 0) {
        const b = beatInfoAt(t, c.bpm);
        dot.style.setProperty('--pulse', String(pulseAt(b.beatPhase, b.beatInBar)));
        dot.classList.toggle('down', b.beatInBar === 0);
        $('preview-state').textContent = `試聽中　小節 ${b.barIndex + 1} : ${b.beatInBar + 1}　（${c.bpm} BPM，偏移 ${Math.round(c.offsetSec * 1000)} ms）`;
      } else {
        $('preview-state').textContent = '即將開始…';
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }
}
