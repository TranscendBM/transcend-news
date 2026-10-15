"""
topic_cluster_store：topic_cluster_job 的 Firestore 讀寫：把近期新增／變更的新聞聚進 news_topics。

- 不改動 news 文件（不寫 topicId 到新聞上：那會讓每個正在監聽最新 300 則的瀏覽器多讀一次）；
  文章與話題的對應存在 news_topics.articleIds，話題文件自帶文章快照，事件中心只讀 news_topics。
- 只處理 fetchedAt 在水位線之後的文章（新增／變更），每次最多 MAX_NEW_PER_RUN 篇，超過的下次繼續。
- 任何讀取失敗都中止、不寫入（不產生空話題、不清除既有話題）；寫入成功後才推進水位線。
- 既有話題的 id 永遠不變；不合併既有話題；已是成員的文章不重算（冪等）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import topic_cluster as tc

NEWS = 'news'
TOPICS = 'news_topics'
STATE_DOC = ('meta', 'topic_cluster_state')
LOCK_NAME = 'topic_cluster'
MAX_NEW_PER_RUN = 500
RECENT_NEWS_DAYS = 7
TOPIC_LOOKBACK_DAYS = 8
WATERMARK_OVERLAP = timedelta(minutes=15)
BATCH_LIMIT = 200          # 每筆話題文件可能有數十 KB；批次不必到 500


class ClusterAbort(Exception):
    """無法安全進行（讀取失敗等）；不寫入任何東西。"""


def _ts(value):
    return tc.to_dt(value)


def load_state(db):
    snap = db.collection(STATE_DOC[0]).document(STATE_DOC[1]).get()
    data = snap.to_dict() if getattr(snap, 'exists', False) else {}
    return data or {}


def load_candidate_articles(db, since, limit):
    """fetchedAt >= since 的新聞（升冪），最多 limit 筆。單一欄位索引（自動），不需要複合索引。"""
    q = db.collection(NEWS).where('fetchedAt', '>=', since).order_by('fetchedAt').limit(limit)
    out = []
    for doc in q.stream():
        data = doc.to_dict() or {}
        out.append({'id': data.get('id') or doc.id, 'fetchedAt': data.get('fetchedAt'), **{
            k: data.get(k) for k in ('title', 'link', 'pubDate', 'sentiment', 'cat', 'mediaName', 'sourceName')}})
    return out


def load_topics(db, since):
    q = db.collection(TOPICS).where('lastPublishedAt', '>=', since)
    return [{**(d.to_dict() or {}), 'id': d.id} for d in q.stream()]


def plan_run(articles, topic_docs, now):
    """
    純函式：回傳 {'upserts': [doc…], 'assigned': int, 'newTopics': int, 'joined': int, 'skipped': int, 'assignments': {...}}。
    articles 已排除過舊的；已在話題裡的文章會被略過。
    """
    clusters = tc.clusters_from_topics(topic_docs)
    existing_ids = {c.id for c in clusters}
    before_members = {c.id: c.member_ids for c in clusters}
    clusters, assignments = tc.assign_articles(articles, clusters)
    upserts = []
    for cl in clusters:
        prev = cl.doc if cl.existing else None
        if cl.existing and not cl.dirty:
            # 沒有新成員：只在 24 小時指標有變化時更新（聲量變化率會隨時間移動）
            new_doc = tc.build_topic_doc(cl, now, prev)
            if tc.doc_changed(prev, new_doc):
                upserts.append(new_doc)
            continue
        upserts.append(tc.build_topic_doc(cl, now, prev))
    joined = sum(1 for a in assignments.values() if a['method'] == 'rule')
    return {
        'upserts': upserts, 'assignments': assignments, 'joined': joined,
        'newTopics': sum(1 for c in clusters if c.id not in existing_ids),
        'assigned': len(assignments), 'skipped': len(articles) - len(assignments),
        'touchedExisting': sum(1 for c in clusters if c.id in existing_ids and c.member_ids != before_members.get(c.id)),
    }


def write_topics(db, docs, server_ts):
    col = db.collection(TOPICS)
    for start in range(0, len(docs), BATCH_LIMIT):
        batch = db.batch()
        for doc in docs[start:start + BATCH_LIMIT]:
            batch.set(col.document(doc['id']), {**doc, 'updatedAt': server_ts})
        batch.commit()


def run_topic_cluster(db, now=None, dry_run=False, max_new=MAX_NEW_PER_RUN, server_ts=None):
    now = now or datetime.now(timezone.utc)
    try:
        state = load_state(db)
        mark = _ts(state.get('watermark'))
        floor = now - timedelta(days=RECENT_NEWS_DAYS)
        since = max(floor, (mark - WATERMARK_OVERLAP) if mark else floor)
        raw = load_candidate_articles(db, since, max_new + 1)
        topic_docs = load_topics(db, now - timedelta(days=TOPIC_LOOKBACK_DAYS))
    except Exception as exc:
        raise ClusterAbort(f'讀取失敗，本次不寫入：{type(exc).__name__}: {exc}') from exc

    more = len(raw) > max_new
    raw = raw[:max_new]
    recent_cut = now - timedelta(days=RECENT_NEWS_DAYS)
    articles = [a for a in raw if (_ts(a.get('pubDate')) or recent_cut) >= recent_cut and a.get('title')]
    plan = plan_run(articles, topic_docs, now)
    last_fetched = max((_ts(a.get('fetchedAt')) for a in raw if _ts(a.get('fetchedAt'))), default=None)
    report = {
        'considered': len(raw), 'clustered': plan['assigned'], 'newTopics': plan['newTopics'], 'joined': plan['joined'],
        'skippedAlreadyAssigned': plan['skipped'], 'topicWrites': len(plan['upserts']), 'hasMore': more,
        'existingTopicsLoaded': len(topic_docs), 'algorithmVersion': tc.ALGORITHM_VERSION, 'dryRun': dry_run,
        'estimatedReads': len(raw) + len(topic_docs) + 1, 'estimatedWrites': len(plan['upserts']) + (0 if dry_run else 1),
    }
    if dry_run:
        return report, plan
    if plan['upserts']:
        from firebase_admin import firestore
        write_topics(db, plan['upserts'], server_ts or firestore.SERVER_TIMESTAMP)
    # 寫入成功之後才推進水位線；還有更多就只推進到本批最後一筆
    if last_fetched is not None:
        db.collection(STATE_DOC[0]).document(STATE_DOC[1]).set(
            {'watermark': last_fetched, 'updatedAt': now, 'lastReport': {k: v for k, v in report.items() if k != 'dryRun'}}, merge=True)
    try:
        from firebase_admin import firestore
        db.collection('job_status').document('topic_cluster').set(
            {'lastRunAt': firestore.SERVER_TIMESTAMP, 'report': {k: v for k, v in report.items() if k != 'dryRun'}}, merge=True)
    except Exception:
        pass
    print('✅ 話題聚類完成：' + str(report))
    return report, plan
