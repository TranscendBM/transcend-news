# 創見資訊新聞監控系統

> **Transcend Information (2451) News Intelligence**
> Firebase Hosting 前端 + Cloud Functions 自動排程 + Firebase Firestore 雲端儲存
>（GitHub 僅作版本控管；Actions 只保留手動備援觸發）

**正式網址：https://transcend-news.web.app**
（舊網址 transcend-news-tbm.web.app 已 301 轉址到新網址）

---

## 🏗 系統架構

```
使用者瀏覽器
     ↕ 讀取新聞資料（股價 onSnapshot 即時推送）
Firebase Firestore（transcend-news-monitor）← Cloud Functions 排程（transcend-news-tbm / asia-east1）
     ↑                                          股價每 1 分鐘（交易時段）、新聞每 15 分鐘、
Firebase Hosting（站台 transcend-news）          財務每日（月初加密）
GitHub（TranscendBM/transcend-news，版本控管；Actions 僅剩手動備援觸發）
```

## 🤖 零預算 AI 工作流（第一階段）

這個階段不呼叫 Gemini、OpenAI 或其他付費 AI API，也不會自動對外發布內容。

```
新聞排程 → 透明規則判斷相關性與優先順序 → Firestore ai_jobs（私有待辦）
                                                   ↓
公司電腦 ← 本機 Ollama / Gemma 產生摘要與分類 → ai_insights（私有結果）
```

- `functions/intelligence.py`：雲端的免費規則層，只把相關新聞排入待辦；待辦不複製內文。
- `tools/local_ai_worker.py`：在公司電腦上主動取得待辦，只允許連到本機
  `127.0.0.1` / `localhost` 的 Ollama；分析結果不會傳給外部 AI 廠商。
- 沒有 Ollama 時可用 `--rules-only`，先產生規則版摘要，整條流程仍可運作。
- `ai_jobs` 與 `ai_insights` 沒有列入公開集合，現行 Firestore Rules 的預設拒絕
  會阻擋瀏覽器客戶端讀寫；只有 Admin SDK 可存取。

### 公司電腦執行方式

建議使用 Google Application Default Credentials（ADC），避免另外下載長期
Service Account 金鑰：

```bash
gcloud auth application-default login
export FIREBASE_PROJECT_ID=transcend-news-monitor
python3 -m venv .venv-local-ai
.venv-local-ai/bin/pip install -r tools/requirements.txt
```

先以完全不用模型的模式驗證一輪：

```bash
.venv-local-ai/bin/python tools/local_ai_worker.py --once --rules-only
```

已在電腦安裝 Ollama 與本機模型後，再執行：

```bash
ollama pull gemma3:4b
.venv-local-ai/bin/python tools/local_ai_worker.py --once --model gemma3:4b
```

程式會驗證模型輸出、最多重試 3 次，並用 owner lease 避免兩個 worker
同時處理同一筆。新聞文字一律視為不可信外部資料，不會授予模型工具、
系統指令或對外發送能力。

## 📧 DRAM/Flash 產業新聞摘要信（`functions/digest.py`，Phase 1）— ⏸ 已停止

> **2026-10 起已停止寄送**：`tw_dram_digest_job`／`us_dram_digest_job` 已從 `functions/main.py` 移除並刪除雲端排程函式。
> `digest.py` 與 Secret `MAIL2000_SMTP_PASSWORD` 保留；要恢復需把兩個排程函式加回 `main.py` 再部署。以下為停止前的設計紀錄。

（停止前）平日自動寄出重要 DRAM/Flash 產業新聞摘要信（`functions/main.py`
`tw_dram_digest_job` / `us_dram_digest_job`）：

| 排程 | 時間（台灣時間，平日） | 內容 |
|---|---|---|
| `tw_dram_digest_job` | 08:00 | `cat=twMarket`（台灣科技媒體） |
| `us_dram_digest_job` | 16:30 | `cat=usMarket`（美國市場/供應鏈） |

- **Phase 1（目前）**：完全零 API 費用，沿用 `intelligence.py` 既有的規則式
  相關性/重要性評分挑出當次要寄的新聞，摘要文字用 `intelligence.rule_summary()`
  （標題＋來源＋事件類型），不呼叫任何付費 AI
- **進度追蹤採 at-least-once 設計**（`meta/digest_tw`、`meta/digest_us`，兩者
  互相獨立）：查詢窗口固定回溯 `DIGEST_LOOKBACK_HOURS`（96 小時，足夠涵蓋
  週五→週一的排程空檔＋容錯餘裕），是否已寄過改用 `sentIds`（已寄送文章
  id 集合）判斷，而非「上次寄送時間」的移動時間游標。原因：`news_job`
  每 15 分鐘執行一次，跟 08:00/16:30 的摘要排程可能同時觸發；若用「寄信
  成功當下的時間」當游標，`news_job` 在摘要查詢 Firestore **之後**才寫入
  一篇發布日較早的文章時，這篇文章會被永久跳過、再也不會被寄出。改成
  固定回溯窗口＋id 判斷後，只要文章還在窗口內就一定會在下一輪被選到；
  `sentIds` 只在寄信成功後才寫入，寄信失敗**完全不更新** checkpoint，
  並依保留天數／筆數上限裁切，避免文件無限增長
- 新聞連結只允許 `http://`／`https://` 才會出現在信件裡（純文字與 HTML
  版本皆同）；`javascript:`、`data:`、`file:` 等 scheme 一律視為無效網址，
  只顯示新聞標題、不建立可點擊連結——新聞連結來自不可信的外部 RSS
- 寄件透過創見 Mail2000 郵件伺服器（`email.transcend-info.com:587`，STARTTLS）：
  - SMTP 認證帳號 `elvis_cheng@transcend-info.com`（已由 IT 授權 Send As）
  - 實際寄件地址／顯示名稱為「每日產業新聞」`<bm@transcend-info.com>`（收件人也是
    `bm@transcend-info.com`），兩者用 Send As，不是同一組帳密——伺服器規定
    From 必須跟認證帳號一致或有代理寄件授權，否則會被退信（550）
  - 密碼存於 Secret Manager **`MAIL2000_SMTP_PASSWORD`**（不進 repo/程式碼）：
    ```bash
    firebase functions:secrets:set MAIL2000_SMTP_PASSWORD --project transcend-news-tbm
    ```
  - 伺服器 TLS 交握不會附上中介憑證，`functions/sectigo-intermediate.pem`
    補完信任鏈用（僅為公開中介 CA 憑證，非伺服器私鑰）；一律維持完整憑證
    驗證，不設定 `CERT_NONE` 或關閉 `check_hostname`。**殘餘風險**：伺服器
    憑證效期至 2026-08-22，到期換發後不保證沿用同一張中介憑證——屆時若
    出現「unable to verify the first certificate」，需重新用瀏覽器或
    openssl 檢查伺服器送出的鏈並更新這個檔案；在確認前這是已知的營運
    風險（憑證未跟著更新會讓寄信失敗，摘要信可能悄悄停止寄送，不是安全
    漏洞本身）
- 收件人清單、篩選分類等寫在 `digest.py` 開頭的常數（`DIGEST_RECIPIENTS`、
  `DIGEST_CATS`），要調整不用改邏輯
- **之後（Phase 2，未實作）**：若導入公司內本機 Ollama 做真正的 AI 摘要，
  只需替換 `build_digest_email()` 產生的內文來源，篩選/寄信/進度追蹤都不用動；
  本機摘要若當次沒準備好，可退回規則版內容當備援，避免開天窗

## 🗑 新聞保存期限（`functions/news_cleanup.py`，只留本月＋上個月）

`news` 集合只保留**本月＋上個月**的新聞（依 `pubDate` 判斷，以
**Asia/Taipei 日曆月份**計算，不是「最近 N 天」）。截止時間固定是
「上個月 1 日 00:00 台灣時間」，pubDate 嚴格早於這個時間點才刪除，
剛好等於這個時間點不刪除。例如：

- 2026/8/3 執行 → 保留 2026/7/1 00:00（台灣時間）之後的新聞
- 2026/9/1 執行 → 保留 2026/8/1 00:00（台灣時間）之後的新聞
- 2027/1/10 執行 → 保留 2026/12/1 00:00（台灣時間）之後的新聞（跨年）

刻意不使用 Firestore TTL policy——那是額外付費功能，而且刪除時機不可控、
無法先確認範圍——改以每天一次的排程 + 查詢分頁自行實作，行為完全可預測、
有測試覆蓋。

| 項目 | 設定 |
|---|---|
| 排程 | `news_cleanup_job`，每天 02:30（台灣時間，離峰時段） |
| 鎖 | `news_cleanup`（獨立鎖，與 `news` 抓取鎖互不影響） |
| 保存範圍 | 本月＋上個月（Asia/Taipei 日曆月份，`news_cleanup._retention_cutoff()`） |
| 單批操作數 | 每批 150 篇文章 × 3 個集合（news + ai_jobs + ai_insights）= 450 次操作，在 Firestore 單一 WriteBatch 500 次上限內 |
| 單次執行上限 | 最多刪除 2,000 篇（`news_cleanup.MAX_DELETIONS_PER_RUN`），超過的留到下次排程繼續清 |

- 只用 Firestore 查詢（`where(pubDate <) + order_by + limit`）分頁挑出候選
  文件，不會把整個 `news` 集合讀進記憶體篩選。
- 截止時間的計算一律先把 `now`（呼叫端傳入的時間，預設為 UTC）用
  `zoneinfo.ZoneInfo('Asia/Taipei')` 轉成台灣時間 aware datetime，
  再判斷「現在是台灣的哪個日曆月份」——避免 UTC 與台灣時間相差 8 小時
  導致月份邊界判斷錯誤（例如 UTC 16:30 在台灣已經是隔天）。
- `pubDate` 缺失或型別無效的文件一律**跳過並記錄警告**，不冒險刪除。
- 新聞刪除時，會一併刪除相同 article id 的 `ai_jobs`／`ai_insights`
  文件，避免孤兒資料；不影響 `stocks`／`revenue`／`financials`／
  `dividends`／`material`／`daily`／`meta` 等其他集合。
- 重跑具冪等性：已刪除的文件不會再被選中，不需要額外的跨次執行游標。
- 刪除失敗時例外會直接往外拋，Cloud Logging 能看到失敗紀錄，鎖也會在
  `finally` 內釋放，下次排程會重新查詢過期範圍再試一次。

**Dry-run（只統計、不刪除）**：本機或有 Firestore 存取權限的環境可直接呼叫

```python
from news_cleanup import cleanup_expired_news
result = cleanup_expired_news(db, dry_run=True)
# {'dry_run': True, 'matched': 已過期筆數, 'oldest': 最舊過期日期,
#  'newest': 最新過期日期, 'skipped_invalid': 略過的異常 pubDate 筆數}
```

正式排程一律使用 `dry_run=False`；`dry_run=True` 只用於人工確認即將
刪除的範圍，不會執行任何 `delete`。

## 📡 PR 媒體曝光統計（`src/features/news/usePRNews.js`）

PR 媒體戰情分頁的統計卡片（今天/本週/本月）、重點媒體曝光排行、
「創見最新報導」清單與其 Excel 匯出，全部改用獨立的 `usePRNews()` 查詢，
不再從 `useNewsFeed` 的結果裡篩選：

```
where('cat', '==', 'transcend')
where('pubDate', '>=', taipeiMonthStart(now))   // 只查「本月」（Asia/Taipei）
orderBy('pubDate', 'desc')
```

- **只查本月，不是整個 `transcend` 分類。** 最初的版本只有
  `where('cat','==','transcend')`，在正式資料庫實測會直接讀取全部
  **9,519 筆** `transcend` 文件——即使資料庫已經只保留「本月＋上個月」，
  `transcend` 這個分類單獨的文件量仍可能達到數千筆（例如清理排程尚未
  清完舊資料的過渡期），PR 統計卻只需要「本月」的資料，沒有理由連
  上個月都讀進來。加上 `pubDate >=` 條件後，讀取量上限等於「本月全部
  分類新聞則數」（實測當時約 289 則，`transcend` 只是其中一部分，
  隨當月新聞量變動，沒有固定值）。
- **不會 fallback 成不限日期的查詢**：查詢失敗（含缺少 index 時的
  `FAILED_PRECONDITION`）一律顯示明確錯誤狀態，絕不悄悄退回讀全部
  `transcend` 文件的舊行為。
- 這個查詢需要 **Firestore composite index**（`cat` ASC + `pubDate`
  DESC），定義在 repo 根目錄的 `firestore.indexes.json`——**這個檔案
  刻意沒有被 `firebase.json` 引用**，本輪也**沒有部署**，避免日常
  `firebase deploy` 意外對 Firestore 動作，也避免打到錯誤的專案
  （這個 index 屬於 **`transcend-news-monitor`**，不是 Hosting/Functions
  用的 `transcend-news-tbm`）。**部署前端這個改動之前，必須先由擁有
  `transcend-news-monitor` 權限的（舊）帳號建立好這個 index，等狀態
  變成 `Enabled` 之後才能部署**，否則 PR 頁面會持續顯示查詢失敗。
  手動建立步驟：
  1. 用有 `transcend-news-monitor` 權限的帳號登入
     https://console.firebase.google.com/project/transcend-news-monitor/firestore/indexes
  2. 「新增索引」→ Collection ID 填 `news`
  3. 欄位依序加入：`cat`（Ascending）、`pubDate`（Descending）
  4. Query scope 選 `Collection`
  5. 建立後等狀態從 `Building` 變成 `Enabled`（通常幾分鐘，視資料量而定）
  6. 也可以直接複製貼上 `firestore.indexes.json` 的內容用
     `firebase deploy --only firestore:indexes --project transcend-news-monitor`
     部署（需要暫時在 `firebase.json` 加入
     `"firestore": {"indexes": "firestore.indexes.json"}`，用完記得移除，
     避免留在預設設定裡讓日常 `npm run deploy` 誤打到 Firestore）
- 跨月處理：`usePRNews` 內部每分鐘檢查一次是否已經跨入新的台灣日曆
  月份，一旦跨月就取消舊的 `onSnapshot` 監聽器、用新的月份起點重新
  訂閱，不會停留在已經不是「本月」的舊查詢範圍。
- 統計卡片、排行榜、清單、匯出全部共用同一份「先過濾 `isValidTranscendPR`、
  再 `dedupeArticlesByTitle` 去重、再套用搜尋／媒體／情緒篩選」後的
  陣列，確保這幾處看到的數字彼此一致、也跟畫面上實際渲染的新聞則數
  一致。PR 分頁上方的篩選工具列（搜尋／媒體／情緒）是整個 PR 頁面
  唯一的一個篩選工具列，只影響創見 PR 的統計/排行/清單/匯出，不影響
  下面的競品動態（`CompetitorNews` 仍是自己一份獨立的期間篩選，跟這個
  工具列無關，避免同一個工具列的數字被誤讀成涵蓋兩份互不相干的清單）。
- 期間邊界（今天/本週/本月）一律用 `src/utils/dates.js` 的
  `taipeiDayStart`／`taipeiWeekStart`／`taipeiMonthStart`（固定 UTC+8
  換算），跟後端 `news_cleanup.py` 的「本月＋上個月」保留範圍用同一套
  Asia/Taipei 時區定義，不依賴使用者瀏覽器的本地時區。
- 查詢失敗時會顯示明確的錯誤狀態（`⚠ 載入失敗`／`⚠ 資料載入失敗`），
  不會悄悄顯示看起來正常的 0；按頁面上的「重新整理」（或個別面板的
  重試按鈕）可以重新啟動失敗的查詢。

**讀取量修正前後比較**（依 Codex 在正式資料庫的唯讀測試）：

| | 舊設計（只 `cat==transcend`） | 新設計（`cat==transcend` + 本月 `pubDate`） |
|---|---|---|
| 讀取範圍 | 全部 `transcend` 文件 | 本月的 `transcend` 文件 |
| 讀取量（實測當下） | 9,519 筆 | ≤ 289 筆（本月全部分類新聞則數，`transcend` 只是其中一部分） |

實際數量隨當月新聞量變動，不是固定值。

**關於快取，正確的說法（避免過度保證）**：
- IndexedDB／多分頁本機快取通常可以減少重複訪問時的讀取量。
- 但 listener 中斷太久、快取失效，或（如跨月）需要重新建立查詢時，
  仍可能重新計算/重新產生讀取——**不是**「開新分頁就保證 0 次讀取」
  或「一定只計異動文件」，只是實務上通常會比較省。

## ✅ 人工確認媒體曝光（Excel 匯入）

`tools/import_media_exposure.py` 將新聞稿發布後由同仁人工彙整的 Excel
剪報整合進 PR 媒體戰情。人工確認曝光與 RSS 自動新聞是兩種不同資料：

- `media_exposure`：已清理、可在網站顯示的公開唯讀資料。
- `media_exposure_private`：來源檔名、工作表、列號與內部採訪備註；沒有
  列入 Firestore Rules 的公開集合，由檔末預設拒絕規則保護。
- 不寫入 `news`，因此不會被 `news_cleanup_job` 的「本月＋上個月」規則刪除。
- 原始 Excel 永遠只讀，不會被工具修改。
- URL 正規化後用固定雜湊 ID 寫入，重跑同一批檔案不會建立重複文件。
- 同一網址重複出現在不同月份檔案時合併成一筆，私密來源紀錄仍保留每個
  來源位置；媒體名稱會套用少量已確認的別名正規化。

先安裝本機工具相依套件，再執行 dry-run：

```bash
python3 -m venv .venv-tools
.venv-tools/bin/pip install -r tools/requirements.txt

.venv-tools/bin/python tools/import_media_exposure.py \
  "/path/to/Media exposure_07.xlsx" \
  "/path/to/Media exposure_08.xlsx" \
  "/path/to/Media exposure_09.xlsx"
```

未加 `--copy` 時只會輸出筆數、去重數、無效列位置及原因，不連線或寫入
Firestore，也不在報告中輸出新聞標題、內部備註等內容。正式寫入必須同時：

1. 明確指定／確認目標是 `transcend-news-tbm`。
2. 加上 `--copy`。
3. 加上 `--i-approve-writing-to-transcend-news-tbm`。
4. 若 dry-run 有無效列，必須修正原始資料，或用
   `--approve-skipping-invalid N` 精確核准略過的列數；數字不一致就拒絕寫入。

前端 `src/features/pr/useMediaExposure.js` 最多讀取最新 1,000 筆公開資料，
依 `exposureDate` 由新到舊排列。PR 頁面會另外顯示本月人工確認數、已載入
總數、涵蓋媒體與最近紀錄，刻意不把人工確認數靜默加進自動新聞監測統計，
避免同一曝光被誤算兩次。匯出功能也只使用公開欄位，不會包含內部備註。

### 網站上傳（PR 頁面最下方「人工確認曝光」→「⬆ 上傳 Excel」）

不用開指令列，直接在網站選 .xlsx 檔（可一次多個）上傳：

1. **① 檢查檔案**：只解析、不寫入，回報讀到幾列、不重複幾筆、新增／已存在各幾筆、
   各月筆數、無效列的位置與原因（等同 CLI 的 dry-run）。
2. **② 確認匯入**：有無效列時必須勾選「確認略過」，送出的略過數要跟檢查結果一致
   （等同 CLI 的 `--approve-skipping-invalid`）。

架構：網站沒有登入機制、Firestore 也禁止客戶端寫入，所以上傳走 Cloud Function
`upload_media_exposure`（`functions/main.py` → `functions/media_exposure_upload.py`），
由 Hosting rewrite（`firebase.json`）把 `/api/media-exposure` 轉進去，並以
**上傳通行碼**把關：Secret Manager 的 `MEDIA_EXPOSURE_UPLOAD_PASSCODE`，沒有通行碼
無法解析也無法寫入（錯誤時延遲 1.5 秒回應）。限制：最多 6 個檔案、每檔 4 MB、
合計 8 MB、單次 5,000 筆。解析／去重／媒體名稱對照與 CLI 共用
`functions/media_exposure.py`，兩種匯入方式產生的文件 ID 一致，混用不會重複。

更換通行碼：

```bash
printf '%s' '新的通行碼' > /tmp/pass.txt
firebase functions:secrets:set MEDIA_EXPOSURE_UPLOAD_PASSCODE --data-file /tmp/pass.txt --force
firebase deploy --only functions:upload_media_exposure   # 讓函式讀到新版本
rm /tmp/pass.txt
```

本機 `npm run dev` 時，`/api` 會由 `vite.config.js` 轉到線上網站，所以上傳會真的寫入正式資料庫。

### 新聞稿曝光成效的分組規則（PR 媒體戰情）

「新聞稿曝光成效」把人工確認曝光依「新聞稿／主題」彙整。同一則新聞稿各媒體的標題常常完全不同，
所以不能只比對標題文字；每組都會標示**分組依據**（推定，可展開檢視每一則）。由嚴到寬依序：

1. **新聞稿編號**：資料有 `campaignId`／`pressReleaseId` 就優先用（有編號的紀錄只跟同編號合併）。
2. **事件規則**（`exposureEvents.js`）：標題抽出「期間」——月份（9月、前七月、1—9月、4、5月）、
   季（Q3、第2季、首季、前3季）、半年（上半年、H1）——再用發布日推定年份；期間必須已結束、
   且在發布日前 75 天內。講營收 → 「月營收公告」，講 EPS／獲利／財報 → 「季度財報／獲利」，
   同一期的所有報導合成同一個事件。沒有明確期間時，只有「標題有創見＋營收＋月／季字眼、且發布日
   在每月 12 日前」才推定為上個月營收，否則不歸類。
   另外有**展覽參展**事件：標題有「創見」且提到展覽名單（`src/config/exposureShows.js`，例如
   COMPUTEX、智慧製造展／Touch Taiwan、自動化工業大展、智慧能源週）→ 「該展覽、該月」合成一個事件，
   展覽的別名視為同一個展。新增展覽直接在名單加一筆。
3. **標題相同**：NFKC 正規化、小寫、移除空白、去掉首尾標點後完全相同（不限日期）。
4. **標題相似**：發布日相差 1 天內、字元雙連詞 Dice 相似度 ≥ 0.4（兩篇已被認成不同事件的不比）。

都不符合就各自獨立。用真實資料（401 筆）驗證：397 組 → 198 組，月營收公告與季財報各自成組。
規則是推定，不是正式新聞稿編號；要精準分組，最可靠的做法是匯入 Excel 時加一欄 `campaignId`。
調整規則改 `src/features/pr/exposureEvents.js`，相似度門檻改 `SIMILAR_THRESHOLD`（`exposurePerformance.js`）。

## 📋 新聞稿稿單自動同步（Google Sheet → `press_releases`，`functions/press_release_sync.py`）

只維護一份 Google Sheet「新聞稿稿單」（試算表 ID `1ran1qZjie3rMnUzo-LambYaP6c_vMQ8MdVH5iCMkUqM`），
`press_release_sync_job` 每天 06:30（Asia/Taipei）唯讀同步，並用它精準配對 `media_exposure`。

- **唯讀、無金鑰**：scope 只有 `spreadsheets.readonly`，用 Cloud Functions 執行環境的 service account
  （ADC，沒有任何 JSON 金鑰），Sheet 不需要公開；只要把 Sheet 以「檢視者」分享給該 service account，並啟用 Google Sheets API。
  沒有權限時任務會失敗並在 `job_status/press_release_sync.lastError` 寫出要分享的 email（fail closed，不寫入任何資料）。
- **只處理名稱為 `20xx` 的分頁**；第 1 列文件標題、第 2 列欄位標題都不會當成資料；欄位依「標題名稱」尋找，
  支援別名（新聞稿 ID／正式標題／實際發布日／狀態／官方連結／關鍵字／英文標題…），目前沒有的欄位也能運作。
  **「備註」欄永遠不讀、不寫、不顯示。**
- **日期**：年份取自分頁名稱；`M/D` 轉成 Asia/Taipei 日期，`6月`、空白、不合法日期一律不猜（`actualReleaseDate=null`，
  `datePrecision=month|unknown`），絕不補成今天。沒有「狀態」欄時狀態是 `unknown`。
- **`press_releases`（內部集合，Firestore Rules 預設拒絕，前端不讀）**：id 為「明確新聞稿 ID」或
  `sha1(試算表|年份|正規化標題|原始日期)`（不含備註、不含列號，插列不影響）。同一份 Sheet 重複同步不會產生重複或多餘寫入；
  Sheet 裡消失的資料標 `active=false`（不刪除）；標題改了＝新文件＋舊文件停用，不會同時有效。
- **fail closed**：任何讀取失敗、版面看不懂、解析結果為空、或一次要停用超過一半既有新聞稿，都不寫入、不清除既有配對。
- **配對（`functions/press_release_match.py`）**：人工確認（`confirmed`）永不覆蓋 → 已存在的有效配對 → 明確新聞稿 ID →
  官方連結 → 正規化標題完全相同 → 日期（日精度）＋關鍵字高信心 → 標題相似度（只寫 `suggested`）→ `unmatched`。
  不同月份營收、不同季度、不同型號（DDR5 7200／6400）不互相配對；候選同分不任選；月份／缺日期不做日期配對。
  結果寫回 `media_exposure`：`pressReleaseId/Title`（僅 confirmed／auto_matched）、`matchStatus/Method/Confidence/matchedAt`、
  `suggestedPressReleaseId/Title`。網站的「曝光成效」優先用 `pressReleaseId` 分組，並顯示配對依據、最後同步時間與待確認／未配對數量；
  公開網站沒有任何寫入或確認按鈕。
- **dry-run（零寫入）**：`python tools/press_release_dry_run.py --api`（需要 ADC）或 `--sheet-json 檔案`；
  會列出解析統計、日期不完整與可能重複的標題、配對統計，不輸出備註。
- **部署**：`firebase deploy --only functions:press_release_sync_job,hosting:main --project transcend-news-tbm`。

## ✅ 配對準確度與人工覆核（`press_release_match.py`、`match_review.py`）

- **名詞**：「人工彙整曝光」＝同仁蒐集的曝光資料（Excel 匯入）；「人工確認配對」＝同仁確認某則曝光屬於某篇新聞稿（`matchStatus=confirmed`）。兩者不同。
- **高信心自動配對（`high_confidence_anchors`）**：只有同時符合才會把「建議」提升為自動配對——曝光標題明確提到創見／Transcend／創見管理層；
  曝光日期與新聞稿發布日同日或前後 1 天；不是同業主導、股價評論或混合多個事件的文章；月份／季度相容，且曝光標題的規格
  （型號、容量、速度）都出現在新聞稿裡；至少 2 個具辨識力的錨點（規格、產品名、展覽、管理層、獎項、月份／季度、財務數字）；
  候選唯一且最佳候選的錨點數至少多 1。理由會寫成「同日＋創見＋64GB＋DDR5＋工業記憶體」。不是調低相似度門檻。
- **每筆曝光的配對說明**：`matchStatus`、`matchConfidence`、`matchMethod`、`matchReason`（中文說明；建議配對會說明未自動配對的原因，
  未配對會說明未通過的原因）。網站每個主題與待確認項目都顯示。
- **人工覆核（Google Sheet）**：公開網站只讀、不開放任何寫入。覆核在同一份 Google Sheet 的「曝光配對覆核」分頁完成，欄位
  `exposureId`、`decision`、`pressReleaseId`、`note`（選填，程式不讀取、不寫入、不顯示）：
  `confirm` 確認目前建議、`rematch` 另指定新聞稿（必填 pressReleaseId）、`reject` 不屬於任何新聞稿（中文：確認／改配／排除）。
  網站「待確認配對」→「匯出待確認 Excel」的前四欄就是這個分頁的欄位（第二張工作表列出新聞稿 ID）。
  每天排程（或手動執行 `press_release_sync_job`）同步：只接受白名單 decision 與有效 ID；未知 exposureId／pressReleaseId、
  重複矛盾的決策、confirm 與目前建議不同……任何一項不合格，**整次同步中止、不寫入**。沒有這個分頁或分頁是空的，既有同步照常。
  決策寫成 `matchStatus=confirmed`（`matchMethod=manual_confirm|manual_rematch`）或 `rejected`（人工排除），
  `matchSource=google_sheet_review`，**永遠不會被後續自動排程覆蓋**。

## 🏷 曝光分類（`functions/coverage_classify.py`，`coverageClass`）

`unmatched` 不等於錯誤，也不一定該配到新聞稿。每篇曝光另有獨立的分類欄位（與 `matchStatus` 分開，不影響 `pressReleaseId`／`confirmed`／`auto_matched`／`suggested`）：

| coverageClass | 顯示 | 規則 |
|---|---|---|
| `press_release_derived` | 新聞稿衍生曝光 | `confirmed`、`auto_matched` |
| `review` | 待確認 | `suggested`；有新聞稿特徵但無法唯一配對；資訊不足；信心 < 0.7 |
| `company_coverage` | 一般公司報導 | 創見的產品、營運、財報、公司活動、管理層談話（非新聞稿轉載） |
| `industry_related` | 產業連帶報導 | 持股轉讓、指數成分調整、記憶體漲價／缺貨、原廠外包、競品營收比較、股市個股清單 |
| `unrelated` | 不相關 | 同名公司（創見文化事業…）等 |

附屬欄位：`coverageClassLabel`、`coverageClassMethod`（`manual`／`press_release_match`／`rule`／`fallback`）、`coverageClassConfidence`、
`coverageClassReasons`、`classifiedAt`、`classificationVersion`。

- 分類跟著 `press_release_sync_job` 一起執行（配對之後），只更新「分類結果有變動」的文件（版本升級也算變動，可安全重跑）；
  `coverageClassMethod = manual` 的人工分類永遠不被覆蓋；單筆失敗保留既有分類；分批寫入（每批 ≤ 400）；不刪除任何文件。
- 同業在標題中比創見更前面出現的報導（例如「威剛9月營收…創見…」）不會被當成創見新聞稿轉載。
- 網站「曝光成效」：統計預設只算「新聞稿衍生曝光」，其他分類另計並可用篩選查看；Excel 明細帶配對狀態、曝光分類、分類方法、信心程度。
  公開網站沒有任何修改分類的寫入功能（人工修正需要日後的安全管理介面）。
- `tools/press_release_dry_run.py` 會列出各分類數量、代表案例與預計更新數（零寫入）。

## 🧭 事件中心（新聞話題聚類，`functions/topic_cluster.py`）

把不同媒體對「同一事件」的報導聚成一個話題（`news_topics`），事件顯示在「上游市場 → 事件」子頁（網址 `?tab=us&section=events`，預設類別「上游市場」，可切創見／競品／財務…；舊網址 `?tab=events` 會自動導向）；PR 總覽顯示最多 3 個涉及創見的重要事件，
上游市場顯示最多 3 個 DRAM／Flash 事件，今日情報快報同一事件只列一則。既有新聞清單完全保留。

- **排程**：`topic_cluster_job` 每 30 分鐘（Asia/Taipei，`max_instances=1`，lease lock `topic_cluster`）。只讀 `news`（不寫），
  只處理水位線（`meta/topic_cluster_state`）之後新增／變更的文章，每次最多 500 篇；讀取失敗不寫入、不清除既有話題；寫入成功才推進水位線。
- **演算法 `topic-v1`（透明規則，零 API 費用）**：先用倒排索引（公司＋事件類型、型號、展覽名稱、期間）找候選話題，不做全部兩兩比較；
  分數＝標題相似度（排除 AI／記憶體／SSD 等通用詞）＋公司重疊＋事件類型＋型號＋展覽＋財務數字＋期間＋時間；沒有「錨點」不合併。
- **硬性不合併**：超過時間窗口（一般 72 小時；價格／供需 7 天；營收／財報需同月份／季度）、月份或季度不同、公司主體不同、
  產品型號／容量／速度不同（DDR5 7200 ≠ 6400）、展覽不同、營收金額對不上、只因同一天或只有通用詞重疊。低信心保持獨立。
- **穩定**：話題 id＝sha1(最早那篇文章 id)；新文章加入既有話題不改 id；已分組的文章不重算（冪等）；不合併既有話題；
  演算法升級只影響新文章，可用 `tools/topic_cluster_dry_run.py` 預覽。
- **指標**：篇數、不重複媒體數、首次／最近報導、持續時間、情緒、24 小時聲量與前一個 24 小時的變化率、重要性（0–100，
  每一項加分都寫在 `importanceReasons`，事件卡顯示「重要原因」）。
- **資料與權限**：`news_topics` 由 Admin SDK 寫入，Firestore Rules 公開唯讀（`allow write: if false`）；話題文件自帶文章快照，
  事件中心只讀 `news_topics`，不讀 `news`。查詢只有 `lastPublishedAt` 單一欄位，不需要新的複合索引。
  新聞文件不加 `topicId`（會讓所有正在監聽最新 300 則的瀏覽器多讀一次）；對應關係在 `news_topics.articleIds`。
- **部署順序**：`firebase deploy --only firestore:rules` → `--only functions:topic_cluster_job` → `--only hosting:main`。

## 🌐 上游市場新聞（`src/features/news/useUpstreamNews.js`）

上游市場分頁（供應鏈＋ DRAM/Flash 市場）的統計卡片、品牌篩選、「創見最新
報導」以外的新聞清單，比照 PR 媒體戰情的做法，改用獨立的
`useUpstreamNews()` 查詢，不再從 `useNewsFeed` 的結果裡篩選：

```
where('cat', 'in', ['usMarket', 'supplier'])
where('pubDate', '>=', taipeiMonthStart(now))   // 只查「本月」（Asia/Taipei）
orderBy('pubDate', 'desc')
```

- **只查本月，不是整個 `usMarket`/`supplier` 分類**，理由跟 `usePRNews`
  完全相同——正式資料庫只保留「本月＋上個月」，但單一分類的文件量仍可能
  達到數千筆，上游市場統計只需要本月資料。
- **沿用既有的 composite index，不需要另外建立**：`transcend-news-monitor`
  已經建立好的 index（`news` collection、`cat` Ascending、`pubDate`
  Descending、`__name__` Descending、Collection scope）同樣能支援這個
  `in` 查詢——Firestore 的 `in` 查詢在執行面等同拆成多個 `==` 查詢後再
  合併結果，所需要的 index 跟單一 `==` 等值查詢相同，不需要替 `in`
  另外申請 index。也就是說，只要 PR 媒體戰情那個 index 已經是
  `Enabled`，上游市場這個查詢可以直接沿用，**不需要額外部署任何東西**。
  萬一實際查詢仍回報缺少 index（`FAILED_PRECONDITION`），畫面會顯示
  明確的「⚠ 上游新聞載入失敗」錯誤（並在瀏覽器 console 印出完整錯誤
  訊息，其中含 Firebase 提供的建立連結），**不會**自動退回不限日期的
  查詢；此時應照錯誤訊息裡的連結，在 `transcend-news-monitor` 專案手動
  建立所需 index，絕不從這個 sandbox 自行部署。
- **不會 fallback 成不限日期的查詢**：查詢失敗一律顯示明確錯誤狀態，
  絕不悄悄退回讀取全部上游文件的舊行為。
- `enabled` 參數：`useUpstreamNews({ enabled: tab === 'us' })`——使用者
  停留在 PR 或 IR 分頁時不建立查詢（若已有監聽器，立即取消），切到
  「上游市場」分頁才開始訂閱，離開時立即取消，避免不必要的讀取。
- 跨月處理、StrictMode／unmount 安全性、`refresh()` 重試，做法都跟
  `usePRNews` 一致（見上方章節）。
- 資料流程統一為：`useUpstreamNews` 本月資料 → `dedupeArticlesByTitle`
  去重 → 搜尋／媒體／情緒篩選（`NewsFilterToolbar`）→ 今天／本週／本月
  期間篩選 → 品牌篩選（Samsung/Micron/SK Hynix…）→ 統計卡片／今日重要
  情報／新聞清單，全部共用同一份最終結果，避免數字和清單不一致（若目前
  選了特定品牌，「最多討論」／「品牌數量」會如實反映只剩該品牌，這是
  同一份資料的自然結果）。
- 期間篩選只保留今天/本週/本月（拿掉本年、已載入資料），期間邊界一律
  用 `taipeiDayStart`／`taipeiWeekStart`／`taipeiMonthStart`，跟 PR 媒體
  戰情、後端保留範圍用同一套 Asia/Taipei 時區定義。
- 競品動態監測（`CompetitorNews`）維持原本自己的期間篩選與資料來源
  （`useNewsFeed`），本次調整未變動。

## 🚀 前端部署（Firebase Hosting）

改完 `public/index.html` 後：

```bash
npm run deploy
```

（需以 tselvis814@gmail.com 登入 firebase CLI；Firebase 專案為 `transcend-news-tbm`、Hosting 站台為 `transcend-news`，
新聞資料仍存於原 Firebase 專案 `transcend-news-monitor` 的 Firestore。）

## ⏰ 排程部署（Cloud Functions）

排程程式在 `functions/`（Python 3.11、asia-east1），改完後：

```bash
cd functions && python3.11 -m venv venv && ./venv/bin/pip install -r requirements.txt  # 第一次才需要
firebase deploy --only functions
```

### 跨專案 Firestore 與 Secret Manager

- 排程函式部署在 **transcend-news-tbm**，但資料寫入**舊專案 transcend-news-monitor** 的 Firestore。
- 跨專案身分使用 monitor 專案的 service account 金鑰，存放於 tbm 專案的
  **Secret Manager**（名稱 `MONITOR_SERVICE_ACCOUNT`；不得放進 repo 或程式碼）。更新金鑰：
  ```bash
  firebase functions:secrets:set MONITOR_SERVICE_ACCOUNT --data-file <金鑰.json>
  ```
- 程式初始化時**必須明確指定 projectId**（`functions/main.py get_db()`）：
  Cloud Functions 的 `FIREBASE_CONFIG` 預設專案是 tbm，不指定會寫錯資料庫。

### 必要 IAM 權限

| 身分 | 權限 | 用途 |
|---|---|---|
| 部署者（tselvis814）| tbm 專案 Owner/Editor | `firebase deploy` |
| Functions 執行身分（`<專案編號>-compute@developer.gserviceaccount.com`）| `secretmanager.secretAccessor`（deploy 時 CLI 自動授予）| 讀取 MONITOR_SERVICE_ACCOUNT |
| monitor 專案 service account（金鑰內容本身）| 該專案 Firebase Admin SDK 預設角色 | 寫入 Firestore（繞過 Security Rules）|

### 防重疊與冪等

每個排程函式設 `max_instances=1`，並以 Firestore lease lock（`meta/lock_*`）
防止執行重疊；鎖有 TTL，函式異常中止會自動過期被接管。新聞寫入採內容雜湊
去重（`meta/newsIndex`），只寫入新增或內容變更的文章，重跑不產生重複寫入。

---

## 📦 目錄結構

```
/
├── public/
│   └── index.html                # 前端網頁（Firebase Hosting 只部署此目錄）
├── firestore.rules               # Firestore 安全規則（屬於 transcend-news-monitor 專案）
├── firestore.indexes.json        # Firestore composite index 定義（屬於 transcend-news-monitor 專案，未被 firebase.json 引用、本輪未部署，見上方 PR 媒體曝光統計章節）
├── firebase.json / .firebaserc   # Firebase Hosting 設定（transcend-news-tbm 專案）
├── .github/
│   └── workflows/                # GitHub Actions（僅手動備援；正式排程在 Cloud Functions）
├── functions/
│   ├── main.py                   # Cloud Functions 排程進入點（部署於 transcend-news-tbm）
│   ├── fetch_news.py             # 抓取邏輯（Functions 與 Actions 共用）
│   ├── intelligence.py           # 零成本相關性、優先順序與事件規則
│   ├── digest.py                 # DRAM/Flash 產業新聞摘要信（Phase 1，規則版摘要）
│   ├── news_cleanup.py           # 新聞保存期限清理（只留本月＋上個月）
│   ├── sectigo-intermediate.pem  # Mail2000 寄信用 TLS 中介憑證（見上方摘要信章節）
│   └── requirements.txt          # Python 相依套件（固定版本）
├── tools/
│   ├── local_ai_worker.py        # 公司電腦上的 Ollama / 規則處理程式
│   └── requirements.txt          # 本機 worker 相依套件
└── tests/
    ├── test_fetch_news.py        # 抓取、去重、鎖與 AI 待辦整合測試
    ├── test_intelligence.py       # 相關性與風險規則測試
    ├── test_local_ai_worker.py    # 本機端點、輸出與防衝突測試
    ├── test_digest.py            # 摘要信篩選、進度追蹤與寄信流程測試
    ├── test_news_cleanup.py      # 新聞保存期限清理測試
　　└── test_main_functions.py    # Cloud Functions 進入點測試（全離線）
```

執行測試：`python3 -m unittest discover -s tests`（不需網路、不碰任何外部服務）

---

## 🔐 Firestore Rules 部署

`firestore.rules` 屬於**資料庫專案 `transcend-news-monitor`**（舊 Google 帳號），
不是 Hosting 專案 `transcend-news-tbm`，`npm run deploy` **不會**部署規則。修改後請擇一部署：

- **方法 A（建議）Firebase Console**：以擁有 `transcend-news-monitor` 的 Google 帳號登入
  https://console.firebase.google.com/project/transcend-news-monitor/firestore/rules
  ，貼上 `firestore.rules` 全文後點「發布」。
- **方法 B（CLI）**：以有該專案權限的帳號 `firebase login` 後執行：
  ```bash
  firebase deploy --only firestore:rules --project transcend-news-monitor
  ```
  （需暫時在 `firebase.json` 加入 `"firestore": {"rules": "firestore.rules"}` 區塊；
  平常不放這段，避免日常 deploy 誤打到錯的專案。）

---

## 🤖 已移除的功能（2026-07）

以下功能已整組移除，如需恢復請參考 git 歷史：

- **Gemini AI 摘要**（前端按鈕、後端摘要、backfill）——原公開 API Key 已撤銷；
  既有新聞文件中的 `summary` 欄位仍照常顯示
- **定時郵件**（下午英文上游市場報告、早上繁中科技早報、連線測試）

---

## 🚀 從零重建（新環境部署步驟）

### Step 1：資料庫專案（現行為 transcend-news-monitor）

1. Firebase Console 建立專案，啟用 **Firestore**（地區建議 `asia-east1`、Production mode）
2. 「Firestore → 規則」貼上本 repo 的 `firestore.rules` 發布
3. 「專案設定 → 服務帳號 → Generate new private key」下載 JSON
   （**妥善保管，絕不進 repo / GitHub / 程式碼**）

### Step 2：Hosting + Functions 專案（現行為 transcend-news-tbm，需 Blaze 方案）

```bash
firebase login                       # 具 tbm 專案權限的帳號
firebase functions:secrets:set MONITOR_SERVICE_ACCOUNT --data-file <Step1 的金鑰.json>
cd functions && python3.11 -m venv venv && ./venv/bin/pip install -r requirements.txt && cd ..
firebase deploy --only functions,hosting
```

（若前端 `firebaseConfig` 指向新的資料庫專案，記得同步更新 `public/index.html`）

### Step 3：GitHub 備援（選用）

repo Settings → Secrets and variables → Actions → Secrets 新增
`FIREBASE_SERVICE_ACCOUNT` = Step 1 的 JSON 全文，供手動觸發的備援 workflow 使用。

---

## ✅ 確認一切正常

| 檢查項目 | 說明 |
|---------|------|
| 網站可訪問 | https://transcend-news.web.app 能正常開啟 |
| Firebase 橫幅顯示 | 頁面顯示「Firebase 已連線」 |
| 自動排程 | Cloud Functions：股價交易時段每 1 分鐘、新聞每 15 分鐘（見 functions/main.py） |
| 排程日誌 | `firebase functions:log --project transcend-news-tbm` 或 Firebase Console |
| 新聞出現 | 開啟頁面，新聞應從 Firebase 載入（新新聞會即時推送） |
| 單元測試 | `python3 -m unittest discover -s tests` 全數通過 |

---

## ⚙️ 手動備援觸發（GitHub Actions）

正式排程由 Cloud Functions 負責；GitHub Actions 僅保留**手動觸發**作為備援
（Cloud Functions 故障時使用）：

1. GitHub Repository → 「Actions」分頁
2. 選「自動抓取新聞」（或「Update Stock Prices」）→「Run workflow」
3. 等約 2-3 分鐘，重新整理前端網頁

---

## 🔒 安全注意事項

- **任何 API Key / Service Account / Secret 一律不得寫入前端或 repository**
  （本 repo 為公開，寫入即等於洩漏，且會永久留在 Git 歷史中）
- Service Account JSON 僅存兩處加密服務：**GCP Secret Manager**（`MONITOR_SERVICE_ACCOUNT`，
  供 Cloud Functions）與 **GitHub Secrets**（`FIREBASE_SERVICE_ACCOUNT`，供手動備援）
- Firestore 規則：前端讀取的集合**公開唯讀**、所有客戶端禁止寫入，
  寫入只允許 Admin SDK（Cloud Functions 排程／Actions 備援）
- `public/index.html` 內的 `firebaseConfig.apiKey` 是 Firebase 前端識別用的公開金鑰，
  本來就會隨網頁公開，安全性由 Firestore Rules 把關，**不是**需要保密的 Secret

---

## 🐛 常見問題

**Q：排程沒有跑／資料沒更新？**
A：`firebase functions:log --project transcend-news-tbm` 看日誌。常見原因：
Secret `MONITOR_SERVICE_ACCOUNT` 未設定或格式錯誤（日誌會有明確錯誤訊息）、
前次執行持鎖中（日誌顯示「鎖 xxx 使用中，跳過本次」屬正常防重疊行為）。

**Q：前端顯示空白？**
A：確認 Firestore 中已有資料（可先手動觸發一次備援 workflow），並看瀏覽器 Console 錯誤。

**Q：費用？**
A：Functions 於 Blaze 方案下執行，目前用量在免費額度內（月費趨近 $0）；
新聞寫入已做內容雜湊去重，未變更文章不重寫，Firestore 寫入量大幅降低。
建議在 GCP 帳單設定預算警示。
