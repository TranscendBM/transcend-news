"""press_release_match：保守配對規則（純函式，完全離線）"""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import press_release_match as pm  # noqa: E402


def pr(pid, title, day=None, **extra):
    base = {'id': pid, 'title': title, 'scheduledDate': day, 'keywords': [], 'status': 'unknown', 'active': True}
    base.update(extra)
    return pm.prepare_press_release(base)


def ex(title, day, **extra):
    return {'title': title, 'day': date.fromisoformat(day) if day else None, 'link': '', 'campaignId': '', **extra}


class TestNormalization(unittest.TestCase):
    def test_nfkc_case_whitespace_and_edge_punctuation(self):
        self.assertEqual(pm.normalize_title('  ＤＤＲ５　7200 ！ '), 'ddr5 7200')
        self.assertEqual(pm.normalize_title('「創見 ECM」。'), '創見 ecm')

    def test_numbers_months_quarters_models_are_kept(self):
        for text in ('7月營收', '2026 Q1', 'DDR5 7200', '64GB 6400MT/s'):
            normalized = pm.normalize_title(text)
            self.assertTrue(any(c.isdigit() for c in normalized), text)
        self.assertNotEqual(pm.normalize_title('7月營收'), pm.normalize_title('8月營收'))
        self.assertNotEqual(pm.normalize_title('DDR5 7200'), pm.normalize_title('DDR5 6400'))

    def test_period_signatures(self):
        self.assertEqual(pm.period_signatures('創見7月營收創新高')['month'], frozenset({'7'}))
        self.assertEqual(pm.period_signatures('2026 Q1 財報')['quarter'], frozenset({'2026q1'}))
        self.assertEqual(pm.period_signatures('第三季獲利')['quarter'], frozenset({'q3'}))
        self.assertEqual(pm.period_signatures('創見推出新品'), {})

    def test_url_normalization(self):
        a = pm.normalize_url('https://www.transcend-info.com/Press/abc/?utm_source=x#top')
        b = pm.normalize_url('http://transcend-info.com/Press/abc')
        self.assertEqual(a, b)
        self.assertEqual(pm.normalize_url('https://transcend-info.com/'), '')   # 只有網域不算
        self.assertEqual(pm.normalize_url(''), '')


class TestMatchRules(unittest.TestCase):
    def test_explicit_id_wins(self):
        prs = [pr('pr_1', '完全不同的標題', '2026-03-01', explicitPressReleaseId='PR-2026-007')]
        r = pm.match_exposure(ex('隨便一個標題', '2026-03-02', campaignId='pr-2026-007'), prs)
        self.assertEqual((r['matchStatus'], r['matchMethod'], r['pressReleaseId']), ('auto_matched', 'explicit_id', 'pr_1'))

    def test_official_url_match(self):
        prs = [pr('pr_1', '標題 A', '2026-03-01', officialUrl='https://transcend-info.com/press/a'),
               pr('pr_2', '標題 B', '2026-03-01', officialUrl='https://transcend-info.com/press/b')]
        r = pm.match_exposure(ex('完全不相關的媒體標題', '2026-05-01', link='https://www.transcend-info.com/press/b/?utm_campaign=z'), prs)
        self.assertEqual((r['matchMethod'], r['pressReleaseId']), ('official_url', 'pr_2'))

    def test_exact_normalized_title(self):
        prs = [pr('pr_1', 'COMPUTEX 2026 創見展出 AI 儲存方案', '2026-06-02')]
        r = pm.match_exposure(ex('ＣＯＭＰＵＴＥＸ 2026 創見展出 AI 儲存方案！', '2026-06-03'), prs)
        self.assertEqual((r['matchStatus'], r['matchMethod']), ('auto_matched', 'exact_title'))

    def test_repeated_generic_title_uses_date_and_never_picks_arbitrarily(self):
        prs = [pr('a', '營收新聞稿', '2026-02-06'), pr('b', '營收新聞稿', '2026-03-04')]
        r = pm.match_exposure(ex('營收新聞稿', '2026-03-05'), prs)
        self.assertEqual(r['pressReleaseId'], 'b')
        tie = pm.match_exposure(ex('營收新聞稿', '2026-02-20'), [pr('a', '營收新聞稿', '2026-02-19'), pr('b', '營收新聞稿', '2026-02-21')])
        self.assertEqual(tie['matchStatus'], 'unmatched')
        self.assertIsNone(tie['pressReleaseId'])
        self.assertIsNone(tie['suggestedPressReleaseId'])

    def test_date_plus_keyword_high_confidence(self):
        prs = [pr('p1', 'RDE3 + USD710S', '2026-01-21')]
        r = pm.match_exposure(ex('創見推出 RDE3 與 USD710S 車用隨身碟', '2026-01-22'), prs)
        self.assertEqual((r['matchStatus'], r['matchMethod'], r['pressReleaseId']), ('auto_matched', 'date_keyword', 'p1'))

    def test_same_day_two_products_do_not_cross_match(self):
        prs = [pr('p1', 'RDE3 + USD710S', '2026-01-21'), pr('p2', 'DDR5 7200 電競記憶體', '2026-01-21')]
        r1 = pm.match_exposure(ex('創見 RDE3 與 USD710S 登場', '2026-01-21'), prs)
        r2 = pm.match_exposure(ex('創見 DDR5 7200 電競記憶體上市', '2026-01-21'), prs)
        self.assertEqual(r1['pressReleaseId'], 'p1')
        self.assertEqual(r2['pressReleaseId'], 'p2')
        unrelated = pm.match_exposure(ex('創見董事長談產業趨勢', '2026-01-21'), prs)
        self.assertNotEqual(unrelated['matchStatus'], 'auto_matched')

    def test_date_alone_never_matches(self):
        prs = [pr('p1', '智慧製造展', '2026-04-01')]
        r = pm.match_exposure(ex('創見榮獲永續設計獎', '2026-04-01'), prs)
        self.assertEqual(r['matchStatus'], 'unmatched')

    def test_model_numbers_are_not_interchangeable(self):
        prs = [pr('p1', 'DDR5 7200 電競記憶體', '2026-05-10')]
        r = pm.match_exposure(ex('創見 DDR5 6400 電競記憶體上市', '2026-05-11'), prs)
        self.assertNotEqual(r['matchStatus'], 'auto_matched')
        self.assertIsNone(r['pressReleaseId'])

    def test_month_revenue_isolation(self):
        prs = [pr('jul', '7月營收', '2026-08-06'), pr('aug', '8月營收', '2026-09-04')]
        r = pm.match_exposure(ex('創見8月營收年增創高', '2026-09-05'), prs)
        self.assertEqual(r['pressReleaseId'], 'aug')
        wrong_month = pm.match_exposure(ex('創見9月營收年增創高', '2026-10-05'), prs)
        self.assertIsNone(wrong_month['pressReleaseId'])
        self.assertIsNone(wrong_month['suggestedPressReleaseId'])
        # 7月的新聞稿不能被 8 月的報導拿去用，即使日期剛好在範圍內
        near = pm.match_exposure(ex('創見7月營收', '2026-09-05'), [pr('aug', '8月營收', '2026-09-04')])
        self.assertIsNone(near['pressReleaseId'])
        self.assertIsNone(near['suggestedPressReleaseId'])

    def test_quarter_isolation(self):
        prs = [pr('q1', '2026 Q1 財報', '2026-05-12'), pr('q3', '2026 Q3 財報', '2026-11-12')]
        r = pm.match_exposure(ex('創見 2026 Q3 財報獲利創高', '2026-11-13'), prs)
        self.assertEqual(r['pressReleaseId'], 'q3')
        r = pm.match_exposure(ex('創見 2026 Q2 財報', '2026-08-13'), prs)
        self.assertIsNone(r['pressReleaseId'])

    def test_ecm_vs_ecm_with_housing_is_not_auto_confirmed(self):
        prs = [pr('ecm', 'ECM', '2026-04-15'), pr('ecmh', 'ECM with Housing', None)]
        r = pm.match_exposure(ex('創見 ECM with Housing 工控新品', '2026-04-16'), prs)
        self.assertNotEqual(r['matchStatus'], 'auto_matched')
        self.assertEqual(r['suggestedPressReleaseId'], 'ecmh')

    def test_date_missing_or_month_only_never_high_confidence(self):
        prs = [pr('p1', 'RDE3 + USD710S', None)]
        r = pm.match_exposure(ex('創見推出 RDE3 與 USD710S 車用隨身碟', '2026-01-22'), prs)
        self.assertNotEqual(r['matchStatus'], 'auto_matched')
        r = pm.match_exposure(ex('創見推出 RDE3 與 USD710S 車用隨身碟', None), [pr('p1', 'RDE3 + USD710S', '2026-01-21')])
        self.assertNotEqual(r['matchStatus'], 'auto_matched')

    def test_similarity_only_suggests(self):
        prs = [pr('p1', '創見嵌入式展 embedded world 2026 參展新品', '2026-03-10')]
        r = pm.match_exposure(ex('創見參展 embedded world 2026 展出新品', '2026-03-30'), prs)
        self.assertEqual(r['matchStatus'], 'suggested')
        self.assertIsNone(r['pressReleaseId'])
        self.assertEqual(r['suggestedPressReleaseId'], 'p1')
        self.assertLess(r['matchConfidence'], 1)

    def test_equal_candidates_are_not_picked(self):
        prs = [pr('a', '創見 AI 儲存方案發表', '2026-06-02'), pr('b', '創見 AI 儲存方案發表', '2026-06-03')]
        r = pm.match_exposure(ex('創見 AI 儲存方案發表會', '2026-06-05'), prs)
        self.assertIsNone(r['pressReleaseId'])
        self.assertIsNone(r['suggestedPressReleaseId'])

    def test_generic_revenue_press_release_matches_previous_month_revenue_only(self):
        prs = [pr('r3', '營收新聞稿', '2025-03-06'), pr('r5', '營收新聞稿', '2025-05-08'), pr('r8', '營收新聞稿', '2025-08-07')]
        r = pm.match_exposure(ex('創見2月營收創同期新高', '2025-03-07'), prs)
        self.assertEqual((r['matchStatus'], r['pressReleaseId']), ('auto_matched', 'r3'))
        r = pm.match_exposure(ex('創見4月營收年增', '2025-05-09'), prs)
        self.assertEqual(r['pressReleaseId'], 'r5')
        # 月份對不上就不配對：5/8 發的是 4 月營收，不能被 7 月營收的報導拿走
        r = pm.match_exposure(ex('創見7月營收年增', '2025-05-09'), prs)
        self.assertIsNone(r['pressReleaseId'])
        self.assertIsNone(r['suggestedPressReleaseId'])
        # 一般報導（沒有月份）不算營收新聞稿
        r = pm.match_exposure(ex('創見營收展望佳', '2025-05-09'), prs)
        self.assertIsNone(r['pressReleaseId'])

    def test_full_title_clause_quoted_by_media_matches(self):
        prs = [pr('e', '創見資訊參展2026台北國際電子產業科技展,展出嵌入式鏡頭與DDR5記憶體,拓展Edge AI應用', '2026-10-13', topic='電子展')]
        r = pm.match_exposure(ex('創見參加台北國際電子產業科技展 展出嵌入式鏡頭與DDR5記憶體', '2026-10-13'), prs)
        self.assertEqual((r['matchStatus'], r['pressReleaseId']), ('auto_matched', 'e'))
        r = pm.match_exposure(ex('創見搶攻邊緣 AI 嵌入式鏡頭、DDR5高速記憶體雙線出擊', '2026-10-13'), prs)
        # 同日＋創見＋嵌入式鏡頭＋DDR5：符合高信心規則（見 test_high_confidence_*）
        self.assertEqual((r['matchStatus'], r['matchMethod']), ('auto_matched', 'high_confidence_anchors'))

    def test_revenue_article_without_company_name_still_matches_by_month_and_date(self):
        prs = [pr('r9', '9月營收', '2026-10-06', topic='9月營收')]
        r = pm.match_exposure(ex('營收速報：9月營收60.4億元 年增290%', '2026-10-06'), prs)
        self.assertEqual(r['pressReleaseId'], 'r9')
        r = pm.match_exposure(ex('營收速報：8月營收48.4億元', '2026-10-06'), prs)
        self.assertIsNone(r['pressReleaseId'])

    def test_monthly_revenue_article_may_mention_quarter_but_quarterly_pr_needs_its_quarter(self):
        prs = [pr('r9', '9月營收', '2026-10-06', topic='9月營收'), pr('q3', '營收新聞稿 2026 Q3', '2026-11-05')]
        r = pm.match_exposure(ex('創見9月營收60.4億元 Q3營收大增291%', '2026-10-06'), prs)
        self.assertEqual(r['pressReleaseId'], 'r9')
        # 月營收報導不能配給季度新聞稿；也不能因為提到 Q3 就配到沒有月份的稿
        r = pm.match_exposure(ex('創見9月營收60.4億元 Q3營收大增291%', '2026-11-06'), [prs[1]])
        self.assertIsNone(r['pressReleaseId'])

    def test_competitor_led_article_is_not_a_press_release_derivative(self):
        prs = [pr('r9', '9月營收', '2026-10-06', topic='9月營收')]
        r = pm.match_exposure(ex('威剛9月營收年增2倍、Q3首破500億！創見前9月增370%創高', '2026-10-05'), prs)
        self.assertEqual(r['matchStatus'], 'unmatched')
        self.assertEqual(r['reason'], 'peer_led')
        r = pm.match_exposure(ex('創見9月營收年增290% 威剛衰退', '2026-10-06'), prs)
        self.assertEqual(r['matchStatus'], 'auto_matched')

    def test_generic_revenue_without_date_never_matches(self):
        r = pm.match_exposure(ex('創見4月營收年增', '2025-05-09'), [pr('r', '營收新聞稿', None)])
        self.assertNotEqual(r['matchStatus'], 'auto_matched')

    def test_model_number_only_title_can_match_by_date(self):
        prs = [pr('u', 'USD710S', '2025-09-24'), pr('e', 'ESD420', '2025-07-14')]
        r = pm.match_exposure(ex('創見推出 USD710S 隨身碟 通過軍規', '2025-09-25'), prs)
        self.assertEqual((r['matchStatus'], r['pressReleaseId']), ('auto_matched', 'u'))

    def test_single_keyword_event_is_only_suggested(self):
        prs = [pr('c', 'COMPUTEX', '2026-06-02')]
        r = pm.match_exposure(ex('創見亮相 COMPUTEX 展出 AI 儲存', '2026-06-03'), prs)
        self.assertEqual((r['matchStatus'], r['suggestedPressReleaseId']), ('suggested', 'c'))
        self.assertIsNone(r['pressReleaseId'])

    def test_short_topic_and_full_title_both_work_and_hyphenated_models_split(self):
        prs = [pr('d', '創見推出全系列DDR5-7200工業用記憶體模組，加速AI PC、邊緣運算與伺服器平台升級', '2026-08-20', topic='DDR5 7200'),
               pr('e', '創見推出64GB DDR5工業用記憶體，提升高速運算效能與系統穩定性', '2026-09-14', topic='DDR5 6400 64GB')]
        r = pm.match_exposure(ex('創見DDR5-7200工業記憶體搶攻AI與資料中心', '2026-08-22'), prs)
        self.assertEqual((r['matchStatus'], r['pressReleaseId']), ('auto_matched', 'd'))
        r = pm.match_exposure(ex('創見推出64GB DDR5工業用記憶體 提升高速運算效能與系統穩定性', '2026-09-15'), prs)
        self.assertEqual(r['pressReleaseId'], 'e')
        r = pm.match_exposure(ex('創見DDR5-6400工業記憶體登場', '2026-08-22'), prs)
        self.assertNotEqual(r['pressReleaseId'], 'd')

    def test_general_company_coverage_is_not_forced_into_a_press_release(self):
        prs = [pr('p1', 'DDR5 7200 電競記憶體', '2026-05-10')]
        r = pm.match_exposure(ex('創見資訊股價今日上漲', '2026-05-11'), prs)
        self.assertEqual(r['matchStatus'], 'unmatched')


HBR = '創見資訊董事長束崇萬再度榮獲2026《哈佛商業評論》「台灣企業領袖100強」肯定'
EXPO = '創見資訊參展2026台北國際電子產業科技展，展出嵌入式鏡頭與DDR5記憶體，拓展Edge AI應用'
D64 = '創見推出64GB DDR5工業用記憶體，提升高速運算效能與系統穩定性'


class TestHighConfidence(unittest.TestCase):
    """可解釋的高信心規則：同日／前後 1 天＋明確提到創見＋至少 2 個錨點＋候選唯一＋規格相容。"""

    def prs(self):
        return [pr('hbr', HBR, '2026-08-05', topic='2026《哈佛商業評論》「台灣企業領袖100強」肯定'),
                pr('expo', EXPO, '2026-10-13', topic='電子展'),
                pr('d64', D64, '2026-09-14', topic='DDR5 6400 64GB'),
                pr('d72', '創見推出全系列DDR5-7200工業用記憶體模組', '2026-08-20', topic='DDR5 7200'),
                pr('r7', '7月營收', '2026-08-06', topic='7月營收'), pr('r8', '8月營收', '2026-09-03', topic='8月營收')]

    def test_three_reported_cases_are_auto_matched_with_explainable_reasons(self):
        cases = [('創見搶攻邊緣 AI 嵌入式鏡頭、DDR5高速記憶體雙線出擊', '2026-10-13', 'expo', ('同日', '嵌入式鏡頭', 'DDR5')),
                 ('創見推64GB DDR5工業記憶體 搶攻邊緣AI應用', '2026-09-13', 'd64', ('前後 1 天', '64GB', 'DDR5', '工業記憶體')),
                 ('創見董事長束崇萬 再獲HBR台灣企業領袖100強', '2026-08-04', 'hbr', ('束崇萬', 'HBR', '台灣企業領袖100強'))]
        for title, day, expected, parts in cases:
            r = pm.match_exposure(ex(title, day), self.prs())
            self.assertEqual((r['matchStatus'], r['matchMethod'], r['pressReleaseId']), ('auto_matched', 'high_confidence_anchors', expected), title)
            self.assertGreaterEqual(r['matchConfidence'], 0.82)
            self.assertTrue(r['matchReason'].startswith(('同日＋創見＋', '前後 1 天＋創見＋')), r['matchReason'])
            for part in parts:
                self.assertIn(part, r['matchReason'])

    def test_mixed_stock_exhibition_article_stays_suggested(self):
        prs = [pr('auto', '創見資訊參展2026台北國際自動化工業大展， 聚焦AI視覺辨識應用', '2026-08-12', topic='自動化展')]
        r = pm.match_exposure(ex('創見業績爆表加上參加自動化展新品齊發 早盤股價急拉漲停', '2026-08-12'), prs)
        self.assertEqual(r['matchStatus'], 'suggested')
        self.assertIsNone(r['pressReleaseId'])
        self.assertIn('同時包含股價與多個事件內容', r['matchReason'])
        self.assertEqual(r['suggestedPressReleaseId'], 'auto')

    def test_date_must_be_same_day_or_one_day_apart(self):
        r = pm.match_exposure(ex('創見推64GB DDR5工業記憶體 搶攻邊緣AI應用', '2026-09-16'), self.prs())
        self.assertNotEqual(r['matchMethod'], 'high_confidence_anchors')
        r = pm.match_exposure(ex('創見推64GB DDR5工業記憶體 搶攻邊緣AI應用', '2026-09-15'), self.prs())
        self.assertEqual(r['pressReleaseId'], 'd64')

    def test_company_must_be_named(self):
        r = pm.match_exposure(ex('推64GB DDR5工業記憶體 搶攻邊緣AI應用', '2026-09-14'), self.prs())
        self.assertNotEqual(r['matchStatus'], 'auto_matched')

    def test_single_anchor_is_not_enough(self):
        r = pm.match_exposure(ex('創見最新動態 嵌入式鏡頭', '2026-10-13'), self.prs())
        self.assertNotEqual(r['matchMethod'], 'high_confidence_anchors')

    def test_speed_and_capacity_differences_are_never_ignored(self):
        r = pm.match_exposure(ex('創見推64GB DDR5-7200工業記憶體 搶攻邊緣AI', '2026-09-14'), self.prs())
        self.assertNotEqual(r['pressReleaseId'], 'd64')                      # 7200 不在這篇（6400）新聞稿裡
        r = pm.match_exposure(ex('創見推32GB DDR5工業記憶體 搶攻邊緣AI', '2026-09-14'), self.prs())
        self.assertNotEqual(r['pressReleaseId'], 'd64')                      # 32GB ≠ 64GB
        r = pm.match_exposure(ex('創見推DDR5-6400工業記憶體', '2026-08-20'), self.prs())
        self.assertNotEqual(r['pressReleaseId'], 'd72')                      # 7200 的新聞稿不能算給 6400
        r = pm.match_exposure(ex('創見推出全系列DDR5-7200工業記憶體', '2026-08-20'), self.prs())
        self.assertEqual(r['pressReleaseId'], 'd72')

    def test_month_and_quarter_must_match(self):
        r = pm.match_exposure(ex('創見7月營收年增308% 提前改寫全年紀錄', '2026-09-03'), self.prs())
        self.assertNotEqual(r['pressReleaseId'], 'r8')
        r = pm.match_exposure(ex('創見8月營收48.4億元 年增275%', '2026-09-03'), self.prs())
        self.assertEqual(r['pressReleaseId'], 'r8')
        q = [pr('q1', '2026 Q1 財報 EPS 18.93', '2026-05-06', topic='2026 Q1 財報')]
        r = pm.match_exposure(ex('創見 2026 Q3 財報 每股賺27.7元', '2026-05-06'), q)
        self.assertNotEqual(r['matchStatus'], 'auto_matched')

    def test_peer_led_comparison_and_anonymous_articles_are_never_auto(self):
        for title in ('威剛推出64GB DDR5工業記憶體 創見跟進 搶攻邊緣AI應用', '「模組廠」推64GB DDR5工業記憶體 搶攻邊緣AI應用',
                      '威剛與創見 64GB DDR5 工業記憶體齊發', '記憶體大廠這檔推64GB DDR5工業記憶體'):
            r = pm.match_exposure(ex(title, '2026-09-14'), self.prs())
            self.assertNotEqual(r['matchStatus'], 'auto_matched', title)

    def test_equal_candidates_are_not_picked(self):
        prs = [pr('a', '創見推出64GB DDR5工業用記憶體 A版', '2026-09-14', topic='DDR5 64GB'),
               pr('b', '創見推出64GB DDR5工業用記憶體 B版', '2026-09-14', topic='DDR5 64GB')]
        r = pm.match_exposure(ex('創見推64GB DDR5工業記憶體 搶攻邊緣AI', '2026-09-14'), prs)
        self.assertIsNone(r['pressReleaseId'])
        self.assertNotEqual(r['matchStatus'], 'auto_matched')

    def test_reasons_are_plain_chinese_without_technical_codes(self):
        prs = self.prs()
        titles = [('創見參展 embedded world 2026 展出工控新品', '2026-03-20'), ('創見董事長談產業', '2026-08-04'),
                  ('威剛9月營收創新高 創見跟進', '2026-09-04'), ('創見公告股東會重要決議', '2026-06-17')]
        for title, day in titles:
            r = pm.match_exposure(ex(title, day), prs)
            if r['matchStatus'] in ('unmatched', 'suggested'):
                self.assertTrue(r['matchReason'], title)
                self.assertNotRegex(r['matchReason'], r'ambiguous_|peer_led|no_anchor')
        unmatched = pm.match_exposure(ex('完全無關的新聞', '2026-03-20'), prs)
        self.assertIn('對不上', unmatched['matchReason'])
        peer = pm.match_exposure(ex('威剛9月營收創新高 創見跟進', '2026-09-04'), prs)
        self.assertIn('同業公司在標題前方', peer['matchReason'])

    def test_older_rules_now_carry_reasons_too(self):
        exact = pm.match_exposure(ex(HBR, '2026-08-06'), self.prs())
        self.assertEqual((exact['matchMethod'], exact['matchReason']), ('exact_title', '標題與新聞稿完全相同'))
        explicit = pm.match_exposure(ex('隨便', '2026-08-06', campaignId='X1'), [pr('p', 'T', '2026-08-06', explicitPressReleaseId='x1')])
        self.assertEqual(explicit['matchReason'], '新聞稿編號相同')



if __name__ == '__main__':
    unittest.main()
