"""
functions/digest.py（DRAM/Flash 新聞摘要信件，Phase 1）單元測試 — 完全離線

外部套件（requests / feedparser / firebase_admin）在 import 前以 stub 取代；
send_email 一律 mock 掉，測試中不會真的連線 smtp.gmail.com。
"""

import datetime
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

for _mod in ('requests', 'feedparser', 'firebase_admin',
             'firebase_admin.credentials', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import digest  # noqa: E402

TZ_UTC = datetime.timezone.utc


def _mk_article(title, content='', pub_dt=None, cat='twMarket', link=None):
    return {
        'title': title,
        'content': content,
        'link': link if link is not None else f'https://example.com/{title}',
        'pubDate': pub_dt if pub_dt is not None else datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC),
        'sentiment': 'neutral',
        'cat': cat,
        'brand': None,
        'sourceName': 'src',
        'mediaName': 'media',
    }


class TestSelectDigestArticles(unittest.TestCase):
    def setUp(self):
        self.since = datetime.datetime(2026, 7, 20, 0, 0, tzinfo=TZ_UTC)

    def test_filters_out_articles_at_or_before_since(self):
        old = _mk_article('舊聞 創見', '創見 記憶體', pub_dt=self.since - datetime.timedelta(hours=1))
        at_boundary = _mk_article('邊界 創見', '創見 記憶體', pub_dt=self.since)
        new = _mk_article('新聞 創見', '創見 記憶體 供應鏈', pub_dt=self.since + datetime.timedelta(hours=1))
        result = digest.select_digest_articles([old, at_boundary, new], self.since)
        titles = [a['title'] for a, _ in result]
        self.assertEqual(titles, ['新聞 創見'])

    def test_filters_out_irrelevant_articles(self):
        irrelevant = _mk_article('今天天氣真好', '跟產業無關的內容',
                                  pub_dt=self.since + datetime.timedelta(hours=1))
        result = digest.select_digest_articles([irrelevant], self.since)
        self.assertEqual(result, [])

    def test_sorted_by_importance_desc(self):
        after = self.since + datetime.timedelta(hours=1)
        low = _mk_article('DRAM NAND 記憶體 儲存', '', pub_dt=after)       # importance 18
        high = _mk_article('創見 財報 獲利 EPS', '創見 財報 獲利', pub_dt=after)  # importance 60
        result = digest.select_digest_articles([low, high], self.since)
        titles = [a['title'] for a, _ in result]
        self.assertEqual(titles, ['創見 財報 獲利 EPS', 'DRAM NAND 記憶體 儲存'])

    def test_respects_limit(self):
        after = self.since + datetime.timedelta(hours=1)
        arts = [_mk_article(f'創見 記憶體 新聞{i}', '創見 記憶體', pub_dt=after) for i in range(5)]
        result = digest.select_digest_articles(arts, self.since, limit=2)
        self.assertEqual(len(result), 2)

    def test_missing_pubdate_excluded(self):
        bad = _mk_article('創見 記憶體', '創見')
        bad['pubDate'] = None
        result = digest.select_digest_articles([bad], self.since)
        self.assertEqual(result, [])

    def test_empty_input(self):
        self.assertEqual(digest.select_digest_articles([], self.since), [])


class TestBuildDigestEmail(unittest.TestCase):
    def test_empty_items_message(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        subject, body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [], now=now)
        self.assertIn('2026-07-20', subject)
        self.assertIn('沒有符合條件', body)

    def test_items_included_with_link_and_count(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article('創見 財報 獲利', '創見 財報 獲利', link='https://example.com/x')
        import intelligence
        rules = intelligence.analyze_article_rules(article)
        subject, body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertIn('共 1 則', subject)
        self.assertIn('創見', body)
        self.assertIn('https://example.com/x', body)


class _FakeSnap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None
    def to_dict(self):
        return self._data


class _FakeDocRef:
    def __init__(self, store, path):
        self.store = store
        self.path = path
    def get(self):
        return _FakeSnap(self.store.get(self.path))
    def set(self, data, merge=False):
        current = self.store.get(self.path, {}) if merge else {}
        current.update(data)
        self.store[self.path] = current


class _FakeDoc:
    def __init__(self, store, path, data):
        self.store = store
        self.path = path
        self._data = data
    def to_dict(self):
        return self._data


class _FakeQuery:
    def __init__(self, docs):
        self._docs = docs
    def stream(self):
        return iter(self._docs)


class _FakeCollection:
    def __init__(self, db, name):
        self.db = db
        self.name = name
    def document(self, doc_id):
        return _FakeDocRef(self.db.store, f'{self.name}/{doc_id}')
    def where(self, field, op, value):
        assert op == '=='
        docs = [
            _FakeDoc(self.db.store, f'{self.name}/{i}', d)
            for i, d in enumerate(self.db.news)
            if d.get(field) == value
        ]
        return _FakeQuery(docs)


class FakeDB:
    def __init__(self, news=None):
        self.store = {}     # meta/xxx checkpoint storage
        self.news = news or []
    def collection(self, name):
        return _FakeCollection(self, name)


class TestDigestCheckpoint(unittest.TestCase):
    def test_no_checkpoint_defaults_to_lookback(self):
        db = FakeDB()
        before_call = datetime.datetime.now(TZ_UTC)
        since = digest.get_last_digest_time(db, 'tw', default_lookback_hours=48)
        expected_floor = before_call - datetime.timedelta(hours=48, minutes=1)
        self.assertGreater(since, expected_floor)
        self.assertLess(since, before_call)

    def test_reads_existing_checkpoint(self):
        db = FakeDB()
        ts = datetime.datetime(2026, 7, 18, 8, 0, tzinfo=TZ_UTC)
        digest.set_last_digest_time(db, 'tw', ts)
        self.assertEqual(digest.get_last_digest_time(db, 'tw'), ts)

    def test_tw_and_us_checkpoints_independent(self):
        db = FakeDB()
        digest.set_last_digest_time(db, 'tw', datetime.datetime(2026, 7, 18, 8, 0, tzinfo=TZ_UTC))
        digest.set_last_digest_time(db, 'us', datetime.datetime(2026, 7, 17, 16, 30, tzinfo=TZ_UTC))
        self.assertNotEqual(digest.get_last_digest_time(db, 'tw'),
                             digest.get_last_digest_time(db, 'us'))


class TestFetchCatArticles(unittest.TestCase):
    def test_filters_by_category_only(self):
        db = FakeDB(news=[
            _mk_article('台灣新聞', cat='twMarket'),
            _mk_article('美國新聞', cat='usMarket'),
        ])
        arts = digest.fetch_cat_articles(db, 'twMarket')
        self.assertEqual([a['title'] for a in arts], ['台灣新聞'])


class TestRunDigest(unittest.TestCase):
    def test_sends_email_and_advances_checkpoint_on_success(self):
        db = FakeDB(news=[_mk_article('創見 財報 獲利', '創見 財報 獲利',
                                       pub_dt=datetime.datetime.now(TZ_UTC))])
        with patch.object(digest, 'send_email') as msend:
            result = digest.run_digest(db, 'tw', 'fake-app-password')
        msend.assert_called_once()
        self.assertEqual(result['count'], 1)
        # checkpoint 應已推進到接近現在，下次執行不會重複寄送同一則
        new_since = digest.get_last_digest_time(db, 'tw')
        self.assertGreater(new_since, datetime.datetime.now(TZ_UTC) - datetime.timedelta(minutes=1))

    def test_checkpoint_not_advanced_when_send_fails(self):
        db = FakeDB(news=[_mk_article('創見 財報 獲利', '創見 財報 獲利',
                                       pub_dt=datetime.datetime.now(TZ_UTC))])
        old_since = datetime.datetime(2020, 1, 1, tzinfo=TZ_UTC)
        digest.set_last_digest_time(db, 'tw', old_since)
        with patch.object(digest, 'send_email', side_effect=RuntimeError('smtp 掛了')):
            with self.assertRaises(RuntimeError):
                digest.run_digest(db, 'tw', 'fake-app-password')
        self.assertEqual(digest.get_last_digest_time(db, 'tw'), old_since,
                         '寄信失敗時不得更新時間戳記，否則下次執行會漏掉這次的新聞')


if __name__ == '__main__':
    unittest.main()
