"""press_release_sync：Sheet 解析、同步計畫、冪等、fail closed、配對寫入（完全離線）"""

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

for _mod in ('firebase_admin', 'firebase_admin.firestore', 'firebase_admin.credentials'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import press_release_sync as ps  # noqa: E402

NOTE_SECRET = '內部備註-不可外流-XYZ'

ROWS_2026 = [
    ['新聞稿稿單'],                                  # 第 1 列：文件標題
    ['時程', '標題', '類型'],                         # 第 2 列：欄位標題
    ['1/5', '25大國際品牌', '品牌'],
    ['1/21', 'RDE3 + USD710S', '商規'],
    ['6月', 'COMPUTEX', '秀展'],
    ['', 'DDR5 7200', '產品'],
    ['2/30', '不合法日期的稿', '產品'],
    [],                                            # 空列
    ['3/4', '營收新聞稿 2025', '營收'],
]
ROWS_2025 = [
    ['新聞稿稿單'],
    ['時程', '標題', '類型', '產品', '備註'],
    ['12/30', '年底稿', '品牌', 'ECM', NOTE_SECRET],
    ['7/10', 'ECM', '產品', 'ECM', NOTE_SECRET],
]


class FakeSheets:
    def __init__(self, tabs=None, fail=None):
        self.tabs = tabs if tabs is not None else {'2026': ROWS_2026, '2025': ROWS_2025, '備份': [['x']], 'Sheet1': []}
        self.fail = fail
        self.value_calls = []

    def get_metadata(self):
        if self.fail == 'metadata':
            raise ps.SyncAbort('metadata down')
        return [{'title': t, 'sheetId': i} for i, t in enumerate(self.tabs)]

    def get_values(self, title):
        self.value_calls.append(title)
        if self.fail == title:
            raise ps.SyncAbort('read down')
        return self.tabs[title]


class FakeDoc:
    def __init__(self, id_, data):
        self.id, self._d = id_, data

    def to_dict(self):
        return dict(self._d)


class FakeRef(tuple):
    db = None

    def set(self, data, merge=False):
        coll = self.db.store.setdefault(self[0], {})
        coll[self[1]] = {**coll.get(self[1], {}), **data} if merge else dict(data)
        self.db.writes.append((self[0], self[1]))


class FakeCollection:
    def __init__(self, store, name, db=None):
        self.store, self.name, self.db = store, name, db

    def stream(self):
        return [FakeDoc(i, d) for i, d in self.store.setdefault(self.name, {}).items()]

    def document(self, id_):
        ref = FakeRef((self.name, id_))
        ref.db = self.db
        return ref


class FakeBatch:
    def __init__(self, db):
        self.db, self.ops = db, []

    def set(self, ref, data, merge=False):
        self.ops.append((ref, data, merge))

    def commit(self):
        self.db.commits += 1
        for (name, id_), data, merge in self.ops:
            coll = self.db.store.setdefault(name, {})
            if merge and id_ in coll:
                coll[id_] = {**coll[id_], **data}
            else:
                coll[id_] = dict(data)
            self.db.writes.append((name, id_))


class FakeDb:
    def __init__(self, store=None):
        self.store = store or {}
        self.writes, self.commits = [], 0

    def collection(self, name):
        return FakeCollection(self.store, name, self)

    def batch(self):
        return FakeBatch(self)


NOW = datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc)


def exposure(id_, title, day, **extra):
    return {'title': title, 'link': '', 'exposureDate': datetime(*day, 4, tzinfo=timezone.utc), 'campaignId': None, **extra}


class TestParseDate(unittest.TestCase):
    def test_md_with_sheet_year(self):
        self.assertEqual(ps.parse_date('1/5', 2026), ('2026-01-05', 'day'))
        self.assertEqual(ps.parse_date('01/05', 2026), ('2026-01-05', 'day'))
        self.assertEqual(ps.parse_date('12/30', 2025), ('2025-12-30', 'day'))
        self.assertEqual(ps.parse_date('３/４', 2026), ('2026-03-04', 'day'))
        self.assertEqual(ps.parse_date('3月4日', 2026), ('2026-03-04', 'day'))

    def test_cross_year_full_date_uses_its_own_year(self):
        self.assertEqual(ps.parse_date('2026/1/5', 2025), ('2026-01-05', 'day'))
        self.assertEqual(ps.parse_date('2026-01-05', 2025), ('2026-01-05', 'day'))

    def test_month_only_blank_and_invalid_are_never_guessed(self):
        self.assertEqual(ps.parse_date('6月', 2026), (None, 'month'))
        self.assertEqual(ps.parse_date('', 2026), (None, 'unknown'))
        self.assertEqual(ps.parse_date(None, 2026), (None, 'unknown'))
        self.assertEqual(ps.parse_date('2/30', 2026), (None, 'unknown'))
        self.assertEqual(ps.parse_date('13/1', 2026), (None, 'unknown'))
        self.assertEqual(ps.parse_date('待定', 2026), (None, 'unknown'))
        self.assertEqual(ps.parse_date('6/10-6/12', 2026), (None, 'unknown'))

    def test_never_returns_today_for_missing_date(self):
        today = datetime.now().date().isoformat()
        for raw in ('', '6月', '亂寫'):
            self.assertNotEqual(ps.parse_date(raw, datetime.now().year)[0], today)


class TestParseSheet(unittest.TestCase):
    def test_title_row_and_header_row_are_not_data(self):
        out = ps.parse_sheet('2026', ROWS_2026)
        titles = [r['title'] for r in out['records']]
        self.assertNotIn('新聞稿稿單', titles)
        self.assertNotIn('標題', titles)
        self.assertEqual(out['headerRow'], 2)
        self.assertEqual(len(out['records']), 6)               # 空列略過

    def test_rows_dates_and_precision(self):
        recs = {r['title']: r for r in ps.parse_sheet('2026', ROWS_2026)['records']}
        self.assertEqual(recs['25大國際品牌']['scheduledDate'], '2026-01-05')
        self.assertEqual(recs['25大國際品牌']['sourceRow'], 3)
        self.assertEqual(recs['COMPUTEX']['scheduledDate'], None)
        self.assertEqual(recs['COMPUTEX']['datePrecision'], 'month')
        self.assertEqual(recs['COMPUTEX']['rawDate'], '6月')
        self.assertEqual(recs['DDR5 7200']['datePrecision'], 'unknown')
        self.assertIsNone(recs['DDR5 7200']['actualReleaseDate'])
        self.assertEqual(recs['不合法日期的稿']['datePrecision'], 'unknown')
        self.assertTrue(all(r['status'] == 'unknown' for r in recs.values()))   # 沒有狀態欄：不假裝都已發布

    def test_columns_found_by_name_not_position(self):
        rows = [['x'], ['類型', '標題', '時程'], ['品牌', '標題甲', '2/3']]
        rec = ps.parse_sheet('2026', rows)['records'][0]
        self.assertEqual((rec['title'], rec['type'], rec['scheduledDate']), ('標題甲', '品牌', '2026-02-03'))

    def test_2025_product_column_and_note_never_read(self):
        out = ps.parse_sheet('2025', ROWS_2025)
        self.assertEqual([r['product'] for r in out['records']], ['ECM', 'ECM'])
        self.assertNotIn(NOTE_SECRET, json.dumps(out, ensure_ascii=False))

    def test_future_columns_supported_with_aliases(self):
        rows = [['稿單'], ['新聞稿ID', '時程', '標題', '正式標題', '實際發布日', '狀態', '官方連結', '別名', '英文標題'],
                ['PR-9', '6月', '簡稱', '正式的完整標題', '6/3', '已發布', 'https://example.com/p', 'ABC,DEF', 'English']]
        rec = ps.parse_sheet('2026', rows)['records'][0]
        self.assertEqual(rec['explicitPressReleaseId'], 'PR-9')
        self.assertEqual(rec['id'], 'pr_PR-9')
        self.assertEqual(rec['officialTitle'], '正式的完整標題')
        self.assertEqual(rec['actualReleaseDate'], '2026-06-03')
        self.assertEqual(rec['datePrecision'], 'day')
        self.assertEqual(rec['status'], 'published')
        self.assertEqual(rec['officialUrl'], 'https://example.com/p')
        self.assertIn('ABC', rec['keywords'])
        self.assertEqual(rec['englishTitle'], 'English')

    def test_status_values(self):
        rows = [['x'], ['時程', '標題', '狀態'], ['1/1', 'A', '規劃中'], ['1/2', 'B', '已發布'], ['1/3', 'C', '取消'], ['1/4', 'D', '亂寫']]
        self.assertEqual([r['status'] for r in ps.parse_sheet('2026', rows)['records']], ['planned', 'published', 'cancelled', 'unknown'])

    def test_unrecognised_layout_aborts_instead_of_guessing(self):
        with self.assertRaises(ps.SyncAbort):
            ps.parse_sheet('2026', [['隨便'], ['甲', '乙']])

    def test_ids_are_deterministic_and_do_not_depend_on_row_or_note(self):
        a = ps.parse_sheet('2026', ROWS_2026)['records']
        shifted = [ROWS_2026[0], ROWS_2026[1], ['9/9', '插入的新稿', '品牌']] + ROWS_2026[2:]
        b = {r['title']: r for r in ps.parse_sheet('2026', shifted)['records']}
        for r in a:
            self.assertEqual(b[r['title']]['id'], r['id'])        # 插列後 id 不變
            self.assertEqual(b[r['title']]['sourceFingerprint'], r['sourceFingerprint'])
        self.assertEqual(len({r['id'] for r in a}), len(a))
        with_note = [ROWS_2025[0], ROWS_2025[1], ['7/10', 'ECM', '產品', 'ECM', 'A']]
        other_note = [ROWS_2025[0], ROWS_2025[1], ['7/10', 'ECM', '產品', 'ECM', 'B']]
        self.assertEqual(ps.parse_sheet('2025', with_note)['records'][0]['id'], ps.parse_sheet('2025', other_note)['records'][0]['id'])
        self.assertEqual(ps.parse_sheet('2025', with_note)['records'][0]['sourceFingerprint'],
                         ps.parse_sheet('2025', other_note)['records'][0]['sourceFingerprint'])

    def test_identical_rows_get_distinct_ids(self):
        rows = [['x'], ['時程', '標題'], ['1/1', '同一篇'], ['1/1', '同一篇']]
        recs = ps.parse_sheet('2026', rows)['records']
        self.assertEqual(len({r['id'] for r in recs}), 2)

    def test_explicit_id_is_sanitised_but_distinct(self):
        self.assertEqual(ps._safe_id('PR-1'), 'pr_PR-1')
        self.assertNotEqual(ps._safe_id('a/b'), ps._safe_id('a_b'))


class TestFetchSource(unittest.TestCase):
    def test_only_year_sheets_are_read(self):
        sheets = FakeSheets()
        out = ps.fetch_source(sheets)
        self.assertEqual(sorted(sheets.value_calls), ['2025', '2026'])
        self.assertEqual(out['ignoredSheets'], ['備份', 'Sheet1'])
        self.assertEqual(out['sheets']['2026']['rows'], 6)
        self.assertEqual(out['sheets']['2025']['rows'], 2)

    def test_no_year_sheet_aborts(self):
        with self.assertRaises(ps.SyncAbort):
            ps.fetch_source(FakeSheets(tabs={'備份': [['x']]}))


class TestSheetsClient(unittest.TestCase):
    class Resp:
        def __init__(self, code, body=None):
            self.status_code, self._b = code, body or {}

        def json(self):
            return self._b

    class Session:
        def __init__(self, responses):
            self.responses, self.calls = list(responses), []

        def get(self, url, params=None, timeout=None):
            self.calls.append((url, params, timeout))
            r = self.responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

    def client(self, responses):
        sess = self.Session(responses)
        return ps.SheetsClient('SID', session=sess, sleep=lambda s: None), sess

    def test_uses_timeout_and_is_read_only_get(self):
        c, sess = self.client([self.Resp(200, {'sheets': [{'properties': {'title': '2026'}}]})])
        self.assertEqual(c.get_metadata(), [{'title': '2026'}])
        self.assertEqual(sess.calls[0][2], ps.HTTP_TIMEOUT_SEC)
        self.assertEqual(ps.SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets.readonly')

    def test_retries_then_succeeds(self):
        c, sess = self.client([self.Resp(503), ConnectionError('x'), self.Resp(200, {'values': [['a']]})])
        self.assertEqual(c.get_values('2026'), [['a']])
        self.assertEqual(len(sess.calls), 3)

    def test_gives_up_after_limited_retries(self):
        c, sess = self.client([self.Resp(500)] * 5)
        with self.assertRaises(ps.SyncAbort):
            c.get_values('2026')
        self.assertEqual(len(sess.calls), ps.MAX_ATTEMPTS)

    def test_permission_error_is_not_retried_and_names_the_account(self):
        c, sess = self.client([self.Resp(403)])
        c.service_account_email = 'x@y.iam.gserviceaccount.com'
        with self.assertRaises(ps.SheetsAccessError) as ctx:
            c.get_metadata()
        self.assertIn('x@y.iam.gserviceaccount.com', str(ctx.exception))
        self.assertEqual(len(sess.calls), 1)

    def test_permission_error_includes_google_reason_but_no_secrets(self):
        class R:
            status_code = 403

            def json(self):
                return {'error': {'status': 'PERMISSION_DENIED', 'message': 'Google Sheets API has not been used in project 1 before',
                                  'details': [{'reason': 'SERVICE_DISABLED'}]}}
        c, _ = self.client([R()])
        c.service_account_email = 'x@y.iam.gserviceaccount.com'
        with self.assertRaises(ps.SheetsAccessError) as ctx:
            c.get_metadata()
        self.assertIn('SERVICE_DISABLED', str(ctx.exception))
        self.assertIn('PERMISSION_DENIED', str(ctx.exception))

    def test_runtime_email_ignores_default_placeholder(self):
        class Cred:
            service_account_email = 'real@p.iam.gserviceaccount.com'
        self.assertEqual(ps.SheetsClient._runtime_email(Cred()), 'real@p.iam.gserviceaccount.com')

    def test_sheet_title_is_quoted_in_range(self):
        c, sess = self.client([self.Resp(200, {})])
        c.get_values("2026")
        self.assertIn("'2026'!", sess.calls[0][0])


class TestPlanPressReleases(unittest.TestCase):
    def parsed(self, tabs=None):
        return ps.fetch_source(FakeSheets(tabs))

    def test_first_run_creates_all_second_run_changes_nothing(self):
        parsed = self.parsed()
        plan = ps.plan_press_releases(parsed['records'], {})
        self.assertEqual(len(plan['created']), 8)
        existing = {r['id']: {**r, 'active': True} for r in plan['created']}
        again = ps.plan_press_releases(self.parsed()['records'], existing)
        self.assertEqual((len(again['created']), len(again['updated']), len(again['deactivate'])), (0, 0, 0))
        self.assertEqual(len(again['unchanged']), 8)

    def test_changed_title_creates_new_doc_and_deactivates_old(self):
        parsed = self.parsed()
        existing = {r['id']: {**r, 'active': True} for r in parsed['records']}
        tabs = {'2026': [list(r) for r in ROWS_2026], '2025': ROWS_2025}
        tabs['2026'][2] = ['1/5', '25大國際品牌（改標題）', '品牌']
        plan = ps.plan_press_releases(self.parsed(tabs)['records'], existing)
        self.assertEqual(len(plan['created']), 1)
        self.assertEqual(len(plan['deactivate']), 1)
        old = next(r for r in parsed['records'] if r['title'] == '25大國際品牌')
        self.assertEqual(plan['deactivate'], [old['id']])

    def test_changed_content_same_id_is_an_update(self):
        parsed = self.parsed()
        existing = {r['id']: {**r, 'active': True} for r in parsed['records']}
        tabs = {'2026': [list(r) for r in ROWS_2026], '2025': ROWS_2025}
        tabs['2026'][2] = ['1/5', '25大國際品牌', '產品']          # 只改類型
        plan = ps.plan_press_releases(self.parsed(tabs)['records'], existing)
        self.assertEqual((len(plan['updated']), len(plan['created']), len(plan['deactivate'])), (1, 0, 0))

    def test_reappearing_inactive_row_is_reactivated(self):
        parsed = self.parsed()
        existing = {r['id']: {**r, 'active': False} for r in parsed['records']}
        plan = ps.plan_press_releases(parsed['records'], existing)
        self.assertEqual(len(plan['updated']), 8)

    def test_empty_parse_never_overwrites_existing(self):
        existing = {'pr_1': {'active': True}}
        with self.assertRaises(ps.SyncAbort):
            ps.plan_press_releases([], existing)

    def test_mass_deactivation_is_blocked(self):
        existing = {f'pr_{i}': {'active': True} for i in range(10)}
        with self.assertRaises(ps.SyncAbort):
            ps.plan_press_releases(self.parsed()['records'][:2], existing)


class TestRunSync(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()

    def run_it(self, sheets=None, dry_run=False):
        return ps.run_sync(self.db, sheets or FakeSheets(), dry_run=dry_run, run_id='run1', now=NOW)

    def test_first_sync_writes_press_releases_without_notes(self):
        report = self.run_it()
        docs = self.db.store['press_releases']
        self.assertEqual(report['created'], 8)
        self.assertEqual(len(docs), 8)
        self.assertNotIn(NOTE_SECRET, json.dumps(docs, ensure_ascii=False, default=str))
        self.assertTrue(all(d['active'] and d['syncRunId'] == 'run1' for d in docs.values()))
        self.assertNotIn('備註', json.dumps(docs, ensure_ascii=False, default=str))

    def test_resync_is_idempotent_no_duplicates_no_writes(self):
        self.run_it()
        count, writes = len(self.db.store['press_releases']), len(self.db.writes)
        report = self.run_it()
        self.assertEqual(len(self.db.store['press_releases']), count)
        self.assertEqual((report['created'], report['updated'], report['deactivated']), (0, 0, 0))
        press_writes = [w for w in self.db.writes[writes:] if w[0] == 'press_releases']
        self.assertEqual(press_writes, [])

    def test_sheet_read_failure_fails_closed_and_changes_nothing(self):
        self.run_it()
        snapshot = json.dumps(self.db.store, sort_keys=True, default=str)
        writes = len(self.db.writes)
        for fail in ('metadata', '2026', '2025'):
            with self.assertRaises(ps.SyncAbort):
                self.run_it(FakeSheets(fail=fail))
        self.assertEqual(json.dumps(self.db.store, sort_keys=True, default=str), snapshot)
        self.assertEqual(len(self.db.writes), writes)
        self.assertTrue(all(d['active'] for d in self.db.store['press_releases'].values()))

    def test_row_removed_from_sheet_is_deactivated_not_deleted(self):
        self.run_it()
        tabs = {'2026': ROWS_2026[:-1], '2025': ROWS_2025}               # 少一列
        report = self.run_it(FakeSheets(tabs))
        self.assertEqual(report['deactivated'], 1)
        docs = self.db.store['press_releases']
        self.assertEqual(len(docs), 8)                                   # 不刪除
        self.assertEqual(sum(1 for d in docs.values() if not d['active']), 1)

    def test_dry_run_writes_nothing(self):
        self.db.store['media_exposure'] = {'e1': exposure('e1', 'RDE3 與 USD710S 新品', (2026, 1, 22))}
        report = self.run_it(dry_run=True)
        self.assertEqual(self.db.writes, [])
        self.assertEqual(self.db.commits, 0)
        self.assertEqual(self.db.store.get('press_releases', {}), {})
        self.assertTrue(report['dryRun'])
        self.assertEqual(report['read'], 8)
        self.assertEqual(report['dateIncomplete'], 3)
        dumped = json.dumps(report, ensure_ascii=False, default=str)
        self.assertNotIn(NOTE_SECRET, dumped)


class TestMatchingWrites(unittest.TestCase):
    def setUp(self):
        self.db = FakeDb()
        self.db.store['media_exposure'] = {
            'e_auto': exposure('e_auto', '創見推出 RDE3 與 USD710S 車用隨身碟', (2026, 1, 22)),
            'e_none': exposure('e_none', '創見董事長談產業趨勢', (2026, 1, 22)),
            'e_conf': exposure('e_conf', '創見推出 RDE3 與 USD710S 車用隨身碟', (2026, 1, 22),
                               matchStatus='confirmed', pressReleaseId='manual_pick', pressReleaseTitle='人工選的'),
            'e_legacy': exposure('e_legacy', '創見推出 RDE3 與 USD710S', (2026, 1, 22), pressReleaseId='legacy_pick'),
        }

    def sync(self):
        return ps.run_sync(self.db, FakeSheets(), run_id='r', now=NOW)

    def test_confirmed_and_legacy_manual_matches_are_never_overwritten(self):
        before = {k: dict(v) for k, v in self.db.store['media_exposure'].items() if k in ('e_conf', 'e_legacy')}
        report = self.sync()
        after = self.db.store['media_exposure']
        # 配對欄位完全不動（分類欄位另算：confirmed 一律是新聞稿衍生曝光）
        for key in ('e_conf', 'e_legacy'):
            for field in ps.MATCH_FIELDS + ('title', 'link', 'campaignId'):
                self.assertEqual(after[key].get(field), before[key].get(field), (key, field))
            self.assertEqual(after[key]['coverageClass'], 'press_release_derived')
        self.assertEqual(report['confirmed'], 2)

    def test_auto_match_unmatched_and_counts(self):
        report = self.sync()
        exp = self.db.store['media_exposure']
        self.assertEqual(exp['e_auto']['matchStatus'], 'auto_matched')
        self.assertEqual(exp['e_auto']['matchMethod'], 'date_keyword')
        self.assertEqual(exp['e_auto']['pressReleaseTitle'], 'RDE3 + USD710S')
        self.assertTrue(exp['e_auto']['pressReleaseId'].startswith('pr_'))
        self.assertEqual(exp['e_none']['matchStatus'], 'unmatched')
        self.assertIsNone(exp['e_none']['pressReleaseId'])
        self.assertEqual((report['autoMatched'], report['unmatched'], report['suggested']), (1, 1, 0))
        # 曝光原有欄位沒被覆寫
        self.assertEqual(exp['e_auto']['title'], '創見推出 RDE3 與 USD710S 車用隨身碟')

    def test_matching_is_idempotent(self):
        self.sync()
        writes = len(self.db.writes)
        report = self.sync()
        self.assertEqual(report['matchUpdates'], 0)
        data_writes = [w for w in self.db.writes[writes:] if w[0] != 'job_status']
        self.assertEqual(data_writes, [])

    def test_existing_auto_match_survives_resync(self):
        self.sync()
        pid = self.db.store['media_exposure']['e_auto']['pressReleaseId']
        self.sync()
        self.assertEqual(self.db.store['media_exposure']['e_auto']['pressReleaseId'], pid)

    def test_topic_column_with_full_title_keeps_ids_and_retitles_existing_matches(self):
        self.sync()
        old_ids = {r['title']: r['id'] for r in ps.parse_sheet('2026', ROWS_2026)['records']}
        pid = self.db.store['media_exposure']['e_auto']['pressReleaseId']
        full = '創見推出 RDE3 與 USD710S 車用隨身碟，通過軍規認證'
        rows = [ROWS_2026[0], ['時程', '主題', '標題', '類型']] + [
            [r[0], r[1], full if r[1] == 'RDE3 + USD710S' else '', r[2]] for r in ROWS_2026[2:] if len(r) > 1]
        parsed = ps.parse_sheet('2026', rows)['records']
        self.assertEqual({r['id'] for r in parsed if r['topic'] == 'RDE3 + USD710S'}, {pid})   # id 不變
        self.assertEqual(old_ids['RDE3 + USD710S'], pid)
        self.assertTrue(all(r['title'] for r in parsed))               # 沒有完整標題的列仍用主題當標題，不會被略過
        ps.run_sync(self.db, FakeSheets({'2026': rows, '2025': ROWS_2025}), run_id='r3', now=NOW)
        exp = self.db.store['media_exposure']['e_auto']
        self.assertEqual((exp['pressReleaseId'], exp['matchStatus']), (pid, 'auto_matched'))
        self.assertEqual(exp['pressReleaseTitle'], full.replace('，', ','))   # 儲存格文字會做 NFKC
        self.assertEqual(sum(1 for d in self.db.store['press_releases'].values() if d['active']), 8)

    def test_stale_auto_match_is_reevaluated_when_press_release_disappears(self):
        self.sync()
        tabs = {'2026': [r for r in ROWS_2026 if not (len(r) > 1 and r[1].startswith('RDE3'))], '2025': ROWS_2025}
        ps.run_sync(self.db, FakeSheets(tabs), run_id='r2', now=NOW)
        exp = self.db.store['media_exposure']['e_auto']
        self.assertNotEqual(exp['matchStatus'], 'auto_matched')
        self.assertIsNone(exp['pressReleaseId'])

    def test_cancelled_press_releases_are_not_used_for_matching(self):
        tabs = {'2026': [['x'], ['時程', '標題', '狀態'], ['1/21', 'RDE3 + USD710S', '取消']], '2025': ROWS_2025}
        ps.run_sync(self.db, FakeSheets(tabs), run_id='r', now=NOW)
        self.assertNotEqual(self.db.store['media_exposure']['e_auto']['matchStatus'], 'auto_matched')

    def test_low_confidence_writes_only_a_suggestion(self):
        self.db.store['media_exposure'] = {
            'e_sim': exposure('e_sim', '創見參展 embedded world 2026 展出工控新品', (2026, 3, 20))}
        tabs = {'2026': [['x'], ['時程', '標題'], ['3/4', '創見嵌入式展 embedded world 2026 參展新品']], '2025': ROWS_2025}
        ps.run_sync(self.db, FakeSheets(tabs), run_id='r', now=NOW)
        e = self.db.store['media_exposure']['e_sim']
        self.assertEqual(e['matchStatus'], 'suggested')
        self.assertIsNone(e['pressReleaseId'])
        self.assertTrue(e['suggestedPressReleaseId'])

    def test_notes_never_reach_exposure_docs_or_status_doc(self):
        self.sync()
        dumped = json.dumps(self.db.store, ensure_ascii=False, default=str)
        self.assertNotIn(NOTE_SECRET, dumped)

    def test_failure_does_not_touch_matches(self):
        self.sync()
        snapshot = json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str)
        with self.assertRaises(ps.SyncAbort):
            ps.run_sync(self.db, FakeSheets(fail='2025'), run_id='x', now=NOW)
        self.assertEqual(json.dumps(self.db.store['media_exposure'], sort_keys=True, default=str), snapshot)

    def test_status_doc_written_with_counts_only(self):
        self.sync()
        doc = self.db.store['job_status']['press_release_sync']
        self.assertIn('lastSyncAt', doc)
        self.assertEqual(doc['report']['read'], 8)
        self.assertNotIn('title', json.dumps(doc, ensure_ascii=False, default=str))


class TestSourceHygiene(unittest.TestCase):
    def test_module_has_no_secrets_or_write_scope_and_never_reads_note_column(self):
        text = (Path(__file__).resolve().parent.parent / 'functions' / 'press_release_sync.py').read_text(encoding='utf-8')
        self.assertNotIn('private_key', text)
        self.assertNotIn('service_account.Credentials', text)
        self.assertNotIn('auth/spreadsheets"', text)
        self.assertIn('spreadsheets.readonly', text)
        self.assertNotIn("'note'", text.split('FIELD_ALIASES = {')[1].split('}')[0])


if __name__ == '__main__':
    unittest.main()
