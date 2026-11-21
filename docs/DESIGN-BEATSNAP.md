# BPM Slash v2：BeatSnap 自適應切分打擊系統

> 本文件由總監（Opus）撰寫，**取代 `docs/DESIGN.md` §6（攻擊量化）與 §10/§11 中與攻擊相關的部分**；時間模型（§5）、世界鎖拍原則（§7.1）與其餘章節仍然有效。
> **語言規範：只能使用繁體中文或英文，嚴禁簡體字。**
> 不得在遊戲中使用《Dead as Disco》的名稱、角色、美術或專有名詞；我們借鑑的是「機制」。

---

## 1. 參考：《Dead as Disco》的節奏打擊（研究摘要）

| 觀察到的機制（來源：開發者訪談與評測） | 本作的落實 |
|---|---|
| 按鍵**立即反應**，角色馬上開始動作；但「命中」要等到音樂上合理的時刻才發生 | 按下 → 立刻進入前搖動畫；命中點（connect）被吸附到 2 的冪次切分網格（§3） |
| 每段動畫都標註可伸縮區段，依音樂把動畫拉長或壓縮，讓關鍵影格落在拍上 | 攻擊動畫分「前搖／揮擊／收招」三段，前搖可伸縮，揮擊的最後一格固定落在 connect 時間（§5） |
| 音效與特效疊在同步後的時間軸上，打擊聽起來像音樂的一部分 | 每一擊都是一個在音訊時鐘上精準排程的**鼓組音色**，依拍位強弱選擇大鼓、小鼓、鈸、踩鈸、碎音，形成伴奏（§4） |
| 準拍打擊聲音飽滿＋震屏；離拍打擊較「空」、傷害約 40% | 準拍（Perfect/Great）加上重低音層與震屏；離拍（Off）傷害 ×0.4、音色較薄，但**仍在網格上** |
| 準拍動作累積狂熱量表；失誤或受傷讓連擊歸零 | 「狂熱 FEVER」量表、chain 規則（§6） |
| 在拍上招架敵人的攻擊 | 只有一顆攻擊鍵：攻擊的 connect 剛好落在敵人出招的拍點上 → 招架反擊（§7） |
| 敵人的攻擊節奏與歌曲同步，並依歌曲段落標記事件 | 歌曲地圖（每小節能量 → 低／中／高強度段落）驅動生怪與敵人攻擊頻率（§8） |
| 音樂錄影帶式的呈現：燈光、場景隨音樂律動 | 迪斯可舞池地板、旋轉鏡球、掃射聚光燈、隨拍擺動的觀眾剪影（§9） |

---

## 2. 名詞：tick 與拍位強弱

- **tick** = 32 分音符 = `beatDur / 8`。所有打擊時間都以整數 tick 表示：`tickSongTime(k) = k × beatDur / 8`（由整數乘步長，不得累加）。
- 一小節 = 32 tick（4/4 拍，小節從 beatIndex 為 4 的倍數處開始）。負 tick 用正確的模運算。
- **拍位等級（level）與權重（weight）**：

| 條件（依序判斷） | level | weight | 名稱 |
|---|---|---|---|
| `k mod 32 == 0` | `bar` | 5 | 小節強拍（第 1 拍） |
| `k mod 16 == 0` | `half` | 4 | 半小節（第 3 拍） |
| `k mod 8 == 0` | `beat` | 3 | 正拍（第 2、4 拍） |
| `k mod 4 == 0` | `eighth` | 2 | 後拍（八分 "&"） |
| `k mod 2 == 0` | `sixteenth` | 1 | 十六分 |
| 其他 | `thirtysecond` | 0 | 三十二分 |

- 相容欄位 `half`：level ∈ {bar, half, beat} → `'front'`（前拍）；`eighth` → `'back'`（後拍）；更細 → `'sub'`。

---

## 3. BeatSnap 量化演算法（`js/core/beatSnap.js`，純函式）

### 3.1 兩種網格
- **落點格（connect grid）**：每拍切成 `d` 份，`d ∈ {1, 2, 4, 8}`（全部是 2 的冪次，對應四分、八分、十六分、三十二分）。步長 `S = 8 / d` tick。
  - 設定 `subdivision = 'auto'`（預設）：取 `beatDur / d ≥ 0.11 s` 的**最大** `d`（上限 8）。例：88 BPM → 16 分（S=2）；120 BPM → 16 分；150 BPM → 8 分（S=4）；240 BPM → 8 分；40 BPM → 32 分（S=1）。
  - 設定也可固定為 `1 / 2 / 4 / 8`（選單顯示為「四分／八分／十六分／三十二分」）。
- **判定格（judge grid）**：步長 `J = max(4, S)` tick（一般是八分音符，也就是前拍＋後拍；選四分時是四分音符）。

### 3.2 `beatSnap(params)`
輸入：
- `inputSongTime t`（聽覺域，已含輸入延遲校正）
- `schedNowSongTime s` = `ctx.currentTime − beat0AudioTime`（排程域現在）
- `bpm`、`subdivision`（`'auto'` 或 1/2/4/8）
- `lateGraceSec = 0.045`、`minWindupSec = 0.05`、`marginSec = 0.005`、`magnetMaxWaitSec = 0.2`
- `minTick = -Infinity`（佇列用）、`strict = false`（延遲容許 = 0 時為 true）

步驟（`tickDur = beatDur / 8`，`time(k) = k × tickDur`，取整都要加 `1e-9` 容錯）：
1. `schedMinTick = ceil((s + marginSec) / tickDur)`：最早能精準排程的 tick。
2. `aimWindowSec = min(0.09, J × tickDur / 2)`。
3. `pJ` = ≤ t 的最後一個判定格點，`nJ = pJ + J`。
4. **規則 late**：若 `!strict` 且 `t − time(pJ) ≤ lateGraceSec` 且 `pJ ≥ minTick` → 選 `pJ`（立即命中，`rule = 'late'`）。
5. **規則 aimed**：否則若 `time(nJ) − t ≤ aimWindowSec` 且 `nJ ≥ minTick` 且（`!strict` 或 `nJ ≥ schedMinTick`）→ 選 `nJ`（`rule = 'aimed'`）。
6. **規則 snap**（離拍按鍵，BeatSnap 的核心）：否則
   - `earliest = max(t + minWindupSec, s + marginSec)`；
   - `c0` = 最小的 S 的倍數 tick，滿足 `time(c0) ≥ earliest`、`c0 ≥ minTick`、`c0 ≥ schedMinTick`；
   - **節拍磁吸**：`c1 = c0 + S`；若 `weight(c1) ≥ 3` 且 `weight(c1) > weight(c0)` 且 `time(c1) − time(c0) ≤ magnetMaxWaitSec` → 選 `c1`（`magnet = true`），否則選 `c0`。
   - `rule = 'snap'`。snap 規則選出的點**一定可以精準排程**（不會 clamped）。
7. **判定**（衡量玩家按得準不準，與落點無關）：`a` = 離 t 最近的判定格點，`judgeDeltaSec = t − time(a)`；
   `|Δ| ≤ 0.045 → perfect`，`≤ 0.090 → great`，`≤ 0.140 → good`，否則 `off`。`onBeat = perfect || great`。
8. 回傳：`{ tick, connectSongTime: time(tick), level, weight, half, rule, magnet, late: rule === 'late', judgeTick: a, judgeDeltaSec, judgment, onBeat, beatIndex: floor(tick / 8), beatInBar, barIndex, isDownbeat: tick mod 32 == 0, stepTicks: S, judgeStepTicks: J }`。

### 3.3 佇列與連打
- 最多 3 個尚未命中的攻擊；第 4 次按鍵忽略。新攻擊 `minTick = 上一擊 tick + 1`。
- 連續快速按鍵時，snap 規則會讓攻擊一格接一格落在落點格上 → 自然形成鼓的「過門（fill）」。

---

## 4. 打擊音效＝伴奏鼓組（`js/audio/sfxVoices.js`、`js/audio/audioEngine.js`）

- **主音色在按下的當下就排程**在 `beat0AudioTime + connectSongTime`（排程域）。這是唯一帶有尖銳起音的聲音，它決定節奏感。
- `engine.playHit(desc, expectedAudioTime)` → `{ scheduledAudioTime, ctxNowAtSchedule, clamped }`，`desc = { level, onBeat, fever, combo, parry }`，`combo ∈ null | 'eighth' | 'bar' | 'fill'`。
- `SfxVoices#hit(desc, when)` 必須能在 OfflineAudioContext 中渲染（供稽核）。並匯出 `HIT_LEVELS = ['bar','half','beat','eighth','sixteenth','thirtysecond']`。

| level | 鼓組角色 | 相對音量 |
|---|---|---|
| bar | 大鼓＋碎音鈸＋低頻轟鳴 | 1.00 |
| half | 大鼓＋低音筒鼓 | 0.85 |
| beat | 小鼓／拍手（反拍 backbeat） | 0.80 |
| eighth | 閉合踩鈸＋鼓邊 | 0.60 |
| sixteenth | 輕踩鈸／沙鈴（ghost note） | 0.42 |
| thirtysecond | 極短滴答 | 0.30 |

- **準拍層**（`onBeat` 或 `fever`）：加上 55–70 Hz 短促重低音與噪音「拍擊」層，聲音飽滿；搭配震屏。
- **離拍**：不加重低音層，整體 ×0.7 並偏高頻（聽起來較空），但時間點仍精準在網格上。
- **連段**：`fill` → 加碎音鈸；`bar`（小節終結）→ 大碎音＋鑼；`eighth`（八分連斬）→ 開放踩鈸＋拍手。**招架**：明亮拍手＋金屬「叮」。**狂熱**：加一層閃亮的高頻點綴。
- **反應音效**（命中敵人、格擋、擊倒）是在 impact 幀才知道的事件，必然晚於網格；它們必須是**柔和起音（≥ 15 ms 淡入）、音量低、偏音調的尾音**，不得產生尖銳的離格瞬態，節奏感由主音色負責。
- 所有主音色的起音包絡 ≤ 1.5 ms，渲染後真實 onset 與排定時間差 ≤ 2 ms。
- 響度順序：bar > half ≥ beat > eighth > sixteenth > thirtysecond；同 level 下 onBeat > off。

---

## 5. 動畫伸縮（`js/game/player.js`）

- 按下瞬間進入**前搖**；前搖長度 = `connect − 揮擊長度 − 按下時間`，可伸可縮。
- **揮擊**長度 `min(0.07, S × tickDur × 0.6)`，最後一格（劍刃最遠點）剛好在 `connectSongTime`。
- **收招** `min(0.12, 下一擊前的剩餘時間)`；若佇列中還有攻擊，直接接下一擊的前搖。
- 各 level 招式外觀不同：bar 大幅度斜劈、half/beat 橫斬、eighth 直刺、sixteenth/thirtysecond 短促連刺。

---

## 6. 招式、判定、連擊、狂熱（`js/game/combat.js`、`js/game/game.js`、`js/core/comboTracker.js`）

| 招式 | 觸發 level | 傷害 | 距離 | 特性 |
|---|---|---|---|---|
| 強拍斬 | bar | 3 | 96 | 震屏、粒子多 |
| 前拍斬 | half、beat | 2 | 78 | 被盾兵正面格擋 |
| 後拍刺 | eighth | 1.5 | 92 | 穿透盾牌 |
| 碎拍連刺 | sixteenth、thirtysecond | 0.75 | 72 | 被盾兵正面格擋 |

- 判定倍率：perfect ×1.5、great ×1.25、good ×0.6、off ×0.4。
- 連段（優先序：小節終結 > 過門重擊 > 八分連斬）：
  - **八分連斬**：tick `k, k+4, k+8, k+12`（`k mod 8 == 0`）都有攻擊 → 第 4 擊 ×2、距離 160。
  - **小節終結**：同一小節 4 個正拍（`32b, +8, +16, +24`）都有攻擊，且中間沒有任何非正拍的攻擊 → 第 4 擊放出衝擊波，260 px 內全體 4 傷害。
  - **過門重擊（fill）**：連續 ≥ 4 擊、彼此間隔剛好 S tick，且最後一擊落在小節強拍（`tick mod 32 == 0`）→ 該擊變成過門重擊：200 px 內全體 3 傷害＋碎音鈸。
- chain：perfect/great +1；good 不變；off 或受傷歸零（狂熱期間 off 不歸零）。分數 `100 × 係數(perfect 1 / great 0.8 / good 0.4 / off 0.1) × min(4, 1 + floor(chain/10) × 0.5)`，連段 +500，招架 +300。
- **狂熱 FEVER**（量表 0–1）：perfect +0.06、great +0.04、good 0、off −0.05、招架 +0.25、連段 +0.10；以歌曲時間差計算衰減 0.02/s（受傷後 2 秒內 0.05/s）。
  - 量表滿 → 進入「待命」，在**下一個小節強拍**的 beat event 開始狂熱，持續 8 拍（2 小節），也在小節強拍結束。world log 記 `fever-start`、`fever-end`（`beatInBar` 必為 0）。
  - 狂熱期間：傷害 ×2、所有打擊都用準拍層音色、燈光全開、量表線性歸零。

---

## 7. 招架反擊（只用攻擊鍵）

- 敵人在第 3 拍預警時設定 `e.strikeTick`（出招拍的 tick，即第 4 拍 = `beatIndex × 8`），出招或被招架後清為 `null`。
- 敵人出招的 beat event 處理時，先呼叫 `game.combat.findParry(e)`：若佇列中有攻擊的 `tick === e.strikeTick`、敵人在該招距離 +30 px 內、玩家面向敵人 → 回傳該攻擊，敵人呼叫 `e.parry(game, attack)`：取消出招、暈眩到下一個小節強拍（暈眩中不行動、受到傷害 ×2），顯示「PARRY!」，world log 記 `parry`。此判斷與「同一幀內誰先更新」無關。
- 預警時在敵人身上畫一個收縮光圈，光圈剛好在 `strikeTick` 的時間收到最小，提示玩家在那一拍出手。

---

## 8. 歌曲地圖（`js/core/songMap.js`，純函式）

- `analyzeSongMap(samples, sampleRate, { bpm, offsetSec, beatsPerBar = 4 })` → `{ bars, barEnergy: number[] (0–1), barIntensity: ('low'|'mid'|'high')[], sections: [{ startBar, endBar, intensity }] }`。
- 作法：每小節 RMS → 取 log → 以 2 小節平滑 → 以分位數切三級（≤ 33% low、≥ 67% high）→ 合併成段落，長度不足 2 小節的段落併入前一段。
- 預設曲的 `assets/audio/default-88bpm.json` 另外提供人工標註的 `sections`（含 `name`：intro / verse / chorus / breakdown / final），遊戲優先採用。
- `game.intensityAtBar(barIndex)` 回傳 `'low' | 'mid' | 'high'`（超出範圍回 `'mid'`），供生怪、敵人攻擊頻率、燈光使用：
  - low：生怪少、蝙蝠每 2 小節俯衝一次、燈光暗；
  - mid：一般；
  - high：生怪多、盾兵與蝙蝠增加、蝙蝠每小節俯衝、燈光全開。

---

## 9. 迪斯可舞台呈現（`js/game/level.js`、`js/game/background.js`、新檔 `js/game/disco.js`、`js/ui/hud.js`）

- 地面改為**迪斯可舞池地磚**：每拍切換亮燈圖樣（棋盤、波浪、放射），小節強拍全亮閃一下，圖樣依段落強度切換；保留隨拍彈跳與漣漪。
- 畫面上方一顆**旋轉鏡球**，反光光點隨 `beatFloat` 移動；**聚光燈**以 2 小節為週期掃射；背景**觀眾剪影**每拍點頭，高強度段落在強拍跳起。
- 狂熱期間：彩虹燈、聚光燈加倍、鏡球光點增加。
- HUD：狂熱量表與「FEVER ×2」、節拍軌上顯示落點格小刻度與已排定攻擊的精確位置、判定文字顯示「準拍／離拍」與拍位名稱（強拍／半小節／正拍／後拍／十六分）、chain。
- 「減少閃爍」開啟時關閉全螢幕閃光與震屏、降低燈光閃爍強度。

---

## 10. 除錯掛鉤與 log（取代 DESIGN.md §10 的攻擊部分）

- `getState()` 另含 `subdivision`、`stepTicks`、`judgeStepTicks`、`fever: { value, armed, active, endsAtBeat }`。
- `start(opts)` 另接受 `subdivision`。
- `getAttackLog()` 每筆：`{ id, inputSongTime, tick, connectSongTime, level, weight, half, rule, magnet, late, judgeTick, judgeDeltaSec, judgment, onBeat, kind, combo, parry, fever, stepTicks, judgeStepTicks, sfxClamped, scheduledAudioTime, expectedAudioTime, ctxNowAtSchedule, impactSongTime }`。
- `getWorldLog()` 新增 kind：`fever-start`、`fever-end`（beatInBar 0）、`parry`、`enemy-stun`（任意拍）。

---

## 11. 驗收標準（新增／取代）

1. 每一擊：`tick` 為整數，`connectSongTime == tick × beatDur/8`（誤差 < 1e-6 s）；`rule = 'snap'` 的 tick 是 `stepTicks` 的倍數；`late`/`aimed` 的 tick 是 `judgeStepTicks` 的倍數；`level`、`half`、`isDownbeat` 與 tick 一致。
2. 以 §3.2 的參考實作重算，每一擊的 tick、rule、magnet、judgment 完全一致；tick 嚴格遞增；同時最多 3 個 pending。
3. `rule = 'snap'` 的攻擊：`sfxClamped = false`，且 `|scheduled − expected| ≤ 1 ms`、`scheduled − ctxNowAtSchedule ≥ 0`；嚴格模式下所有攻擊都不得 clamped。
   - **總監裁定（aimed 的物理限制）**：非嚴格模式下，`aimed` 若在拍點前不到「`ctx.currentTime` 與聽覺域的差距」（約一個輸出延遲）才按下，音效只能立即播放（clamped），誤差 ≤ outputLatency + 15 ms；不得為了「網格上精準」而把它延到下一格，因為準確的按鍵反而會晚一整格才出聲，手感更差。這與 osu!、DDR 按下即發聲的做法一致，30 ms 內人耳仍聽成在拍上。`aimed` 在該範圍外一律不得 clamped。
   - `late` 可 clamped，誤差 ≤ outputLatency + lateGrace + 15 ms（headless 的 `currentTime` 以約 10 ms 的區塊前進，所以容許 15 ms）。
4. impact frame 規則沿用 DESIGN.md §11.3。
5. 離線渲染：每個 level × {onBeat, off} 以及 fill、bar、eighth 連段、招架音色，真實 onset 與排定時間差 ≤ 2 ms；響度順序符合 §4。
6. `fever-start` / `fever-end` 只在 `beatInBar 0`；招架只在攻擊 tick 等於敵人 strikeTick 時發生。
7. 自動切分：88 BPM → stepTicks 2；150 BPM → 4；240 BPM → 4；40 BPM → 1。
8. 其餘 DESIGN.md §11 項目（拍點事件、世界事件拍位、節拍器、無 console error、只用繁體中文或英文）持續有效。

---

## 12. 檔案所有權（v2 實作階段）

| Agent | 檔案 |
|---|---|
| Sonnet-Snap | `js/core/beatSnap.js`（新）、`js/core/quantizer.js`（可移除或保留相容）、`js/core/comboTracker.js`、`js/game/combat.js`、`js/game/player.js`、`js/game/game.js`、`js/main.js`、`js/ui/menu.js`、`js/ui/settings.js`、`index.html`、`js/debug/debugHook.js`、`tools/rhythm-audit.mjs`、`tests/`（除 songMap 與 bpmDetect） |
| Sonnet-Drum | `js/audio/sfxVoices.js`、`js/audio/audioEngine.js` |
| Sonnet-Disco | `js/game/disco.js`（新）、`js/game/level.js`、`js/game/background.js`、`js/game/enemies.js`、`js/game/effects.js`、`js/ui/hud.js`、`css/style.css` |
| Haiku-Map | `js/core/songMap.js`（新）、`tests/songMap.test.mjs`、`tools/generate-default-song.mjs`、`assets/audio/default-88bpm.json`（WAV 位元組不可改變） |
| Haiku-Docs（最後） | `README.md` |

跨模組介面以本文件為準：`engine.playHit`（§4）、`SfxVoices#hit` 與 `HIT_LEVELS`（§4）、`game.combat.findParry(e)` 與 `e.strikeTick` / `e.parry()` / `e.stunned`（§7）、`game.intensityAtBar()`（§8）、`game.fever`（§6）、`analyzeSongMap`（§8）。
