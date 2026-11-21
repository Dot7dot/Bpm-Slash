# BPM Slash 設計規格書

> 本文件由總監（Opus）撰寫，所有實作 agent（Sonnet / Haiku）都必須遵守。
> **語言規範：所有 UI 文字、程式碼註解、文件、commit 訊息只能使用「繁體中文」或「英文」，嚴禁出現任何簡體字。**

---

## 1. 遊戲概要

一款 2D 橫向卷軸節奏動作遊戲。玩家操控一個「拿著劍的小人」，只有三個動作：**向左、向右、攻擊**。

核心賣點：
1. 玩家按下攻擊後，攻擊的「命中瞬間（impact）」**一定落在目前歌曲 BPM 的節拍網格上**。
2. 每一拍切成「**前拍**（正拍，on-beat）」與「**後拍**（反拍，off-beat，八分音符的 "&"）」，攻擊可以落在任一個半拍上，兩種攻擊招式不同，讓慢速歌曲（例如 88 BPM）也有足夠的節奏變化。
3. BPM 可由玩家調整，並可上傳自己的 WAV / MP4 歌曲。預設提供一首原創 88 BPM 歌曲。
4. 關卡中的怪物與地形全部跟著節拍跳動（4/4 拍，每小節四拍，第 1 拍為強拍）。

---

## 2. 參考遊戲與借鑑重點

| 參考遊戲 | 借鑑的機制 | 在本作的落實 |
|---|---|---|
| Hi-Fi Rush | 攻擊自動對拍；按得準有加成；整個世界隨音樂律動 | 攻擊量化到半拍網格；判定越準傷害／分數越高；地形、怪物、背景都跟拍 |
| Crypt of the NecroDancer | 敵人只在拍點上行動；底部節拍條；可匯入自己的音樂並設定 BPM | 敵人的跳躍／移動／攻擊只在拍點觸發；底部節拍軌；自訂歌曲 + BPM + 偏移 |
| Metal: Hellsinger | 對拍傷害倍率、準心節拍提示 | 判定倍率 Perfect ×1.5 / Great ×1.25 / Good ×1.0 / Auto ×0.75 |
| Muse Dash | 橫向卷軸節奏戰鬥、角色揮擊迎面而來的敵人 | 橫向卷軸 + 揮劍戰鬥 |
| Taiko no Tatsujin（咚／咔） | 兩種打擊類型帶來變化 | 前拍斬（重）／後拍刺（輕快）兩種招式 |
| Rhythm Doctor | 反拍、切分音的趣味 | 後拍刺可穿透盾兵的盾牌，鼓勵玩家打反拍 |
| Patapon | 以四拍為一句的指令 | 「小節終結」：同一小節四個前拍都出手觸發終結技 |
| Rhythm Heaven / Thumper | 前一拍預警、下一拍出招的清楚提示 | 敵人與尖刺都在第 3 拍預警、第 4 拍發動 |
| Geometry Dash / Just Shapes & Beats | 地形與陷阱隨音樂脈動 | 地磚隨拍彈跳、節拍尖刺 |
| Friday Night Funkin' | 角色待機時隨拍點頭 | 小人每拍上下擺動，走路步伐鎖定 BPM |
| osu! / DDR / Guitar Hero / A Dance of Fire and Ice | 判定窗口、連擊、評級、延遲校正、歌曲偏移設定 | Perfect/Great/Good/Auto、連擊鏈、S/A/B/C 評級、輸入延遲校正、第一拍偏移 |
| BPM: Bullets Per Minute | 動作被鎖在拍子上 | 揮劍命中瞬間被鎖在半拍網格 |
| Audiosurf / Beat Hazard | 玩家上傳自己的歌曲 | WAV / MP4 上傳 + 自動 BPM 偵測建議 |

---

## 3. 技術選型

- 純 **HTML5 Canvas 2D + Web Audio API**，原生 **ES Modules**，**零外部相依、無建置步驟**。
- 啟動：`npm start` → `node tools/serve.mjs`（零相依靜態伺服器，預設 port 5173，可用 `PORT` 環境變數覆寫）。
  - `tools/serve.mjs` 必須 `export async function startServer({ port = 5173, root } = {})`，回傳 `{ url, port, close() }`；當檔案被直接執行時才自動啟動。`port: 0` 代表隨機可用 port。
  - 必須回傳正確 MIME：`.html .js .mjs .css .json .wav(audio/wav) .mp4(video/mp4) .m4a(audio/mp4) .png .svg`。
- 測試：`npm test` → `node --test tests/`（Node 22 內建 test runner）。
- 邏輯畫布 960×540，CSS 等比縮放並處理 devicePixelRatio。
- `js/core/` 底下的模組必須是**純函式、不得碰 DOM / Web Audio**，才能在 Node 中單元測試。

---

## 4. 目錄與檔案所有權

| 路徑 | 負責 agent | 說明 |
|---|---|---|
| `docs/DESIGN.md` | Opus | 本規格書（實作者不得修改） |
| `index.html`、`css/style.css` | Sonnet-Core | 頁面與選單樣式 |
| `js/main.js` | Sonnet-Core | 啟動、場景狀態機、主迴圈 |
| `js/core/beatMath.js` | Sonnet-Core | 純函式：拍／小節換算、半拍 slot 時間 |
| `js/core/quantizer.js` | Sonnet-Core | 純函式：攻擊量化與判定（§6） |
| `js/core/comboTracker.js` | Sonnet-Core | 純函式：連段偵測 |
| `js/core/tapTempo.js` | Sonnet-Core | 純函式：Tap Tempo |
| `js/core/bpmDetect.js` | Haiku-BPM | 純函式：自動 BPM 偵測（§9.3） |
| `js/audio/conductor.js` | Sonnet-Core | 主時鐘、歌曲時間、拍點事件 |
| `js/audio/audioEngine.js` | Sonnet-Core | AudioContext、載入/解碼、播放、音效合成、節拍器排程 |
| `js/game/*.js` | Sonnet-Core | 玩家、戰鬥、敵人、地形、特效、鏡頭 |
| `js/ui/*.js` | Sonnet-Core | HUD、HTML 選單、結算畫面 |
| `js/debug/debugHook.js` | Sonnet-Core | `window.__BPM_SLASH_DEBUG__`（§10） |
| `tests/*.test.mjs`（除 bpmDetect） | Sonnet-Core | 單元測試 |
| `tests/bpmDetect.test.mjs` | Haiku-BPM | 單元測試 |
| `package.json`、`tools/serve.mjs`、`README.md` | Sonnet-Core | |
| `tools/generate-default-song.mjs` | Haiku-Song | 預設曲合成腳本 |
| `assets/audio/default-88bpm.wav`、`.json` | Haiku-Song | 腳本產物 |
| `.claude/agents/feasibility-reviewer.md` | Haiku-Song | 可行性檢查 agent |
| `.claude/agents/rhythm-sync-auditor.md` | Sonnet-Audit | 節奏對拍檢查 agent |
| `tools/rhythm-audit.mjs` | Sonnet-Audit | 自動化對拍稽核工具 |

`package.json` scripts（由 Sonnet-Core 建立）：
```
"start": "node tools/serve.mjs",
"test": "node --test tests/",
"generate:song": "node tools/generate-default-song.mjs",
"audit:rhythm": "node tools/rhythm-audit.mjs"
```
`"type": "module"`，`"private": true`，**不加任何 dependencies**。

---

## 5. 時間模型（最重要，必須嚴格遵守）

### 5.1 唯一主時鐘
- 唯一可信的時鐘是 `AudioContext.currentTime`（下稱 **audio time**）。
- **禁止**用 `setTimeout`、`setInterval`、`Date.now()` 或累加每幀 `dt` 來推算節拍。`dt` 只能用於與節拍無關的物理（例如玩家走路位移、粒子）。
- 由於 `currentTime` 以音訊區塊為單位跳動，畫面需要平滑時間時，用 `ctx.getOutputTimestamp()` 將 `performance.now()` 換算為 audio time：
  `audioNowSmooth = ts.contextTime + (performance.now() - ts.performanceTime) / 1000`
  （不支援時退回 `ctx.currentTime`）。鍵盤事件使用 `event.timeStamp`（performance.now 時間域）換算成 audio time，比用「處理事件當下的時間」更準。

### 5.2 名詞定義
- `bpm`：使用者設定值，範圍 40–240，可到小數 0.1。
- `beatDur = 60 / bpm`，`halfStep = beatDur / 2`。
- `offsetSec`：使用者設定的「**第一拍偏移**」= 音檔中第 1 拍所在的秒數（預設曲為 0）。
- `beat0AudioTime`：歌曲第 0 拍被「排程播放」的 audio time。
- 音源啟動：`source.start(beat0AudioTime - offsetSec)`；若該時間已過去，改為 `source.start(now, now - (beat0AudioTime - offsetSec))`。
- `outputLatencySec = ctx.outputLatency || ctx.baseLatency || 0`。
- **排程域歌曲時間**（用於排程音效）：`schedSongTime(t) = t - beat0AudioTime`。
- **聽覺域歌曲時間**（用於畫面、判定）：`heardSongTime(t) = t - outputLatencySec - beat0AudioTime`。
- **畫面時間** `visualSongTime = heardSongTime(audioNowSmooth)`。
- **輸入時間** `inputSongTime = heardSongTime(eventAudioTime) - inputCalibrationSec`（使用者「輸入延遲校正」，正值表示玩家習慣按晚，系統會把輸入往前修正）。

### 5.3 拍與小節
- `beatFloat = songTime / beatDur`，`beatIndex = floor(beatFloat)`，`beatPhase = beatFloat - beatIndex`（0..1）。
- `beatInBar = ((beatIndex % 4) + 4) % 4`（0 = 第 1 拍 = 強拍），`barIndex = floor(beatIndex / 4)`。
- **半拍 slot**：整數 `k`，`slotSongTime(k) = k * halfStep`。`k` 為偶數 → **前拍**（第 `k/2` 拍）；`k` 為奇數 → **後拍**。
- 浮點運算時一律由整數 index 乘上步長得到時間，**不得以累加方式**推進，避免漂移。

### 5.4 預備拍（Count-in）
開始遊戲時：`beat0AudioTime = ctx.currentTime + 0.15 + 4 * beatDur`。也就是先有一小節（beat −4 ~ −1）的預備拍，HUD 顯示「1 2 3 4」後「GO!」，節拍器在預備拍一定會響（即使節拍器設定關閉）。

### 5.5 拍點事件
每一幀用 `visualSongTime` 算出 `beatIndex`，若與上一幀不同，對**每一個跨越的整數拍**依序發出 beat event（不可漏拍、不可重複），內容：`{ beatIndex, beatInBar, barIndex, isDownbeat, beatSongTime }`。半拍事件同理（供後拍相關動畫使用）。

### 5.6 音效與節拍器排程
- 使用 lookahead scheduler（Chris Wilson「A Tale of Two Clocks」模式）：每 25 ms 檢查一次，提前 100 ms 把節拍器 click 排在 `beat0AudioTime + n * beatDur`。強拍 click 音高較高。
- 攻擊音效排在 `beat0AudioTime + slotSongTime(k)`（排程域，與音樂在同一條音訊時間線上，所以「聽到」時會與音樂的拍點完全對齊）。

---

## 6. 攻擊量化（核心功能）

### 6.1 `quantizeAttack(params)` 純函式
輸入：
- `inputSongTime`（秒，聽覺域）
- `bpm`
- `mode`：`'half'`（八分：前拍＋後拍，預設）或 `'beat'`（四分：僅前拍）
- `lateGraceSec`：延遲容許，預設 0.040（設定 0 即「嚴格模式」）
- `minSlotIndex`：可選，佇列用，預設 `-Infinity`

演算法：
1. slot 單位永遠是半拍；`'half'` 模式所有整數 k 都可用，`'beat'` 模式只允許偶數 k。
2. `prev` = 時間 ≤ input 的最大可用 k；`next` = 時間 > input 的最小可用 k（用 `Math.floor(input / halfStep + 1e-9)` 這類寫法處理浮點邊界）。
3. 若 `input - slotSongTime(prev) <= lateGraceSec` 且 `prev >= minSlotIndex` → 選 `prev`（稍晚命中，`late = true`）；否則選 `next`。
4. 若選到的 k < `minSlotIndex` → 改為 ≥ `minSlotIndex` 的最小可用 k。
5. `deltaSec = inputSongTime - slotSongTime(chosen)`（負值 = 提早按，正值 = 稍晚）。
6. 判定（以 `|deltaSec|`）：≤ 45 ms → `perfect`；≤ 90 ms → `great`；≤ 140 ms → `good`；其餘 → `auto`（仍會自動對拍命中，只是沒有加成）。
7. 回傳：`{ slotIndex, slotSongTime, half: 'front'|'back', beatIndex, beatInBar, isDownbeat, deltaSec, judgment, late }`。`isDownbeat` = 前拍且 `beatInBar === 0`。

### 6.2 攻擊執行流程
1. 按下攻擊 → 呼叫 `quantizeAttack` → 建立 pending attack。
2. 音效：若 `beat0AudioTime + slotSongTime` 仍在未來 → 排程在該 audio time；若已過去（只會發生在 late 情況或極接近的情況）→ 立即播放。log 中記錄實際的 `scheduledAudioTime` 與理論值 `expectedAudioTime`。
3. 動畫：角色立即進入「前搖（windup）」，進度 = `(visualSongTime - inputSongTime) / (slotSongTime - inputSongTime)`；**`visualSongTime >= slotSongTime` 的第一幀就是 impact frame**：此時才判定 hitbox、扣血、噴特效、記錄 `impactSongTime`。之後收招 `min(0.12, halfStep * 0.8)` 秒。
4. 佇列：最多 2 個尚未命中的攻擊；新攻擊的 `minSlotIndex = 上一個已排定 slot + 1`；第 3 次按鍵忽略。
5. 攻擊期間玩家仍可移動（速度 ×0.6）。

### 6.3 招式
| 招式 | 觸發 | 效果 |
|---|---|---|
| 前拍斬 | 偶數 slot | 橫向重斬，傷害 2，距離 78 px，弧形 120°，擊退 40 px |
| 強拍斬 | 前拍且 `beatInBar === 0` | 傷害 3，距離 96 px，小幅震屏，粒子更多 |
| 後拍刺 | 奇數 slot | 快速突刺，傷害 1，距離 92 px（窄），**可穿透盾兵的盾** |

判定倍率：Perfect ×1.5、Great ×1.25、Good ×1.0、Auto ×0.75（傷害可為小數）。

### 6.4 連段（`comboTracker` 純函式）
- **八分連斬**：連續 4 個 slot `k, k+1, k+2, k+3`（k 為偶數，即「前後前後」）都有攻擊 → 第 4 擊傷害 ×2，距離延伸到 160 px。
- **小節終結**：同一小節的 4 個前拍（`8b, 8b+2, 8b+4, 8b+6`）都有攻擊，且中間沒有任何後拍攻擊 → 第 4 擊放出衝擊波，命中 260 px 內所有敵人，傷害 4。
- **節奏連擊鏈（chain）**：perfect/great/good 讓 chain +1；auto 或受傷讓 chain 歸零。
- 分數：`100 × 判定係數 × min(4, 1 + floor(chain / 10) × 0.5)`，判定係數 perfect 1.0 / great 0.8 / good 0.5 / auto 0.2；連段觸發額外 +500。

---

## 7. 節拍同步的世界（每小節四拍）

### 7.1 共通規則
- 所有世界動畫的相位都由 `visualSongTime` 推導；**離散動作（跳、出招、尖刺升降、生怪）只能在 beat event 觸發**，不得使用隨機計時器。
- 脈動包絡：`pulse = exp(-beatPhase * 5)`；強拍振幅 1.0，其他拍 0.55。
- 「減少閃爍」選項開啟時關閉螢幕閃光與震屏，但保留物件彈跳。

### 7.2 地形
- 地面由 40 px 寬的地磚組成，每塊地磚隨拍向上彈起（`pulse × 振幅`），依 tile index 加微小相位延遲形成漣漪；強拍時地磚邊緣亮起。
- 背景：霓虹城市 / 等化器柱，高度隨 pulse 跳動，強拍時霓虹線閃一下。視差捲動（2 層以上）。
- **節拍尖刺**：第 3 拍（`beatInBar 2`）發光預警，第 4 拍（`beatInBar 3`）升起，下一小節第 1 拍收回。升起期間玩家重疊會受 1 點傷害。
- 關卡往右無限程序生成（以 chunk 為單位，種子固定），左邊界 x = 0。玩家不能跳，所以地面維持可步行（平地＋緩坡即可），尖刺不可太密集，必須留安全落腳處。

### 7.3 敵人
| 敵人 | HP | 行為（全部鎖拍） |
|---|---|---|
| 史萊姆 | 2 | 每拍朝玩家跳一下（跳躍動作占該拍前 45%），著地時擠壓變形。接觸傷害 1 |
| 蝙蝠 | 1 | `y = baseY + sin(beatFloat × π) × 振幅` 上下飛；第 3 拍預警，第 4 拍俯衝撞向玩家 |
| 盾兵 | 4 | 第 1、3 拍前進一步；正面持盾：**前拍攻擊從正面會被格擋（顯示 BLOCK）**，後拍刺可穿透；第 3 拍舉劍並顯示「!」，第 4 拍劈下（前方 60 px hitbox，傷害 1） |

- 所有敵人待機時也要隨 pulse 做 squash & stretch。
- 生怪導演：只在強拍（小節第 1 拍）的 beat event 生怪；依 `barIndex` 查波次表，難度隨歌曲進度上升；前 2 小節不生怪；同時最多 6 隻；生在鏡頭外右側（偶爾左側）。

### 7.4 玩家
- 外觀：火柴人小人（圓頭、身體、手腳）手持一把劍，Canvas 繪製，不用圖片。
- 待機時每拍上下點頭；走路步伐相位鎖定 `beatFloat`（每半拍一步）。
- 操作：`←/→` 或 `A/D` 移動（230 px/s）；`J`、`K` 或 `Space` 攻擊；`Esc` 或 `P` 暫停。手機顯示觸控按鈕（左、右、攻擊）。
- HP 5；被打中後無敵 1 拍（閃爍）並被擊退。HP 歸零 → 結算（失敗）；歌曲播完 → 結算（通關）。

---

## 8. HUD（Canvas 繪製）

- **節拍軌**（底部中央，參考 NecroDancer / Hi-Fi Rush）：刻度從左右兩側往中央的圓環滑入，各顯示前方 2 拍；前拍刻度大、後拍刻度小、強拍刻度最大且換色；中央圓環隨拍脈動；已排定的攻擊 slot 在軌上以劍形圖示標出。
- 判定文字在玩家頭上浮出：`PERFECT / GREAT / GOOD / AUTO` + `前拍 / 後拍 / 強拍`，連段觸發時顯示招式名。
- 左上：愛心血量、分數、chain。右上：BPM、`小節 : 拍`（例如 `12 : 3`）、歌名、歌曲進度條。
- 預備拍時畫面中央大字「1 2 3 4 → GO!」。

---

## 9. 選單與設定（HTML 覆蓋層）

### 9.1 主選單／設定
- 歌曲來源：預設曲（88 BPM）或上傳檔案。`<input type="file" accept=".wav,.mp4,.m4a,audio/wav,audio/x-wav,audio/mp4,video/mp4">`。
- 解碼：`ctx.decodeAudioData(arrayBuffer)`；失敗時顯示「無法解碼此檔案，請改用 WAV 或 AAC 編碼的 MP4」。（註：Playwright 內建的 Chromium 沒有 AAC 專利編碼，測試 MP4 時請用 Opus 或 FLAC 音軌的 MP4。）
- BPM：數字欄 + 滑桿（40–240，step 0.1，預設 88）；**Tap Tempo** 按鈕（平均最近 8 次間隔，超過 2 秒沒按就重置）；**自動偵測**按鈕（呼叫 `detectBpm`，顯示建議值，玩家按「套用」才生效）。
- 第一拍偏移（ms，0–10000，附 ±10 ms 微調鈕）。
- 輸入延遲校正（ms，−150 ~ +150）。
- 延遲容許（ms，0–100，預設 40；0 = 嚴格模式）。
- 量化模式：八分（前拍＋後拍）／四分（僅前拍）。
- 節拍器開關、音樂音量、音效音量、減少閃爍。
- **試聽對拍**：從頭播放歌曲並疊加節拍器，BPM／偏移改動要即時套用，讓玩家用耳朵確認上傳的歌與 BPM 是否對齊。
- 開始遊戲。
- 設定以 `localStorage` 保存（全部包在 try/catch，讀不到也要能正常運作；上傳的檔案不保存）。
- 預設曲的歌名與 BPM 讀取 `assets/audio/default-88bpm.json`，讀取失敗則用內建預設值（88 BPM、偏移 0）。

### 9.2 結算畫面
通關／失敗、分數、評級（S/A/B/C）、最大 chain、各判定次數、前拍／後拍／強拍命中數、連段次數、「再玩一次」「回選單」。
評級：`(perfect + great) / 總攻擊數` ≥ 0.85 且未死亡 → S；≥ 0.70 → A；≥ 0.50 → B；其他 → C。

### 9.3 `detectBpm(samples, sampleRate, opts)`（Haiku-BPM 負責）
- 輸入：單聲道 `Float32Array`、取樣率。回傳 `{ bpm, confidence, offsetSec }`。
- 作法建議：降取樣 → 能量包絡（約 10 ms hop）→ onset strength（正向差分）→ 在 60–200 BPM 範圍做自相關 → 結果折疊到 70–180 BPM → 以 onset 與網格的相位對齊求 `offsetSec`（第一拍位置，0 ≤ offsetSec < beatDur）。
- 必須是純函式、可在 Node 中測試；長歌曲只分析前 60 秒以控制耗時。

---

## 10. 除錯掛鉤合約（供 rhythm-sync-auditor 使用）

`js/debug/debugHook.js` 永遠安裝 `window.__BPM_SLASH_DEBUG__`：

| 成員 | 說明 |
|---|---|
| `version` | `1` |
| `getState()` | `{ scene: 'menu'|'countin'|'playing'|'paused'|'results', bpm, offsetMs, quantizeMode, lateGraceMs, inputCalibrationMs, songTime, beatFloat, beat0AudioTime, audioNow, outputLatency, songName, songDuration }` |
| `start(opts)` | `opts = { bpm?, offsetMs?, quantizeMode?, lateGraceMs? }`，套用設定後用預設曲（或目前已載入的歌）開始遊戲；回傳 Promise，進入 `countin` 時 resolve |
| `stop()` | 停止並回到選單 |
| `pressAttack()` | 模擬一次攻擊輸入，走與鍵盤完全相同的程式路徑（時間取 `performance.now()`） |
| `setInvincible(bool)` | 稽核時避免死亡 |
| `getAttackLog()` | `[{ id, inputSongTime, slotIndex, slotSongTime, half, isDownbeat, deltaSec, judgment, late, scheduledAudioTime, expectedAudioTime, impactSongTime }]`（`impactSongTime` 在命中前為 `null`） |
| `getBeatLog()` | `[{ beatIndex, beatInBar, barIndex, beatSongTime, firedSongTime }]` |
| `getWorldLog()` | `[{ kind, entityId, beatIndex, beatInBar, beatSongTime, firedSongTime }]`，kind ∈ `slime-hop, bat-telegraph, bat-swoop, guard-step, guard-telegraph, guard-strike, spike-telegraph, spike-up, spike-down, spawn` |
| `getMetronomeLog()` | `[{ beatIndex, scheduledAudioTime, expectedAudioTime }]` |
| `clearLogs()` | 清空所有 log |

每種 log 最多保留 5000 筆（超過丟最舊）。時間欄位單位一律為秒。`firedSongTime` 是觸發當幀的 `visualSongTime`。

---

## 11. 驗收標準

1. 非 late 的攻擊：`|scheduledAudioTime − expectedAudioTime| ≤ 1 ms`；late 的攻擊：`0 < deltaSec ≤ lateGraceSec`。
2. 所有 `slotSongTime` 都是 `halfStep` 的整數倍（誤差 < 1e-6 s）；`'beat'` 模式只會出現偶數 slot；`half` 與 slot 奇偶一致。
3. impact frame：`0 ≤ impactSongTime − slotSongTime ≤ 1 幀`（60 fps 下 ≤ 20 ms；headless 環境容許 ≤ 40 ms）。
4. beat event 不漏拍、不重複，觸發延遲 ≤ 1 幀；強拍每 4 拍一次。
5. 世界事件只在規格指定的拍點觸發（例如 `spike-up` 只會在 `beatInBar 3`、`spawn` 只會在 `beatInBar 0`）。
6. 節拍器：`|scheduledAudioTime − expectedAudioTime| ≤ 1 ms`。
7. 預設曲：鼓的 onset 與 88 BPM 網格平均誤差 ≤ 5 ms；偵測 BPM = 88 ± 0.5。
8. 更改 BPM（例如 72.5、120、150）後以上條件仍成立。
9. 無 console error；一般筆電可維持 60 fps。
10. 全部文字只使用繁體中文或英文。
