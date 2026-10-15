"""coverage_classify：曝光分類規則（純函式，完全離線）"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import coverage_classify as cc  # noqa: E402


def cls(title, status='unmatched', **kw):
    return cc.classify_exposure({'title': title}, status, **kw)


class TestMatchDrivenRules(unittest.TestCase):
    def test_confirmed_is_press_release_derived(self):
        r = cls('隨便什麼標題', 'confirmed')
        self.assertEqual((r['coverageClass'], r['coverageClassMethod'], r['coverageClassConfidence']), ('press_release_derived', 'press_release_match', 1.0))
        self.assertEqual(r['coverageClassLabel'], '新聞稿衍生曝光')

    def test_auto_matched_is_press_release_derived(self):
        r = cls('創見9月營收60.4億元', 'auto_matched', match_confidence=0.88)
        self.assertEqual((r['coverageClass'], r['coverageClassMethod']), ('press_release_derived', 'press_release_match'))
        self.assertGreaterEqual(r['coverageClassConfidence'], cc.AUTO_MIN_CONFIDENCE)

    def test_suggested_is_review_never_derived(self):
        r = cls('創見董事長束崇萬再獲台灣企業領袖100強', 'suggested')
        self.assertEqual(r['coverageClass'], 'review')
        self.assertIn('suggested_match_unconfirmed', r['coverageClassReasons'])

    def test_ambiguous_press_release_features_go_to_review(self):
        r = cls('創見9月營收60.4億元', 'unmatched', match_reason='ambiguous_date_keyword')
        self.assertEqual(r['coverageClass'], 'review')
        self.assertIn('ambiguous_date_keyword', r['coverageClassReasons'])

    def test_result_carries_version_and_label(self):
        r = cls('創見推出新品')
        self.assertEqual(r['classificationVersion'], cc.CLASSIFICATION_VERSION)
        self.assertEqual(r['coverageClassLabel'], cc.CLASS_LABELS[r['coverageClass']])


class TestTextRules(unittest.TestCase):
    def check(self, title, expected, reason=None):
        r = cls(title)
        self.assertEqual(r['coverageClass'], expected, (title, r))
        if reason:
            self.assertIn(reason, r['coverageClassReasons'], title)
        return r

    def test_company_coverage_product_event_management_financials(self):
        for t in ('創見推出218層3D NAND工業級儲存解決方案', '創見參展COMPUTEX 2026 秀AI嵌入式、消費級存儲方案',
                  '創見董座束崇萬再獲 台灣企業領袖100強殊榮', '創見4月營收創高 年增近6倍', '創見 公告本公司115年股東常會重要決議事項',
                  '創見違反貿易法遭罰156萬元 已繳清罰鍰並著手改善', '創見喊記憶體續缺至2028年 群聯：短期漲幅難緩',
                  '創見：DRAM、Flash缺貨今年難解 三星報價，第二季DDR5價格較第一季仍上漲約40%至50%'):
            self.check(t, 'company_coverage')

    def test_management_statement_about_industry_is_still_company_coverage(self):
        self.check('創見看記憶體供不應求達1.5-2年，有利營收/毛利成長', 'company_coverage', 'management_statement')

    def test_single_company_stock_flash_is_company_coverage(self):
        self.check('盤中速報 - 創見(2451)大漲7.39%，報269元', 'company_coverage', 'single_company_stock')

    def test_shareholding_transfer_is_industry_related(self):
        self.check('個股：新門(5432)7/24取得創見股票400張，每股均價261.35元', 'industry_related', 'shareholding_transfer')
        self.check('新門9/3~10/6處分創見219張，獲利約497萬元', 'industry_related', 'shareholding_transfer')

    def test_index_rebalance_is_industry_related(self):
        self.check('9/17起「臺灣全市場半導體精選30指數」納台勝科、萬潤/刪創見、頎邦等', 'industry_related', 'index_rebalance')
        self.check('「二哥」、 緯創強勢入列！00900成分股大換血 「護國神山」竟被踢出', 'industry_related', 'index_rebalance')

    def test_memory_price_and_shortage_market_news_is_industry_related(self):
        self.check('記憶體缺貨衝擊 傳觸控MacBook Pro延至明年', 'industry_related')
        self.check('三星罷工18天 助攻台廠記憶體18檔', 'industry_related')

    def test_samsung_outsourcing_is_industry_related(self):
        self.check('三星傳統記憶體模組與 SSD 相關業務擬擴大委外 創見、宇瞻奪單呼聲高', 'industry_related')

    def test_competitor_comparison_is_industry_related(self):
        self.check('壹蘋新聞 AI帶動記憶體大爆發！威剛3月營收破百億 創見、十銓Q1齊創高', 'industry_related', 'peer_companies')
        self.check('威剛9月業績寫同期最佳 創見月增24%', 'industry_related')
        self.check('創見、宜鼎 需求升溫', 'industry_related')

    def test_multi_stock_lists_are_industry_related(self):
        self.check('《外資買超40-21》神基(411)、台新辛(409)、創見(406)', 'industry_related', 'multi_stock_list')

    def test_general_market_news_without_company_is_industry_related(self):
        self.check('看好台積電上3500！台股盤中跌逾6百點守45K', 'industry_related')

    def test_partner_company_does_not_make_it_industry(self):
        self.check('創見攜手研華，ECM301G2F嵌入式鏡頭模組整合至輝達Edge AI運算平台', 'company_coverage')

    def test_same_name_company_is_unrelated(self):
        r = self.check('創見文化事業推出新書發表會', 'unrelated', 'same_name_company')
        self.assertGreaterEqual(r['coverageClassConfidence'], 0.9)
        # 有記憶體／股票線索就不是同名公司
        self.assertNotEqual(cls('創見文化事業 創見(2451)記憶體')['coverageClass'], 'unrelated')

    def test_unclear_items_go_to_review_not_forced(self):
        for t in ('笑瘋！科技圈重要精神象徵 乖乖現身COMPUTEX爆紅', '記憶體價格走揚！「這檔」H1每股賺46.63元創同期新高',
                  ''):
            r = cls(t)
            self.assertEqual(r['coverageClass'], 'review', t)
            self.assertIn(r['coverageClassMethod'], ('fallback', 'rule'))

    def test_low_confidence_is_review(self):
        r = cls('某個標題很長但看不出和創見的關係 創見')
        self.assertIn(r['coverageClass'], ('review', 'company_coverage', 'industry_related'))
        if r['coverageClassConfidence'] < cc.AUTO_MIN_CONFIDENCE:
            self.assertEqual(r['coverageClass'], 'review')

    def test_numbers_are_not_normalised_away(self):
        # 分類只看文字，月份、季度、型號都留在原標題；不同月份的營收報導不會被誤判成同一類以外的東西
        for t in ('創見7月營收年增308%', '創見8月營收年增275%', '創見 2026 Q1 財報', '創見 DDR5 7200 與 DDR5 6400'):
            self.assertEqual(cls(t)['coverageClass'], 'company_coverage', t)

    def test_never_raises_on_odd_input(self):
        for t in (None, 123, '   ', '創見' * 500):
            cc.classify_exposure({'title': t}, 'unmatched')


class TestManualAndChange(unittest.TestCase):
    def test_manual_is_protected(self):
        self.assertTrue(cc.is_manual({'coverageClass': 'unrelated', 'coverageClassMethod': 'manual'}))
        self.assertFalse(cc.is_manual({'coverageClass': 'unrelated', 'coverageClassMethod': 'rule'}))
        self.assertFalse(cc.is_manual({'coverageClassMethod': 'manual'}))

    def test_class_changed_only_when_result_differs(self):
        r = cls('創見推出新品')
        stored = {k: r[k] for k in cc.CLASS_FIELDS}
        self.assertFalse(cc.class_changed(stored, r))
        self.assertTrue(cc.class_changed({**stored, 'classificationVersion': 'old'}, r))   # 版本升級可重跑
        self.assertTrue(cc.class_changed({**stored, 'coverageClass': 'review'}, r))
        self.assertTrue(cc.class_changed({}, r))


if __name__ == '__main__':
    unittest.main()
