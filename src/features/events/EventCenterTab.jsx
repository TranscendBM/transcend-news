import { useMemo } from 'react';

import { ActionButton, EmptyState, ErrorState, FilterBar, LoadingSkeleton, MetricCard, PageHeader, SearchField, SegmentedControl } from '../../components/ui/index.js';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import { PanelStateProvider, usePanelState } from '../../hooks/usePanelState.jsx';
import { useUrlParam } from '../../hooks/useUrlParam.js';
import { useNow } from '../../hooks/useNow.js';
import EventCard from './EventCard.jsx';
import { SENTIMENTS, SORTS, TAGS, filterTopics, sortTopics, topicStats } from './eventData.js';

const PAGE = 20;
const TAG_IDS = Object.keys(TAGS);

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

  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const TAG_OPTIONS = Object.entries(TAGS).map(([id, label]) => ({ id, label }));
  const SORT_OPTIONS = Object.entries(SORTS).map(([id, label]) => ({ id, label }));
  // 統計卡可以點：直接套用對應的篩選（再點一次取消）；沒有對應篩選的（待確認）不可點。
  const kpiToggle = (isOn, on, off) => () => (isOn ? off() : on());
  const kpis = [
    { label: '今日事件', value: stats.today, on: from === todayStr && to === todayStr,
      onClick: kpiToggle(from === todayStr && to === todayStr, () => { setFrom(todayStr); setTo(todayStr); }, () => { setFrom(''); setTo(''); }) },
    { label: '升溫事件', value: stats.rising, tone: stats.rising ? 'text-[color:var(--up)]' : '', on: sortMode === 'surge',
      onClick: kpiToggle(sortMode === 'surge', () => setSortMode('surge'), () => setSortMode('importance')) },
    { label: '涉及創見', value: stats.transcend, on: tag === 'transcend',
      onClick: kpiToggle(tag === 'transcend', () => setTag('transcend'), () => setTag(defaultTag)) },
    { label: '競品事件', value: stats.competitor, on: tag === 'competitor',
      onClick: kpiToggle(tag === 'competitor', () => setTag('competitor'), () => setTag(defaultTag)) },
    { label: '產業事件', value: stats.upstream, on: tag === 'upstream',
      onClick: kpiToggle(tag === 'upstream', () => setTag('upstream'), () => setTag(defaultTag)) },
    { label: '負面事件', value: stats.negative, tone: stats.negative ? 'text-[color:var(--up)]' : '', on: sentiment === 'negative',
      onClick: kpiToggle(sentiment === 'negative', () => setSentiment('negative'), () => setSentiment('all')) },
    { label: '待確認事件', value: stats.review },
  ];
  const activeChips = [
    ...(tag !== defaultTag ? [{ key: 'tag', label: `類別：${TAGS[tag]}`, onClear: () => setTag(defaultTag, { replace: true }) }] : []),
    ...(sentiment !== 'all' ? [{ key: 'sent', label: `情緒：${SENTIMENTS[sentiment].replace('情緒：', '')}`, onClear: () => setSentiment('all') }] : []),
    ...(query.trim() ? [{ key: 'q', label: `搜尋：${query.trim()}`, onClear: () => setQuery('') }] : []),
    ...((from || to) ? [{ key: 'date', label: `日期：${from || '…'} ～ ${to || '…'}`, onClear: () => { setFrom(''); setTo(''); } }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="事件" description="把不同媒體對同一事件的報導聚成一個話題（透明規則、零 API 費用，每 30 分鐘更新）。月份、季度、產品型號、公司不同的報導不會被合併；信心較低的保持獨立。展開可看原始新聞。" />

      {failed && <ErrorState message="事件載入失敗" onRetry={onRetry} />}
      {loadingFirst && <LoadingSkeleton lines={4} className="py-4" />}
      {!failed && !loadingFirst && topics.length === 0 && (
        <EmptyState title="目前沒有事件資料" hint="話題聚類排程每 30 分鐘執行一次，有新報導後會陸續產生事件。" />
      )}

      {!loadingFirst && topics.length > 0 && (
        <>
          <div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2" data-testid="event-stats">
              {kpis.map(k => (
                <MetricCard key={k.label} label={k.label} value={String(k.value)} tone={k.tone}
                  onClick={k.onClick} active={k.onClick ? k.on : undefined} />
              ))}
            </div>
            <p className="text-xs text-ui-muted mt-1.5">統計範圍：今日事件＝最新報導在台灣今天；其餘為近 72 小時有更新的事件（共 {stats.recentTotal} 個）。點統計卡可直接套用篩選。</p>
          </div>

          <FilterBar active={activeChips} onClearAll={filtering ? clear : undefined} clearLabel="清除篩選"
            resultText={`符合 ${sorted.length} / 共 ${topics.length} 個事件`}>
            <SearchField value={query} onChange={setQuery} label="搜尋事件" placeholder="搜尋事件、公司、產品或新聞標題…" className="md:flex-1 md:min-w-[220px]" />
            <select value={sentiment} onChange={e => setSentiment(e.target.value)} aria-label="事件情緒篩選" className="ui-field">
              {Object.entries(SENTIMENTS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <div className="flex items-center gap-2">
              <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="事件起始日" className="ui-field" />
              <span className="text-ui-muted text-sm">至</span>
              <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="事件結束日" className="ui-field" />
            </div>
            <SegmentedControl label="事件類別篩選" value={tag} onChange={setTag} options={TAG_OPTIONS} className="basis-full" />
            <SegmentedControl label="事件排序" value={sortMode} onChange={setSortMode} options={SORT_OPTIONS} className="basis-full" />
          </FilterBar>
          <p className="sr-only" data-testid="event-count" aria-live="polite">符合 {sorted.length} / 共 {topics.length} 個事件</p>

          {sorted.length === 0 ? (
            <EmptyState title="沒有符合條件的事件" hint="可放寬類別、情緒或日期範圍。"
              action={<ActionButton onClick={clear}>清除篩選</ActionButton>} />
          ) : (
            <div className="space-y-2">
              {more.shown.map(t => (
                <EventCard key={t.id} topic={t} open={openIds.has(t.id)} onToggle={() => toggle(setOpenIds, t.id)}
                  allArticles={allArticles.has(t.id)} onShowAllArticles={() => toggle(setAllArticles, t.id)} />
              ))}
              <ShowMoreButton remaining={more.remaining} step={PAGE} onMore={more.showMore} onAll={more.showAll} />
            </div>
          )}
        </>
      )}
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
