import { useMemo } from 'react';
import Card from '../../components/Card.jsx';
import { dedupeArticlesByTitle, getBriefingMeta, getActionSuggestion } from '../../utils/news.js';
import { fmtDate, taipeiDayStart } from '../../utils/dates.js';
import { useNow } from '../../hooks/useNow.js';

export default function TodayBriefing({ articles, title = '今日情報快報' }) {
  // useNow()：「今天」必須用 Asia/Taipei 日曆邊界（taipeiDayStart），不是
  // 瀏覽器本地時區的 getFullYear/getMonth/getDate——本地時區不保證是
  // 台灣，跟後端 news_cleanup.py、usePRNews/useUpstreamNews 的期間篩選
  // 用同一套時區定義才不會兜不起來。useMemo 依賴也必須包含 now：頁面
  // 開著跨過台灣午夜時，即使 articles 完全沒變，也要重新計算「今天」
  // 的邊界並讓已經不屬於今天的文章自動退出清單。
  const now = useNow();
  const items = useMemo(() => {
    const todayStart = taipeiDayStart(now);
    const today = dedupeArticlesByTitle(articles).filter(n => {
      const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
      return d.getTime() >= todayStart.getTime();
    });
    return today
      .map(article => {
        const meta = getBriefingMeta(article);
        return { article, meta, action: getActionSuggestion(article, meta) };
      })
      .filter(item => item.meta.kind !== 'news')
      .sort((a, b) => b.meta.score - a.meta.score)
      .slice(0, 6);
  }, [articles, now]);

  const summary = useMemo(() => ({
    important: items.length,
    risks: items.filter(item => item.meta.kind === 'risk').length,
    competitors: items.filter(item => item.article.cat === 'competitor').length,
  }), [items]);

  const badgeClass = {
    risk: 'bg-red-900/40 text-red-300 border-red-700/50',
    finance: 'bg-blue-900/60 text-blue-300 border-blue-700/50',
    opportunity: 'bg-green-900/40 text-green-300 border-green-700/50',
    market: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
    news: 'bg-gray-800 text-gray-400 border-gray-600/50',
  };

  return (
    <Card title={title} icon="☀️">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 -mt-1 mb-3">
        <p className="text-xs text-gray-500">今天的重要消息與建議下一步</p>
        <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-500 whitespace-nowrap">規則分析 · 零 API 費用</span>
      </div>
      {items.length > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="rounded-xl bg-gray-800/40 border border-gray-700/40 px-3 py-2">
              <p className="text-xs text-gray-500">重要消息</p>
              <p className="text-lg font-bold text-ink">{summary.important}<span className="text-xs font-normal text-gray-500 ml-1">則</span></p>
            </div>
            <div className="rounded-xl bg-red-900/40 border border-red-700/50 px-3 py-2">
              <p className="text-xs text-red-300">風險提醒</p>
              <p className="text-lg font-bold text-red-300">{summary.risks}<span className="text-xs font-normal ml-1">則</span></p>
            </div>
            <div className="rounded-xl bg-blue-900/60 border border-blue-700/50 px-3 py-2">
              <p className="text-xs text-blue-300">競品動態</p>
              <p className="text-lg font-bold text-blue-300">{summary.competitors}<span className="text-xs font-normal ml-1">則</span></p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {items.map(({ article, meta, action }, i) => (
            <a key={article.id || i} href={article.link || '#'} target="_blank" rel="noreferrer"
              className="group rounded-xl border border-gray-700/40 bg-gray-800/40 hover:bg-gray-800 hover:border-gray-600 p-3 transition-all min-w-0">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${badgeClass[meta.kind]}`}>{meta.label}</span>
                <span className="text-xs text-gray-600">{fmtDate(article.pubDate)}</span>
              </div>
              <p className="content-title text-sm font-semibold leading-relaxed line-clamp-3 transition-colors">{article.title}</p>
              <p className="text-xs text-gray-500 mt-2">入選原因：{meta.reasons.join(' · ')}</p>
              <div className="mt-2 pt-2 border-t border-gray-700/40">
                <p className="text-xs font-semibold text-secondary mb-0.5">建議下一步</p>
                <p className="text-sm text-gray-500 leading-relaxed">{action}</p>
              </div>
            </a>
          ))}
          </div>
        </>
      ) : <div className="py-6 text-center text-sm text-gray-600">今天目前沒有需要處理的重要情報</div>}
    </Card>
  );
}
