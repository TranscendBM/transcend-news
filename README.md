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

## 📧 DRAM/Flash 產業新聞摘要信（`functions/digest.py`，Phase 1）

平日自動寄出重要 DRAM/Flash 產業新聞摘要信（`functions/main.py`
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
