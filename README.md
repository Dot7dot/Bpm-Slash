# BPM Slash（拍點斬）

一款在瀏覽器執行的 2D 橫向卷軸節奏動作遊戲。你操控一個拿著劍的火柴人，但這次你不只是戰士，**你也是鼓手**：預設的背景音樂是去鼓伴奏，整首歌沒有任何鼓聲，你的兩個攻擊鍵分別打出**大鼓（KICK）**與**小鼓（SNARE）**，你打出來的就是這首歌的鼓組。每一次攻擊都會吸附到音樂的節奏格線上（BeatSnap 拍點吸附），所以即使你按得不完美，鼓聲仍然會落在拍子上。

靈感來自《Dead as Disco》以節拍吸附為核心的打擊機制，並參考 Hi-Fi Rush、Crypt of the NecroDancer 等節奏遊戲的玩法。本作只借鑑**機制**，遊戲中不使用上述作品的任何素材或名稱。

- 純 HTML5 Canvas 2D + Web Audio API，原生 ES Modules
- 零外部相依、無建置步驟
- 預設附一首原創 88 BPM 去鼓伴奏「霓虹步伐 Neon Step」，也可以上傳自己的 WAV / MP4（建議使用去鼓版伴奏）

設計規格依序見 [`docs/DESIGN.md`](docs/DESIGN.md)（總規格）→ [`docs/DESIGN-BEATSNAP.md`](docs/DESIGN-BEATSNAP.md)（v2，BeatSnap 與戰鬥）→ [`docs/DESIGN-DRUMMER.md`](docs/DESIGN-DRUMMER.md)（v3，玩家就是鼓手；與前兩份衝突時以後者為準）。

## 如何執行

```bash
npm start
```

然後用瀏覽器開啟 <http://localhost:5173>（可用 `PORT=8080 npm start` 更改連接埠）。需要 Node.js 18 以上（開發環境為 Node 22）。

> 由於使用 ES Modules 與 `fetch`，必須透過 HTTP 伺服器開啟，直接雙擊 `index.html` 不會運作。

### 其他指令

| 指令 | 說明 |
|---|---|
| `npm start` | 啟動零相依靜態伺服器（預設 port 5173） |
| `npm test` | 以 Node 內建 test runner 執行 `tests/*.test.mjs` 單元測試 |
| `npm run audit:rhythm` | 以 headless Chromium 自動稽核對拍（需要 Playwright，見下方） |
| `npm run generate:song` | 重新合成預設曲：寫出去鼓版 `assets/audio/default-88bpm.wav` 與 `.json` |

`npm run audit:rhythm` 需要 Playwright。在新的電腦上請先安裝：

```bash
npm i -D playwright && npx playwright install chromium
```

稽核工具常用參數：`--quick`（只跑 88 自動、150 自動、120 嚴格三組）、`--json <path>`（輸出機器可讀報告）、`--shots <dir>`（每組設定存一張截圖）、`--skip-wav`（略過 Part A）、`--skip-browser`（只跑離線檢查）。

### 預設曲的合成

`tools/generate-default-song.mjs` 匯出 `renderSong({ drums = true } = {}) → Float32Array`：

- `npm run generate:song` 寫出的是**去鼓版**（`drums: false`），也就是遊戲預設載入的伴奏，`.json` 內 `"drums": false`。
- 若要在程式中取得含鼓的完整混音，呼叫 `renderSong({ drums: true })`。測試中依賴含鼓版的案例也是這樣做的。

## 操作

| 動作 | 鍵盤 | 手機觸控 |
|---|---|---|
| 向左 / 向右 | `←` `→` 或 `A` `D` | 畫面左下方「◀ ▶」按鈕 |
| 大鼓 KICK「咚」 | `J`、`Space`（空白鍵） | 右下方「咚」按鈕 |
| 小鼓 SNARE「啪」 | `K` | 右下方「啪」按鈕 |
| 暫停 / 繼續 | `Esc` 或 `P` | 上方中央「Ⅱ」按鈕 |

建議手機橫向遊玩；直向時畫面會較小，遊戲中會出現可關閉的提示。

## 你就是鼓手

背景音樂沒有鼓，鼓組完全來自你的攻擊：

- **大鼓 KICK（`J` / `Space` / 「咚」）**：重擊，傷害 ×1.25、擊退大。會被盾兵正面格擋。
- **小鼓 SNARE（`K` / 「啪」）**：快刺，傷害 ×0.8、距離 +20 px。**可穿透盾牌**。
- **齊奏 UNISON**：兩鼓落在同一個格點（同一 tick），第二擊觸發齊奏，該格兩擊傷害各 ×1.5，並加上碎音鈸，畫面顯示「齊奏!」。
- 兩種鼓各自有獨立的佇列（各最多 3 個尚未命中的攻擊），所以同時按兩鍵會落在同一個格點，正是齊奏的來源。

### 鼓組音色（依拍位強弱）

| 拍位 level | 大鼓 KICK | 小鼓 SNARE |
|---|---|---|
| bar（小節強拍，第 1 拍） | 大鼓＋碎音鈸＋低頻轟鳴 | 小鼓＋碎音鈸 |
| half（半小節，第 3 拍） | 飽滿大鼓 | 飽滿小鼓（加拍手） |
| beat（正拍，第 2、4 拍） | 大鼓 | 反拍小鼓（backbeat crack） |
| eighth（後拍，八分 "&"） | 較輕的大鼓 | 鼓邊（rimshot） |
| sixteenth（十六分） | 雙踏 ghost kick | ghost snare／閉合踩鈸 |
| thirtysecond（三十二分） | 極短大鼓滴答 | 踩鈸滴答 |

準拍（PERFECT／GREAT）的聲音會加上重低音與拍擊層，音色飽滿；離拍（GOOD／OFF）音色較薄。

### 招式與傷害

| 招式 | 觸發 | 傷害 | 距離 | 特性 |
|---|---|---|---|---|
| 強拍斬 | bar | 3 | 96 px | 震屏、粒子多 |
| 前拍斬 | half、beat | 2 | 78 px | 大鼓可被盾兵正面格擋 |
| 後拍刺 | eighth | 1.5 | 92 px | 穿透盾牌 |
| 碎拍連刺 | sixteenth、thirtysecond | 0.75 | 72 px | 大鼓可被格擋 |

基礎傷害再乘上**樂器倍率**（大鼓 ×1.25、小鼓 ×0.8）、**判定倍率**（PERFECT ×1.5、GREAT ×1.25、GOOD ×0.6、OFF ×0.4）與齊奏倍率（×1.5）。

### 連段

優先序：小節終結 > 過門重擊 > 八分連斬。

- **八分連斬**：tick `k, k+4, k+8, k+12`（`k` 為 8 的倍數）都有攻擊 → 第 4 擊傷害 ×2、距離 160 px。
- **小節終結**：同一小節的 4 個正拍（第 1、2、3、4 拍）都有攻擊，中間沒有任何非正拍的攻擊 → 第 4 擊放出衝擊波，260 px 內全體敵人受 4 點傷害。
- **過門重擊（fill）**：連續 4 擊以相同格距排列，且最後一擊落在小節強拍 → 該擊變成過門重擊，200 px 內全體敵人受 3 點傷害，並加碎音鈸。連續快速按鍵時，攻擊會一格接一格落在格點上，自然形成鼓的過門。

## 節奏型 GROOVE（鼓手節奏型獎勵）

每個小節的強拍會結算**上一小節**中你打出的鼓點，符合下列節奏型即可獲得獎勵（同一小節只取最高的一種）：

| 節奏型 | 條件（小節內 第 1 / 2 / 3 / 4 拍） | 獎勵 |
|---|---|---|
| 搖滾節奏 Rock Beat | 大鼓在第 1、3 拍，小鼓在第 2、4 拍 | 狂熱 +0.15、分數 +500，「GROOVE! 搖滾節奏」 |
| 四拍大鼓 Four on the Floor | 大鼓連打第 1、2、3、4 拍 | 狂熱 +0.15、分數 +500，「GROOVE! 四拍大鼓」 |
| 反拍 Backbeat | 小鼓只打第 2、4 拍（不滿足上面兩種時） | 狂熱 +0.08、分數 +250，「GROOVE! 反拍」 |

## BeatSnap 拍點吸附

BeatSnap 的目標是：**你按下攻擊後，鼓聲一定落在音樂的格線上**，即使按得稍早或稍晚。

**基本單位**：tick = 三十二分音符。一小節有 32 個 tick，第 1、2、3、4 拍分別是 tick 0、8、16、24。

**落點格（connect grid）**：每拍切成 1、2、4、8 份，即四分、八分、十六分、三十二分。

- 預設「自動」：依 BPM 選出每格不短於約 110 ms 的最細切分。例如 88 BPM 用十六分、150 BPM 用八分、40 BPM 用三十二分。
- 也可在選單「落點切分」中固定為四分、八分、十六分或三十二分。
- **判定格（judge grid）**：一般是八分音符（前拍＋後拍）；選四分時則是四分音符。

**吸附規則**（你按下的時間 `t` 與拍點的關係）：

1. **late（稍晚按）**：剛過某個判定格不久（不超過 **延遲容許**，預設 45 ms，與 PERFECT 判定窗一致）→ 攻擊就算在那個格點上，立即命中。
2. **aimed（瞄準）**：在判定格前不久（約 90 ms 內）按下 → 攻擊算在下一個判定格上。
3. **snap（吸附）**：其餘情況 → 攻擊落在下一個落點格上，並留出一點準備時間（windup）。若下一格是較強的拍，且等待時間很短，會被**節拍磁吸**拉到較強的那一拍。

**判定**與**落點**是分開的：判定衡量你按得準不準，依按下時間與最近判定格的距離計算，≤ 45 ms 為 PERFECT、≤ 90 ms 為 GREAT、≤ 140 ms 為 GOOD，其餘為 OFF。PERFECT 與 GREAT 算準拍；GOOD 與 OFF 算離拍。離拍仍然落在格線上，只是傷害較低（OFF ×0.4、GOOD ×0.6）、音色較薄。

**嚴格模式**：把延遲容許設為 0，攻擊音效會 100% 落在格線上，代價是你必須提早按。

### 誠實說明：輸出延遲

聲音從電腦送到你耳朵之間有一段**輸出延遲**（與音效卡與系統有關）。遊戲無法讓「按下的那一刻就發聲」且「精準排在拍點上」同時成立：

- **提早按**：攻擊聲音會被精確排程在音訊時鐘上的格點時間，與音樂完全對齊。
- **稍晚按（在延遲容許內）**：攻擊會立即發聲並命中該拍點。聲音最多比拍點晚「輸出延遲 + 延遲容許」，與 osu!、DDR 等節奏遊戲「按下即發聲」的做法相同。
- **剛好在拍點前按（不到一個輸出延遲）**：聲音只能立即播放，誤差大約是輸出延遲加 15 ms。這在人耳中仍會被聽成在拍上。

如果你覺得判定總是偏早或偏晚，用選單的**輸入延遲校正**（−150 ~ +150 ms）調整。

## FEVER 狂熱

- 狂熱量表會隨你的準拍累積（PERFECT／GREAT 增加，OFF 減少），招架與連段也會加量，節奏型獎勵同樣會增加狂熱。受傷或長時間不出手則會下降。
- 量表滿後進入**待命**，在**下一個小節的強拍**開始狂熱，持續 2 小節（8 拍）。
- 狂熱期間傷害 ×2、所有打擊都用準拍音色、燈光全開。畫面會顯示「FEVER ×2」橫幅。

## 招架 PARRY

- 敵人預警時，會在身上顯示一個收縮的光圈；光圈收到最小的那一刻，就是敵人出招的拍點。
- 在出招拍（延遲容許內）用任一鼓打出攻擊，就能招架：敵人的攻擊被取消，並暈眩到下一個小節的強拍。暈眩中的敵人受到的傷害 ×2，招架成功獲得 +300 分與狂熱。
- 招架只看節拍，與畫面更新的先後無關。

## 歌曲段落驅動世界

歌曲會依能量分成「低、中、高」強度的段落（預設曲另有人工標註的 intro、verse、chorus、breakdown、final）。段落強度會影響：

- **低**：生怪少、蝙蝠每 2 小節俯衝一次、燈光較暗。
- **中**：一般。
- **高**：生怪多、盾兵與蝙蝠增加、蝙蝠每小節俯衝、燈光全開。

敵人的每一次動作（跳、預警、出招、暈眩）都只在節拍事件上觸發，地形與舞池燈光也都跟著拍子跳動。

## 上傳歌曲與 BPM 設定

1. 在選單按「上傳去鼓伴奏 WAV / MP4」選擇檔案。WAV 最穩定；MP4 需要瀏覽器能解碼其音軌（AAC 或 Opus 通常可行），解碼失敗時會提示改用 WAV 或 AAC 編碼的 MP4。上傳的檔案**不會被保存**，重新整理後需要再上傳。
2. 設定 **BPM**（40 – 240，可到小數點第一位）。可以直接輸入、拖曳滑桿、用 **Tap Tempo**（跟著歌曲連續點擊，取最近 8 次間隔的平均，超過 2 秒沒點就重置），或按 **自動偵測** 取得建議值後再按「套用」。自動偵測的可信度只是參考，請務必用耳朵確認。
3. 設定 **第一拍偏移**（ms）：歌曲檔案中第 1 拍所在的位置，可用 ±10 ms 按鈕微調。
4. 按 **試聽對拍**：從頭播放歌曲並疊加節拍器，調整 BPM 或偏移會即時生效，用耳朵確認是否對齊。
5. 若覺得判定總是偏早或偏晚，用 **輸入延遲校正**。

**建議上傳去鼓伴奏（minus-drum / drumless backing track）**。這樣你打出的鼓才是唯一的鼓，體驗最好。含鼓的歌曲也能玩，但原曲的鼓會和你的鼓互相打架。

其他設定：落點切分（自動／四分／八分／十六分／三十二分）、延遲容許（0–100 ms，預設 45；0 為嚴格模式）、節拍器開關、音樂 / 音效音量、減少閃爍（關閉螢幕閃光與震屏）。設定會存在瀏覽器的 `localStorage`，讀寫失敗時仍可遊玩，只是不會記住設定。已保存的舊設定（例如延遲容許 40 ms）會沿用使用者的值。

## 預設曲

- 歌名：**霓虹步伐 Neon Step（去鼓伴奏版）**（原創）
- BPM：**88**，共 **32 小節**，約 87.3 秒
- 去鼓：只有 bass、pad、lead 與一段上升噪音掃掠，沒有任何打擊樂
- 由 `tools/generate-default-song.mjs` 以程式合成（`npm run generate:song` 可重新產生），產物為 `assets/audio/default-88bpm.wav` 與 `assets/audio/default-88bpm.json`

## 遊戲內容

- **玩家**：火柴人小人，HP 5；被打中後短暫無敵並被擊退。
- **史萊姆**（HP 2）：每拍朝你跳一下。
- **蝙蝠**（HP 1）：隨拍上下飛，第 3 拍預警，第 4 拍俯衝。
- **盾兵**（HP 4）：第 1、3 拍前進；正面持盾，大鼓會被格擋，小鼓與連段可穿透；第 3 拍舉劍，第 4 拍劈下。
- **節拍尖刺**：第 3 拍發光預警，第 4 拍升起，下一小節第 1 拍收回。
- **地形與背景**：迪斯可舞池地磚隨拍亮燈與彈跳，頭頂旋轉鏡球、掃射聚光燈與隨拍點頭的觀眾剪影，強拍時全場亮起。
- **結算**：S / A / B / C 評級。`(PERFECT + GREAT) / 總攻擊數` ≥ 0.85 且未死亡為 S，≥ 0.70 為 A，≥ 0.50 為 B，其餘為 C。結算另列出大鼓、小鼓、齊奏、節奏型次數與擊敗敵人數。

## 參考遊戲

本作借鑑下列遊戲的機制，詳細對照見 `docs/DESIGN.md` §2 與 `docs/DESIGN-BEATSNAP.md` §1。

| 遊戲 | 借鑑重點 |
|---|---|
| **《Dead as Disco》（主要參考）** | BeatSnap 式的攻擊吸附到節拍格、按下即起手但命中在音樂上合理的時刻、打擊音效就是伴奏鼓組、準拍加狂熱、在拍上招架、音樂驅動的敵人與段落 |
| Hi-Fi Rush | 攻擊自動對拍、判定越準越有加成、整個世界隨音樂律動 |
| Crypt of the NecroDancer | 敵人只在拍點行動、底部節拍軌、可匯入自己的音樂並設定 BPM 與偏移 |
| Metal: Hellsinger | 對拍傷害倍率與準心節拍提示 |
| Muse Dash | 橫向卷軸節奏戰鬥，揮擊迎面而來的敵人 |
| Taiko no Tatsujin（太鼓達人） | 兩種打擊類型（咚／咔）帶來變化，本作對應大鼓與小鼓 |
| Rhythm Doctor | 反拍與切分音的趣味，小鼓可穿透盾兵 |
| Patapon | 以四拍為一句的指令，本作對應「小節終結」 |
| Rhythm Heaven | 前一拍預警、下一拍出招的清楚提示 |
| Geometry Dash | 地形與陷阱隨音樂脈動，節拍尖刺 |
| Friday Night Funkin' | 角色待機時隨拍點頭，走路步伐鎖定 BPM |
| osu! / DDR | 判定窗口、連擊、評級、延遲校正與歌曲偏移設定 |
| BPM: Bullets Per Minute | 動作被鎖在拍子上，揮劍命中被鎖在半拍網格 |
| Audiosurf | 玩家上傳自己的歌曲，並以 BPM 偵測作為建議 |

## 品質檢查（Claude Code agents）

專案在 `.claude/agents/` 提供兩個 Claude Code 子代理，兩者都只回報、不修改遊戲原始碼：

- **`feasibility-reviewer`（可行性審查）**：以 headless Chromium 實際啟動遊戲，檢查頁面載入、預設去鼓曲與 WAV / MP4 上傳、選單控制項（含落點切分與延遲容許 45 ms）、鍵盤（J／Space 大鼓、K 小鼓）與觸控、手機版面、通關與失敗流程、齊奏／節奏型／狂熱／招架的可見性、效能、localStorage 失敗情境與文字語言規範。適合在功能變更後使用。
- **`rhythm-sync-auditor`（節奏對拍稽核）**：執行單元測試與 `npm run audit:rhythm`，並靜態檢查時間相關程式碼，確認攻擊、節拍事件、敵人與地形、節拍器都精準落在 BPM 網格上，回報實測數字與修正建議。適合在修改時間、音訊、BeatSnap、戰鬥、敵人或節奏型程式後使用。

呼叫方式：在 Claude Code 中直接說明需求並指定代理，例如「請使用 `feasibility-reviewer` 審查目前的選單與手機版面」或「請使用 `rhythm-sync-auditor` 稽核對拍」，Claude Code 會以對應的 subagent 執行。

### 節奏稽核工具的主要檢查（`tools/rhythm-audit.mjs`）

- **Part A（離線分析去鼓背景音樂）**：貝斯與旋律音符的起點對齊八分音符網格，平均誤差 ≤ 5 ms；獨立估計 tempo，88 或其兩倍 176 都視為 88。
- **B1 網格規則**：tick 為整數、connect 時間 = tick × beatDur / 8、snap 落在落點格倍數、late／aimed 落在判定格倍數、level／half／weight 正確。
- **B2 音效排程**：snap 與 aimed 不得 clamp 且誤差 ≤ 1 ms（aimed 只在非嚴格模式下容許 clamp，並有上限）；late 容許 clamp 誤差 ≤ 輸出延遲 + 延遲容許；嚴格模式無 clamp 與 late；排程時間不早於當下。
- **B3 BeatSnap 參考實作**：每一擊的 tick、rule、magnet、judgment 與 `docs/DESIGN-BEATSNAP.md` §3.2 逐筆一致（含相對磁吸上限、每支鼓獨立佇列、各 ≤ 3 pending、齊奏旗標）。
- **B4 impact 延遲**：命中畫面的時間落在 connect 之後 0 ~ 40 ms（headless 容許）。
- **B5 拍點事件**：beat event 連續不漏拍、拍與小節索引正確、延遲 ≤ 40 ms。
- **B6 世界事件**：只在規定拍位觸發（spawn、spike、bat、guard 等）；groove 與 fever 只在 beatInBar 0；fever-start／fever-end 成對、相隔 8 拍；parry 在出招拍；enemy-stun 可在任意拍；groove 以獨立實作重算逐小節比對。
- **B7 節拍器**：排程誤差 ≤ 1 ms 且連續。
- **B8 錯誤**：無 console error 與 page error。
- **B9 離線渲染**：以 OfflineAudioContext 渲染鼓組的每個 `HIT_INSTRUMENTS × HIT_LEVELS × {onBeat, off}`，以及齊奏、過門、連段、招架、狂熱與節拍器 click，真實發聲與排程時間差 ≤ 2 ms。
- **B10 響度與起音**：每支鼓的響度順序為 bar > half ≥ beat > eighth > sixteenth > thirtysecond，每個 level 的 onBeat > off；反應音（招架確認、受擊）為柔和起音，不產生離格瞬態。

## 時間模型

唯一的主時鐘是 `AudioContext.currentTime`。畫面用 `getOutputTimestamp()` 換算成聽覺時間，鍵盤事件用 `event.timeStamp` 換算。節拍事件、敵人動作、尖刺、生怪與招架判定都只在歌曲時間的節拍上觸發；不使用 `setTimeout` / `Date.now()` / 累加 `dt` 推算節拍。節拍器的 lookahead 排程器只用計時器來「喚醒」，排程時間一律由音訊時鐘計算。詳見 `docs/DESIGN.md` §5。

## 專案結構

```
index.html                  頁面骨架：選單（含玩法說明）、暫停、結算、觸控按鈕、手機直向提示
css/style.css               霓虹風格樣式
docs/                       設計規格（DESIGN.md → DESIGN-BEATSNAP.md → DESIGN-DRUMMER.md）
package.json                npm 指令
assets/audio/               預設去鼓曲（wav 與 json）
js/main.js                  啟動、場景狀態機、主迴圈、輸入、畫面尺寸
js/core/                    純函式（不碰 DOM / Web Audio，可在 Node 測試）
  beatMath.js               拍 / 小節 / tick 換算、脈動包絡
  beatSnap.js               BeatSnap 吸附與判定（tick、落點格、判定格）
  clockMath.js              聽覺域時間換算
  comboTracker.js           連段偵測、連擊鏈、分數、評級、狂熱量表
  groove.js                 鼓手節奏型（搖滾／四拍大鼓／反拍）判定
  songMap.js                歌曲能量地圖與段落強度
  tapTempo.js               Tap Tempo
  bpmDetect.js              自動 BPM 偵測
  rng.js                    種子亂數
js/audio/
  audioEngine.js            AudioContext、解碼、播放、音效入口、節拍器排程
  conductor.js              主時鐘、歌曲時間、拍點事件
  sfxVoices.js              鼓組音色（大鼓、小鼓）、連段與招架音色
js/game/
  combat.js                 兩個攻擊佇列、排程鼓聲、命中、齊奏、招架判定
  player.js                 玩家動畫與移動
  enemies.js                史萊姆、蝙蝠、盾兵與預警光圈
  game.js                   遊戲流程、狂熱、節奏型、世界事件
  level.js                  地形、地磚與節拍尖刺
  disco.js                  舞池、鏡球、聚光燈、觀眾
  background.js             霓虹城市背景
  effects.js                特效與浮動文字
  camera.js                 鏡頭
  constants.js              顏色與共用常數
js/ui/
  menu.js                   選單與表單綁定
  hud.js                    遊戲內 HUD（Canvas 繪製，含雙鼓譜線與節拍軌）
  results.js                結算畫面
  settings.js               設定存取（localStorage）
js/debug/debugHook.js       window.__BPM_SLASH_DEBUG__（供稽核工具使用）
tools/
  serve.mjs                 零相依靜態伺服器
  generate-default-song.mjs 預設去鼓曲合成腳本（renderSong）
  rhythm-audit.mjs          自動化對拍稽核（Playwright）
tests/                      Node 單元測試（*.test.mjs）
.claude/agents/             品質檢查代理（feasibility-reviewer、rhythm-sync-auditor）
```

## 語言規範

所有介面文字、程式註解與文件只使用繁體中文或英文，不使用簡體字。
