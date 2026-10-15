"""topic_cluster：話題聚類規則（純函式，完全離線）"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import topic_cluster as tc  # noqa: E402

BASE = datetime(2026, 10, 10, 2, 0, tzinfo=timezone.utc)


def art(i, title, hours=0, media='經濟日報', sentiment='neutral', cat='transcend', days=0):
    return {'id': f'a{i}', 'title': title, 'pubDate': BASE + timedelta(hours=hours, days=days), 'mediaName': media,
            'sentiment': sentiment, 'cat': cat, 'link': f'https://example.com/{i}'}


def cluster(articles, existing=None):
    clusters = tc.clusters_from_topics(existing or [])
    return tc.assign_articles(articles, clusters)


def groups(clusters):
    return sorted(sorted(m['id'] for m in c.members) for c in clusters)


class TestMerging(unittest.TestCase):
    def test_same_event_different_media_titles_merge(self):
        clusters, _ = cluster([
            art(1, '創見參加台北國際電子展 秀智慧鏡頭、DDR5高速記憶體', 0, '聯合報'),
            art(2, '創見參展台北國際電子展 秀DDR5-7200及AI影像新品', 3, '工商時報'),
            art(3, '創見參加2026台北國際電子展 秀智慧鏡頭、DDR5高速記憶體搶機器人商機', 5, '鏡報'),
        ])
        self.assertEqual(groups(clusters), [['a1', 'a2', 'a3']])

    def test_identical_titles_merge_and_media_is_deduplicated(self):
        clusters, _ = cluster([art(1, '長鑫存儲4F² DRAM量產領先三星2年', 0, 'Digitimes', cat='usMarket'),
                               art(2, '長鑫存儲4F² DRAM量產領先三星2年', 1, 'Digitimes', cat='usMarket'),
                               art(3, '長鑫存儲4F² DRAM量產領先三星2年', 2, '鉅亨網', cat='usMarket')])
        self.assertEqual(len(clusters), 1)
        doc = tc.build_topic_doc(clusters[0], BASE + timedelta(hours=3))
        self.assertEqual((doc['articleCount'], doc['mediaCount']), (3, 2))
        self.assertEqual(doc['mediaNames'], sorted({'Digitimes', '鉅亨網'}))

    def test_different_month_revenue_not_merged(self):
        clusters, _ = cluster([art(1, '創見7月營收52億元 年增308%', 0), art(2, '創見8月營收48.4億元 年增275%', 24)])
        self.assertEqual(len(clusters), 2)

    def test_same_month_revenue_of_different_companies_not_merged(self):
        clusters, _ = cluster([art(1, '創見7月營收52億元創高', 0), art(2, '威剛7月營收創歷史新高', 1, cat='competitor')])
        self.assertEqual(len(clusters), 2)

    def test_same_company_same_month_revenue_merges(self):
        clusters, _ = cluster([art(1, '創見9月營收60.4億元 年增290%', 0, '經濟日報'), art(2, '創見9月營收達60.4億元年增290% AI需求同步升溫', 2, '鉅亨網')])
        self.assertEqual(len(clusters), 1)

    def test_revenue_with_conflicting_amounts_stays_separate(self):
        clusters, _ = cluster([art(1, '創見9月營收60.4億元', 0), art(2, '創見9月營收48.4億元', 1)])
        self.assertEqual(len(clusters), 2)

    def test_different_quarter_earnings_not_merged(self):
        clusters, _ = cluster([art(1, '創見 2026 Q1 財報 每股賺18.93元', 0), art(2, '創見 2026 Q3 財報 每股賺27.7元', 5)])
        self.assertEqual(len(clusters), 2)

    def test_product_model_capacity_speed_protected(self):
        pairs = [('創見推出 DDR5 7200 工業記憶體模組', '創見推出 DDR5 6400 工業記憶體模組'),
                 ('創見推出64GB DDR5工業用記憶體', '創見推出32GB DDR5工業用記憶體'),
                 ('創見推出 ECM301 嵌入式鏡頭模組', '創見推出 ECM305 嵌入式鏡頭模組')]
        for a, b in pairs:
            clusters, _ = cluster([art(1, a, 0), art(2, b, 2)])
            self.assertEqual(len(clusters), 2, (a, b))

    def test_same_model_merges(self):
        clusters, _ = cluster([art(1, '創見推出 DDR5 7200 工業記憶體模組', 0), art(2, '創見推出DDR5-7200工業記憶體模組 搶攻AI', 4)])
        self.assertEqual(len(clusters), 1)

    def test_different_companies_same_theme_not_merged(self):
        clusters, _ = cluster([art(1, '三星擴產DRAM 搶攻AI需求', 0, cat='usMarket'), art(2, '美光新廠啟用 擴大DRAM產能 搶攻AI需求', 2, cat='usMarket')])
        self.assertEqual(len(clusters), 2)

    def test_different_exhibitions_not_merged(self):
        clusters, _ = cluster([art(1, '創見參展COMPUTEX 秀AI儲存方案', 0), art(2, '創見參展自動化展 秀AI視覺方案', 2)])
        self.assertEqual(len(clusters), 2)

    def test_generic_industry_words_alone_never_merge(self):
        clusters, _ = cluster([art(1, 'AI記憶體SSD需求暢旺 市場看好', 0, cat='twMarket'),
                               art(2, 'AI帶動SSD與記憶體市場成長 業者布局', 1, cat='twMarket'),
                               art(3, '記憶體產業AI浪潮 市場需求強勁', 2, cat='twMarket')])
        self.assertEqual(len(clusters), 3)

    def test_same_day_alone_is_not_a_reason(self):
        clusters, _ = cluster([art(1, '創見推出新品固態硬碟', 0), art(2, '威剛董事長談經營策略', 0, cat='competitor')])
        self.assertEqual(len(clusters), 2)

    def test_time_windows(self):
        near, _ = cluster([art(1, '創見推出 DDR5 7200 工業記憶體模組', 0), art(2, '創見推出DDR5-7200工業記憶體模組 搶攻AI', 60)])
        far, _ = cluster([art(1, '創見推出 DDR5 7200 工業記憶體模組', 0), art(2, '創見推出DDR5-7200工業記憶體模組 搶攻AI', 80)])
        self.assertEqual((len(near), len(far)), (1, 2))                     # 72 小時
        a = art(1, '創見看記憶體缺貨漲價持續 報價再漲', 0)
        b = art(2, '創見看記憶體缺貨漲價持續 報價再漲', 24 * 5)
        persistent, _ = cluster([a, b])
        self.assertEqual(len(persistent), 1)                                # 價格／供需議題最多 7 天
        c = art(3, '創見看記憶體缺貨漲價持續 報價再漲', 24 * 9)
        tooLate, _ = cluster([a, c])
        self.assertEqual(len(tooLate), 2)

    def test_low_confidence_stays_independent(self):
        clusters, _ = cluster([art(1, '創見董座談經營 記憶體供需', 0), art(2, '創見榮獲企業領袖肯定 董座發表感言', 3)])
        self.assertEqual(len(clusters), 2)


class TestStability(unittest.TestCase):
    ARTS = [art(1, '創見參加台北國際電子展 秀智慧鏡頭、DDR5高速記憶體', 0, '聯合報'),
            art(2, '創見參展台北國際電子展 秀DDR5-7200及AI影像新品', 3, '工商時報')]

    def test_topic_id_is_derived_from_the_earliest_article_and_is_deterministic(self):
        c1, _ = cluster(self.ARTS)
        c2, _ = cluster(list(reversed(self.ARTS)))
        self.assertEqual(c1[0].id, c2[0].id)
        self.assertEqual(c1[0].id, tc.new_topic_id('a1'))

    def test_new_article_joins_existing_topic_without_changing_its_id(self):
        c1, _ = cluster(self.ARTS)
        doc1 = tc.build_topic_doc(c1[0], BASE + timedelta(hours=6))
        newer = art(3, '創見參加2026台北國際電子展 秀智慧鏡頭、DDR5高速記憶體搶機器人商機', 8, '鏡報')
        c2, assignments = cluster([newer], [doc1])
        self.assertEqual(len(c2), 1)
        self.assertEqual(c2[0].id, doc1['id'])
        self.assertEqual(assignments['a3']['topicId'], doc1['id'])
        doc2 = tc.build_topic_doc(c2[0], BASE + timedelta(hours=9), doc1)
        self.assertEqual((doc2['id'], doc2['articleCount'], doc2['seedArticleId']), (doc1['id'], 3, 'a1'))

    def test_earlier_article_joining_later_keeps_the_existing_id(self):
        c1, _ = cluster([self.ARTS[1]])
        doc = tc.build_topic_doc(c1[0], BASE + timedelta(hours=6))
        c2, _ = cluster([self.ARTS[0]], [doc])
        self.assertEqual(c2[0].id, doc['id'])
        self.assertEqual(c2[0].id, tc.new_topic_id('a2'))      # 不會因為更早的文章加入而改 id

    def test_rerun_is_idempotent(self):
        c1, _ = cluster(self.ARTS)
        doc = tc.build_topic_doc(c1[0], BASE + timedelta(hours=6))
        c2, assignments = cluster(self.ARTS, [doc])
        self.assertEqual(assignments, {})
        again = tc.build_topic_doc(c2[0], BASE + timedelta(hours=6), doc)
        self.assertFalse(tc.doc_changed(doc, again))

    def test_existing_topics_are_never_merged_together(self):
        a, _ = cluster([art(1, '創見推出 DDR5 7200 工業記憶體模組', 0)])
        b, _ = cluster([art(2, '創見推出DDR5-7200工業記憶體模組 搶攻AI', 100)])
        da, db_ = tc.build_topic_doc(a[0], BASE + timedelta(hours=1)), tc.build_topic_doc(b[0], BASE + timedelta(hours=101))
        clusters, _ = cluster([art(3, '創見推出DDR5-7200工業記憶體模組', 101)], [da, db_])
        self.assertEqual({c.id for c in clusters}, {da['id'], db_['id']})


class TestMetrics(unittest.TestCase):
    def test_sentiment_counts_and_label(self):
        arts = [art(1, '創見獲獎 營收創高', 0, sentiment='positive'), art(2, '創見獲獎 營收創高亮眼', 1, '鉅亨網', 'positive'),
                art(3, '創見獲獎 營收創高', 2, '自由時報', 'neutral')]
        clusters, _ = cluster(arts)
        doc = tc.build_topic_doc(clusters[0], BASE + timedelta(hours=3))
        self.assertEqual((doc['positiveCount'], doc['neutralCount'], doc['negativeCount']), (2, 1, 0))
        self.assertEqual(doc['sentiment'], 'positive')
        self.assertEqual(tc.sentiment_label(1, 2, 1)[0], 'neutral')
        self.assertEqual(tc.sentiment_label(0, 1, 3)[0], 'negative')

    def test_velocity_and_24h_counts(self):
        arts = [art(i, '創見推出 DDR5 7200 工業記憶體模組', h, media=f'媒體{i}') for i, h in enumerate([-30, -26, 1, 2, 3, 4], start=1)]
        clusters, _ = cluster(arts)
        now = BASE + timedelta(hours=5)
        doc = tc.build_topic_doc(clusters[0], now)
        self.assertEqual((doc['count24h'], doc['countPrev24h']), (4, 2))
        self.assertEqual(doc['velocity24h'], 100.0)
        first = tc.build_topic_doc(cluster(arts[2:4])[0][0], now)
        self.assertIsNone(first['velocity24h'])                 # 前一個 24 小時沒有報導 → 不算比例

    def test_importance_is_explainable(self):
        arts = [art(i, '創見9月營收60.4億元 年增290%', h, media=m) for i, (h, m) in enumerate(
            [(0, '經濟日報'), (1, '鉅亨網'), (2, '電子時報'), (3, '自由時報')], start=1)]
        clusters, _ = cluster(arts)
        doc = tc.build_topic_doc(clusters[0], BASE + timedelta(hours=4))
        self.assertGreater(doc['importanceScore'], 50)
        self.assertLessEqual(doc['importanceScore'], 100)
        text = ' '.join(doc['importanceReasons'])
        for part in ('4 家媒體報導', '提及創見', '營收事件', '重點媒體'):
            self.assertIn(part, text)
        self.assertTrue(all('+' in r for r in doc['importanceReasons']))
        self.assertIn('transcend', doc['tags'])
        self.assertIn('finance', doc['tags'])

    def test_importance_reason_labels_have_no_duplicated_word(self):
        clusters, _ = cluster([art(1, '創見遭罰156萬元 違反貿易法', 0, sentiment='negative')])
        doc = tc.build_topic_doc(clusters[0], BASE + timedelta(hours=1))
        self.assertIn('風險事件 +12', ' '.join(doc['importanceReasons']))
        self.assertNotIn('事件事件', ' '.join(doc['importanceReasons']))

    def test_fields_and_tags(self):
        clusters, _ = cluster([art(1, '三星罷工 記憶體供需吃緊 創見看漲價', 0, cat='usMarket')])
        doc = tc.build_topic_doc(clusters[0], BASE + timedelta(hours=1))
        for key in ('id', 'title', 'normalizedTitle', 'summary', 'category', 'eventType', 'entities', 'companies', 'products', 'keywords',
                    'numericTokens', 'articleIds', 'representativeArticleIds', 'articleCount', 'mediaCount', 'mediaNames', 'positiveCount',
                    'neutralCount', 'negativeCount', 'sentiment', 'importanceScore', 'velocity24h', 'firstPublishedAt', 'lastPublishedAt',
                    'algorithmVersion', 'status', 'needsReview'):
            self.assertIn(key, doc)
        self.assertEqual(doc['algorithmVersion'], tc.ALGORITHM_VERSION)
        self.assertIn('upstream', doc['tags'])

    def test_forum_posts_and_index_pages_are_not_topics(self):
        clusters, assignments = cluster([art(1, '3260 威剛- 10/13 - 股市爆料同學會', 0), art(2, '旺宏電子股份有限公司 相關專利權資料', 0)])
        self.assertEqual((clusters, assignments), ([], {}))


class TestCandidateGeneration(unittest.TestCase):
    def test_does_not_compare_every_pair(self):
        calls = {'n': 0}
        original = tc.pair_score

        def counting(a, b):
            calls['n'] += 1
            return original(a, b)
        tc.pair_score = counting
        try:
            arts = [art(i, f'公司{chr(65 + i % 26)}推出產品{i}型號X{i}00 新聞', i % 40) for i in range(300)]
            cluster(arts)
        finally:
            tc.pair_score = original
        self.assertLess(calls['n'], 300 * 299 / 2 / 2)          # 少於全部兩兩比較的一半（每篇候選上限 MAX_CANDIDATES）


if __name__ == '__main__':
    unittest.main()
