import Icon from '../../components/Icon.jsx';
import ActionButton from '../../components/ui/ActionButton.jsx';
import { tagClass } from '../../components/tagStyles.js';
import { EVENT_TYPE_LABELS, durationText, isRising, sentimentText, velocityText } from './eventData.js';

const SENT_TONE = { positive: 'green', neutral: 'gray', negative: 'red' };
const fmtTime = d => (d
  ? d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  : '—');
const SHOWN_ARTICLES = 20;

/** 展開後的原始新聞：連結已通過 safeHttpUrl，沒有安全連結的標題不輸出 <a>。 */
function ArticleList({ articles, showAll, onShowAll }) {
  const shown = showAll ? articles : articles.slice(0, SHOWN_ARTICLES);
  return (
    <div>
      <ul className="divide-y divide-ui-line">
        {shown.map(a => (
          <li key={a.id} className="py-1.5 flex flex-wrap items-start gap-x-2 gap-y-0.5 text-sm">
            <span className="shrink-0 text-xs text-ui-muted tabular-nums w-24">{fmtTime(a.date)}</span>
            <span className="shrink-0 text-xs font-medium text-ui-secondary w-20 truncate" title={a.mediaName}>{a.mediaName}</span>
            {a.link
              ? <a href={a.link} target="_blank" rel="noopener noreferrer" className="min-w-0 basis-full sm:basis-0 sm:flex-1 text-ink hover:text-brand leading-snug break-words">{a.title}</a>
              : <span className="min-w-0 basis-full sm:basis-0 sm:flex-1 text-ink leading-snug break-words">{a.title}</span>}
          </li>
        ))}
      </ul>
      {!showAll && articles.length > SHOWN_ARTICLES && (
        <ActionButton onClick={onShowAll} className="mt-2">顯示全部 {articles.length} 則</ActionButton>
      )}
    </div>
  );
}

export default function EventCard({ topic, open, onToggle, allArticles, onShowAllArticles }) {
  const detailId = `event-${topic.id}`;
  const rising = isRising(topic);
  return (
    <article className="list-row rounded-lg border border-ui-line bg-ui-soft" data-testid="event-card">
      <button onClick={onToggle} aria-expanded={open} aria-controls={detailId}
        className="ui-focus w-full text-left p-3 flex items-start gap-3 hover:bg-ui-surface rounded-lg transition">
        <Icon name="chevronright" className={`mt-1 text-ui-muted transition-transform shrink-0 ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink leading-snug break-words">{topic.title}</h3>
          <p className="text-xs text-ui-muted mt-1">
            {topic.articleCount} 篇報導｜{topic.mediaCount} 家媒體｜最新 {fmtTime(topic.last)}
          </p>
          {/* 顏色只表達語意：情緒（紅／綠）與升溫（紅）；其餘一律中性，低信心的「待確認」低調標示 */}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <span className={tagClass(SENT_TONE[topic.sentiment])}>情緒：{sentimentText(topic)}</span>
            <span className={tagClass(rising ? 'red' : 'gray')}>{rising ? '▲ ' : ''}{velocityText(topic)}</span>
            {topic.needsReview && <span className="text-xs text-ui-muted border border-dashed border-ui-strong rounded-full px-2 py-0.5">待確認（聚類信心較低）</span>}
            {topic.companies.length > 0 && <span className="text-xs text-ui-muted">涉及：{topic.companies.slice(0, 5).join('、')}</span>}
          </div>
          {topic.importanceReasons.length > 0 && (
            <p className="text-xs text-ui-muted mt-2" data-testid="event-reasons">
              <span className="font-medium text-ui-secondary">重要原因：</span>{topic.importanceReasons.join('、')}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold text-ink tabular-nums leading-none" aria-label={`重要性 ${topic.importance}`}>{topic.importance}</p>
          <span className="text-xs text-ui-muted">重要性</span>
        </div>
      </button>
      {open && (
        <div id={detailId} className="px-3 pb-3 border-t border-ui-line pt-2 space-y-2">
          <p className="text-xs text-ui-muted">
            {EVENT_TYPE_LABELS[topic.eventType] || '其他'}事件｜持續 {durationText(topic)}｜首次 {fmtTime(topic.first)}
          </p>
          {topic.summary && <p className="text-xs text-ui-muted">{topic.summary}</p>}
          <p className="text-xs text-ui-muted">原始新聞（新到舊）</p>
          {topic.articles.length > 0
            ? <ArticleList articles={topic.articles} showAll={allArticles} onShowAll={onShowAllArticles} />
            : <p className="text-sm text-ui-muted py-2">這個事件沒有可顯示的原始新聞</p>}
        </div>
      )}
    </article>
  );
}
