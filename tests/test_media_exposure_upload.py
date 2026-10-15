import base64
import datetime
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import media_exposure_upload as upload  # noqa: E402

PASS = 'correct-passcode'


class _Snap:
    def __init__(self, exists):
        self.exists = exists


class _Ref:
    def __init__(self, collection, doc_id):
        self.collection, self.id = collection, doc_id


class _Collection:
    def __init__(self, name):
        self.name = name

    def document(self, doc_id):
        return _Ref(self.name, doc_id)


class _Batch:
    def __init__(self, db):
        self.db, self.ops = db, []

    def set(self, ref, data, merge=False):
        self.ops.append((ref, data))

    def commit(self):
        self.db.commits.append(self.ops)


class _FakeDb:
    def __init__(self, existing_public_ids=()):
        self.existing = set(existing_public_ids)
        self.commits = []

    def collection(self, name):
        return _Collection(name)

    def get_all(self, refs):
        return [_Snap(r.id in self.existing) for r in refs]

    def batch(self):
        return _Batch(self)


def _xlsx_b64(rows, header=('日期', '媒體', '記者', '新聞標題', '連結', None)):
    wb = Workbook()
    ws = wb.active
    ws.title = '08'
    ws.append(list(header))
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


def _payload(rows, mode='check', **extra):
    return {
        'passcode': PASS, 'mode': mode,
        'files': [{'name': 'Media exposure_08.xlsx', 'data': _xlsx_b64(rows)}],
        **extra,
    }


GOOD = [
    [datetime.date(2026, 8, 3), '經濟日報', '王記者', '創見新品發表', 'https://example.com/a', '內部備註甲'],
    [datetime.date(2026, 9, 5), '鉅亨網新聞中心', '', '創見營收', 'https://example.com/b', ''],
]
INVALID = [None, None, None, None, 'https://www.facebook.com/x/photo', '']


class UploadHandlerTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(upload.time, 'sleep')
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)

    def test_wrong_passcode_is_rejected_before_anything_is_parsed_or_read(self):
        db = mock.MagicMock()
        status, body = upload.respond('POST', {**_payload(GOOD), 'passcode': 'nope'},
                                      passcode=PASS, get_db=lambda: db)
        self.assertEqual(status, 403)
        self.assertFalse(body['ok'])
        self.sleep.assert_called_once()
        db.get_all.assert_not_called()

    def test_empty_server_passcode_never_authenticates(self):
        status, _ = upload.respond('POST', {**_payload(GOOD), 'passcode': ''},
                                   passcode='', get_db=_FakeDb)
        self.assertEqual(status, 403)

    def test_only_post_is_allowed(self):
        status, _ = upload.respond('GET', None, passcode=PASS, get_db=_FakeDb)
        self.assertEqual(status, 405)

    def test_check_reports_counts_without_writing_or_leaking_content(self):
        db = _FakeDb()
        status, body = upload.respond('POST', _payload(GOOD + [INVALID]),
                                      passcode=PASS, get_db=lambda: db)
        self.assertEqual(status, 200)
        self.assertEqual(body['mode'], 'check')
        self.assertEqual(body['uniqueRecords'], 2)
        self.assertEqual(body['newRecords'], 2)
        self.assertEqual(body['existingRecords'], 0)
        self.assertEqual(body['byMonth'], {'2026-08': 1, '2026-09': 1})
        self.assertEqual(len(body['invalidRows']), 1)
        self.assertEqual(body['invalidRows'][0]['row'], 4)
        self.assertEqual(db.commits, [])
        raw = json.dumps(body, ensure_ascii=False)
        self.assertNotIn('創見新品發表', raw)
        self.assertNotIn('內部備註甲', raw)

    def test_check_counts_records_that_already_exist(self):
        first = upload.respond('POST', _payload(GOOD), passcode=PASS, get_db=_FakeDb)[1]
        ids = [r for r in upload.core.parse_workbooks(
            [('x.xlsx', io.BytesIO(base64.b64decode(_payload(GOOD)['files'][0]['data'])))]).records]
        self.assertEqual(first['newRecords'], 2)
        status, body = upload.respond('POST', _payload(GOOD), passcode=PASS,
                                      get_db=lambda: _FakeDb(existing_public_ids=ids[:1]))
        self.assertEqual((body['newRecords'], body['existingRecords']), (1, 1))

    def test_commit_writes_public_and_private_and_merges_media_aliases(self):
        db = _FakeDb()
        status, body = upload.respond('POST', _payload(GOOD, mode='commit'),
                                      passcode=PASS, get_db=lambda: db)
        self.assertEqual(status, 200)
        self.assertEqual(body['written'], 2)
        self.assertTrue(body['importBatch'].startswith('web-upload-'))
        ops = db.commits[0]
        self.assertEqual(len(ops), 4)  # 2 筆 × (public + private)
        public = [d for ref, d in ops if ref.collection == 'media_exposure']
        private = [d for ref, d in ops if ref.collection == 'media_exposure_private']
        self.assertEqual({d['mediaName'] for d in public}, {'經濟日報', '鉅亨網'})
        self.assertTrue(all('noteInternal' not in d for d in public))
        self.assertIn('內部備註甲', {d['noteInternal'] for d in private})

    def test_commit_with_invalid_rows_requires_the_exact_skip_count(self):
        rows = GOOD + [INVALID]
        for approve in (None, 0, 2):
            db = _FakeDb()
            status, body = upload.respond(
                'POST', _payload(rows, mode='commit', approveSkippingInvalid=approve),
                passcode=PASS, get_db=lambda: db)
            self.assertEqual(status, 409, approve)
            self.assertEqual(db.commits, [])
        db = _FakeDb()
        status, body = upload.respond(
            'POST', _payload(rows, mode='commit', approveSkippingInvalid=1),
            passcode=PASS, get_db=lambda: db)
        self.assertEqual(status, 200)
        self.assertEqual(body['written'], 2)

    def test_commit_with_nothing_valid_is_refused(self):
        status, _ = upload.respond('POST', _payload([INVALID], mode='commit', approveSkippingInvalid=1),
                                   passcode=PASS, get_db=_FakeDb)
        self.assertEqual(status, 400)

    def test_rejects_non_xlsx_names_bad_base64_and_non_zip_content(self):
        cases = [
            [{'name': 'a.xls', 'data': _xlsx_b64(GOOD)}],
            [{'name': 'a.xlsx', 'data': '!!!not base64!!!'}],
            [{'name': 'a.xlsx', 'data': base64.b64encode(b'plain text').decode()}],
            [],
        ]
        for files in cases:
            status, _ = upload.respond('POST', {'passcode': PASS, 'mode': 'check', 'files': files},
                                       passcode=PASS, get_db=_FakeDb)
            self.assertEqual(status, 400, files)

    def test_corrupt_xlsx_names_the_offending_file(self):
        bad = base64.b64encode(b'PK\x03\x04 definitely not a workbook').decode()
        status, body = upload.respond('POST', {
            'passcode': PASS, 'mode': 'check',
            'files': [{'name': 'ok.xlsx', 'data': _xlsx_b64(GOOD)}, {'name': 'broken.xlsx', 'data': bad}],
        }, passcode=PASS, get_db=_FakeDb)
        self.assertEqual(status, 400)
        self.assertIn('broken.xlsx', body['error'])

    def test_too_many_files_and_oversized_files_are_rejected(self):
        one = {'name': 'a.xlsx', 'data': _xlsx_b64(GOOD)}
        status, _ = upload.respond('POST', {'passcode': PASS, 'mode': 'check',
                                            'files': [one] * (upload.MAX_FILES + 1)},
                                   passcode=PASS, get_db=_FakeDb)
        self.assertEqual(status, 400)
        huge = base64.b64encode(b'PK' + b'0' * (upload.MAX_FILE_BYTES + 10)).decode()
        status, _ = upload.respond('POST', {'passcode': PASS, 'mode': 'check',
                                            'files': [{'name': 'big.xlsx', 'data': huge}]},
                                   passcode=PASS, get_db=_FakeDb)
        self.assertEqual(status, 413)

    def test_unexpected_errors_do_not_leak_internal_messages(self):
        def boom():
            raise RuntimeError('secret internal detail')
        with mock.patch('builtins.print'):
            status, body = upload.respond('POST', _payload(GOOD), passcode=PASS, get_db=boom)
        self.assertEqual(status, 500)
        self.assertNotIn('secret internal detail', json.dumps(body, ensure_ascii=False))


if __name__ == '__main__':
    unittest.main()
