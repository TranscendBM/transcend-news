import { useState, useMemo } from 'react';

import TabBtn from '../../components/TabBtn.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import NewsFilterToolbar from '../../components/filters/NewsFilterToolbar.jsx';
import USNewsCard from '../news/USNewsCard.jsx';
import TodayBriefing from '../intelligence/TodayBriefing.jsx';
import { useNow } from '../../hooks/useNow.js';
import { taipeiPeriodRange, inPeriod } from '../../utils/dates.js';
import { exportNewsExcel } from '../../utils/formatting.js';
import {
  BRAND, getSentiment, dedupeArticlesByTitle, getUSBrand, US_BRAND_CFG, filterNewsList,
} from '../../utils/news.js';

// 上游市場自己的期間設定：只保留今天/本週/本月。故意不共用 PRTab 的
// CompetitorNews 用的期間篩選——那個陣列被 CompetitorNews 共用，若直接
// 在這裡砍成 3 個選項，會連帶把競品動態監測的期間篩選也改掉（本輪範圍
// 明確排除競品動態）。
const UPSTREAM_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
  { id: 'lastMonth', label: '上月' },
];

// ═══════════════════════════════════════════════════════════
// 上游市場 TAB
// ═══════════════════════════════════════════════════════════
// upstreamArticles/upstreamStatus/refreshUpstreamNews 由 App() 呼叫
// useUpstreamNews() 後往下傳（不在這裡直接呼叫 hook）：一方面讓「重新
// 整理」按鈕能統一觸發，另一方面 enabled 開關（只在 tab==='us' 時查詢）
// 需要知道目前分頁，放在 App() 層級才知道 tab 狀態。
export function USMarketTab({ upstreamArticles, upstreamStatus, refreshUpstreamNews }) {
  const [timeFilter, setTimeFilter] = useState('week');
  const [brandFilter, setBrandFilter] = useState('all');
  const [usQuery, setUsQuery] = useState('');
  const [usMedia, setUsMedia] = useState('all');
  const [usSentiment, setUsSentiment] = useState('all');

  // usUpstreamNews 已經在查詢層就限定 cat in ['usMarket','supplier']，
  // 這裡只需要去重（同一則報導可能因不同 RSS/搜尋條件被存成多筆文件）。
  const validUpstream = useMemo(() => dedupeArticlesByTitle(upstreamArticles), [upstreamArticles]);

  const mediaOptions = useMemo(
    () => [...new Set(validUpstream.map(n => n.mediaName || n.sourceName || '未知媒體'))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    [validUpstream]);

  // 搜尋／媒體／情緒篩選：跟 PRTab 一樣只有這一個工具列，resultCount／
  // totalCount 一律來自 useUpstreamNews 的本月資料，不是受全站 2000
  // 筆上限限制的 news。
  const searchFiltered = useMemo(
    () => filterNewsList(validUpstream, { query: usQuery, media: usMedia, sentiment: usSentiment }),
    [validUpstream, usQuery, usMedia, usSentiment]);

  const resetUpstreamFilters = () => {
    setUsQuery('');
    setUsMedia('all');
    setUsSentiment('all');
  };

  // useNow()：today/week/month 的邊界必須隨「目前時間」定期更新，不能
  // 只在 searchFiltered 改變時才重新計算（同 PRTab 的說明）。一律用
  // Asia/Taipei 日曆邊界，不用瀏覽器本地時區。
  const now = useNow();
  const periodFiltered = useMemo(() => {
    const range = taipeiPeriodRange(timeFilter, now);
    return searchFiltered.filter(n => inPeriod(n, range));
  }, [searchFiltered, timeFilter, now]);

  // 品牌 pill 按鈕上顯示的則數：用「期間篩選後、尚未套用品牌篩選」的
  // 集合計算，這樣切換品牌時每個 pill 仍顯示切過去會有幾則，不會因為
  // 目前選了某個品牌，其餘 pill 全部顯示 0。
  const brandCounts = useMemo(() => {
    const c = {};
    periodFiltered.forEach(n => { const b = getUSBrand(n); c[b] = (c[b] || 0) + 1; });
    return c;
  }, [periodFiltered]);

  // 品牌篩選是資料流程的最後一步：統計卡片／今日重要情報／新聞清單
  // 全部共用這同一份「已去重＋已篩選（搜尋/媒體/情緒）＋期間＋品牌」
  // 之後的最終結果，避免像先前 PR 頁面那樣，統計卡片和清單各自套用
  // 不同的篩選條件而數字對不上（若目前選了特定品牌，「最多討論」／
  // 「品牌數量」會如實反映只剩該品牌這件事，這是同一份資料的自然結果，
  // 不是另外特例處理）。
  const final = useMemo(
    () => brandFilter === 'all' ? periodFiltered : periodFiltered.filter(n => getUSBrand(n) === brandFilter),
    [periodFiltered, brandFilter]);

  // 今日重要情報：套用搜尋/媒體/情緒＋品牌，但不套用期間篩選——選「上月」
  // 時 final 不含今天，若直接用 final，今日情報會被清空、誤顯示「沒有重要情報」。
  const briefingSource = useMemo(
    () => brandFilter === 'all' ? searchFiltered : searchFiltered.filter(n => getUSBrand(n) === brandFilter),
    [searchFiltered, brandFilter]);

  const more = useShowMore(final, 80, [timeFilter, brandFilter, usQuery, usMedia, usSentiment]);
  const shown = more.shown;

  const pos = final.filter(n => (n.sentiment || getSentiment(n.title, n.content)) === 'positive').length;
  const neg = final.filter(n => (n.sentiment || getSentiment(n.title, n.content)) === 'negative').length;
  const finalBrandCounts = useMemo(() => {
    const c = {};
    final.forEach(n => { const b = getUSBrand(n); c[b] = (c[b] || 0) + 1; });
    return c;
  }, [final]);
  const topBrand = Object.entries(finalBrandCounts).sort((a, b) => b[1] - a[1])[0];
  const brandCountStat = Object.keys(finalBrandCounts).length;

  const STAT_CARDS = [
    { label: '本期新聞', val: final.length, sub: '供應鏈＋市場', cls: 'text-ink' },
    { label: '正面消息', val: pos, sub: final.length ? `${Math.round(pos / final.length * 100)}% 佔比` : '', cls: 'text-green-400' },
    { label: '負面消息', val: neg, sub: final.length ? `${Math.round(neg / final.length * 100)}% 佔比` : '', cls: 'text-red-400' },
    { label: '最多討論', val: topBrand?.[0] || '—', sub: `${topBrand?.[1] || 0} 則`, cls: 'text-blue-300', big: false },
    { label: '品牌數量', val: brandCountStat, sub: '含品牌資訊', cls: 'text-purple-300' },
  ];

  return (
    <div className="space-y-4 fade-in">
      {/* 今天重要情報（沿用「今日情報快報」規則：風險／財務／機會／市場關鍵字 + 24 小時內加權）
          跟統計卡片／新聞清單套用相同的搜尋/媒體/情緒/品牌篩選，但不受期間
          分頁影響（見上方 briefingSource），TodayBriefing 自己只挑「今天」。 */}
      <TodayBriefing articles={briefingSource} title="上游市場今日重要情報" />

      <NewsFilterToolbar
        query={usQuery} setQuery={setUsQuery}
        media={usMedia} setMedia={setUsMedia}
        sentiment={usSentiment} setSentiment={setUsSentiment}
        mediaOptions={mediaOptions}
        resultCount={searchFiltered.length} totalCount={validUpstream.length}
        onReset={resetUpstreamFilters}
      />

      {/* 統計卡片：查詢失敗時明確顯示錯誤，載入中顯示載入中，不悄悄顯示 0 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {STAT_CARDS.map((s, i) => (
          <div key={i} className="bg-gray-900 rounded-2xl border border-gray-700/60 p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            {upstreamStatus === 'error' ? (
              <p className="text-sm text-red-400 mt-1">⚠ 載入失敗</p>
            ) : upstreamStatus === 'loading' ? (
              <p className="text-sm text-gray-600 mt-1">載入中…</p>
            ) : (
              <>
                <p className={`${s.big === false ? 'text-lg' : 'text-2xl'} font-bold ${s.cls} truncate`}>{s.val}</p>
                <p className="text-xs text-gray-600 mt-0.5">{s.sub}</p>
              </>
            )}
          </div>
        ))}
      </div>

      {/* 主要新聞卡 */}
      <div className="bg-gray-900 rounded-2xl border border-gray-700/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-base font-semibold text-gray-200 flex items-center gap-2 min-w-0">
            <span>🌐</span>上游供應鏈 ＆ DRAM / Flash 市場新聞
          </h3>
          {/* 匯出目前畫面上的完整結果（final，未截斷成前 80 則）：期間＋品牌＋搜尋/媒體/情緒都已套用 */}
          <button
            onClick={() => exportNewsExcel(final, '上游市場新聞',
              `上游市場新聞_${UPSTREAM_TIME_FILTERS.find(f => f.id === timeFilter)?.label}`,
              { 品牌: getUSBrand })}
            disabled={final.length === 0}
            className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
            ⬇ 匯出 Excel
          </button>
        </div>

        {/* 時間篩選：今天/本週/本月/上月，上游市場專用（見上方 UPSTREAM_TIME_FILTERS） */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {UPSTREAM_TIME_FILTERS.map(f => (
            <TabBtn key={f.id} active={timeFilter === f.id} onClick={() => setTimeFilter(f.id)}>{f.label}</TabBtn>
          ))}
        </div>

        {/* 品牌篩選 pill */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {US_BRAND_CFG.map(b => {
            const cnt = b.id === 'all' ? periodFiltered.length : (brandCounts[b.id] || 0);
            const active = brandFilter === b.id;
            return (
              <button key={b.id} onClick={() => setBrandFilter(b.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                  active ? 'text-white' : 'bg-gray-800/60 text-gray-400 hover:text-gray-200'
                }`}
                style={active
                  ? { background: b.color || BRAND, borderColor: b.color || BRAND }
                  : { borderColor: 'rgba(75,85,99,0.4)' }}>
                {b.label}
                {cnt > 0 && <span className={`ml-1 ${active ? 'text-white/70' : 'text-gray-600'}`}>{cnt}</span>}
              </button>
            );
          })}
        </div>

        {upstreamStatus === 'error'
          ? <div className="h-32 flex flex-col items-center justify-center gap-2 text-red-400 text-sm">
              <span>⚠ 上游新聞載入失敗</span>
              <button onClick={refreshUpstreamNews}
                className="text-xs px-3 py-1 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
                重試
              </button>
            </div>
          : shown.length > 0
          ? <>
              <div className="space-y-2">{shown.map((n, i) => <USNewsCard key={n.id || i} article={n} />)}</div>
              <ShowMoreButton remaining={more.remaining} step={80} onMore={more.showMore} onAll={more.showAll} />
            </>
          : <div className="h-32 flex items-center justify-center text-gray-600 text-sm">
              {upstreamStatus === 'ready' ? '此區間暫無資料' : '載入中…'}
            </div>
        }
      </div>
    </div>
  );
}
