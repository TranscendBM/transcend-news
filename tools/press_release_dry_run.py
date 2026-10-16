"""
新聞稿主檔同步 dry-run：只讀、零寫入。

  python tools/press_release_dry_run.py --sheet-json fixture.json          # 離線版面（{"2026": [[…rows…]], …}）
  python tools/press_release_dry_run.py --api                              # 用 ADC 唯讀讀 Google Sheet

曝光資料預設從 Firestore REST 讀公開集合 media_exposure（規則本來就公開唯讀，不需要憑證）；
也可用 --exposures-json 指定本機檔。已存在的 press_releases（內部集合）只有 --api 且本機有 ADC 時才會讀，
否則視為空（等於「第一次同步」）。

輸出：解析統計、日期不完整的稿、可能重複的標題、配對統計與逐筆配對（只印標題與配對方式）。
絕不輸出「備註」欄（解析器根本不讀）。
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import press_release_sync as ps  # noqa: E402

REST = 'https://firestore.googleapis.com/v1/projects/transcend-news-tbm/databases/(default)/documents/media_exposure'


def _value(v):
    if 'stringValue' in v:
        return v['stringValue']
    if 'timestampValue' in v:
        return datetime.fromisoformat(v['timestampValue'].replace('Z', '+00:00'))
    if 'nullValue' in v:
        return None
    for key in ('integerValue', 'doubleValue', 'booleanValue'):
        if key in v:
            return v[key]
    return None


def read_public_exposures():
    out, token = [], ''
    while True:
        url = REST + '?pageSize=300' + (f'&pageToken={token}' if token else '')
        with urlopen(url, timeout=30) as resp:          # noqa: S310 — 固定的 Firestore REST 網址
            data = json.load(resp)
        for doc in data.get('documents', []):
            fields = {k: _value(v) for k, v in doc.get('fields', {}).items()}
            out.append({'id': doc['name'].rsplit('/', 1)[-1], **fields})
        token = data.get('nextPageToken')
        if not token:
            return out


class FileSheets:
    def __init__(self, path):
        self.tabs = json.loads(Path(path).read_text(encoding='utf-8'))

    def get_metadata(self):
        return [{'title': t} for t in self.tabs]

    def get_values(self, title):
        return self.tabs[title]


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--sheet-json')
    src.add_argument('--api', action='store_true')
    ap.add_argument('--exposures-json')
    ap.add_argument('--verbose', action='store_true')
    ap.add_argument('--samples', default='6')
    args = ap.parse_args()

    sheets = FileSheets(args.sheet_json) if args.sheet_json else ps.SheetsClient()
    parsed = ps.fetch_source(sheets)
    if args.exposures_json:
        raw = json.loads(Path(args.exposures_json).read_text(encoding='utf-8'))
        exposures = [{**r, 'exposureDate': datetime.fromisoformat(r['exposureDate'])} for r in raw]
    else:
        exposures = read_public_exposures()
    plan = ps.build_plan(parsed, {}, exposures)

    print('== 來源 ==')
    print(json.dumps({'sheets': parsed['sheets'], 'ignoredSheets': parsed['ignoredSheets'],
                      'skippedRows': parsed['skipped']}, ensure_ascii=False, indent=1))
    print('== 報告（dry-run，零寫入）==')
    print(json.dumps(plan['report'], ensure_ascii=False, indent=1))
    print('== 曝光分類（coverageClass，與配對狀態分開）==')
    classified = plan['matches']['classified']
    by_class = {}
    for exp in exposures:
        cls = classified.get(exp['id'])
        if cls:
            by_class.setdefault(cls['coverageClass'], []).append((exp, cls))
    undecidable = sum(1 for _, c in sum(by_class.values(), []) if c['coverageClassMethod'] == 'fallback')
    print(json.dumps({'總文件數': len(exposures), **{k: len(v) for k, v in by_class.items()},
                      'review': len(by_class.get('review', [])), '規則無法判定(fallback)': undecidable,
                      '預計更新文件數': len(plan['matches']['updates']),
                      '其中分類欄位變動': plan['matches']['counts']['classChanged'],
                      '人工分類受保護': plan['matches']['counts']['classProtected'],
                      '人工確認配對（不會被覆蓋）': plan['matches']['counts']['confirmed'],
                      '刪除': 0}, ensure_ascii=False, indent=1))
    per = int(args.samples)
    for name, items in by_class.items():
        print(f'-- {name}（代表案例 {per} 筆）')
        for exp, cls in items[:per]:
            print(f"   [{cls['coverageClassMethod']:19} {cls['coverageClassConfidence']:.2f}] {','.join(cls['coverageClassReasons']):32} {str(exp.get('title'))[:50]!r}")
    print('== 日期不完整（只列標題、列號）==')
    for r in parsed['records']:
        if r['datePrecision'] != 'day':
            print(f"  {r['sourceSheet']} 第{r['sourceRow']}列 [{r['datePrecision']}] raw={r['rawDate']!r} {r['title']}")
    titles = {}
    for r in parsed['records']:
        titles.setdefault(r['normalizedTitle'], []).append(f"{r['sourceSheet']}#{r['sourceRow']}({r['scheduledDate']})")
    print('== 可能重複的標題（同名；通常是每月營收這類重複型）==')
    for t, where in titles.items():
        if len(where) > 1:
            print(f'  {t}: {", ".join(where)}')
    by_id = {r['id']: r for r in parsed['records']}
    ex_by_id = {e['id']: e for e in exposures}
    print('== 配對結果 ==')
    for upd in plan['matches']['updates']:
        f = upd['fields']
        e = ex_by_id[upd['id']]
        target = f['pressReleaseTitle'] or f['suggestedPressReleaseTitle'] or '-'
        if args.verbose or f['matchStatus'] != 'unmatched':
            print(f"  [{f['matchStatus']:12}] {f['matchMethod'] or upd['reason'] or '':24} {str(e.get('title'))[:40]!r} -> {target[:30]!r} | {f.get('matchReason') or ''}")
    unmatched = [u for u in plan['matches']['updates'] if u['fields']['matchStatus'] == 'unmatched']
    print(f'  （未配對 {len(unmatched)} 筆；加 --verbose 全部列出）')
    _ = by_id, timezone


if __name__ == '__main__':
    main()
