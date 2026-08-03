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
             目的端（甚至不需要目的端有寫入權限）。
  --copy     實際把符合範圍的文件寫入目的端（見下方「複製方式」）。
             需要額外加上 --i-approve-writing-to-dest 才會執行，避免
             不小心打了 --copy 就真的寫資料。
  --verify   比較來源與目的端：目的端缺少的文件、內容不同的文件、
             一致的文件數。不會寫入任何一端。

複製方式（冪等、可安全中斷重跑）：
  - 文件 ID 完全比照來源（不重新產生），所以同一個文件重跑會覆寫成
    跟來源一致的內容，不會產生重複資料。
  - 每個集合依文件 ID 分頁讀取（order_by 文件 ID + limit + start_after），
    不會把整個集合一次讀進記憶體。
  - 寫入用 Firestore WriteBatch，每個 batch 最多 --batch-size 筆
    （預設 400，硬性上限 500，超過會直接拒絕啟動）。
  - 可選 --checkpoint-file：記錄每個集合目前搬到哪個文件 ID 為止（只存
    ID，不存內容），中斷後重跑可以跳過已完成的頁面，不需要整個重新
    讀取——即使沒有 checkpoint，重新整個跑一次結果也是一致的（冪等）。

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
    排除；其餘未知的 meta 文件 ID 一律不搬，只列在報告裡供人工確認。
  - 任何不在上述清單內的頂層集合，--dry-run 會透過 Firestore 原生的
    「列出頂層集合」呼叫實際列出來（不是憑印象／README 猜測），並在
    報告中標記為「未知集合，本工具尚未支援搬移規則」，不會自動搬移。

安全防呆：
  - --source-project 與 --dest-project 必須明確指定，沒有任何預設值。
  - 兩者相同時立即拒絕執行（防止打錯參數把同一個專案當來源跟目的地）。
  - 所有輸出只包含集合名稱、文件 ID、數量與錯誤類型，絕不印出文件
    內容或任何憑證/Secret 內容。
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import sys
from zoneinfo import ZoneInfo

logger = logging.getLogger('migrate_firestore')

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

# 現況快照類集合：沒有保存期限概念，全量搬移。
FULL_COPY_COLLECTIONS = ('stocks', 'revenue', 'financials', 'dividends', 'material', 'daily')

# news 的關聯集合（一對一，以 article id 為鍵）；只搬跟本次搬移的 news
# 文件對應的那些，不整批搬移。見 functions/news_cleanup.py 的
# RELATED_COLLECTIONS，這裡刻意保持同一份清單意義一致。
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
    """設定或防呆檢查失敗（尚未碰任何 Firestore 呼叫）。"""


# ══════════════════════════════════════════════════════════════
# 分頁讀取（依文件 ID 排序，適用所有集合；news 另外疊加 pubDate 範圍）
# ══════════════════════════════════════════════════════════════

def _paginate_by_document_id(collection_ref, page_size, order_by_id_fn):
    """
    依文件 ID 排序分頁讀取整個集合，yield 每一頁的 snapshot list。
    order_by_id_fn(query) 由呼叫端決定「依文件 ID 排序」要怎麼呼叫
    （真正的 Firestore client 用 order_by(FieldPath.document_id())，
    測試用的 FakeFirestore 用最簡單的 order_by('__name__')）。
    """
    cursor = None
    while True:
        query = order_by_id_fn(collection_ref).limit(page_size)
        if cursor is not None:
            query = query.start_after(cursor)
        page = list(query.stream())
        if not page:
            return
        yield page
        cursor = page[-1]


def _paginate_news_in_window(db, cutoff, page_size, order_by_pubdate_fn):
    """
    依 pubDate 排序分頁讀取 pubDate >= cutoff 的 news 文件（本次搬移範圍），
    邏輯上是 functions/news_cleanup.py `pubDate < cutoff 才刪除` 的互補
    條件：這裡搬「>= cutoff」，news_cleanup 之後清「< cutoff」，兩者合
    起來剛好覆蓋全部文件、不重疊。
    """
    query_base = db.collection('news').where('pubDate', '>=', cutoff)
    cursor = None
    while True:
        query = order_by_pubdate_fn(query_base).limit(page_size)
        if cursor is not None:
            query = query.start_after(cursor)
        page = list(query.stream())
        if not page:
            return
        yield page
        cursor = page[-1]


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
    }


# ══════════════════════════════════════════════════════════════
# dry-run：只讀取、統計，完全不寫入
# ══════════════════════════════════════════════════════════════

def dry_run_report(source_db, now, page_size, order_by_id_fn, order_by_pubdate_fn,
                    collections=ALL_KNOWN_COLLECTIONS):
    """
    回傳 {collection_name: report_dict}。只呼叫 source_db 的讀取方法，
    不會呼叫任何 write/set/delete/batch。
    """
    cutoff = retention_cutoff(now)
    reports = {}

    if 'news' in collections:
        reports['news'] = _dry_run_news(source_db, cutoff, page_size, order_by_pubdate_fn)
        eligible_news_ids = reports['news'].pop('_eligible_ids')
    else:
        eligible_news_ids = set()

    for coll in FULL_COPY_COLLECTIONS:
        if coll in collections:
            reports[coll] = _dry_run_full_copy(source_db, coll, page_size, order_by_id_fn)

    for coll in NEWS_RELATED_COLLECTIONS:
        if coll in collections:
            reports[coll] = _dry_run_related(source_db, coll, page_size, order_by_id_fn,
                                              eligible_news_ids)

    if 'meta' in collections:
        reports['meta'] = _dry_run_meta(source_db, page_size, order_by_id_fn)

    # 安全網：實際列出來源端所有頂層集合，任何不在 ALL_KNOWN_COLLECTIONS
    # 的集合都要浮上來，不能被漏掉或被誤以為「反正 README 沒提到就沒事」。
    reports['_unrecognized_collections'] = _list_unrecognized_collections(source_db, collections)

    return reports


def _dry_run_full_copy(source_db, coll_name, page_size, order_by_id_fn):
    report = _new_collection_report()
    for page in _paginate_by_document_id(source_db.collection(coll_name), page_size, order_by_id_fn):
        report['total_in_source'] += len(page)
        report['eligible'] += len(page)
    return report


def _dry_run_news(source_db, cutoff, page_size, order_by_pubdate_fn):
    report = _new_collection_report()
    eligible_ids = set()
    for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
        for snap in page:
            report['eligible'] += 1
            eligible_ids.add(snap.id)
    # total_in_source：news 集合的總量不在本工具的搬移範圍內，也沒有必要
    # 為了統計而讀整個集合（可能是數千篇）；dry-run 只需要知道「這次會
    # 搬幾篇」，不需要「來源總共有幾篇」。刻意留白，避免誤導成
    # 「total_in_source 就是全部 news 文件數」。
    report['total_in_source'] = None
    report['_eligible_ids'] = eligible_ids
    return report


def _dry_run_related(source_db, coll_name, page_size, order_by_id_fn, eligible_news_ids):
    report = _new_collection_report()
    report['total_in_source'] = None  # 理由同 news：不需要讀整個集合來統計
    coll_ref = source_db.collection(coll_name)
    for doc_id in sorted(eligible_news_ids):
        snap = coll_ref.document(doc_id).get()
        if getattr(snap, 'exists', False):
            report['eligible'] += 1
        else:
            report['excluded'] += 1
    return report


def _dry_run_meta(source_db, page_size, order_by_id_fn):
    report = _new_collection_report()
    for page in _paginate_by_document_id(source_db.collection('meta'), page_size, order_by_id_fn):
        for snap in page:
            report['total_in_source'] += 1
            cls = classify_meta_doc_id(snap.id)
            if cls == 'preserve':
                report['eligible'] += 1
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


# ══════════════════════════════════════════════════════════════
# copy：實際寫入目的端
# ══════════════════════════════════════════════════════════════

class Checkpoint:
    """
    本地端進度紀錄（只存文件 ID，不存內容），用於安全中斷後重跑時跳過
    已完成的頁面。即使完全不用 checkpoint，重跑整個流程也是冪等安全的
    （只是會重新讀取/覆寫已經搬過的文件）。
    """

    def __init__(self, path=None):
        self.path = path
        self.data = {}  # {collection: last_doc_id}
        if path is not None:
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    self.data = json.load(f)
            except FileNotFoundError:
                self.data = {}

    def last_id(self, collection):
        return self.data.get(collection)

    def mark(self, collection, doc_id):
        self.data[collection] = doc_id
        if self.path is not None:
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.data, f)

    def clear(self, collection):
        self.data.pop(collection, None)
        if self.path is not None:
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.data, f)


def _commit_batch(dest_db, ops, batch_size):
    """ops: [(coll_name, doc_id, data), ...]。每 batch_size 筆提交一次。"""
    if len(ops) > 500:
        raise MigrationError(f'batch 操作數 {len(ops)} 超過 Firestore 500 上限')
    batch = dest_db.batch()
    for coll_name, doc_id, data in ops:
        batch.set(dest_db.collection(coll_name).document(doc_id), data)
    batch.commit()


def _copy_pages(dest_db, coll_name, pages, batch_size, report, checkpoint=None, resume_after_id=None):
    """
    共用的分頁寫入邏輯：pages 是「一批 (doc_id, data) tuple 的 list」的
    iterable（不是 Firestore snapshot——呼叫端先轉換好，方便 news/meta/
    related 共用同一段寫入程式碼）。resume_after_id 不為 None 時，跳過
    到（但不含）該 ID 為止的所有項目——用於 checkpoint 續跑。

    checkpoint 只在每個 batch「成功提交後」才前進到該 batch 最後一筆的
    ID——刻意不是「處理到哪就記到哪」，否則萬一某個 batch 失敗、後面的
    batch 卻成功了，checkpoint 會被後面成功的 batch 推得比失敗點還前面，
    下次重跑就會照 checkpoint 跳過那個失敗 batch，永遠遺漏那批文件而
    不自知。因此一旦某個 batch 失敗，這個集合本次執行就此停止（不繼續
    處理後面的頁面），記錄 failed 並回傳 halted=True；下次重跑會從
    上一個成功 checkpoint 繼續，重新讀取並覆寫那個失敗的 batch。
    """
    skipping = resume_after_id is not None
    pending = []

    def flush():
        if not pending:
            return False
        try:
            _commit_batch(dest_db, pending, batch_size)
            report['success'] += len(pending)
            if checkpoint is not None:
                checkpoint.mark(coll_name, pending[-1][1])
            return False
        except Exception as e:  # noqa: BLE001 - 記錄後停止這個集合本次的後續處理
            report['failed'] += len(pending)
            report['failed_ids'].extend(pid for _c, pid, _d in pending)
            logger.error(
                '批次寫入 %s 失敗（%d 筆），停止本次對這個集合的後續處理，'
                '下次重跑會從上一個成功的 checkpoint 繼續（不會跳過這批失敗的文件）：%s: %s',
                coll_name, len(pending), type(e).__name__, e)
            return True

    # 手動控制迭代（不是直接 for page in pages），確保一旦 halted，絕不
    # 再向 pages 產生器多要一頁——否則像 meta 這種一邊拉頁一邊在產生器
    # 內部累加 total_in_source 的用法，會在停止後還多算到一頁沒被實際
    # 寫入/checkpoint 的文件，造成報告數字跟實際處理進度對不上。
    pages_iter = iter(pages)
    while not report['halted']:
        try:
            page = next(pages_iter)
        except StopIteration:
            break
        for doc_id, data in page:
            if skipping:
                if doc_id == resume_after_id:
                    skipping = False
                report['skipped'] += 1
                continue
            pending.append((coll_name, doc_id, data))
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
             checkpoint=None, collections=ALL_KNOWN_COLLECTIONS):
    """
    實際複製。batch_size 必須 <= 500（呼叫端在 CLI 層已經檔過一次，這裡
    再檔一次是防止被當函式庫直接呼叫時跳過 CLI 檢查）。
    回傳 {collection_name: report_dict}（跟 dry_run_report 同樣的形狀，
    方便共用同一份輸出格式化程式碼）。
    """
    if batch_size > 500:
        raise MigrationError(f'--batch-size={batch_size} 超過 Firestore 單一 WriteBatch 500 次操作上限')
    checkpoint = checkpoint or Checkpoint()
    cutoff = retention_cutoff(now)
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
                    items.append((snap.id, snap.to_dict()))
                yield items

        _copy_pages(dest_db, 'news', news_pages(), batch_size, report,
                    checkpoint=checkpoint, resume_after_id=checkpoint.last_id('news'))
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

        def full_pages(coll_name=coll):
            for page in _paginate_by_document_id(source_db.collection(coll_name), page_size, order_by_id_fn):
                yield [(snap.id, snap.to_dict()) for snap in page]

        _copy_pages(dest_db, coll, full_pages(), batch_size, report,
                    checkpoint=checkpoint, resume_after_id=checkpoint.last_id(coll))
        # 注意：這是「這次執行實際處理到的筆數」，若這個集合這次被 halted
        # 中止，不代表來源端的真實總數（還有未處理到的部分）。
        report['total_in_source'] = report['success'] + report['skipped'] + report['failed']
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
                    chunk.append((doc_id, snap.to_dict()))
                if len(chunk) >= page_size:
                    yield chunk
                    chunk = []
            if chunk:
                yield chunk

        _copy_pages(dest_db, coll, related_pages(), batch_size, report,
                    checkpoint=checkpoint, resume_after_id=checkpoint.last_id(coll))
        reports[coll] = report

    if 'meta' in collections:
        report = _new_collection_report()

        def meta_pages():
            for page in _paginate_by_document_id(source_db.collection('meta'), page_size, order_by_id_fn):
                items = []
                for snap in page:
                    report['total_in_source'] += 1
                    cls = classify_meta_doc_id(snap.id)
                    if cls == 'preserve':
                        items.append((snap.id, snap.to_dict()))
                    elif cls == 'exclude_lock':
                        report['excluded'] += 1
                    else:
                        report['unclassified_ids'].append(snap.id)
                yield items

        _copy_pages(dest_db, 'meta', meta_pages(), batch_size, report,
                    checkpoint=checkpoint, resume_after_id=checkpoint.last_id('meta'))
        reports['meta'] = report

    return reports


# ══════════════════════════════════════════════════════════════
# verify：比較來源與目的端，不寫入任何一端
# ══════════════════════════════════════════════════════════════

def verify_all(source_db, dest_db, now, page_size, order_by_id_fn, order_by_pubdate_fn,
               collections=ALL_KNOWN_COLLECTIONS):
    """
    回傳 {collection_name: {'missing_in_dest': [...], 'differs': [...],
    'matches': N}}。清單只放文件 ID，不放內容。比對範圍跟 copy_all 完全
    一致（news 本月+上個月、關聯集合依 news id、meta 只比對白名單）。
    """
    cutoff = retention_cutoff(now)
    reports = {}
    eligible_news_ids = set()

    if 'news' in collections:
        report = _verify_report()
        for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
            for snap in page:
                eligible_news_ids.add(snap.id)
                _verify_one(dest_db, 'news', snap.id, snap.to_dict(), report)
        reports['news'] = report
    else:
        for page in _paginate_news_in_window(source_db, cutoff, page_size, order_by_pubdate_fn):
            for snap in page:
                eligible_news_ids.add(snap.id)

    for coll in FULL_COPY_COLLECTIONS:
        if coll not in collections:
            continue
        report = _verify_report()
        for page in _paginate_by_document_id(source_db.collection(coll), page_size, order_by_id_fn):
            for snap in page:
                _verify_one(dest_db, coll, snap.id, snap.to_dict(), report)
        reports[coll] = report

    for coll in NEWS_RELATED_COLLECTIONS:
        if coll not in collections:
            continue
        report = _verify_report()
        source_coll = source_db.collection(coll)
        for doc_id in sorted(eligible_news_ids):
            snap = source_coll.document(doc_id).get()
            if getattr(snap, 'exists', False):
                _verify_one(dest_db, coll, doc_id, snap.to_dict(), report)
        reports[coll] = report

    if 'meta' in collections:
        report = _verify_report()
        for page in _paginate_by_document_id(source_db.collection('meta'), page_size, order_by_id_fn):
            for snap in page:
                if classify_meta_doc_id(snap.id) == 'preserve':
                    _verify_one(dest_db, 'meta', snap.id, snap.to_dict(), report)
        reports['meta'] = report

    return reports


def _verify_report():
    return {'missing_in_dest': [], 'differs': [], 'matches': 0}


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
    # 使用者操作失誤）不需要真的建立網路用戶端就能回報清楚的錯誤。
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
    return query.order_by('pubDate')


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
                    help='逗號分隔的集合子集合（預設全部）；主要用於分階段執行或除錯。')
    p.add_argument('--page-size', type=int, default=300, help='每頁讀取筆數（預設 300）。')
    p.add_argument('--batch-size', type=int, default=400,
                    help='每個 WriteBatch 的筆數上限（預設 400，硬性上限 500）。')
    p.add_argument('--checkpoint-file', default=None,
                    help='--copy 模式的進度紀錄檔路徑（只存文件 ID）；不指定則不使用 checkpoint。')
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


def _print_report(mode_label, reports):
    print(f'\n=== {mode_label} 報告（不含任何文件內容） ===')
    unrecognized = reports.pop('_unrecognized_collections', 'N/A')
    for coll, r in sorted(reports.items()):
        if 'missing_in_dest' in r:
            print(f'  {coll}: matches={r["matches"]} '
                  f'missing_in_dest={len(r["missing_in_dest"])} differs={len(r["differs"])}')
            if r['missing_in_dest']:
                print(f'    missing ids: {r["missing_in_dest"]}')
            if r['differs']:
                print(f'    differing ids: {r["differs"]}')
        else:
            halted_note = '（⚠ 已中止，尚未處理完整個集合，下次重跑會從上次成功處繼續）' if r.get('halted') else ''
            print(f'  {coll}: total_in_source={r["total_in_source"]} eligible={r["eligible"]} '
                  f'excluded={r["excluded"]} success={r["success"]} skipped={r["skipped"]} '
                  f'failed={r["failed"]}{halted_note}')
            if r['failed_ids']:
                print(f'    failed ids: {r["failed_ids"]}')
            if r['unclassified_ids']:
                print(f'    ⚠ 未分類的 meta 文件（需要人工確認是否搬移）：{r["unclassified_ids"]}')
    if unrecognized is None:
        print('  ⚠ 無法列出來源端頂層集合（目前的憑證/替身不支援），未確認是否有未知集合。')
    elif unrecognized:
        print(f'  ⚠ 來源端發現未知頂層集合（本工具尚未支援搬移規則，不會自動搬移）：{unrecognized}')
    else:
        print('  ✅ 來源端頂層集合皆已列入已知清單，沒有發現未知集合。')


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    args = build_arg_parser().parse_args(argv)

    if args.source_project == args.dest_project:
        raise MigrationError(
            f'--source-project 與 --dest-project 相同（都是 {args.source_project!r}），'
            f'拒絕執行——這通常代表參數打錯了目的專案。')

    if args.batch_size > 500:
        raise MigrationError(f'--batch-size={args.batch_size} 超過 Firestore 單一 WriteBatch 500 次操作上限')

    if args.copy and not args.i_approve_writing_to_dest:
        raise MigrationError(
            '--copy 需要額外加上 --i-approve-writing-to-dest 才會執行寫入，'
            '這是刻意的二次確認，避免不小心觸發正式搬移。')

    collections = (tuple(c.strip() for c in args.collections.split(','))
                   if args.collections else ALL_KNOWN_COLLECTIONS)
    now = _parse_now(args.now)

    source_db = build_client(args.source_project, args.source_credentials)
    dest_db = None
    if args.copy or args.verify:
        dest_db = build_client(args.dest_project, args.dest_credentials)

    if args.dry_run:
        reports = dry_run_report(source_db, now, args.page_size,
                                  _order_by_id_real, _order_by_pubdate_real, collections)
        _print_report('DRY-RUN', reports)
    elif args.verify:
        reports = verify_all(source_db, dest_db, now, args.page_size,
                              _order_by_id_real, _order_by_pubdate_real, collections)
        _print_report('VERIFY', reports)
    else:
        checkpoint = Checkpoint(args.checkpoint_file)
        reports = copy_all(source_db, dest_db, now, args.page_size, args.batch_size,
                            _order_by_id_real, _order_by_pubdate_real,
                            checkpoint=checkpoint, collections=collections)
        _print_report('COPY', reports)

    return 0


if __name__ == '__main__':
    sys.exit(main())
