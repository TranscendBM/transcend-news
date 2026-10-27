import MetricCard from '../../components/ui/MetricCard.jsx';
import { useNow } from '../../hooks/useNow.js';
import {
  taipeiDayStart, taipeiWeekStart, taipeiMonthStart, taipeiPeriodRange, inPeriod,
} from '../../utils/dates.js';

// ═══════════════════════════════════════════════════════════
// PR — 統計卡片：媒體曝光｜今天／本週／本月／上月
// 新聞監測（套用搜尋／媒體／情緒篩選）與總覽（全部有效創見報導）共用這一個元件，
// 統計定義只有一份。
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
    { label: '今天', val: counts.today },
    { label: '本週', val: counts.week },
    { label: '本月', val: counts.month },
    { label: '上月', val: counts.lastMonth },
  ];
  const cardState = status === 'error' ? 'error' : status === 'loading' ? 'loading' : 'ready';

  return (
    <div className="space-y-4">
      {/* 統計卡片：查詢失敗明確顯示錯誤、載入中顯示骨架，不悄悄顯示 0（重點數字用品牌紅） */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {PERIODS.map(p => (
          <MetricCard key={p.label} label={`媒體曝光｜${p.label}`} value={`${p.val}`} hint={cardState === 'ready' ? '篇' : undefined} state={cardState}
            tone="text-brand !text-3xl" className="text-center" />
        ))}
      </div>
    </div>
  );
}
