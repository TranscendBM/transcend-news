"""
Firestore 資料庫合併工具：transcend-news-monitor → transcend-news-tbm。

背景：正式服務（Hosting/Functions/Scheduler）都已經在 transcend-news-tbm，
但 Firestore 資料庫至今仍是舊專案 transcend-news-monitor（Functions 透過
Secret Manager 的 MONITOR_SERVICE_ACCOUNT 跨專案讀寫）。這個工具是那次
資料庫搬遷本身：把 transcend-news-monitor 的資料複製到 transcend-news-tbm
（目前是空的），讓之後前端／Functions 可以切換成同專案存取。

本工具「只搬資料」，不會：
  - 修改 transcend-news-monitor 的任何資料（一律唯讀）
  - 執行 firebase deploy 或任何 Firestore import/export
  - 自動切換前端／Functions 使用哪個專案（那是另一個步驟，見
    docs/firestore-migration/README.md 的「正式切換」章節）

三個模式：
  --dry-run  只讀取來源、統計每個集合預計搬移/排除的文件數，完全不寫入
             目的端（甚至不需要目的端有寫入權限）。也會做「有沒有不支援
             的頂層集合／子集合／未分類 meta 文件」的安全檢查——這些
             檢查同時是 --copy 執行前的強制前置檢查（見下方）。
  --copy     實際把符合範圍的文件寫入目的端（見下方「複製方式」）。
             需要額外加上 --i-approve-writing-to-dest 才會執行；執行前
             一律先做一次等同 --dry-run 的安全檢查，發現未知頂層集合、
             未分類 meta 文件、或任何文件底下有子集合（本工具不支援
             搬移子集合），一律拒絕執行，沒有任何旗標可以略過這個檢查——
             要嘛先確認/處理清楚，要嘛就是程式碼本身要更新白名單。
  --verify   比較來源與目的端：目的端缺少的文件、內容不同的文件、目的端
             多出來的文件（extra_in_dest）、一致的文件數，以及目的端有
             沒有出現未知頂層集合。發現任何 missing/differs，或發現不在
             預期範圍內的 extra，行程式結束碼非 0（給 CI/腳本判斷用）。
             不會寫入任何一端。

複製方式（冪等）：
  - 文件 ID 完全比照來源（不重新產生），所以同一個文件重跑會覆寫成
    跟來源一致的內容，不會產生重複資料。
  - 每個集合依文件 ID 排序分頁讀取（news 額外用 pubDate 當主要排序、
    文件 ID 當穩定 tie-breaker，避免 pubDate 相同時分頁順序不穩定），
    不會把整個集合一次讀進記憶體。
  - 寫入用 Firestore WriteBatch，每個 batch 最多 --batch-size 筆
    （預設 400，硬性上限 500，超過會直接拒絕啟動）。

安全中斷後重跑：
  - `stocks`/`revenue`/`financials`/`dividends`/`material`/`daily`/`meta`
    這幾個集合支援 --checkpoint-file：記錄每個集合「最後成功寫入的
    Firestore 排序游標值」（不是文件 ID 比對——即使該筆之後在來源端被
    刪除或不再符合條件，游標值本身仍然可以正確定位分頁位置，不會因為
    「找不到那個文件」就整個集合的後續資料都被誤判成已處理而略過）。
    這幾個集合的排序游標都是純文件 ID 字串，天生可以安全序列化成 JSON。
    checkpoint 綁定這次執行的來源/目的專案、cutoff、集合清單、頁面
    大小與格式版本（fingerprint）；只要其中任何一項對不上（例如換了
    專案、跨月導致 cutoff 改變、集合清單不同），或檔案損毀/不完整，
    一律視為不可用、記錄警告、該次執行對所有集合從頭開始（絕不靜默
    沿用一個對不上的舊 checkpoint、也絕不因為 cursor 無法確認就跳過
    整個集合）。checkpoint 檔案採 atomic write（先寫暫存檔、fsync 後
    os.replace()），中途中斷不會留下損毀的半寫入檔案。
  - `news`/`ai_jobs`/`ai_insights`：**刻意不支援** checkpoint 續傳，一律
    從頭冪等重跑。news 分頁排序用 (pubDate, 文件 ID)——pubDate 是
    `datetime`，不是純字串，無法安全寫進 JSON checkpoint 檔案（曾經
    嘗試支援過，結果是 commit 明明成功、卻在寫 checkpoint 時序列化
    datetime 失敗而被誤判成批次寫入失敗；與其為了 news 另外設計一套
    有型別、可逆的 Timestamp 序列化格式，不如直接比照 ai_jobs/
    ai_insights：不留持久化進度，中斷後整個重新執行一次，冪等寫入確保
    最終結果正確）。ai_jobs/ai_insights 這兩個集合則是本來就不是
    Firestore 原生分頁查詢（是依 news id 清單逐筆 get()），沒有自然的
    查詢游標可用；以目前的資料量，中斷後直接重新完整執行一次遠比為了
    這種「依本地清單逐筆查」的存取模式另外發明一套游標格式簡單可靠。

資料範圍：
  - stocks / revenue / financials / dividends / material / daily：
    現況快照類資料，沒有保存期限，全量搬移。
  - news：只搬「本月＋上個月」（Asia/Taipei 日曆月份），跟
    functions/news_cleanup.py 的保留政策完全一致（不搬即將被清理的
    過期新聞）——見 retention_cutoff()。
  - ai_jobs / ai_insights：只搬文件 ID 對應到「本次會搬移的 news 文件」
    的那些（跟 functions/news_cleanup.py 的 RELATED_COLLECTIONS 邏輯
    對齊：這兩個集合本來就是以 news 的 article id 為鍵、一對一關聯）。
    不會整批搬移這兩個集合。
  - meta：只搬白名單內的文件（見 META_PRESERVE_IDS 說明）；lock_* 一律
    排除；其餘未知的 meta 文件 ID 一律不搬，只列在報告裡供人工確認，且
    會擋下 --copy（見上方安全檢查說明）。
  - 任何不在上述清單內的頂層集合，--dry-run 會透過 Firestore 原生的
    「列出頂層集合」呼叫實際列出來（不是憑印象／README 猜測），並在
    報告中標記為「未知集合，本工具尚未支援搬移規則」，同樣會擋下 --copy。
  - 任何文件底下若存在子集合，本工具不支援搬移子集合內容；--dry-run 會
    明確列出（collection、文件 ID、子集合名稱），同樣會擋下 --copy。

安全防呆：
  - --source-project 與 --dest-project 必須明確指定，沒有任何預設值。
  - 兩者相同時立即拒絕執行（防止打錯參數把同一個專案當來源跟目的地）。
  - --page-size / --batch-size 必須是正整數；--batch-size 不得超過 500。
  - --collections 只能是本工具已知的集合名稱，出現未知名稱直接拒絕。
  - 沒有任何「一律略過安全檢查」的通用旗標（例如 --force）。
  - 所有輸出只包含集合名稱、文件 ID、數量與錯誤類型，絕不印出文件
    內容或任何憑證/Secret 內容。
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import json
import logging
import os
import sys
import tempfile
from zoneinfo import ZoneInfo

logger = logging.getLogger('migrate_firestore')

SCHEMA_VERSION = 1

# ══════════════════════════════════════════════════════════════
# 保留範圍（跟 functions/news_cleanup.py 的 _retention_cutoff 完全一致：
# 「本月＋上個月」，以 Asia/Taipei 日曆月份計算）
# ══════════════════════════════════════════════════════════════
TAIPEI_TZ = ZoneInfo('Asia/Taipei')


def retention_cutoff(now):
    """
    純函式，邏輯與 functions/news_cleanup.py 的 _retention_cutoff 完全相同
    （刻意重寫一份而不是跨目錄 import——tools/ 跟 functions/ 是分開部署的
    程式碼，不共用執行環境/相依套件），回傳「上個月 1 日 00:00 台灣時間」。
    news 文件的 pubDate >= 這個時間點才視為「本次要搬移」的範圍，
    跟 news_cleanup 的「pubDate < cutoff 才刪除」正好是同一個邊界的
    互補條件，兩邊如果之後各自修改，靠 tests/test_migrate_firestore.py
    裡的一致性測試互相校對。
    """
    taipei_now = now.astimezone(TAIPEI_TZ)
    this_month_start = datetime.datetime(taipei_now.year, taipei_now.month, 1, tzinfo=TAIPEI_TZ)
    last_day_of_prev_month = this_month_start - datetime.timedelta(days=1)
    return datetime.datetime(
        last_day_of_prev_month.year, last_day_of_prev_month.month, 1, tzinfo=TAIPEI_TZ)


# ══════════════════════════════════════════════════════════════
# 集合搬移規則
# ══════════════════════════════════════════════════════════════

# 現況快照類集合：沒有保存期限概念，全量搬移，支援 checkpoint 續傳。
FULL_COPY_COLLECTIONS = ('stocks', 'revenue', 'financials', 'dividends', 'material', 'daily')

# news 的關聯集合（一對一，以 article id 為鍵）；只搬跟本次搬移的 news
# 文件對應的那些，不整批搬移，且刻意不支援 checkpoint 續傳（見模組
# docstring「安全中斷後重跑」）。
NEWS_RELATED_COLLECTIONS = ('ai_jobs', 'ai_insights')

# meta/lock_* 一律不搬（排程用的暫時鎖，搬過去只會造成困惑或誤判鎖定中）。
META_LOCK_PREFIX = 'lock_'

# meta/newsIndex_0 .. newsIndex_f：新聞去重索引分片，共 16 個。必須保留，
# 否則切換後第一次執行 news_job 會因為索引是空的而把所有新聞當成新文章
# 重新處理一次（見 functions/fetch_news.py 的「去重索引（分片設計）」）。
META_NEWS_INDEX_SHARD_IDS = frozenset(f'newsIndex_{c}' for c in '0123456789abcdef')

# meta/digest_tw、meta/digest_us：DRAM/Flash 摘要信的「上次寄送時間」
# 進度追蹤（見 functions/digest.py _checkpoint_ref）。必須保留，否則
# 切換後下一次排程會用預設回溯窗口重新寄一次可能已經寄過的新聞。
META_DIGEST_CHECKPOINT_IDS = frozenset({'digest_tw', 'digest_us'})

# meta/migration_news_date_fix_20260722：一次性歷史資料日期修正的完成
# 標記（見 functions/fetch_news.py NEWS_DATE_CORRECTION_MARKER）。保留
# 它是無害的稽核紀錄；若遺漏，函式重跑該修正也是冪等的（相同內容
# merge 一次），但保留可以避免多一次不必要的寫入且維持稽核連續性。
META_ONE_TIME_MARKER_IDS = frozenset({'migration_news_date_fix_20260722'})

META_PRESERVE_IDS = META_NEWS_INDEX_SHARD_IDS | META_DIGEST_CHECKPOINT_IDS | META_ONE_TIME_MARKER_IDS

ALL_KNOWN_COLLECTIONS = FULL_COPY_COLLECTIONS + ('news',) + NEWS_RELATED_COLLECTIONS + ('meta',)

# 支援 checkpoint 續傳的集合（見模組 docstring「安全中斷後重跑」）。
# news 刻意不在這裡：它的排序游標含 datetime，無法安全序列化進 JSON
# checkpoint 檔案（見上方 docstring 說明），一律比照 ai_jobs/ai_insights
# 從頭冪等重跑。
CHECKPOINTABLE_COLLECTIONS = FULL_COPY_COLLECTIONS + ('meta',)


def classify_meta_doc_id(doc_id):
    """
    回傳 'exclude_lock' / 'preserve' / 'unclassified'。

    'unclassified' 的文件絕不自動搬移——這是刻意的：規格明確要求「其他
    meta 文件先列出文件 ID 與用途，不能自行決定是否移轉」，所以任何不在
    上面兩份白名單內的 meta 文件，一律只列在報告裡，需要人工確認後才能
    考慮是否加進 META_PRESERVE_IDS。
    """
    if doc_id.startswith(META_LOCK_PREFIX):
        return 'exclude_lock'
    if doc_id in META_PRESERVE_IDS:
        return 'preserve'
    return 'unclassified'


class MigrationError(Exception):
    """設定或防呆檢查失敗（尚未碰任何 Firestore 呼叫，或安全檢查擋下執行）。"""


# ══════════════════════════════════════════════════════════════
# 排序游標：分頁用「欄位值」而不是「文件 ID 比對」續傳，這樣即使該筆
# 文件之後被刪除或不再符合條件，游標值本身仍然能正確定位分頁位置。
# ══════════════════════════════════════════════════════════════

def _id_cursor(snap):
    return (snap.id,)


def _pubdate_cursor(snap):
    data = snap.to_dict() or {}
    return (data.get('pubDate'), snap.id)


def _paginate_by_document_id(collection_ref, page_size, order_by_id_fn, start_cursor=None):
    """
    依文件 ID 排序分頁讀取整個集合，yield 每一頁的 snapshot list。
    order_by_id_fn(query) 由呼叫端決定「依文件 ID 排序」要怎麼呼叫
    （真正的 Firestore client 用 order_by(FieldPath.document_id())，
    測試用的 FakeFirestore 用最簡單的 order_by_document_id()）。
    start_cursor 是「欄位值」的 tuple/list（不是 snapshot、也不是文件
    ID 比對），對應 Firestore Query.start_after() 接受 list/tuple 值
    當作查詢結果游標的用法——這個值不需要對應的文件仍然存在。
    """
    cursor = list(start_cursor) if start_cursor else None
    while True:
        query = order_by_id_fn(collection_ref).limit(page_size)
        if cursor is not None:
            query = query.start_after(cursor)
        page = list(query.stream())
        if not page:
            return
        yield page
        cursor = list(_id_cursor(page[-1]))


def _paginate_news_in_window(db, cutoff, page_size, order_by_pubdate_fn, start_cursor=None):
    """
    依 (pubDate, 文件 ID) 排序分頁讀取 pubDate >= cutoff 的 news 文件
    （本次搬移範圍），文件 ID 當穩定 tie-breaker——pubDate 相同的文件
    在沒有次要排序鍵時，分頁順序不保證穩定，可能造成漏筆或重複頁。
    邏輯上是 functions/news_cleanup.py `pubDate < cutoff 才刪除` 的互補
    條件：這裡搬「>= cutoff」，news_cleanup 之後清「< cutoff」。
    """
    query_base = db.collection('news').where('pubDate', '>=', cutoff)
    cursor = list(start_cursor) if start_cursor else None
    while True:
        query = order_by_pubdate_fn(query_base).limit(page_size)
        if cursor is not None:
            query = query.start_after(cursor)
        page = list(query.stream())
        if not page:
            return
        yield page
        cursor = list(_pubdate_cursor(page[-1]))


# ══════════════════════════════════════════════════════════════
# Checkpoint：fail-closed，fingerprint 綁定這次執行的參數，atomic write
# ══════════════════════════════════════════════════════════════

def _build_fingerprint(source_project, dest_project, cutoff, collections, page_size):
    return {
        'schema_version': SCHEMA_VERSION,
        'source_project': source_project,
        'dest_project': dest_project,
        'cutoff': cutoff.isoformat(),
        'collections': sorted(collections),
        'page_size': page_size,
    }


class Checkpoint:
    """
    本地端進度紀錄（只存排序游標值，不存文件內容），用於安全中斷後重跑
    時跳過已成功寫入目的端的部分。

    Fail-closed：載入時如果檔案不存在、損毀、或跟這次呼叫端傳入的
    fingerprint（來源/目的專案、cutoff、集合清單、page_size、格式版本）
    對不上，一律視為「沒有可用的舊進度」，所有集合從頭開始，並立刻把
    新的 fingerprint 寫回檔案——絕不假裝在延續一個其實對不上的舊
    checkpoint，也絕不因為某個 cursor 看起來怪怪的就跳過整個集合
    （跳過=風險，從頭重跑=安全，兩者不確定時一律選後者）。
    """

    def __init__(self, path=None):
        self.path = path
        self.data = {'fingerprint': None, 'cursors': {}}

    def load_or_reset(self, fingerprint):
        raw = self._read_raw()
        if raw is not None and isinstance(raw, dict) and raw.get('fingerprint') == fingerprint \
                and isinstance(raw.get('cursors'), dict):
            self.data = raw
            return
        if raw is not None:
            logger.warning(
                'checkpoint 檔案跟這次執行的參數（來源/目的專案、cutoff、集合清單、'
                'page_size 或格式版本）不符，或內容不完整——捨棄舊 checkpoint，'
                '所有支援續傳的集合這次從頭開始（安全、冪等，只是會重新處理已經'
                '搬過的文件）。')
        self.data = {'fingerprint': fingerprint, 'cursors': {}}
        self._write_atomic()

    def _read_raw(self):
        if self.path is None:
            return None
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as e:
            logger.warning('checkpoint 檔案損毀（%s: %s），視同不存在。', type(e).__name__, e)
            return None

    def cursor_for(self, collection):
        cur = self.data['cursors'].get(collection)
        return tuple(cur) if cur is not None else None

    def mark(self, collection, cursor_values):
        self.data['cursors'][collection] = list(cursor_values)
        self._write_atomic()

    def _write_atomic(self):
        """先寫暫存檔、fsync、再 os.replace()——中途中斷不會留下損毀的
        半寫入檔案，讀到的要嘛是完整的舊內容、要嘛是完整的新內容。"""
        if self.path is None:
            return
        directory = os.path.dirname(os.path.abspath(self.path))
        fd, tmp_path = tempfile.mkstemp(dir=directory, prefix='.migrate-checkpoint-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(self.data, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.path)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.remove(tmp_path)
            raise


# ══════════════════════════════════════════════════════════════
# Report 資料結構
# ══════════════════════════════════════════════════════════════

def _new_collection_report():
    return {
        'total_in_source': 0,
        'eligible': 0,
        'excluded': 0,
        'success': 0,
        'skipped': 0,
        'failed': 0,
        'failed_ids': [],       # 只放文件 ID，不放內容
        'unclassified_ids': [], # 只有 meta 集合會用到
        'halted': False,        # 這個集合這次執行是否因為批次寫入失敗而提前中止
        'checkpoint_error': None,  # batch commit 成功、但 checkpoint 進度檔寫入失敗時的錯誤描述
    }


# ══════════════════════════════════════════════════════════════
# 子集合安全檢查：本工具不支援搬移子集合，發現了就必須明確列出並擋下 --copy
# ══════════════════════════════════════════════════════════════

def _check_subcollections(snap, coll_name, findings, scan_errors):
    """
    findings：確認「有」子集合的文件。scan_errors：檢查本身失敗、
    「無法確認」有沒有子集合的文件——這兩者不能混為一談：「無法確認」
    絕不能被當成「確認沒有」，否則 --copy 會在看不清楚的情況下放行。
    """
    ref = getattr(snap, 'reference', None)
    if ref is None or not hasattr(ref, 'collections'):
        scan_errors.append({'collection': coll_name, 'doc_id': snap.id,
                             'reason': '文件快照沒有可檢查子集合的 reference'})
        return
    try:
        subs = [c.id for c in ref.collections()]
    except Exception as e:  # noqa: BLE001 - 檢查本身失敗不應該讓整個 dry-run 掛掉
        scan_errors.append({'collection': coll_name, 'doc_id': snap.id,
                             'reason': f'{type(e).__name__}: {e}'})
        logger.warning('檢查 %s/%s 是否有子集合時發生錯誤（%s: %s），視為無法確認',
                        coll_name, snap.id, type(e).__name__, e)
        return
    if subs:
        findings.append({'collection': coll_name, 'doc_id': snap.id, 'subcollections': subs})


# ══════════════════════════════════════════════════════════════
# dry-run：只讀取、統計，完全不寫入。也是 --copy 的強制前置安全檢查。
# ══════════════════════════════════════════════════════════════

def dry_run_report(source_db, now, page_size, order_by_id_fn, order_by_pubdate_fn,
                    collections=ALL_KNOWN_COLLECTIONS):
    """
    回傳 {collection_name: report_dict, '_unrecognized_collections': [...],
    '_subcollections_found': [...], '_subcollection_scan_errors': [...]}。
    只呼叫 source_db 的讀取方法，不會呼叫任何 write/set/delete/batch。

    `_subcollections_found` 是「確認有」子集合的文件；
    `_subcollection_scan_errors` 是「檢查本身失敗、無法確認」的文件——
    兩者都會擋下 --copy（見 _blocking_issues），因為「無法確認」不等於
    「確認沒有」。
    """
    cutoff = retention_cutoff(now)
    reports = {}
    subcollection_findings = []
    subcollection_scan_errors = []

    if 'news' in collections:
        reports['news'] = _dry_run_news(source_db, cutoff, page_size, order_by_pubdate_fn,
                                         subcollection_findings, subcollection_scan_errors)
        eligible_news_ids = reports['news'].pop('_eligible_ids')
    else:
        eligible_news_ids = set()

    for coll in FULL_COPY_COLLECTIONS:
        if coll in collections:
            reports[coll] = _dry_run_full_copy(source_db, coll, page_size, order_by_id_fn,
                                                subcollection_findings, subcollection_scan_errors)

    for coll in NEWS_RELATED_COLLECTIONS:
        if coll in collections:
            reports[coll] = _dry_run_related(source_db, coll, page_size, order_by_id_fn,
                                              eligible_news_ids, subcollection_findings,
                                              subcollection_scan_errors)

    if 'meta' in collections:
        reports['meta'] = _dry_run_meta(source_db, page_size, order_by_id_fn, subcollection_findings,
                                         subcollection_scan_errors)

    # 安全網：實際列出來源端所有頂層集合，任何不在 ALL_KNOWN_COLLECTIONS
    # 的集合都要浮上來，不能被漏掉或被誤以為「反正 README 沒提到就沒事」。
    reports['_unrecognized_collections'] = _list_unrecognized_collections(source_db, collections)
    reports['_subcollections_found'] = subcollection_findings
    reports['_subcollection_scan_errors'] = subcollection_scan_errors

    return reports


def _dry_run_full_copy(source_db, coll_name, page_size, order_by_id_fn, subcollection_findings,
                        subcollection_scan_errors):
    report = _new_collection_report()
    for page in _paginate_by_document_id(source_db.collection(coll_name), page_size, order_by_id_fn):
        report['total_in_source'] += len(page)
        report['eligible'] += len(page)
        for snap in page:
            _check_subcollections(snap, coll_name, subcollection_findings, subcollection_scan_errors)
    return report


def _dry_run_news(source_db, cutoff, page_size, order_by_pubdate_fn, subcollection_findings,
                   subcollection_scan_errors):
    report = _new_collection_report()
    eligible_ids = set()
    for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
        for snap in page:
            report['eligible'] += 1
            eligible_ids.add(snap.id)
            _check_subcollections(snap, 'news', subcollection_findings, subcollection_scan_errors)
    # total_in_source：news 集合的總量不在本工具的搬移範圍內，也沒有必要
    # 為了統計而讀整個集合（可能是數千篇）；dry-run 只需要知道「這次會
    # 搬幾篇」，不需要「來源總共有幾篇」。刻意留白，避免誤導成
    # 「total_in_source 就是全部 news 文件數」。
    report['total_in_source'] = None
    report['_eligible_ids'] = eligible_ids
    return report


def _dry_run_related(source_db, coll_name, page_size, order_by_id_fn, eligible_news_ids,
                      subcollection_findings, subcollection_scan_errors):
    report = _new_collection_report()
    report['total_in_source'] = None  # 理由同 news：不需要讀整個集合來統計
    coll_ref = source_db.collection(coll_name)
    for doc_id in sorted(eligible_news_ids):
        snap = coll_ref.document(doc_id).get()
        if getattr(snap, 'exists', False):
            report['eligible'] += 1
            _check_subcollections(snap, coll_name, subcollection_findings, subcollection_scan_errors)
        else:
            report['excluded'] += 1
    return report


def _dry_run_meta(source_db, page_size, order_by_id_fn, subcollection_findings,
                   subcollection_scan_errors):
    report = _new_collection_report()
    for page in _paginate_by_document_id(source_db.collection('meta'), page_size, order_by_id_fn):
        for snap in page:
            report['total_in_source'] += 1
            cls = classify_meta_doc_id(snap.id)
            if cls == 'preserve':
                report['eligible'] += 1
                _check_subcollections(snap, 'meta', subcollection_findings, subcollection_scan_errors)
            elif cls == 'exclude_lock':
                report['excluded'] += 1
            else:
                report['unclassified_ids'].append(snap.id)
    return report


def _list_unrecognized_collections(source_db, collections):
    """
    實際呼叫 Firestore 的『列出頂層集合』，回傳任何不在
    ALL_KNOWN_COLLECTIONS（且本次也不是刻意排除）裡的集合名稱列表。
    這是本工具「不可只依 README 猜測」的具體實作：每次 dry-run 都會
    重新列一次，不是寫死的清單。
    """
    try:
        live_collections = {c.id for c in source_db.collections()}
    except AttributeError:
        # Fake/簡化版測試替身沒有實作 collections()：視同「無法列出」，
        # 回傳 None 明確表示這項檢查沒有執行，不要假裝成『已確認沒有』。
        return None
    return sorted(live_collections - set(ALL_KNOWN_COLLECTIONS))


def _blocking_issues(reports):
    """
    回傳 dry-run 報告中會擋下 --copy 的問題描述列表（人類可讀字串）；
    空列表代表可以放行。這是唯一判斷「能不能 --copy」的地方，--copy
    的前置檢查與使用者自己執行 --dry-run 看到的訊息完全一致。
    """
    issues = []
    unrecognized = reports.get('_unrecognized_collections')
    if unrecognized is None:
        issues.append('無法列出來源端頂層集合（憑證或替身不支援 collections()），'
                       '無法確認是否有未知集合，基於 fail-closed 原則拒絕 --copy')
    elif unrecognized:
        issues.append(f'來源端發現未知頂層集合，本工具尚未支援搬移規則：{unrecognized}')
    subcols = reports.get('_subcollections_found')
    if subcols:
        issues.append(f'發現 {len(subcols)} 個文件底下有子集合，本工具不支援搬移子集合內容：{subcols}')
    scan_errors = reports.get('_subcollection_scan_errors')
    if scan_errors:
        issues.append(f'{len(scan_errors)} 個文件的子集合檢查失敗，無法確認是否有子集合'
                       f'（無法確認不等於確認沒有，基於 fail-closed 原則拒絕 --copy）：{scan_errors}')
    for coll, r in reports.items():
        if coll.startswith('_'):
            continue
        if r.get('unclassified_ids'):
            issues.append(f'集合 {coll} 有未分類的 meta 文件，需要人工確認後更新程式碼白名單：'
                           f'{r["unclassified_ids"]}')
    return issues


# ══════════════════════════════════════════════════════════════
# copy：實際寫入目的端
# ══════════════════════════════════════════════════════════════

def _commit_batch(dest_db, ops, batch_size):
    """ops: [(coll_name, doc_id, data, cursor), ...]。每 batch_size 筆提交一次。"""
    if len(ops) > 500:
        raise MigrationError(f'batch 操作數 {len(ops)} 超過 Firestore 500 上限')
    batch = dest_db.batch()
    for coll_name, doc_id, data, _cursor in ops:
        batch.set(dest_db.collection(coll_name).document(doc_id), data)
    batch.commit()


def _copy_pages(dest_db, coll_name, pages, batch_size, report, checkpoint=None, checkpointable=False):
    """
    共用的分頁寫入邏輯：pages 是「一批 (doc_id, data, cursor) tuple 的
    list」的 iterable（cursor 是該文件在排序中的游標值，只有
    checkpointable=True 時才會被用來寫回 checkpoint）。

    一旦某個 batch 寫入失敗，這個集合本次執行就此停止（不繼續處理後面的
    頁面）：checkpoint 只在 batch 成功提交後才前進，不會被後面剛好成功
    的 batch 推得比失敗點還前面（那樣下次重跑會誤跳過失敗的那批）。
    """
    pending = []

    def flush():
        if not pending:
            return False
        # 階段 A：batch commit。這一步失敗代表文件確定沒有寫入目的端，
        # 全部計入 failed。
        try:
            _commit_batch(dest_db, pending, batch_size)
        except Exception as e:  # noqa: BLE001 - 記錄後停止這個集合本次的後續處理
            report['failed'] += len(pending)
            report['failed_ids'].extend(pid for _c, pid, _d, _cur in pending)
            logger.error(
                '批次寫入 %s 失敗（%d 筆），停止本次對這個集合的後續處理，'
                '下次重跑會從上一個成功的 checkpoint 繼續（不會跳過這批失敗的文件）：%s: %s',
                coll_name, len(pending), type(e).__name__, e)
            return True

        # commit 已經確定成功：這些文件已經寫入目的端，不論階段 B 是否
        # 成功都不能改變這個事實，success 計數在這裡就要定案。
        report['success'] += len(pending)

        # 階段 B：checkpoint 進度持久化，跟階段 A 分開處理。如果這裡失敗，
        # 文件仍然算 success（已經真的寫入了），但無法安全記錄「已經寫到
        # 哪裡」，所以仍然要中止這個集合本次的後續處理（避免下一批的
        # checkpoint 覆蓋掉這一批其實沒寫成功的進度紀錄），並回報
        # checkpoint_error 讓 CLI 能以非 0 結束碼提醒使用者。
        if checkpointable and checkpoint is not None:
            try:
                checkpoint.mark(coll_name, pending[-1][3])
            except Exception as e:  # noqa: BLE001
                report['checkpoint_error'] = f'{type(e).__name__}: {e}'
                logger.error(
                    '%s 的這批文件（%d 筆）已經成功寫入目的端，但 checkpoint 進度檔寫入'
                    '失敗，停止本次對這個集合的後續處理（已寫入的文件仍計入 success，'
                    '不會被誤計為 failed）：%s: %s',
                    coll_name, len(pending), type(e).__name__, e)
                return True
        return False

    # 手動控制迭代（不是直接 for page in pages），確保一旦 halted，絕不
    # 再向 pages 產生器多要一頁，避免報告數字跟實際處理進度對不上。
    pages_iter = iter(pages)
    while not report['halted']:
        try:
            page = next(pages_iter)
        except StopIteration:
            break
        for doc_id, data, cursor in page:
            pending.append((coll_name, doc_id, data, cursor))
            if len(pending) >= batch_size:
                if flush():
                    report['halted'] = True
                pending = []
                if report['halted']:
                    break
    if pending and not report['halted']:
        if flush():
            report['halted'] = True


def copy_all(source_db, dest_db, now, page_size, batch_size, order_by_id_fn, order_by_pubdate_fn,
             checkpoint=None, collections=ALL_KNOWN_COLLECTIONS, source_project=None, dest_project=None):
    """
    實際複製。batch_size 必須 <= 500（呼叫端在 CLI 層已經檔過一次，這裡
    再檔一次是防止被當函式庫直接呼叫時跳過 CLI 檢查）。

    source_project/dest_project 只用於建立 checkpoint fingerprint（見
    Checkpoint 類別說明）；直接呼叫這個函式做測試時可以留空，此時
    checkpoint 一律視為新的（不會有 fingerprint 不符的問題，因為
    fingerprint 本身用 None 也能一致比較）。

    回傳 {collection_name: report_dict}（跟 dry_run_report 同樣的形狀，
    方便共用同一份輸出格式化程式碼）。
    """
    if batch_size > 500:
        raise MigrationError(f'--batch-size={batch_size} 超過 Firestore 單一 WriteBatch 500 次操作上限')
    if batch_size <= 0:
        raise MigrationError(f'--batch-size={batch_size} 必須是正整數')
    if page_size <= 0:
        raise MigrationError(f'--page-size={page_size} 必須是正整數')

    checkpoint = checkpoint or Checkpoint()
    cutoff = retention_cutoff(now)
    fingerprint = _build_fingerprint(source_project, dest_project, cutoff, collections, page_size)
    checkpoint.load_or_reset(fingerprint)

    reports = {}

    eligible_news_ids = set()
    if 'news' in collections:
        report = _new_collection_report()
        report['total_in_source'] = None

        def news_pages():
            for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
                items = []
                for snap in page:
                    eligible_news_ids.add(snap.id)
                    items.append((snap.id, snap.to_dict(), _pubdate_cursor(snap)))
                yield items

        # news 刻意不使用 checkpoint 續傳（見模組 docstring「安全中斷後
        # 重跑」）：它的排序游標含 datetime，無法安全序列化進 JSON
        # checkpoint 檔案，一律從頭冪等重跑。
        _copy_pages(dest_db, 'news', news_pages(), batch_size, report, checkpointable=False)
        report['eligible'] = report['success'] + report['skipped'] + report['failed']
        reports['news'] = report
    else:
        # 需要知道本次「應該」搬移哪些 news id，即使這次沒有真的搬 news
        # （例如分階段執行、只重跑 ai_jobs），才能正確過濾關聯集合。
        for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
            for snap in page:
                eligible_news_ids.add(snap.id)

    for coll in FULL_COPY_COLLECTIONS:
        if coll not in collections:
            continue
        report = _new_collection_report()

        def full_pages(start_cursor=None, coll_name=coll):
            for page in _paginate_by_document_id(source_db.collection(coll_name), page_size,
                                                  order_by_id_fn, start_cursor=start_cursor):
                yield [(snap.id, snap.to_dict(), _id_cursor(snap)) for snap in page]

        start_cursor = checkpoint.cursor_for(coll)
        _copy_pages(dest_db, coll, full_pages(start_cursor), batch_size, report,
                    checkpoint=checkpoint, checkpointable=True)
        # 注意：這是「這次執行實際處理到的筆數」，若這個集合這次被 halted
        # 中止，不代表來源端的真實總數（還有未處理到的部分）。
        report['total_in_source'] = report['success'] + report['skipped'] + report['failed']
        report['eligible'] = report['total_in_source']
        reports[coll] = report

    for coll in NEWS_RELATED_COLLECTIONS:
        if coll not in collections:
            continue
        report = _new_collection_report()
        report['total_in_source'] = None
        coll_ref = source_db.collection(coll)
        sorted_ids = sorted(eligible_news_ids)

        def related_pages(coll_ref=coll_ref, sorted_ids=sorted_ids):
            chunk = []
            for doc_id in sorted_ids:
                snap = coll_ref.document(doc_id).get()
                if getattr(snap, 'exists', False):
                    chunk.append((doc_id, snap.to_dict(), _id_cursor(snap)))
                if len(chunk) >= page_size:
                    yield chunk
                    chunk = []
            if chunk:
                yield chunk

        # ai_jobs/ai_insights 刻意不使用 checkpoint 續傳（見模組 docstring）。
        _copy_pages(dest_db, coll, related_pages(), batch_size, report, checkpointable=False)
        report['eligible'] = report['success'] + report['skipped'] + report['failed']
        report['excluded'] = len(eligible_news_ids) - report['eligible']
        reports[coll] = report

    if 'meta' in collections:
        report = _new_collection_report()

        def meta_pages(start_cursor=None):
            for page in _paginate_by_document_id(source_db.collection('meta'), page_size,
                                                  order_by_id_fn, start_cursor=start_cursor):
                items = []
                for snap in page:
                    report['total_in_source'] += 1
                    cls = classify_meta_doc_id(snap.id)
                    if cls == 'preserve':
                        items.append((snap.id, snap.to_dict(), _id_cursor(snap)))
                    elif cls == 'exclude_lock':
                        report['excluded'] += 1
                    else:
                        report['unclassified_ids'].append(snap.id)
                yield items

        start_cursor = checkpoint.cursor_for('meta')
        _copy_pages(dest_db, 'meta', meta_pages(start_cursor), batch_size, report,
                    checkpoint=checkpoint, checkpointable=True)
        report['eligible'] = report['success'] + report['skipped'] + report['failed']
        reports['meta'] = report

    return reports


def copy_has_failures(reports):
    """
    True 代表這次 --copy 有任何集合出現批次寫入失敗、提前中止、或
    checkpoint 進度寫入失敗——CLI 據此決定結束碼是否非 0，避免「看起來
    跑完了」但其實有文件沒寫成功、或進度沒能安全記錄下來，卻被誤判成
    完全成功（結束碼 0）。
    """
    for coll, r in reports.items():
        if coll.startswith('_'):
            continue
        if r.get('failed', 0) > 0 or r.get('halted') or r.get('checkpoint_error'):
            return True
    return False


# ══════════════════════════════════════════════════════════════
# verify：比較來源與目的端，不寫入任何一端
# ══════════════════════════════════════════════════════════════

def verify_all(source_db, dest_db, now, page_size, order_by_id_fn, order_by_pubdate_fn,
               collections=ALL_KNOWN_COLLECTIONS):
    """
    回傳 {collection_name: {'missing_in_dest': [...], 'differs': [...],
    'extra_in_dest': [...], 'matches': N, 'source_total': N, 'dest_total': N}}
    以及 '_unrecognized_dest_collections'（目的端出現本工具不認得的頂層
    集合——可能是別的用途誤寫進同一個資料庫，或搬移範圍以外的殘留）。
    清單只放文件 ID，不放內容。比對範圍跟 copy_all 完全一致（news 本月
    +上個月、關聯集合依 news id、meta 只比對白名單）。
    """
    cutoff = retention_cutoff(now)
    reports = {}
    eligible_news_ids = set()

    if 'news' in collections:
        report = _verify_report()
        expected_ids = set()
        for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
            for snap in page:
                eligible_news_ids.add(snap.id)
                expected_ids.add(snap.id)
                _verify_one(dest_db, 'news', snap.id, snap.to_dict(), report)
        report['source_total'] = len(expected_ids)
        report['dest_total'] = _count_collection(dest_db, 'news', page_size, order_by_id_fn)
        report['extra_in_dest'] = _find_extra_in_dest(dest_db, 'news', page_size, order_by_id_fn, expected_ids)
        reports['news'] = report
    else:
        for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
            for snap in page:
                eligible_news_ids.add(snap.id)

    for coll in FULL_COPY_COLLECTIONS:
        if coll not in collections:
            continue
        report = _verify_report()
        expected_ids = set()
        for page in _paginate_by_document_id(source_db.collection(coll), page_size, order_by_id_fn):
            for snap in page:
                expected_ids.add(snap.id)
                _verify_one(dest_db, coll, snap.id, snap.to_dict(), report)
        report['source_total'] = len(expected_ids)
        report['dest_total'] = _count_collection(dest_db, coll, page_size, order_by_id_fn)
        report['extra_in_dest'] = _find_extra_in_dest(dest_db, coll, page_size, order_by_id_fn, expected_ids)
        reports[coll] = report

    for coll in NEWS_RELATED_COLLECTIONS:
        if coll not in collections:
            continue
        report = _verify_report()
        source_coll = source_db.collection(coll)
        expected_ids = set()
        for doc_id in sorted(eligible_news_ids):
            snap = source_coll.document(doc_id).get()
            if getattr(snap, 'exists', False):
                expected_ids.add(doc_id)
                _verify_one(dest_db, coll, doc_id, snap.to_dict(), report)
        report['source_total'] = len(expected_ids)
        report['dest_total'] = _count_collection(dest_db, coll, page_size, order_by_id_fn)
        report['extra_in_dest'] = _find_extra_in_dest(dest_db, coll, page_size, order_by_id_fn, expected_ids)
        reports[coll] = report

    if 'meta' in collections:
        report = _verify_report()
        expected_ids = set()
        for page in _paginate_by_document_id(source_db.collection('meta'), page_size, order_by_id_fn):
            for snap in page:
                if classify_meta_doc_id(snap.id) == 'preserve':
                    expected_ids.add(snap.id)
                    _verify_one(dest_db, 'meta', snap.id, snap.to_dict(), report)
        dest_meta_ids = _dest_doc_ids(dest_db, 'meta', page_size, order_by_id_fn)
        report['source_total'] = len(expected_ids)
        report['dest_total'] = len(dest_meta_ids)
        # 正式切換前，目的端本來就不該有任何排程寫入的資料，所以任何不在
        # 這次來源預期範圍內的目的端 meta 文件都要算 extra——包含看起來
        # 像 lock_* 或未分類命名的 ID，不能因為「不像白名單命名規則」就
        # 特別放行，否則 final verify 可能在目的端其實已經有非預期資料
        # 的情況下仍然回報「沒問題」。
        report['extra_in_dest'] = sorted(dest_meta_ids - expected_ids)
        reports['meta'] = report

    reports['_unrecognized_dest_collections'] = _list_unrecognized_collections(dest_db, collections)

    return reports


def _verify_report():
    return {'missing_in_dest': [], 'differs': [], 'extra_in_dest': [], 'matches': 0,
            'source_total': 0, 'dest_total': 0}


def _verify_one(dest_db, coll_name, doc_id, source_data, report):
    dest_snap = dest_db.collection(coll_name).document(doc_id).get()
    if not getattr(dest_snap, 'exists', False):
        report['missing_in_dest'].append(doc_id)
        return
    dest_data = dest_snap.to_dict()
    if dest_data != source_data:
        report['differs'].append(doc_id)
        return
    report['matches'] += 1


def _dest_doc_ids(dest_db, coll_name, page_size, order_by_id_fn):
    ids = set()
    for page in _paginate_by_document_id(dest_db.collection(coll_name), page_size, order_by_id_fn):
        ids.update(snap.id for snap in page)
    return ids


def _count_collection(dest_db, coll_name, page_size, order_by_id_fn):
    return len(_dest_doc_ids(dest_db, coll_name, page_size, order_by_id_fn))


def _find_extra_in_dest(dest_db, coll_name, page_size, order_by_id_fn, expected_ids):
    return sorted(_dest_doc_ids(dest_db, coll_name, page_size, order_by_id_fn) - expected_ids)


def verify_has_findings(reports):
    """
    True 代表這次 verify 發現了任何 missing/differs/extra_in_dest，或目的
    端有未知頂層集合——CLI 據此決定結束碼是否非 0。
    """
    unrecognized = reports.get('_unrecognized_dest_collections')
    if unrecognized:
        return True
    for coll, r in reports.items():
        if coll.startswith('_'):
            continue
        if r['missing_in_dest'] or r['differs'] or r['extra_in_dest']:
            return True
    return False


# ══════════════════════════════════════════════════════════════
# Firestore client 建構（真正連線用；測試一律傳入 fake db，不會呼叫這裡）
# ══════════════════════════════════════════════════════════════

def build_client(project_id, credentials_path=None):
    """
    建立指向明確 project_id 的 google.cloud.firestore.Client。
    credentials_path 給定時用該 service account 檔案；否則使用
    Application Default Credentials（環境需自行設定好）。
    絕不印出憑證內容，只在錯誤訊息中提及檔案路徑。
    """
    # 先驗證憑證檔案、憑證檔案有問題就在這裡直接失敗——刻意排在
    # `google.cloud.firestore` 的 import 之前，讓憑證檔案錯誤（常見的
    # 使用者操作失誤）不需要真的建立網路用戶端就能回報清楚的錯誤，
    # 也不需要在乾淨環境安裝 google-cloud-firestore 才能測到這個分支。
    creds = None
    if credentials_path:
        from google.oauth2 import service_account
        try:
            creds = service_account.Credentials.from_service_account_file(credentials_path)
        except (FileNotFoundError, ValueError) as e:
            raise MigrationError(
                f'無法載入 --source-credentials/--dest-credentials 指定的檔案'
                f'（{type(e).__name__}），請確認路徑正確且是合法的 service account JSON'
            ) from None

    from google.cloud import firestore as gcf  # 延後 import：測試不需要安裝這個套件
    if creds is not None:
        return gcf.Client(project=project_id, credentials=creds)
    return gcf.Client(project=project_id)


# ══════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════

def _order_by_id_real(query):
    from google.cloud.firestore_v1.field_path import FieldPath
    return query.order_by(FieldPath.document_id())


def _order_by_pubdate_real(query):
    from google.cloud.firestore_v1.field_path import FieldPath
    return query.order_by('pubDate').order_by(FieldPath.document_id())


def build_arg_parser():
    p = argparse.ArgumentParser(
        description='Firestore 資料庫合併工具：transcend-news-monitor → transcend-news-tbm')
    p.add_argument('--source-project', required=True,
                    help='來源專案 ID（例如 transcend-news-monitor）。沒有預設值，必須明確指定。')
    p.add_argument('--dest-project', required=True,
                    help='目的專案 ID（例如 transcend-news-tbm）。沒有預設值，必須明確指定。')
    p.add_argument('--source-credentials', default=None,
                    help='來源專案 service account JSON 路徑；不指定則用 Application Default Credentials。')
    p.add_argument('--dest-credentials', default=None,
                    help='目的專案 service account JSON 路徑；不指定則用 Application Default Credentials。')

    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true', help='只讀取來源、統計，完全不寫入。')
    mode.add_argument('--copy', action='store_true', help='實際複製到目的端；需另加 --i-approve-writing-to-dest。')
    mode.add_argument('--verify', action='store_true', help='比較來源與目的端，不寫入任何一端。')

    p.add_argument('--i-approve-writing-to-dest', action='store_true',
                    help='--copy 模式的額外確認旗標；不加這個旗標，--copy 會拒絕執行。')
    p.add_argument('--collections', default=None,
                    help='逗號分隔的集合子集合（預設全部）；只能是本工具已知的集合名稱，主要用於'
                         '分階段執行或除錯。')
    p.add_argument('--page-size', type=int, default=300, help='每頁讀取筆數（預設 300，必須 > 0）。')
    p.add_argument('--batch-size', type=int, default=400,
                    help='每個 WriteBatch 的筆數上限（預設 400，必須 > 0，硬性上限 500）。')
    p.add_argument('--checkpoint-file', default=None,
                    help='--copy 模式的進度紀錄檔路徑（只存排序游標值，不存內容）；只對'
                         'stocks/revenue/financials/dividends/material/daily/meta 有效，'
                         'news/ai_jobs/ai_insights 一律從頭冪等重跑（news 的排序游標含'
                         'datetime，無法安全序列化進 JSON checkpoint）。不指定則不使用'
                         ' checkpoint。')
    p.add_argument('--now', default=None,
                    help='覆寫「現在時間」（ISO 8601，例如 2026-08-03T00:00:00+00:00）；'
                         '不指定則用系統目前時間（UTC）。長時間執行的搬移建議固定這個值，'
                         '避免保留範圍邊界在執行過程中跨月飄移。')
    return p


def _parse_now(now_str):
    if now_str is None:
        return datetime.datetime.now(datetime.timezone.utc)
    dt = datetime.datetime.fromisoformat(now_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _validate_collections_arg(collections_str):
    if collections_str is None:
        return ALL_KNOWN_COLLECTIONS
    requested = tuple(c.strip() for c in collections_str.split(','))
    unknown = [c for c in requested if c not in ALL_KNOWN_COLLECTIONS]
    if unknown:
        raise MigrationError(
            f'--collections 包含本工具不認得的集合名稱：{unknown}；'
            f'已知集合僅有：{sorted(ALL_KNOWN_COLLECTIONS)}')
    return requested


def _print_dry_run_report(reports):
    print('\n=== DRY-RUN 報告（不含任何文件內容） ===')
    unrecognized = reports.get('_unrecognized_collections')
    subcols = reports.get('_subcollections_found') or []
    scan_errors = reports.get('_subcollection_scan_errors') or []
    for coll, r in sorted(reports.items()):
        if coll.startswith('_'):
            continue
        print(f'  {coll}: total_in_source={r["total_in_source"]} eligible={r["eligible"]} '
              f'excluded={r["excluded"]}')
        if r['unclassified_ids']:
            print(f'    ⚠ 未分類的 meta 文件（需要人工確認是否搬移）：{r["unclassified_ids"]}')
    if unrecognized is None:
        print('  ⚠ 無法列出來源端頂層集合（目前的憑證/替身不支援），未確認是否有未知集合。')
    elif unrecognized:
        print(f'  ⚠ 來源端發現未知頂層集合（本工具尚未支援搬移規則，不會自動搬移）：{unrecognized}')
    else:
        print('  ✅ 來源端頂層集合皆已列入已知清單，沒有發現未知集合。')
    if subcols:
        print(f'  ⚠ 發現 {len(subcols)} 個文件底下有子集合（本工具不支援搬移子集合內容）：{subcols}')
    else:
        print('  ✅ 沒有發現任何子集合（就已成功檢查的文件而言，見下方是否有未確認項目）。')
    if scan_errors:
        print(f'  ⚠ {len(scan_errors)} 個文件無法確認是否有子集合（檢查本身失敗，'
              f'不代表「確認沒有」）：{scan_errors}')
    else:
        print('  ✅ 所有文件的子集合檢查皆已成功執行，沒有無法確認的項目。')


def _print_copy_report(reports):
    print('\n=== COPY 報告（不含任何文件內容） ===')
    for coll, r in sorted(reports.items()):
        halted_note = '（⚠ 已中止，尚未處理完整個集合，下次重跑會從上次成功處繼續或從頭冪等重跑）' \
            if r.get('halted') else ''
        print(f'  {coll}: total_in_source={r["total_in_source"]} eligible={r["eligible"]} '
              f'excluded={r["excluded"]} success={r["success"]} skipped={r["skipped"]} '
              f'failed={r["failed"]}{halted_note}')
        if r['failed_ids']:
            print(f'    failed ids: {r["failed_ids"]}')
        if r.get('checkpoint_error'):
            print(f'    ⚠ checkpoint 進度檔寫入失敗（已成功寫入的文件仍計入 success）：'
                  f'{r["checkpoint_error"]}')


def _print_verify_report(reports):
    print('\n=== VERIFY 報告（不含任何文件內容） ===')
    unrecognized = reports.get('_unrecognized_dest_collections')
    for coll, r in sorted(reports.items()):
        if coll.startswith('_'):
            continue
        print(f'  {coll}: source_total={r["source_total"]} dest_total={r["dest_total"]} '
              f'matches={r["matches"]} missing_in_dest={len(r["missing_in_dest"])} '
              f'differs={len(r["differs"])} extra_in_dest={len(r["extra_in_dest"])}')
        if r['missing_in_dest']:
            print(f'    missing ids: {r["missing_in_dest"]}')
        if r['differs']:
            print(f'    differing ids: {r["differs"]}')
        if r['extra_in_dest']:
            print(f'    extra ids: {r["extra_in_dest"]}')
    if unrecognized is None:
        print('  ⚠ 無法列出目的端頂層集合（目前的憑證/替身不支援）。')
    elif unrecognized:
        print(f'  ⚠ 目的端發現未知頂層集合：{unrecognized}')
    else:
        print('  ✅ 目的端頂層集合皆在預期範圍內。')


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    args = build_arg_parser().parse_args(argv)

    if args.source_project == args.dest_project:
        raise MigrationError(
            f'--source-project 與 --dest-project 相同（都是 {args.source_project!r}），'
            f'拒絕執行——這通常代表參數打錯了目的專案。')

    if args.page_size <= 0:
        raise MigrationError(f'--page-size={args.page_size} 必須是正整數')
    if args.batch_size <= 0:
        raise MigrationError(f'--batch-size={args.batch_size} 必須是正整數')
    if args.batch_size > 500:
        raise MigrationError(f'--batch-size={args.batch_size} 超過 Firestore 單一 WriteBatch 500 次操作上限')

    if args.copy and not args.i_approve_writing_to_dest:
        raise MigrationError(
            '--copy 需要額外加上 --i-approve-writing-to-dest 才會執行寫入，'
            '這是刻意的二次確認，避免不小心觸發正式搬移。')

    collections = _validate_collections_arg(args.collections)
    now = _parse_now(args.now)

    source_db = build_client(args.source_project, args.source_credentials)
    dest_db = None
    if args.copy or args.verify:
        dest_db = build_client(args.dest_project, args.dest_credentials)

    if args.dry_run:
        reports = dry_run_report(source_db, now, args.page_size,
                                  _order_by_id_real, _order_by_pubdate_real, collections)
        _print_dry_run_report(reports)
        return 0

    if args.verify:
        reports = verify_all(source_db, dest_db, now, args.page_size,
                              _order_by_id_real, _order_by_pubdate_real, collections)
        _print_verify_report(reports)
        return 1 if verify_has_findings(reports) else 0

    # --copy：一律先做一次等同 --dry-run 的安全檢查，發現任何阻擋條件
    # 就拒絕執行——沒有任何旗標可以略過這個檢查。
    preflight = dry_run_report(source_db, now, args.page_size,
                                _order_by_id_real, _order_by_pubdate_real, collections)
    issues = _blocking_issues(preflight)
    if issues:
        raise MigrationError(
            '--copy 前置安全檢查未通過，拒絕執行（沒有旗標可以略過這個檢查，'
            '請先確認/處理後再重跑，或更新程式碼白名單）：\n  - ' + '\n  - '.join(issues))

    checkpoint = Checkpoint(args.checkpoint_file)
    reports = copy_all(source_db, dest_db, now, args.page_size, args.batch_size,
                        _order_by_id_real, _order_by_pubdate_real,
                        checkpoint=checkpoint, collections=collections,
                        source_project=args.source_project, dest_project=args.dest_project)
    _print_copy_report(reports)
    return 1 if copy_has_failures(reports) else 0


if __name__ == '__main__':
    sys.exit(main())
