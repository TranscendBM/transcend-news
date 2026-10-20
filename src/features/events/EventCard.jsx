import Icon from '../../components/Icon.jsx';
import { tagClass } from '../../components/tagStyles.js';
import { EVENT_TYPE_LABELS, durationText, isRising, sentimentText, velocityText } from './eventData.js';

const SENT_TONE = { positive: 'green', neutral: 'gray', negative: 'red' };
const fmtTime = d => (d
  ? d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  : '—');
const SHOWN_ARTICLES = 20;

/** 重要性分數的顏色等級（只做視覺提示，數字與原因都會寫出來）。 */
const importanceTone = score => (score >= 70 ? 'red' : score >= 45 ? 'amber' : 'gray');

/** 展開後的原始新聞：連結已通過 safeHttpUrl，沒有安全連結的標題不輸出 <a>。 */
function ArticleList({ articles, showAll, onShowAll }) {
  const shown = showAll ? articles : articles.slice(0, SHOWN_ARTICLES);
  return (
    <div>
      <ul className="divide-y divide-gray-800/50">
        {shown.map(a => (
          <li key={a.id} className="py-1.5 flex items-start gap-2 text-sm">
            <span className="shrink-0 text-xs text-gray-500 tabular-nums w-24">{fmtTime(a.date)}</span>
            <span className="shrink-0 text-xs font-medium text-gray-300 w-20 truncate" title={a.mediaName}>{a.mediaName}</span>
            {a.link
              ? <a href={a.link} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 text-ink hover:text-red-500 leading-snug">{a.title}</a>
              : <span className="min-w-0 flex-1 text-ink leading-snug">{a.title}</span>}
          </li>
        ))}
      </ul>
      {!showAll && articles.length > SHOWN_ARTICLES && (
        <button onClick={onShowAll} className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">
          顯示全部 {articles.length} 則
        </button>
      )}
    </div>
  );
}

export default function EventCard({ topic, open, onToggle, allArticles, onShowAllArticles }) {
  const detailId = `event-${topic.id}`;
  const rising = isRising(topic);
  return (
    <article className="list-row rounded-xl border border-gray-700/40 bg-gray-800/40" data-testid="event-card">
      <button onClick={onToggle} aria-expanded={open} aria-controls={detailId}
        className="w-full text-left p-3 flex items-start gap-3 hover:bg-gray-800 rounded-xl transition">
        <Icon name="chevronright" className={`mt-1 text-gray-500 transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink leading-snug break-words">{topic.title}</h3>
          <p className="text-xs text-gray-500 mt-1">
            {topic.articleCount} 篇報導｜{topic.mediaCount} 家媒體｜持續 {durationText(topic)}
            ｜首次 {fmtTime(topic.first)}｜最新 {fmtTime(topic.last)}
          </p>
          {topic.summary && <p className="text-xs text-gray-500 mt-0.5">{topic.summary}</p>}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {topic.companies.length > 0 && <span className={tagClass('gray')}>涉及：{topic.companies.slice(0, 5).join('、')}</span>}
            <span className={tagClass(SENT_TONE[topic.sentiment])}>情緒：{sentimentText(topic)}</span>
            <span className={tagClass(rising ? 'red' : 'gray')}>{rising ? '▲ ' : ''}{velocityText(topic)}</span>
            <span className={tagClass('blue')}>{EVENT_TYPE_LABELS[topic.eventType] || '其他'}</span>
            {topic.needsReview && <span className={tagClass('amber')}>待確認（聚類信心較低）</span>}
          </div>
          {topic.importanceReasons.length > 0 && (
            <p className="text-xs text-gray-500 mt-2" data-testid="event-reasons">
              <span className="font-medium text-gray-400">重要原因：</span>{topic.importanceReasons.join('、')}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold text-ink tabular-nums leading-none" aria-label={`重要性 ${topic.importance}`}>{topic.importance}</p>
          <span className={`${tagClass(importanceTone(topic.importance))} inline-block mt-1`}>重要性</span>
        </div>
      </button>
      {open && (
        <div id={detailId} className="px-3 pb-3 border-t border-gray-800/50 pt-2">
          <p className="text-xs text-gray-500 mb-1">原始新聞（新到舊）</p>
          {topic.articles.length > 0
            ? <ArticleList articles={topic.articles} showAll={allArticles} onShowAll={onShowAllArticles} />
            : <p className="text-sm text-gray-500 py-2">這個事件沒有可顯示的原始新聞</p>}
        </div>
      )}
    </article>
  );
}
