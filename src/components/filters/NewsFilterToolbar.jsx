import FilterBar from '../ui/FilterBar.jsx';
import SearchField from '../ui/SearchField.jsx';

const SENTIMENT_LABEL = { positive: '正面', neutral: '中立', negative: '負面' };

/**
 * 新聞篩選列（PR 新聞監測、上游市場新聞清單共用，建立在共用的 FilterBar 上）：
 * 搜尋、媒體、情緒；children 放該頁額外的篩選（期間、品牌…）。
 * 目前生效的條件顯示成可個別移除的晶片，並有「清除條件」一鍵清除；手機收合成「篩選」按鈕。
 * extraActive：額外篩選的晶片（[{ key, label, onClear }]），一併計入並由「清除條件」呼叫 onReset 清除。
 */
export default function NewsFilterToolbar({
  query, setQuery, media, setMedia, sentiment, setSentiment, mediaOptions, resultCount, totalCount, onReset,
  extraActive = [], children,
}) {
  const active = [
    ...(query.trim() ? [{ key: 'q', label: `搜尋：${query.trim()}`, onClear: () => setQuery('') }] : []),
    ...(media !== 'all' ? [{ key: 'm', label: `媒體：${media}`, onClear: () => setMedia('all') }] : []),
    ...(sentiment !== 'all' ? [{ key: 's', label: `情緒：${SENTIMENT_LABEL[sentiment] || sentiment}`, onClear: () => setSentiment('all') }] : []),
    ...extraActive,
  ];
  return (
    <FilterBar active={active} onClearAll={active.length ? onReset : undefined}
      resultText={`顯示 ${resultCount} / ${totalCount} 則`}>
      <SearchField value={query} onChange={setQuery} label="搜尋新聞" placeholder="搜尋標題、內容、媒體或品牌…" className="md:flex-1 md:min-w-[220px]" />
      <select value={media} onChange={e => setMedia(e.target.value)} aria-label="依媒體篩選" className="ui-field md:max-w-[190px]">
        <option value="all">所有媒體</option>
        {mediaOptions.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <select value={sentiment} onChange={e => setSentiment(e.target.value)} aria-label="依情緒篩選" className="ui-field">
        <option value="all">所有情緒</option>
        <option value="positive">正面</option>
        <option value="neutral">中立</option>
        <option value="negative">負面</option>
      </select>
      {children}
    </FilterBar>
  );
}
