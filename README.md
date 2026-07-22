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
├── firebase.json / .firebaserc   # Firebase Hosting 設定（transcend-news-tbm 專案）
├── .github/
│   └── workflows/                # GitHub Actions（僅手動備援；正式排程在 Cloud Functions）
├── functions/
│   ├── main.py                   # Cloud Functions 排程進入點（部署於 transcend-news-tbm）
│   ├── fetch_news.py             # 抓取邏輯（Functions 與 Actions 共用）
│   ├── intelligence.py           # 零成本相關性、優先順序與事件規則
│   └── requirements.txt          # Python 相依套件（固定版本）
├── tools/
│   ├── local_ai_worker.py        # 公司電腦上的 Ollama / 規則處理程式
│   └── requirements.txt          # 本機 worker 相依套件
└── tests/
    ├── test_fetch_news.py        # 抓取、去重、鎖與 AI 待辦整合測試
    ├── test_intelligence.py       # 相關性與風險規則測試
    ├── test_local_ai_worker.py    # 本機端點、輸出與防衝突測試
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
