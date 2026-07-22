import datetime
import os
import sys
import unittest


FUNCTIONS_DIR = os.path.join(os.path.dirname(__file__), '..', 'functions')
sys.path.insert(0, os.path.abspath(FUNCTIONS_DIR))
import intelligence


def article(**overrides):
    value = {
        'id': 'abc123', 'title': '普通新聞', 'content': '一般內容',
        'cat': 'transcend', 'sourceName': '新聞來源', 'mediaName': '媒體',
        'pubDate': datetime.datetime(2026, 7, 22, tzinfo=datetime.timezone.utc),
    }
    value.update(overrides)
    return value


class TestRuleAnalysis(unittest.TestCase):
    def test_internal_category_is_not_company_mention(self):
        result = intelligence.analyze_article_rules(article())
        self.assertFalse(result['relevant'])
        self.assertEqual(result['entities'], [])

    def test_english_alias_does_not_match_inside_ordinary_word(self):
        result = intelligence.analyze_article_rules(article(
            title='Quarterly results transcend market expectations'))
        self.assertEqual(result['entities'], [])

    def test_company_crisis_is_high_priority_and_needs_review(self):
        result = intelligence.analyze_article_rules(article(
            title='創見 SSD 爆出資安事故並召回', content='產品已停產'))
        self.assertTrue(result['relevant'])
        self.assertEqual(result['eventType'], 'crisis')
        self.assertEqual(result['impact'], 'risk')
        self.assertTrue(result['requiresReview'])

    def test_same_name_cultural_company_is_excluded(self):
        value = article(title='創見文化事業有限公司推出新書')
        result = intelligence.analyze_article_rules(value)
        self.assertFalse(result['relevant'])
        self.assertEqual(result['entities'], [])
        self.assertIsNone(intelligence.build_ai_job(value, 'hash', 'server-time'))

    def test_competitor_and_industry_are_detected(self):
        result = intelligence.analyze_article_rules(article(
            title='威剛擴大 NAND 與 SSD 產品線'))
        self.assertTrue(result['relevant'])
        self.assertEqual(result['entities'][0]['code'], '3260')

    def test_irrelevant_article_does_not_build_job(self):
        self.assertIsNone(intelligence.build_ai_job(article(), 'hash', 'server-time'))

    def test_job_contains_no_article_body_or_secret(self):
        job = intelligence.build_ai_job(
            article(title='創見推出 SSD', content='PRIVATE ARTICLE BODY'),
            'hash-1', 'server-time')
        self.assertIsNotNone(job)
        serialized = str(job)
        self.assertNotIn('PRIVATE ARTICLE BODY', serialized)
        self.assertEqual(job['status'], 'pending')
        self.assertEqual(job['attempts'], 0)


if __name__ == '__main__':
    unittest.main()
