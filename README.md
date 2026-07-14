# 創見資訊新聞監控系統

> **Transcend Information (2451) News Intelligence**
> Firebase Hosting 前端 + GitHub Actions 自動排程 + Firebase Firestore 雲端儲存

**正式網址：https://transcend-news.web.app**
（舊網址 transcend-news-tbm.web.app 已 301 轉址到新網址）

---

## 🏗 系統架構

```
使用者瀏覽器
     ↕ 讀取新聞資料
Firebase Firestore（transcend-news-monitor）← GitHub Actions（每 30 分鐘自動抓取）
     ↑
Firebase Hosting（站台 transcend-news，public/index.html 前端）
GitHub（TranscendBM/transcend-news，僅作版本控管與備份）
```

## 🚀 前端部署（Firebase Hosting）

改完 `public/index.html` 後：

```bash
npm run deploy
```

（需以 tselvis814@gmail.com 登入 firebase CLI；Firebase 專案為 `transcend-news-tbm`、Hosting 站台為 `transcend-news`，
新聞資料仍存於原 Firebase 專案 `transcend-news-monitor` 的 Firestore。）

---

## 📦 目錄結構

```
/
├── public/
│   └── index.html                # 前端網頁（Firebase Hosting 只部署此目錄）
├── firestore.rules               # Firestore 安全規則（屬於 transcend-news-monitor 專案）
├── firebase.json / .firebaserc   # Firebase Hosting 設定（transcend-news-tbm 專案）
├── .github/
│   └── workflows/                # GitHub Actions（fetch-news / update-stocks / cleanup-msn）
├── scripts/
│   ├── fetch_news.py             # Python 抓取腳本
│   └── requirements.txt          # Python 相依套件（固定版本，全部 workflow 共用）
└── tests/
    └── test_fetch_news.py        # 純函式單元測試（離線，python3 -m unittest discover -s tests）
```

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

## 🚀 完整部署步驟

### Step 1：建立 Firebase 專案

1. 前往 https://console.firebase.google.com
2. 點「新增專案」，輸入名稱（例如 `transcend-news`），建立專案
3. 在左側選單點「Firestore Database」→「建立資料庫」
   - 選擇地區（建議 `asia-east1` 台灣/香港附近）
   - 選擇「Production mode」（之後套用我們的安全規則）

4. 取得 **Web 設定**：
   - 左上齒輪 → 「專案設定」→「一般」
   - 下方「您的應用程式」→ 點「</> Web」圖示
   - 填寫應用程式名稱，複製出現的 `firebaseConfig` 物件

   ```javascript
   // 你會看到像這樣的設定
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "transcend-news.firebaseapp.com",
     projectId: "transcend-news",
     storageBucket: "transcend-news.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123:web:abc"
   };
   ```

5. 取得 **Service Account（給 GitHub Actions 用）**：
   - 「專案設定」→「服務帳號」
   - 點「Generate new private key」→「Generate key」
   - 下載 JSON 檔（重要：妥善保管，不要上傳到 GitHub！）

6. 套用 **Firestore 安全規則**：
   - 左側選單「Firestore Database」→「規則」
   - 把 `firestore.rules` 的內容貼入，點「發布」

---

### Step 2：建立 GitHub Repository

1. 前往 https://github.com/new
2. Repository name：`transcend-news-monitor`（或自訂）
3. Visibility：**Private**（建議，保護設定）
4. 點「Create repository」

5. 上傳這個資料夾的所有檔案到 Repository：

   **方法 A：網頁上傳（最簡單）**
   - 點「uploading an existing file」
   - 把 `index.html`、`firestore.rules`、`README.md` 拖進去
   - 再分別建立 `.github/workflows/fetch-news.yml` 和 `scripts/` 目錄下的檔案
   - 每次點「Commit changes」

   **方法 B：使用 git 指令（有安裝 git 的話）**
   ```bash
   git init
   git add .
   git commit -m "初始化創見新聞監控系統"
   git remote add origin https://github.com/你的帳號/transcend-news-monitor.git
   git push -u origin main
   ```

---

### Step 3：設定 GitHub Secrets

這是最重要的步驟！把 Firebase 服務帳號金鑰安全地存入 GitHub：

1. 在 GitHub Repository 頁面點「Settings」
2. 左側「Secrets and variables」→「Actions」
3. 點「New repository secret」
4. Name：`FIREBASE_SERVICE_ACCOUNT`
5. Value：把 Step 1 下載的 JSON 檔**全部內容**貼上
6. 點「Add secret」

---

### Step 4：部署前端（Firebase Hosting）

> 前端已改由 **Firebase Hosting** 托管（不再使用 GitHub Pages），見上方「前端部署」。
> 建議到 Repository Settings → Pages 將 Source 設為「None」，避免無用的 pages build。

---

## ✅ 確認一切正常

| 檢查項目 | 說明 |
|---------|------|
| 網站可訪問 | https://transcend-news.web.app 能正常開啟 |
| Firebase 橫幅顯示 | 頁面顯示「Firebase 已連線」 |
| 手動觸發 Actions | GitHub → Actions → 「自動抓取新聞」→ Run workflow |
| 自動排程 | fetch-news 每 30 分鐘、update-stocks 交易時段每 5 分鐘（GitHub 排程常有延遲） |
| 新聞出現 | 重新整理頁面，新聞應從 Firebase 載入 |
| 單元測試 | `python3 -m unittest discover -s tests` 全數通過 |

---

## ⚙️ 手動觸發抓取

不需要等排程，隨時可以手動執行：

1. GitHub Repository → 點「Actions」分頁
2. 左側點「自動抓取新聞」
3. 右側點「Run workflow」→ 選擇模式（all / morning / afternoon）
4. 點「Run workflow」
5. 等約 2-3 分鐘，重新整理前端網頁即可看到新聞

---

## 🔒 安全注意事項

- **任何 API Key / Service Account / Secret 一律不得寫入前端或 repository**
  （本 repo 為公開，寫入即等於洩漏，且會永久留在 Git 歷史中）
- Firebase Service Account JSON 儲存在 **GitHub Secrets**，安全加密
- Firestore 規則：前端讀取的集合**公開唯讀**、所有客戶端禁止寫入，寫入只允許 Admin SDK（Actions）
- `public/index.html` 內的 `firebaseConfig.apiKey` 是 Firebase 前端識別用的公開金鑰，
  本來就會隨網頁公開，安全性由 Firestore Rules 把關，**不是**需要保密的 Secret

---

## 🐛 常見問題

**Q：Actions 執行失敗？**
A：點 Actions → 失敗的任務 → 查看 log。最常見原因是 `FIREBASE_SERVICE_ACCOUNT` Secret 未設定或格式錯誤。

**Q：前端顯示空白？**
A：確認 Firebase 設定正確填入，且 Firestore 中已有資料（先手動觸發一次 Actions）。

**Q：GitHub Actions 免費嗎？**
A：Public Repository 免費無限制；Private Repository 每月有 2,000 分鐘免費額度（每次執行約 2 分鐘，每天 2 次 = 每月 ~120 分鐘，綽綽有餘）。
