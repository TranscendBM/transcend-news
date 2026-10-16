"""match_review：Google Sheet「曝光配對覆核」分頁 → 人工決策（解析、驗證、套用、保護、fail closed）。完全離線。"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

from test_press_release_sync import FakeDb, FakeSheets, NOW, ROWS_2025, exposure  # noqa: E402
import match_review as mr  # noqa: E402
import press_release_sync as ps  # noqa: E402

NOTE = '覆核備註-內部資訊-不可外流'
HEAD = ['exposureId', 'decision', 'pressReleaseId', 'note']


class TestParsing(unittest.TestCase):
    def test_empty_or_missing_review_tab_means_no_decisions(self):
        self.assertEqual(mr.parse_review_rows([]), [])
        self.assertEqual(mr.parse_review_rows([[], ['', '']]), [])
        self.assertEqual(mr.parse_review_rows([HEAD]), [])

    def test_columns_found_by_name_with_aliases_and_chinese_decisions(self):
        rows = [['備註', '決定', '曝光ID', '新聞稿ID'], [NOTE, '確認', 'e1', ''], ['x', '改配', 'e2', 'pr_2'], ['', '排除', 'e3', '']]
        got = {d['exposureId']: (d['decision'], d['pressReleaseId']) for d in mr.parse_review_rows(rows)}
        self.assertEqual(got, {'e1': ('confirm', ''), 'e2': ('rematch', 'pr_2'), 'e3': ('reject', '')})

    def test_note_column_is_never_read_into_the_result(self):
        parsed = mr.parse_review_rows([HEAD, ['e1', 'confirm', '', NOTE]])
        self.assertNotIn(NOTE, json.dumps(parsed, ensure_ascii=False))

    def test_only_whitelisted_decisions(self):
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([HEAD, ['e1', 'delete', '', '']])
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([HEAD, ['e1', '', 'pr_1', '']])

    def test_missing_exposure_id_and_missing_header_fail(self):
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([HEAD, ['', 'confirm', '', '']])
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([['甲', '乙'], ['e1', 'confirm']])

    def test_identical_duplicates_collapse_but_contradictions_fail(self):
        self.assertEqual(len(mr.parse_review_rows([HEAD, ['e1', 'confirm', '', ''], ['e1', 'confirm', '', 'again']])), 1)
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([HEAD, ['e1', 'confirm', '', ''], ['e1', 'reject', '', '']])
        with self.assertRaises(mr.ReviewError):
            mr.parse_review_rows([HEAD, ['e1', 'rematch', 'pr_1', ''], ['e1', 'rematch', 'pr_2', '']])


class TestValidation(unittest.TestCase):
    EXP = {'e1': {'id': 'e1', 'suggestedPressReleaseId': 'pr_a'}, 'e2': {'id': 'e2'}, 'e3': {'id': 'e3', 'pressReleaseId': 'pr_a'}}
    PRS = {'pr_a': {'id': 'pr_a', 'title': 'A'}, 'pr_b': {'id': 'pr_b', 'title': 'B'}}

    def check(self, *rows):
        decisions = mr.parse_review_rows([HEAD, *rows])
        mr.validate_decisions(decisions, self.EXP, self.PRS)
        return decisions

    def test_valid_decisions(self):
        self.check(['e1', 'confirm', '', ''], ['e1x', 'reject', '', ''][:0] or ['e2', 'reject', '', ''], ['e2b', 'rematch', 'pr_b', ''][:0] or ['e3', 'rematch', 'pr_b', ''])
        self.check(['e1', 'confirm', 'pr_a', ''])

    def test_unknown_ids_and_inconsistent_confirm_fail_closed(self):
        for row in (['nope', 'reject', '', ''], ['e1', 'confirm', 'pr_zzz', ''], ['e1', 'rematch', 'pr_zzz', ''], ['e1', 'rematch', '', ''],
                    ['e1', 'confirm', 'pr_b', ''], ['e2', 'confirm', '', '']):
            with self.assertRaises(mr.ReviewError, msg=row):
                self.check(row)

    def test_built_fields_have_no_note_and_correct_states(self):
        decisions = self.check(['e1', 'confirm', '', NOTE], ['e2', 'reject', '', NOTE], ['e3', 'rematch', 'pr_b', NOTE])
        fields = mr.build_manual_fields(decisions, self.EXP, self.PRS)
        self.assertEqual((fields['e1']['matchStatus'], fields['e1']['pressReleaseId'], fields['e1']['matchMethod']), ('confirmed', 'pr_a', 'manual_confirm'))
        self.assertEqual((fields['e3']['matchStatus'], fields['e3']['pressReleaseId'], fields['e3']['matchMethod']), ('confirmed', 'pr_b', 'manual_rematch'))
        self.assertEqual((fields['e2']['matchStatus'], fields['e2']['pressReleaseId'], fields['e2']['matchMethod']), ('rejected', None, 'manual_reject'))
        for f in fields.values():
            self.assertEqual(f['matchSource'], mr.MANUAL_SOURCE)
            self.assertEqual(f['matchConfidence'], 1.0)
        self.assertNotIn(NOTE, json.dumps(fields, ensure_ascii=False))


# ═══════════════════════════════════════════════════════════
class TestSyncIntegration(unittest.TestCase):
    TABS = {'2026': [['x'], ['時程', '標題'], ['1/21', 'RDE3 + USD710S'], ['3/4', '創見嵌入式展 embedded world 2026 參展新品']], '2025': ROWS_2025}

    def setUp(self):
        self.db = FakeDb()
        self.db.store['media_exposure'] = {
            'e_sug': exposure('e_sug', '創見參展 embedded world 2026 展出工控新品', (2026, 3, 20)),
            'e_rej': exposure('e_rej', '創見董事長談產業', (2026, 5, 1)),
            'e_re': exposure('e_re', '創見推出 RDE3 與 USD710S 車用隨身碟', (2026, 1, 22)),
            'e_plain': exposure('e_plain', '無關的一般新聞', (2026, 6, 1)),
        }
        self.prs = {r['title']: r['id'] for r in ps.parse_sheet('2026', self.TABS['2026'])['records']}

    def sync(self, review=None, tabs=None):
        t = dict(tabs or self.TABS)
        if review is not None:
            t[mr.REVIEW_SHEET_TITLE] = review
        return ps.run_sync(self.db, FakeSheets(t), run_id='r', now=NOW)

    def exp(self, key):
        return self.db.store['media_exposure'][key]

    def test_without_review_tab_sync_works_and_suggests(self):
        report = self.sync()
        self.assertEqual(self.exp('e_sug')['matchStatus'], 'suggested')
        self.assertEqual(report['manualDecisions'], 0)

    def test_empty_review_tab_changes_nothing(self):
        self.sync()
        snapshot = json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str)
        self.sync(review=[HEAD])
        self.assertEqual(json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str), snapshot)

    def apply_decisions(self):
        self.sync()
        rows = [HEAD,
                ['e_sug', 'confirm', '', NOTE],
                ['e_rej', 'reject', '', NOTE],
                ['e_re', 'rematch', self.prs['創見嵌入式展 embedded world 2026 參展新品'], NOTE]]
        return self.sync(review=rows)

    def test_confirm_reject_rematch_are_applied(self):
        report = self.apply_decisions()
        sug, rej, re_ = self.exp('e_sug'), self.exp('e_rej'), self.exp('e_re')
        self.assertEqual((sug['matchStatus'], sug['matchMethod'], sug['matchSource']), ('confirmed', 'manual_confirm', mr.MANUAL_SOURCE))
        self.assertEqual(sug['pressReleaseId'], self.prs['創見嵌入式展 embedded world 2026 參展新品'])
        self.assertIsNone(sug['suggestedPressReleaseId'])
        self.assertEqual((rej['matchStatus'], rej['matchMethod'], rej['pressReleaseId']), ('rejected', 'manual_reject', None))
        self.assertEqual((re_['matchStatus'], re_['matchMethod']), ('confirmed', 'manual_rematch'))
        self.assertEqual((report['manualDecisions'], report['rejected']), (3, 1))
        self.assertEqual(sug['coverageClass'], 'press_release_derived')              # 人工確認配對 → 新聞稿衍生曝光
        self.assertNotEqual(rej['coverageClass'], 'press_release_derived')            # 人工排除不會被算成新聞稿曝光

    def test_manual_decisions_are_never_overwritten_by_later_automatic_runs(self):
        self.apply_decisions()
        before = {k: dict(self.exp(k)) for k in ('e_sug', 'e_rej', 'e_re')}
        for _ in range(2):
            self.sync(review=[HEAD])                              # 覆核分頁清空、自動排程再跑
        self.sync()                                               # 連分頁都沒有
        tabs = {'2026': [['x'], ['時程', '標題'], ['3/4', '完全不同的新聞稿']], '2025': ROWS_2025}      # 稿單大改
        self.sync(tabs=tabs)
        for key, old in before.items():
            for field in ps.MATCH_FIELDS:
                self.assertEqual(self.exp(key).get(field), old.get(field), (key, field))

    def test_decisions_apply_idempotently(self):
        self.apply_decisions()
        writes = len(self.db.writes)
        self.apply_decisions()
        self.assertEqual([w for w in self.db.writes[writes:] if w[0] == 'media_exposure'], [])

    def test_invalid_review_data_fails_closed_without_any_write(self):
        self.sync()
        snapshot = json.dumps(self.db.store, sort_keys=True, default=str)
        writes = len(self.db.writes)
        bad_sets = [
            [HEAD, ['no_such_exposure', 'reject', '', NOTE]],
            [HEAD, ['e_sug', 'confirm', 'pr_unknown', NOTE]],
            [HEAD, ['e_sug', 'maybe', '', NOTE]],
            [HEAD, ['e_sug', 'confirm', '', ''], ['e_sug', 'reject', '', '']],
            [HEAD, ['e_plain', 'confirm', '', '']],                                   # 沒有可確認的建議
            [['亂', '寫'], ['a', 'b']],
        ]
        for rows in bad_sets:
            with self.assertRaises(ps.SyncAbort, msg=str(rows)):
                self.sync(review=rows)
        self.assertEqual(json.dumps(self.db.store, sort_keys=True, default=str), snapshot)
        self.assertEqual(len(self.db.writes), writes)

    def test_review_tab_read_failure_fails_closed(self):
        self.sync()
        snapshot = json.dumps(self.db.store, sort_keys=True, default=str)
        with self.assertRaises(ps.SyncAbort):
            ps.run_sync(self.db, FakeSheets({**self.TABS, mr.REVIEW_SHEET_TITLE: [HEAD]}, fail=mr.REVIEW_SHEET_TITLE), run_id='x', now=NOW)
        self.assertEqual(json.dumps(self.db.store, sort_keys=True, default=str), snapshot)

    def test_notes_never_reach_public_documents(self):
        self.apply_decisions()
        self.assertNotIn(NOTE, json.dumps(self.db.store, ensure_ascii=False, default=str))
        for key in ('e_sug', 'e_rej', 'e_re'):
            self.assertNotIn('note', {k.lower() for k in self.exp(key)})

    def test_review_tab_is_not_treated_as_a_press_release_year_sheet(self):
        report = self.sync(review=[HEAD])
        self.assertEqual(set(report['sheets']), {'2026', '2025'})


if __name__ == '__main__':
    unittest.main()
