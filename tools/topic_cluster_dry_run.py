"""
話題聚類 dry-run：只讀、零寫入。從 Firestore 公開的 news 集合（規則本來就公開唯讀，不需要憑證）
讀近期新聞，在記憶體裡聚類並印出統計與抽查樣本。

  python tools/topic_cluster_dry_run.py --days 7 --limit 1500 [--samples 8] [--dump out.json]

輸出：處理新聞數、話題數、平均篇數、最大話題、單篇話題數、低信心話題、可能錯誤合併（內聚力最低）、
可能該合併而沒合併（標題很像但被規則擋下，附原因）、預計 Firestore 讀寫數。
"""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import topic_cluster as tc  # noqa: E402
import topic_cluster_store as job  # noqa: E402

RUN = 'https://firestore.googleapis.com/v1/projects/transcend-news-tbm/databases/(default)/documents:runQuery'


def _val(v):
    if 'stringValue' in v:
        return v['stringValue']
    if 'timestampValue' in v:
        return datetime.fromisoformat(v['timestampValue'].replace('Z', '+00:00'))
    for k in ('integerValue', 'doubleValue', 'booleanValue'):
        if k in v:
            return v[k]
    return None


def read_news(days, limit):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
    body = {'structuredQuery': {
        'from': [{'collectionId': 'news'}],
        'where': {'fieldFilter': {'field': {'fieldPath': 'pubDate'}, 'op': 'GREATER_THAN_OR_EQUAL', 'value': {'timestampValue': since}}},
        'orderBy': [{'field': {'fieldPath': 'pubDate'}, 'direction': 'DESCENDING'}],
        'limit': limit}}
    req = Request(RUN, data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=60) as resp:      # noqa: S310 — 固定的 Firestore REST 網址
        rows = json.load(resp)
    out = []
    for row in rows:
        doc = row.get('document')
        if not doc:
            continue
        f = {k: _val(v) for k, v in doc['fields'].items()}
        out.append({'id': f.get('id') or doc['name'].rsplit('/', 1)[-1], **{
            k: f.get(k) for k in ('title', 'link', 'pubDate', 'sentiment', 'cat', 'mediaName', 'sourceName')}})
    return out


def cohesion(members):
    if len(members) < 2:
        return 1.0
    total, n = 0.0, 0
    for i, a in enumerate(members):
        for b in members[i + 1:]:
            total += tc._dice(a['tokens'], b['tokens'])
            n += 1
    return total / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--limit', type=int, default=1500)
    ap.add_argument('--samples', type=int, default=8)
    ap.add_argument('--dump')
    args = ap.parse_args()

    news = read_news(args.days, args.limit)
    now = datetime.now(timezone.utc)
    clusters = []
    clusters, assignments = tc.assign_articles(news, clusters)
    docs = [tc.build_topic_doc(c, now) for c in clusters]
    sizes = sorted((d['articleCount'] for d in docs), reverse=True)
    singles = sum(1 for s in sizes if s == 1)
    multi = [d for d in docs if d['articleCount'] > 1]
    low = [d for d in docs if d['needsReview'] or d['confidence'] < 0.6]
    print('== 統計（dry-run，零寫入）==')
    print(json.dumps({
        '讀取新聞數': len(news), '處理(聚類)篇數': len(assignments), '話題數': len(docs),
        '平均每話題篇數': round(len(assignments) / max(len(docs), 1), 2), '最大話題篇數': sizes[0] if sizes else 0,
        '單篇話題數': singles, '多篇話題數': len(multi), '低信心話題數': len(low),
        '預計 Firestore 讀取': len(news) + 1, '預計 Firestore 寫入(話題文件)': len(docs) + 1,
        '演算法版本': tc.ALGORITHM_VERSION, '刪除': 0}, ensure_ascii=False, indent=1))

    by_id = {c.id: c for c in clusters}
    print('\n== 最大的話題 ==')
    for d in sorted(docs, key=lambda d: -d['articleCount'])[:args.samples]:
        print(f"  [{d['articleCount']:3}篇/{d['mediaCount']}媒體 重要{d['importanceScore']:3} {d['eventType']:10}] {d['title'][:46]} | {','.join(d['companies'][:4])}")

    print('\n== 可能錯誤合併（內聚力最低的多篇話題）==')
    ranked = sorted(((cohesion(by_id[d['id']].members), d) for d in multi), key=lambda x: x[0])
    for coh, d in ranked[:args.samples]:
        titles = [m['title'][:30] for m in by_id[d['id']].members[:3]]
        print(f"  coh={coh:.2f} {d['articleCount']}篇 {titles}")

    print('\n== 可能該合併而沒合併（標題相似但被規則擋下／分數不足的跨話題配對）==')
    firsts = sorted(clusters, key=lambda c: c.members[0]['time'])
    misses, reasons = [], {}
    for i, a in enumerate(firsts):
        fa = a.members[0]
        for b in firsts[i + 1:i + 120]:
            fb = b.members[0]
            sim = tc._dice(fa['tokens'], fb['tokens'])
            if sim < 0.45:
                continue
            block = tc.blocked_reason(fa, fb, sim)
            score, why = tc.pair_score(fa, fb)
            if block or (0.3 <= score < tc.MERGE_THRESHOLD):
                reasons[block or 'low_score'] = reasons.get(block or 'low_score', 0) + 1
                misses.append((sim, block or f'score={score}', fa['title'][:28], fb['title'][:28]))
    print('  原因統計：', json.dumps(reasons, ensure_ascii=False))
    for sim, why, ta, tb in sorted(misses, reverse=True)[:args.samples]:
        print(f'  sim={sim:.2f} {why}: {ta!r} / {tb!r}')

    print('\n== 抽查：多篇話題樣本（依重要性）==')
    for d in sorted(multi, key=lambda d: -d['importanceScore'])[:args.samples]:
        print(f"  ({d['articleCount']}篇) {d['title'][:50]} | 重要{d['importanceScore']} 原因: {'; '.join(d['importanceReasons'][:3])}")
        for m in by_id[d['id']].members[:4]:
            print(f"      - {m['media'][:6]:6} {m['title'][:56]}")
    if args.dump:
        Path(args.dump).write_text(json.dumps(
            [{'id': d['id'], 'title': d['title'], 'n': d['articleCount'], 'articles': [a['title'] for a in d['articles']]} for d in docs],
            ensure_ascii=False, indent=1), encoding='utf-8')
    _ = job


if __name__ == '__main__':
    main()
