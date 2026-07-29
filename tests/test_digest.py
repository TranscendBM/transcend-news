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


class TestSafeArticleUrl(unittest.TestCase):
    """
    新聞連結來自不可信的外部 RSS。只允許 http/https 進入信件，
    避免 javascript:／data:／file: 等 scheme 被當成可點擊連結
    （等同信件內 XSS／本機檔案存取）。
    """

    def test_allows_https(self):
        self.assertEqual(digest._safe_article_url('https://example.com/a'), 'https://example.com/a')

    def test_allows_http(self):
        self.assertEqual(digest._safe_article_url('http://example.com/a'), 'http://example.com/a')

    def test_rejects_javascript_scheme(self):
        self.assertIsNone(digest._safe_article_url('javascript:alert(1)'))

    def test_rejects_data_scheme(self):
        self.assertIsNone(digest._safe_article_url('data:text/html,<script>alert(1)</script>'))

    def test_rejects_file_scheme(self):
        self.assertIsNone(digest._safe_article_url('file:///etc/passwd'))

    def test_rejects_control_characters(self):
        self.assertIsNone(digest._safe_article_url('https://example.com/\n\x00evil'))

    def test_rejects_empty_blank_or_none(self):
        self.assertIsNone(digest._safe_article_url(''))
        self.assertIsNone(digest._safe_article_url(None))
        self.assertIsNone(digest._safe_article_url('   '))

    def test_rejects_scheme_relative_and_unknown_scheme(self):
        self.assertIsNone(digest._safe_article_url('//evil.example.com/x'))
        self.assertIsNone(digest._safe_article_url('ftp://example.com/x'))


class TestBuildDigestEmailUnsafeLinks(unittest.TestCase):
    def test_javascript_link_not_rendered_as_anchor_or_text(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, link='javascript:alert(1)')
        rules = intelligence.analyze_article_rules(article)
        _, text_body, html_body = digest.build_digest_email(
            '台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertNotIn('javascript:', html_body)
        self.assertNotIn('javascript:', text_body)
        self.assertNotIn('<a href', html_body, '無效網址不應建立 <a> 連結，只顯示標題')
        self.assertIn(HIGH_TITLE, html_body)

    def test_data_scheme_link_not_rendered(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, link='data:text/html,<script>x</script>')
        rules = intelligence.analyze_article_rules(article)
        _, text_body, html_body = digest.build_digest_email(
            '台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertNotIn('data:text/html', html_body)
        self.assertNotIn('data:text/html', text_body)
        self.assertNotIn('<a href', html_body)

    def test_safe_https_link_still_rendered(self):
        now = datetime.datetime(2026, 7, 20, 8, 0)
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, link='https://example.com/ok')
        rules = intelligence.analyze_article_rules(article)
        _, text_body, html_body = digest.build_digest_email(
            '台灣 DRAM/Flash 產業新聞', [(article, rules)], now=now)
        self.assertIn('https://example.com/ok', html_body)
        self.assertIn('https://example.com/ok', text_body)
        self.assertIn('<a href="https://example.com/ok"', html_body)


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


class TestDigestLookbackWindow(unittest.TestCase):
    def test_lookback_window_fixed_width(self):
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        since = digest.get_digest_lookback_since(now)
        self.assertEqual(now - since, datetime.timedelta(hours=digest.DIGEST_LOOKBACK_HOURS))

    def test_lookback_window_covers_weekend_schedule_gap(self):
        """週五 08:00/16:30 到週一同一時段的排程空檔是 72 小時，
        回溯窗口必須大於這個值，否則週一早上會漏掉週五的新聞。"""
        self.assertGreater(digest.DIGEST_LOOKBACK_HOURS, 72)


class TestSentArticleIds(unittest.TestCase):
    def test_no_record_defaults_to_empty(self):
        db = FakeDB()
        self.assertEqual(digest.get_sent_article_ids(db, 'tw'), {})

    def test_record_and_read_back(self):
        db = FakeDB()
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        digest.record_sent_articles(db, 'tw', ['a1', 'a2'], now=now)
        self.assertEqual(set(digest.get_sent_article_ids(db, 'tw')), {'a1', 'a2'})

    def test_tw_and_us_sent_ids_independent(self):
        db = FakeDB()
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        digest.record_sent_articles(db, 'tw', ['id-tw'], now=now)
        digest.record_sent_articles(db, 'us', ['id-us'], now=now)
        self.assertIn('id-tw', digest.get_sent_article_ids(db, 'tw'))
        self.assertNotIn('id-tw', digest.get_sent_article_ids(db, 'us'))
        self.assertIn('id-us', digest.get_sent_article_ids(db, 'us'))
        self.assertNotIn('id-us', digest.get_sent_article_ids(db, 'tw'))

    def test_sent_ids_pruned_by_retention_days(self):
        db = FakeDB()
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        digest.record_sent_articles(
            db, 'tw', ['old-1'],
            now=now - datetime.timedelta(days=digest.DIGEST_SENT_ID_RETENTION_DAYS + 1))
        digest.record_sent_articles(db, 'tw', ['new-1'], now=now)
        sent = digest.get_sent_article_ids(db, 'tw')
        self.assertNotIn('old-1', sent, '超過保留天數的已寄送紀錄應被裁切，不能無限增長')
        self.assertIn('new-1', sent)

    def test_sent_ids_pruned_by_max_entries(self):
        db = FakeDB()
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        many_ids = [f'id-{i}' for i in range(digest.DIGEST_SENT_ID_MAX_ENTRIES + 50)]
        digest.record_sent_articles(db, 'tw', many_ids, now=now)
        sent = digest.get_sent_article_ids(db, 'tw')
        self.assertLessEqual(len(sent), digest.DIGEST_SENT_ID_MAX_ENTRIES,
                              '已寄送 id 數量必須有硬上限，避免 checkpoint 文件無限增長')


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
    def test_sends_email_and_records_sent_ids_on_success(self):
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC))
        db = FakeDB(news=[article])
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        with patch.object(digest, 'send_email') as msend:
            result = digest.run_digest(db, 'tw', 'fake-app-password', now=now)
        msend.assert_called_once()
        self.assertEqual(result['count'], 1)
        sent = digest.get_sent_article_ids(db, 'tw')
        self.assertIn(digest._article_identity(article), sent,
                      '寄信成功後必須把文章 id 記入已寄送集合')

    def test_send_failure_does_not_mark_as_sent(self):
        """寄送失敗不標記為已寄出：下次執行必須能重新嘗試同一批候選文章。"""
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC))
        db = FakeDB(news=[article])
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        with patch.object(digest, 'send_email', side_effect=RuntimeError('smtp 掛了')):
            with self.assertRaises(RuntimeError):
                digest.run_digest(db, 'tw', 'fake-app-password', now=now)
        self.assertEqual(digest.get_sent_article_ids(db, 'tw'), {},
                         '寄信失敗時不得記錄已寄送，否則下次執行會永久漏掉這篇文章')

    def test_sent_article_not_resent_next_round(self):
        """成功寄出的文章下一輪不重複：同一天重跑或下一次排程都不能再選到它。"""
        article = _mk_article(HIGH_TITLE, HIGH_CONTENT, pub_dt=datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC))
        db = FakeDB(news=[article])
        t1 = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        with patch.object(digest, 'send_email'):
            result1 = digest.run_digest(db, 'tw', 'fake-app-password', now=t1)
        self.assertEqual(result1['count'], 1)

        t2 = t1 + datetime.timedelta(minutes=15)
        with patch.object(digest, 'send_email') as msend2:
            result2 = digest.run_digest(db, 'tw', 'fake-app-password', now=t2)
        msend2.assert_called_once()
        self.assertEqual(result2['count'], 0, '已成功寄出的文章不應在下一輪重複選中、重複寄出')

    def test_late_written_article_is_picked_up_next_round(self):
        """
        競態場景：news_job 在摘要查詢 Firestore「之後」才把一篇 pubDate
        較早的文章寫入。用寄信成功時間當游標的舊設計會讓這篇文章的
        pubDate 落在下次查詢起點之前，永遠不會再被選中；新設計用固定
        回溯窗口 + sentIds 判斷，只要還在窗口內就一定會在下一輪被選到。
        """
        db = FakeDB(news=[])
        t1 = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        with patch.object(digest, 'send_email'):
            result1 = digest.run_digest(db, 'tw', 'fake-app-password', now=t1)
        self.assertEqual(result1['count'], 0, '查詢當下 Firestore 裡還沒有這篇文章')

        # 模擬 news_job 在摘要查詢完成「之後」才寫入這篇文章；
        # pubDate 是它在 RSS 上的真實發布時間，比第一次執行的時間點還早。
        late_article = _mk_article(HIGH_TITLE, HIGH_CONTENT,
                                    pub_dt=t1 - datetime.timedelta(hours=1), cat='twMarket')
        db.news.append(late_article)

        t2 = t1 + datetime.timedelta(minutes=15)
        with patch.object(digest, 'send_email') as msend2:
            result2 = digest.run_digest(db, 'tw', 'fake-app-password', now=t2)
        msend2.assert_called_once()
        self.assertEqual(result2['count'], 1,
                         '查詢完成後才寫入的舊日期文章，下一輪仍必須被選中並寄出')

    def test_tw_and_us_digests_do_not_interfere(self):
        """台灣與美國摘要的 checkpoint 互相獨立：寄出 tw 不影響 us 的候選文章。"""
        tw_article = _mk_article(HIGH_TITLE, HIGH_CONTENT,
                                  pub_dt=datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC), cat='twMarket')
        us_article = _mk_article(HIGH_TITLE, HIGH_CONTENT,
                                  pub_dt=datetime.datetime(2026, 7, 20, 3, 0, tzinfo=TZ_UTC), cat='usMarket')
        db = FakeDB(news=[tw_article, us_article])
        now = datetime.datetime(2026, 7, 20, 8, 0, tzinfo=TZ_UTC)
        with patch.object(digest, 'send_email'):
            result_tw = digest.run_digest(db, 'tw', 'fake-app-password', now=now)
        with patch.object(digest, 'send_email') as msend_us:
            result_us = digest.run_digest(db, 'us', 'fake-app-password', now=now)
        self.assertEqual(result_tw['count'], 1)
        self.assertEqual(result_us['count'], 1, 'us 的候選文章不應被 tw 的 sentIds 誤擋下')
        msend_us.assert_called_once()


if __name__ == '__main__':
    unittest.main()
