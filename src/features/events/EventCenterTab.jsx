import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import { PanelStateProvider, usePanelState } from '../../hooks/usePanelState.jsx';
import { useUrlParam } from '../../hooks/useUrlParam.js';
import { useNow } from '../../hooks/useNow.js';
import EventCard from './EventCard.jsx';
import { SENTIMENTS, SORTS, TAGS, filterTopics, sortTopics, topicStats } from './eventData.js';

const PAGE = 20;
const TAG_IDS = Object.keys(TAGS);
const inputCls = 'min-w-0 max-w-full rounded-xl border border-gray-700/60 px-3 py-2 text-sm outline-none transition focus:border-red-700';

function Stat({ label, value, tone = '' }) {
  return (
    <div className="list-row rounded-xl border border-gray-700/40 bg-gray-800/40 p-3 text-center min-w-0">
      <p className="text-xs text-gray-500 truncate">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${tone || 'text-ink'}`}>{value}</p>
    </div>
  );
}

// defaultTag：網址沒有 ?filter= 時預設的類別（上游市場的「事件」子頁預設看「上游市場」；明確選「全部」會寫成 ?filter=all）
export function EventCenter({ topics, status, onRetry, defaultTag = 'all' }) {
  const now = useNow();
  const [tag, setTag] = useUrlParam('filter', TAG_IDS, defaultTag);            // 網址 ?filter=：重新整理與上一頁／下一頁都保留
  const [sentiment, setSentiment] = usePanelState('events.sentiment', 'all');
  const [query, setQuery] = usePanelState('events.query', '');
  const [from, setFrom] = usePanelState('events.from', '');
  const [to, setTo] = usePanelState('events.to', '');
  const [sortMode, setSortMode] = usePanelState('events.sort', 'importance');
  const [openIds, setOpenIds] = usePanelState('events.open', () => new Set());
  const [allArticles, setAllArticles] = usePanelState('events.allArticles', () => new Set());

  const stats = useMemo(() => topicStats(topics, now), [topics, now]);
  const filtered = useMemo(() => filterTopics(topics, { tag, sentiment, query, from, to }), [topics, tag, sentiment, query, from, to]);
  const sorted = useMemo(() => sortTopics(filtered, sortMode), [filtered, sortMode]);
  const more = useShowMore(sorted, PAGE, [tag, sentiment, query, from, to, sortMode]);

  const filtering = tag !== defaultTag || sentiment !== 'all' || query.trim() || from || to;
  const toggle = (setter, id) => setter(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clear = () => {
    setTag(defaultTag, { replace: true }); setSentiment('all'); setQuery(''); setFrom(''); setTo('');
  };

  const loadingFirst = status === 'loading' && topics.length === 0;
  const failed = status === 'error';

  return (
    <div className="space-y-4">
      <Card title="事件中心" icon="radar">
        <p className="text-xs text-gray-500 mb-3">
          把不同媒體對同一事件的報導聚成一個話題（透明規則、零 API 費用，每 30 分鐘更新）。
          月份、季度、產品型號、公司不同的報導不會被合併；信心較低的保持獨立。展開可看原始新聞，既有新聞清單仍在各頁籤。
        </p>

        {failed && (
          <div className="py-6 text-center text-sm text-red-400" role="alert">
            <p><Icon name="alert" /> 事件載入失敗</p>
            <button onClick={onRetry}
              className="mt-2 text-sm px-3.5 py-1.5 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">重試</button>
          </div>
        )}
        {loadingFirst && <div className="py-8 text-center text-sm text-gray-600">載入中…</div>}
        {!failed && !loadingFirst && topics.length === 0 && (
          <div className="py-8 text-center text-sm text-gray-600">目前沒有事件資料（話題聚類排程會陸續產生）</div>
        )}

        {!loadingFirst && topics.length > 0 && (
          <div className="space-y-4">
            <div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2" data-testid="event-stats">
                <Stat label="今日事件" value={stats.today} />
                <Stat label="升溫事件" value={stats.rising} tone={stats.rising ? 'text-red-400' : ''} />
                <Stat label="涉及創見" value={stats.transcend} />
                <Stat label="競品事件" value={stats.competitor} />
                <Stat label="產業事件" value={stats.upstream} />
                <Stat label="負面事件" value={stats.negative} tone={stats.negative ? 'text-red-400' : ''} />
                <Stat label="待確認事件" value={stats.review} />
              </div>
              <p className="text-xs text-gray-500 mt-1.5">統計範圍：今日事件＝最新報導在台灣今天；其餘為近 72 小時有更新的事件（共 {stats.recentTotal} 個）。</p>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="事件類別篩選">
                {Object.entries(TAGS).map(([id, label]) => (
                  <TabBtn key={id} active={tag === id} onClick={() => setTag(id)}>{label}</TabBtn>
                ))}
              </div>
              <div className="flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2">
                <label className="relative flex-1 min-w-[200px]">
                  <span className="sr-only">搜尋事件</span>
                  <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋事件、公司、產品或新聞標題…"
                    aria-label="搜尋事件" className={`${inputCls} w-full`} />
                </label>
                <select value={sentiment} onChange={e => setSentiment(e.target.value)} aria-label="事件情緒篩選" className={inputCls}>
                  {Object.entries(SENTIMENTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
                <div className="flex items-center gap-2">
                  <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="事件起始日" className={inputCls} />
                  <span className="text-gray-500 text-sm">至</span>
                  <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="事件結束日" className={inputCls} />
                </div>
                {filtering && (
                  <button onClick={clear} className="text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">清除篩選</button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-gray-500 tabular-nums" data-testid="event-count">符合 {sorted.length} / 共 {topics.length} 個事件</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="事件排序">
                  {Object.entries(SORTS).map(([id, label]) => (
                    <TabBtn key={id} active={sortMode === id} onClick={() => setSortMode(id)}>{label}</TabBtn>
                  ))}
                </div>
              </div>
            </div>

            {sorted.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-600">
                沒有符合條件的事件。<button onClick={clear} className="ml-2 underline text-gray-400 hover:text-gray-200">清除篩選</button>
              </div>
            ) : (
              <div className="space-y-2">
                {more.shown.map(t => (
                  <EventCard key={t.id} topic={t} open={openIds.has(t.id)} onToggle={() => toggle(setOpenIds, t.id)}
                    allArticles={allArticles.has(t.id)} onShowAllArticles={() => toggle(setAllArticles, t.id)} />
                ))}
                <ShowMoreButton remaining={more.remaining} step={PAGE} onMore={more.showMore} onAll={more.showAll} />
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/** 事件中心頁籤。topics／status 由 App 的 useNewsTopics() 傳進來（資料只讀一次，切換頁籤不會重讀）。 */
export function EventCenterTab({ topics, status, onRetry }) {
  return (
    <PanelStateProvider>
      <EventCenter topics={topics} status={status} onRetry={onRetry} />
    </PanelStateProvider>
  );
}
