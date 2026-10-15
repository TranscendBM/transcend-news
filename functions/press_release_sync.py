"""
Google Sheet「新聞稿稿單」→ Firestore press_releases 同步，並用它精準配對 media_exposure。

安全原則
  - Google Sheet 只讀（scope = spreadsheets.readonly），使用 Cloud Functions 執行環境的
    Application Default Credentials；不建立、不讀取任何金鑰檔，Sheet 也不需要公開。
  - 「備註」欄不讀取、不寫入、不顯示（解析時只取明確列在 FIELD_ALIASES 的欄位）。
  - 任一階段讀取失敗一律 fail closed：不停用既有新聞稿、不以空資料覆蓋、不清除既有配對。
  - 人工確認（matchStatus == 'confirmed'）的配對永遠不被覆蓋。
  - 所有寫入皆冪等：同一份 Sheet 重複同步不會產生重複文件、不會重複計為更新。

流程：fetch_source（唯讀）→ build_plan（純函式，dry-run 就停在這裡）→ apply_plan（寫入）。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from datetime import date, datetime, timezone

import press_release_match as pm
import coverage_classify as cc

SPREADSHEET_ID = '1ran1qZjie3rMnUzo-LambYaP6c_vMQ8MdVH5iCMkUqM'
SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
YEAR_SHEET = re.compile(r'^20\d{2}$')
PRESS_COLLECTION = 'press_releases'
EXPOSURE_COLLECTION = 'media_exposure'
JOB_STATUS_DOC = ('job_status', 'press_release_sync')
LOCK_NAME = 'press_release_sync'

HTTP_TIMEOUT_SEC = 30
MAX_ATTEMPTS = 3
BATCH_LIMIT = 400
HEADER_SCAN_ROWS = 6

# 沒有別名命中的欄位（含「備註」）一律不讀取
FIELD_ALIASES = {
    'id': ['新聞稿id', '新聞稿編號', '新聞稿 id', 'id', '編號'],
    'scheduled': ['時程', '日期', '預定日期', '預定發布日', '預計發布日'],
    'actual': ['實際發布日', '實際發布日期', '發布日期', '發布日'],
    'title': ['標題'],
    'topic': ['主題', '簡稱'],
    'officialTitle': ['正式標題', '新聞稿標題'],
    'englishTitle': ['英文標題', 'english title'],
    'type': ['類型', '分類'],
    'product': ['產品'],
    'status': ['狀態'],
    'officialUrl': ['官方連結', '新聞稿連結', '連結', '網址'],
    'keywords': ['關鍵字', '別名'],
}
# 認得但刻意忽略的欄位（只用來避免被當成未知欄位警告；內容永遠不讀）
IGNORED_HEADERS = {'備註', '備註說明', 'note', 'notes', 'remark', 'remarks'}

STATUS_MAP = {'規劃中': 'planned', '已發布': 'published', '取消': 'cancelled', '已取消': 'cancelled'}


class SyncAbort(Exception):
    """同步無法安全進行（讀取失敗、版面看不懂、風險過高）；不寫入任何東西。"""


class SheetsAccessError(SyncAbort):
    """沒有權限或找不到 Sheet。"""


# ═══════════════════════════════════════════════════════════
# Google Sheets 唯讀用戶端（ADC，不需要 googleapiclient）
# ═══════════════════════════════════════════════════════════
class SheetsClient:
    def __init__(self, spreadsheet_id=SPREADSHEET_ID, session=None, sleep=time.sleep):
        self.spreadsheet_id = spreadsheet_id
        self._session = session
        self._sleep = sleep
        self.service_account_email = ''

    def _get_session(self):
        if self._session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession
            credentials, _ = google.auth.default(scopes=[SHEETS_SCOPE])
            self.service_account_email = self._runtime_email(credentials)
            self._session = AuthorizedSession(credentials)
        return self._session

    @staticmethod
    def _runtime_email(credentials):
        """Compute／Cloud Functions 的憑證只回傳 'default'；向 metadata server 問真正的 service account email。"""
        email = getattr(credentials, 'service_account_email', '') or ''
        if email and email != 'default':
            return email
        try:
            import requests
            resp = requests.get(
                'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
                headers={'Metadata-Flavor': 'Google'}, timeout=3)
            if resp.status_code == 200 and resp.text.strip():
                return resp.text.strip()
        except Exception:
            pass
        return email

    @staticmethod
    def _error_detail(resp):
        """Google API 錯誤的狀態與原因（例如 SERVICE_DISABLED／PERMISSION_DENIED）；不含任何憑證或資料內容。"""
        try:
            err = resp.json().get('error', {})
        except Exception:
            return ''
        reasons = [d.get('reason') for d in err.get('details', []) if isinstance(d, dict) and d.get('reason')]
        return ' '.join(x for x in [err.get('status'), ','.join(reasons), str(err.get('message', ''))[:160]] if x)

    def _request(self, url, params=None):
        last = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                resp = self._get_session().get(url, params=params, timeout=HTTP_TIMEOUT_SEC)
            except Exception as exc:                    # 網路層錯誤：有限重試
                last = f'{type(exc).__name__}: {exc}'
                print(f'⚠ Sheets 請求失敗（第 {attempt}/{MAX_ATTEMPTS} 次）：{last}')
            else:
                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code in (401, 403, 404):
                    who = self.service_account_email or '（執行環境的 service account）'
                    raise SheetsAccessError(
                        f'Sheets API 回 {resp.status_code}（{self._error_detail(resp)}）：沒有權限、找不到試算表，或尚未啟用 Google Sheets API。'
                        f'請將 Google Sheet 以「檢視者」分享給 {who}，並確認已啟用 Google Sheets API。')
                last = f'HTTP {resp.status_code}'
                print(f'⚠ Sheets 請求失敗（第 {attempt}/{MAX_ATTEMPTS} 次）：{last}')
                if resp.status_code not in (408, 429) and resp.status_code < 500:
                    break
            if attempt < MAX_ATTEMPTS:
                self._sleep(2 ** attempt)
        raise SyncAbort(f'讀取 Google Sheet 失敗：{last}')

    def get_metadata(self):
        data = self._request(
            f'{SHEETS_API}/{self.spreadsheet_id}',
            {'fields': 'properties.title,sheets.properties(sheetId,title,hidden)'})
        return [s['properties'] for s in data.get('sheets', [])]

    def get_values(self, sheet_title):
        rng = "'" + sheet_title.replace("'", "''") + "'!A1:Z2000"
        data = self._request(
            f'{SHEETS_API}/{self.spreadsheet_id}/values/{rng}',
            {'valueRenderOption': 'FORMATTED_VALUE', 'majorDimension': 'ROWS'})
        return data.get('values', [])


# ═══════════════════════════════════════════════════════════
# 解析
# ═══════════════════════════════════════════════════════════
def _norm_header(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or ''))).strip().lower()


_ALIAS_LOOKUP = {_norm_header(alias): field for field, aliases in FIELD_ALIASES.items() for alias in aliases}
_IGNORED = {_norm_header(h) for h in IGNORED_HEADERS}


def find_header(rows):
    """前幾列中找標題列（要認得出標題欄）。回傳 (列索引, {欄位名: 欄索引})；找不到 (None, {})。"""
    for index, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        columns = {}
        for col, cell in enumerate(row):
            field = _ALIAS_LOOKUP.get(_norm_header(cell))
            if field and field not in columns:
                columns[field] = col
        if 'title' in columns or 'officialTitle' in columns or 'topic' in columns:
            return index, columns
    return None, {}


def _cell(row, columns, field):
    col = columns.get(field)
    if col is None or col >= len(row):
        return ''
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(row[col] or ''))).strip()


def parse_date(raw, sheet_year):
    """
    → (ISO 日期字串或 None, 精度 'day'|'month'|'unknown')。
    只接受明確的「日」：M/D、MM/DD、M-D、M月D日、YYYY/M/D、YYYY-MM-DD。
    「6月」是 month 精度、空白與其他格式一律 unknown——絕不猜測，更不會補成今天。
    """
    text = unicodedata.normalize('NFKC', str(raw or '')).strip()
    if not text:
        return None, 'unknown'
    patterns = [
        (r'(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})', True),
        (r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?', True),
        (r'(\d{1,2})\s*[/\-.]\s*(\d{1,2})', False),
        (r'(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?', False),
    ]
    for pattern, has_year in patterns:
        m = re.fullmatch(pattern, text)
        if not m:
            continue
        nums = [int(g) for g in m.groups()]
        year, month, day = nums if has_year else (sheet_year, nums[0], nums[1])
        try:
            return date(year, month, day).isoformat(), 'day'
        except ValueError:
            return None, 'unknown'
    m = re.fullmatch(r'(\d{1,2})\s*月份?', text)
    if m and 1 <= int(m.group(1)) <= 12:
        return None, 'month'
    return None, 'unknown'


def _split_keywords(value):
    return [k.strip() for k in re.split(r'[,，、;；/\n]+', value) if k.strip()]


def _safe_id(explicit):
    cleaned = re.sub(r'[^A-Za-z0-9_-]', '_', explicit)[:100]
    if cleaned != explicit:
        cleaned += '_' + hashlib.sha1(explicit.encode('utf-8')).hexdigest()[:8]
    return 'pr_' + cleaned


def _fingerprint(fields):
    payload = json.dumps(fields, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(payload.encode('utf-8')).hexdigest()


def parse_sheet(sheet_title, rows, spreadsheet_id=SPREADSHEET_ID):
    """解析一個年度分頁。回傳 {'records': [...], 'skipped': [...], 'headerRow': n, 'fields': [...]}；看不懂版面時拋 SyncAbort。"""
    header_index, columns = find_header(rows)
    if header_index is None:
        raise SyncAbort(f'分頁 {sheet_title} 找不到標題列（需要「標題」欄），為避免錯位已停止同步')
    year = int(sheet_title)
    records, skipped, seen_ids = [], [], {}
    header_labels = {_norm_header(a) for a in FIELD_ALIASES['title'] + FIELD_ALIASES['officialTitle'] + FIELD_ALIASES['topic']}

    for offset, row in enumerate(rows[header_index + 1:], start=header_index + 2):
        title_text = _cell(row, columns, 'title')
        topic = _cell(row, columns, 'topic')
        official = _cell(row, columns, 'officialTitle')
        # 顯示用標題：正式標題 → 標題（完整新聞稿標題）→ 主題（簡稱）
        display = official or title_text or topic
        if not display:
            if any(str(c or '').strip() for c in row):
                skipped.append({'sheet': sheet_title, 'row': offset, 'reason': 'no_title'})
            continue
        if _norm_header(display) in header_labels:      # 重複出現的標題列
            skipped.append({'sheet': sheet_title, 'row': offset, 'reason': 'repeated_header'})
            continue

        raw_date = _cell(row, columns, 'scheduled')
        scheduled, precision = parse_date(raw_date, year)
        actual_raw = _cell(row, columns, 'actual')
        actual, _ = parse_date(actual_raw, year) if actual_raw else (None, 'unknown')
        if actual:
            precision = 'day'
        status_raw = _cell(row, columns, 'status')
        status = STATUS_MAP.get(status_raw, 'unknown')
        explicit = _cell(row, columns, 'id')
        product = _cell(row, columns, 'product')
        keywords = _split_keywords(_cell(row, columns, 'keywords'))
        url = _cell(row, columns, 'officialUrl')
        # id 用「主題（簡稱）優先」：以前只有簡稱時 id 就是用簡稱算的，補上完整標題後 id 不變
        norm_title = pm.normalize_title(topic or display)

        content = {
            'title': display, 'topic': topic, 'officialTitle': official, 'englishTitle': _cell(row, columns, 'englishTitle'),
            'type': _cell(row, columns, 'type'), 'product': product, 'keywords': keywords,
            'officialUrl': url, 'rawDate': raw_date, 'scheduledDate': scheduled,
            'actualReleaseDate': actual, 'status': status, 'explicitPressReleaseId': explicit or None,
        }
        if explicit:
            doc_id = _safe_id(explicit)
        else:
            identity = '|'.join([spreadsheet_id, str(year), norm_title, pm.norm_text(raw_date)])
            doc_id = 'pr_' + hashlib.sha1(identity.encode('utf-8')).hexdigest()[:24]
        base_id = doc_id
        seen_ids[base_id] = seen_ids.get(base_id, 0) + 1
        if seen_ids[base_id] > 1:                     # 同一分頁內完全相同的列：加序號，不互相覆蓋
            skipped.append({'sheet': sheet_title, 'row': offset, 'reason': 'duplicate_row'})
            doc_id = f'{base_id}_{seen_ids[base_id]}'

        derived = sorted(set(keywords) | pm.alnum_tokens(product) | pm.strong_tokens(pm.alnum_tokens(display)))
        records.append({
            'id': doc_id,
            'sourceSpreadsheetId': spreadsheet_id,
            'sourceSheet': sheet_title,
            'sourceYear': year,
            'sourceRow': offset,
            'normalizedTitle': norm_title,
            'datePrecision': precision,
            'keywords': derived,
            'active': True,
            **content,
            'sourceFingerprint': _fingerprint(content),
        })
    return {'records': records, 'skipped': skipped, 'headerRow': header_index + 1, 'fields': sorted(columns)}


# ═══════════════════════════════════════════════════════════
# 唯讀取得來源
# ═══════════════════════════════════════════════════════════
def fetch_source(sheets, spreadsheet_id=SPREADSHEET_ID):
    """讀 metadata → 只處理 20xx 分頁 → 解析。任何失敗都拋 SyncAbort（呼叫端不得寫入）。"""
    props = sheets.get_metadata()
    year_sheets = [p['title'] for p in props if YEAR_SHEET.match(p.get('title', ''))]
    ignored = [p.get('title') for p in props if not YEAR_SHEET.match(p.get('title', ''))]
    for name in ignored:
        print(f'ℹ 忽略非年度分頁：{name}')
    if not year_sheets:
        raise SyncAbort('找不到名稱為 20xx 的年度分頁，已停止同步')
    sheets_out, records, skipped = {}, [], []
    for title in sorted(year_sheets, reverse=True):
        parsed = parse_sheet(title, sheets.get_values(title), spreadsheet_id)
        sheets_out[title] = {'rows': len(parsed['records']), 'headerRow': parsed['headerRow'], 'fields': parsed['fields']}
        records.extend(parsed['records'])
        skipped.extend(parsed['skipped'])
    return {'records': records, 'skipped': skipped, 'sheets': sheets_out, 'ignoredSheets': ignored}


# ═══════════════════════════════════════════════════════════
# 計畫（純函式：dry-run 只做到這裡）
# ═══════════════════════════════════════════════════════════
MAX_DEACTIVATE_RATIO = 0.5
MIN_EXISTING_FOR_RATIO_GUARD = 6


def plan_press_releases(parsed_records, existing):
    """existing：{doc_id: dict}。回傳 created/updated/unchanged/deactivated 的 id 清單與要寫的內容；高風險時拋 SyncAbort。"""
    existing_active = {k for k, v in existing.items() if v.get('active', True)}
    if not parsed_records and existing_active:
        raise SyncAbort('Sheet 解析結果是空的，但資料庫已有有效新聞稿；視為異常，不覆蓋')
    parsed_ids = {r['id'] for r in parsed_records}
    to_deactivate = sorted(existing_active - parsed_ids)
    if (len(existing_active) >= MIN_EXISTING_FOR_RATIO_GUARD
            and len(to_deactivate) > len(existing_active) * MAX_DEACTIVATE_RATIO):
        raise SyncAbort(
            f'本次會停用 {len(to_deactivate)}/{len(existing_active)} 筆既有新聞稿，超過安全上限，已停止同步')

    created, updated, unchanged = [], [], []
    for rec in parsed_records:
        old = existing.get(rec['id'])
        if old is None:
            created.append(rec)
        elif (old.get('sourceFingerprint') != rec['sourceFingerprint'] or old.get('sourceRow') != rec['sourceRow']
              or not old.get('active', True) or old.get('sourceSheet') != rec['sourceSheet']):
            updated.append(rec)
        else:
            unchanged.append(rec)
    return {'created': created, 'updated': updated, 'unchanged': unchanged, 'deactivate': to_deactivate}


def _to_day(value):
    if value is None:
        return None
    if hasattr(value, 'astimezone'):
        from zoneinfo import ZoneInfo
        return value.astimezone(ZoneInfo('Asia/Taipei')).date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def decide_exposure(exposure, prs_by_id, prepared):
    """
    單筆曝光的配對決策。回傳 (動作, 結果 dict)：
      ('skip_confirmed', None)  人工確認，不動
      ('keep', None)            已有仍有效的配對，保留
      ('match', result)         新的配對結果
    """
    status = exposure.get('matchStatus')
    existing_id = exposure.get('pressReleaseId')
    if status == pm.STATUS_CONFIRMED or (existing_id and not status):
        return 'skip_confirmed', None
    # 自動配對（auto_matched）每次依最新規則與稿單重算——規則是確定性的，結果穩定；只有人工確認不動
    ex = {
        'title': exposure.get('title'), 'link': exposure.get('link'),
        'campaignId': exposure.get('campaignId'), 'day': _to_day(exposure.get('exposureDate')),
    }
    return 'match', pm.match_exposure(ex, prepared)


MATCH_FIELDS = ('pressReleaseId', 'pressReleaseTitle', 'matchStatus', 'matchMethod', 'matchConfidence',
                'suggestedPressReleaseId', 'suggestedPressReleaseTitle')


def plan_matches(exposures, press_releases):
    """
    exposures：list of dict（含 id）；press_releases：同步後的有效新聞稿（list of dict）。
    回傳 updates（每筆曝光最多一個，含配對欄位 fields 與分類欄位 classFields）與統計。
    配對與分類各自獨立計算；人工確認的配對（confirmed）與人工分類（coverageClassMethod=manual）都不會被覆蓋。
    """
    usable = [p for p in press_releases if p.get('active', True) and p.get('status') != 'cancelled']
    prepared = [pm.prepare_press_release(p) for p in usable]
    prs_by_id = {p['id']: p for p in prepared}
    updates, classified = {}, {}
    counts = {'confirmed': 0, 'auto_matched': 0, 'suggested': 0, 'unmatched': 0, 'changed': 0,
              'classProtected': 0, 'classChanged': 0, 'classErrors': 0,
              'classes': {k: 0 for k in cc.CLASS_LABELS}}
    for exp in exposures:
        action, result = decide_exposure(exp, prs_by_id, prepared)
        final_status, final_conf, reason = exp.get('matchStatus'), exp.get('matchConfidence'), None
        match_fields = None
        if action == 'skip_confirmed':
            counts['confirmed'] += 1
            final_status = pm.STATUS_CONFIRMED
        elif action == 'keep':
            counts['auto_matched'] += 1
            final_status = pm.STATUS_AUTO
            # 稿單補了完整標題：只更新顯示用的新聞稿名稱，配對本身不動
            display = prs_by_id[exp['pressReleaseId']]['_display']
            if display and display != exp.get('pressReleaseTitle'):
                match_fields = {'pressReleaseTitle': display}
        else:
            counts[result['matchStatus']] += 1
            final_status, final_conf, reason = result['matchStatus'], result['matchConfidence'], result.get('reason')
            new = {k: result[k] for k in MATCH_FIELDS}
            if new != {k: exp.get(k) for k in MATCH_FIELDS}:
                match_fields = new

        class_fields = None
        if cc.is_manual(exp):
            counts['classProtected'] += 1
            counts['classes'][exp['coverageClass']] = counts['classes'].get(exp['coverageClass'], 0) + 1
        else:
            try:
                cls = cc.classify_exposure(exp, final_status, final_conf, reason)
            except Exception as exc:                  # 單筆分類失敗：保留既有分類，不影響其他筆
                print(f"⚠ 分類失敗（保留既有分類）：{exp.get('id')} {type(exc).__name__}")
                counts['classErrors'] += 1
                cls = None
            if cls:
                classified[exp['id']] = cls
                counts['classes'][cls['coverageClass']] += 1
                if cc.class_changed(exp, cls):
                    class_fields = cls
                    counts['classChanged'] += 1
        if match_fields or class_fields:
            updates[exp['id']] = {'id': exp['id'], 'fields': match_fields or {}, 'classFields': class_fields or {}, 'reason': reason}
            if match_fields:
                counts['changed'] += 1
    return {'updates': list(updates.values()), 'counts': counts, 'classified': classified}


def build_plan(parsed, existing, exposures):
    pr_plan = plan_press_releases(parsed['records'], existing)
    # 配對用「同步後」的狀態：本次解析出的有效新聞稿（被停用的不參與）
    matches = plan_matches(exposures, parsed['records'])
    incomplete = [r for r in parsed['records'] if r['datePrecision'] != 'day']
    titles = {}
    for r in parsed['records']:
        titles.setdefault(r['normalizedTitle'], []).append((r['sourceSheet'], r['sourceRow']))
    return {
        'press': pr_plan, 'matches': matches,
        'report': {
            'read': len(parsed['records']),
            'created': len(pr_plan['created']), 'updated': len(pr_plan['updated']),
            'unchanged': len(pr_plan['unchanged']), 'deactivated': len(pr_plan['deactivate']),
            'dateIncomplete': len(incomplete), 'skippedRows': len(parsed['skipped']),
            'duplicateTitles': sum(1 for v in titles.values() if len(v) > 1),
            'confirmed': matches['counts']['confirmed'], 'autoMatched': matches['counts']['auto_matched'],
            'suggested': matches['counts']['suggested'], 'unmatched': matches['counts']['unmatched'],
            'matchUpdates': matches['counts']['changed'],
            'classes': matches['counts']['classes'], 'classUpdates': matches['counts']['classChanged'],
            'classProtected': matches['counts']['classProtected'], 'classErrors': matches['counts']['classErrors'],
            'classificationVersion': cc.CLASSIFICATION_VERSION,
            'sheets': {k: v['rows'] for k, v in parsed['sheets'].items()},
        },
    }


# ═══════════════════════════════════════════════════════════
# 寫入
# ═══════════════════════════════════════════════════════════
def _commit_in_chunks(db, operations):
    for start in range(0, len(operations), BATCH_LIMIT):
        batch = db.batch()
        for fn in operations[start:start + BATCH_LIMIT]:
            fn(batch)
        batch.commit()


def load_existing_press_releases(db):
    return {d.id: d.to_dict() for d in db.collection(PRESS_COLLECTION).stream()}


def load_exposures(db):
    keep = ('title', 'link', 'campaignId', 'exposureDate') + MATCH_FIELDS + ('matchedAt',) + cc.CLASS_FIELDS
    out = []
    for d in db.collection(EXPOSURE_COLLECTION).stream():
        data = d.to_dict() or {}
        out.append({'id': d.id, **{k: data.get(k) for k in keep}})
    return out


def apply_plan(db, plan, run_id, server_ts=None, now=None):
    """寫入新聞稿與配對。confirmed 不會出現在 updates 裡；配對只寫 MATCH_FIELDS＋matchedAt。"""
    from firebase_admin import firestore
    server_ts = server_ts or firestore.SERVER_TIMESTAMP
    now = now or datetime.now(timezone.utc)
    col = db.collection(PRESS_COLLECTION)
    ops = []
    for rec in plan['press']['created'] + plan['press']['updated']:
        doc = {**rec, 'syncedAt': server_ts, 'syncRunId': run_id}
        ops.append(lambda b, r=rec, d=doc: b.set(col.document(r['id']), d))
    for doc_id in plan['press']['deactivate']:
        ops.append(lambda b, i=doc_id: b.set(
            col.document(i), {'active': False, 'deactivatedAt': server_ts, 'syncRunId': run_id}, merge=True))
    _commit_in_chunks(db, ops)

    exp_col = db.collection(EXPOSURE_COLLECTION)
    ops = []
    for upd in plan['matches']['updates']:
        fields = dict(upd['fields'])
        if fields:
            fields['matchedAt'] = now
        if upd.get('classFields'):
            fields.update(upd['classFields'])
            fields['classifiedAt'] = now
        ops.append(lambda b, i=upd['id'], f=fields: b.set(exp_col.document(i), f, merge=True))
    _commit_in_chunks(db, ops)


def run_sync(db, sheets, dry_run=False, run_id=None, now=None):
    """完整同步。dry_run=True：只讀 Sheet 與 Firestore，零寫入，回傳報告。"""
    now = now or datetime.now(timezone.utc)
    run_id = run_id or now.strftime('%Y%m%dT%H%M%SZ')
    parsed = fetch_source(sheets)                 # 失敗 → SyncAbort，下面都不會執行
    existing = load_existing_press_releases(db)
    exposures = load_exposures(db)
    plan = build_plan(parsed, existing, exposures)
    report = {**plan['report'], 'runId': run_id, 'dryRun': dry_run}
    if dry_run:
        return report
    apply_plan(db, plan, run_id, now=now)
    from firebase_admin import firestore
    db.collection(JOB_STATUS_DOC[0]).document(JOB_STATUS_DOC[1]).set({
        'lastSyncAt': firestore.SERVER_TIMESTAMP,
        'report': {k: v for k, v in report.items() if k != 'sheets'},
        'sheets': report['sheets'],
    }, merge=True)
    print('✅ 新聞稿同步完成：' + json.dumps(report, ensure_ascii=False))
    return report
