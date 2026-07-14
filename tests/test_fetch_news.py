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


if __name__ == '__main__':
    unittest.main()
