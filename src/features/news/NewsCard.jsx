import SentBadge from '../../components/badges/SentBadge.jsx';
import { getSentiment } from '../../utils/news.js';
import { fmtDate } from '../../utils/dates.js';

export default function NewsCard({ article }) {
  const s = article.sentiment || getSentiment(article.title, article.content);
  const media = article.mediaName || article.sourceName || '媒體';
  return (
    <a href={article.link || '#'} target="_blank" rel="noreferrer"
      className="flex items-start gap-2.5 p-3 rounded-xl bg-gray-800/40 hover:bg-gray-800 border border-gray-700/40 hover:border-gray-600 transition-all group cursor-pointer">
      <div className="flex-1 min-w-0">
        <p className="content-title text-sm line-clamp-2 leading-snug transition-colors">{article.title}</p>
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-500">
          <span className="font-medium" style={{ color: '#dc2626' }}>{media}</span>
          <span>·</span>
          <span>{fmtDate(article.pubDate)}</span>
        </div>
      </div>
      <SentBadge s={s} />
    </a>
  );
}
