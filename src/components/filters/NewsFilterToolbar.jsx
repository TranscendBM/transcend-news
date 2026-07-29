export default function NewsFilterToolbar({ query, setQuery, media, setMedia, sentiment, setSentiment, mediaOptions, resultCount, totalCount, onReset }) {
  const active = query.trim() || media !== 'all' || sentiment !== 'all';
  return (
    <div className="bg-gray-900 rounded-2xl border border-gray-700/60 p-3">
      <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
        <label className="relative flex-1 min-w-0">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true">⌕</span>
          <input type="search" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="搜尋標題、內容、媒體或品牌…" aria-label="搜尋新聞"
            className="w-full rounded-xl border border-gray-700/60 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-red-700" />
        </label>
        <div className="grid grid-cols-2 sm:flex gap-2">
          <select value={media} onChange={e => setMedia(e.target.value)} aria-label="依媒體篩選"
            className="rounded-xl border border-gray-700/60 px-3 py-2 text-sm outline-none focus:border-red-700 sm:max-w-[190px]">
            <option value="all">所有媒體</option>
            {mediaOptions.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <select value={sentiment} onChange={e => setSentiment(e.target.value)} aria-label="依情緒篩選"
            className="rounded-xl border border-gray-700/60 px-3 py-2 text-sm outline-none focus:border-red-700">
            <option value="all">所有情緒</option>
            <option value="positive">正面</option>
            <option value="neutral">中立</option>
            <option value="negative">負面</option>
          </select>
        </div>
        <div className="flex items-center justify-between lg:justify-end gap-3 shrink-0">
          <span className="text-xs text-gray-500 tabular-nums">顯示 {resultCount} / {totalCount} 則</span>
          {active && (
            <button onClick={onReset} className="text-xs font-medium px-3 py-2 rounded-lg border border-gray-700/60 text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition">
              清除條件
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
