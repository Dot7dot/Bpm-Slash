# BPM Slash（拍點斬）

一款在瀏覽器執行的 2D 橫向卷軸節奏動作遊戲。你操控一個拿著劍的火柴人，只有三個動作：**向左、向右、攻擊**。
怪物、地磚、尖刺與背景全部跟著 4/4 拍脈動（每小節四拍，第 1 拍為強拍）；攻擊的「命中瞬間」則被鎖在歌曲 BPM 的半拍格線上。

- 純 HTML5 Canvas 2D + Web Audio API，原生 ES Modules
- 零外部相依、無建置步驟
- 預設附一首原創 88 BPM 歌曲「霓虹步伐 Neon Step」，也可以上傳自己的 WAV / MP4

完整設計規格見 [`docs/DESIGN.md`](docs/DESIGN.md)。

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
| `npm run generate:song` | 重新合成預設曲 `assets/audio/default-88bpm.wav` 與 `.json` |

`npm run audit:rhythm` 需要 Playwright。在新的電腦上請先安裝：

```bash
npm i -D playwright && npx playwright install chromium
```

## 操作

| 動作 | 鍵盤 | 手機觸控 |
|---|---|---|
| 向左 / 向右 | `←` `→` 或 `A` `D` | 畫面左下方「◀ ▶」按鈕 |
| 攻擊 | `J`、`K` 或 `空白鍵` | 右下方「斬」按鈕 |
| 暫停 / 繼續 | `Esc` 或 `P` | 上方中央「Ⅱ」按鈕 |

建議手機橫向遊玩；直向時畫面會較小，遊戲中會出現可關閉的提示。

## 前拍 / 後拍系統

每一拍被切成兩個「半拍 slot」：

- **前拍**（正拍，on-beat）：整數拍上的 slot
- **後拍**（反拍，off-beat，八分音符的 "&"）：兩拍中間的 slot

按下攻擊後，系統會把你的輸入吸附到最近的可用 slot（半拍格線），命中瞬間（hitbox、傷害、特效）就發生在該 slot 的時間點。

| 招式 | 觸發 | 效果 |
|---|---|---|
| 前拍斬 | 前拍（偶數 slot） | 橫向重斬，傷害 2，距離 78 px |
| 強拍斬 | 前拍且為小節第 1 拍 | 傷害 3，距離 96 px，小幅震屏 |
| 後拍刺 | 後拍（奇數 slot） | 快速突刺，傷害 1，距離 92 px，**可穿透盾兵的盾** |
| 八分連斬 | 連續 4 個半拍都有攻擊（前後前後） | 第 4 擊傷害 ×2，距離 160 px |
| 小節終結 | 同一小節的 4 個前拍都出手，中間沒有後拍 | 第 4 擊放出衝擊波，260 px 內全體敵人受到 4 點傷害 |

**判定窗口**（依命中與拍點的誤差）：

| 判定 | 誤差 | 傷害倍率 |
|---|---|---|
| PERFECT | ≤ 45 ms | ×1.5 |
| GREAT | ≤ 90 ms | ×1.25 |
| GOOD | ≤ 140 ms | ×1.0 |
| AUTO | 其餘 | ×0.75（仍會自動對拍命中，只是沒有加成） |

同時最多排定 2 個尚未命中的攻擊；第 3 次按鍵會被忽略。

## 攻擊如何鎖在拍點上（誠實說明）

攻擊的「聲音」與「命中」分別處理，兩者的行為如下：

- **提早按**：攻擊音效會被精確排程在音訊時鐘上的拍點時間，聲音與音樂對齊。
- **剛好在拍點或稍晚按**（晚於拍點不超過 **延遲容許**，預設 40 ms）：攻擊會立即發出聲音並命中該拍點。實際聲音最多比拍點晚「輸出延遲 + 延遲容許」，這與 osu!、DDR 等節奏遊戲「按下即發聲」的做法相同。
- **晚於延遲容許**：攻擊會等到下一個半拍 slot 才出手。

**嚴格模式**：把延遲容許設為 0，即可保證攻擊音效 100% 落在網格上，代價是你必須提早按。

延遲容許與輸入延遲校正都可以在選單中調整。

## BPM、偏移與上傳歌曲

1. 在選單按「上傳 WAV / MP4」選擇檔案（解碼失敗請改用 WAV 或 AAC 編碼的 MP4）。上傳的檔案**不會被保存**，重新整理後需要再上傳。
2. 設定 **BPM**（40 – 240，可到小數點第一位）。可以直接輸入、拖曳滑桿、用 **Tap Tempo**（跟著歌曲連續點擊，取最近 8 次間隔的平均，超過 2 秒沒點就重置），或按 **自動偵測** 取得建議值後再按「套用」。自動偵測的可信度只是參考，請務必用耳朵確認。
3. 設定 **第一拍偏移**（ms）：歌曲檔案中第 1 拍所在的位置，可用 ±10 ms 按鈕微調。
4. 按 **試聽對拍**：從頭播放歌曲並疊加節拍器，調整 BPM 或偏移會即時生效，用耳朵確認是否對齊。
5. 若覺得判定總是偏早或偏晚，用 **輸入延遲校正**（−150 ~ +150 ms；正值表示你習慣按得晚，系統會把輸入往前修正）。

其他設定：量化模式（八分 = 前拍＋後拍；四分 = 僅前拍）、節拍器開關、音樂 / 音效音量、減少閃爍（關閉螢幕閃光與震屏）。設定會存在瀏覽器的 `localStorage`（讀寫失敗時仍可遊玩，只是不會記住設定）。

## 預設曲

- 歌名：**霓虹步伐 Neon Step**（原創）
- BPM：**88**，共 **32 小節**
- 由 `tools/generate-default-song.mjs` 以程式合成（`npm run generate:song` 可重新產生），產物為 `assets/audio/default-88bpm.wav` 與 `assets/audio/default-88bpm.json`

## 遊戲內容

- **玩家**：火柴人小人，HP 5；被打中後短暫無敵並被擊退。
- **史萊姆**（HP 2）：每拍朝你跳一下。
- **蝙蝠**（HP 1）：隨拍上下飛，第 3 拍預警，第 4 拍俯衝。
- **盾兵**（HP 4）：第 1、3 拍前進；前拍攻擊從正面會被格擋（BLOCK），後拍刺可穿透；第 3 拍舉劍，第 4 拍劈下。
- **節拍尖刺**：第 3 拍發光預警，第 4 拍升起，下一小節第 1 拍收回。
- **地形與背景**：地磚隨拍彈跳並形成漣漪，強拍時邊緣亮起；霓虹城市與等化器柱也跟著跳動。
- **結算**：S / A / B / C 評級，`(PERFECT + GREAT) / 總攻擊數` ≥ 0.85 且未死亡為 S，≥ 0.70 為 A，≥ 0.50 為 B，其餘為 C。

## 參考遊戲

本作借鑑下列遊戲的機制，詳細對照見 `docs/DESIGN.md` §2。

| 遊戲 | 借鑑重點 |
|---|---|
| Hi-Fi Rush | 攻擊自動對拍、判定越準越有加成、整個世界隨音樂律動 |
| Crypt of the NecroDancer | 敵人只在拍點行動、底部節拍軌、可匯入自己的音樂並設定 BPM 與偏移 |
| Metal: Hellsinger | 對拍傷害倍率與準心節拍提示 |
| Muse Dash | 橫向卷軸節奏戰鬥，揮擊迎面而來的敵人 |
| Taiko no Tatsujin（太鼓達人） | 兩種打擊類型（咚／咔）帶來變化，本作對應前拍斬與後拍刺 |
| Rhythm Doctor | 反拍與切分音的趣味，後拍刺可穿透盾兵 |
| Patapon | 以四拍為一句的指令，本作對應「小節終結」 |
| Rhythm Heaven | 前一拍預警、下一拍出招的清楚提示 |
| Geometry Dash | 地形與陷阱隨音樂脈動，節拍尖刺 |
| Friday Night Funkin' | 角色待機時隨拍點頭，走路步伐鎖定 BPM |
| osu! / DDR | 判定窗口、連擊、評級、延遲校正與歌曲偏移設定 |
| BPM: Bullets Per Minute | 動作被鎖在拍子上，揮劍命中被鎖在半拍網格 |
| Audiosurf | 玩家上傳自己的歌曲，並以 BPM 偵測作為建議 |

## 品質檢查（Claude Code agents）

專案在 `.claude/agents/` 提供兩個 Claude Code 子代理，兩者都只回報、不修改遊戲原始碼：

- **`feasibility-reviewer`（可行性審查）**：以 headless Chromium 實際啟動遊戲，檢查頁面載入、預設曲與 WAV / MP4 上傳、選單控制項、鍵盤與觸控、手機版面、通關與失敗流程、效能、localStorage 失敗情境與文字語言規範。適合在功能變更後使用。
- **`rhythm-sync-auditor`（節奏對拍稽核）**：執行單元測試與 `npm run audit:rhythm`，並靜態檢查時間相關程式碼，確認攻擊、節拍事件、敵人與地形、節拍器都精準落在 BPM 網格上，回報實測數字與修正建議。適合在修改時間、音訊、量化、戰鬥或敵人程式後使用。

呼叫方式：在 Claude Code 中直接說明需求並指定代理，例如「請使用 `feasibility-reviewer` 審查目前的選單與手機版面」或「請使用 `rhythm-sync-auditor` 稽核對拍」，Claude Code 會以對應的 subagent 執行。

## 時間模型

唯一的主時鐘是 `AudioContext.currentTime`。畫面用 `getOutputTimestamp()` 換算成聽覺時間，鍵盤事件用 `event.timeStamp` 換算。節拍事件、敵人動作、尖刺與生怪都只在節拍事件上觸發；不使用 `setTimeout` / `Date.now()` / 累加 `dt` 推算節拍。節拍器的 lookahead 排程器只用計時器來「喚醒」，排程時間一律由音訊時鐘計算。詳見 `docs/DESIGN.md` §5。

## 專案結構

```
index.html                  頁面骨架：選單、暫停、結算、觸控按鈕、手機直向提示
css/style.css               霓虹風格樣式（含選單底部操作列）
docs/DESIGN.md              設計規格書（實作者必須遵守）
package.json                npm 指令
assets/audio/               預設曲（wav 與 json）
js/main.js                  啟動、場景狀態機、主迴圈、輸入、畫面尺寸
js/core/                    純函式（不碰 DOM / Web Audio，可在 Node 測試）
  beatMath.js               拍 / 小節 / 半拍 slot 換算、脈動包絡
  clockMath.js              聽覺域時間換算
  quantizer.js              攻擊量化與判定
  comboTracker.js           連段偵測、連擊鏈、分數、評級
  tapTempo.js               Tap Tempo
  bpmDetect.js              自動 BPM 偵測
  rng.js                    種子亂數
js/audio/
  audioEngine.js            AudioContext、解碼、播放、音效合成、節拍器排程
  conductor.js              主時鐘、歌曲時間、拍點事件
  sfxVoices.js              攻擊與節拍器音色
js/game/                    玩家、戰鬥、敵人、地形、背景、特效、鏡頭、遊戲流程
js/ui/
  menu.js                   選單與表單綁定
  hud.js                    遊戲內 HUD（Canvas 繪製）
  results.js                結算畫面
  settings.js               設定存取（localStorage）
js/debug/debugHook.js       window.__BPM_SLASH_DEBUG__（供稽核工具使用）
tools/
  serve.mjs                 零相依靜態伺服器
  generate-default-song.mjs 預設曲合成腳本
  rhythm-audit.mjs          自動化對拍稽核（Playwright）
tests/                      Node 單元測試
.claude/agents/             品質檢查代理（feasibility-reviewer、rhythm-sync-auditor）
```

## 語言規範

所有介面文字、程式註解與文件只使用繁體中文或英文，不使用簡體字。
