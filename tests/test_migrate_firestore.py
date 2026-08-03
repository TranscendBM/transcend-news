"""
tools/migrate_firestore.py 單元測試 — 完全離線，可在任何乾淨環境
（GitHub Actions、macOS/Linux、任何使用者帳號）執行。

用自建的 FakeFirestoreDB 模擬 google-cloud-firestore 的 collection/
document/where/order_by/order_by_document_id/limit/start_after/stream/
get/batch/commit/collections()，不需要安裝 google-cloud-firestore、
不會連線任何專案。所有需要暫存檔的測試（checkpoint 檔案、憑證檔案）
一律用 tempfile.TemporaryDirectory()，不寫死任何固定路徑。
"""

import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))

import migrate_firestore as mig  # noqa: E402

TZ_UTC = datetime.timezone.utc


def _taipei(year, month, day, hour=0, minute=0, second=0):
    return datetime.datetime(year, month, day, hour, minute, second, tzinfo=mig.TAIPEI_TZ)


def _utc(year, month, day, hour=0, minute=0, second=0):
    return datetime.datetime(year, month, day, hour, minute, second, tzinfo=TZ_UTC)


# ══════════════════════════════════════════════════════════════
# 自建 Fake Firestore：只實作 migrate_firestore.py 會用到的介面
# ══════════════════════════════════════════════════════════════

class _FakeSnap:
    def __init__(self, doc_id, data, exists=True, reference=None):
        self.id = doc_id
        self._data = data
        self.exists = exists
        self.reference = reference

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _FakeDocRef:
    def __init__(self, db, coll, doc_id):
        self.db, self.coll, self.doc_id = db, coll, doc_id

    def get(self):
        data = self.db.store.get(self.coll, {}).get(self.doc_id)
        return _FakeSnap(self.doc_id, data, exists=data is not None, reference=self)

    def collections(self):
        names = self.db.subcollections.get((self.coll, self.doc_id), [])
        return [_FakeCollection(self.db, name) for name in names]


class _FakeQuery:
    """order_fields 是排序欄位名稱的 list，'__id__' 代表依文件 ID 排序
    （對應真正 Firestore client 的 FieldPath.document_id()）。支援複合
    排序（例如 news 用 ['pubDate', '__id__']），跟真正的 Firestore
    order_by().order_by() 鏈式呼叫語意一致。"""

    def __init__(self, db, coll, filters=None, order_fields=None, limit_n=None, start_after_values=None):
        self.db, self.coll = db, coll
        self.filters = filters or []
        self.order_fields = order_fields or []
        self.limit_n = limit_n
        self.start_after_values = start_after_values

    def where(self, field, op, value):
        assert op in ('>=', '=='), f'fake 只實作 >= 與 ==，收到 {op!r}'
        return _FakeQuery(self.db, self.coll, self.filters + [(field, op, value)],
                           self.order_fields, self.limit_n, self.start_after_values)

    def order_by(self, field):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_fields + [field],
                           self.limit_n, self.start_after_values)

    def order_by_document_id(self):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_fields + ['__id__'],
                           self.limit_n, self.start_after_values)

    def limit(self, n):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_fields, n,
                           self.start_after_values)

    def start_after(self, values):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_fields, self.limit_n,
                           list(values))

    def _sort_key(self, doc_id, data):
        key = []
        for f in self.order_fields:
            key.append(doc_id if f == '__id__' else data.get(f))
        return tuple(key)

    def stream(self):
        items = list(self.db.store.get(self.coll, {}).items())  # [(doc_id, data)]

        for field, op, value in self.filters:
            kept = []
            for doc_id, data in items:
                v = data.get(field)
                if op == '>=' and isinstance(v, datetime.datetime) and v >= value:
                    kept.append((doc_id, data))
                elif op == '==' and v == value:
                    kept.append((doc_id, data))
            items = kept

        items.sort(key=lambda kv: self._sort_key(kv[0], kv[1]))

        if self.start_after_values is not None:
            cursor = tuple(self.start_after_values)
            items = [kv for kv in items if self._sort_key(kv[0], kv[1]) > cursor]

        if self.limit_n is not None:
            items = items[:self.limit_n]

        return [_FakeSnap(doc_id, data, reference=_FakeDocRef(self.db, self.coll, doc_id))
                for doc_id, data in items]


class _FakeCollection:
    def __init__(self, db, name):
        self.db, self.name = db, name
        self.id = name

    def document(self, doc_id):
        return _FakeDocRef(self.db, self.name, doc_id)

    def where(self, field, op, value):
        return _FakeQuery(self.db, self.name).where(field, op, value)

    def order_by(self, field):
        return _FakeQuery(self.db, self.name).order_by(field)

    def order_by_document_id(self):
        return _FakeQuery(self.db, self.name).order_by_document_id()

    def limit(self, n):
        return _FakeQuery(self.db, self.name).limit(n)


class _FakeBatch:
    def __init__(self, db):
        self.db = db
        self.ops = []  # [(ref, data)]

    def set(self, ref, data):
        self.ops.append((ref, data))

    def commit(self):
        assert len(self.ops) <= 500, f'單一 WriteBatch 操作數 {len(self.ops)} 超過 Firestore 500 上限'
        self.db.commit_calls += 1
        if self.db.commit_calls == self.db.fail_at_commit_number:
            raise RuntimeError('simulated write failure')
        for ref, data in self.ops:
            self.db.store.setdefault(ref.coll, {})[ref.doc_id] = dict(data)
            self.db.write_calls += 1


class FakeFirestoreDB:
    def __init__(self):
        self.store = {}  # {collection: {doc_id: data}}
        self.subcollections = {}  # {(collection, doc_id): [sub_collection_name, ...]}
        self.commit_calls = 0
        self.write_calls = 0
        self.fail_at_commit_number = None  # 1-indexed；剛好是第幾次 commit() 呼叫時模擬失敗

    def collection(self, name):
        return _FakeCollection(self, name)

    def batch(self):
        return _FakeBatch(self)

    def collections(self):
        return [_FakeCollection(self, name) for name in self.store.keys()]

    def seed(self, coll, doc_id, data):
        self.store.setdefault(coll, {})[doc_id] = dict(data)

    def seed_subcollection(self, coll, doc_id, sub_collection_name):
        self.subcollections.setdefault((coll, doc_id), []).append(sub_collection_name)

    def exists(self, coll, doc_id):
        return doc_id in self.store.get(coll, {})

    def get(self, coll, doc_id):
        return self.store.get(coll, {}).get(doc_id)


def order_by_id(query_or_coll):
    return query_or_coll.order_by_document_id()


def order_by_pubdate(query):
    return query.order_by('pubDate').order_by_document_id()


def _news(title, pub_date, cat='usMarket'):
    return {'title': title, 'pubDate': pub_date, 'cat': cat}


# ══════════════════════════════════════════════════════════════
# retention_cutoff：跟 functions/news_cleanup.py 的保留政策必須一致
# ══════════════════════════════════════════════════════════════

class TestRetentionCutoff(unittest.TestCase):
    def test_august_execution_cutoff_is_july_first(self):
        self.assertEqual(mig.retention_cutoff(_taipei(2026, 8, 3, 10, 0)), _taipei(2026, 7, 1))

    def test_january_execution_crosses_year_boundary_to_december(self):
        self.assertEqual(mig.retention_cutoff(_taipei(2027, 1, 10, 2, 30)), _taipei(2026, 12, 1))

    def test_utc_now_just_past_taipei_midnight_is_already_next_month(self):
        now_utc = _utc(2026, 7, 31, 16, 30)
        self.assertEqual(mig.retention_cutoff(now_utc), _taipei(2026, 7, 1))

    def test_matches_news_cleanup_retention_cutoff_for_a_range_of_dates(self):
        """跟正式清理邏輯（functions/news_cleanup.py）的 cutoff 逐一比對，
        確保搬移工具跟正式保留政策不會各自演化到不一致。"""
        for _mod in ('requests', 'feedparser'):
            if _mod not in sys.modules:
                import unittest.mock as _mock
                sys.modules[_mod] = _mock.MagicMock(name=_mod)
        functions_dir = str(Path(__file__).resolve().parent.parent / 'functions')
        if functions_dir not in sys.path:
            sys.path.insert(0, functions_dir)
        import news_cleanup

        cases = [
            _taipei(2026, 8, 3, 10, 0),
            _taipei(2026, 9, 1, 2, 30),
            _taipei(2027, 1, 10, 2, 30),
            _utc(2026, 7, 31, 16, 30),
            _utc(2026, 7, 31, 10, 0),
        ]
        for now in cases:
            with self.subTest(now=now):
                self.assertEqual(mig.retention_cutoff(now), news_cleanup._retention_cutoff(now))


# ══════════════════════════════════════════════════════════════
# meta 文件分類
# ══════════════════════════════════════════════════════════════

class TestMetaClassification(unittest.TestCase):
    def test_lock_prefixed_docs_are_excluded(self):
        for name in ('lock_news', 'lock_stocks', 'lock_trading', 'lock_finance',
                     'lock_digest_tw', 'lock_digest_us', 'lock_news_cleanup'):
            self.assertEqual(mig.classify_meta_doc_id(name), 'exclude_lock')

    def test_news_index_shards_and_digest_checkpoints_and_marker_are_preserved(self):
        for name in list(mig.META_NEWS_INDEX_SHARD_IDS) + ['digest_tw', 'digest_us',
                                                            'migration_news_date_fix_20260722']:
            self.assertEqual(mig.classify_meta_doc_id(name), 'preserve')

    def test_unknown_meta_doc_is_unclassified_not_auto_migrated(self):
        self.assertEqual(mig.classify_meta_doc_id('some_future_feature_flag'), 'unclassified')

    def test_there_are_exactly_16_news_index_shards(self):
        self.assertEqual(len(mig.META_NEWS_INDEX_SHARD_IDS), 16)


# ══════════════════════════════════════════════════════════════
# dry-run：零寫入
# ══════════════════════════════════════════════════════════════

class TestDryRunZeroWrites(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()

    def test_dry_run_never_calls_batch_or_writes_anything(self):
        now = _taipei(2026, 8, 3, 10, 0)
        self.source.seed('stocks', 'latest', {'price': 1})
        self.source.seed('news', 'n1', _news('本月新聞', _taipei(2026, 7, 15)))
        self.source.seed('meta', 'lock_news', {'owner': 'x'})
        self.source.seed('meta', 'digest_tw', {'lastSentAt': now})

        mig.dry_run_report(self.source, now, page_size=10,
                            order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate)

        self.assertEqual(self.source.commit_calls, 0)
        self.assertEqual(self.source.write_calls, 0)
        self.assertEqual(self.source.store['stocks']['latest'], {'price': 1})

    def test_dry_run_reports_eligible_counts_correctly(self):
        now = _taipei(2026, 8, 3, 10, 0)
        self.source.seed('stocks', 'latest', {'price': 1})
        self.source.seed('revenue', '2451', {'records': []})
        report = mig.dry_run_report(self.source, now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                     collections=('stocks', 'revenue'))
        self.assertEqual(report['stocks']['total_in_source'], 1)
        self.assertEqual(report['stocks']['eligible'], 1)
        self.assertEqual(report['revenue']['total_in_source'], 1)


# ══════════════════════════════════════════════════════════════
# 分頁與批次上限
# ══════════════════════════════════════════════════════════════

class TestPaginationAndBatchLimits(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_pagination_visits_every_document_across_multiple_pages(self):
        for i in range(25):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        mig.copy_all(self.source, self.dest, self.now, page_size=7, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        self.assertEqual(len(self.dest.store.get('stocks', {})), 25)
        for i in range(25):
            self.assertEqual(self.dest.store['stocks'][f'doc{i:03d}'], {'v': i})

    def test_batch_size_over_500_is_rejected_before_any_write(self):
        self.source.seed('stocks', 'a', {'v': 1})
        with self.assertRaises(mig.MigrationError):
            mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=501,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         collections=('stocks',))
        self.assertEqual(self.dest.write_calls, 0)

    def test_batch_size_zero_or_negative_is_rejected(self):
        self.source.seed('stocks', 'a', {'v': 1})
        for bad in (0, -1):
            with self.assertRaises(mig.MigrationError):
                mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=bad,
                             order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                             collections=('stocks',))

    def test_page_size_zero_or_negative_is_rejected(self):
        self.source.seed('stocks', 'a', {'v': 1})
        for bad in (0, -5):
            with self.assertRaises(mig.MigrationError):
                mig.copy_all(self.source, self.dest, self.now, page_size=bad, batch_size=10,
                             order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                             collections=('stocks',))

    def test_batches_never_exceed_configured_batch_size(self):
        for i in range(23):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        mig.copy_all(self.source, self.dest, self.now, page_size=100, batch_size=10,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        # 23 筆、每批 10 筆 → 3 次 commit（10+10+3）
        self.assertEqual(self.dest.commit_calls, 3)
        self.assertEqual(len(self.dest.store['stocks']), 23)


# ══════════════════════════════════════════════════════════════
# 重跑冪等
# ══════════════════════════════════════════════════════════════

class TestIdempotentRerun(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_running_copy_twice_does_not_duplicate_documents(self):
        for i in range(10):
            self.source.seed('stocks', f'doc{i}', {'v': i})
        mig.copy_all(self.source, self.dest, self.now, page_size=4, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        first_count = len(self.dest.store['stocks'])

        mig.copy_all(self.source, self.dest, self.now, page_size=4, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        second_count = len(self.dest.store['stocks'])

        self.assertEqual(first_count, 10)
        self.assertEqual(second_count, 10)

    def test_rerun_overwrites_with_latest_source_content_not_stale_dest_content(self):
        self.source.seed('stocks', 'latest', {'price': 100})
        mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        self.source.seed('stocks', 'latest', {'price': 200})
        mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        self.assertEqual(self.dest.store['stocks']['latest'], {'price': 200})


# ══════════════════════════════════════════════════════════════
# 來源/目的專案防呆與 CLI 參數防呆
# ══════════════════════════════════════════════════════════════

class TestSourceDestGuardrails(unittest.TestCase):
    def test_identical_source_and_dest_project_is_rejected(self):
        with self.assertRaises(mig.MigrationError):
            mig.main(['--source-project', 'transcend-news-tbm',
                      '--dest-project', 'transcend-news-tbm',
                      '--dry-run'])

    def test_copy_without_approval_flag_is_rejected(self):
        with self.assertRaises(mig.MigrationError):
            mig.main(['--source-project', 'transcend-news-monitor',
                      '--dest-project', 'transcend-news-tbm',
                      '--copy'])

    def test_required_project_args_are_enforced_by_argparse(self):
        with self.assertRaises(SystemExit):
            mig.build_arg_parser().parse_args(['--dry-run'])

    def test_page_size_must_be_positive(self):
        with self.assertRaises(mig.MigrationError):
            mig.main(['--source-project', 'transcend-news-monitor',
                      '--dest-project', 'transcend-news-tbm',
                      '--page-size', '0', '--dry-run'])

    def test_batch_size_must_be_positive(self):
        with self.assertRaises(mig.MigrationError):
            mig.main(['--source-project', 'transcend-news-monitor',
                      '--dest-project', 'transcend-news-tbm',
                      '--batch-size', '0', '--dry-run'])

    def test_batch_size_over_500_is_rejected_at_cli_level(self):
        with self.assertRaises(mig.MigrationError):
            mig.main(['--source-project', 'transcend-news-monitor',
                      '--dest-project', 'transcend-news-tbm',
                      '--batch-size', '501', '--dry-run'])

    def test_unknown_collection_name_is_rejected(self):
        with self.assertRaises(mig.MigrationError):
            mig._validate_collections_arg('stocks,not_a_real_collection')

    def test_known_collections_are_accepted(self):
        result = mig._validate_collections_arg('stocks,news')
        self.assertEqual(result, ('stocks', 'news'))

    def test_there_is_no_generic_force_flag(self):
        """規格明確要求不得新增可以忽略安全檢查的通用 --force。"""
        help_text = mig.build_arg_parser().format_help()
        self.assertNotIn('--force', help_text)


# ══════════════════════════════════════════════════════════════
# lock 文件排除
# ══════════════════════════════════════════════════════════════

class TestLockDocsExcluded(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_lock_docs_are_never_copied(self):
        self.source.seed('meta', 'lock_news', {'owner': 'abc', 'expiresAt': self.now})
        self.source.seed('meta', 'lock_news_cleanup', {'owner': 'xyz'})
        self.source.seed('meta', 'digest_tw', {'lastSentAt': self.now})

        report = mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('meta',))

        self.assertFalse(self.dest.exists('meta', 'lock_news'))
        self.assertFalse(self.dest.exists('meta', 'lock_news_cleanup'))
        self.assertTrue(self.dest.exists('meta', 'digest_tw'))
        self.assertEqual(report['meta']['excluded'], 2)
        self.assertEqual(report['meta']['success'], 1)


# ══════════════════════════════════════════════════════════════
# meta allowlist（未知文件不自動搬移，只列出來，且會擋下 --copy）
# ══════════════════════════════════════════════════════════════

class TestMetaAllowlist(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_unclassified_meta_doc_is_listed_but_not_copied(self):
        self.source.seed('meta', 'digest_tw', {'lastSentAt': self.now})
        self.source.seed('meta', 'some_new_feature_flag', {'enabled': True})

        report = mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('meta',))

        self.assertFalse(self.dest.exists('meta', 'some_new_feature_flag'))
        self.assertIn('some_new_feature_flag', report['meta']['unclassified_ids'])
        self.assertTrue(self.dest.exists('meta', 'digest_tw'))

    def test_all_16_news_index_shards_and_marker_are_preserved(self):
        for shard in mig.META_NEWS_INDEX_SHARD_IDS:
            self.source.seed('meta', shard, {'hashes': {}})
        self.source.seed('meta', 'migration_news_date_fix_20260722', {'completed': True})

        mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('meta',))

        for shard in mig.META_NEWS_INDEX_SHARD_IDS:
            self.assertTrue(self.dest.exists('meta', shard))
        self.assertTrue(self.dest.exists('meta', 'migration_news_date_fix_20260722'))

    def test_unclassified_meta_doc_blocks_the_cli_copy_preflight_check(self):
        self.source.seed('meta', 'some_new_feature_flag', {'enabled': True})
        preflight = mig.dry_run_report(self.source, self.now, page_size=10,
                                        order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                        collections=('meta',))
        issues = mig._blocking_issues(preflight)
        self.assertTrue(any('unclassified' in i.lower() or '未分類' in i for i in issues))


# ══════════════════════════════════════════════════════════════
# 新聞保留邊界與跨年
# ══════════════════════════════════════════════════════════════

class TestNewsRetentionWindow(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()

    def test_only_this_month_and_last_month_news_are_migrated(self):
        now = _taipei(2026, 8, 3, 10, 0)
        self.source.seed('news', 'in_window', _news('本月內', _taipei(2026, 7, 15)))
        self.source.seed('news', 'exactly_at_cutoff', _news('剛好在邊界', _taipei(2026, 7, 1, 0, 0, 0)))
        self.source.seed('news', 'out_of_window', _news('已過期', _taipei(2026, 6, 30, 23, 59, 59)))

        mig.copy_all(self.source, self.dest, now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news',))

        self.assertTrue(self.dest.exists('news', 'in_window'))
        self.assertTrue(self.dest.exists('news', 'exactly_at_cutoff'),
                         '剛好等於截止時間（7/1 00:00 台灣時間）應視為本次範圍內')
        self.assertFalse(self.dest.exists('news', 'out_of_window'))

    def test_retention_window_correctly_crosses_the_year_boundary(self):
        now = _taipei(2027, 1, 10, 10, 0)
        self.source.seed('news', 'december', _news('去年12月', _taipei(2026, 12, 15)))
        self.source.seed('news', 'november', _news('去年11月已過期', _taipei(2026, 11, 20)))

        mig.copy_all(self.source, self.dest, now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news',))

        self.assertTrue(self.dest.exists('news', 'december'))
        self.assertFalse(self.dest.exists('news', 'november'))

    def test_ai_jobs_and_ai_insights_follow_the_same_news_retention_window(self):
        now = _taipei(2026, 8, 3, 10, 0)
        self.source.seed('news', 'recent', _news('本月', _taipei(2026, 7, 15), cat='transcend'))
        self.source.seed('news', 'expired', _news('已過期', _taipei(2026, 6, 1), cat='transcend'))
        self.source.seed('ai_jobs', 'recent', {'status': 'done'})
        self.source.seed('ai_jobs', 'expired', {'status': 'done'})
        self.source.seed('ai_insights', 'recent', {'summary': 'x'})
        self.source.seed('ai_insights', 'expired', {'summary': 'y'})

        mig.copy_all(self.source, self.dest, now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news', 'ai_jobs', 'ai_insights'))

        self.assertTrue(self.dest.exists('ai_jobs', 'recent'))
        self.assertFalse(self.dest.exists('ai_jobs', 'expired'))
        self.assertTrue(self.dest.exists('ai_insights', 'recent'))
        self.assertFalse(self.dest.exists('ai_insights', 'expired'))

    def test_ai_jobs_without_a_corresponding_news_doc_are_not_migrated(self):
        """ai_jobs/ai_insights 是以 news 的 article id 為鍵的一對一關聯；
        即使文件本身存在，若沒有對應的 news 文件（或該 news 不在保留
        範圍內），也不應該被搬移——驗證的是『引用關係』，不是單純複製
        整個集合。"""
        now = _taipei(2026, 8, 3, 10, 0)
        self.source.seed('ai_jobs', 'orphan', {'status': 'done'})

        mig.copy_all(self.source, self.dest, now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news', 'ai_jobs'))

        self.assertFalse(self.dest.exists('ai_jobs', 'orphan'))

    def test_news_with_identical_pubdate_uses_document_id_as_stable_tiebreaker(self):
        """兩篇文章 pubDate 完全相同時，若沒有次要排序鍵，分頁順序不保證
        穩定，可能導致漏筆或重複頁。文件 ID 當 tie-breaker 後，兩篇都
        應該正確搬移，即使 page_size=1（強制跨頁）。"""
        now = _taipei(2026, 8, 3, 10, 0)
        same_time = _taipei(2026, 7, 15, 12, 0, 0)
        self.source.seed('news', 'aaa', _news('文章A', same_time))
        self.source.seed('news', 'bbb', _news('文章B', same_time))
        self.source.seed('news', 'ccc', _news('文章C', same_time))

        mig.copy_all(self.source, self.dest, now, page_size=1, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news',))

        self.assertTrue(self.dest.exists('news', 'aaa'))
        self.assertTrue(self.dest.exists('news', 'bbb'))
        self.assertTrue(self.dest.exists('news', 'ccc'))
        self.assertEqual(len(self.dest.store['news']), 3)


# ══════════════════════════════════════════════════════════════
# 子集合安全網
# ══════════════════════════════════════════════════════════════

class TestSubcollectionSafetyNet(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_dry_run_flags_a_document_with_a_subcollection(self):
        self.source.seed('stocks', 'latest', {'price': 1})
        self.source.seed_subcollection('stocks', 'latest', 'history')

        report = mig.dry_run_report(self.source, self.now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                     collections=('stocks',))

        findings = report['_subcollections_found']
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]['collection'], 'stocks')
        self.assertEqual(findings[0]['doc_id'], 'latest')
        self.assertIn('history', findings[0]['subcollections'])

    def test_no_subcollections_found_when_there_are_none(self):
        self.source.seed('stocks', 'latest', {'price': 1})
        report = mig.dry_run_report(self.source, self.now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                     collections=('stocks',))
        self.assertEqual(report['_subcollections_found'], [])

    def test_subcollection_finding_blocks_the_copy_preflight_check(self):
        self.source.seed('stocks', 'latest', {'price': 1})
        self.source.seed_subcollection('stocks', 'latest', 'history')
        preflight = mig.dry_run_report(self.source, self.now, page_size=10,
                                        order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                        collections=('stocks',))
        issues = mig._blocking_issues(preflight)
        self.assertTrue(any('子集合' in i for i in issues))


# ══════════════════════════════════════════════════════════════
# 未知頂層集合安全網（也會擋下 --copy）
# ══════════════════════════════════════════════════════════════

class TestUnrecognizedCollections(unittest.TestCase):
    def test_flags_a_collection_not_in_the_known_list(self):
        source = FakeFirestoreDB()
        source.seed('stocks', 'a', {'v': 1})
        source.seed('some_future_collection', 'x', {'y': 1})
        now = _taipei(2026, 8, 3, 10, 0)

        report = mig.dry_run_report(source, now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate)

        self.assertIn('some_future_collection', report['_unrecognized_collections'])

    def test_no_unrecognized_collections_when_source_only_has_known_ones(self):
        source = FakeFirestoreDB()
        source.seed('stocks', 'a', {'v': 1})
        now = _taipei(2026, 8, 3, 10, 0)

        report = mig.dry_run_report(source, now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate)

        self.assertEqual(report['_unrecognized_collections'], [])

    def test_unrecognized_collection_blocks_the_copy_preflight_check(self):
        source = FakeFirestoreDB()
        source.seed('some_future_collection', 'x', {'y': 1})
        now = _taipei(2026, 8, 3, 10, 0)
        preflight = mig.dry_run_report(source, now, page_size=10,
                                        order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate)
        issues = mig._blocking_issues(preflight)
        self.assertTrue(any('some_future_collection' in i for i in issues))


# ══════════════════════════════════════════════════════════════
# copy 報告一致性（eligible/success/skipped/failed/excluded 可核對）
# ══════════════════════════════════════════════════════════════

class TestCopyReportConsistency(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_full_copy_collection_eligible_matches_success_plus_skipped_plus_failed(self):
        for i in range(12):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        report = mig.copy_all(self.source, self.dest, self.now, page_size=5, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('stocks',))
        r = report['stocks']
        self.assertEqual(r['eligible'], 12)
        self.assertEqual(r['success'], 12)
        self.assertEqual(r['eligible'], r['success'] + r['skipped'] + r['failed'])

    def test_news_eligible_matches_success_plus_skipped_plus_failed(self):
        for i in range(5):
            self.source.seed('news', f'n{i}', _news(f'文章{i}', _taipei(2026, 7, 10 + i)))
        report = mig.copy_all(self.source, self.dest, self.now, page_size=2, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('news',))
        r = report['news']
        self.assertEqual(r['eligible'], 5)
        self.assertEqual(r['success'], 5)
        self.assertEqual(r['eligible'], r['success'] + r['skipped'] + r['failed'])

    def test_ai_jobs_eligible_and_excluded_are_consistent_with_the_news_id_set(self):
        self.source.seed('news', 'a', _news('文章A', _taipei(2026, 7, 10)))
        self.source.seed('news', 'b', _news('文章B', _taipei(2026, 7, 11)))
        self.source.seed('ai_jobs', 'a', {'status': 'done'})
        # 'b' 沒有對應的 ai_jobs 文件——應該計入 excluded，不是 eligible。
        report = mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('news', 'ai_jobs'))
        r = report['ai_jobs']
        self.assertEqual(r['eligible'], 1)
        self.assertEqual(r['excluded'], 1)
        self.assertEqual(r['success'], 1)

    def test_eligible_is_never_left_at_zero_when_documents_were_actually_copied(self):
        self.source.seed('meta', 'digest_tw', {'lastSentAt': self.now})
        report = mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('meta',))
        self.assertEqual(report['meta']['eligible'], 1)
        self.assertEqual(report['meta']['success'], 1)


# ══════════════════════════════════════════════════════════════
# checkpoint：fail-closed fingerprint、atomic write、value-based cursor
# ══════════════════════════════════════════════════════════════

class TestCheckpointFailClosed(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_checkpointed_document_deleted_from_source_still_resumes_correctly(self):
        """checkpoint 存的是排序游標『值』，不是文件 ID 存在與否的比對——
        即使 checkpoint 指向的那個文件之後從來源端被刪除，剩餘文件仍然
        必須正確被搬移，不能因為『找不到那個 ID』就整批遺漏。"""
        for i in range(10):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            checkpoint = mig.Checkpoint(cp_path)
            report1 = mig.copy_all(self.source, self.dest, self.now, page_size=5, batch_size=5,
                                    order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                    checkpoint=checkpoint, collections=('stocks',),
                                    source_project='p-src', dest_project='p-dst')
            self.assertEqual(report1['stocks']['success'], 10)
            # checkpoint 目前指向 doc009（最後一批的最後一筆）。把它從
            # 來源刪掉，模擬「checkpoint 文件已刪除」。
            del self.source.store['stocks']['doc009']
            # 新增幾筆給下一輪搬（模擬持續有新資料進來）。
            for i in range(10, 13):
                self.source.seed('stocks', f'doc{i:03d}', {'v': i})

            checkpoint2 = mig.Checkpoint(cp_path)
            report2 = mig.copy_all(self.source, self.dest, self.now, page_size=5, batch_size=5,
                                    order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                    checkpoint=checkpoint2, collections=('stocks',),
                                    source_project='p-src', dest_project='p-dst')
            # 游標值本身（doc009 這個 ID 字串）仍然可以正確定位「在它之後」
            # 的位置，即使該文件已經不存在，doc010/011/012 仍然要被搬到。
            self.assertEqual(report2['stocks']['success'], 3)
            self.assertTrue(self.dest.exists('stocks', 'doc010'))
            self.assertTrue(self.dest.exists('stocks', 'doc011'))
            self.assertTrue(self.dest.exists('stocks', 'doc012'))

    def test_cutoff_change_invalidates_the_checkpoint_and_restarts_from_scratch(self):
        """cutoff 隨『現在時間』跨月而改變時，checkpoint 的 fingerprint
        會對不上，必須整個丟棄、從頭開始，不能沿用舊 cutoff 下的游標
        （那個游標的排序位置，換了 cutoff 之後意義已經不同）。"""
        self.source.seed('news', 'july', _news('七月', _taipei(2026, 7, 15)))
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            now_august = _taipei(2026, 8, 3, 10, 0)
            checkpoint = mig.Checkpoint(cp_path)
            mig.copy_all(self.source, self.dest, now_august, page_size=10, batch_size=400,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         checkpoint=checkpoint, collections=('news',),
                         source_project='p-src', dest_project='p-dst')

            self.source.seed('news', 'september', _news('九月', _taipei(2026, 9, 10)))
            now_september = _taipei(2026, 9, 15, 10, 0)  # cutoff 從 7/1 變成 8/1
            checkpoint2 = mig.Checkpoint(cp_path)
            with self.assertLogs('migrate_firestore', level='WARNING') as logs:
                report = mig.copy_all(self.source, self.dest, now_september, page_size=10, batch_size=400,
                                       order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                       checkpoint=checkpoint2, collections=('news',),
                                       source_project='p-src', dest_project='p-dst')
            self.assertTrue(any('不符' in m or 'fingerprint' in m.lower() for m in logs.output))
            # 'july' 這篇已經離開新的保留範圍（cutoff 變成 8/1），不會再被
            # 搬移；'september' 是這次唯一符合範圍的文章。
            self.assertEqual(report['news']['success'], 1)
            self.assertTrue(self.dest.exists('news', 'september'))

    def test_source_or_dest_project_change_invalidates_the_checkpoint(self):
        self.source.seed('stocks', 'a', {'v': 1})
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            checkpoint = mig.Checkpoint(cp_path)
            mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         checkpoint=checkpoint, collections=('stocks',),
                         source_project='project-a', dest_project='project-b')

            checkpoint2 = mig.Checkpoint(cp_path)
            with self.assertLogs('migrate_firestore', level='WARNING'):
                mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                             order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                             checkpoint=checkpoint2, collections=('stocks',),
                             source_project='project-a', dest_project='project-DIFFERENT')

    def test_corrupt_checkpoint_json_is_treated_as_absent_and_does_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            with open(cp_path, 'w', encoding='utf-8') as f:
                f.write('{not valid json::::')

            self.source.seed('stocks', 'a', {'v': 1})
            checkpoint = mig.Checkpoint(cp_path)
            with self.assertLogs('migrate_firestore', level='WARNING'):
                report = mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                                       order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                       checkpoint=checkpoint, collections=('stocks',),
                                       source_project='p-src', dest_project='p-dst')
            self.assertEqual(report['stocks']['success'], 1)
            self.assertTrue(self.dest.exists('stocks', 'a'))

    def test_checkpoint_file_uses_atomic_write_no_leftover_tmp_file(self):
        self.source.seed('stocks', 'a', {'v': 1})
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            checkpoint = mig.Checkpoint(cp_path)
            mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         checkpoint=checkpoint, collections=('stocks',),
                         source_project='p-src', dest_project='p-dst')

            entries = os.listdir(tmp_dir)
            self.assertIn('checkpoint.json', entries)
            leftover_tmp_files = [e for e in entries if e != 'checkpoint.json']
            self.assertEqual(leftover_tmp_files, [], f'不應該留下暫存檔：{leftover_tmp_files}')
            with open(cp_path, 'r', encoding='utf-8') as f:
                json.load(f)  # 檔案內容必須是合法 JSON（完整寫入，不是半寫入）

    def test_matching_fingerprint_resumes_without_reprocessing_successful_documents(self):
        for i in range(30):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            self.dest.fail_at_commit_number = 2
            checkpoint = mig.Checkpoint(cp_path)
            mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         checkpoint=checkpoint, collections=('stocks',),
                         source_project='p-src', dest_project='p-dst')
            self.assertEqual(len(self.dest.store.get('stocks', {})), 10)

            checkpoint2 = mig.Checkpoint(cp_path)
            report2 = mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                                    order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                    checkpoint=checkpoint2, collections=('stocks',),
                                    source_project='p-src', dest_project='p-dst')

            self.assertFalse(report2['stocks']['halted'])
            self.assertEqual(len(self.dest.store.get('stocks', {})), 30)
            for i in range(30):
                self.assertEqual(self.dest.store['stocks'][f'doc{i:03d}'], {'v': i})


# ══════════════════════════════════════════════════════════════
# 部分失敗後可重跑（沒有 checkpoint 檔案時：從頭冪等重跑）
# ══════════════════════════════════════════════════════════════

class TestPartialFailureThenResume(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_failed_batch_is_reported_and_halts_this_collection(self):
        for i in range(30):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        self.dest.fail_at_commit_number = 2  # 第二批（doc010..019）會失敗

        report = mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               collections=('stocks',))

        self.assertTrue(report['stocks']['halted'])
        self.assertEqual(report['stocks']['success'], 10)
        self.assertEqual(report['stocks']['failed'], 10)
        self.assertEqual(len(self.dest.store.get('stocks', {})), 10)

    def test_ai_jobs_without_checkpoint_file_safely_reruns_from_scratch_after_failure(self):
        """news/ai_jobs/ai_insights 沒有 checkpoint 機制；中斷後直接
        整個重新執行一次，冪等寫入確保最終結果正確，不需要任何續傳邏輯。"""
        self.source.seed('news', 'a', _news('文章A', _taipei(2026, 7, 10)))
        self.source.seed('news', 'b', _news('文章B', _taipei(2026, 7, 11)))
        self.source.seed('ai_jobs', 'a', {'status': 'done'})
        self.source.seed('ai_jobs', 'b', {'status': 'done'})

        self.dest.fail_at_commit_number = 1
        mig.copy_all(self.source, self.dest, self.now, page_size=1, batch_size=1,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('news', 'ai_jobs'))

        # 不注入失敗，重新完整執行一次。
        self.dest.fail_at_commit_number = None
        report2 = mig.copy_all(self.source, self.dest, self.now, page_size=1, batch_size=1,
                                order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                collections=('news', 'ai_jobs'))

        self.assertFalse(report2['ai_jobs']['halted'])
        self.assertTrue(self.dest.exists('ai_jobs', 'a'))
        self.assertTrue(self.dest.exists('ai_jobs', 'b'))


# ══════════════════════════════════════════════════════════════
# verify：missing/differs/extra/總數/未知集合/非 0 結束碼
# ══════════════════════════════════════════════════════════════

class TestVerify(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_verify_reports_missing_differing_matching_and_extra_docs(self):
        self.source.seed('stocks', 'match', {'price': 100})
        self.source.seed('stocks', 'differs', {'price': 200})
        self.source.seed('stocks', 'missing', {'price': 300})
        self.dest.seed('stocks', 'match', {'price': 100})
        self.dest.seed('stocks', 'differs', {'price': 999})
        self.dest.seed('stocks', 'extra_doc', {'price': 1})
        # 'missing' 沒有 seed 到 dest

        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('stocks',))

        self.assertEqual(report['stocks']['matches'], 1)
        self.assertEqual(report['stocks']['differs'], ['differs'])
        self.assertEqual(report['stocks']['missing_in_dest'], ['missing'])
        self.assertEqual(report['stocks']['extra_in_dest'], ['extra_doc'])
        self.assertEqual(report['stocks']['source_total'], 3)
        self.assertEqual(report['stocks']['dest_total'], 3)

    def test_verify_does_not_write_to_either_side(self):
        self.source.seed('stocks', 'a', {'price': 1})
        mig.verify_all(self.source, self.dest, self.now, page_size=10,
                       order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                       collections=('stocks',))
        self.assertEqual(self.dest.commit_calls, 0)
        self.assertEqual(self.dest.write_calls, 0)
        self.assertFalse(self.dest.exists('stocks', 'a'))

    def test_verify_after_successful_copy_reports_all_matches_and_no_findings(self):
        for i in range(5):
            self.source.seed('stocks', f'doc{i}', {'v': i})
        mig.copy_all(self.source, self.dest, self.now, page_size=10, batch_size=400,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     collections=('stocks',))
        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('stocks',))
        self.assertEqual(report['stocks']['matches'], 5)
        self.assertEqual(report['stocks']['missing_in_dest'], [])
        self.assertEqual(report['stocks']['differs'], [])
        self.assertEqual(report['stocks']['extra_in_dest'], [])
        self.assertFalse(mig.verify_has_findings(report))

    def test_verify_has_findings_true_when_anything_is_missing_or_differs_or_extra(self):
        self.source.seed('stocks', 'missing', {'v': 1})
        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('stocks',))
        self.assertTrue(mig.verify_has_findings(report))

    def test_dest_unrecognized_collection_is_flagged_and_counts_as_a_finding(self):
        self.dest.seed('some_unexpected_collection', 'x', {'y': 1})
        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('stocks',))
        self.assertIn('some_unexpected_collection', report['_unrecognized_dest_collections'])
        self.assertTrue(mig.verify_has_findings(report))

    def test_cli_verify_exits_non_zero_when_findings_exist(self):
        self.source.seed('stocks', 'missing', {'v': 1})
        # main() 透過 build_client 建立真正的 client，這裡直接呼叫
        # verify_all + verify_has_findings 驗證 main() 會用到的判斷邏輯，
        # 不需要真的起一個 CLI 行程。
        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate)
        self.assertEqual(1 if mig.verify_has_findings(report) else 0, 1)

    def test_meta_extra_only_flags_preserve_like_ids_not_locks_or_unclassified(self):
        """目的端如果自己另外有 lock_* 或未分類的 meta 文件（例如
        Functions 已經切換過去自己產生的鎖），不該被 verify 誤判成
        『多出來的』——那不是這個工具的搬移範圍需要處理的問題。"""
        self.source.seed('meta', 'digest_tw', {'lastSentAt': self.now})
        self.dest.seed('meta', 'digest_tw', {'lastSentAt': self.now})
        self.dest.seed('meta', 'lock_news', {'owner': 'someone-else'})
        self.dest.seed('meta', 'some_other_app_data', {'x': 1})

        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('meta',))

        self.assertEqual(report['meta']['extra_in_dest'], [])
        self.assertEqual(report['meta']['matches'], 1)


# ══════════════════════════════════════════════════════════════
# 憑證與錯誤訊息不洩漏秘密（全部用 tempfile，不寫死任何固定路徑）
# ══════════════════════════════════════════════════════════════

class TestCredentialErrorsDoNotLeakSecrets(unittest.TestCase):
    def test_missing_credentials_file_error_does_not_include_file_content(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_key_path = os.path.join(tmp_dir, 'does_not_exist_key.json')
            try:
                mig.build_client('transcend-news-tbm', credentials_path=fake_key_path)
                self.fail('預期應該因為檔案不存在而拋出 MigrationError')
            except mig.MigrationError as e:
                msg = str(e)
                self.assertIn('MigrationError', type(e).__name__)
                self.assertNotIn('private_key', msg)
                self.assertNotIn('BEGIN PRIVATE KEY', msg)

    def test_malformed_credentials_file_error_does_not_echo_file_content(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            bad_key_path = os.path.join(tmp_dir, 'bad_key.json')
            with open(bad_key_path, 'w', encoding='utf-8') as f:
                f.write('{"private_key": "-----BEGIN PRIVATE KEY-----\\nnotarealkey\\n-----END PRIVATE KEY-----"}')
            with self.assertRaises(mig.MigrationError) as ctx:
                mig.build_client('transcend-news-tbm', credentials_path=bad_key_path)
            self.assertNotIn('BEGIN PRIVATE KEY', str(ctx.exception))
            self.assertNotIn('notarealkey', str(ctx.exception))

    def test_print_report_never_includes_document_field_values(self):
        """報告輸出只應該看得到 ID／數量，不能出現原始文件內容
        （用一個帶有明顯敏感樣式字串的欄位值當 canary，斷言它完全
        不會出現在任何 report 的可序列化內容裡）。"""
        source = FakeFirestoreDB()
        canary = 'CANARY-SECRET-VALUE-should-never-be-logged'
        source.seed('stocks', 'a', {'apiToken': canary})
        now = _taipei(2026, 8, 3, 10, 0)

        report = mig.dry_run_report(source, now, page_size=10,
                                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                     collections=('stocks',))
        serialized = json.dumps(report, default=str)
        self.assertNotIn(canary, serialized)

    def test_checkpoint_file_only_contains_ids_and_metadata_not_document_content(self):
        source = FakeFirestoreDB()
        dest = FakeFirestoreDB()
        canary = 'CANARY-SECRET-VALUE-should-never-be-in-checkpoint'
        source.seed('stocks', 'a', {'apiToken': canary})
        now = _taipei(2026, 8, 3, 10, 0)

        with tempfile.TemporaryDirectory() as tmp_dir:
            cp_path = os.path.join(tmp_dir, 'checkpoint.json')
            checkpoint = mig.Checkpoint(cp_path)
            mig.copy_all(source, dest, now, page_size=10, batch_size=400,
                         order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                         checkpoint=checkpoint, collections=('stocks',),
                         source_project='p-src', dest_project='p-dst')
            with open(cp_path, 'r', encoding='utf-8') as f:
                content = f.read()
            self.assertNotIn(canary, content)


if __name__ == '__main__':
    unittest.main()
