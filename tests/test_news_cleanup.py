"""
functions/news_cleanup.py（新聞保存期限清理，只留最近 365 天）單元測試 — 完全離線

用自建的 FakeCleanupDB 模擬 Firestore 的 where/order_by/limit/start_after
分頁查詢與 WriteBatch delete，不需安裝 firebase_admin / google-cloud-firestore，
也絕不會連線任何外部服務。
"""

import datetime
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

for _mod in ('requests', 'feedparser', 'firebase_admin',
             'firebase_admin.credentials', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import news_cleanup  # noqa: E402

TZ_UTC = datetime.timezone.utc
NOW = datetime.datetime(2027, 1, 1, 0, 0, tzinfo=TZ_UTC)


def _days_ago(n, now=NOW):
    return now - datetime.timedelta(days=n)


def _mk_article(article_id, pub_date):
    return {'title': f'標題{article_id}', 'pubDate': pub_date, 'cat': 'twMarket'}


# ══════════════════════════════════════════════════════════════
# 自建 Fake Firestore：只實作本模組會用到的介面
# （collection/document/get/set/delete、where(<)/order_by/limit/
#   start_after/stream、batch()/delete()/commit()）
# ══════════════════════════════════════════════════════════════

class _FakeSnap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _FakeDocRef:
    def __init__(self, db, coll, doc_id):
        self.db, self.coll, self.doc_id = db, coll, doc_id

    def delete(self):
        self.db.delete_calls += 1
        self.db.store.get(self.coll, {}).pop(self.doc_id, None)


class _FakeQuery:
    def __init__(self, db, coll, filters=None, order_field=None,
                 limit_n=None, start_after_snap=None):
        self.db, self.coll = db, coll
        self.filters = filters or []
        self.order_field = order_field
        self.limit_n = limit_n
        self.start_after_snap = start_after_snap

    def where(self, field, op, value):
        assert op == '<', f'這個測試假物件只實作 < 運算子，收到 {op!r}'
        return _FakeQuery(self.db, self.coll, self.filters + [(field, value)],
                           self.order_field, self.limit_n, self.start_after_snap)

    def order_by(self, field):
        return _FakeQuery(self.db, self.coll, self.filters, field,
                           self.limit_n, self.start_after_snap)

    def limit(self, n):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_field,
                           n, self.start_after_snap)

    def start_after(self, snap):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_field,
                           self.limit_n, snap)

    def stream(self):
        items = list(self.db.store.get(self.coll, {}).items())  # [(doc_id, data)]

        # where(field < value)：模擬 Firestore 不等式查詢會排除欄位缺失
        # 或型別不一致的文件（而不是拿去跟 value 比較拋例外）。
        for field, value in self.filters:
            kept = []
            for doc_id, data in items:
                v = data.get(field)
                if isinstance(v, datetime.datetime) and v < value:
                    kept.append((doc_id, data))
            items = kept

        if self.order_field:
            items.sort(key=lambda kv: (kv[1].get(self.order_field), kv[0]))

        if self.start_after_snap is not None:
            cursor_data = self.start_after_snap.to_dict() or {}
            cursor_key = (cursor_data.get(self.order_field), self.start_after_snap.id)
            items = [kv for kv in items
                     if (kv[1].get(self.order_field), kv[0]) > cursor_key]

        if self.limit_n is not None:
            items = items[:self.limit_n]

        return [_FakeSnap(doc_id, data) for doc_id, data in items]


class _FakeCollection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def document(self, doc_id):
        return _FakeDocRef(self.db, self.name, doc_id)

    def where(self, field, op, value):
        return _FakeQuery(self.db, self.name).where(field, op, value)


class _FakeBatch:
    def __init__(self, db):
        self.db = db
        self.ops = []

    def delete(self, ref):
        self.ops.append(ref)

    def commit(self):
        assert len(self.ops) <= 500, (
            f'單一 WriteBatch 操作數 {len(self.ops)} 超過 Firestore 500 上限')
        self.db.batch_commits += 1
        for ref in self.ops:
            ref.delete()


class FakeCleanupDB:
    def __init__(self):
        self.store = {}          # {collection: {doc_id: data}}
        self.batch_commits = 0
        self.delete_calls = 0

    def collection(self, name):
        return _FakeCollection(self, name)

    def batch(self):
        return _FakeBatch(self)

    def seed(self, coll, doc_id, data):
        self.store.setdefault(coll, {})[doc_id] = dict(data)

    def exists(self, coll, doc_id):
        return doc_id in self.store.get(coll, {})


# ══════════════════════════════════════════════════════════════
# 保存期限邊界
# ══════════════════════════════════════════════════════════════

class TestRetentionBoundary(unittest.TestCase):
    def setUp(self):
        self.db = FakeCleanupDB()

    def test_older_than_365_days_is_deleted(self):
        self.db.seed('news', 'a1', _mk_article('a1', _days_ago(366)))
        result = news_cleanup.cleanup_expired_news(self.db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 1)
        self.assertFalse(self.db.exists('news', 'a1'))

    def test_exactly_365_days_boundary_is_kept(self):
        """剛好滿 365 天不算過期（判斷條件是「嚴格早於」cutoff，不含邊界本身）"""
        self.db.seed('news', 'a1', _mk_article('a1', _days_ago(365)))
        result = news_cleanup.cleanup_expired_news(self.db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 0)
        self.assertTrue(self.db.exists('news', 'a1'))

    def test_364_days_is_kept(self):
        self.db.seed('news', 'a1', _mk_article('a1', _days_ago(364)))
        result = news_cleanup.cleanup_expired_news(self.db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 0)
        self.assertTrue(self.db.exists('news', 'a1'))


# ══════════════════════════════════════════════════════════════
# pubDate 缺失/無效
# ══════════════════════════════════════════════════════════════

class TestMissingOrInvalidPubDate(unittest.TestCase):
    def setUp(self):
        self.db = FakeCleanupDB()

    def test_missing_pub_date_is_not_deleted(self):
        self.db.seed('news', 'a1', {'title': '沒有 pubDate 欄位'})
        result = news_cleanup.cleanup_expired_news(self.db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 0)
        self.assertTrue(self.db.exists('news', 'a1'), 'pubDate 缺失時絕不可冒險刪除')

    def test_none_pub_date_is_not_deleted(self):
        self.db.seed('news', 'a1', {'title': 'x', 'pubDate': None})
        result = news_cleanup.cleanup_expired_news(self.db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 0)
        self.assertTrue(self.db.exists('news', 'a1'))


class _RawSnap:
    """不經過 FakeCleanupDB 查詢層，直接構造的假 snapshot，
    用來單獨驗證 _valid_ids_in_page 內建的型別防禦（萬一 query 層
    沒排除某些非預期格式的資料，這裡仍必須擋下來，不誤判為過期）。"""
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return self._data


class TestValidIdsInPageDefensiveCheck(unittest.TestCase):
    def test_invalid_type_and_missing_are_skipped_and_reported(self):
        page = [
            _RawSnap('good', {'pubDate': _days_ago(400)}),
            _RawSnap('bad-str', {'pubDate': '2020-01-01'}),
            _RawSnap('bad-missing', {}),
            _RawSnap('bad-none', {'pubDate': None}),
        ]
        invalid_ids = []
        result = news_cleanup._valid_ids_in_page(
            page, lambda snap: invalid_ids.append(snap.id))
        self.assertEqual([doc_id for doc_id, _pub in result], ['good'])
        self.assertEqual(sorted(invalid_ids), ['bad-missing', 'bad-none', 'bad-str'])

    def test_logs_warning_for_invalid_pub_date(self):
        page = [_RawSnap('bad', {'pubDate': 'nope'})]
        with self.assertLogs('news_cleanup', level='WARNING') as cm:
            news_cleanup._valid_ids_in_page(page, news_cleanup._log_invalid_pub_date)
        self.assertTrue(any('bad' in line for line in cm.output))


# ══════════════════════════════════════════════════════════════
# dry-run
# ══════════════════════════════════════════════════════════════

class TestDryRun(unittest.TestCase):
    def test_dry_run_reports_stats_without_deleting(self):
        db = FakeCleanupDB()
        db.seed('news', 'a1', _mk_article('a1', _days_ago(400)))
        db.seed('news', 'a2', _mk_article('a2', _days_ago(500)))
        db.seed('news', 'a3', _mk_article('a3', _days_ago(100)))  # 未過期
        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=True)
        self.assertEqual(result, {
            'dry_run': True,
            'matched': 2,
            'oldest': _days_ago(500),
            'newest': _days_ago(400),
            'skipped_invalid': 0,
        })
        self.assertTrue(db.exists('news', 'a1'))
        self.assertTrue(db.exists('news', 'a2'))
        self.assertTrue(db.exists('news', 'a3'))
        self.assertEqual(db.batch_commits, 0, 'dry-run 絕不可執行任何 delete')
        self.assertEqual(db.delete_calls, 0)

    def test_dry_run_with_no_expired_articles(self):
        db = FakeCleanupDB()
        db.seed('news', 'a1', _mk_article('a1', _days_ago(1)))
        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=True)
        self.assertEqual(result['matched'], 0)
        self.assertIsNone(result['oldest'])
        self.assertIsNone(result['newest'])


# ══════════════════════════════════════════════════════════════
# 批次操作數上限
# ══════════════════════════════════════════════════════════════

class TestBatchSizeLimit(unittest.TestCase):
    def test_articles_per_batch_times_three_collections_within_500_ops(self):
        total_ops = news_cleanup.ARTICLES_PER_BATCH * (1 + len(news_cleanup.RELATED_COLLECTIONS))
        self.assertLessEqual(total_ops, 500)

    def test_single_batch_never_exceeds_500_ops_even_with_related_docs(self):
        db = FakeCleanupDB()
        for i in range(200):
            aid = f'a{i:03d}'
            db.seed('news', aid, _mk_article(aid, _days_ago(400 + i)))
            db.seed('ai_jobs', aid, {'x': 1})
            db.seed('ai_insights', aid, {'x': 1})
        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 200)
        # ARTICLES_PER_BATCH=150 → ceil(200/150) = 2 次 batch commit
        # （FakeBatch.commit 內部已 assert 每次 <= 500 次操作）
        self.assertEqual(db.batch_commits, 2)
        self.assertEqual(len(db.store.get('ai_jobs', {})), 0)
        self.assertEqual(len(db.store.get('ai_insights', {})), 0)


# ══════════════════════════════════════════════════════════════
# 單次執行刪除筆數上限
# ══════════════════════════════════════════════════════════════

class TestMaxDeletionsPerRun(unittest.TestCase):
    def test_run_caps_at_max_deletions_and_reports_remaining(self):
        db = FakeCleanupDB()
        total = news_cleanup.MAX_DELETIONS_PER_RUN + 100
        for i in range(total):
            aid = f'a{i:05d}'
            db.seed('news', aid, _mk_article(aid, _days_ago(400 + i)))
        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], news_cleanup.MAX_DELETIONS_PER_RUN)
        self.assertTrue(result['remaining'], '還有過期新聞未清完，應標記待下次排程繼續處理')
        self.assertEqual(len(db.store['news']), 100)

    def test_no_remaining_flag_when_fully_cleared_within_cap(self):
        db = FakeCleanupDB()
        for i in range(50):
            aid = f'a{i:03d}'
            db.seed('news', aid, _mk_article(aid, _days_ago(400 + i)))
        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(result['deleted'], 50)
        self.assertFalse(result['remaining'])


# ══════════════════════════════════════════════════════════════
# 關聯集合（ai_jobs / ai_insights）清理
# ══════════════════════════════════════════════════════════════

class TestRelatedCollectionsCleanup(unittest.TestCase):
    def test_deletes_matching_ai_jobs_and_ai_insights_without_touching_others(self):
        db = FakeCleanupDB()
        db.seed('news', 'a1', _mk_article('a1', _days_ago(400)))
        db.seed('ai_jobs', 'a1', {'status': 'pending'})
        db.seed('ai_insights', 'a1', {'summary': 'x'})
        db.seed('ai_jobs', 'other-article', {'status': 'pending'})  # 不相關的 id

        result = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)

        self.assertEqual(result['deleted'], 1)
        self.assertFalse(db.exists('news', 'a1'))
        self.assertFalse(db.exists('ai_jobs', 'a1'))
        self.assertFalse(db.exists('ai_insights', 'a1'))
        self.assertTrue(db.exists('ai_jobs', 'other-article'), '不相關 id 的 ai_jobs 不應被誤刪')


class TestOtherCollectionsUnaffected(unittest.TestCase):
    def test_stocks_and_other_collections_are_never_touched(self):
        db = FakeCleanupDB()
        db.seed('news', 'a1', _mk_article('a1', _days_ago(400)))
        other_collections = ('stocks', 'revenue', 'financials',
                              'dividends', 'material', 'daily', 'meta')
        for coll in other_collections:
            db.seed(coll, 'x', {'keep': True})

        news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)

        for coll in other_collections:
            self.assertTrue(db.exists(coll, 'x'), f'{coll} 集合不應受新聞清理影響')


# ══════════════════════════════════════════════════════════════
# 重跑冪等性
# ══════════════════════════════════════════════════════════════

class TestIdempotentRerun(unittest.TestCase):
    def test_rerun_after_full_cleanup_deletes_nothing_new(self):
        db = FakeCleanupDB()
        db.seed('news', 'a1', _mk_article('a1', _days_ago(400)))
        db.seed('ai_jobs', 'a1', {'x': 1})

        first = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(first['deleted'], 1)

        second = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(second['deleted'], 0)
        self.assertFalse(second['remaining'])
        self.assertFalse(db.exists('news', 'a1'))

    def test_rerun_after_capped_run_continues_from_where_it_left_off(self):
        db = FakeCleanupDB()
        total = news_cleanup.MAX_DELETIONS_PER_RUN + 50
        for i in range(total):
            aid = f'a{i:05d}'
            db.seed('news', aid, _mk_article(aid, _days_ago(400 + i)))

        first = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(first['deleted'], news_cleanup.MAX_DELETIONS_PER_RUN)
        self.assertTrue(first['remaining'])

        second = news_cleanup.cleanup_expired_news(db, now=NOW, dry_run=False)
        self.assertEqual(second['deleted'], 50)
        self.assertFalse(second['remaining'])
        self.assertEqual(len(db.store['news']), 0)


if __name__ == '__main__':
    unittest.main()
