"""topic_cluster_job：Firestore 讀寫流程（水位線、上限、dry-run、fail closed、零刪除）。完全離線。"""

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

for _mod in ('firebase_admin', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)
sys.modules['firebase_admin'].firestore = types.SimpleNamespace(SERVER_TIMESTAMP='TS')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import topic_cluster as tc  # noqa: E402
import topic_cluster_store as job  # noqa: E402

NOW = datetime(2026, 10, 10, 6, 0, tzinfo=timezone.utc)


class Doc:
    def __init__(self, id_, data):
        self.id, self._d = id_, data
        self.exists = True

    def to_dict(self):
        return dict(self._d)


class Query:
    def __init__(self, db, name, filters=(), order=None, lim=None):
        self.db, self.name, self.filters, self.order, self.lim = db, name, filters, order, lim

    def where(self, field, op, value):
        return Query(self.db, self.name, self.filters + ((field, op, value),), self.order, self.lim)

    def order_by(self, field):
        return Query(self.db, self.name, self.filters, field, self.lim)

    def limit(self, n):
        return Query(self.db, self.name, self.filters, self.order, n)

    def stream(self):
        if self.db.fail_reads == self.name:
            raise RuntimeError('read down')
        rows = list(self.db.store.setdefault(self.name, {}).items())
        for field, op, value in self.filters:
            rows = [(i, d) for i, d in rows if d.get(field) is not None and d[field] >= value]
        if self.order:
            rows.sort(key=lambda kv: kv[1][self.order])
        if self.lim:
            rows = rows[:self.lim]
        return [Doc(i, d) for i, d in rows]


class Ref:
    def __init__(self, db, name, id_):
        self.db, self.name, self.id = db, name, id_

    def get(self):
        d = self.db.store.setdefault(self.name, {}).get(self.id)
        snap = Doc(self.id, d or {})
        snap.exists = d is not None
        return snap

    def set(self, data, merge=False):
        coll = self.db.store.setdefault(self.name, {})
        coll[self.id] = {**coll.get(self.id, {}), **data} if merge else dict(data)
        self.db.writes.append((self.name, self.id))


class Collection(Query):
    def document(self, id_):
        return Ref(self.db, self.name, id_)


class Batch:
    def __init__(self, db):
        self.db, self.ops = db, []

    def set(self, ref, data, merge=False):
        self.ops.append((ref, data, merge))

    def commit(self):
        self.db.batch_sizes.append(len(self.ops))
        for ref, data, merge in self.ops:
            ref.set(data, merge)


class FakeDb:
    def __init__(self):
        self.store, self.writes, self.batch_sizes, self.fail_reads = {}, [], [], None

    def collection(self, name):
        return Collection(self, name)

    def batch(self):
        return Batch(self)

    def add_news(self, i, title, fetched_hours, pub_hours=0, **extra):
        self.store.setdefault('news', {})[f'n{i}'] = {
            'id': f'n{i}', 'title': title, 'pubDate': NOW - timedelta(hours=pub_hours), 'fetchedAt': NOW - timedelta(hours=fetched_hours),
            'mediaName': extra.pop('mediaName', '經濟日報'), 'cat': extra.pop('cat', 'transcend'), 'sentiment': 'neutral',
            'link': f'https://example.com/{i}', 'content': '內文不應被改動', **extra}


def seed(db):
    db.add_news(1, '創見參加台北國際電子展 秀智慧鏡頭、DDR5高速記憶體', 5, 5, mediaName='聯合報')
    db.add_news(2, '創見參展台北國際電子展 秀DDR5-7200及AI影像新品', 4, 4, mediaName='工商時報')
    db.add_news(3, '創見7月營收52億元 年增308%', 3, 3)
    db.add_news(4, '威剛7月營收創歷史新高', 2, 2, cat='competitor')


class TestRun(unittest.TestCase):
    def test_first_run_clusters_and_writes_only_topics_and_state(self):
        db = FakeDb()
        seed(db)
        news_before = {k: dict(v) for k, v in db.store['news'].items()}
        report, _ = job.run_topic_cluster(db, NOW, server_ts='TS')
        topics = db.store['news_topics']
        self.assertEqual(report['clustered'], 4)
        self.assertEqual(len(topics), 3)                          # 電子展(2)、創見營收、威剛營收
        self.assertEqual(sorted(t['articleCount'] for t in topics.values()), [1, 1, 2])
        self.assertEqual(db.store['news'], news_before)           # 新聞原文與欄位完全不動
        self.assertEqual({w[0] for w in db.writes}, {'news_topics', 'meta', 'job_status'})
        self.assertIn('watermark', db.store['meta']['topic_cluster_state'])

    def test_rerun_is_idempotent_no_topic_writes(self):
        db = FakeDb()
        seed(db)
        job.run_topic_cluster(db, NOW, server_ts='TS')
        ids = set(db.store['news_topics'])
        writes = len(db.writes)
        report, _ = job.run_topic_cluster(db, NOW, server_ts='TS')
        self.assertEqual(report['clustered'], 0)
        self.assertEqual(report['topicWrites'], 0)
        self.assertEqual(set(db.store['news_topics']), ids)
        self.assertEqual([w for w in db.writes[writes:] if w[0] == 'news_topics'], [])

    def test_new_article_joins_existing_topic_with_same_id(self):
        db = FakeDb()
        seed(db)
        job.run_topic_cluster(db, NOW, server_ts='TS')
        topic_id = next(i for i, t in db.store['news_topics'].items() if t['articleCount'] == 2)
        db.add_news(5, '創見參加2026台北國際電子展 秀智慧鏡頭、DDR5高速記憶體搶機器人商機', 0.2, 0.2, mediaName='鏡報')
        report, _ = job.run_topic_cluster(db, NOW + timedelta(minutes=30), server_ts='TS')
        self.assertEqual(report['joined'], 1)
        self.assertEqual(db.store['news_topics'][topic_id]['articleCount'], 3)
        self.assertEqual(len(db.store['news_topics']), 3)

    def test_dry_run_writes_nothing_and_reports_estimates(self):
        db = FakeDb()
        seed(db)
        report, plan = job.run_topic_cluster(db, NOW, dry_run=True)
        self.assertEqual(db.writes, [])
        self.assertEqual(db.store.get('news_topics', {}), {})
        self.assertTrue(report['dryRun'])
        self.assertEqual(report['newTopics'], 3)
        self.assertEqual(report['estimatedWrites'], len(plan['upserts']))
        self.assertGreater(report['estimatedReads'], 0)

    def test_read_failure_aborts_without_writing_or_clearing_topics(self):
        db = FakeDb()
        seed(db)
        job.run_topic_cluster(db, NOW, server_ts='TS')
        snapshot = {k: dict(v) for k, v in db.store['news_topics'].items()}
        writes = len(db.writes)
        for failing in ('news', 'news_topics'):
            db.fail_reads = failing
            with self.assertRaises(job.ClusterAbort):
                job.run_topic_cluster(db, NOW + timedelta(hours=1), server_ts='TS')
        db.fail_reads = None
        self.assertEqual(len(db.writes), writes)
        self.assertEqual(db.store['news_topics'], snapshot)

    def test_per_run_limit_and_resume(self):
        db = FakeDb()
        for i in range(10):
            db.add_news(i, f'公司{chr(65 + i)}發表產品X{i}00新品', 10 - i, 10 - i)
        report, _ = job.run_topic_cluster(db, NOW, max_new=4, server_ts='TS')
        self.assertEqual((report['considered'], report['hasMore']), (4, True))
        self.assertEqual(len(db.store['news_topics']), 4)
        total = 4
        for k in range(1, 6):
            report, _ = job.run_topic_cluster(db, NOW + timedelta(minutes=30 * k), max_new=4, server_ts='TS')
            total += report['clustered']
            if not report['hasMore']:
                break
        self.assertEqual(len(db.store['news_topics']), 10)
        self.assertEqual(total, 10)

    def test_old_articles_are_ignored(self):
        db = FakeDb()
        db.add_news(1, '創見推出新品', 1, 24 * 20)
        report, _ = job.run_topic_cluster(db, NOW, server_ts='TS')
        self.assertEqual(report['clustered'], 0)

    def test_batches_are_bounded_and_nothing_is_deleted(self):
        db = FakeDb()
        for i in range(450):
            db.add_news(i, f'公司{i}發表產品Y{i}新品第{i}號', 1, 1)
        job.run_topic_cluster(db, NOW, max_new=500, server_ts='TS')
        self.assertTrue(all(n <= job.BATCH_LIMIT for n in db.batch_sizes), db.batch_sizes)
        self.assertEqual(len(db.store['news']), 450)
        self.assertEqual(len(db.store['news_topics']), 450)

    def test_velocity_refresh_only_writes_when_metrics_change(self):
        db = FakeDb()
        seed(db)
        job.run_topic_cluster(db, NOW, server_ts='TS')
        writes = len(db.writes)
        job.run_topic_cluster(db, NOW + timedelta(minutes=30), server_ts='TS')
        self.assertEqual([w for w in db.writes[writes:] if w[0] == 'news_topics'], [])
        later = NOW + timedelta(hours=30)           # 最舊的報導滑出 24 小時視窗 → 指標改變才寫
        report, _ = job.run_topic_cluster(db, later, server_ts='TS')
        self.assertGreater(report['topicWrites'], 0)


class TestHygiene(unittest.TestCase):
    def test_job_module_never_deletes_or_writes_news(self):
        text = (Path(__file__).resolve().parent.parent / 'functions' / 'topic_cluster_store.py').read_text(encoding='utf-8')
        self.assertNotIn('.delete(', text)
        self.assertNotIn("collection(NEWS).document", text)
        self.assertNotIn('batch.delete', text)

    def test_cluster_module_has_no_network_or_paid_ai(self):
        text = (Path(__file__).resolve().parent.parent / 'functions' / 'topic_cluster.py').read_text(encoding='utf-8')
        for bad in ('requests', 'urllib', 'openai', 'anthropic', 'http://', 'https://'):
            self.assertNotIn(bad, text)


if __name__ == '__main__':
    unittest.main()
