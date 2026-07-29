"""
functions/digest.py（DRAM/Flash 新聞摘要信件，Phase 1）單元測試 — 完全離線

外部套件（requests / feedparser / firebase_admin）在 import 前以 stub 取代；
send_email 一律 mock 掉，測試中不會真的連線 email.transcend-info.com。
"""

import datetime
import email
import email.header
import email.utils
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
import intelligence  # noqa: E402

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


# 純供應商/產業內容（不提及創見或任何競品），relevance/importance 已用
# intelligence.py 實際跑過驗證：
#   低重要性（importance=33，無 entities）
#   高重要性（importance=40，無 entities）
LOW_TITLE = '三星 SK海力士 HBM 記憶體 產能'
LOW_CONTENT = '三星 SK海力士 HBM 供應鏈 產能'
HIGH_TITLE = 'DRAM NAND 記憶體 儲存 市場需求'
HIGH_CONTENT = '記憶體 市場 需求 庫存'


class TestSelectDigestArticles(unittest.TestCase):
    def setUp(self):
        self.since = datetime.datetime(2026, 7, 20, 0, 0, tzinfo=TZ_UTC)

    def test_filters_out_articles_at_or_before_since(self):
        old = _mk_article(LOW_TITLE, LOW_CONTENT, pub_dt=self.since - datetime.timedelta(hours=1))
        at_boundary = _mk_article(LOW_TITLE + '邊界', LOW_CONTENT, pub_dt=self.since)
        new = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=self.since + datetime.timedelta(hours=1))
        result = digest.select_digest_articles([old, at_boundary, new], self.since)
        titles = [a['title'] for a, _ in result]
        self.assertEqual(titles, [HIGH_TITLE])

    def test_filters_out_irrelevant_articles(self):
        irrelevant = _mk_article('今天天氣真好', '跟產業無關的內容',
                                  pub_dt=self.since + datetime.timedelta(hours=1))
        result = digest.select_digest_articles([irrelevant], self.since)
        self.assertEqual(result, [])

    def test_excludes_competitor_mentions(self):
        after = self.since + datetime.timedelta(hours=1)
        competitor = _mk_article('威剛 3260 財報', '威剛 財報', pub_dt=after)
        result = digest.select_digest_articles([competitor], self.since)
        self.assertEqual(result, [], '競品公司新聞不應出現在這封信——已有前端競品動態分頁')

    def test_excludes_self_company_mentions(self):
        after = self.since + datetime.timedelta(hours=1)
        own = _mk_article('創見 財報 獲利', '創見 財報 獲利', pub_dt=after)
        result = digest.select_digest_articles([own], self.since)
        self.assertEqual(result, [], '創見自己的公司新聞不應出現在這封信——已有前端 PR 分頁')

    def test_keeps_pure_supplier_industry_news(self):
        after = self.since + datetime.timedelta(hours=1)
        supplier = _mk_article(LOW_TITLE, LOW_CONTENT, pub_dt=after)
        result = digest.select_digest_articles([supplier], self.since)
        self.assertEqual(len(result), 1)

    def test_sorted_by_importance_desc(self):
        after = self.since + datetime.timedelta(hours=1)
        low = _mk_article(LOW_TITLE, LOW_CONTENT, pub_dt=after)
        high = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=after)
        result = digest.select_digest_articles([low, high], self.since)
        titles = [a['title'] for a, _ in result]
        self.assertEqual(titles, [HIGH_TITLE, LOW_TITLE])

    def test_dedupes_near_identical_titles_keeping_highest_importance(self):
        after = self.since + datetime.timedelta(hours=1)
        # 同一則新聞被兩個不同來源/搜尋條件重複收錄，標題只差標點與空白
        dup_low = _mk_article(LOW_TITLE, LOW_CONTENT, pub_dt=after, link='https://a.example.com/1')
        dup_high_variant = _mk_article(
            LOW_TITLE.replace(' ', '，') + '！', LOW_CONTENT, pub_dt=after, link='https://b.example.com/2')
        result = digest.select_digest_articles([dup_low, dup_high_variant], self.since)
        self.assertEqual(len(result), 1, '正規化後標題相同的重複新聞應只保留一則')

    def test_distinct_titles_not_deduped(self):
        after = self.since + datetime.timedelta(hours=1)
        low = _mk_article(LOW_TITLE, LOW_CONTENT, pub_dt=after)
        high = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=after)
        result = digest.select_digest_articles([low, high], self.since)
        self.assertEqual(len(result), 2)

    def test_respects_limit(self):
        after = self.since + datetime.timedelta(hours=1)
        arts = [_mk_article(f'{HIGH_TITLE}{i}', HIGH_CONTENT, pub_dt=after) for i in range(5)]
        result = digest.select_digest_articles(arts, self.since, limit=2)
        self.assertEqual(len(result), 2)

    def test_missing_pubdate_excluded(self):
        bad = _mk_article(LOW_TITLE, LOW_CONTENT)
        bad['pubDate'] = None
        result = digest.select_digest_articles([bad], self.since)
        self.assertEqual(result, [])

    def test_empty_input(self):
        self.assertEqual(digest.select_digest_articles([], self.since), [])


class TestBuildDigestEmail(unittest.TestCase):
    def test_empty_items_message(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        subject, text_body, html_body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [], now=now)
        self.assertIn('2026-07-20', subject)
        self.assertIn('沒有符合條件', text_body)
        self.assertIn('沒有符合條件', html_body)

    def test_items_included_with_link_and_count(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, link='https://example.com/x')
        rules = intelligence.analyze_article_rules(article)
        subject, text_body, html_body = digest.build_digest_email(
            '台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertIn('共 1 則', subject)
        self.assertIn(HIGH_TITLE, text_body)
        self.assertIn('https://example.com/x', text_body)
        self.assertIn('https://example.com/x', html_body)
        self.assertIn(HIGH_TITLE, html_body)

    def test_html_includes_logo(self):
        subject, text_body, html_body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [])
        self.assertIn(digest.LOGO_URL, html_body)

    def test_footer_does_not_mention_api_cost(self):
        subject, text_body, html_body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [])
        self.assertNotIn('API', html_body)
        self.assertNotIn('API', text_body)

    def test_english_mode_subject_and_footer(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        subject, text_body, html_body = digest.build_digest_email(
            'US DRAM/Flash Industry News', [], now=now, lang='en')
        self.assertIn('2026-07-20', subject)
        self.assertIn('US DRAM/Flash Industry News', subject)
        self.assertNotIn('則', subject)
        self.assertNotIn('沒有符合條件', text_body)
        self.assertIn('No qualifying items', text_body)
        self.assertIn('No qualifying items', html_body)
        self.assertNotIn('創見新聞監控系統自動產生', html_body)
        self.assertIn('Automatically generated by Transcend News Monitor', html_body)

    def test_english_mode_item_summary_and_badge_are_english(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, link='https://example.com/x')
        rules = intelligence.analyze_article_rules(article)
        subject, text_body, html_body = digest.build_digest_email(
            'US DRAM/Flash Industry News', [(article, rules)], now=now, lang='en')
        self.assertIn('(1 items)', subject)
        self.assertIn('Source:', text_body)
        self.assertIn('Type:', text_body)
        self.assertNotIn('來源', text_body)
        # 此測試文章的 eventType 會判定為 supply_chain，英文版應顯示
        # "Supply Chain" 徽章，而非中文「供應鏈」
        self.assertIn('Supply Chain', html_body)
        self.assertNotIn('供應鏈', html_body)

    def test_font_family_repeated_on_every_element_for_outlook(self):
        """
        Outlook 桌面版（Word 引擎）不會把 body 上的 font-family 繼承到
        表格/div 裡，只寫在 body 一次會被忽略、退回內建中文預設字型。
        每個文字元素都要重複帶入同一組字型堆疊，這裡至少驗證：
        (1) 有新聞項目時，卡片本身也帶了字型設定，不是只有外層容器；
        (2) 出現次數夠多，代表不是只寫在 body 這一處。
        """
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT)
        rules = intelligence.analyze_article_rules(article)
        _, _, html_body = digest.build_digest_email(
            '台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        occurrences = html_body.count(digest.FONT_STACK)
        self.assertGreaterEqual(occurrences, 8,
                                '字型堆疊應重複出現在多個元素上（含新聞卡片本身），而非只寫在 body 上一次')

    def test_html_escapes_untrusted_title(self):
        """新聞標題來自外部 RSS，視為不可信資料，組 HTML 時必須跳脫。"""
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE + '<script>alert(1)</script>', HIGH_CONTENT)
        rules = intelligence.analyze_article_rules(article)
        _, _, html_body = digest.build_digest_email('台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertNotIn('<script>', html_body)
        self.assertIn('&lt;script&gt;', html_body)


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


class TestSendEmail(unittest.TestCase):
    """
    Mail2000 用 Send As：SMTP 認證帳號（elvis_cheng@）跟實際寄件地址
    （bm@，已由 IT 授權代理寄件）不同，這兩者容易在之後改動時被誤改成
    同一個值，這裡驗證 login/sendmail 各自用對帳號。
    """

    def test_login_uses_auth_account_and_from_uses_send_as_address(self):
        fake_server = MagicMock()
        fake_server.__enter__.return_value = fake_server
        with patch.object(digest.smtplib, 'SMTP', return_value=fake_server) as m_smtp:
            digest.send_email('主旨', '內文', '<p>內文</p>', ['bm@transcend-info.com'], 'fake-password')

        m_smtp.assert_called_once_with(digest.SMTP_HOST, digest.SMTP_PORT, timeout=30)
        fake_server.starttls.assert_called_once()
        fake_server.login.assert_called_once_with(digest.DIGEST_SMTP_AUTH_USER, 'fake-password')
        args, _ = fake_server.sendmail.call_args
        from_addr, to_addrs, raw_message = args
        self.assertEqual(from_addr, digest.DIGEST_SENDER_ADDR,
                         'sendmail envelope From 必須是已授權 Send As 的地址，不是認證帳號')
        self.assertEqual(to_addrs, ['bm@transcend-info.com'])
        parsed = email.message_from_string(raw_message)
        display_name, addr = email.utils.parseaddr(str(email.header.make_header(
            email.header.decode_header(parsed['From']))))
        self.assertEqual(display_name, digest.DIGEST_SENDER_NAME)
        self.assertEqual(addr, digest.DIGEST_SENDER_ADDR)


class TestRunDigest(unittest.TestCase):
    def test_sends_email_and_advances_checkpoint_on_success(self):
        db = FakeDB(news=[_mk_article(HIGH_TITLE, HIGH_CONTENT,
                                       pub_dt=datetime.datetime.now(TZ_UTC))])
        with patch.object(digest, 'send_email') as msend:
            result = digest.run_digest(db, 'tw', 'fake-app-password')
        msend.assert_called_once()
        self.assertEqual(result['count'], 1)
        # checkpoint 應已推進到接近現在，下次執行不會重複寄送同一則
        new_since = digest.get_last_digest_time(db, 'tw')
        self.assertGreater(new_since, datetime.datetime.now(TZ_UTC) - datetime.timedelta(minutes=1))

    def test_checkpoint_not_advanced_when_send_fails(self):
        db = FakeDB(news=[_mk_article(HIGH_TITLE, HIGH_CONTENT,
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
