"""
fetch_news.py 純函式單元測試（完全離線，不連接任何外部服務）

執行方式：
  python3 -m unittest discover -s tests -v

外部套件（requests / feedparser / firebase_admin）在 import 前以 stub 取代，
因此本測試不需安裝這些套件，也絕不會發出網路請求。
"""

import datetime
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# ── 在 import fetch_news 前 stub 掉外部相依，確保離線可測 ──────────
for _mod in ('requests', 'feedparser', 'firebase_admin',
             'firebase_admin.credentials', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import fetch_news  # noqa: E402


TZ_UTC = datetime.timezone.utc


def _tw(y, m, d, hh, mm):
    """建立台灣時間 naive datetime（純函式只看年月日時分與星期）"""
    return datetime.datetime(y, m, d, hh, mm)


class TestMakeArticleId(unittest.TestCase):
    def test_deterministic(self):
        a = fetch_news.make_article_id('https://example.com/a', '標題')
        b = fetch_news.make_article_id('https://example.com/a', '標題')
        self.assertEqual(a, b)

    def test_length_and_hex(self):
        aid = fetch_news.make_article_id('https://example.com/a', 't')
        self.assertEqual(len(aid), 20)
        int(aid, 16)  # 應為十六進位字串

    def test_link_priority_over_title(self):
        # 有 link 時 id 只由 link 決定，不受標題影響
        a = fetch_news.make_article_id('https://example.com/a', '標題一')
        b = fetch_news.make_article_id('https://example.com/a', '標題二')
        self.assertEqual(a, b)

    def test_title_fallback_when_no_link(self):
        a = fetch_news.make_article_id('', '標題一')
        b = fetch_news.make_article_id('', '標題二')
        self.assertNotEqual(a, b)

    def test_empty_inputs(self):
        aid = fetch_news.make_article_id('', '')
        self.assertEqual(len(aid), 20)


class TestParseDate(unittest.TestCase):
    def test_published_parsed(self):
        entry = types.SimpleNamespace(
            published_parsed=(2026, 7, 14, 8, 30, 0, 0, 0, 0))
        dt = fetch_news.parse_date(entry)
        self.assertEqual(dt, datetime.datetime(2026, 7, 14, 8, 30, 0, tzinfo=TZ_UTC))

    def test_fallback_to_updated_parsed(self):
        entry = types.SimpleNamespace(
            published_parsed=None,
            updated_parsed=(2025, 1, 2, 3, 4, 5, 0, 0, 0))
        dt = fetch_news.parse_date(entry)
        self.assertEqual(dt, datetime.datetime(2025, 1, 2, 3, 4, 5, tzinfo=TZ_UTC))

    def test_missing_dates_returns_now(self):
        entry = types.SimpleNamespace()
        before = datetime.datetime.now(TZ_UTC)
        dt = fetch_news.parse_date(entry)
        after = datetime.datetime.now(TZ_UTC)
        self.assertTrue(before <= dt <= after)

    def test_invalid_tuple_falls_through(self):
        entry = types.SimpleNamespace(published_parsed=('bad',))
        dt = fetch_news.parse_date(entry)
        self.assertIsInstance(dt, datetime.datetime)


class TestCleanHtml(unittest.TestCase):
    def test_strips_tags(self):
        self.assertEqual(fetch_news.clean_html('<p>你好 <b>世界</b></p>'), '你好 世界')

    def test_none_and_empty(self):
        self.assertEqual(fetch_news.clean_html(None), '')
        self.assertEqual(fetch_news.clean_html(''), '')

    def test_plain_text_untouched(self):
        self.assertEqual(fetch_news.clean_html('  純文字  '), '純文字')

    def test_nested_and_attrs(self):
        html = '<div class="x"><a href="https://e.co">連結</a>文字</div>'
        self.assertEqual(fetch_news.clean_html(html), '連結文字')


class TestAnalyzeSentiment(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(fetch_news.analyze_sentiment('創見營收創新高 獲利成長'), 'positive')

    def test_negative(self):
        self.assertEqual(fetch_news.analyze_sentiment('記憶體大廠虧損 裁員停產'), 'negative')

    def test_neutral(self):
        self.assertEqual(fetch_news.analyze_sentiment('公司召開例行記者會'), 'neutral')

    def test_english_case_insensitive(self):
        self.assertEqual(fetch_news.analyze_sentiment('Company reports RECORD HIGH profit'), 'positive')
        self.assertEqual(fetch_news.analyze_sentiment('Massive layoff and lawsuit hit firm'), 'negative')

    def test_content_counted(self):
        self.assertEqual(fetch_news.analyze_sentiment('新聞', '兩家公司宣布合作 推出創新產品'), 'positive')


class TestTitleDedup(unittest.TestCase):
    """新聞標題去重：normalize_title + is_too_similar"""

    def test_normalize_removes_space_symbols_case(self):
        self.assertEqual(
            fetch_news.normalize_title('創見 6月營收：月減 20%！'),
            fetch_news.normalize_title('創見6月營收月減20%'))

    def test_normalize_lowercases(self):
        self.assertEqual(fetch_news.normalize_title('Transcend SSD'), 'transcendssd')

    def test_normalize_truncates(self):
        self.assertEqual(len(fetch_news.normalize_title('字' * 99)), 30)

    def test_normalize_none(self):
        self.assertEqual(fetch_news.normalize_title(None), '')

    def test_dedup_flow_same_title_different_punct(self):
        seen = set()
        kept = []
        for title in ['創見營收創新高！', '創見營收創新高', '威剛發表新品']:
            norm = fetch_news.normalize_title(title)
            if norm and norm in seen:
                continue
            seen.add(norm)
            kept.append(title)
        self.assertEqual(kept, ['創見營收創新高！', '威剛發表新品'])

    def test_is_too_similar_detects_overlap(self):
        a = {'title': 'TrendForce says DRAM prices expected to rise in Q3'}
        selected = [{'title': 'DRAM prices expected to rise in Q3, TrendForce says'}]
        self.assertTrue(fetch_news.is_too_similar(a, selected))

    def test_is_too_similar_allows_different(self):
        a = {'title': 'Transcend launches industrial SSD lineup'}
        selected = [{'title': 'Samsung breaks ground on new fab in Texas'}]
        self.assertFalse(fetch_news.is_too_similar(a, selected))

    def test_is_too_similar_empty_title(self):
        self.assertFalse(fetch_news.is_too_similar({'title': ''}, [{'title': 'x y z'}]))


class TestStockStale(unittest.TestCase):
    """股價過期判斷：is_tw_market_open + is_stock_stale"""

    def test_market_open_weekday(self):
        self.assertTrue(fetch_news.is_tw_market_open(_tw(2026, 7, 14, 10, 0)))   # 週二盤中

    def test_market_closed_weekend(self):
        self.assertFalse(fetch_news.is_tw_market_open(_tw(2026, 7, 18, 10, 0)))  # 週六

    def test_market_closed_before_open_after_close(self):
        self.assertFalse(fetch_news.is_tw_market_open(_tw(2026, 7, 14, 8, 59)))
        self.assertFalse(fetch_news.is_tw_market_open(_tw(2026, 7, 14, 14, 0)))

    def test_stale_when_old_during_market(self):
        now = _tw(2026, 7, 14, 11, 0)
        updated = _tw(2026, 7, 14, 10, 0)   # 60 分鐘前
        self.assertTrue(fetch_news.is_stock_stale(updated, now))

    def test_fresh_when_recent_during_market(self):
        now = _tw(2026, 7, 14, 11, 0)
        updated = _tw(2026, 7, 14, 10, 50)  # 10 分鐘前
        self.assertFalse(fetch_news.is_stock_stale(updated, now))

    def test_not_stale_outside_market_hours(self):
        now = _tw(2026, 7, 14, 20, 0)       # 晚上（收盤後）
        updated = _tw(2026, 7, 14, 13, 30)
        self.assertFalse(fetch_news.is_stock_stale(updated, now))

    def test_none_updated_at_is_stale(self):
        self.assertTrue(fetch_news.is_stock_stale(None, _tw(2026, 7, 14, 20, 0)))


class TestRevenueDateConversion(unittest.TestCase):
    """月營收日期轉換：finmind_revenue_period（申報月 → 實際營收月）+ roc_date_to_iso"""

    def test_normal_month_minus_one(self):
        self.assertEqual(fetch_news.finmind_revenue_period('2024-03'), (2024, 2))

    def test_january_rolls_to_previous_december(self):
        self.assertEqual(fetch_news.finmind_revenue_period('2024-01'), (2023, 12))

    def test_full_date_string(self):
        self.assertEqual(fetch_news.finmind_revenue_period('2026-07-01'), (2026, 6))

    def test_invalid_inputs(self):
        self.assertIsNone(fetch_news.finmind_revenue_period(''))
        self.assertIsNone(fetch_news.finmind_revenue_period('garbage'))
        self.assertIsNone(fetch_news.finmind_revenue_period(None))
        self.assertIsNone(fetch_news.finmind_revenue_period('2024-13'))

    def test_roc_date_slash(self):
        self.assertEqual(fetch_news.roc_date_to_iso('114/04/24'), '2025-04-24')

    def test_roc_date_dash(self):
        self.assertEqual(fetch_news.roc_date_to_iso('113-12-01'), '2024-12-01')

    def test_roc_date_invalid_returns_original(self):
        self.assertEqual(fetch_news.roc_date_to_iso('not-a-date-x'), 'not-a-date-x')


# ══════════════════════════════════════════════════════════════
# Fake Firestore（記憶體版，供去重與鎖測試；不連任何外部服務）
# ══════════════════════════════════════════════════════════════

class _FakeSnap:
    def __init__(self, data):
        self._data = data
    @property
    def exists(self):
        return self._data is not None
    def to_dict(self):
        return self._data


class _FakeDocRef:
    def __init__(self, db, path):
        self.db, self.path = db, path
    def get(self, transaction=None):
        if self.db.fail_get_paths and any(self.path.startswith(p) for p in self.db.fail_get_paths):
            raise RuntimeError(f'simulated read failure: {self.path}')
        self.db.reads += 1
        return _FakeSnap(self.db.store.get(self.path))
    def set(self, data, merge=False):
        self.db.writes += 1
        if merge and self.path in self.db.store:
            self.db.store[self.path] = {**self.db.store[self.path], **data}
        else:
            self.db.store[self.path] = dict(data)
    def create(self, data):
        if self.path in self.db.store:
            raise RuntimeError('AlreadyExists')
        self.db.writes += 1
        self.db.store[self.path] = dict(data)
    def delete(self):
        self.db.store.pop(self.path, None)


class _FakeTxn:
    """模擬 Firestore transaction：fn 內讀到最新狀態、set/delete 直接生效。
    （真實 transaction 的序列化語意由循序執行天然滿足）"""
    def __init__(self, db):
        self.db = db
    def set(self, ref, data, merge=False):
        ref.set(data, merge=merge)
    def delete(self, ref):
        ref.delete()


class _FakeCollection:
    def __init__(self, db, name):
        self.db, self.name = db, name
    def document(self, doc_id):
        return _FakeDocRef(self.db, f'{self.name}/{doc_id}')


class _FakeBatch:
    def __init__(self, db):
        self.db, self.ops = db, []
    def set(self, ref, data, merge=False):
        self.ops.append((ref, data, merge))
    def commit(self):
        self.db.batch_commits += 1
        for ref, data, merge in self.ops:
            ref.set(data, merge=merge)


class FakeDB:
    def __init__(self):
        self.store = {}
        self.reads = self.writes = self.batch_commits = self.txn_count = 0
        self.fail_get_paths = set()   # 加入路徑前綴可模擬讀取失敗
    def collection(self, name):
        return _FakeCollection(self, name)
    def batch(self):
        return _FakeBatch(self)
    def run_in_transaction(self, fn):
        self.txn_count += 1
        return fn(_FakeTxn(self))
    def news_doc_count(self):
        return sum(1 for k in self.store if k.startswith('news/'))


def _mk_article(i, title='標題', content='內文', doc_id=None):
    import hashlib as _hl
    return {
        'id': doc_id or _hl.md5(str(i).encode()).hexdigest()[:20],   # 與正式 id 同為 hex
        'title': f'{title}{i}', 'content': content,
        'link': f'https://example.com/{i}', 'pubDate': datetime.datetime(2026, 7, 1, tzinfo=TZ_UTC),
        'sentiment': 'neutral', 'cat': 'transcend', 'brand': None,
        'sourceName': 'src', 'mediaName': 'media', 'rawAuthor': '',
        'fetchedAt': datetime.datetime.now(TZ_UTC), 'fetchMode': 'all',
    }


class TestArticleContentHash(unittest.TestCase):
    def test_stable_for_same_content(self):
        a, b = _mk_article(1), _mk_article(1)
        b['fetchedAt'] = datetime.datetime(2030, 1, 1, tzinfo=TZ_UTC)   # 非內容欄位
        b['fetchMode'] = 'different'
        self.assertEqual(fetch_news.article_content_hash(a),
                         fetch_news.article_content_hash(b))

    def test_changes_when_content_changes(self):
        a, b = _mk_article(1), _mk_article(1)
        b['content'] = '更新後的內文'
        self.assertNotEqual(fetch_news.article_content_hash(a),
                            fetch_news.article_content_hash(b))

    def test_push_count_participates(self):
        a, b = _mk_article(1), _mk_article(1)
        b['pushCount'] = 99
        self.assertNotEqual(fetch_news.article_content_hash(a),
                            fetch_news.article_content_hash(b))


class TestSaveNewArticlesDedup(unittest.TestCase):
    """核心保證：相同文章連續執行兩次，第二次不得產生任何寫入"""

    def setUp(self):
        self.db = FakeDB()
        self.now = datetime.datetime(2026, 7, 15, 9, 0, tzinfo=TZ_UTC)

    def test_first_run_writes_all(self):
        arts = [_mk_article(i) for i in range(5)]
        stats = fetch_news.save_new_articles(self.db, arts, now=self.now)
        self.assertEqual(stats, {'added': 5, 'updated': 0, 'skipped': 0})
        self.assertEqual(self.db.news_doc_count(), 5)

    def test_second_run_same_articles_writes_nothing(self):
        arts = [_mk_article(i) for i in range(5)]
        fetch_news.save_new_articles(self.db, arts, now=self.now)
        writes_after_first = self.db.writes
        stats = fetch_news.save_new_articles(self.db, arts, now=self.now)
        self.assertEqual(stats, {'added': 0, 'updated': 0, 'skipped': 5})
        self.assertEqual(self.db.writes, writes_after_first,
                         '第二次執行不得有任何 Firestore 寫入（含索引）')

    def test_changed_article_is_updated_others_skipped(self):
        arts = [_mk_article(i) for i in range(5)]
        fetch_news.save_new_articles(self.db, arts, now=self.now)
        arts[2] = dict(arts[2], content='內容更新了')
        stats = fetch_news.save_new_articles(self.db, arts, now=self.now)
        self.assertEqual(stats, {'added': 0, 'updated': 1, 'skipped': 4})
        self.assertEqual(self.db.store[f"news/{arts[2]['id']}"]['content'], '內容更新了')

    def test_skipped_article_fetchedAt_not_refreshed(self):
        arts = [_mk_article(0)]
        doc_path = f"news/{arts[0]['id']}"
        fetch_news.save_new_articles(self.db, arts, now=self.now)
        original = self.db.store[doc_path]['fetchedAt']
        later = [dict(_mk_article(0), fetchedAt=datetime.datetime(2030, 1, 1, tzinfo=TZ_UTC))]
        fetch_news.save_new_articles(self.db, later, now=self.now)
        self.assertEqual(self.db.store[doc_path]['fetchedAt'], original,
                         '未變更文章的 fetchedAt 不得被刷新')

    def test_batch_chunking_over_400(self):
        arts = [_mk_article(i) for i in range(950)]
        fetch_news.save_new_articles(self.db, arts, now=self.now)
        self.assertEqual(self.db.news_doc_count(), 950)
        self.assertEqual(self.db.batch_commits, 3, '950 筆應分 400/400/150 三批')

    def test_index_pruned_after_retention(self):
        # 兩篇文章刻意放同一分片（id 開頭同字元），驗證保留期瘦身
        a_old = _mk_article(0, doc_id='a' + '0' * 19)
        a_new = _mk_article(1, doc_id='a' + '1' * 19)
        shard = f"meta/{fetch_news._shard_doc_id(a_old['id'])}"
        fetch_news.save_new_articles(self.db, [a_old], now=self.now)
        old_now = self.now + datetime.timedelta(days=fetch_news.NEWS_INDEX_RETENTION_DAYS + 1)
        fetch_news.save_new_articles(self.db, [a_new], now=old_now)
        hashes = self.db.store[shard]['hashes']
        self.assertNotIn(a_old['id'], hashes, '超過保留期的索引條目應被清除')
        self.assertIn(a_new['id'], hashes)

    # ── Codex 複查新增：索引讀取失敗必須中止、不得覆蓋索引 ──────
    def test_index_read_failure_aborts_without_any_write(self):
        self.db.store['meta/existing'] = {'x': 1}
        self.db.fail_get_paths.add('meta/newsIndex')
        with self.assertRaises(RuntimeError):
            fetch_news.save_new_articles(self.db, [_mk_article(0)], now=self.now)
        self.assertEqual(self.db.news_doc_count(), 0, '索引讀取失敗時不得寫入任何文章')
        self.assertEqual(self.db.writes, 0, '索引讀取失敗時不得有任何寫入（含覆蓋索引）')

    # ── Codex 複查新增：並行更新索引不得 lost-update ──────────────
    def test_txn_merge_preserves_entries_written_by_other_job(self):
        art = _mk_article(0, doc_id='b' + '0' * 19)
        shard = f"meta/{fetch_news._shard_doc_id(art['id'])}"
        # 模擬 community_job 已寫入同分片的另一條目（在本 job 讀索引之後）
        other_id = 'b' + 'f' * 19
        self.db.store[shard] = {'hashes': {other_id: {'h': 'xxxx', 't': '20260714'}}}
        fetch_news.save_new_articles(self.db, [art], now=self.now)
        hashes = self.db.store[shard]['hashes']
        self.assertIn(other_id, hashes, '其他 job 的索引條目不得被蓋掉（lost update）')
        self.assertIn(art['id'], hashes)

    def test_news_and_community_sequential_updates_both_persist(self):
        news_art = _mk_article(0, doc_id='c' + '0' * 19)
        comm_art = _mk_article(1, doc_id='c' + '1' * 19)   # 同分片
        fetch_news.save_new_articles(self.db, [news_art], now=self.now)
        fetch_news.save_new_articles(self.db, [comm_art], now=self.now)
        # 兩者都在索引中：重跑各自 job 都應 skipped，不重寫
        s1 = fetch_news.save_new_articles(self.db, [news_art], now=self.now)
        s2 = fetch_news.save_new_articles(self.db, [comm_art], now=self.now)
        self.assertEqual((s1['skipped'], s2['skipped']), (1, 1))

    def test_index_updates_go_through_transaction(self):
        fetch_news.save_new_articles(self.db, [_mk_article(0)], now=self.now)
        self.assertGreater(self.db.txn_count, 0, '索引回寫必須走 transaction')

    # ── Codex 複查新增：分片與大小保護 ───────────────────────────
    def test_shard_doc_id_mapping(self):
        self.assertEqual(fetch_news._shard_doc_id('abc'), 'newsIndex_a')
        self.assertEqual(fetch_news._shard_doc_id('F00'), 'newsIndex_f')
        self.assertEqual(fetch_news._shard_doc_id('zzz'), 'newsIndex_0')  # 非 hex fallback
        self.assertEqual(fetch_news._shard_doc_id(''), 'newsIndex_0')

    def test_shard_hard_cap_keeps_newest(self):
        with unittest.mock.patch.object(fetch_news, 'NEWS_INDEX_MAX_ENTRIES_PER_SHARD', 3):
            shard = 'meta/newsIndex_d'
            self.db.store[shard] = {'hashes': {
                f'd{i}': {'h': 'h', 't': f'2026070{i}'} for i in range(1, 4)   # d1..d3
            }}
            art = _mk_article(9, doc_id='d' + '9' * 19)
            fetch_news.save_new_articles(self.db, [art], now=self.now)
            hashes = self.db.store[shard]['hashes']
            self.assertEqual(len(hashes), 3, '超過硬上限時分片必須被裁切')
            self.assertIn(art['id'], hashes, '裁切須保留最新條目')
            self.assertNotIn('d1', hashes, '裁切須淘汰最舊條目')


class TestLeaseLock(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.now = datetime.datetime(2026, 7, 15, 9, 0, tzinfo=TZ_UTC)

    def test_is_lock_expired_pure(self):
        self.assertTrue(fetch_news.is_lock_expired(None, self.now))
        self.assertTrue(fetch_news.is_lock_expired({}, self.now))
        self.assertTrue(fetch_news.is_lock_expired(
            {'expiresAt': self.now - datetime.timedelta(seconds=1)}, self.now))
        self.assertFalse(fetch_news.is_lock_expired(
            {'expiresAt': self.now + datetime.timedelta(minutes=5)}, self.now))

    def test_acquire_returns_unique_token(self):
        t1 = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        self.assertIsInstance(t1, str)
        fetch_news.release_lock(self.db, 'news', t1)
        t2 = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        self.assertNotEqual(t1, t2, '每次持鎖必須產生唯一 owner token')

    def test_second_acquire_blocked_while_held(self):
        self.assertIsNotNone(fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now))
        self.assertIsNone(fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10,
                                                  now=self.now + datetime.timedelta(minutes=1)),
                          '鎖仍有效時，重複執行必須被擋下')

    def test_expired_lock_taken_over_in_transaction(self):
        fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        later = self.now + datetime.timedelta(minutes=11)
        txn_before = self.db.txn_count
        token = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=later)
        self.assertIsNotNone(token, '過期鎖（前次異常中止）必須可被接管')
        self.assertGreater(self.db.txn_count, txn_before, '接管必須在 transaction 內完成')

    def test_double_takeover_only_one_wins(self):
        """兩個執行個體同時對過期鎖接管：transaction 重讀最新狀態，僅一個成功"""
        fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        later = self.now + datetime.timedelta(minutes=11)   # 原鎖已過期
        token_a = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=later)
        token_b = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=later)
        self.assertIsNotNone(token_a, '先提交者接管成功')
        self.assertIsNone(token_b, '後提交者在 txn 內看到新鎖（未過期），必須失敗')

    def test_old_owner_cannot_delete_new_owner_lock(self):
        """舊執行者逾時後鎖被接管，其 finally 的 release 不得刪掉接管者的鎖"""
        stale_token = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        later = self.now + datetime.timedelta(minutes=11)
        new_token = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=later)
        released = fetch_news.release_lock(self.db, 'news', stale_token)
        self.assertFalse(released, '舊 token 的 release 必須失敗')
        self.assertIn('meta/lock_news', self.db.store, '接管者的鎖必須仍然存在')
        self.assertEqual(self.db.store['meta/lock_news']['owner'], new_token)
        self.assertTrue(fetch_news.release_lock(self.db, 'news', new_token),
                        '接管者本人的 release 必須成功')

    def test_release_with_none_token_is_noop(self):
        fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        self.assertFalse(fetch_news.release_lock(self.db, 'news', None))
        self.assertIn('meta/lock_news', self.db.store)

    def test_release_allows_reacquire(self):
        token = fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now)
        self.assertTrue(fetch_news.release_lock(self.db, 'news', token))
        self.assertIsNotNone(fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now))

    def test_locks_are_independent_by_name(self):
        self.assertIsNotNone(fetch_news.acquire_lock(self.db, 'news', ttl_minutes=10, now=self.now))
        self.assertIsNotNone(fetch_news.acquire_lock(self.db, 'finance', ttl_minutes=10, now=self.now))


class TestFetchSourceTimeout(unittest.TestCase):
    def test_rss_fetched_via_requests_with_timeout(self):
        fake_resp = types.SimpleNamespace(content=b'<rss></rss>')
        with unittest.mock.patch.object(fetch_news.requests, 'get',
                                        return_value=fake_resp) as mget, \
             unittest.mock.patch.object(fetch_news.feedparser, 'parse',
                                        return_value=types.SimpleNamespace(entries=[])):
            fetch_news.fetch_source({'label': 't', 'url': 'https://x.test/rss', 'cat': 'transcend'})
        _, kwargs = mget.call_args
        self.assertEqual(kwargs.get('timeout'), fetch_news.RSS_TIMEOUT,
                         'RSS 抓取必須帶 timeout，避免單一來源卡死排程')


class TestMaterialNews(unittest.TestCase):
    """創見與競品重大訊息：日期正規化 + 累積合併（只留重訊）"""

    def test_material_date_to_iso(self):
        self.assertEqual(fetch_news.material_date_to_iso('1150717'), '2026-07-17')   # 民國緊湊
        self.assertEqual(fetch_news.material_date_to_iso('115/07/17'), '2026-07-17') # 民國斜線
        self.assertEqual(fetch_news.material_date_to_iso('20260717'), '2026-07-17')  # 西元緊湊
        self.assertEqual(fetch_news.material_date_to_iso('2026-07-17'), '2026-07-17')
        self.assertEqual(fetch_news.material_date_to_iso(''), '')
        self.assertEqual(fetch_news.material_date_to_iso('garbage'), '')

    def _rec(self, code, date, summary, source='TWSE'):
        return {'code': code, 'date': date, 'summary': summary, 'source': source}

    def test_merge_purges_legacy_non_material_records(self):
        """舊時代混入的新聞/股民評論（無 source 標記）必須被清除"""
        legacy = [{'code': '2451', 'date': '2026-04-17', 'summary': '焦點股》宇瞻Q1獲利驚人'},
                  {'code': '4973', 'date': '2026-04-15', 'summary': '終於把出息賣壓甩掉了'}]
        merged, changed = fetch_news.merge_material_records(legacy, [])
        self.assertEqual(merged, [], '無 source 的舊紀錄應全部清除')
        self.assertTrue(changed)

    def test_merge_accumulates_daily_records(self):
        day1 = [self._rec('2451', '2026-07-17', '召開法人說明會')]
        merged, _ = fetch_news.merge_material_records([], day1)
        day2 = [self._rec('3260', '2026-07-18', '董事會決議股利分派', source='TPEX')]
        merged, changed = fetch_news.merge_material_records(merged, day2)
        self.assertEqual(len(merged), 2, '每日資料必須累積，不得整批覆蓋')
        self.assertTrue(changed)
        self.assertEqual(merged[0]['date'], '2026-07-18', '需依日期新→舊排序')

    def test_merge_dedupes_same_announcement(self):
        rec = self._rec('2451', '2026-07-17', '召開法人說明會')
        merged, _ = fetch_news.merge_material_records([], [rec])
        merged2, changed = fetch_news.merge_material_records(merged, [dict(rec)])
        self.assertEqual(len(merged2), 1, '同一則重訊重跑不得重複')
        self.assertFalse(changed, '無新增時不應標記為有變更')

    def test_merge_respects_cap(self):
        many = [self._rec('2451', f'2026-01-{(i % 28) + 1:02d}', f'重訊{i}') for i in range(600)]
        merged, _ = fetch_news.merge_material_records([], many, cap=500)
        self.assertEqual(len(merged), 500)


if __name__ == '__main__':
    unittest.main()
