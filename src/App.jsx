import { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import {
  PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';

import { getDb, doc, onSnapshot, getDoc } from './services/firebase.js';
import Card from './components/Card.jsx';
import Spinner from './components/Spinner.jsx';
import TabBtn from './components/TabBtn.jsx';
import CompanyLogo from './components/logos/CompanyLogo.jsx';
import TranscendMark from './components/logos/TranscendMark.jsx';
import NewsFilterToolbar from './components/filters/NewsFilterToolbar.jsx';
import NewsCard from './features/news/NewsCard.jsx';
import USNewsCard from './features/news/USNewsCard.jsx';
import { useNewsFeed } from './features/news/useNewsFeed.js';
import { usePRNews } from './features/news/usePRNews.js';
import { useUpstreamNews } from './features/news/useUpstreamNews.js';
import TodayBriefing from './features/intelligence/TodayBriefing.jsx';
import { useNow } from './hooks/useNow.js';
import { exportNewsExcel } from './utils/formatting.js';
import {
  sortByDate, isStockStale, fmtStockUpdated,
  taipeiDayStart, taipeiWeekStart, taipeiMonthStart,
} from './utils/dates.js';
import {
  BRAND, KEY_MEDIA, getSentiment, dedupeArticlesByTitle, isValidTranscendPR,
  isBriefingCandidate, getUSBrand, US_BRAND_CFG, filterNewsList,
} from './utils/news.js';

// ═══════════════════════════════════════════════════════════
// COMPETITOR CONFIG
// ═══════════════════════════════════════════════════════════
const COMPETITORS = [
  { id: 'ADATA', name: 'ADATA 威剛', stock: '3260', color: '#ef4444' },
  { id: 'Innodisk', name: 'Innodisk 宜鼎', stock: '5289', color: '#eab308' },
  { id: 'Teamgroup', name: 'Teamgroup 十銓', stock: '4967', color: '#f97316' },
  { id: 'Apacer', name: 'Apacer 宇瞻', stock: '8271', color: '#22c55e' },
  { id: 'Silicon Power', name: 'Silicon Power 廣穎', stock: '4973', color: '#3b82f6' },
];

// 統一的競品顯示順序（威剛／宜鼎／十銓／宇瞻／廣穎）。
// 股票代號當 object key 時，JS 會自動依數字大小排序、無視物件字面量的
// 撰寫順序，所以凡是要照這個順序顯示的地方都要用這個陣列驅動，
// 不能直接 Object.keys()/Object.entries() 一個以代號為 key 的物件。
const COMPETITOR_ORDER = ['3260', '5289', '4967', '8271', '4973'];

const STOCK_META = {
  '2451': { name: '創見' },
  '3260': { name: '威剛' },
  '5289': { name: '宜鼎' },
  '4967': { name: '十銓科技' },
  '8271': { name: '宇瞻' },
  '4973': { name: '廣穎' },
};

// 註：MOCK_COMMUNITY / SRC_COLOR（既有既存但目前無畫面引用）已隨模組搬移
// 保留在 src/utils/news.js（避免在這裡宣告卻未使用而觸發 lint 錯誤）。

// ═══════════════════════════════════════════════════════════
// MOCK — 股價歷史走勢（示意，未來接每日收盤紀錄）
// ═══════════════════════════════════════════════════════════
const MOCK_STOCK_HISTORY = (() => {
  const base = { '2451': 255, '3260': 84, '4973': 133, '5289': 190, '4967': 58, '8271': 72 };
  const trend = { '2451': 1.5, '3260': 0.3, '4973': 0.5, '5289': 0.4, '4967': 0.2, '8271': 0.2 };
  return Array.from({ length: 20 }, (_, i) => {
    const d = new Date('2026-03-24'); d.setDate(d.getDate() + i);
    const row = { date: `${d.getMonth() + 1}/${d.getDate()}` };
    for (const [c, b] of Object.entries(base)) {
      const n = Math.sin(i * 1.3 + parseInt(c) * 0.01) * 8 + Math.cos(i * 0.7) * 5;
      row[c] = +(b + trend[c] * i + n).toFixed(1);
    }
    return row;
  });
})();

const TT = { contentStyle: { background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, color: '#334155', fontSize: 12, boxShadow: '0 8px 24px rgba(15,23,42,.10)' } };

// 上游市場自己的期間設定：只保留今天/本週/本月。故意不共用下面
// CompetitorNews 用的 TIME_FILTERS（今天/本週/本月/本年/已載入資料）——
// 那個陣列被 CompetitorNews 共用，若直接在這裡砍成 3 個選項，會連帶把
// 競品動態監測的期間篩選也改掉（本輪範圍明確排除競品動態）。
const UPSTREAM_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
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
    const cutoffs = {
      today: taipeiDayStart(now),
      week: taipeiWeekStart(now),
      month: taipeiMonthStart(now),
    };
    const cutoff = cutoffs[timeFilter];
    return searchFiltered.filter(n => {
      const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
      return d >= cutoff;
    });
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

  const shown = useMemo(() => final.slice(0, 80), [final]);

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
          用跟統計卡片／新聞清單同一份 final：不管目前選哪個期間分頁，
          TodayBriefing 自己只挑「今天」的子集合，final 一定涵蓋今天。 */}
      <TodayBriefing articles={final} title="上游市場今日重要情報" />

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
        <h3 className="text-base font-semibold text-gray-200 mb-3 flex items-center gap-2">
          <span>🌐</span>上游供應鏈 ＆ DRAM / Flash 市場新聞
        </h3>

        {/* 時間篩選：只有今天/本週/本月，上游市場專用（見上方 UPSTREAM_TIME_FILTERS） */}
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
          ? <div className="space-y-2">{shown.map((n, i) => <USNewsCard key={n.id || i} article={n} />)}</div>
          : <div className="h-32 flex items-center justify-center text-gray-600 text-sm">
              {upstreamStatus === 'ready' ? '此區間暫無資料' : '載入中…'}
            </div>
        }
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// PR TAB — 統計卡片 + 各媒體曝光篇數圖
// ═══════════════════════════════════════════════════════════
export function PRStatsPanel({ articles, status = 'ready' }) {
  // 用 useNow() 而非 new Date() 直接呼叫：today/week/month 的邊界必須
  // 隨「目前時間」定期更新，不能只在 articles 改變時才重新計算——否則
  // 頁面開著跨過午夜/跨週/跨月，統計會停在舊邊界。三個邊界一律用
  // Asia/Taipei 日曆（taipeiDayStart/taipeiWeekStart/taipeiMonthStart），
  // 不用瀏覽器本地時區的 Date getter——使用者瀏覽器時區不保證是台灣，
  // 且要跟後端 news_cleanup.py 的「本月＋上個月」保留範圍用同一套時區
  // 定義，避免兩邊對「今天/本月」認知不一致。
  const now = useNow();
  const todayStart = taipeiDayStart(now);
  const weekStart = taipeiWeekStart(now);
  const monthStart = taipeiMonthStart(now);
  const getD = n => n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);

  // 註：不用 useMemo。todayStart/weekStart/monthStart 每次 render 都可能
  // 因為時間經過而改變，但只依賴 [articles] 的 useMemo 在 articles 沒變
  // 時就不會重新執行，會讓這幾個統計卡在建立當下的舊日期邊界，跨午夜/
  // 跨週/跨月都不會自動更新。改成每次 render 直接算，反而比「看似有
  // 快取、實際會算錯」安全。
  const counts = {
    today: articles.filter(n => getD(n) >= todayStart).length,
    week: articles.filter(n => getD(n) >= weekStart).length,
    month: articles.filter(n => getD(n) >= monthStart).length,
  };

  const PERIODS = [
    { label: '今天', val: counts.today, color: '#dc2626' },
    { label: '本週', val: counts.week, color: '#ea580c' },
    { label: '本月', val: counts.month, color: '#ca8a04' },
  ];

  return (
    <div className="space-y-4">
      {/* 3 個統計卡片：查詢失敗時明確顯示錯誤，不悄悄顯示 0 */}
      <div className="grid grid-cols-3 gap-3">
        {PERIODS.map(p => (
          <div key={p.label} className="bg-gray-900 border border-gray-700/60 rounded-2xl p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">媒體曝光｜{p.label}</p>
            {status === 'error' ? (
              <p className="text-sm text-red-400 mt-1">⚠ 載入失敗</p>
            ) : status === 'loading' ? (
              <p className="text-sm text-gray-600 mt-1">載入中…</p>
            ) : (
              <>
                <p className="text-3xl font-bold tabular-nums leading-none mt-1" style={{ color: p.color }}>
                  {p.val}
                </p>
                <p className="text-xs text-gray-600 mt-1">篇</p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// PR TAB — 重點媒體曝光分析
// ═══════════════════════════════════════════════════════════
export function KeyMediaPanel({ articles, status = 'ready' }) {
  // useNow()：見 PRStatsPanel 同樣的說明——月邊界必須隨目前時間更新，
  // 且用 Asia/Taipei 日曆月份（taipeiMonthStart），不是瀏覽器本地時區。
  const now = useNow();
  const monthStart = taipeiMonthStart(now);
  const getD = n => n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);

  // 註：不用 useMemo，理由同 PRStatsPanel——避免 monthStart 隨時間變動時，
  // 只依賴 [articles] 的 memo 卡在舊邊界。
  const stats = (() => {
    const monthArticles = articles.filter(n => getD(n) >= monthStart);
    const mTotal = monthArticles.length || 1;

    return KEY_MEDIA.map(km => {
      const monthCount = monthArticles.filter(n =>
        (n.mediaName || n.sourceName || '').includes(km.name)).length;
      return {
        ...km,
        monthCount,
        monthPct: Math.round(monthCount / mTotal * 100),
      };
    }).sort((a, b) => b.monthCount - a.monthCount);
  })();

  const maxMonth = Math.max(...stats.map(s => s.monthCount), 1);

  if (status === 'error') {
    return (
      <Card title="重點媒體曝光監控" icon="🎯">
        <div className="text-sm text-red-400 text-center py-6">⚠ 資料載入失敗，請稍後重新整理</div>
      </Card>
    );
  }

  return (
    <Card title="重點媒體曝光監控" icon="🎯">
      <div className="flex items-center gap-4 mb-3 text-xs text-gray-500">
        <span>本月累計曝光篇數（各媒體佔比）</span>
        <span className="ml-auto w-12 text-right">本月</span>
      </div>
      <div className="space-y-2.5">
        {stats.map((s, i) => (
          <div key={s.name} className="group">
            <div className="flex items-center gap-2 mb-1">
              {/* rank */}
              <span className="text-xs w-4 tabular-nums text-gray-600">{i + 1}</span>
              {/* name */}
              <span className="text-xs text-gray-300 w-28 shrink-0">{s.name}</span>
              <span className="text-xs text-gray-600 hidden sm:inline">{s.en}</span>
              {/* bar */}
              <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{ width: `${Math.round(s.monthCount / maxMonth * 100)}%`, background: i === 0 ? '#ef4444' : BRAND }} />
              </div>
              {/* count */}
              <span className={`text-xs tabular-nums w-8 text-right font-bold ${s.monthCount > 0 ? 'text-ink' : 'text-gray-600'}`}>
                {s.monthCount}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-700 mt-3 text-right">
        本月各媒體篇數{status === 'loading' ? '（載入中…）' : ''}
      </p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// PR TAB — 競品動態
// ═══════════════════════════════════════════════════════════
const TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
  { id: 'year', label: '本年' },
  { id: 'all', label: '已載入資料' },
];

function CompetitorNews({ news }) {
  const [active, setActive] = useState('all');
  const [timeFilter, setTimeFilter] = useState('month');
  const comp = COMPETITORS.find(c => c.id === active);

  const filtered = useMemo(() => {
    const now = new Date();
    const cutoffs = {
      today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      month: new Date(now.getFullYear(), now.getMonth(), 1),
      year: new Date(now.getFullYear(), 0, 1),
      all: null,
    };
    const cutoff = cutoffs[timeFilter];
    return dedupeArticlesByTitle(sortByDate(
      news.filter(n => {
        if (n.cat !== 'competitor') return false;
        if (active !== 'all' && n.brand !== active) return false;
        // 排除 CMoney / 股市爆料同學會（移至 IR 網路輿情）
        const link = (n.link || '').toLowerCase();
        const media = (n.mediaName || n.sourceName || '').toLowerCase();
        if (link.includes('cmoney') || media.includes('cmoney') || media.includes('爆料')) return false;
        if (!cutoff) return true;
        const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
        return d >= cutoff;
      })
    )).slice(0, 80);
  }, [news, active, timeFilter]);

  return (
    <Card title="競品動態監測" icon="🔍" className="h-full">
      {/* Brand tabs — 全部 + 各品牌 */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        <TabBtn active={active === 'all'} onClick={() => setActive('all')}>
          全部
        </TabBtn>
        {COMPETITORS.map(c => (
          <TabBtn key={c.id} active={active === c.id} onClick={() => setActive(c.id)}>
            {c.name}
          </TabBtn>
        ))}
      </div>

      {/* Time filter */}
      <div className="flex gap-1.5 mb-3">
        {TIME_FILTERS.map(f => (
          <TabBtn key={f.id} active={timeFilter === f.id} onClick={() => setTimeFilter(f.id)}>
            {f.label}
          </TabBtn>
        ))}
      </div>

      {filtered.length > 0
        ? <div className="space-y-2">{filtered.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
        : <p className="text-sm text-gray-600 text-center py-8">
            {active === 'all' ? '暫無競品報導' : `暫無 ${comp?.name} 相關報導`}
          </p>
      }
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 股價卡片
// ═══════════════════════════════════════════════════════════
function StockCard({ code, data }) {
  const meta = STOCK_META[code] || {};
  const up = data.changePct > 0, dn = data.changePct < 0;
  const stale = isStockStale(data);
  return (
    <div className="p-4 rounded-2xl bg-gray-900 transition-all">
      <div className="mb-2">
        <CompanyLogo code={code} height={24} />
      </div>
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="text-xs text-gray-500">{code}</p>
          <p className="font-bold text-ink">{data.name || meta.name}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {stale && (
            <span className="text-xs px-2 py-0.5 rounded-full border" title="交易時段中超過 30 分鐘未更新"
              style={{ background: 'rgba(217,119,6,0.15)', color: '#fbbf24', borderColor: 'rgba(217,119,6,0.4)' }}>
              資料過期
            </span>
          )}
        </div>
      </div>
      <p className="text-2xl font-bold text-ink">${data.price ?? '--'}</p>
      <div className={`flex items-center gap-1 text-sm font-semibold mt-1 ${up ? 'text-green-400' : dn ? 'text-red-400' : 'text-gray-400'}`}>
        <span>{up ? '▲' : dn ? '▼' : '─'}</span>
        <span>{up ? '+' : ''}{data.changePct?.toFixed(2) ?? '--'}%</span>
      </div>
      <p className="text-sm text-gray-600 mt-1">
        {up ? '+' : ''}{data.change?.toFixed(1) ?? '--'} ·
        量 {data.volume ? (data.volume / 1000).toFixed(0) + '張' : '--'}
      </p>
      <p className={`text-xs mt-1 ${stale ? 'text-amber-500/80' : 'text-gray-600'}`}>{fmtStockUpdated(data)}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 情緒圓餅圖（既有既存但目前無畫面引用；隨模組搬移原樣保留）
// ═══════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
function SentimentPie({ news }) {
  const data = useMemo(() => {
    const items = news.filter(n => n.cat === 'transcend');
    const cnt = { positive: 0, neutral: 0, negative: 0 };
    items.forEach(n => { const s = n.sentiment || getSentiment(n.title, n.content); if (s in cnt) cnt[s]++; });
    const total = items.length || 1;
    return [
      { name: '正面', value: Math.round(cnt.positive / total * 100), color: '#22c55e' },
      { name: '中立', value: Math.round(cnt.neutral / total * 100), color: '#6b7280' },
      { name: '負面', value: Math.round(cnt.negative / total * 100), color: '#ef4444' },
    ];
  }, [news]);

  const total = news.filter(n => n.cat === 'transcend').length;

  return (
    <Card title="產業情緒分佈（創見相關報導）" icon="🧭">
      <div className="flex items-center gap-2">
        <ResponsiveContainer width="54%" height={170}>
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={44} outerRadius={70}
              paddingAngle={3} dataKey="value" startAngle={90} endAngle={-270}>
              {data.map((d, i) => <Cell key={i} fill={d.color} stroke="transparent" />)}
            </Pie>
            <Tooltip {...TT} formatter={v => [`${v}%`]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-col gap-3 flex-1">
          {data.map(d => (
            <div key={d.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                <span className="text-sm text-gray-300">{d.name}</span>
              </div>
              <span className="text-sm font-bold tabular-nums" style={{ color: d.color }}>{d.value}%</span>
            </div>
          ))}
          <p className="text-xs text-gray-600 mt-1">共分析 {total} 篇報導</p>
        </div>
      </div>
    </Card>
  );
}

// 註：STOCK_CMONEY / STOCK_KW_MAP / detectStockCode（既有既存但目前無
// 畫面引用）已隨模組搬移保留在 src/utils/news.js。

// ═══════════════════════════════════════════════════════════
// IR TAB — 月營收 SVG 圖表（純 SVG，無外部依賴，viewBox 自動縮放）
// ═══════════════════════════════════════════════════════════
function MonthRevSVG({ data }) {
  if (!data || !data.length) return null;
  const PL = 60, PR = 52, PT = 10, PB = 36, VW = 800, VH = 210, CW = VW - PL - PR, CH = VH - PT - PB;
  const maxR = Math.max(...data.map(d => Math.max(d.rev || 0, d.prevYr || 0)), 1);
  const yv = data.map(d => d.yoyPct).filter(v => v != null);
  const minY = yv.length ? Math.min(...yv, 0) : -10, maxY = yv.length ? Math.max(...yv, 0) : 10;
  const rY = Math.max(maxY - minY, 1);
  const step = CW / data.length, bw = step * 0.38;
  const toH = v => ((v || 0) / maxR) * CH;
  const toLY = v => v == null ? null : PT + CH * (1 - (v - minY) / rY);
  const fR = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : `${(v / 1e3).toFixed(0)}K`;
  const rT = [.25, .5, .75, 1].map(t => ({ y: PT + CH * (1 - t), v: maxR * t }));
  let lp = ''; data.forEach((d, i) => { const y = toLY(d.yoyPct); if (y != null) lp += `${lp ? 'L' : 'M'}${PL + i * step + step / 2},${y}`; });
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: 'block' }}>
      {rT.map((t, i) => <line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" />)}
      {minY < 0 && maxY > 0 && <line x1={PL} x2={VW - PR} y1={toLY(0)} y2={toLY(0)} stroke="#374151" strokeWidth="1" strokeDasharray="4,4" />}
      {data.map((d, i) => { const cx = PL + i * step + step / 2; return (<g key={i}>
        <rect x={cx - bw * 1.1} y={PT + CH - toH(d.rev)} width={bw} height={toH(d.rev)} fill="#960014" rx="1" opacity="0.9" />
        <rect x={cx + bw * 0.1} y={PT + CH - toH(d.prevYr)} width={bw} height={toH(d.prevYr)} fill="#374151" rx="1" opacity="0.75" />
      </g>); })}
      {lp && <path d={lp} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />}
      {data.map((d, i) => <text key={i} x={PL + i * step + step / 2} y={VH - PB + 14} textAnchor="middle" fill="#6b7280" fontSize={data.length > 16 ? 7 : 9}>{d.label}</text>)}
      {rT.map((t, i) => <text key={i} x={PL - 5} y={t.y + 4} textAnchor="end" fill="#6b7280" fontSize="9">{fR(t.v)}</text>)}
      {[minY, (minY + maxY) / 2, maxY].map((v, i) => <text key={i} x={VW - PR + 5} y={(toLY(v) || 0) + 4} textAnchor="start" fill="#6b7280" fontSize="9">{v > 0 ? '+' : ''}{v.toFixed(0)}%</text>)}
      <rect x={PL} y={VH - 5} width={10} height={5} fill="#960014" rx="1" />
      <text x={PL + 13} y={VH} fill="#9ca3af" fontSize="9">當月營收</text>
      <rect x={PL + 65} y={VH - 5} width={10} height={5} fill="#374151" rx="1" />
      <text x={PL + 78} y={VH} fill="#9ca3af" fontSize="9">去年同期</text>
      <line x1={PL + 135} x2={PL + 145} y1={VH - 2} y2={VH - 2} stroke="#4ade80" strokeWidth="2" />
      <text x={PL + 148} y={VH} fill="#9ca3af" fontSize="9">年增率</text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 年度營收 SVG 圖表（純 SVG，無外部依賴）
// ═══════════════════════════════════════════════════════════
function AnnualRevSVG({ data }) {
  if (!data || !data.length) return null;
  const PL = 68, PR = 8, PT = 22, PB = 28, VW = 800, VH = 200, CW = VW - PL - PR, CH = VH - PT - PB;
  const maxR = Math.max(...data.map(d => d.total || 0), 1);
  const step = CW / data.length, bw = step * 0.65;
  const toH = v => ((v || 0) / maxR) * CH;
  const fR = v => v >= 1e10 ? `${(v / 1e10).toFixed(0)}百億` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
  const rT = [.25, .5, .75, 1].map(t => ({ y: PT + CH * (1 - t), v: maxR * t }));
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: 'block' }}>
      {rT.map((t, i) => <line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" />)}
      {data.map((d, i) => {
        const x = PL + i * step + (step - bw) / 2, bh = toH(d.total), y = PT + CH - bh;
        const c = d.yoy == null ? '#960014' : d.yoy >= 0 ? '#960014' : '#4b5563';
        return (<g key={i}>
          <rect x={x} y={y} width={bw} height={bh} fill={c} rx="2" opacity="0.85" />
          {d.yoy != null && <text x={x + bw / 2} y={y - 5} textAnchor="middle" fill={d.yoy >= 0 ? '#4ade80' : '#f87171'} fontSize="8">{d.yoy > 0 ? '+' : ''}{d.yoy.toFixed(1)}%</text>}
        </g>);
      })}
      {data.map((d, i) => <text key={i} x={PL + i * step + step / 2} y={VH - PB + 14} textAnchor="middle" fill="#6b7280" fontSize="10">{d.year}</text>)}
      {rT.map((t, i) => <text key={i} x={PL - 5} y={t.y + 4} textAnchor="end" fill="#6b7280" fontSize="9">{fR(t.v)}</text>)}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 月營收圖表
// ═══════════════════════════════════════════════════════════
function RevenueChart({ revenue }) {
  const fmtRev = v => Number(v).toLocaleString(); // 千分位，單位：元

  // 自行建立 lookup map，對照去年同期（不依賴 FinMind 的 revenue_year 欄位）
  const revMap = useMemo(() => {
    if (!revenue) return {};
    const m = {};
    revenue.forEach(r => { m[`${r.year}-${r.month}`] = r.revenue; });
    return m;
  }, [revenue]);

  const data = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    return revenue.slice(-24).map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      return {
        label: `${String(r.year).slice(2)}/${r.month}`,
        rev: r.revenue,
        prevYr,
        yoyPct,
      };
    });
  }, [revenue, revMap]);

  // 近 10 年年度彙總（取 11 筆讓最早那年也能算 YoY）
  const annualData = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    const byYear = {};
    revenue.forEach(r => {
      if (!byYear[r.year]) byYear[r.year] = { year: r.year, total: 0, months: 0 };
      byYear[r.year].total += r.revenue;
      byYear[r.year].months += 1;
    });
    const years = Object.values(byYear).sort((a, b) => a.year - b.year);
    const base = years.slice(-11); // 取 11 筆以計算最早年的 YoY
    return base.map((y, i, arr) => {
      const prev = arr[i - 1];
      const yoy = prev && prev.total > 0
        ? +((y.total - prev.total) / prev.total * 100).toFixed(2)
        : null;
      return { ...y, yoy };
    }).slice(-10); // 最終只顯示 10 年
  }, [revenue]);

  const hasData = data.length > 0;
  const recent12 = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    return [...revenue].slice(-12).reverse().map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      return { ...r, prevYrCalc: prevYr, yoyPctCalc: yoyPct };
    });
  }, [revenue, revMap]);

  return (
    <>
    <Card title="創見月營收（近 24 個月）" icon="💰">
      {hasData ? (
        <>
          <MonthRevSVG data={data} />

          {/* 近 12 個月明細表 */}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700/60 text-gray-500">
                  <th className="text-left pb-1.5 pr-3 font-medium">年月</th>
                  <th className="text-right pb-1.5 pr-3 font-medium">當月營收（元）</th>
                  <th className="text-right pb-1.5 pr-3 font-medium">去年同期（元）</th>
                  <th className="text-right pb-1.5 font-medium">年增率</th>
                </tr>
              </thead>
              <tbody>
                {recent12.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                    <td className="py-1.5 pr-3 text-gray-300 tabular-nums">{r.label}</td>
                    <td className="text-right py-1.5 pr-3 text-ink tabular-nums font-medium">
                      {fmtRev(r.revenue)}
                    </td>
                    <td className="text-right py-1.5 pr-3 text-gray-500 tabular-nums">
                      {r.prevYrCalc > 0 ? fmtRev(r.prevYrCalc) : '—'}
                    </td>
                    <td className={`text-right py-1.5 font-bold tabular-nums ${r.yoyPctCalc == null ? 'text-gray-600' : r.yoyPctCalc > 0 ? 'text-green-400' : r.yoyPctCalc < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      {r.yoyPctCalc == null ? '—' : (r.yoyPctCalc > 0 ? '+' : '') + r.yoyPctCalc + '%'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="h-40 flex items-center justify-center text-gray-600 text-sm">
          {revenue === null ? '載入中…' : '尚無月營收資料（Actions 跑完後自動更新）'}
        </div>
      )}
    </Card>

    {/* 近 10 年年度營收趨勢 */}
    {annualData.length > 0 && (
    <Card title="年度營收趨勢（近 10 年，創見）" icon="📊">
      {/* 折線圖 */}
      <AnnualRevSVG data={annualData} />

      {/* 明細表 */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700/60 text-gray-500">
              <th className="text-left pb-1.5 pr-3 font-medium">年度</th>
              <th className="text-right pb-1.5 pr-3 font-medium">全年營收（元）</th>
              <th className="text-right pb-1.5 pr-3 font-medium">年增率</th>
              <th className="text-right pb-1.5 font-medium">涵蓋月數</th>
            </tr>
          </thead>
          <tbody>
            {[...annualData].reverse().map((y, i) => (
              <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                <td className="py-1.5 pr-3 text-gray-300 font-medium tabular-nums">{y.year}</td>
                <td className="text-right py-1.5 pr-3 text-ink tabular-nums font-medium">{fmtRev(y.total)}</td>
                <td className={`text-right py-1.5 pr-3 font-bold tabular-nums ${y.yoy == null ? 'text-gray-600' : y.yoy > 0 ? 'text-green-400' : y.yoy < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                  {y.yoy == null ? '—' : (y.yoy > 0 ? '+' : '') + y.yoy + '%'}
                </td>
                <td className="text-right py-1.5 tabular-nums">
                  {y.months < 12
                    ? <span className="text-yellow-500">{y.months} 月（統計中）</span>
                    : <span className="text-gray-600">12 月</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 月營收加總，單位：新台幣元</p>
    </Card>
    )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 股價走勢折線圖（既有既存但目前無畫面引用；隨模組搬移原樣保留）
// ═══════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
function StockTrendChart() {
  const LINES = [
    { code: '2451', name: '創見', color: BRAND, w: 2.5 },
    { code: '3260', name: '威剛', color: '#ef4444', w: 1.5 },
    { code: '4973', name: '廣穎', color: '#3b82f6', w: 1.5 },
    { code: '5289', name: '宜鼎', color: '#eab308', w: 1.5 },
    { code: '4967', name: '十銓科技', color: '#a78bfa', w: 1.5 },
    { code: '8271', name: '宇瞻', color: '#22c55e', w: 1.5 },
  ];
  return (
    <Card title="競品股價走勢對比（近 20 個交易日）" icon="📉">
      <ResponsiveContainer width="100%" height={230}>
        <LineChart data={MOCK_STOCK_HISTORY} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} width={38} axisLine={false} tickLine={false} />
          <Tooltip {...TT} />
          <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af', paddingTop: 8 }} />
          {LINES.map(l => (
            <Line key={l.code} type="monotone" dataKey={l.code} name={l.name}
              stroke={l.color} strokeWidth={l.w} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-gray-700 text-center mt-2">
        示意資料 · 每日收盤歷史追蹤功能開發中（需求 #1）
      </p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 財務名詞 Tooltip
// ═══════════════════════════════════════════════════════════
function TermTip({ label, tip }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);

  const showTip = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  const hideTip = () => setPos(null);

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span>{label}</span>}
      <span ref={btnRef}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onClick={() => pos ? hideTip() : showTip()}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-xs font-bold cursor-help select-none shrink-0"
        style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>?</span>
      {pos && ReactDOM.createPortal(
        <span style={{
          position: 'fixed', left: `${pos.x}px`, top: `${pos.y - 10}px`,
          transform: 'translate(-50%, -100%)', zIndex: 9999, width: '260px',
          background: '#ffffff', border: '1px solid #e5e7eb', color: '#334155',
          borderRadius: '12px', padding: '12px', fontSize: '12px', lineHeight: '1.6',
          boxShadow: '0 8px 32px rgba(15,23,42,0.14)', pointerEvents: 'none',
          whiteSpace: 'normal', textAlign: 'left', fontWeight: 'normal',
        }}>
          {tip}
          <span style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0, borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent', borderTop: '5px solid #ffffff',
          }} />
        </span>,
        document.body
      )}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 季度損益摘要
// ═══════════════════════════════════════════════════════════
function QuarterlyPnL({ financials }) {
  const quarters = useMemo(() => {
    if (!financials || !financials.length) return [];
    return [...financials].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [financials]);

  const pctCell = v => {
    if (v == null || v === 0) return <span className="text-gray-600">—</span>;
    const cls = v >= 30 ? 'text-green-400' : v >= 15 ? 'text-yellow-400' : 'text-red-400';
    return <span className={cls}>{v.toFixed(1)}%</span>;
  };

  const TERM_TIPS = {
    grossMargin: { label: '毛利率', tip: '賣東西的收入，扣掉原料和直接製造成本後剩下的比例。毛利率越高，代表產品越有競爭力。例：毛利率 30% = 每賣 100 元有 30 元是毛利。' },
    opMargin: { label: '營業利益率', tip: '毛利再扣掉員工薪資、行銷廣告、管理費用後的比例。反映公司整體營運效率，能看出公司是否「賺了卻花光」。' },
    netMargin: { label: '稅後淨利率', tip: '全部費用和稅都扣完後，公司真正賺到的比例。這是最終「實際入袋」的錢，是評估獲利能力最關鍵的指標之一。' },
    eps: { label: 'EPS', tip: '每股盈餘 = 公司季度獲利 ÷ 發行總股數。EPS 越高代表每股賺越多。例：EPS $2 = 持有 1 張（1000 股）的股東，該季理論上貢獻公司獲利 2,000 元。' },
  };

  return (
    <Card title="季度損益摘要（近 8 季）" icon="📋">
      {quarters.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th className="text-left pb-2 pr-3 font-medium">季度</th>
                {['grossMargin', 'opMargin', 'netMargin', 'eps'].map(k => (
                  <th key={k} className="text-right pb-2 pr-3 font-medium last:pr-0">
                    <span className="inline-flex items-center justify-end gap-1">
                      <span>{TERM_TIPS[k].label}</span>
                      <TermTip tip={TERM_TIPS[k].tip} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quarters.map((q, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-gray-300 tabular-nums">{(q.date || '').slice(0, 7)}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.grossMargin)}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.opMargin)}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.netMargin)}</td>
                  <td className={`text-right py-1.5 pr-0 font-bold tabular-nums ${(q.eps || 0) > 0 ? 'text-ink' : (q.eps || 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {q.eps != null ? `$${Number(q.eps).toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {financials === null ? '載入中…' : '尚無季度損益資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 季度財報 · 顏色：≥30% 綠、15-30% 黃、&lt;15% 紅</p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 歷年股利配息
// ═══════════════════════════════════════════════════════════
function DividendHistory({ dividends }) {
  const records = useMemo(() => {
    if (!dividends || !dividends.length) return [];
    return [...dividends].sort((a, b) => String(b.year).localeCompare(String(a.year))).slice(0, 10);
  }, [dividends]);

  const DIV_TIPS = [
    { label: '現金股利',
      tip: '公司把獲利以現金方式發給股東，是投資人「實際拿到手」的報酬。例：持有 1 張（1000 股）、現金股利 $5 = 實拿 5,000 元現金。' },
    { label: '股票股利',
      tip: '公司發給股東的是股票而非現金。股票張數增加，但每股價值同步稀釋，通常代表公司保留盈餘用於擴充。' },
    { label: '殖利率',
      tip: '現金股利 ÷ 當時股價 × 100%。代表「以此價格買進，一年的配息報酬率」。一般台股殖利率高於 5% 視為高殖利率股，創見近年殖利率約 5-8%。' },
  ];

  const divTipMap = Object.fromEntries(DIV_TIPS.map(d => [d.label, d.tip]));

  return (
    <Card title="歷年股利配息（近 10 年）" icon="💵">
      {records.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th className="text-left pb-2 pr-3 font-medium">配息年度</th>
                <th className="text-right pb-2 pr-3 font-medium">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>現金股利（元）</span>
                    <TermTip tip={divTipMap['現金股利']} />
                  </span>
                </th>
                <th className="text-right pb-2 pr-3 font-medium">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>股票股利（元）</span>
                    <TermTip tip={divTipMap['股票股利']} />
                  </span>
                </th>
                <th className="text-right pb-2 font-medium">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>合計（元）</span>
                    <TermTip tip={divTipMap['殖利率']} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-gray-300 font-medium tabular-nums">{r.year}</td>
                  <td className="text-right py-1.5 pr-3 text-green-400 tabular-nums font-medium">
                    {r.cashDividend > 0 ? `$${Number(r.cashDividend).toFixed(2)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 pr-3 text-blue-400 tabular-nums">
                    {r.stockDividend > 0 ? `$${Number(r.stockDividend).toFixed(2)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 text-ink tabular-nums font-bold">
                    ${Number(r.totalDividend > 0 ? r.totalDividend : (r.cashDividend + r.stockDividend)).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {dividends === null ? '載入中…' : '尚無股利資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 股利資料，金額為每股新台幣元</p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 競品重大訊息
// ═══════════════════════════════════════════════════════════
function CompetitorMaterial({ material }) {
  const COMP_META = {
    '2451': { name: '創見資訊', color: BRAND },
    '3260': { name: '威剛科技', color: '#ef4444' },
    '5289': { name: '宜鼎國際', color: '#eab308' },
    '4967': { name: '十銓科技', color: '#f97316' },
    '8271': { name: '宇瞻科技', color: '#22c55e' },
    '4973': { name: '廣穎電通', color: '#3b82f6' },
  };
  const BADGE_COLOR = {
    '董事會': 'bg-red-900/60 text-red-300 border-red-700/50',
    '股東會': 'bg-purple-900/60 text-purple-300 border-purple-700/50',
    '法人說明會': 'bg-blue-900/60 text-blue-300 border-blue-700/50',
    '股利': 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
    '盈餘分配': 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
    '現金增資': 'bg-orange-900/60 text-orange-300 border-orange-700/50',
    '減資': 'bg-pink-900/60 text-pink-300 border-pink-700/50',
    '下市': 'bg-gray-800/80 text-gray-400 border-gray-600/50',
    '合併': 'bg-cyan-900/60 text-cyan-300 border-cyan-700/50',
  };

  const records = useMemo(() => {
    if (!material || !material.length) return [];
    return [...material].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }, [material]);

  const [filterCode, setFilterCode] = useState('all');

  const filtered = useMemo(() =>
    filterCode === 'all' ? records : records.filter(r => r.code === filterCode),
    [records, filterCode]
  );

  return (
    <Card title="創見與競品 IR 新訊" icon="📢">
      {/* 股票篩選 tabs */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <TabBtn active={filterCode === 'all'} onClick={() => setFilterCode('all')}>全部</TabBtn>
        {['2451', ...COMPETITOR_ORDER].map(code => [code, COMP_META[code]]).map(([code, m]) => (
          <TabBtn key={code} active={filterCode === code} onClick={() => setFilterCode(code)}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: m.color }} />
            {code} {m.name}
          </TabBtn>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
          {filtered.map((r, i) => {
            const meta = COMP_META[r.code] || {};
            return (
              <div key={i} className={`rounded-xl px-3 py-2.5 text-sm border ${r.highlight ? 'border-gray-600/60 bg-gray-800/40' : 'border-gray-800/40 bg-gray-900/30'}`}>
                <div className="flex items-start gap-2">
                  <span className="font-bold shrink-0" style={{ color: meta.color || '#9ca3af' }}>
                    {meta.name || r.name || r.code}
                  </span>
                  <span className="text-gray-500 shrink-0 tabular-nums">{r.date}</span>
                  {r.link
                    ? <a href={r.link} target="_blank" rel="noopener noreferrer"
                        className="content-title flex-1 leading-relaxed hover:underline transition-colors">
                        {r.summary}
                      </a>
                    : <span className="text-gray-300 flex-1 leading-relaxed">{r.summary}</span>
                  }
                </div>
                {r.highlight && r.highlightKw && r.highlightKw.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5 pl-14">
                    {r.highlightKw.map(kw => (
                      <span key={kw} className={`px-1.5 py-0.5 rounded text-xs border font-medium ${BADGE_COLOR[kw] || 'bg-gray-700 text-gray-300 border-gray-600'}`}>
                        {kw}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {material === null ? '載入中…' : '尚無重大訊息資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">
        * 資料來源：FinMind TaiwanStockMaterial ·
        <span className="text-red-400/70"> 董事會</span>
        <span className="text-purple-400/70"> 股東會</span>
        <span className="text-blue-400/70"> 法人說明會</span> 特別標注
      </p>
    </Card>
  );
}

// PR 媒體戰情自己的期間設定：只保留今天/本週/本月。故意不共用下面
// CompetitorNews 用的 TIME_FILTERS（今天/本週/本月/本年/已載入資料）——
// 那個陣列被 CompetitorNews 共用，若直接在這裡砍成 3 個選項，會連帶把
// 競品動態監測的期間篩選也改掉（本輪範圍明確排除競品動態）。
const PR_LIST_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
];

// ═══════════════════════════════════════════════════════════
// PR TAB
// ═══════════════════════════════════════════════════════════
// prArticles/prStatus/refreshPRNews 由 App() 呼叫 usePRNews() 後往下傳
// （不在這裡直接呼叫 hook）：頁面上方「重新整理」按鈕會呼叫 App() 的
// fetchAll()，需要能一併觸發 PR 查詢的 refresh，放在 App() 層級才能
// 跟其他資料來源（股價/財報/新聞…）用同一個按鈕統一觸發。
export function PRTab({ news, prArticles, prStatus, refreshPRNews }) {
  const [timeFilter, setTimeFilter] = useState('month');
  const [prQuery, setPrQuery] = useState('');
  const [prMedia, setPrMedia] = useState('all');
  const [prSentiment, setPrSentiment] = useState('all');

  // 所有有效創見 PR 文章（已排除 CMoney / 券商明細），並在這裡就先去重
  // （dedupeArticlesByTitle）——同一則報導可能因為不同 RSS/搜尋條件被
  // 存成多筆 Firestore 文件，下面的搜尋/媒體/情緒篩選、統計卡片、
  // 排行榜、清單、匯出全部共用這同一份「已去重」結果，確保這幾處看到
  // 的數字彼此一致、也精準對應畫面上實際會顯示的新聞則數。
  const validTranscend = useMemo(
    () => dedupeArticlesByTitle(prArticles.filter(isValidTranscendPR)),
    [prArticles]);

  const mediaOptions = useMemo(
    () => [...new Set(validTranscend.map(n => n.mediaName || n.sourceName || '未知媒體'))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    [validTranscend]);

  // PR 頁面唯一的一個篩選工具列（搜尋／媒體／情緒），只影響下面的創見
  // PR 統計/排行/清單/匯出，不影響 CompetitorNews（那是獨立的期間篩選，
  // 資料來源也不同——見下方 <CompetitorNews> 的說明）。
  const searchFiltered = useMemo(
    () => filterNewsList(validTranscend, { query: prQuery, media: prMedia, sentiment: prSentiment }),
    [validTranscend, prQuery, prMedia, prSentiment]);

  const resetPRFilters = () => {
    setPrQuery('');
    setPrMedia('all');
    setPrSentiment('all');
  };

  // useNow()：時間篩選的邊界必須隨「目前時間」更新，不能只在
  // searchFiltered/timeFilter 改變時才重新計算，否則頁面開著跨過
  // 午夜/跨週/跨月，清單會停在舊邊界（同 PRStatsPanel 的說明）。
  const now = useNow();

  // 完整的期間篩選結果（未截斷，searchFiltered 已經套用搜尋/媒體/情緒，
  // 這裡只需要再依日期篩選）：統計用途（例如 Excel 匯出）需要跟畫面上
  // 「這個期間有幾篇」的實際定義完全一致，不能只看畫面上顯示的前 N 筆。
  const transcendFull = useMemo(() => {
    const cutoffs = {
      today: taipeiDayStart(now),
      week: taipeiWeekStart(now),
      month: taipeiMonthStart(now),
    };
    const cutoff = cutoffs[timeFilter];
    return searchFiltered.filter(n => {
      const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
      return d >= cutoff;
    });
  }, [searchFiltered, timeFilter, now]);

  // 畫面清單只顯示前 50 篇（渲染效能考量，不是資料本身被裁切）；
  // Excel 匯出用上面未截斷的 transcendFull，兩者不是同一份陣列。
  const transcend = useMemo(() => transcendFull.slice(0, 50), [transcendFull]);

  return (
    <div className="space-y-4 fade-in">
      <TodayBriefing articles={news.filter(isBriefingCandidate)} />

      {/* PR 專用篩選工具列：搜尋/媒體/情緒，resultCount／totalCount 一律
          來自 usePRNews 的本月資料，不是受全站 2000 筆上限限制的 news。 */}
      <NewsFilterToolbar
        query={prQuery} setQuery={setPrQuery}
        media={prMedia} setMedia={setPrMedia}
        sentiment={prSentiment} setSentiment={setPrSentiment}
        mediaOptions={mediaOptions}
        resultCount={searchFiltered.length} totalCount={validTranscend.length}
        onReset={resetPRFilters}
      />

      {/* 統計卡片 + 各媒體篇數圖：套用搜尋/媒體/情緒篩選（searchFiltered），
          但不套用今天/本週/本月的期間篩選——三個期間的數字本來就要同時顯示。 */}
      <PRStatsPanel articles={searchFiltered} status={prStatus} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="創見最新報導" icon="📰" className="h-full"
          actions={
            <button onClick={() => exportNewsExcel(transcendFull, '創見最新報導', '創見最新報導')}
              disabled={transcendFull.length === 0}
              className="text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
              ⬇ 匯出 Excel
            </button>
          }>
          {/* 時間篩選：只有今天/本週/本月，PR 專用（見上方 PR_LIST_TIME_FILTERS） */}
          <div className="flex gap-1.5 mb-3">
            {PR_LIST_TIME_FILTERS.map(f => (
              <TabBtn key={f.id} active={timeFilter === f.id} onClick={() => setTimeFilter(f.id)}>
                {f.label}
              </TabBtn>
            ))}
          </div>
          {prStatus === 'error'
            ? <div className="h-32 flex flex-col items-center justify-center gap-2 text-red-400 text-sm">
                <span>⚠ 報導載入失敗</span>
                <button onClick={refreshPRNews}
                  className="text-xs px-3 py-1 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
                  重試
                </button>
              </div>
            : transcend.length > 0
            ? <div className="space-y-2">{transcend.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
            : <div className="h-32 flex items-center justify-center text-gray-600 text-sm">
                {prStatus === 'ready' ? '此區間暫無符合報導' : '載入中…'}
              </div>
          }
        </Card>
        {/* CompetitorNews 仍是自己一份獨立的期間篩選、資料來源是 useNewsFeed
            的 news（不受上面 PR 工具列的搜尋/媒體/情緒篩選影響）——兩者
            刻意分開，避免同一個工具列的數字被誤讀成同時涵蓋兩份清單。 */}
        <CompetitorNews news={news} />
      </div>

      {/* 重點媒體曝光監控：移至最下方，同樣套用搜尋/媒體/情緒篩選 */}
      <KeyMediaPanel articles={searchFiltered} status={prStatus} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 每日交易資訊（開收盤、三大法人）
// ═══════════════════════════════════════════════════════════
function DailyTrading({ daily }) {
  const fmtK = v => {
    const n = Math.abs(Number(v || 0));
    if (n >= 10000) return `${(n / 10000).toFixed(0)}萬`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}千`;
    return n.toLocaleString();
  };
  const netStr = (v, unit = '') => {
    if (v == null) return '—';
    return (v > 0 ? '+' : '') + fmtK(v) + unit;
  };
  const nc = v => v == null ? 'text-gray-400' : v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400';

  if (!daily || (!daily.close && !daily.open)) return (
    <Card title="創見 2451 每日交易資訊" icon="📊">
      <div className="h-20 flex items-center justify-center text-gray-600 text-sm">
        {daily === null ? '載入中…' : '尚無資料（Actions 跑完後自動更新）'}
      </div>
    </Card>
  );

  const change = (daily.close != null && daily.open != null)
    ? +(daily.close - daily.open).toFixed(2) : null;

  return (
    <Card title="創見 2451 每日交易資訊" icon="📊">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 股價 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.priceDate || ''} 股價</p>
          {change != null && (
            <p className={`text-2xl font-bold mb-2 ${nc(change)}`}>
              {change > 0 ? '+' : ''}{change}
            </p>
          )}
          <div className="space-y-1.5">
            {[['開盤', daily.open], ['收盤', daily.close], ['最高', daily.high], ['最低', daily.low]].map(([k, v]) => (
              <div key={k} className="flex justify-between text-sm">
                <span className="text-gray-500">{k}</span>
                <span className="text-ink tabular-nums">{v != null ? v : '—'}</span>
              </div>
            ))}
            <div className="flex justify-between text-sm border-t border-gray-700/40 pt-1 mt-1">
              <span className="text-gray-500">交易量</span>
              <span className="text-ink tabular-nums">{daily.volume ? fmtK(daily.volume) + ' 股' : '—'}</span>
            </div>
          </div>
        </div>

        {/* 外資 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 外資</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.foreignNet)}`}>
            {netStr(daily.foreignNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-green-400/80 tabular-nums">{daily.foreignBuy != null ? fmtK(daily.foreignBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-red-400/80 tabular-nums">{daily.foreignSell != null ? fmtK(daily.foreignSell) : '—'}</span>
            </div>
          </div>
          {daily.foreignBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>

        {/* 投信 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 投信</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.trustNet)}`}>
            {netStr(daily.trustNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-green-400/80 tabular-nums">{daily.trustBuy != null ? fmtK(daily.trustBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-red-400/80 tabular-nums">{daily.trustSell != null ? fmtK(daily.trustSell) : '—'}</span>
            </div>
          </div>
          {daily.trustBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>
      </div>
      <p className="text-xs text-gray-700 mt-2">* 股價：TWSE 即時報價 · 法人：FinMind · 數量單位：股</p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB
// ═══════════════════════════════════════════════════════════
// ─── 競品營收比較圖表 ─────────────────────────────────────
const COMP_REV_META = {
  '2451': { name: '創見', color: '#960014' },
  '3260': { name: 'ADATA 威剛', color: '#ef4444' },
  '5289': { name: '宜鼎國際', color: '#eab308' },
  '4967': { name: '十銓科技', color: '#a855f7' },
  '8271': { name: 'Apacer 宇瞻', color: '#f97316' },
  '4973': { name: '廣穎科技', color: '#3b82f6' },
};

function CompetitorRevenueChart({ revenue, compRev }) {
  const allSeries = useMemo(() => {
    const series = {};
    const addSeries = (code, records) => {
      if (!records || !records.length) return;
      records.forEach(r => {
        const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
        if (!series[key]) series[key] = { label: key };
        series[key][code] = r.revenue;
      });
    };
    addSeries('2451', revenue || []);
    Object.entries(compRev || {}).forEach(([code, recs]) => addSeries(code, recs));
    return Object.values(series).sort((a, b) => a.label < b.label ? -1 : 1).slice(-24);
  }, [revenue, compRev]);

  const compKeys = new Set(Object.keys(compRev || {}));
  const hasCodes = ['2451', ...COMPETITOR_ORDER.filter(c => compKeys.has(c))].filter(c => COMP_REV_META[c]);
  if (!allSeries.length || hasCodes.length < 2) {
    return (
      <div className="text-sm text-gray-600 text-center py-6">
        競品營收資料載入中（Actions 跑完後自動更新）
      </div>
    );
  }

  // SVG 參數
  const W = 700, H = 220, PL = 52, PR = 16, PT = 20, PB = 32;
  const VW = W - PL - PR, VH = H - PT - PB;
  const maxVal = Math.max(...allSeries.flatMap(d => hasCodes.map(c => d[c] || 0)), 1);
  const step = VW / Math.max(allSeries.length - 1, 1);

  const line = (code) => allSeries.map((d, i) => {
    const v = d[code] || 0;
    const x = PL + i * step;
    const y = PT + VH - (v / maxVal) * VH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fmtB = v => v >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}萬` : String(v);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(r => ({ r, v: maxVal * r }));

  // Show every 3rd label
  const labelStep = Math.ceil(allSeries.length / 8);

  return (
    <Card title="創見 vs 競品月營收比較（近 24 個月）" icon="📊">
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3">
        {hasCodes.map(c => (
          <div key={c} className="flex items-center gap-1.5 text-xs text-gray-400">
            <div className="w-3 h-0.5 rounded" style={{ background: COMP_REV_META[c].color, height: '3px', width: '16px' }} />
            {COMP_REV_META[c].name}（{c}）
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
        {/* Y grid + labels */}
        {yTicks.map(t => {
          const y = PT + VH - t.r * VH;
          return (
            <g key={t.r}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#374151" strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PL - 4} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="8">{fmtB(t.v)}</text>
            </g>
          );
        })}
        {/* Lines */}
        {hasCodes.map(c => (
          <path key={c} d={line(c)} fill="none" stroke={COMP_REV_META[c].color} strokeWidth="1.8"
                strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* X labels */}
        {allSeries.map((d, i) => i % labelStep === 0 && (
          <text key={i} x={PL + i * step} y={H - PB + 12} textAnchor="middle" fill="#6b7280" fontSize="7">
            {d.label.slice(2)}
          </text>
        ))}
      </svg>
      <p className="text-xs text-gray-700 mt-1">* 資料來源：FinMind，單位：新台幣元</p>
    </Card>
  );
}

// ─── 年度營收趨勢（近 10 年）─────────────────────────────
function AnnualRevenueChart({ revenue, compRev }) {
  const allYears = useMemo(() => {
    const series = {};
    const addSeries = (code, records) => {
      if (!records || !records.length) return;
      records.forEach(r => {
        const key = String(r.year);
        if (!series[key]) series[key] = { label: key };
        series[key][code] = (series[key][code] || 0) + r.revenue;
      });
    };
    addSeries('2451', revenue || []);
    Object.entries(compRev || {}).forEach(([code, recs]) => addSeries(code, recs));
    return Object.values(series)
      .sort((a, b) => a.label < b.label ? -1 : 1)
      .slice(-10);
  }, [revenue, compRev]);

  const compKeys = new Set(Object.keys(compRev || {}));
  const hasCodes = ['2451', ...COMPETITOR_ORDER.filter(c => compKeys.has(c))].filter(c => COMP_REV_META[c]);

  if (!allYears.length || hasCodes.length < 2) {
    return (
      <div className="text-sm text-gray-600 text-center py-6">
        年度營收資料載入中（Actions 跑完後自動更新）
      </div>
    );
  }

  const W = 700, H = 240, PL = 58, PR = 16, PT = 24, PB = 36;
  const VW = W - PL - PR, VH = H - PT - PB;
  const maxVal = Math.max(...allYears.flatMap(d => hasCodes.map(c => d[c] || 0)), 1);
  const step = VW / Math.max(allYears.length - 1, 1);

  const line = (code) => allYears.map((d, i) => {
    const v = d[code] || 0;
    const x = PL + i * step;
    const y = PT + VH - (v / maxVal) * VH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fmtB = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e8 ? `${(v / 1e8).toFixed(0)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}萬` : String(v);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(r => ({ r, v: maxVal * r }));

  return (
    <Card title="年度營收趨勢（近 10 年）" icon="📈">
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3">
        {hasCodes.map(c => (
          <div key={c} className="flex items-center gap-1.5 text-xs text-gray-400">
            <div style={{ background: COMP_REV_META[c].color, height: '3px', width: '16px', borderRadius: '2px' }} />
            {COMP_REV_META[c].name}（{c}）
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
        {/* Y grid + labels */}
        {yTicks.map(t => {
          const y = PT + VH - t.r * VH;
          return (
            <g key={t.r}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#374151" strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PL - 4} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="8">{fmtB(t.v)}</text>
            </g>
          );
        })}
        {/* Lines */}
        {hasCodes.map(c => (
          <path key={c} d={line(c)} fill="none" stroke={COMP_REV_META[c].color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* Dots at each year */}
        {hasCodes.map(c => allYears.map((d, i) => {
          if (!d[c]) return null;
          const x = PL + i * step;
          const y = PT + VH - ((d[c] || 0) / maxVal) * VH;
          return <circle key={`${c}-${i}`} cx={x} cy={y} r="3" fill={COMP_REV_META[c].color} />;
        }))}
        {/* X year labels */}
        {allYears.map((d, i) => (
          <text key={i} x={PL + i * step} y={H - PB + 14} textAnchor="middle" fill="#6b7280" fontSize="8">
            {d.label}
          </text>
        ))}
      </svg>
      <p className="text-xs text-gray-700 mt-1">* 資料來源：FinMind，各年度月營收合計，單位：新台幣元</p>
    </Card>
  );
}

// news/community 為既有既存但目前無畫面引用的 props（原始檔案的 IRTab
// 也是接了這兩個參數卻未在畫面中使用），隨模組搬移原樣保留。
// eslint-disable-next-line no-unused-vars
function IRTab({ news, stocks, community, revenue, financials, dividends, material, daily, compRev }) {
  return (
    <div className="space-y-4 fade-in">
      {/* Stock cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {['2451', ...COMPETITOR_ORDER].map(code => (
          stocks[code]
            ? <StockCard key={code} code={code} data={stocks[code]} />
            : <div key={code} className="p-4 rounded-2xl border border-gray-700/60 bg-gray-900 flex flex-col items-center justify-center gap-2 min-h-[100px]">
                <span className="text-xs text-gray-500 font-bold">{code}</span>
                <span className="text-xs text-gray-600">{STOCK_META[code].name}</span>
                <span className="text-xs text-gray-700">等待 Actions 更新</span>
              </div>
        ))}
      </div>
      {Object.keys(stocks).length === 0 && (
        <div className="text-xs text-yellow-600/70 bg-yellow-900/10 border border-yellow-800/30 rounded-xl px-4 py-3">
          ⚠ 尚未取得股價 — 請先在 GitHub Actions 手動執行一次 fetch-news workflow，確認 Firebase stocks/latest 文件已建立。
        </div>
      )}

      <DailyTrading daily={daily} />
      <CompetitorMaterial material={material} />
      <RevenueChart revenue={revenue} />
      <CompetitorRevenueChart revenue={revenue} compRev={compRev} />
      <AnnualRevenueChart revenue={revenue} compRev={compRev} />
      <QuarterlyPnL financials={financials} />
      <DividendHistory dividends={dividends} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState('pr');
  const [stocks, setStocks] = useState({});
  const [revenue, setRevenue] = useState(null);
  const [financials, setFinancials] = useState(null);
  const [dividends, setDividends] = useState(null);
  const [material, setMaterial] = useState(null);
  const [daily, setDaily] = useState(null);
  const [compRev, setCompRev] = useState({});
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [stockCountdown, setStockCountdown] = useState(300); // 300s = 5 min（配合 Actions 排程）

  const { news, refresh: refreshNews } = useNewsFeed({
    onFirstPublish: () => setLoading(false),
  });
  const { articles: prArticles, status: prStatus, refresh: refreshPRNews } = usePRNews();
  // enabled: tab === 'us' ——使用者停留在 PR 或 IR 分頁時不建立上游市場
  // 查詢，切到「上游市場」分頁才開始訂閱，離開時立即取消監聽器。
  const { articles: upstreamArticles, status: upstreamStatus, refresh: refreshUpstreamNews } =
    useUpstreamNews({ enabled: tab === 'us' });

  // ─── Firebase init ───────────────────────────────────────
  // getDb() 同步完成離線快取設定（initializeFirestore + persistentLocalCache），
  // 不再需要另外 await 一個「啟用持久化」的非同步步驟——呼叫這行的當下
  // 快取設定就已經生效，之後任何查詢（包含 useNewsFeed 自己掛載時就會
  // 開始的新聞查詢）都安全。
  //
  // useNewsFeed 掛載時會自己啟動新聞管線（見該 hook 內的 useEffect），
  // 這裡的初始 fetchAll 因此改用 fetchAll(false)，不再重複呼叫
  // refreshNews()／建立第二個新聞監聽器；手動按「重新整理」時才會
  // 一併觸發 refreshNews()（見下方 fetchAll 定義與按鈕 onClick）。
  useEffect(() => {
    let unsubStocks = null;
    try {
      const db = getDb();
      setConnected(true);
      fetchAll(false);
      // 股價即時監聽：排程一寫入 stocks/latest，頁面立即更新（免重整）
      unsubStocks = onSnapshot(doc(db, 'stocks', 'latest'),
        snap => { if (snap.exists()) { setStocks(snap.data()); setStockCountdown(300); } },
        err => console.error('Stocks listen:', err)
      );
    } catch (e) {
      console.error('Firebase:', e);
      setLoading(false);
    }
    return () => {
      if (unsubStocks) unsubStocks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 股價每 5 分鐘輪詢（onSnapshot 即時推送的備援）─────────
  useEffect(() => {
    // 倒數計時器：每秒 -1
    const tick = setInterval(() => {
      setStockCountdown(s => {
        if (s <= 1) {
          // 時間到：靜默刷新股價 + 每日交易
          fetchStocks();
          fetchDaily();
          return 300;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  // includeNewsRefresh=false 用在掛載時的初始呼叫：useNewsFeed／usePRNews／
  // useUpstreamNews 自己的 useEffect 已經會在掛載時啟動各自的管線，這裡
  // 不需要（也不應該）再呼叫一次，否則會在監聽器建立前的非同步空窗期
  // 造成重複啟動。手動按「重新整理」則維持 includeNewsRefresh=true
  // （預設值）——這是查詢失敗後主要的重試管道：refreshNews() 在監聽器
  // 已存在時只會重試 cursor 補抓，refreshPRNews()/refreshUpstreamNews()
  // 則會取消舊監聽器並重新訂閱一次新的查詢。refreshUpstreamNews() 在
  // tab !== 'us' 時是安全的 no-op（enabled=false 時 hook 內部不會建立
  // 查詢），不需要在這裡另外判斷目前分頁。
  async function fetchAll(includeNewsRefresh = true) {
    setLoading(true);
    const tasks = [fetchStocks(), fetchRevenue(), fetchFinancials(), fetchDividends(), fetchMaterial(), fetchDaily(), fetchCompRevenue()];
    if (includeNewsRefresh) {
      tasks.push(refreshNews());
      refreshPRNews();
      refreshUpstreamNews();
    }
    await Promise.all(tasks);
    setLoading(false);
    setUpdated(new Date());
  }

  async function fetchStocks() {
    try {
      const snap = await getDoc(doc(getDb(), 'stocks', 'latest'));
      if (snap.exists()) setStocks(snap.data());
    } catch (e) { console.error('Stocks:', e); }
  }

  async function fetchRevenue() {
    try {
      const snap = await getDoc(doc(getDb(), 'revenue', '2451'));
      if (snap.exists()) setRevenue(snap.data().records || []);
      else setRevenue([]);
    } catch (e) { console.error('Revenue:', e); setRevenue([]); }
  }

  async function fetchFinancials() {
    try {
      const snap = await getDoc(doc(getDb(), 'financials', '2451'));
      if (snap.exists()) setFinancials(snap.data().quarters || []);
      else setFinancials([]);
    } catch (e) { console.error('Financials:', e); setFinancials([]); }
  }

  async function fetchDividends() {
    try {
      const snap = await getDoc(doc(getDb(), 'dividends', '2451'));
      if (snap.exists()) setDividends(snap.data().records || []);
      else setDividends([]);
    } catch (e) { console.error('Dividends:', e); setDividends([]); }
  }

  async function fetchMaterial() {
    try {
      const snap = await getDoc(doc(getDb(), 'material', 'competitors'));
      if (snap.exists()) setMaterial(snap.data().records || []);
      else setMaterial([]);
    } catch (e) { console.error('Material:', e); setMaterial([]); }
  }

  async function fetchDaily() {
    try {
      const snap = await getDoc(doc(getDb(), 'daily', '2451'));
      if (snap.exists()) setDaily(snap.data());
      else setDaily({});
    } catch (e) { console.error('Daily:', e); setDaily({}); }
  }

  async function fetchCompRevenue() {
    try {
      const codes = ['3260', '8271', '4967', '5289', '4973'];
      const results = {};
      await Promise.all(codes.map(async code => {
        const snap = await getDoc(doc(getDb(), 'revenue', code));
        if (snap.exists()) results[code] = snap.data().records || [];
      }));
      setCompRev(results);
    } catch (e) { console.error('CompRev:', e); }
  }

  // 社群資料（cat=community，PTT Stock 討論創見/2451）
  const community = useMemo(() =>
    sortByDate(news.filter(n => n.cat === 'community')),
    [news]
  );

  const self = stocks['2451'];
  const updatedStr = updated ? updated.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="light-theme min-h-screen" style={{ background: '#f5f6f8', fontFamily: "'Segoe UI',system-ui,sans-serif" }}>

      {/* ─────────── HEADER ─────────── */}
      <header className="sticky top-0 z-50 shadow-2xl"
        style={{ background: 'rgb(150,0,20)' }}>
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">

          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <TranscendMark height={26} fill="white" />
            <div className="border-l border-white/20 pl-3 hidden sm:block">
              <p className="text-lg font-bold text-white/90 leading-tight tracking-wide">新聞監控</p>
              <p className="text-xs text-red-200/60 leading-tight">News Intelligence</p>
            </div>
          </div>

          {/* PR / IR / US tab switcher */}
          <nav className="flex gap-1 p-1 rounded-xl" style={{ background: 'rgba(0,0,0,0.35)' }}>
            {[
              { id: 'pr', icon: '📡', label: 'PR 媒體戰情' },
              { id: 'ir', icon: '📈', label: 'IR 投資情報' },
              { id: 'us', icon: '🌐', label: '上游市場' },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === t.id ? 'text-white shadow' : 'text-red-200/60 hover:text-white'}`}
                style={tab === t.id ? { background: 'rgba(0,0,0,0.5)' } : {}}>
                <span>{t.icon}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </nav>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => fetchAll()} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}>
              {loading ? <Spinner /> : '↻'}
              <span className="hidden sm:inline">{loading ? '載入中' : '重新整理'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* ─────────── STATUS BAR ─────────── */}
      <div style={{ background: '#ffffff', borderBottom: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(15,23,42,.04)' }}>
        <div className="max-w-7xl mx-auto px-4 h-8 flex items-center gap-4 text-xs overflow-x-auto whitespace-nowrap">
          <span className={connected ? 'text-green-500' : 'text-yellow-500'}>
            {connected ? '● Firebase 已連線' : '○ 連線中…'}
          </span>
          <span className="text-gray-600">📰 {news.length} 則新聞</span>
          {updatedStr && <span className="text-gray-600">更新 {updatedStr}</span>}
          <span className="text-gray-700" title="股價自動更新倒數">
            ⏱ {Math.floor(stockCountdown / 60)}:{String(stockCountdown % 60).padStart(2, '0')}
          </span>
          {self && isStockStale(self) && (
            <span className="text-amber-500" title={`交易時段中超過 30 分鐘未更新（${fmtStockUpdated(self)}）`}>
              ⚠ 股價資料過期
            </span>
          )}
          {self && (
            <span className="text-gray-500">
              創見 <span className={`font-semibold ${self.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                ${self.price} {self.changePct >= 0 ? '▲' : '▼'}{Math.abs(self.changePct ?? 0).toFixed(2)}%
              </span>
            </span>
          )}
          {COMPETITORS.filter(c => c.stock && stocks[c.stock]).map(c => {
            const s = stocks[c.stock];
            const shortName = STOCK_META[c.stock]?.name || c.name;
            return (
              <span key={c.stock} className="text-gray-500">
                {shortName} <span className={`font-semibold ${s.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  ${s.price} {s.changePct >= 0 ? '▲' : '▼'}{Math.abs(s.changePct ?? 0).toFixed(2)}%
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* ─────────── MAIN ─────────── */}
      <main className="max-w-7xl mx-auto px-4 py-5">
        {tab === 'pr' ? (
          <PRTab news={news} prArticles={prArticles} prStatus={prStatus} refreshPRNews={refreshPRNews} />
        ) : tab === 'us' ? (
          <USMarketTab
            upstreamArticles={upstreamArticles}
            upstreamStatus={upstreamStatus}
            refreshUpstreamNews={refreshUpstreamNews}
          />
        ) : (
          <IRTab news={news} stocks={stocks} community={community} revenue={revenue} financials={financials} dividends={dividends} material={material} daily={daily} compRev={compRev} />
        )}
      </main>

    </div>
  );
}
