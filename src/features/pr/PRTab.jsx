import { useState, useMemo } from 'react';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import NewsFilterToolbar from '../../components/filters/NewsFilterToolbar.jsx';
import NewsCard from '../news/NewsCard.jsx';
import TodayBriefing from '../intelligence/TodayBriefing.jsx';
import MediaExposureUpload from './MediaExposureUpload.jsx';
import { useNow } from '../../hooks/useNow.js';
import { exportNewsExcel, exportMediaExposureExcel } from '../../utils/formatting.js';
import {
  sortByDate, taipeiDayStart, taipeiWeekStart, taipeiMonthStart, taipeiPeriodRange, inPeriod,
} from '../../utils/dates.js';
import {
  BRAND, KEY_MEDIA, dedupeArticlesByTitle, isValidTranscendPR,
  isBriefingCandidate, filterNewsList,
} from '../../utils/news.js';
import { COMPETITORS } from '../../config/competitors.js';

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
    lastMonth: articles.filter(n => inPeriod(n, taipeiPeriodRange('lastMonth', now))).length,
  };

  const PERIODS = [
    { label: '今天', val: counts.today, color: '#dc2626' },
    { label: '本週', val: counts.week, color: '#ea580c' },
    { label: '本月', val: counts.month, color: '#ca8a04' },
    { label: '上月', val: counts.lastMonth, color: '#6b7280' },
  ];

  return (
    <div className="space-y-4">
      {/* 3 個統計卡片：查詢失敗時明確顯示錯誤，不悄悄顯示 0 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
    const lastMonthArticles = articles.filter(n => inPeriod(n, taipeiPeriodRange('lastMonth', now)));
    const mTotal = monthArticles.length || 1;
    const countFor = (list, km) => list.filter(n =>
      (n.mediaName || n.sourceName || '').includes(km.name)).length;

    return KEY_MEDIA.map(km => {
      const monthCount = countFor(monthArticles, km);
      return {
        ...km,
        monthCount,
        monthPct: Math.round(monthCount / mTotal * 100),
        lastMonthCount: countFor(lastMonthArticles, km),
      };
    }).sort((a, b) => b.monthCount - a.monthCount || b.lastMonthCount - a.lastMonthCount);
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
        <span>本月／上月累計曝光篇數</span>
        <span className="ml-auto w-8 text-right">本月</span>
        <span className="w-8 text-right">上月</span>
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
              <span className="text-xs tabular-nums w-8 text-right text-gray-500">
                {s.lastMonthCount}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-700 mt-3 text-right">
        本月／上月各媒體篇數{status === 'loading' ? '（載入中…）' : ''}
      </p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// PR TAB — 人工確認曝光（與自動新聞監測分開計算）
// ═══════════════════════════════════════════════════════════
function exposureDate(record) {
  return record.exposureDate?.toDate
    ? record.exposureDate.toDate()
    : new Date(record.exposureDate || 0);
}

export function ManualExposurePanel({ records = [], status = 'idle', onRetry = () => {}, onImported = () => {} }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const now = useNow();
  const monthStart = taipeiMonthStart(now);
  const monthRecords = records.filter(record => exposureDate(record) >= monthStart);
  const uniqueMedia = new Set(records.map(record => record.mediaName).filter(Boolean)).size;
  const latest = records.slice(0, 12);

  return (
    <Card title="人工確認曝光" icon="✓"
      actions={
        <div className="flex gap-1.5 shrink-0">
          <button onClick={() => setUploadOpen(open => !open)} aria-expanded={uploadOpen}
            className="text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">
            {uploadOpen ? '收合上傳' : '⬆ 上傳 Excel'}
          </button>
          <button onClick={() => exportMediaExposureExcel(records)}
            disabled={records.length === 0}
            className="text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed">
            ⬇ 匯出 Excel
          </button>
        </div>
      }>
      <p className="text-xs text-gray-500 mb-4">
        新聞稿發布後由同仁人工核對的實際曝光。此區與自動新聞監測分開統計，內部備註不會顯示在網站。
      </p>

      {uploadOpen && <MediaExposureUpload onImported={onImported} />}

      {status === 'error' ? (
        <div className="py-8 text-center text-sm text-red-400">
          <p>⚠ 人工曝光載入失敗</p>
          <button onClick={onRetry}
            className="mt-2 text-xs px-3 py-1 rounded-lg border border-red-700/60 text-red-300 hover:bg-red-900/30 transition">
            重試
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              ['本月人工確認', monthRecords.length],
              ['已載入曝光', records.length],
              ['涵蓋媒體', uniqueMedia],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-700/60 bg-gray-900 p-3 text-center">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-2xl font-bold text-ink mt-1 tabular-nums">
                  {status === 'loading' ? '…' : value}
                </p>
              </div>
            ))}
          </div>

          {latest.length > 0 ? (
            <div className="divide-y divide-gray-800/70">
              {latest.map(record => {
                const date = exposureDate(record);
                return (
                  <div key={record.id} className="py-2.5 flex gap-3 items-start">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/30 text-green-500 shrink-0">
                      人工確認
                    </span>
                    <div className="min-w-0 flex-1">
                      <a href={record.link} target="_blank" rel="noopener noreferrer"
                        className="text-sm text-ink hover:text-red-500 leading-snug line-clamp-2">
                        {record.title}
                      </a>
                      <p className="text-xs text-gray-500 mt-1">
                        {record.mediaName || '未知媒體'}
                        {record.reporter ? `｜${record.reporter}` : ''}
                        {!isNaN(date.getTime())
                          ? `｜${date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`
                          : ''}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : status === 'ready' ? (
            <div className="py-8 text-center text-sm text-gray-600">尚未匯入人工確認曝光</div>
          ) : null}
          {records.length > latest.length && (
            <p className="text-xs text-gray-600 text-right mt-3">顯示最新 {latest.length} 筆，共 {records.length} 筆</p>
          )}
        </>
      )}
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
    ));
  }, [news, active, timeFilter]);
  const more = useShowMore(filtered, 80, [active, timeFilter]);

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
        ? <>
            <div className="space-y-2">{more.shown.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
            <ShowMoreButton remaining={more.remaining} step={80} onMore={more.showMore} onAll={more.showAll} />
          </>
        : <p className="text-sm text-gray-600 text-center py-8">
            {active === 'all' ? '暫無競品報導' : `暫無 ${comp?.name} 相關報導`}
          </p>
      }
    </Card>
  );
}

// PR 媒體戰情自己的期間設定：只保留今天/本週/本月。故意不共用上面
// CompetitorNews 用的 TIME_FILTERS（今天/本週/本月/本年/已載入資料）——
// 那個陣列被 CompetitorNews 共用，若直接在這裡砍成 3 個選項，會連帶把
// 競品動態監測的期間篩選也改掉（本輪範圍明確排除競品動態）。
const PR_LIST_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
  { id: 'lastMonth', label: '上月' },
];

// ═══════════════════════════════════════════════════════════
// PR TAB
// ═══════════════════════════════════════════════════════════
// prArticles/prStatus/refreshPRNews 由 App() 呼叫 usePRNews() 後往下傳
// （不在這裡直接呼叫 hook）：頁面上方「重新整理」按鈕會呼叫 App() 的
// fetchAll()，需要能一併觸發 PR 查詢的 refresh，放在 App() 層級才能
// 跟其他資料來源（股價/財報/新聞…）用同一個按鈕統一觸發。
export function PRTab({
  news,
  prArticles,
  prStatus,
  refreshPRNews,
  mediaExposure = [],
  mediaExposureStatus = 'idle',
  refreshMediaExposure = () => {},
}) {
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
    const range = taipeiPeriodRange(timeFilter, now);
    return searchFiltered.filter(n => inPeriod(n, range));
  }, [searchFiltered, timeFilter, now]);

  // 畫面清單先顯示前 50 篇，可按「顯示更多」展開（渲染效能考量，不是資料本身被裁切）；
  // Excel 匯出用上面未截斷的 transcendFull，兩者不是同一份陣列。
  const more = useShowMore(transcendFull, 50, [timeFilter, prQuery, prMedia, prSentiment]);
  const transcend = more.shown;

  return (
    <div className="space-y-4 fade-in">
      <TodayBriefing articles={news.filter(isBriefingCandidate)} />

      {/* PR 專用篩選工具列：搜尋/媒體/情緒，resultCount／totalCount 一律
          來自 usePRNews 的本月＋上月資料，不是受全站 2000 筆上限限制的 news。 */}
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
          {/* 時間篩選：今天/本週/本月/上月，PR 專用（見上方 PR_LIST_TIME_FILTERS） */}
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
            ? <>
                <div className="space-y-2">{transcend.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
                <ShowMoreButton remaining={more.remaining} step={50} onMore={more.showMore} onAll={more.showAll} />
              </>
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

      {/* 重點媒體曝光監控：同樣套用搜尋/媒體/情緒篩選 */}
      <KeyMediaPanel articles={searchFiltered} status={prStatus} />

      {/* 人工確認曝光：放在頁面最下方（含 Excel 上傳）；跟自動新聞監測分開統計 */}
      <ManualExposurePanel
        records={mediaExposure}
        status={mediaExposureStatus}
        onRetry={refreshMediaExposure}
        onImported={refreshMediaExposure}
      />
    </div>
  );
}
