// HTML menu wiring (DESIGN section 9.1).
import { roundBpm, beatInfoAt, pulseAt } from '../core/beatMath.js';
import { resolveSubdivision, SUBDIVISION_NAMES } from '../core/beatSnap.js';
import { sanitizeSubdivision } from './settings.js';

const $ = (id) => document.getElementById(id);

export class Menu {
  constructor(app) {
    this.app = app;
    this.detected = null;
    this._rafId = 0;
    this._bind();
    this.syncInputs();
    // The AudioContext only exists after the first user gesture: refresh the latency read-out until/while it does.
    this._latTimer = setInterval(() => this.updateLatencyInfo(), 1000);
  }

  /** Detected output latency (outputLatency + baseLatency, ms) with the DESIGN-DRUMMER section 6 hint. */
  updateLatencyInfo() {
    const el = $('latency-info');
    if (!el) return;
    const c = this.app.engine && this.app.engine.ctx;
    if (!c) { el.textContent = '輸出延遲：尚未偵測（開始試聽或遊戲後顯示）'; return; }
    const ms = Math.round(((Number(c.outputLatency) || 0) + (Number(c.baseLatency) || 0)) * 1000);
    el.textContent = `輸出延遲：約 ${ms} ms。鼓聲要精準落在拍上，可比拍點提早約 ${ms} ms 按下；藍牙耳機延遲很大，建議改用有線耳機或喇叭`;
  }

  show() { $('menu').classList.remove('hidden'); this.syncInputs(); }
  hide() { $('menu').classList.add('hidden'); }

  message(text, isErr = false) {
    const el = $('song-msg');
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
  }

  setSongStatus(text) { $('song-status').textContent = text; }

  /** Render the built-in song cards (title, BPM, length). Safe to call again when the list is replaced. */
  renderSongs(list) {
    const box = $('song-list');
    box.textContent = '';
    for (const e of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'song-card';
      b.dataset.songId = e.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      const dur = Number.isFinite(e.durationSec) ? e.durationSec : (32 * 4 * 60) / e.bpm;
      const name = document.createElement('span'); name.className = 'song-title'; name.textContent = String(e.title).replace(/\s*[（(][^）)]*版[）)]\s*$/, ''); // card shows the short name
      const meta = document.createElement('span'); meta.className = 'song-meta';
      const bpm = document.createElement('b'); bpm.textContent = `${Math.round(e.bpm)} BPM`;
      meta.append(bpm, ` · ${this.app._fmtDur(dur)}`);
      b.append(name, meta);
      b.addEventListener('click', () => this.app.selectSong(e.id, true));
      box.appendChild(b);
    }
    this.setSelectedSong(this._selectedSong || null);
  }

  /** Highlight a built-in song card (null = none, e.g. after an upload). */
  setSelectedSong(id) {
    this._selectedSong = id;
    for (const c of document.querySelectorAll('#song-list .song-card')) {
      const on = c.dataset.songId === id;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /** Push the current settings into the form controls. */
  syncInputs() {
    const s = this.app.settings;
    $('bpm-num').value = String(s.bpm);
    $('bpm-range').value = String(s.bpm);
    $('offset-num').value = String(Math.round(s.offsetMs));
    $('calib-num').value = String(Math.round(s.inputCalibrationMs));
    $('grace-num').value = String(Math.round(s.lateGraceMs));
    for (const r of document.querySelectorAll('input[name="subdiv"]')) r.checked = r.value === String(s.subdivision);
    this.updateSubdivInfo();
    $('chk-reduce').checked = s.reduceFlashing;
    $('music-vol').value = String(s.musicVol);
    $('sfx-vol').value = String(s.sfxVol);
    this.updateLatencyInfo();
  }

  /** 「目前：十六分（每格 170 ms）」 */
  updateSubdivInfo() {
    const s = this.app.settings;
    const d = resolveSubdivision(s.subdivision, s.bpm);
    const ms = Math.round((60000 / s.bpm) / d);
    $('subdiv-info').textContent = `目前：${SUBDIVISION_NAMES[d]}（每格 ${ms} ms）${s.subdivision === 'auto' ? '，自動選擇' : ''}`;
  }

  _changed() { this.updateSubdivInfo(); this.app.settingsChanged(); }

  _bind() {
    const app = this.app;
    const s = () => app.settings;

    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) app.loadUploadedFile(f);
      e.target.value = '';
    });

    // Every BPM write path rounds to an integer in [40, 240] and writes the result back to both controls.
    const setBpm = (v) => {
      s().bpm = roundBpm(v);
      $('bpm-num').value = String(s().bpm);
      $('bpm-range').value = String(s().bpm);
      this._changed();
    };
    $('bpm-num').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < 40 || v > 240) return; // partial typing: wait for 'change'
      s().bpm = roundBpm(v);
      $('bpm-range').value = String(s().bpm);
      if (String(s().bpm) !== e.target.value.trim()) e.target.value = String(s().bpm); // 88.7 -> 89 immediately
      this._changed();
    });
    $('bpm-num').addEventListener('change', (e) => setBpm(parseFloat(e.target.value)));
    $('bpm-range').addEventListener('input', (e) => setBpm(parseFloat(e.target.value)));

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

    $('calib-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { s().inputCalibrationMs = Math.max(-150, Math.min(150, v)); if (s().inputCalibrationMs !== v) e.target.value = String(s().inputCalibrationMs); this._changed(); } });
    $('grace-num').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { s().lateGraceMs = Math.max(0, Math.min(100, v)); if (s().lateGraceMs !== v) e.target.value = String(s().lateGraceMs); this._changed(); } });
    for (const r of document.querySelectorAll('input[name="subdiv"]')) r.addEventListener('change', () => { if (r.checked) { s().subdivision = sanitizeSubdivision(r.value); this._changed(); } });
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
      if (!r || !Number.isFinite(r.bpm) || r.bpm <= 0) throw new Error('no result');
      this.detected = r;
      // The confidence value is only a rough ranking signal, so show a qualitative label instead of a percentage.
      const c = Number(r.confidence) || 0;
      const level = c >= 0.25 ? '高' : c >= 0.12 ? '中' : '低';
      out.textContent = `建議：${roundBpm(r.bpm)} BPM，第一拍 ${Math.round((r.offsetSec || 0) * 1000)} ms（可信度：${level}）。建議按「試聽對拍」用耳朵確認後再套用`;
      $('btn-apply-detect').classList.remove('hidden');
    } catch (e) {
      out.textContent = '自動偵測失敗，請改用手動輸入';
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
