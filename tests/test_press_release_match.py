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

    def test_competitor_only_revenue_article_is_not_counted(self):
        prs = [pr('r8', '8月營收', '2026-09-03')]
        r = pm.match_exposure(ex('威剛8月營收創歷史新高', '2026-09-04'), prs)
        self.assertNotEqual(r['matchStatus'], 'auto_matched')
        r = pm.match_exposure(ex('創見與威剛8月營收創歷史新高', '2026-09-04'), prs)
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

    def test_general_company_coverage_is_not_forced_into_a_press_release(self):
        prs = [pr('p1', 'DDR5 7200 電競記憶體', '2026-05-10')]
        r = pm.match_exposure(ex('創見資訊股價今日上漲', '2026-05-11'), prs)
        self.assertEqual(r['matchStatus'], 'unmatched')


if __name__ == '__main__':
    unittest.main()
