# BPM Slash v3：玩家就是鼓手

> 本文件由總監（Opus）撰寫，建立在 `docs/DESIGN-BEATSNAP.md`（v2）之上；與 v2 衝突之處以本文件為準。
> **語言規範：只能使用繁體中文或英文，嚴禁簡體字。**
> **核心精髓：背景音樂沒有鼓，鼓聲只來自玩家的攻擊。玩家打出來的就是這首歌的鼓組。**

---

## 1. 去鼓背景音樂（Haiku-Song2）

- `tools/generate-default-song.mjs` 重構為可匯出 `renderSong({ drums = true } = {}) → Float32Array`（同樣的固定種子，`drums: true` 的輸出必須與目前 WAV 的取樣逐一相同）。
- CLI 預設輸出**去鼓版**到 `assets/audio/default-88bpm.wav`：移除所有打擊樂（kick、snare、clap、closed/open hat、crash），保留 bass、pad、lead 與 bar 23 的上升噪音掃掠。節拍網格、長度、取樣率完全不變。
- `assets/audio/default-88bpm.json` 保留所有欄位與 `sections`，新增 `"drums": false`，`title` 改為 `"霓虹步伐 Neon Step（去鼓伴奏版）"`。
- 依賴預設曲含鼓的測試（`tests/bpmDetect.test.mjs` 的預設曲案例、`tests/songMap.test.mjs` 的預設曲案例）改用 `renderSong({ drums: true })` 在記憶體中產生含鼓版，或改為適用去鼓版的斷言；測試必須仍然有意義。

## 2. 兩個攻擊鍵 = 兩種鼓

| 鍵 | 樂器 | 鍵盤 | 觸控 | 招式 | 特性 |
|---|---|---|---|---|---|
| 攻擊 A | 大鼓 KICK | `J`、`Space` | 「咚」 | 重擊：傷害 ×1.25、擊退大 | 被盾兵正面格擋 |
| 攻擊 B | 小鼓 SNARE | `K` | 「啪」 | 快刺：傷害 ×0.8、距離 +20 px | **穿透盾牌** |

- 兩種樂器都走同一套 BeatSnap 量化（v2 §3），但**各自有獨立佇列**（各最多 3 個 pending，各自的 `minTick = 該樂器上一擊 tick + 1`）。因此同時按下兩鍵會落在同一個 tick。
- 招式的基礎傷害仍依拍位等級（v2 §6 表：bar 3、half/beat 2、eighth 1.5、更細 0.75），再乘上樂器倍率與判定倍率。v2 中「後拍刺穿透盾牌」的規則改為「小鼓穿透盾牌」。
- **齊奏（UNISON）**：大鼓與小鼓落在同一個 tick → 第二擊觸發齊奏：該 tick 兩擊各 ×1.5，加碎音鈸，顯示「齊奏!」。

## 3. 鼓組音色（Sonnet-Kit）

`SfxVoices#hit(desc, when)` 的 `desc` 新增 `instrument: 'kick' | 'snare'`（缺省為 `'kick'`）。匯出 `HIT_INSTRUMENTS = ['kick', 'snare']`。

| level | 大鼓 KICK | 小鼓 SNARE |
|---|---|---|
| bar | 大鼓＋碎音鈸＋低頻轟鳴 | 小鼓＋碎音鈸 |
| half | 飽滿大鼓 | 飽滿小鼓（加拍手） |
| beat | 大鼓 | 反拍小鼓（backbeat crack） |
| eighth | 較輕的大鼓 | 鼓邊（rimshot） |
| sixteenth | 雙踏 ghost kick | ghost snare／閉合踩鈸 |
| thirtysecond | 極短大鼓滴答 | 踩鈸滴答 |

- 每種樂器內部響度順序：bar > half ≥ beat > eighth > sixteenth > thirtysecond；同 level 下 onBeat > off。
- `combo: 'unison'` 新增：碎音鈸＋兩種鼓的重疊。`'fill'` 時大鼓加落地筒鼓、小鼓加高音筒鼓。
- 起音 ≤ 1.5 ms，渲染 onset 與排定時間差 ≤ 2 ms（兩種樂器全部變體）。
- **混音**：背景音樂已無鼓，鼓組就是節奏組，`HIT_TRIM` 需提高到讓鼓聲成為主角但不壓過旋律；最壞情況（齊奏＋狂熱＋招架疊加在強拍）主輸出峰值 ≤ 0 dBFS（保留零延遲 tanh 防削波）。
- 修正 v2 稽核 F1：`playHurt` 改為柔和起音（≥ 15 ms），不得產生離格瞬態。
- 修正 v2 稽核 F3：新增 `SfxVoices#confirmParry(when)`／`engine.playConfirmParry()`，柔和起音的招架確認尾音；實際招架成功（`Game.onParry`）時播放，按下時已預測到招架的主音色仍保留 parry 層。

## 4. 鼓手節奏型（Groove）獎勵（Sonnet-Drummer，`js/core/groove.js` 純函式）

在每個小節強拍的 beat event 評估**上一小節**內已命中的打擊（依 tick 與 instrument）：

| 節奏型 | 條件（小節內 tick 0/8/16/24 = 第 1/2/3/4 拍） | 獎勵 |
|---|---|---|
| 搖滾節奏 Rock Beat | 大鼓在 0 與 16、小鼓在 8 與 24 | 狂熱 +0.15、分數 +500、「GROOVE! 搖滾節奏」 |
| 迪斯可四拍 Four on the Floor | 大鼓在 0、8、16、24 | 狂熱 +0.15、分數 +500、「GROOVE! 四拍大鼓」 |
| 反拍 Backbeat | 小鼓在 8 與 24（不滿足上面兩種時） | 狂熱 +0.08、分數 +250、「GROOVE! 反拍」 |

- 同一小節只取最高獎勵的一種。world log 記 `groove`（`beatInBar` 必為 0），內容含節奏型名稱。
- `groove.js` 匯出 `evaluateGroove(hits /* [{ tick, instrument }] 皆屬同一小節 */, barIndex) → null | { id, name, fever, score }`，需有單元測試。

## 5. 介面

- HUD 節拍軌改成**兩條鼓譜線**（上：小鼓、下：大鼓），把本小節已打出的鼓點畫成音符，佇列中的打擊畫在精確的 `connectSongTime`，讓玩家看見「自己打出的鼓譜」。
- 判定資訊只保留一處：保留玩家頭上的浮動判定文字，移除左下角重複的判定面板（v2 可行性與總監審查的發現）。
- 招架時「+300」不得與「PARRY!」重疊；`Game.onBeat` 不再自行彈出「FEVER ×2」文字（HUD 已有橫幅）。
- 觸控：兩顆攻擊鍵「咚」（大鼓）與「啪」（小鼓），手機寬度下不得溢出、不得互相遮擋。
- 選單說明與 README 必須清楚寫出：背景音樂是去鼓伴奏，你就是鼓手；建議上傳去鼓伴奏（minus-drum／drumless backing track）以獲得最佳體驗。

## 6. 其他修正（來自 v2 稽核）

- F2：節拍磁吸上限改為相對值：`time(c1) − time(c0) ≤ max(magnetMaxWaitSec, 0.35 × beatDur)`（更新 v2 §3.2 參考實作、單元測試與稽核工具）。
- F4（**總監最終裁定，取代先前的 25 ms**）：「延遲容許」預設值為 **45 ms**，與 PERFECT 判定窗一致。v3 鼓手實測顯示：稍晚 25–45 ms 的按鍵若被吸附到下一個十六分音符，會變成很輕的 ghost note 卻顯示 PERFECT，回饋互相矛盾；對鼓手而言「稍晚按、立即響」才自然。網格吸附用於提早與離拍的按鍵。`beatSnap.js` 的 `DEFAULT_LATE_GRACE` 同步為 0.045。已保存的使用者設定照舊沿用。
- 設定頁顯示偵測到的輸出延遲（`outputLatency + baseLatency`，ms），並提示：「鼓聲要精準落在拍上，可比拍點提早約 N ms 按下；藍牙耳機延遲很大，建議改用有線耳機或喇叭」。

## 6b. v4 更新：曲目選擇、整數 BPM、移除 Tap Tempo 與背景節拍器（總監）

### 新增兩首原創去鼓伴奏（Haiku-Songs）
所有內建曲都是**去鼓伴奏**（玩家就是鼓手），22050 Hz、16-bit、mono，第一拍在 sample 0（offset 0），32 小節，段落與預設曲相同（0–4 intro low、4–12 verse mid、12–20 chorus high、20–24 breakdown low、24–32 final high）。新腳本 `tools/generate-extra-songs.mjs` 匯出 `renderExtraSong(id, { drums = true })`（含鼓版僅供測試／稽核），CLI 寫出去鼓版。`npm run generate:song` 一次產生全部三首。

| id | 標題 | BPM | 調性與風格 | 檔案 |
|---|---|---|---|---|
| `neon-step` | 霓虹步伐 Neon Step（去鼓伴奏版） | 88 | A 小調，既有預設曲 | `assets/audio/default-88bpm.wav/.json` |
| `midnight-funk` | 午夜放克 Midnight Funk（去鼓伴奏版） | 100 | E 多利安放克：切分十六分貝斯、反拍 clav 和弦、銅管感主旋律 | `assets/audio/song-100bpm.wav/.json` |
| `starlight-runner` | 星光跑者 Starlight Runner（去鼓伴奏版） | 112 | D 大調合成器流行：十六分琶音、八分撥弦貝斯、明亮主旋律 | `assets/audio/song-112bpm.wav/.json` |

- 曲目清單 `assets/audio/songs.json`：`[{ "id", "title", "bpm", "json", "wav" }]`，依 BPM 排序，`neon-step` 為預設。
- 每首 JSON 欄位與預設曲相同（`title, bpm, offsetMs, beatsPerBar, bars, durationSec, sampleRate, sections, drums: false`）。

### 選單與遊戲（Sonnet-Menu）
- 「歌曲」區改為**曲目選擇**：三張內建曲卡片（標題、BPM、長度）＋「上傳去鼓伴奏 WAV / MP4」。選內建曲時自動套用該曲的 BPM 與第一拍偏移；記住上次選的曲目（`settings.songId`，上傳檔不保存）。
- **移除 Tap Tempo**：按鈕、說明文字、`js/core/tapTempo.js` 與其測試一併移除。
- **BPM 只能是整數**：數字欄與滑桿 step 1，所有寫入（輸入、自動偵測「套用」、讀取舊設定）一律四捨五入成整數，範圍 40–240；自動偵測的建議值顯示為整數。引擎內部仍可接受小數（供稽核與測試），但所有玩家可見的設定都是整數。
- **移除背景節拍器聲音**：遊戲中（含預備拍）不再播放任何節拍器 click；預備拍只保留畫面上的「1 2 3 4 → GO!」。移除「節拍器」開關與 `settings.metronome`。「試聽對拍」是玩家主動按下、用來確認 BPM 與偏移的工具，保留它的 click。
- 除錯掛鉤：`start({ songId })` 可選內建曲；`getState()` 含 `songId`。

### 稽核調整
- Part A 依 `songs.json` 逐首分析三首內建曲（各自的 BPM），音符起點對八分網格平均誤差 ≤ 5 ms。
- 遊戲中不再有節拍器：B7 改為驗證「遊戲中 metronome log 為空」，並在試聽模式下驗證 click 的排程誤差 ≤ 1 ms（或保留 B9b 離線渲染驗證 click 音色時間）。
- 矩陣新增 `midnight-funk`（100 BPM）與 `starlight-runner`（112 BPM）各一組。

## 7. 除錯掛鉤與稽核

- `pressAttack(instrument = 'kick')`；attack log 每筆新增 `instrument`、`unison`；world log 新增 `groove`。
- 稽核工具：
  - Part A 改為分析去鼓背景音樂（貝斯與旋律的音符起點仍在八分音符網格上），平均誤差 ≤ 5 ms；tempo 估計可以 88 或其倍數 176 判定為 88（記錄說明）。
  - B3 參考實作套用新的磁吸上限與「每樂器獨立佇列」。
  - B9／B10 涵蓋 `HIT_INSTRUMENTS × HIT_LEVELS × {onBeat, off}` 以及 unison、fill、parry、confirmParry（confirm 類只檢查柔和起音：前 10 ms 的 RMS 低於其峰值的 30%）。
  - B6：`groove` 只能在 `beatInBar 0`。
  - Bot 同時使用兩個鍵，包含刻意打出搖滾節奏、四拍大鼓與齊奏。
