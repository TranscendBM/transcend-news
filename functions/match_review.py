"""
人工覆核：用同一份 Google Sheet 的「曝光配對覆核」分頁，把人工決策同步回 media_exposure（純函式，不碰網路／Firestore）。

為什麼用 Google Sheet：正式網站是公開唯讀，不能開放 Firestore 公開寫入，也不能把管理權限放到前端；
Sheet 本來就是同事維護新聞稿稿單的地方，同步工作（唯讀、Admin SDK）負責把決策寫進資料庫。

分頁欄位（依欄位名稱尋找，順序可以不同）：
  exposureId      曝光文件 ID（網站「待確認配對」匯出的 Excel 第一欄）
  decision        confirm（確認目前建議配對）｜rematch（人工指定另一篇）｜reject（不屬於任何新聞稿衍生曝光）
                  也接受中文：確認／改配／排除
  pressReleaseId  confirm 可省略（用目前建議）；rematch 必填；reject 不用
  note            選填。只是給人看的備註——程式不讀取、不寫入、不顯示。

fail closed：未知 exposureId、未知 pressReleaseId、不認得的 decision、同一筆曝光有互相矛盾的決策、
confirm 指定的新聞稿與目前建議不同……任何一項不合格，整次同步中止、不寫入任何東西。
沒有這個分頁或分頁是空的：沒有任何人工決策，既有同步照常運作。
"""

from __future__ import annotations

import re
import unicodedata

REVIEW_SHEET_TITLE = '曝光配對覆核'
MANUAL_SOURCE = 'google_sheet_review'
MAX_ERRORS_SHOWN = 8

DECISIONS = {
    'confirm': 'confirm', '確認': 'confirm',
    'rematch': 'rematch', '改配': 'rematch', '重新配對': 'rematch',
    'reject': 'reject', '排除': 'reject', '拒絕': 'reject',
}
HEADER_ALIASES = {
    'exposureId': ['exposureid', '曝光id', '曝光編號', '曝光 id'],
    'decision': ['decision', '決定', '決策', '覆核決定'],
    'pressReleaseId': ['pressreleaseid', '新聞稿id', '新聞稿編號', '新聞稿 id'],
}
# 認得但永遠不讀取內容的欄位
IGNORED_HEADERS = {'note', 'notes', '備註', '備註說明', '覆核備註'}
HEADER_SCAN_ROWS = 4


class ReviewError(Exception):
    """覆核資料不合格（呼叫端要中止同步）。訊息不包含任何備註內容。"""


def _norm(value) -> str:
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or ''))).strip()


_ALIASES = {_norm(a).lower(): field for field, aliases in HEADER_ALIASES.items() for a in aliases}


def _find_header(rows):
    for index, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        columns = {}
        for col, cell in enumerate(row):
            field = _ALIASES.get(_norm(cell).lower())
            if field and field not in columns:
                columns[field] = col
        if 'exposureId' in columns and 'decision' in columns:
            return index, columns
    return None, {}


def parse_review_rows(rows):
    """→ [{'row','exposureId','decision','pressReleaseId'}]（已去除完全重複的列）；格式或決策不合格拋 ReviewError。"""
    if not rows or not any(any(str(c or '').strip() for c in row) for row in rows):
        return []                                       # 沒有任何內容 → 沒有人工決策
    header_index, columns = _find_header(rows)
    if header_index is None:
        raise ReviewError(f'「{REVIEW_SHEET_TITLE}」分頁找不到標題列（需要 exposureId 與 decision 欄），已停止同步')
    problems, parsed = [], {}
    for offset, row in enumerate(rows[header_index + 1:], start=header_index + 2):
        cell = lambda field: _norm(row[columns[field]]) if field in columns and columns[field] < len(row) else ''  # noqa: E731
        exposure_id, raw_decision, pr_id = cell('exposureId'), cell('decision'), cell('pressReleaseId')
        if not (exposure_id or raw_decision or pr_id):
            continue
        if not exposure_id:
            problems.append(f'第 {offset} 列缺少 exposureId')
            continue
        decision = DECISIONS.get(raw_decision.lower()) or DECISIONS.get(raw_decision)
        if decision is None:
            problems.append(f'第 {offset} 列的 decision 不是 confirm／rematch／reject')
            continue
        key = (decision, pr_id if decision != 'reject' else '')
        if exposure_id in parsed:
            if parsed[exposure_id]['key'] != key:
                problems.append(f'第 {offset} 列與前面的決策互相矛盾（同一筆曝光 {exposure_id}）')
            continue
        parsed[exposure_id] = {'row': offset, 'exposureId': exposure_id, 'decision': decision, 'pressReleaseId': key[1], 'key': key}
    if problems:
        raise ReviewError('覆核分頁有問題：' + '；'.join(problems[:MAX_ERRORS_SHOWN]) + ('…' if len(problems) > MAX_ERRORS_SHOWN else ''))
    return [{k: v for k, v in d.items() if k != 'key'} for d in parsed.values()]


def validate_decisions(decisions, exposures_by_id, press_releases_by_id):
    """檢查 ID 都存在、confirm 與目前建議一致。press_releases_by_id 只含「有效且未取消」的新聞稿。"""
    problems = []
    for d in decisions:
        exp = exposures_by_id.get(d['exposureId'])
        if exp is None:
            problems.append(f"第 {d['row']} 列的 exposureId 不存在")
            continue
        decision, pr_id = d['decision'], d['pressReleaseId']
        if decision == 'reject':
            continue
        if decision == 'rematch' and not pr_id:
            problems.append(f"第 {d['row']} 列 rematch 需要填 pressReleaseId")
            continue
        suggested = exp.get('suggestedPressReleaseId') or exp.get('pressReleaseId')
        if decision == 'confirm':
            if pr_id and suggested and pr_id != suggested:
                problems.append(f"第 {d['row']} 列 confirm 的新聞稿與目前建議不同（要改配請用 rematch）")
                continue
            pr_id = pr_id or suggested
            if not pr_id:
                problems.append(f"第 {d['row']} 列 confirm 沒有可確認的建議（請改用 rematch 並填 pressReleaseId）")
                continue
        if pr_id not in press_releases_by_id:
            problems.append(f"第 {d['row']} 列的 pressReleaseId 不存在或已取消")
    if problems:
        raise ReviewError('覆核決策無法套用：' + '；'.join(problems[:MAX_ERRORS_SHOWN]) + ('…' if len(problems) > MAX_ERRORS_SHOWN else ''))


def build_manual_fields(decisions, exposures_by_id, press_releases_by_id) -> dict:
    """決策 → {exposureId: 要寫入 media_exposure 的配對欄位}。只有狀態、方法、來源、新聞稿 ID／標題；沒有備註。"""
    out = {}
    for d in decisions:
        exp = exposures_by_id[d['exposureId']]
        if d['decision'] == 'reject':
            out[d['exposureId']] = {
                'pressReleaseId': None, 'pressReleaseTitle': None, 'matchStatus': 'rejected', 'matchMethod': 'manual_reject',
                'matchConfidence': 1.0, 'matchReason': '人工排除：不屬於任何新聞稿衍生曝光', 'matchSource': MANUAL_SOURCE,
                'suggestedPressReleaseId': None, 'suggestedPressReleaseTitle': None,
            }
            continue
        pr_id = d['pressReleaseId'] or exp.get('suggestedPressReleaseId') or exp.get('pressReleaseId')
        pr = press_releases_by_id[pr_id]
        out[d['exposureId']] = {
            'pressReleaseId': pr_id, 'pressReleaseTitle': pr.get('officialTitle') or pr.get('title') or pr.get('topic') or '',
            'matchStatus': 'confirmed', 'matchMethod': 'manual_rematch' if d['decision'] == 'rematch' else 'manual_confirm',
            'matchConfidence': 1.0, 'matchReason': '人工確認配對（Google Sheet 覆核）', 'matchSource': MANUAL_SOURCE,
            'suggestedPressReleaseId': None, 'suggestedPressReleaseTitle': None,
        }
    return out
