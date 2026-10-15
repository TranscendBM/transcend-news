"""曝光分類寫入（media_exposure.coverageClass*）：保護人工分類、冪等、分批、失敗不清除、零刪除（完全離線）"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

from test_press_release_sync import FakeBatch, FakeDb, FakeSheets, NOW, ROWS_2025, exposure  # noqa: E402
import press_release_sync as ps  # noqa: E402


class TestClassificationWrites(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()
        self.db.store['media_exposure'] = {
            'e_auto': exposure('e_auto', '創見推出 RDE3 與 USD710S 車用隨身碟', (2026, 1, 22)),
            'e_co': exposure('e_co', '創見4月營收創高 年增近6倍', (2026, 5, 4)),
            'e_ind': exposure('e_ind', '新門(5432)7/24取得創見股票400張，每股均價261.35元', (2026, 7, 26)),
            'e_conf': exposure('e_conf', '隨便', (2026, 1, 22), matchStatus='confirmed', pressReleaseId='manual_pick'),
            'e_manual': exposure('e_manual', '創見推出新品', (2026, 3, 1), coverageClass='unrelated',
                                 coverageClassLabel='不相關', coverageClassMethod='manual', coverageClassConfidence=1.0,
                                 coverageClassReasons=['人工'], classificationVersion='old'),
            'e_sug': exposure('e_sug', '創見參展 embedded world 2026 展出工控新品', (2026, 3, 20)),
        }

    def sync(self, sheets=None, dry_run=False):
        tabs = {'2026': [['x'], ['時程', '標題'], ['1/21', 'RDE3 + USD710S'], ['3/4', '創見嵌入式展 embedded world 2026 參展新品']],
                '2025': ROWS_2025}
        return ps.run_sync(self.db, sheets or FakeSheets(tabs), run_id='r', now=NOW, dry_run=dry_run)

    def exp(self, key):
        return self.db.store['media_exposure'][key]

    def test_classes_are_written_separately_from_match_status(self):
        report = self.sync()
        self.assertEqual(self.exp('e_auto')['matchStatus'], 'auto_matched')
        self.assertEqual(self.exp('e_auto')['coverageClass'], 'press_release_derived')
        self.assertEqual(self.exp('e_co')['matchStatus'], 'unmatched')
        self.assertEqual(self.exp('e_co')['coverageClass'], 'company_coverage')       # unmatched ≠ 錯誤、也不強迫配對
        self.assertIsNone(self.exp('e_co')['pressReleaseId'])
        self.assertEqual(self.exp('e_ind')['coverageClass'], 'industry_related')
        self.assertEqual(self.exp('e_sug')['matchStatus'], 'suggested')
        self.assertEqual(self.exp('e_sug')['coverageClass'], 'review')
        for key in ('e_auto', 'e_co', 'e_ind', 'e_sug'):
            e = self.exp(key)
            self.assertEqual(e['classificationVersion'], ps.cc.CLASSIFICATION_VERSION)
            self.assertIn('classifiedAt', e)
            self.assertIn(e['coverageClassMethod'], ('press_release_match', 'rule', 'fallback'))
        self.assertEqual(report['classes']['press_release_derived'], 2)       # e_auto＋e_conf
        self.assertEqual(report['classProtected'], 1)

    def test_confirmed_match_untouched_but_classified_as_derived(self):
        self.sync()
        e = self.exp('e_conf')
        self.assertEqual((e['matchStatus'], e['pressReleaseId']), ('confirmed', 'manual_pick'))
        self.assertEqual(e['coverageClass'], 'press_release_derived')

    def test_manual_classification_is_never_overwritten(self):
        before = dict(self.exp('e_manual'))
        self.sync()
        self.sync()
        after = self.exp('e_manual')
        for key in ps.cc.CLASS_FIELDS:
            self.assertEqual(after[key], before[key], key)
        self.assertNotIn('classifiedAt', after)

    def test_rerun_is_idempotent_and_only_changed_docs_are_written(self):
        self.sync()
        writes = len(self.db.writes)
        report = self.sync()
        self.assertEqual((report['classUpdates'], report['matchUpdates']), (0, 0))
        self.assertEqual([w for w in self.db.writes[writes:] if w[0] != 'job_status'], [])

    def test_version_change_reclassifies_safely(self):
        self.sync()
        self.exp('e_co')['classificationVersion'] = 'older'
        self.exp('e_co')['coverageClass'] = 'review'
        writes = len(self.db.writes)
        report = self.sync()
        self.assertEqual(report['classUpdates'], 1)
        self.assertEqual(self.exp('e_co')['coverageClass'], 'company_coverage')
        written = [w for w in self.db.writes[writes:] if w[0] == 'media_exposure']
        self.assertEqual(written, [('media_exposure', 'e_co')])

    def test_month_isolation_preserved_with_classification(self):
        self.db.store['media_exposure'] = {'x': exposure('x', '創見8月營收年增275%', (2026, 9, 4))}
        tabs = {'2026': [['x'], ['時程', '主題'], ['8/6', '7月營收']], '2025': ROWS_2025}
        self.sync(FakeSheets(tabs))
        e = self.exp('x')
        self.assertNotEqual(e['matchStatus'], 'auto_matched')
        self.assertEqual(e['coverageClass'], 'company_coverage')

    def test_failure_keeps_existing_classification(self):
        self.sync()
        snapshot = json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str)
        with self.assertRaises(ps.SyncAbort):
            self.sync(FakeSheets(fail='2025'))
        self.assertEqual(json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str), snapshot)

    def test_single_classification_error_keeps_that_docs_existing_class(self):
        self.sync()
        old = dict(self.exp('e_co'))
        original = ps.cc.classify_exposure

        def flaky(exposure_, *a, **k):
            if exposure_.get('id') == 'e_co':
                raise RuntimeError('boom')
            return original(exposure_, *a, **k)
        ps.cc.classify_exposure = flaky
        try:
            self.exp('e_ind')['classificationVersion'] = 'older'
            report = self.sync()
        finally:
            ps.cc.classify_exposure = original
        self.assertEqual(report['classErrors'], 1)
        self.assertEqual(self.exp('e_co')['coverageClass'], old['coverageClass'])
        self.assertEqual(self.exp('e_ind')['classificationVersion'], ps.cc.CLASSIFICATION_VERSION)   # 其他筆照常

    def test_dry_run_writes_nothing_and_reports_class_counts(self):
        report = self.sync(FakeSheets(), dry_run=True)
        self.assertEqual(self.db.writes, [])
        self.assertNotIn('coverageClass', self.exp('e_co'))
        self.assertEqual(sum(report['classes'].values()), 6)

    def test_batches_stay_below_firestore_limit(self):
        many = {f'm{i}': exposure(f'm{i}', f'創見推出新品第{i}代', (2026, 3, 1)) for i in range(950)}
        self.db.store['media_exposure'] = many
        sizes = []
        original = FakeBatch.commit

        def spy(batch):
            sizes.append(len(batch.ops))
            original(batch)
        FakeBatch.commit = spy
        try:
            self.sync()
        finally:
            FakeBatch.commit = original
        self.assertTrue(all(n <= ps.BATCH_LIMIT <= 500 for n in sizes), sizes)
        self.assertEqual(sum(1 for d in many if 'coverageClass' in self.exp(d)), 950)

    def test_nothing_is_ever_deleted(self):
        before = set(self.db.store['media_exposure'])
        self.sync()
        self.assertEqual(set(self.db.store['media_exposure']), before)


if __name__ == '__main__':
    unittest.main()
