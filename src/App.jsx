import { useState, useEffect, useMemo, lazy, Suspense } from 'react';

import { getDb, doc, onSnapshot, getDoc } from './services/firebase.js';
import Spinner from './components/Spinner.jsx';
import StockCountdown from './components/StockCountdown.jsx';
import Icon from './components/Icon.jsx';
import TranscendMark from './components/logos/TranscendMark.jsx';
import { useNewsFeed } from './features/news/useNewsFeed.js';
import { usePRNews } from './features/news/usePRNews.js';
import { useUpstreamNews } from './features/news/useUpstreamNews.js';
import { useMediaExposure } from './features/pr/useMediaExposure.js';
import { useNewsTopics } from './features/events/useNewsTopics.js';
import { useUrlParam } from './hooks/useUrlParam.js';
import { rememberedSection } from './hooks/useSectionNav.js';
import { writeParams, readParam } from './utils/urlState.js';
import { sortByDate, isStockStale, fmtStockUpdated } from './utils/dates.js';
import { COMPETITORS, STOCK_META } from './config/competitors.js';

// 三個分頁各自的程式碼／SVG 圖表都相當大，但同時只會顯示一個——lazy
// load 讓使用者只下載目前分頁需要的程式碼，不用一次打包進主 bundle。
// 主分頁存在網址 ?tab=（pr／ir／us／health；沒有或不認識的值 → pr），上一頁／下一頁會切換分頁。
// 'events' 只是舊網址的別名：事件已整合進「上游市場 → 事件」，見下方的導向
const TAB_IDS = ['pr', 'events', 'ir', 'us', 'health'];

const PRTab = lazy(() => import('./features/pr/PRTab.jsx').then(m => ({ default: m.PRTab })));
const USMarketTab = lazy(() => import('./features/market/USMarketTab.jsx').then(m => ({ default: m.USMarketTab })));
const IRTab = lazy(() => import('./features/ir/IRTab.jsx').then(m => ({ default: m.IRTab })));
const HealthTab = lazy(() => import('./features/health/HealthTab.jsx').then(m => ({ default: m.HealthTab })));

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [tab] = useUrlParam('tab', TAB_IDS, 'pr');
  // 切換主分頁時 section 換成該分頁上次停留的子頁（沒有就移除 → 預設的總覽）；PR 與 IR 各記各的
  const setTab = id => writeParams({ tab: id, section: rememberedSection(id), filter: null });
  const [stocks, setStocks] = useState({});
  const [revenue, setRevenue] = useState(null);
  const [financials, setFinancials] = useState(null);
  const [dividends, setDividends] = useState(null);
  const [material, setMaterial] = useState(null);
  const [daily, setDaily] = useState(null);
  const [compRev, setCompRev] = useState({});
  // 各 IR 資料集是否載入失敗（失敗時資料仍是空值；用來區分「載入失敗」與「尚無資料」）
  const [loadErrors, setLoadErrors] = useState({});
  // 新聞稿主檔同步狀態（job_status/press_release_sync，一次性讀取、沒有監聽器）：null＝尚未讀到
  const [pressSync, setPressSync] = useState(null);
  const markLoad = (key, failed) => setLoadErrors(prev => (prev[key] === failed ? prev : { ...prev, [key]: failed }));
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [updated, setUpdated] = useState(null);

  const { news, refresh: refreshNews } = useNewsFeed({
    onFirstPublish: () => setLoading(false),
  });
  const { articles: prArticles, status: prStatus, refresh: refreshPRNews } = usePRNews();
  const {
    records: mediaExposure,
    status: mediaExposureStatus,
    refresh: refreshMediaExposure,
  } = useMediaExposure({ enabled: tab === 'pr' });
  // 事件中心（news_topics）：PR 總覽、上游市場與事件中心用得到；一次性讀取，沒有監聽器
  const { topics, status: topicsStatus, refresh: refreshTopics } = useNewsTopics({ enabled: tab === 'pr' || tab === 'us' || tab === 'events' });
  // 舊網址 ?tab=events[&filter=…] → 上游市場的「事件」子頁（用 replace，不留下無效的歷史紀錄）
  useEffect(() => {
    if (tab === 'events') writeParams({ tab: 'us', section: 'events', filter: readParam('filter') }, { replace: true });
  }, [tab]);
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
        snap => { if (snap.exists()) setStocks(snap.data()); },
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
    const tasks = [fetchStocks(), fetchRevenue(), fetchFinancials(), fetchDividends(), fetchMaterial(), fetchDaily(), fetchCompRevenue(), fetchPressSync()];
    if (includeNewsRefresh) {
      tasks.push(refreshNews());
      refreshPRNews();
      refreshUpstreamNews();
      refreshMediaExposure();
      refreshTopics();
    }
    await Promise.all(tasks);
    setLoading(false);
    setUpdated(new Date());
  }

  async function fetchStocks() {
    try {
      const snap = await getDoc(doc(getDb(), 'stocks', 'latest'));
      if (snap.exists()) setStocks(snap.data());
      markLoad('stocks', false);
    } catch (e) { console.error('Stocks:', e); markLoad('stocks', true); }
  }

  async function fetchRevenue() {
    try {
      const snap = await getDoc(doc(getDb(), 'revenue', '2451'));
      if (snap.exists()) setRevenue(snap.data().records || []);
      else setRevenue([]);
      markLoad('revenue', false);
    } catch (e) { console.error('Revenue:', e); setRevenue([]); markLoad('revenue', true); }
  }

  async function fetchFinancials() {
    try {
      const snap = await getDoc(doc(getDb(), 'financials', '2451'));
      if (snap.exists()) setFinancials(snap.data().quarters || []);
      else setFinancials([]);
      markLoad('financials', false);
    } catch (e) { console.error('Financials:', e); setFinancials([]); markLoad('financials', true); }
  }

  async function fetchDividends() {
    try {
      const snap = await getDoc(doc(getDb(), 'dividends', '2451'));
      if (snap.exists()) setDividends(snap.data().records || []);
      else setDividends([]);
      markLoad('dividends', false);
    } catch (e) { console.error('Dividends:', e); setDividends([]); markLoad('dividends', true); }
  }

  async function fetchMaterial() {
    try {
      const snap = await getDoc(doc(getDb(), 'material', 'competitors'));
      if (snap.exists()) setMaterial(snap.data().records || []);
      else setMaterial([]);
      markLoad('material', false);
    } catch (e) { console.error('Material:', e); setMaterial([]); markLoad('material', true); }
  }

  async function fetchDaily() {
    try {
      const snap = await getDoc(doc(getDb(), 'daily', '2451'));
      if (snap.exists()) setDaily(snap.data());
      else setDaily({});
      markLoad('daily', false);
    } catch (e) { console.error('Daily:', e); setDaily({}); markLoad('daily', true); }
  }

  async function fetchPressSync() {
    try {
      const snap = await getDoc(doc(getDb(), 'job_status', 'press_release_sync'));
      if (!snap.exists()) { setPressSync({ missing: true }); return; }
      const d = snap.data();
      const ms = v => (v && typeof v.toDate === 'function' ? v.toDate() : null);
      setPressSync({
        lastSyncAt: ms(d.lastSyncAt) || ms(d.lastSuccessAt),
        failedSinceSuccess: Boolean(ms(d.lastErrorAt) && (!ms(d.lastSuccessAt) || ms(d.lastErrorAt) > ms(d.lastSuccessAt))),
        report: d.report && typeof d.report === 'object' ? d.report : null,
        // 新聞稿清單（ID／標題／日期）：「待確認配對」匯出 Excel 時查 pressReleaseId 用
        pressReleases: Array.isArray(d.pressReleases)
          ? d.pressReleases.filter(p => p && typeof p.id === 'string' && typeof p.title === 'string')
            .map(p => ({ id: p.id, title: p.title, date: typeof p.date === 'string' ? p.date : '' }))
          : [],
      });
    } catch (e) { console.error('PressSync:', e); setPressSync({ error: true }); }
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
      markLoad('compRev', false);
    } catch (e) { console.error('CompRev:', e); markLoad('compRev', true); }
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
        <div className="max-w-7xl mx-auto px-2 sm:px-4 h-14 flex items-center justify-between gap-1.5 sm:gap-3">

          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <TranscendMark height={20} fill="white" />
            <div className="border-l border-white/20 pl-3 hidden sm:block">
              <p className="text-lg font-bold text-white/90 leading-tight tracking-wide">新聞監控</p>
              <p className="text-xs text-red-200/60 leading-tight">News Intelligence</p>
            </div>
          </div>

          {/* PR / IR / US tab switcher */}
          <nav className="flex gap-0.5 sm:gap-1 p-1 rounded-xl" style={{ background: 'rgba(0,0,0,0.35)' }}>
            {[
              { id: 'pr', icon: 'megaphone', label: 'PR 媒體戰情' },
              { id: 'ir', icon: 'trend', label: 'IR 投資情報' },
              { id: 'us', icon: 'globe', label: '上游市場' },
              { id: 'health', icon: 'activity', label: '系統健康' },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-2 sm:px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === t.id ? 'text-white shadow' : 'text-red-200/60 hover:text-white'}`}
                style={tab === t.id ? { background: 'rgba(0,0,0,0.5)' } : {}}>
                <Icon name={t.icon} className="text-[1.25em]" />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
          </nav>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => fetchAll()} disabled={loading}
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}>
              {loading ? <Spinner /> : <Icon name="refresh" />}
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
          <span className="text-gray-600"><Icon name="news" /> {news.length} 則新聞</span>
          {updatedStr && <span className="text-gray-600">更新 {updatedStr}</span>}
          <StockCountdown resetSignal={stocks} onExpire={() => { fetchStocks(); fetchDaily(); }} />
          {self && isStockStale(self) && (
            <span className="text-amber-500" title={`交易時段中超過 30 分鐘未更新（${fmtStockUpdated(self)}）`}>
              <Icon name="alert" /> 股價資料過期
            </span>
          )}
          {self && (
            <span className="text-gray-500">
              創見 <span className={`font-semibold ${self.changePct >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                ${self.price} {self.changePct >= 0 ? '▲' : '▼'}{Math.abs(self.changePct ?? 0).toFixed(2)}%
              </span>
            </span>
          )}
          {COMPETITORS.filter(c => c.stock && stocks[c.stock]).map(c => {
            const s = stocks[c.stock];
            const shortName = STOCK_META[c.stock]?.name || c.name;
            return (
              <span key={c.stock} className="text-gray-500">
                {shortName} <span className={`font-semibold ${s.changePct >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                  ${s.price} {s.changePct >= 0 ? '▲' : '▼'}{Math.abs(s.changePct ?? 0).toFixed(2)}%
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* ─────────── MAIN ─────────── */}
      <main className="max-w-7xl mx-auto px-4 py-5">
        {/* 三個分頁都是 lazy load，切換分頁或重新整理時第一次進入該分頁
            會有短暫的載入態；fallback 維持跟原本「載入中」骨架一致的
            高度感，避免畫面跳動。 */}
        <Suspense fallback={<div className="h-32 flex items-center justify-center text-gray-500 text-sm">載入中…</div>}>
          {tab === 'pr' ? (
            <PRTab
              news={news}
              prArticles={prArticles}
              prStatus={prStatus}
              refreshPRNews={refreshPRNews}
              mediaExposure={mediaExposure}
              mediaExposureStatus={mediaExposureStatus}
              refreshMediaExposure={refreshMediaExposure}
              pressSync={pressSync}
              topics={topics}
              topicsStatus={topicsStatus}
            />
          ) : tab === 'events' ? null : tab === 'us' ? (
            <USMarketTab
              upstreamArticles={upstreamArticles}
              upstreamStatus={upstreamStatus}
              refreshUpstreamNews={refreshUpstreamNews}
              topics={topics}
              topicsStatus={topicsStatus}
              refreshTopics={refreshTopics}
            />
          ) : tab === 'health' ? (
            <HealthTab />
          ) : (
            <IRTab news={news} stocks={stocks} community={community} revenue={revenue} financials={financials} dividends={dividends} material={material} daily={daily} compRev={compRev} loadErrors={loadErrors} loading={loading} />
          )}
        </Suspense>
      </main>

    </div>
  );
}
