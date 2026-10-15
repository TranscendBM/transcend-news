import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import { tagClass } from '../../components/tagStyles.js';
import { exportExposurePerformanceExcel } from '../../utils/formatting.js';
import { MAX_EXPOSURE_RECORDS } from './exposureLimits.js';
import { EVENT_KIND_LABELS } from './exposureEvents.js';
import { usePRState } from './prState.jsx';
import {
  EMPTY_FILTERS, MATCH_FILTERS, TOPIC_SORTS, applyFilters, buildDetailRows, buildPerformance, buildSummaryRows,
  countMatchKinds, filterOptions, filterTopicsByMatch, hasActiveFilters, sortTopics, toPublicRecords, typeLabel,
} from './exposurePerformance.js';

// 「新聞稿曝光成效」：把人工確認曝光（media_exposure 公開欄位）依「新聞稿／主題」彙整。
// 篩選只做一次（filtered），摘要、類型分布、媒體排行、主題分組、明細與 Excel 匯出
// 全部吃同一份結果，畫面上的數字才會彼此一致。

const TYPE_COLORS = { online: '#960014', video: '#b45309', social: '#475569', other: '#94a3b8' };
const TYPE_TONES = { online: 'blue', video: 'amber', social: 'green' };
const typeColor = key => TYPE_COLORS[key] || TYPE_COLORS.other;
// 分組依據標籤（只有多篇的主題才顯示）：編號＝綠、事件規則＝藍、標題相似＝琥珀、標題相同＝灰
const BASIS_TONES = { id: 'green', event: 'blue', similar: 'amber', title: 'gray' };
const basisText = t => t.basisLabel + (t.eventKind ? '（' + EVENT_KIND_LABELS[t.eventKind] + '）' : '');

// 配對依據標籤：人工確認＝綠、稿單自動配對＝藍、稿單建議配對＝琥珀、標題推定／尚未配對＝灰
const MATCH_TONES = { confirmed: 'green', auto: 'blue', suggested: 'amber', inferred: 'gray', none: 'gray' };

const fmtDateTime = d => (d
  ? d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

/** 資料來源與最後同步時間；沒有新聞稿主檔或讀取失敗時說明目前用標題推定，頁面照常運作。 */
function SyncStatusLine({ sync, hasMatchData }) {
  let text;
  if (!sync) text = '新聞稿主檔同步狀態讀取中…';
  else if (sync.error) text = '新聞稿主檔同步狀態讀取失敗，目前以標題推定分組。';
  else if (sync.missing) text = '尚未同步 Google Sheet 新聞稿主檔，目前以標題推定分組。';
  else text = `資料來源：Google Sheet 新聞稿主檔＋人工曝光資料・最後同步 ${fmtDateTime(sync.lastSyncAt)}`;
  return (
    <p className="text-xs text-gray-500 mb-1" data-testid="press-sync-status">
      {text}
      {sync && !sync.error && !sync.missing && !hasMatchData && '（目前尚無曝光完成配對）'}
      {sync && sync.failedSinceSuccess && (
        <span className="text-amber-700"> 最近一次同步失敗，沿用上次成功的資料。</span>
      )}
    </p>
  );
}

const fmtDay = d => (d ? d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }) : '—');
const pct = v => `${Math.round(v * 100)}%`;
const TOPIC_PAGE = 15;

const inputCls = 'min-w-0 max-w-full rounded-xl border border-gray-700/60 px-3 py-2 text-sm outline-none transition focus:border-red-700';
const btnCls = 'text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0';

function Kpi({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900 p-3 text-center">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-ink mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}

function ExposureLink({ record }) {
  // record.link 已經過 safeHttpUrl；不安全的網址在這裡是空字串，不會輸出成連結
  return record.link
    ? <a href={record.link} target="_blank" rel="noopener noreferrer" className="text-ink hover:text-red-500 leading-snug">{record.title || record.link}</a>
    : <span className="text-ink leading-snug">{record.title || '（無標題）'}</span>;
}

function TopicRow({ topic, open, onToggle, onExport }) {
  const detailId = `exposure-topic-${topic.key.replace(/[^a-z0-9]/gi, '').slice(0, 24)}-${topic.total}`;
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900">
      <button onClick={onToggle} aria-expanded={open} aria-controls={detailId}
        className="w-full text-left p-3 flex items-start gap-3 hover:bg-gray-800/30 rounded-xl transition">
        <Icon name="chevronright" className={`mt-1 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink leading-snug break-words">{topic.name}</p>
          <p className="text-xs text-gray-500 mt-1">
            {topic.mediaCount} 家媒體・首次 {fmtDay(topic.firstDate)}・最近 {fmtDay(topic.lastDate)}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span className={tagClass(MATCH_TONES[topic.matchKind])} title="這個主題與 Google Sheet 新聞稿主檔的配對狀態">
              {topic.matchLabel}{topic.matchKind === 'suggested' && topic.suggestedName ? `：${topic.suggestedName}` : ''}
            </span>
            {topic.basis !== 'single' && topic.matchKind !== 'auto' && topic.matchKind !== 'confirmed' && (
              <span className={tagClass(BASIS_TONES[topic.basis])} title="這些曝光被歸成同一個主題的依據（推定，可展開檢視每一則）">
                分組依據：{basisText(topic)}
              </span>
            )}
            <span className={tagClass('gray')} title="這個主題的資料來源">
              來源：{topic.fromPressReleaseSheet ? 'Google Sheet 新聞稿主檔＋人工曝光資料' : '人工曝光資料'}
            </span>
            {topic.typeCounts.map(c => (
              <span key={c.key} className={tagClass(TYPE_TONES[c.key] || 'gray')}>{c.label} {c.count}</span>
            ))}
            {topic.topMedia.map(m => (
              <span key={m.key} className={tagClass('gray')}>{m.label} {m.count}</span>
            ))}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold text-ink tabular-nums leading-none">{topic.total}</p>
          <p className="text-xs text-gray-500 mt-1">則曝光</p>
        </div>
      </button>

      {open && (
        <div id={detailId} className="px-3 pb-3 border-t border-gray-700/60">
          <div className="flex items-center justify-between gap-2 py-2">
            <p className="text-xs text-gray-500">曝光明細（新到舊）</p>
            <button onClick={onExport} className={btnCls}>
              <Icon name="download" /> 匯出此主題
            </button>
          </div>
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="ir-table w-full text-sm">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">日期</th>
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">媒體</th>
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">記者</th>
                  <th className="text-left pb-1.5 pr-3 font-medium min-w-[220px]">新聞標題</th>
                  <th className="text-left pb-1.5 font-medium whitespace-nowrap">類型</th>
                </tr>
              </thead>
              <tbody>
                {topic.items.map((r, i) => (
                  <tr key={r.id || i}>
                    <td className="py-1.5 pr-3 text-gray-400 tabular-nums whitespace-nowrap">{r.day}</td>
                    <td className="py-1.5 pr-3 text-gray-300 whitespace-nowrap">{r.mediaName}</td>
                    <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">{r.reporter || '—'}</td>
                    <td className="py-1.5 pr-3"><ExposureLink record={r} /></td>
                    <td className="py-1.5 text-xs text-gray-500 whitespace-nowrap">{typeLabel(r.type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExposurePerformancePanel({
  records = [], status = 'idle', onRetry = () => {}, maxRecords = MAX_EXPOSURE_RECORDS, sync = null,
}) {
  // 篩選、展開的主題、排序放在 PR store：切換子頁再回來仍保留
  const [filters, setFilters] = usePRState('exposure.filters', EMPTY_FILTERS);
  const [openKeys, setOpenKeys] = usePRState('exposure.openTopics', () => new Set());
  const [matchFilter, setMatchFilter] = usePRState('exposure.match', 'all');   // 配對狀態篩選
  const [sortMode, setSortMode] = usePRState('exposure.sort', 'recent');   // 預設：最近曝光的主題排最前面
  const setFilter = (name, value) => setFilters(f => ({ ...f, [name]: value }));

  // 衍生資料全部 memoize：只在原始資料或篩選條件改變時重算
  const publicRecords = useMemo(() => toPublicRecords(records), [records]);
  const options = useMemo(() => filterOptions(publicRecords), [publicRecords]);
  const filtered = useMemo(() => applyFilters(publicRecords, filters), [publicRecords, filters]);
  const perf = useMemo(() => buildPerformance(filtered), [filtered]);
  const topics = useMemo(() => sortTopics(perf.topics, sortMode), [perf.topics, sortMode]);
  const hasMatchData = useMemo(() => publicRecords.some(r => r.matchStatus), [publicRecords]);
  const matchCounts = useMemo(() => countMatchKinds(perf.topics), [perf.topics]);
  const activeMatch = hasMatchData ? matchFilter : 'all';
  const shownTopics = useMemo(() => filterTopicsByMatch(topics, activeMatch), [topics, activeMatch]);
  const more = useShowMore(shownTopics, TOPIC_PAGE, [filters, sortMode, activeMatch]);

  const filtering = hasActiveFilters(filters) || activeMatch !== 'all';
  const truncated = records.length >= maxRecords;
  const toggle = key => setOpenKeys(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const exportAll = () => exportExposurePerformanceExcel({
    summaryRows: buildSummaryRows(shownTopics), detailRows: buildDetailRows(shownTopics),
  });
  const exportTopic = topic => exportExposurePerformanceExcel({
    detailRows: buildDetailRows([topic]), suffix: topic.name,
  });

  const loadingFirst = status === 'loading' && publicRecords.length === 0;
  const failed = status === 'error';
  const showData = !failed && !loadingFirst && publicRecords.length > 0;

  return (
    <Card title="新聞稿曝光成效" icon="chart"
      actions={
        <button onClick={exportAll} disabled={!showData || perf.total === 0} className={btnCls}>
          <Icon name="download" /> 匯出新聞稿成效{filtering ? '（目前篩選）' : ''}
        </button>
      }>
      <p className="text-xs text-gray-500 mb-1">
        依「新聞稿／主題」彙整人工確認的曝光。同一則新聞稿各媒體標題常不一樣，所以依序用這些依據分組：
        ① 新聞稿編號（資料有才用）② 事件規則——同一期的月營收公告、同一季的財報／獲利
        ③ 標題完全相同 ④ 發布日前後 1 天內的相似標題；都不符合就各自獨立。
        這是推定而非正式新聞稿編號，每組都標示依據，可展開檢視每一則。
      </p>
      <SyncStatusLine sync={sync} hasMatchData={hasMatchData} />
      <p className="text-xs text-gray-500 mb-4">
        統計依目前已載入的 {publicRecords.length.toLocaleString()} 筆人工確認曝光
        {truncated && (
          <span className="text-amber-700">（已達讀取上限 {maxRecords.toLocaleString()} 筆，更早的資料未納入統計）</span>
        )}
        。
      </p>

      {failed && (
        <div className="py-8 text-center text-sm text-red-400" role="alert">
          <p><Icon name="alert" /> 新聞稿曝光成效載入失敗</p>
          <button onClick={onRetry}
            className="mt-2 text-sm px-3.5 py-1.5 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
            重試
          </button>
        </div>
      )}

      {loadingFirst && <div className="py-8 text-center text-sm text-gray-600">載入中…</div>}

      {!failed && !loadingFirst && publicRecords.length === 0 && (
        <div className="py-8 text-center text-sm text-gray-600">尚未匯入人工確認曝光資料</div>
      )}

      {showData && (
        <div className="space-y-4">
          {/* 篩選列 */}
          <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2">
            <label className="relative flex-1 min-w-[200px]">
              <span className="sr-only">搜尋曝光</span>
              <input type="search" value={filters.query} onChange={e => setFilter('query', e.target.value)}
                placeholder="搜尋標題、媒體或記者…" aria-label="搜尋曝光（標題、媒體、記者）"
                className={`${inputCls} w-full`} />
            </label>
            <div className="grid grid-cols-2 sm:flex gap-2">
              <select value={filters.media} onChange={e => setFilter('media', e.target.value)} aria-label="曝光媒體篩選"
                className={`${inputCls} sm:max-w-[190px]`}>
                <option value="all">所有媒體</option>
                {options.media.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select value={filters.type} onChange={e => setFilter('type', e.target.value)} aria-label="曝光類型篩選"
                className={inputCls}>
                <option value="all">所有類型</option>
                {options.types.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input type="date" value={filters.from} max={filters.to || undefined}
                onChange={e => setFilter('from', e.target.value)} aria-label="曝光起始日" className={inputCls} />
              <span className="text-gray-500 text-sm">至</span>
              <input type="date" value={filters.to} min={filters.from || undefined}
                onChange={e => setFilter('to', e.target.value)} aria-label="曝光結束日" className={inputCls} />
            </div>
            <div className="flex items-center justify-between gap-3 lg:ml-auto">
              <span className="text-xs text-gray-500 tabular-nums">符合 {perf.total} / 共 {publicRecords.length} 筆</span>
              {filtering && (
                <button onClick={() => { setFilters(EMPTY_FILTERS); }} className={btnCls}>清除篩選</button>
              )}
            </div>
          </div>

          {perf.total === 0 ? (
            <div className="py-8 text-center text-sm text-gray-600">
              沒有符合篩選條件的曝光。
              <button onClick={() => setFilters(EMPTY_FILTERS)} className="ml-2 underline text-gray-400 hover:text-gray-200">清除篩選</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Kpi label="人工確認曝光" value={perf.total} hint="則" />
                <Kpi label="涵蓋媒體" value={perf.mediaCount} hint="家" />
                <Kpi label="新聞稿／主題" value={perf.topicCount} hint="依標題彙整" />
                <Kpi label="最近曝光" value={fmtDay(perf.latestDate)} hint={`首次 ${fmtDay(perf.firstDate)}`} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 mb-2">曝光類型分布</p>
                  <div className="flex h-3 rounded-full overflow-hidden bg-gray-800" role="img"
                    aria-label={perf.typeCounts.map(c => `${c.label} ${c.count}`).join('，')}>
                    {perf.typeCounts.map(c => (
                      <div key={c.key} style={{ width: `${c.share * 100}%`, background: typeColor(c.key) }} />
                    ))}
                  </div>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-400">
                    {perf.typeCounts.map(c => (
                      <li key={c.key} className="flex items-center gap-1.5">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: typeColor(c.key) }} />
                        {c.label} {c.count}（{pct(c.share)}）
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-2">曝光量最高的媒體</p>
                  <ol className="space-y-1.5">
                    {perf.mediaRanking.slice(0, 8).map((m, i) => (
                      <li key={m.key} className="flex items-center gap-2 text-sm">
                        <span className="w-4 text-xs text-gray-600 tabular-nums">{i + 1}</span>
                        <span className="w-28 shrink-0 text-gray-300 truncate">{m.label}</span>
                        <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${m.count / perf.mediaRanking[0].count * 100}%`, background: 'rgb(150,0,20)' }} />
                        </div>
                        <span className="w-8 text-right text-xs font-bold text-ink tabular-nums">{m.count}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <p className="text-xs text-gray-500">
                    新聞稿／主題（{perf.topicCount}，依{sortMode === 'recent' ? '最近曝光時間由近到遠' : '曝光數由多到少'}排序；點開看明細）
                  </p>
                  <div className="flex gap-1.5" role="group" aria-label="主題排序">
                    {Object.entries(TOPIC_SORTS).map(([id, label]) => (
                      <TabBtn key={id} active={sortMode === id} onClick={() => setSortMode(id)}>{label}</TabBtn>
                    ))}
                  </div>
                </div>
                {hasMatchData && (
                  <div className="flex flex-wrap items-center gap-2 mb-2" data-testid="match-filter">
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="配對狀態篩選">
                      {Object.entries(MATCH_FILTERS).map(([id, label]) => (
                        <TabBtn key={id} active={activeMatch === id} onClick={() => setMatchFilter(id)}>
                          {label}{id === 'all' ? ` ${perf.topicCount}` : ` ${matchCounts[id]}`}
                        </TabBtn>
                      ))}
                    </div>
                    <span className="text-xs text-gray-500">
                      待確認 {matchCounts.suggested}・未配對 {matchCounts.unmatched}（以主題計；未配對含標題推定分組）
                    </span>
                  </div>
                )}
                <div className="space-y-2">
                  {shownTopics.length === 0 && (
                    <p className="py-6 text-center text-sm text-gray-600">沒有符合「{MATCH_FILTERS[activeMatch]}」的主題</p>
                  )}
                  {more.shown.map(t => (
                    <TopicRow key={t.key} topic={t} open={openKeys.has(t.key)}
                      onToggle={() => toggle(t.key)} onExport={() => exportTopic(t)} />
                  ))}
                </div>
                <ShowMoreButton remaining={more.remaining} step={TOPIC_PAGE} onMore={more.showMore} onAll={more.showAll} />
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
