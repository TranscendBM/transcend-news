import Card from '../../components/Card.jsx';
import Icon from '../../components/Icon.jsx';
import { useNow } from '../../hooks/useNow.js';
import { taipeiMonthStart, taipeiPeriodRange, inPeriod } from '../../utils/dates.js';
import { BRAND, KEY_MEDIA } from '../../utils/news.js';
import { ViewAllButton } from './PRSummaryCard.jsx';

// ═══════════════════════════════════════════════════════════
// PR — 重點媒體曝光分析（本月／上月各重點媒體的報導篇數）
// limit：只顯示前 N 家（總覽用 5）；onViewAll：有的話在標題旁顯示「查看全部」。
// 排名與篇數的算法只有這一份，總覽和曝光成效頁共用。
// ═══════════════════════════════════════════════════════════
export function KeyMediaPanel({ articles, status = 'ready', limit, onViewAll }) {
  // useNow()：見 PRStatsPanel 同樣的說明——月邊界必須隨目前時間更新，
  // 且用 Asia/Taipei 日曆月份（taipeiMonthStart），不是瀏覽器本地時區。
  const now = useNow();
  const monthStart = taipeiMonthStart(now);
  const getD = n => n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
  const actions = onViewAll ? <ViewAllButton onClick={onViewAll} label="查看全部：重點媒體曝光監控" /> : undefined;

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

  const shown = limit ? stats.slice(0, limit) : stats;
  const maxMonth = Math.max(...stats.map(s => s.monthCount), 1);

  if (status === 'error') {
    return (
      <Card title="重點媒體曝光監控" icon="target" actions={actions} className="h-full">
        <div className="text-sm text-red-400 text-center py-6"><Icon name="alert" /> 資料載入失敗，請稍後重新整理</div>
      </Card>
    );
  }

  return (
    <Card title="重點媒體曝光監控" icon="target" actions={actions} className="h-full">
      <div className="flex items-center gap-4 mb-3 text-xs text-gray-500">
        <span>本月／上月累計曝光篇數</span>
        <span className="ml-auto w-8 text-right">本月</span>
        <span className="w-8 text-right">上月</span>
      </div>
      <div className="space-y-2.5">
        {shown.map((s, i) => (
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
