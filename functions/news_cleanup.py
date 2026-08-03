"""
新聞保存期限清理（只保留「本月＋上個月」）。

依 news 文件的 pubDate 判斷是否過期，過期的新聞連同相同 article id 的
ai_jobs / ai_insights 文件一併刪除，避免孤兒資料。刻意不使用 Firestore
TTL policy（那是額外付費功能，且 TTL 刪除時機不可控、無法先 dry-run
確認範圍），改用排程 + 查詢分頁的方式自行實作，行為完全可預測、可測試。

保留範圍：以 **Asia/Taipei 日曆月份**計算「本月＋上個月」，不是最近
N 天。截止時間固定是「上個月 1 日 00:00 台灣時間」——pubDate 嚴格早於
這個時間點才刪除，剛好等於這個時間點不刪除。例如：
  2026/8/3 執行  → 保留 2026/7/1 00:00（台灣時間）之後的新聞
  2026/9/1 執行  → 保留 2026/8/1 00:00（台灣時間）之後的新聞
  2027/1/10 執行 → 保留 2026/12/1 00:00（台灣時間）之後的新聞（跨年）
用「本月第一天 00:00 台灣時間往前推一天」取得上個月的日期，再取該日期
所在月份的第一天，避免手算月份/年份進位（1 月要回推到去年 12 月）時
自行寫錯進位邏輯。

安全原則：
- 只用 Firestore 查詢（where + order_by + limit）挑出候選文件，絕不把
  整個 news 集合讀進記憶體篩選。
- pubDate 缺失、型別不是合法 datetime 時一律跳過並記錄警告，不冒險判定
  為過期——Firestore 的不等式查詢（`<`）本身就會排除欄位缺失或型別不一致
  的文件，這裡的型別檢查是額外一層防禦，避免資料庫出現非預期格式時誤刪。
- 分頁游標用「前一頁最後一筆文件的 snapshot」（start_after），不依賴
  刪除動作本身推進分頁——因此 dry_run（完全不刪除）也能正確走完整個
  過期範圍去統計數量與最舊/最新日期。
- 真正執行刪除時，每頁最多 ARTICLES_PER_BATCH 篇文章會被放進同一個
  Firestore WriteBatch，一次原子提交該頁所有文章的 news + ai_jobs +
  ai_insights 三個集合的刪除（寧可整批失敗即可重試，也不要 news 刪了、
  關聯文件卻因為分開提交而部分失敗變成孤兒）。單一 WriteBatch 最多
  500 次操作，三個集合合計 = ARTICLES_PER_BATCH * 3，所以
  ARTICLES_PER_BATCH 上限是 166；這裡取 150 留安全餘裕。
- 每次執行最多刪除 MAX_DELETIONS_PER_RUN 篇，避免第一次補跑（可能累積
  一次性大量過期新聞）超時，或瞬間對 Firestore 打出過量寫入操作；跑不完
  的部分留到下一次排程繼續清（下次執行會重新查詢，已刪除的文件不會再
  出現，天然冪等，不需要額外的跨次執行游標）。
"""

import datetime
import logging
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

# 保留範圍以這個時區的日曆月份計算，跟 functions/main.py 其他排程一致。
TAIPEI_TZ = ZoneInfo('Asia/Taipei')

# 與 news 文件一併清理的關聯集合（依相同 article id 尋找對應文件）。
# 不得動到 stocks / revenue / financials / dividends / material / daily /
# meta 等其他集合。
RELATED_COLLECTIONS = ('ai_jobs', 'ai_insights')

# 單一 WriteBatch 最多 500 次操作；三個集合合計 = ARTICLES_PER_BATCH * 3，
# 上限為 166（500 // 3），這裡取 150 留安全餘裕。
ARTICLES_PER_BATCH = 150

# 單次排程執行最多刪除筆數，其餘留到下次排程繼續清理。
MAX_DELETIONS_PER_RUN = 2000


def _retention_cutoff(now):
    """
    純函式：保留「本月＋上個月」（Asia/Taipei 日曆月份）。回傳「上個月
    1 日 00:00 台灣時間」——pubDate 嚴格早於這個時間點的新聞才視為過期，
    剛好等於這個時間點不算過期（不含邊界本身）。

    now 可以是任何時區的 aware datetime（呼叫端通常傳 UTC）；轉換成
    台灣時間才能正確判斷「現在是台灣的哪個日曆月份」——例如 UTC 16:30
    在台灣已經是隔天 00:30，若直接拿 UTC 的年/月判斷會誤判成前一個月。
    """
    taipei_now = now.astimezone(TAIPEI_TZ)
    this_month_start = datetime.datetime(taipei_now.year, taipei_now.month, 1, tzinfo=TAIPEI_TZ)
    last_day_of_prev_month = this_month_start - datetime.timedelta(days=1)
    return datetime.datetime(
        last_day_of_prev_month.year, last_day_of_prev_month.month, 1, tzinfo=TAIPEI_TZ)


def _is_valid_pub_date(value):
    return isinstance(value, datetime.datetime)


def _validate_params(page_size, max_deletions):
    """
    在任何 Firestore 查詢或刪除之前，先驗證參數是否合法；不合法一律
    拋出 ValueError，絕不用預設值悄悄帶過或送出無意義的查詢。
    """
    if page_size <= 0:
        raise ValueError(f'page_size 必須 > 0，收到 {page_size}')
    ops_per_batch = page_size * (1 + len(RELATED_COLLECTIONS))
    if ops_per_batch > 500:
        raise ValueError(
            f'page_size={page_size} 會讓單一 WriteBatch 操作數達到 '
            f'{ops_per_batch}（page_size × {1 + len(RELATED_COLLECTIONS)} 個集合），'
            f'超過 Firestore 單一 WriteBatch 500 次操作上限')
    if max_deletions <= 0:
        raise ValueError(f'max_deletions 必須 > 0，收到 {max_deletions}')


def _query_expired_page(db, cutoff, page_size, start_after_snap):
    """
    查一頁 pubDate 早於 cutoff 的 news 文件，依 pubDate 由舊到新排序，
    只回傳最多 page_size 筆。只用 where/order_by/limit（+ start_after
    分頁游標），不讀取整個 news 集合。
    """
    query = (db.collection('news')
               .where('pubDate', '<', cutoff)
               .order_by('pubDate')
               .limit(page_size))
    if start_after_snap is not None:
        query = query.start_after(start_after_snap)
    return list(query.stream())


def _iter_expired_pages(db, cutoff, page_size):
    """
    依序 yield 每一頁過期新聞的 document snapshot list，直到沒有更多為止。
    游標是「前一頁最後一筆的 snapshot」，不依賴刪除動作推進——
    因此 dry_run（完全不刪除）也能正確分頁走完整個過期範圍。
    """
    cursor = None
    while True:
        page = _query_expired_page(db, cutoff, page_size, cursor)
        if not page:
            return
        yield page
        cursor = page[-1]


def _valid_ids_in_page(page, on_invalid):
    """
    從一頁 snapshot 中過濾出 pubDate 為合法 datetime 的文件 id 清單。
    pubDate 缺失或型別無效時呼叫 on_invalid(snap) 記錄，並且不列入清單
    （不冒險判定為過期、不刪除）。
    回傳 [(doc_id, pub_date), ...]，維持頁面原本的（依 pubDate 由舊到新）順序。
    """
    result = []
    for snap in page:
        data = snap.to_dict() or {}
        pub = data.get('pubDate')
        if not _is_valid_pub_date(pub):
            on_invalid(snap)
            continue
        result.append((snap.id, pub))
    return result


def _log_invalid_pub_date(snap):
    logger.warning(
        'news_cleanup: 文件 news/%s 的 pubDate 缺失或格式無效，'
        '略過刪除（不冒險判定為過期）', snap.id)


def _scan_dry_run(db, cutoff, page_size):
    """
    只統計：預計刪除筆數、最舊/最新過期 pubDate、略過的異常文件數。
    完全不呼叫任何 delete。
    """
    matched = 0
    skipped_invalid = 0
    oldest = None
    newest = None

    def on_invalid(snap):
        nonlocal skipped_invalid
        skipped_invalid += 1
        _log_invalid_pub_date(snap)

    for page in _iter_expired_pages(db, cutoff, page_size):
        for _doc_id, pub in _valid_ids_in_page(page, on_invalid):
            matched += 1
            if oldest is None or pub < oldest:
                oldest = pub
            if newest is None or pub > newest:
                newest = pub

    return {
        'dry_run': True,
        'matched': matched,
        'oldest': oldest,
        'newest': newest,
        'skipped_invalid': skipped_invalid,
    }


def _delete_batch(db, article_ids):
    """
    以單一 WriteBatch 原子刪除這一批文章的 news + 關聯集合文件。
    關聯文件不論是否存在都送出 delete（Firestore 對不存在的文件
    delete 是合法且冪等的操作，仍計入該次 batch 的操作數）。
    """
    batch = db.batch()
    for article_id in article_ids:
        batch.delete(db.collection('news').document(article_id))
        for coll in RELATED_COLLECTIONS:
            batch.delete(db.collection(coll).document(article_id))
    batch.commit()


def _more_expired_exists(db, cutoff):
    """
    達到單次刪除上限（或某一頁的刪除額度用完）後，用一個 limit(1) 的
    小型查詢確認資料庫裡「現在」是否還有其他過期新聞——而不是直接假設
    一定還有。避免「剛好清完 max_deletions 篇、其實已經沒有更多過期
    資料」時被誤報為 remaining=True。這個查詢在本次已刪除的文件生效
    之後才執行，看到的是刪除後的最新狀態。
    """
    return bool(_query_expired_page(db, cutoff, page_size=1, start_after_snap=None))


def _delete_expired(db, cutoff, page_size, max_deletions):
    """
    實際刪除過期新聞（連同關聯集合），最多刪除 max_deletions 篇。
    回傳的 remaining=True 代表這次因達到 max_deletions 上限而中止，
    可能還有更多過期新聞留到下次排程處理。
    """
    deleted = 0
    skipped_invalid = 0
    remaining = False

    def on_invalid(snap):
        nonlocal skipped_invalid
        skipped_invalid += 1
        _log_invalid_pub_date(snap)

    for page in _iter_expired_pages(db, cutoff, page_size):
        valid = _valid_ids_in_page(page, on_invalid)
        if not valid:
            continue

        room = max_deletions - deleted
        if room <= 0:
            remaining = _more_expired_exists(db, cutoff)
            break

        chunk = valid[:room]

        _delete_batch(db, [article_id for article_id, _pub in chunk])
        deleted += len(chunk)

        if deleted >= max_deletions:
            remaining = _more_expired_exists(db, cutoff)
            break

    return {
        'dry_run': False,
        'deleted': deleted,
        'skipped_invalid': skipped_invalid,
        'remaining': remaining,
    }


def cleanup_expired_news(db, now=None, dry_run=True,
                          page_size=ARTICLES_PER_BATCH,
                          max_deletions=MAX_DELETIONS_PER_RUN):
    """
    刪除（或 dry_run 模式下只統計）pubDate 早於「本月＋上個月」保留範圍
    （見 _retention_cutoff）的 news 文件，並同步刪除相同 id 的 ai_jobs /
    ai_insights 文件。

    dry_run=True（預設，安全值）：只統計預計刪除筆數、最舊/最新過期
      pubDate、略過的異常文件數，不執行任何 delete。
    dry_run=False：實際刪除，每頁最多 page_size 篇文章、一個 WriteBatch
      原子刪除該頁所有文章的 news + ai_jobs + ai_insights 文件；單次
      執行最多刪除 max_deletions 篇，其餘留到下次排程繼續清理。

    回傳 dict：
      dry_run=True：{dry_run, matched, oldest, newest, skipped_invalid}
      dry_run=False：{dry_run, deleted, skipped_invalid, remaining}

    參數不合法（page_size/max_deletions 不是正數，或 page_size 會讓
    單一 WriteBatch 操作數超過 500）一律拋出 ValueError，且保證發生在
    任何 Firestore 查詢或刪除之前。
    """
    _validate_params(page_size, max_deletions)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cutoff = _retention_cutoff(now)
    if dry_run:
        return _scan_dry_run(db, cutoff, page_size)
    return _delete_expired(db, cutoff, page_size, max_deletions)
