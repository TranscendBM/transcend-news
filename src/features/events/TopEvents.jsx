import { tagClass } from '../../components/tagStyles.js';
import { sentimentText, topEvents, velocityText } from './eventData.js';
import { writeParams } from '../../utils/urlState.js';

/** 到「上游市場 → 事件」（可指定類別篩選）。網址 ?tab=us&section=events&filter=…，上一頁可以回來。 */
export function openEventCenter(filter = 'all') {
  writeParams({ tab: 'us', section: 'events', filter });
  try { window.scrollTo(0, 0); } catch { /* 非瀏覽器環境略過 */ }
}

/** 摘要用的重要事件清單（最多 limit 個）。沒有事件資料時顯示說明，不影響所在頁面。 */
export default function TopEvents({ topics, status, tag, keywords, limit = 3, emptyText = '近 72 小時沒有符合的重要事件' }) {
  const list = topEvents(topics || [], { tag, keywords, limit });
  if (status === 'error' && list.length === 0) return <p className="text-sm text-gray-500 text-center py-4">事件載入失敗</p>;
  if (status === 'loading' && list.length === 0) return <p className="text-sm text-gray-500 text-center py-4">載入中…</p>;
  if (list.length === 0) return <p className="text-sm text-gray-500 text-center py-4">{emptyText}</p>;
  return (
    <ul className="space-y-2" data-testid="top-events">
      {list.map(t => (
        <li key={t.id}>
          <button onClick={() => openEventCenter(tag || 'all')} aria-label={`查看事件：${t.title}`}
            className="list-row w-full text-left rounded-xl border border-gray-700/40 bg-gray-800/40 hover:bg-gray-800 p-2.5 transition">
            <p className="text-sm font-medium text-ink leading-snug line-clamp-2">{t.title}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-gray-500">
              <span>{t.articleCount} 篇｜{t.mediaCount} 家媒體</span>
              <span className={tagClass('gray')}>{sentimentText(t)}</span>
              <span>{velocityText(t)}</span>
              <span className="ml-auto font-bold text-ink tabular-nums" title="重要性">重要性 {t.importance}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
