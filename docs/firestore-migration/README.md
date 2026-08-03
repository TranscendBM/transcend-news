# Firestore 資料庫合併：transcend-news-monitor → transcend-news-tbm

現況：Hosting／Functions／Cloud Scheduler 都已經在 `transcend-news-tbm`，
但 Firestore 資料庫仍是舊專案 `transcend-news-monitor`（Functions 透過
Secret Manager 的 `MONITOR_SERVICE_ACCOUNT` 跨專案讀寫，前端的
`FIREBASE_CONFIG` 也指向這個舊專案）。這份文件是把 Firestore 資料庫本身
搬到 `transcend-news-tbm`（目前是空的）的完整規劃：盤點、搬移工具、
正式切換步驟、rollback。

**本輪（這個 PR）只做了：唯讀盤點（含明確的存取限制說明）、搬移工具
本體與測試、Rules/Indexes/Functions/前端切換的準備素材。沒有複製任何
正式資料、沒有刪除任何資料、沒有執行任何 `firebase deploy`、沒有切換
前端或 Functions 的實際連線目標。**

## 目錄

- [1. 存取限制（唯讀盤點做到哪裡為止）](#1-存取限制唯讀盤點做到哪裡為止)
- [2. 集合盤點（依原始碼比對，不是猜測）](#2-集合盤點依原始碼比對不是猜測)
- [3. meta 文件處理清單](#3-meta-文件處理清單)
- [4. 搬移工具：tools/migrate_firestore.py](#4-搬移工具-toolsmigrate_firestorepy)
- [5. Rules／Indexes 差異](#5-rulesindexes-差異)
- [6. Functions／前端需要切換的項目](#6-functions前端需要切換的項目)
- [7. 實際所需 IAM 權限](#7-實際所需-iam-權限)
- [8. 正式切換步驟](#8-正式切換步驟)
- [9. Rollback 步驟](#9-rollback-步驟)

---

## 1. 存取限制（唯讀盤點做到哪裡為止）

用目前 sandbox 裡僅有的兩把 service account 金鑰（`deploy-bot@transcend-news-tbm`、
`firebase-adminsdk-fbsvc@transcend-news-tbm`，兩把都只綁定
`transcend-news-tbm` 專案）分別對兩個專案的 Firestore 根目錄做了一次
最小化的唯讀請求（`documents:listCollectionIds`，不讀取任何文件內容）：

| 專案 | 結果 |
|---|---|
| `transcend-news-tbm`（目的端） | `200 OK`（空資料庫，符合預期） |
| `transcend-news-monitor`（來源端） | `403 PERMISSION_DENIED`（兩把金鑰皆同樣結果） |

**結論：這個 sandbox 目前沒有任何憑證可以讀取 `transcend-news-monitor`
的 Firestore。** 因此本輪「集合盤點」（第 2 節）是**依原始碼**（`functions/*.py`
實際的 `db.collection(...)` 呼叫）比對出來的集合名稱與 ID 規則，**不是
猜測**，但**無法提供任何即時文件筆數**——那需要真正的讀取權限才能做。

缺少的權限：在 `transcend-news-monitor` 專案，對將執行搬移工具的
service account 授予 `roles/datastore.viewer`（唯讀盤點/dry-run/verify
的來源端讀取）足夠；`--copy` 執行時來源端一樣只需要 viewer（來源端從頭
到尾都只被讀取，不會被寫入）。授予後即可執行：

```bash
python3 tools/migrate_firestore.py \
  --source-project transcend-news-monitor --dest-project transcend-news-tbm \
  --source-credentials <有 datastore.viewer 權限的金鑰> \
  --dry-run
```

得到真正的集合／文件數盤點（本文件第 2 節的「文件數」欄位會補上）。

---

## 2. 集合盤點（依原始碼比對，不是猜測）

以下集合清單、文件 ID 規則、寫入位置，全部對照 `functions/fetch_news.py`、
`functions/news_cleanup.py`、`functions/digest.py`、`tools/local_ai_worker.py`
的實際 `db.collection(...)`／`db.collection(...).document(...)` 呼叫整理，
逐一列出證據行號：

| 集合 | 文件 ID | 用途 | 證據 | 本次搬移範圍 |
|---|---|---|---|---|
| `news` | 文章 id（md5 hex，見 `fetch_news.py` 產生邏輯） | 新聞本文 | `fetch_news.py:568` | 只搬「本月＋上個月」（見 §4） |
| `stocks` | `latest` | 即時股價快照 | `fetch_news.py:1128` | 全量 |
| `revenue` | 股票代號（`2451`/`3260`/`8271`/`4967`/`5289`/`4973`） | 月營收 | `fetch_news.py:1000` | 全量 |
| `financials` | 股票代號 | 季度損益 | `fetch_news.py:1360` | 全量 |
| `dividends` | 股票代號 | 股利 | `fetch_news.py:1738` | 全量 |
| `material` | `competitors` | 競品重大訊息 | `fetch_news.py:1489` | 全量 |
| `daily` | 股票代號 | 每日交易資訊 | `fetch_news.py:1607` | 全量 |
| `meta` | 見第 3 節 | 排程鎖／去重索引／摘要信進度／一次性標記 | 見第 3 節 | 依白名單，見第 3 節 |
| `ai_jobs` | 對應 `news` 文章 id | AI 分析待辦 | `fetch_news.py:588`、`news_cleanup.py:52` | 只搬 ID 落在本次搬移的 news 範圍內的 |
| `ai_insights` | 對應 `news` 文章 id | AI 分析結果 | `tools/local_ai_worker.py:235`、`news_cleanup.py:52` | 同上 |

`community`（PTT Stock 輿情）**不是**獨立集合，是 `news` 文件裡
`cat == 'community'` 的一個分類值（`fetch_news.py:170-173`），已經包含在
上面的 `news` 列裡，不需要另外處理。

前端（`src/App.jsx`、`src/features/news/use*News.js`）讀取的集合跟上表
完全一致，沒有發現任何前端讀但後端沒寫、或反過來的集合。

**文件數**：本輪沒有讀取權限，無法提供（見第 1 節）。`tools/migrate_firestore.py
--dry-run` 拿到權限後可以直接產生每個集合的 `total_in_source`／`eligible`／
`excluded` 統計。

**安全網**：即使上面這份清單有遺漏，`--dry-run` 每次執行都會呼叫
Firestore 原生的「列出頂層集合」API（`source_db.collections()`），把
任何不在這份已知清單裡的集合明確列出來（`_unrecognized_collections`），
不會因為程式碼裡沒寫到就悄悄略過。

---

## 3. meta 文件處理清單

`meta` 集合底下目前已知的文件 ID（全部來自原始碼裡实際寫入的位置，
不是猜測）：

| 文件 ID | 用途 | 證據 | 處理方式 |
|---|---|---|---|
| `lock_stocks`、`lock_news`、`lock_trading`、`lock_finance`、`lock_digest_tw`、`lock_digest_us`、`lock_news_cleanup` | 排程用的暫時 lease lock，防止同一 job 重疊執行 | `fetch_news.py:748-749`、`main.py` 各 `_run_locked(...)` 呼叫 | **一律不搬**（`META_LOCK_PREFIX = 'lock_'`） |
| `newsIndex_0` … `newsIndex_f`（16 個分片） | 新聞去重索引（依文章 id 第一個字元分片） | `fetch_news.py:612-630` | **保留**（不搬會讓切換後第一次 `news_job` 誤判全部新聞都是新文章） |
| `digest_tw`、`digest_us` | DRAM/Flash 摘要信「上次寄送時間」 | `digest.py:431` | **保留**（不搬會讓切換後下次排程重複寄送已經寄過的新聞） |
| `migration_news_date_fix_20260722` | 一次性歷史新聞日期修正的完成標記 | `fetch_news.py:386-411` | **保留**（無害的稽核紀錄；即使遺漏，該修正本身冪等，重跑不會造成資料錯誤，只是多一次不必要的寫入） |

**其他未列在上面的 meta 文件**：本輪沒有讀取權限，無法確認是否存在
（見第 1 節）。工具本身在 `--dry-run`／`--copy`／`--verify` 任何一次
執行遇到不在上面白名單、也不是 `lock_*` 的 meta 文件時，一律歸類為
`unclassified`——**不會自動搬移**，只會列在報告裡（`unclassified_ids`），
需要人工確認用途後才能決定要不要加進
`tools/migrate_firestore.py` 的 `META_PRESERVE_IDS`。

---

## 4. 搬移工具：tools/migrate_firestore.py

```bash
# 1. 盤點（唯讀，不需要目的端寫入權限）
python3 tools/migrate_firestore.py \
  --source-project transcend-news-monitor --dest-project transcend-news-tbm \
  --source-credentials <來源端唯讀金鑰> \
  --dry-run

# 2. 實際複製（需要來源唯讀 + 目的讀寫；--copy 需要額外加上確認旗標）
python3 tools/migrate_firestore.py \
  --source-project transcend-news-monitor --dest-project transcend-news-tbm \
  --source-credentials <來源端唯讀金鑰> --dest-credentials <目的端讀寫金鑰> \
  --checkpoint-file /path/to/checkpoint.json \
  --copy --i-approve-writing-to-dest

# 3. 驗證（唯讀兩端，不寫入任何一端）
python3 tools/migrate_firestore.py \
  --source-project transcend-news-monitor --dest-project transcend-news-tbm \
  --source-credentials <來源端唯讀金鑰> --dest-credentials <目的端讀寫金鑰> \
  --verify
```

行為摘要（完整說明見程式內 docstring）：

- **冪等**：文件 ID 完全比照來源，重跑只會覆寫成跟來源一致，不會產生
  重複資料。
- **分頁**：依文件 ID（或 `news` 的 `pubDate`）排序分頁讀取，不會把整個
  集合讀進記憶體。
- **批次上限**：每個 WriteBatch 預設 400 筆、硬性拒絕超過 500。
- **可安全中斷重跑**：`--checkpoint-file` 記錄每個集合目前搬到哪個文件
  ID（只存 ID，不存內容）；某個 batch 寫入失敗時，該集合本次執行就此
  停止（不會讓 checkpoint 被後面剛好成功的 batch 推到失敗點前面而遺漏
  資料），下次重跑會從上一個成功的 checkpoint 繼續。
- **範圍**：`news` 只搬「本月＋上個月」（跟 `functions/news_cleanup.py`
  的保留政策同一份邏輯，見 `tests/test_migrate_firestore.py` 的一致性
  測試）；`ai_jobs`/`ai_insights` 只搬對應到本次搬移的 `news` 文件的
  那些；`meta` 只搬白名單（見第 3 節）。
- **防呆**：`--source-project` 與 `--dest-project` 相同時直接拒絕執行；
  `--copy` 沒有額外加 `--i-approve-writing-to-dest` 也會拒絕執行。
- **不外洩敏感資料**：所有輸出（含錯誤訊息）只包含集合名稱、文件 ID、
  數量與錯誤類型，絕不印出文件內容或憑證內容
  （見 `tests/test_migrate_firestore.py` 的 `TestCredentialErrorsDoNotLeakSecrets`）。

測試：`tests/test_migrate_firestore.py`（35 個測試，完全離線，用自建的
`FakeFirestoreDB` 模擬，不需要安裝 `google-cloud-firestore`）涵蓋：
dry-run 零寫入、分頁與批次上限、重跑冪等、來源/目的專案防呆、lock 文件
排除、meta allowlist、新聞保留邊界與跨年、部分失敗後可重跑（含
checkpoint 不會跳過失敗批次的驗證）、verify 找出缺少/不同的文件、
憑證與錯誤訊息不外洩秘密、跟 `functions/news_cleanup.py` 保留政策的
一致性、未知頂層集合安全網。

---

## 5. Rules／Indexes 差異

**沒有差異**——兩份「準備好」的檔案內容跟現行 `transcend-news-monitor`
用的版本逐字相同：

- `docs/firestore-migration/firestore.tbm.rules` ↔ 根目錄 `firestore.rules`
- `docs/firestore-migration/firestore.tbm.indexes.json` ↔ 根目錄 `firestore.indexes.json`

之所以逐字相同：Firestore Rules／Indexes 定義本身不含專案 ID，同一份
規則／索引邏輯本來就能直接套用到任何專案。這兩份檔案目前都**沒有**被
`firebase.json` 引用、**沒有**部署到任何專案——純粹是「切換時要用的
內容已經準備好，複製過去就能部署」，正式切換步驟見第 8 節。

---

## 6. Functions／前端需要切換的項目

### Functions（`functions/main.py`）

準備了 `functions/db_same_project.py`（**目前完全沒有被 import／呼叫，
純參考實作**）：用 Cloud Functions 執行環境自身的 Application Default
Credentials 連線，取代現在 `get_db()` 用 `MONITOR_SERVICE_ACCOUNT`
secret 跨專案連線的做法。切換時要做的修改（現在還沒做）：

1. `main.py` 改用 `from db_same_project import get_db`，移除自己的
   `get_db()` 與 `MONITOR_SERVICE_ACCOUNT = SecretParam(...)`。
2. 移除全部 8 個 `@scheduler_fn.on_schedule(..., secrets=[MONITOR_SERVICE_ACCOUNT, ...])`
   裡的 `MONITOR_SERVICE_ACCOUNT`（`MAIL2000_SMTP_PASSWORD` 等其他
   secret 不動）。
3. `firebase deploy --only functions --project transcend-news-tbm`。

### 前端（`src/services/firebase.js`）

**尚未能完全準備**：`transcend-news-tbm` 專案目前**還沒有註冊任何
Firebase Web App**（用現有金鑰呼叫 Firebase Management API 的
`projects/transcend-news-tbm/webApps` 回傳空清單）——沒有 Web App 就
沒有對應的 `apiKey`/`appId` 可以填入 `FIREBASE_CONFIG`。註冊一個新
Web App 是會實際建立雲端資源的動作，不屬於本輪「唯讀盤點/建立工具/
測試/開 Draft PR」的授權範圍，所以刻意沒有做。

切換時要做的修改（現在還沒做）：

1. 在 Firebase Console（`transcend-news-tbm` 專案）→ 專案設定 → 新增
   Web App，取得 `apiKey`/`authDomain`/`projectId`/`storageBucket`/
   `messagingSenderId`/`appId`。
2. `src/services/firebase.js` 的 `FIREBASE_CONFIG` 換成上一步拿到的值
   （這個物件本來就是公開的 client 設定，不是需要保密的憑證——見
   `firebase.js` 現有註解）。
3. 這個改動不需要重新編譯 Functions，只需要 `npm run build` 後
   `firebase deploy --only hosting:main --project transcend-news-tbm`。

### Firestore Rules／Indexes

見第 5 節：把 `docs/firestore-migration/firestore.tbm.{rules,indexes.json}`
複製成根目錄的 `firestore.rules`/`firestore.indexes.json`，並在
`firebase.json` 加入：

```json
"firestore": {
  "rules": "firestore.rules",
  "indexes": "firestore.indexes.json"
}
```

（目前 `firebase.json` 刻意不含這個區塊，避免日常 `firebase deploy`
不小心動到 Firestore；只有在確定要切換到 `transcend-news-tbm` 時才
加入，而且要注意這時候 `firestore.rules`/`firestore.indexes.json`
所在的專案脈絡已經是 `transcend-news-tbm`，不能不小心用同一份
`firebase.json` 又打去部署 `transcend-news-monitor`。）

---

## 7. 實際所需 IAM 權限

| 專案 | 用途 | 最小角色 | 目前狀態 |
|---|---|---|---|
| `transcend-news-monitor` | `--dry-run`／`--copy`／`--verify` 的來源端讀取（自始至終唯讀） | `roles/datastore.viewer` | **缺少**（兩把現有金鑰皆 403，見第 1 節） |
| `transcend-news-tbm` | `--copy` 的目的端寫入、`--verify` 的目的端讀取 | `roles/datastore.user` | 已具備（`deploy-bot@transcend-news-tbm` 與 `firebase-adminsdk-fbsvc@transcend-news-tbm` 皆可讀寫，`transcend-news-tbm` 這次做 `listCollectionIds` 測試回傳 `200`） |
| `transcend-news-tbm`（切換後，Functions 執行身分） | 同專案 Firestore 讀寫（取代現在跨專案的 `MONITOR_SERVICE_ACCOUNT`） | `roles/datastore.user`（通常 Cloud Functions 預設服務帳號已有） | 待切換時確認 |

---

## 8. 正式切換步驟（本輪不執行，供之後參考）

1. 依第 1 節取得 `transcend-news-monitor` 的 `roles/datastore.viewer`。
2. `--dry-run` 確認真實的集合／文件數（補上第 2 節的「文件數」欄）。
3. `--copy --i-approve-writing-to-dest`（建議先在非尖峰時段執行，並保留
   `--checkpoint-file`）。
4. `--verify` 確認來源與目的端一致（`missing_in_dest`/`differs` 都是空的）。
5. 依第 6 節切換 Functions（`get_db()` 改用 `db_same_project.py`）並部署。
6. 依第 6 節建立 Web App、切換前端 `FIREBASE_CONFIG` 並部署 Hosting。
7. 依第 5/6 節把 Rules／Indexes 部署到 `transcend-news-tbm`。
8. 觀察至少一個完整排程週期（含每天 02:30 的 `news_cleanup_job`、每天
   17:30 的 `finance_job`、平日 08:00/16:30 的兩個摘要信 job）確認一切
   正常。
9. 確認無誤且穩定運作一段時間後，才考慮撤銷 `MONITOR_SERVICE_ACCOUNT`
   secret 與 `transcend-news-monitor` 那把對應金鑰——撤銷前務必再三確認
   沒有其他用途還在依賴它。**`transcend-news-monitor` 的 Firestore 資料
   庫本身，在整個流程中都不需要刪除**（多留著也不花費什麼，作為切換後
   一段時間的最終備援）。

## 9. Rollback 步驟

因為整個流程中 `transcend-news-monitor` 從頭到尾只被讀取、從未被寫入或
刪除，任何時間點都可以安全退回：

- **切換 Functions 之後想退回**：把第 8 節步驟 5 的異動 `git revert`，
  重新 `firebase deploy --only functions`，`MONITOR_SERVICE_ACCOUNT`
  secret 全程沒有被移除過（除非已經執行了步驟 9），退回後立刻恢復連回
  `transcend-news-monitor`。
- **切換前端之後想退回**：把 `FIREBASE_CONFIG` 改回原本指向
  `transcend-news-monitor` 的值，`npm run build && firebase deploy --only hosting:main`。
- **部署了 Rules/Indexes 之後想退回**：`transcend-news-monitor` 的
  Rules/Indexes 完全沒有被這次流程更動過，不需要對它做任何事；
  `transcend-news-tbm` 上部署的 Rules/Indexes 即使先切回 Functions/前端
  也不需要立刻撤除（反正沒人在讀寫它，多留著沒有風險）。
- **最壞情況（切換後才發現資料有問題）**：只要還沒執行第 8 節步驟 9
  （撤銷 monitor 的憑證/secret），`transcend-news-monitor` 的資料完整
  保留，上面三步驟合起來就是完整退回；即使已經執行步驟 9，
  `transcend-news-monitor` 的 Firestore 資料庫本身仍然存在（只是
  Functions 沒有憑證存取），還原一把新的 service account 金鑰即可恢復
  存取。
