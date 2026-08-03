"""
tools/migrate_firestore.py 單元測試 — 完全離線。

用自建的 FakeFirestoreDB 模擬 google-cloud-firestore 的 collection/
document/where/order_by/limit/start_after/stream/get/batch/commit/
collections()，不需要安裝 google-cloud-firestore、不會連線任何專案。
"""

import datetime
import json
import sys
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
    def __init__(self, doc_id, data, exists=True):
        self.id = doc_id
        self._data = data
        self.exists = exists

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _FakeDocRef:
    def __init__(self, db, coll, doc_id):
        self.db, self.coll, self.doc_id = db, coll, doc_id

    def get(self):
        data = self.db.store.get(self.coll, {}).get(self.doc_id)
        return _FakeSnap(self.doc_id, data, exists=data is not None)


class _FakeQuery:
    def __init__(self, db, coll, filters=None, order_field=None, order_is_id=False,
                 limit_n=None, start_after_snap=None):
        self.db, self.coll = db, coll
        self.filters = filters or []
        self.order_field = order_field
        self.order_is_id = order_is_id
        self.limit_n = limit_n
        self.start_after_snap = start_after_snap

    def where(self, field, op, value):
        assert op in ('>=', '=='), f'fake 只實作 >= 與 ==，收到 {op!r}'
        return _FakeQuery(self.db, self.coll, self.filters + [(field, op, value)],
                           self.order_field, self.order_is_id, self.limit_n, self.start_after_snap)

    def order_by(self, field):
        return _FakeQuery(self.db, self.coll, self.filters, field, False,
                           self.limit_n, self.start_after_snap)

    def order_by_document_id(self):
        return _FakeQuery(self.db, self.coll, self.filters, None, True,
                           self.limit_n, self.start_after_snap)

    def limit(self, n):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_field, self.order_is_id,
                           n, self.start_after_snap)

    def start_after(self, snap):
        return _FakeQuery(self.db, self.coll, self.filters, self.order_field, self.order_is_id,
                           self.limit_n, snap)

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

        if self.order_is_id:
            items.sort(key=lambda kv: kv[0])
        elif self.order_field:
            items.sort(key=lambda kv: (kv[1].get(self.order_field), kv[0]))

        if self.start_after_snap is not None:
            if self.order_is_id:
                cursor_key = self.start_after_snap.id
                items = [kv for kv in items if kv[0] > cursor_key]
            else:
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

    def exists(self, coll, doc_id):
        return doc_id in self.store.get(coll, {})

    def get(self, coll, doc_id):
        return self.store.get(coll, {}).get(doc_id)


def order_by_id(query_or_coll):
    return query_or_coll.order_by_document_id()


def order_by_pubdate(query):
    return query.order_by('pubDate')


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
        # dry-run 不需要目的端；沒有任何 dest_db 被建立/呼叫，這裡用「來源
        # 端 store 完全沒被修改」佐證同一件事。
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
# 來源/目的專案防呆
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
# meta allowlist（未知文件不自動搬移，只列出來）
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


# ══════════════════════════════════════════════════════════════
# 部分失敗後可重跑
# ══════════════════════════════════════════════════════════════

class TestPartialFailureThenResume(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_failed_batch_is_reported_and_does_not_advance_checkpoint_past_it(self):
        for i in range(30):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        checkpoint_path = '/tmp/claude-0/-home-user-transcend-news/8d5a0ee1-4f8c-56cc-988e-827128d125ce/scratchpad/mig_test_checkpoint.json'
        Path(checkpoint_path).unlink(missing_ok=True)
        checkpoint = mig.Checkpoint(checkpoint_path)

        self.dest.fail_at_commit_number = 2  # 第二批（doc010..019）會失敗
        report = mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                               order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                               checkpoint=checkpoint, collections=('stocks',))

        self.assertTrue(report['stocks']['halted'])
        self.assertEqual(report['stocks']['success'], 10)   # 第一批成功
        self.assertEqual(report['stocks']['failed'], 10)    # 第二批失敗
        # 第三批（doc020..029）因為 halted 而完全沒被嘗試，不算 success 也不算 failed。
        self.assertEqual(len(self.dest.store.get('stocks', {})), 10)
        # checkpoint 停在第一批結束處（doc009），不是失敗批次結束處。
        self.assertEqual(checkpoint.last_id('stocks'), 'doc009')
        Path(checkpoint_path).unlink(missing_ok=True)

    def test_rerun_with_checkpoint_completes_the_remaining_documents_without_reprocessing_the_success_ones(self):
        for i in range(30):
            self.source.seed('stocks', f'doc{i:03d}', {'v': i})
        checkpoint_path = '/tmp/claude-0/-home-user-transcend-news/8d5a0ee1-4f8c-56cc-988e-827128d125ce/scratchpad/mig_test_checkpoint2.json'
        Path(checkpoint_path).unlink(missing_ok=True)
        checkpoint = mig.Checkpoint(checkpoint_path)

        self.dest.fail_at_commit_number = 2
        mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                     order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                     checkpoint=checkpoint, collections=('stocks',))
        self.assertEqual(len(self.dest.store.get('stocks', {})), 10)

        # 用同一個 checkpoint 檔案重新載入後重跑（模擬程式重新啟動）；
        # 這次不再注入失敗，應該把剩下的 20 筆都補完，總數變成 30。
        checkpoint2 = mig.Checkpoint(checkpoint_path)
        report2 = mig.copy_all(self.source, self.dest, self.now, page_size=30, batch_size=10,
                                order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                checkpoint=checkpoint2, collections=('stocks',))

        self.assertFalse(report2['stocks']['halted'])
        self.assertEqual(len(self.dest.store.get('stocks', {})), 30)
        for i in range(30):
            self.assertEqual(self.dest.store['stocks'][f'doc{i:03d}'], {'v': i})
        Path(checkpoint_path).unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════
# verify 能找出缺少或內容不同的文件
# ══════════════════════════════════════════════════════════════

class TestVerify(unittest.TestCase):
    def setUp(self):
        self.source = FakeFirestoreDB()
        self.dest = FakeFirestoreDB()
        self.now = _taipei(2026, 8, 3, 10, 0)

    def test_verify_reports_missing_differing_and_matching_docs(self):
        self.source.seed('stocks', 'match', {'price': 100})
        self.source.seed('stocks', 'differs', {'price': 200})
        self.source.seed('stocks', 'missing', {'price': 300})
        self.dest.seed('stocks', 'match', {'price': 100})
        self.dest.seed('stocks', 'differs', {'price': 999})
        # 'missing' 沒有 seed 到 dest

        report = mig.verify_all(self.source, self.dest, self.now, page_size=10,
                                 order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                                 collections=('stocks',))

        self.assertEqual(report['stocks']['matches'], 1)
        self.assertEqual(report['stocks']['differs'], ['differs'])
        self.assertEqual(report['stocks']['missing_in_dest'], ['missing'])

    def test_verify_does_not_write_to_either_side(self):
        self.source.seed('stocks', 'a', {'price': 1})
        mig.verify_all(self.source, self.dest, self.now, page_size=10,
                       order_by_id_fn=order_by_id, order_by_pubdate_fn=order_by_pubdate,
                       collections=('stocks',))
        self.assertEqual(self.dest.commit_calls, 0)
        self.assertEqual(self.dest.write_calls, 0)
        self.assertFalse(self.dest.exists('stocks', 'a'))

    def test_verify_after_successful_copy_reports_all_matches(self):
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


# ══════════════════════════════════════════════════════════════
# 未知頂層集合安全網
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


# ══════════════════════════════════════════════════════════════
# 憑證與錯誤訊息不洩漏秘密
# ══════════════════════════════════════════════════════════════

class TestCredentialErrorsDoNotLeakSecrets(unittest.TestCase):
    def test_missing_credentials_file_error_does_not_include_file_content(self):
        fake_key_path = '/tmp/claude-0/-home-user-transcend-news/8d5a0ee1-4f8c-56cc-988e-827128d125ce/scratchpad/does_not_exist_key.json'
        Path(fake_key_path).unlink(missing_ok=True)
        try:
            mig.build_client('transcend-news-tbm', credentials_path=fake_key_path)
            self.fail('預期應該因為檔案不存在而拋出 MigrationError')
        except mig.MigrationError as e:
            msg = str(e)
            self.assertIn('MigrationError', type(e).__name__)
            self.assertNotIn('private_key', msg)
            self.assertNotIn('BEGIN PRIVATE KEY', msg)

    def test_malformed_credentials_file_error_does_not_echo_file_content(self):
        bad_key_path = '/tmp/claude-0/-home-user-transcend-news/8d5a0ee1-4f8c-56cc-988e-827128d125ce/scratchpad/bad_key.json'
        with open(bad_key_path, 'w', encoding='utf-8') as f:
            f.write('{"private_key": "-----BEGIN PRIVATE KEY-----\\nnotarealkey\\n-----END PRIVATE KEY-----"}')
        try:
            with self.assertRaises(mig.MigrationError) as ctx:
                mig.build_client('transcend-news-tbm', credentials_path=bad_key_path)
            self.assertNotIn('BEGIN PRIVATE KEY', str(ctx.exception))
            self.assertNotIn('notarealkey', str(ctx.exception))
        finally:
            Path(bad_key_path).unlink(missing_ok=True)

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


if __name__ == '__main__':
    unittest.main()
