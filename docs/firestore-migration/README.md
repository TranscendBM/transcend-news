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
- **分頁**：依文件 ID（或 `news` 的 `(pubDate, 文件 ID)` 複合排序，文件
  ID 當穩定 tie-breaker，避免 pubDate 相同時分頁順序不穩定漏筆）排序
  分頁讀取，不會把整個集合讀進記憶體。
- **批次上限**：每個 WriteBatch 預設 400 筆、必須 > 0、硬性拒絕超過 500。
- **可安全中斷重跑（fail-closed checkpoint）**：`stocks`/`revenue`/
  `financials`/`dividends`/`material`/`daily`/`news`/`meta` 支援
  `--checkpoint-file`，記錄每個集合「最後成功寫入的 Firestore 排序
  游標值」（不是文件 ID 是否還存在的比對——即使該筆之後被刪除或不再
  符合條件，游標值本身仍能正確定位分頁位置）。checkpoint 綁定這次執行
  的來源/目的專案、cutoff、集合清單、page_size 與格式版本；任何一項
  對不上、或檔案損毀，一律視為不可用、記錄警告、對應集合從頭開始
  （絕不靜默沿用不符的舊 checkpoint，也絕不因為 cursor 無法確認就跳過
  整個集合）。checkpoint 檔案採 atomic write（暫存檔 + fsync +
  `os.replace()`），不會留下損毀的半寫入檔案。`ai_jobs`/`ai_insights`
  刻意不支援 checkpoint——這兩個集合是依 news id 清單逐筆查詢，沒有
  自然的 Firestore 分頁游標，以目前的資料量直接整個重新冪等執行更
  簡單可靠。某個 batch 寫入失敗時，該集合本次執行就此停止。
- **範圍**：`news` 只搬「本月＋上個月」（跟 `functions/news_cleanup.py`
  的保留政策同一份邏輯，見 `tests/test_migrate_firestore.py` 的一致性
  測試）；`ai_jobs`/`ai_insights` 只搬對應到本次搬移的 `news` 文件的
  那些；`meta` 只搬白名單（見第 3 節）。
- **`--copy` 強制前置安全檢查**：執行寫入前一律先做一次等同 `--dry-run`
  的掃描，發現任何一種情況就直接拒絕執行，**沒有任何旗標可以略過**：
  來源端有未知頂層集合、任何文件底下有子集合（本工具不支援搬移子集合
  內容）、或有未分類的 `meta` 文件。必須先處理清楚或更新程式碼白名單
  才能繼續。
- **防呆**：`--source-project` 與 `--dest-project` 相同時直接拒絕執行；
  `--page-size`/`--batch-size` 必須是正整數，`--batch-size` 不得超過
  500；`--collections` 只能是本工具已知的集合名稱；`--copy` 沒有額外
  加 `--i-approve-writing-to-dest` 也會拒絕執行。
- **verify 強化**：除了 `missing_in_dest`/`differs`/`matches`，也統計
  `extra_in_dest`（目的端多出來、來源沒有的文件）、來源與目的端各自的
  文件總數、以及目的端有沒有出現未知頂層集合；只要發現任何
  missing/differs/extra/未知集合，CLI 結束碼回傳 `1`（方便 CI/腳本
  判斷），一律不寫入任何一端。
- **不外洩敏感資料**：所有輸出（含錯誤訊息、checkpoint 檔案內容）只包含
  集合名稱、文件 ID、排序游標值、數量與錯誤類型，絕不印出文件內容或
  憑證內容（見 `tests/test_migrate_firestore.py` 的
  `TestCredentialErrorsDoNotLeakSecrets`）。

測試：`tests/test_migrate_firestore.py`（64 個測試）+
`tests/test_db_same_project.py`（3 個測試），完全離線，用自建的
`FakeFirestoreDB` 模擬、暫存檔一律用 `tempfile`（不寫死任何固定路徑，
在 GitHub Actions／任何使用者帳號的乾淨環境都能跑），涵蓋：dry-run
零寫入、分頁與批次上限（含 page-size/batch-size 必須為正數）、重跑
冪等、來源/目的專案與 CLI 參數防呆（未知集合名稱拒絕、無 `--force`）、
lock 文件排除、meta allowlist（含擋下 `--copy`）、新聞保留邊界與跨年、
新聞 pubDate 相同時的穩定 tie-breaker、子集合安全網（含擋下
`--copy`）、未知頂層集合安全網（含擋下 `--copy`）、copy 報告
eligible/success/skipped/failed/excluded 一致性、checkpoint fail-closed
（checkpoint 文件已刪除、cutoff 改變、來源/目的專案改變、checkpoint
JSON 損壞、atomic write 不留暫存檔）、部分失敗後可重跑、verify
找出缺少/不同/多出的文件與非 0 結束碼、憑證與錯誤訊息（含 checkpoint
檔案）不外洩秘密、跟 `functions/news_cleanup.py` 保留政策的一致性、
`db_same_project.py` 的 get_app()-優先/新建/singleton 三種情境。

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

關鍵原則：**先把 tbm 端準備到「跟 monitor 行為一致」的狀態並驗證過，
才暫停排程做最後一次同步，把 writer 切過去**——切換的瞬間 monitor 停止
接受新寫入、tbm 開始接受新寫入，中間沒有兩邊都在寫的空窗，避免
split-brain（見第 9 節 rollback 的說明，這也是切換後 rollback 不再是
「單純改回舊設定」的原因）。

**A. 建立 `transcend-news-tbm` Firebase Web App，但先不切換**
   在 Firebase Console 建立 Web App、取得 `apiKey`/`appId` 等設定值，
   先記下來，`src/services/firebase.js` 暫時不動。

**B. 先部署 Firestore Rules 與 Indexes 到 `transcend-news-tbm`**
   把 `docs/firestore-migration/firestore.tbm.{rules,indexes.json}`
   複製成根目錄檔案，`firebase.json` 暫時加入 `"firestore"` 區塊，
   `firebase deploy --only firestore:rules,firestore:indexes --project transcend-news-tbm`。

**C. 等 composite index 狀態變成 `Enabled`**
   在 Console 確認（`news` collection、`cat` Ascending + `pubDate`
   Descending），通常幾分鐘，視資料量而定。**這一步之前不能有任何
   讀取流量依賴這個 index**（此時前端還沒切過去，沒有影響）。

**D. initial copy**
   依第 1 節取得 `transcend-news-monitor` 的 `roles/datastore.viewer`後：
   ```bash
   python3 tools/migrate_firestore.py \
     --source-project transcend-news-monitor --dest-project transcend-news-tbm \
     --source-credentials <來源唯讀金鑰> --dest-credentials <目的讀寫金鑰> \
     --checkpoint-file /path/to/checkpoint.json \
     --copy --i-approve-writing-to-dest
   ```
   這時候 monitor 仍然是正式資料庫，Functions/前端都還沒切換，monitor
   端持續有新資料寫入是預期的——這一步只是把「大部分資料」先搬過去，
   減少最後停機同步的資料量。

**E. verify**
   確認 initial copy 沒有嚴重問題（`missing_in_dest`/`differs` 應該很少，
   因為 monitor 端在 copy 期間仍持續變動是正常的）。

**F. 暫停所有會寫 Firestore 的 Cloud Scheduler jobs**
   `stocks_job`/`news_job`/`trading_job`/`finance_job`/
   `finance_early_month_job`/`tw_dram_digest_job`/`us_dram_digest_job`/
   `news_cleanup_job` 全部暫停（Cloud Scheduler 主控台或
   `gcloud scheduler jobs pause`）。**從這一刻起，monitor 端不再有新
   寫入**——這是避免 split-brain 的關鍵：writer 只會存在於這之後才
   啟用的 tbm 端，不會同時有兩個專案接受寫入。

**G. 不使用舊 checkpoint，執行 final full/delta copy**
   刻意不沿用步驟 D 的 checkpoint 檔案（換一個新的 `--checkpoint-file`
   路徑，或不指定）——因為現在 monitor 端已經靜止（writer 暫停），這次
   要確保是對「靜止狀態」做一次完整、乾淨的同步，不是接續一個可能跨越
   了 monitor 仍在寫入期間的舊游標。

**H. final verify，必須零 missing、零 differs**
   `--verify` 的 `missing_in_dest`/`differs`/`extra_in_dest` 必須全部
   是空的（結束碼 `0`）才能繼續下一步；只要有任何一筆對不上，停下來
   查清楚原因，不能帶著已知的不一致繼續切換。

**I. 切換並部署 Functions**
   依第 6 節切換 `main.py` 的 `get_db()`（改用 `db_same_project.py`）、
   移除 `MONITOR_SERVICE_ACCOUNT` 依賴，
   `firebase deploy --only functions --project transcend-news-tbm`。

**J. 切換並部署 Hosting**
   `src/services/firebase.js` 的 `FIREBASE_CONFIG` 換成步驟 A 的值，
   `npm run build && firebase deploy --only hosting:main --project transcend-news-tbm`。

**K. 做正式網站與 Firestore 寫入驗證**
   打開正式網站確認資料正常顯示（PR/IR/上游市場三個分頁）、Console 沒有
   新增錯誤；手動確認至少一次 Functions 執行有成功寫入 tbm 的 Firestore
   （例如短暫恢復 `stocks_job` 觀察一次股價更新是否寫進 tbm）。

**L. 恢復 Scheduler jobs**
   確認 K 沒問題後，把步驟 F 暫停的所有 job 恢復正常排程。

**M. 觀察完整排程週期**
   觀察至少一個完整排程週期（含每天 02:30 的 `news_cleanup_job`、每天
   17:30 的 `finance_job`、平日 08:00/16:30 的兩個摘要信 job）確認一切
   正常，才考慮之後撤銷 `MONITOR_SERVICE_ACCOUNT` secret 與
   `transcend-news-monitor` 那把對應金鑰（撤銷前務必再三確認沒有其他
   用途還在依賴它）。**`transcend-news-monitor` 的 Firestore 資料庫本身
   不需要刪除**，作為切換後一段時間的最終備援。

## 9. Rollback 步驟

**重要更正**：這裡不再宣稱「切換後任何時間都可以直接退回舊專案、不會
遺失資料」——那個說法只在 monitor 端從頭到尾維持唯讀時才成立。一旦
`transcend-news-tbm` 開始接受新寫入（第 8 節步驟 F 之後），rollback
就不再是「單純改回舊設定」，必須先處理資料方向，避免退回後又反過來
造成 monitor/tbm 兩邊都有寫入的 split-brain：

- **步驟 A–E（Web App 建立／Rules-Indexes 部署／initial copy／verify，
  Scheduler 尚未暫停）之前想退回**：monitor 端全程唯讀，直接放棄這些
  準備動作即可，不影響任何正式服務，資料不會遺失。
- **步驟 F 之後（Scheduler 已暫停，monitor 端不再接受新寫入）想退回，
  但還沒切換 Functions/Hosting（步驟 I/J 之前）**：把步驟 F 暫停的
  Scheduler jobs 恢復即可——monitor 端恢復接受寫入，因為 Functions/前端
  都還沒切換到 tbm，沒有任何一方誤寫，資料不會遺失。
- **步驟 I/J 之後（Functions/Hosting 已經切到 tbm、tbm 已經有新寫入）
  想退回**：**不能只是把設定改回去**，而且**絕對不能把
  `tools/migrate_firestore.py` 的 `--source-project`/`--dest-project`
  對調直接反過來跑一次當作 rollback 手段**——這個工具是針對「monitor
  （全程唯讀）→ tbm（一開始是空的）」這個單一方向設計、驗證過的一次性
  搬移工具，反過來用完全是不同的問題，理由：
  1. `transcend-news-monitor` 目前只規劃、也只驗證過
     `roles/datastore.viewer`（唯讀）；反向把 tbm 的資料寫回 monitor
     需要 `roles/datastore.user`，這個角色從未被授予、也從未驗證過能
     正常寫入 monitor，不能假設它可用。
  2. `transcend-news-monitor` 可能仍保留搬移範圍（本月＋上個月）以外
     的舊新聞資料——這些資料從未被本工具讀取或比對過。如果直接對調
     方向執行 `--verify`，這些範圍外的舊資料會被大量列為
     `extra_in_dest`/`missing_in_dest`，產生跟實際問題無關的雜訊，
     反而讓真正需要處理的差異被淹沒。
  3. 本工具從未作為「rollback／增量同步」流程被設計或測試過：它假設
     目的端一開始是空的、只做單向、整批覆寫式的冪等寫入，並不處理
     「monitor 和 tbm 兩邊在切換後可能各自累積了新資料，需要合併或
     取捨」這種雙向同步情境。

  正確做法：
  1. **立即先暫停 tbm 端的 Scheduler jobs（此時唯一的 writer）**，停止
     任何一端繼續寫入——這是切換後一旦發現問題應該做的第一步，不需要
     等資料方向想清楚了才做。
  2. Rollback 需要一個**獨立規劃、審查並測試過的增量同步工具**（目前
     尚未實作），設計上必須同時處理「tbm 切換後新增/變更的資料」與
     「monitor 端是否存在搬移範圍外、需要排除的既有資料」，而不是把
     現有的單向搬移工具參數對調了事。
  3. 建置並使用這個增量同步工具之前，需要先向
     `transcend-news-monitor` 申請並驗證足夠的寫入權限
     （`roles/datastore.user`，目前只有唯讀）。
  4. 在增量同步工具存在並通過測試之前，**如果切換後發現資料問題，
     正確且唯一該做的第一個動作是停止 writer（步驟 1），不得自行反向
     執行目前這個（單向）搬移工具**，也不建議臨時放寬 monitor 端的
     IAM 權限來湊合著跑。
  5. 增量同步工具就緒、驗證資料一致後，才把 Functions/Hosting 設定
     改回指向 `transcend-news-monitor` 並部署，接著才恢復 Scheduler
     jobs——同一時間只能有一個專案在接受寫入。
- **Rules/Indexes**：`transcend-news-monitor` 的 Rules/Indexes 在整個
  流程中都沒有被更動過，rollback 不需要對它做任何事；
  `transcend-news-tbm` 上部署的 Rules/Indexes 即使切回 monitor 也不需要
  立刻撤除（沒人在讀寫它，多留著沒有風險）。
- **最壞情況（切換後才發現資料有問題，且已經撤銷了
  `MONITOR_SERVICE_ACCOUNT`）**：`transcend-news-monitor` 的 Firestore
  資料庫本身仍然存在（只是 Functions 沒有憑證存取），還原一把新的
  service account 金鑰即可恢復存取，但仍然必須先執行上面「步驟 I/J
  之後」的資料方向決定與同步流程，不能直接切回去。
