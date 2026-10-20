import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import { tagClass } from '../../components/tagStyles.js';
import { exportMatchReviewExcel } from '../../utils/formatting.js';
import { usePRState } from './prState.jsx';
import {
  MATCH_METHOD_LABELS, REVIEW_STATUSES, buildPressReleaseListRows, buildReviewRows, percentText, countReviewStatuses,
  filterReviewItems, reviewPressReleaseOptions, selectReviewItems, toPublicRecords,
} from './exposurePerformance.js';

// 待確認配對：把需要人工覆核的曝光集中在一處（建議配對、未配對、已人工確認、已人工排除）。
// 公開網站只讀、沒有任何確認／修改按鈕：覆核請在 Google Sheet「曝光配對覆核」分頁填 decision（confirm／rematch／reject），
// 每天排程（或手動執行）會同步回網站。這裡的「匯出待確認 Excel」前四欄就是那個分頁的欄位，複製貼上即可。

const STATUS_TONES = { suggested: 'amber', unmatched: 'gray', confirmed: 'green', rejected: 'red' };
const PAGE = 20;
const selectCls = 'min-w-0 max-w-full rounded-xl border border-gray-700/60 px-3 py-2 text-sm outline-none transition focus:border-red-700';
const btnCls = 'text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0';

export default function MatchReviewPanel({ records = [], status = 'ready', sync = null }) {
  const [filters, setFilters] = usePRState('exposure.review', { status: 'all', media: 'all', pressRelease: 'all', from: '', to: '', query: '' });
  const setFilter = (name, value) => setFilters(f => ({ ...f, [name]: value }));

  const items = useMemo(() => selectReviewItems(toPublicRecords(records)), [records]);
  const counts = useMemo(() => countReviewStatuses(items), [items]);
  const mediaOptions = useMemo(() => [...new Set(items.map(i => i.record.mediaName))].sort((a, b) => a.localeCompare(b, 'zh-Hant')), [items]);
  const prOptions = useMemo(() => reviewPressReleaseOptions(items), [items]);
  const shown = useMemo(() => filterReviewItems(items, filters), [items, filters]);
  const more = useShowMore(shown, PAGE, [filters]);
  const filtering = filters.status !== 'all' || filters.media !== 'all' || filters.pressRelease !== 'all'
    || filters.from || filters.to || filters.query.trim();

  const exportReview = () => exportMatchReviewExcel({
    rows: buildReviewRows(shown), pressReleases: buildPressReleaseListRows(sync && sync.pressReleases),
  });

  if (status === 'error' || (status === 'loading' && records.length === 0)) return null;
  if (records.length === 0) return null;

  return (
    <Card title="待確認配對" icon="checkcircle"
      actions={
        <button onClick={exportReview} disabled={shown.length === 0} className={btnCls}>
          <Icon name="download" /> 匯出待確認 Excel{filtering ? '（目前篩選）' : ''}
        </button>
      }>
      <p className="text-xs text-gray-500 mb-1">
        需要同仁覆核的曝光：<strong className="text-gray-300">建議配對</strong>（可能屬於某篇新聞稿）、<strong className="text-gray-300">未配對</strong>（資訊不足、無法判定）、
        已人工確認、已人工排除。一般報導與股市評論不會被硬配給新聞稿。
      </p>
      <p className="text-xs text-gray-500 mb-3">
        覆核方式：匯出 Excel → 在 Google Sheet「曝光配對覆核」分頁貼上前四欄，填 decision
        （<code>confirm</code> 確認建議／<code>rematch</code> 另指定新聞稿並填 pressReleaseId／<code>reject</code> 不屬於任何新聞稿）→ 下次同步會寫回。
        公開網站不提供直接修改。
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="待確認配對狀態" data-testid="review-status">
        <TabBtn active={filters.status === 'all'} onClick={() => setFilter('status', 'all')}>全部 {items.length}</TabBtn>
        {Object.entries(REVIEW_STATUSES).map(([id, label]) => (
          <TabBtn key={id} active={filters.status === id} onClick={() => setFilter('status', id)}>{label} {counts[id]}</TabBtn>
        ))}
      </div>

      <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2 mb-3">
        <label className="relative flex-1 min-w-[200px]">
          <span className="sr-only">搜尋待確認曝光</span>
          <input type="search" value={filters.query} onChange={e => setFilter('query', e.target.value)}
            placeholder="搜尋標題、媒體或新聞稿…" aria-label="搜尋待確認曝光" className={`${selectCls} w-full`} />
        </label>
        <select value={filters.media} onChange={e => setFilter('media', e.target.value)} aria-label="待確認媒體篩選" className={selectCls}>
          <option value="all">所有媒體</option>
          {mediaOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filters.pressRelease} onChange={e => setFilter('pressRelease', e.target.value)} aria-label="待確認新聞稿篩選"
          className={`${selectCls} lg:max-w-[260px]`}>
          <option value="all">所有新聞稿</option>
          {prOptions.map(o => <option key={o.id} value={o.id}>{o.title.slice(0, 40)}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={e => setFilter('from', e.target.value)}
            aria-label="待確認起始日" className={selectCls} />
          <span className="text-gray-500 text-sm">至</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={e => setFilter('to', e.target.value)}
            aria-label="待確認結束日" className={selectCls} />
        </div>
        {filtering && (
          <button className={btnCls}
            onClick={() => setFilters({ status: 'all', media: 'all', pressRelease: 'all', from: '', to: '', query: '' })}>清除篩選</button>
        )}
        <span className="text-xs text-gray-500 tabular-nums lg:ml-auto" data-testid="review-count">符合 {shown.length} / 共 {items.length} 則</span>
      </div>

      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-600">目前沒有需要覆核的曝光</p>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-600">沒有符合條件的曝光</p>
      ) : (
        <ul className="space-y-2" data-testid="review-list">
          {more.shown.map(({ record: r, status: st }) => (
            <li key={r.id} className="rounded-xl border border-gray-700/40 bg-gray-800/40 p-3" data-testid="review-item">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className={tagClass(STATUS_TONES[st])}>{REVIEW_STATUSES[st]}</span>
                {r.matchConfidence !== null && <span className={tagClass('gray')}>信心 {percentText(r.matchConfidence)}</span>}
                {MATCH_METHOD_LABELS[r.matchMethod] && <span className={tagClass('gray')}>{MATCH_METHOD_LABELS[r.matchMethod]}</span>}
                <span className="text-xs text-gray-500 tabular-nums">{r.day}・{r.mediaName}</span>
              </div>
              {r.link
                ? <a href={r.link} target="_blank" rel="noopener noreferrer" className="text-sm text-ink hover:text-red-500 leading-snug">{r.title || r.link}</a>
                : <p className="text-sm text-ink leading-snug">{r.title || '（無標題）'}</p>}
              {(r.suggestedName || r.campaignName) && (
                <p className="text-xs text-gray-400 mt-1">
                  {st === 'suggested' ? '建議配對到：' : '配對到：'}<span className="text-gray-300">{r.suggestedName || r.campaignName}</span>
                </p>
              )}
              {r.matchReason && <p className="text-xs text-gray-500 mt-0.5">{st === 'unmatched' ? '未配對原因：' : '理由：'}{r.matchReason}</p>}
            </li>
          ))}
        </ul>
      )}
      <ShowMoreButton remaining={more.remaining} step={PAGE} onMore={more.showMore} onAll={more.showAll} />
    </Card>
  );
}
