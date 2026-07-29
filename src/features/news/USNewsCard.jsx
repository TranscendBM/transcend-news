import SentBadge from '../../components/badges/SentBadge.jsx';
import { getSentiment, getUSBrand, US_BRAND_CFG } from '../../utils/news.js';
import { fmtDate } from '../../utils/dates.js';

export default function USNewsCard({ article }) {
  const brand = getUSBrand(article);
  const cfg = US_BRAND_CFG.find(b => b.id === brand);
  const color = cfg?.color || '#6b7280';
  const s = article.sentiment || getSentiment(article.title, article.content);
  const src = article.mediaName || article.sourceName || '';
  const summary = article.summary ? article.summary.trim() : '';
  const bullets = summary
    ? summary.split('•').map(s => s.trim()).filter(Boolean)
    : [];
  return (
    <a href={article.link || '#'} target="_blank" rel="noreferrer"
      className="flex items-start gap-2.5 p-3 rounded-xl bg-gray-800/40 hover:bg-gray-800 border border-gray-700/40 hover:border-gray-600 transition-all group cursor-pointer">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
          <span className="text-xs font-bold px-1.5 py-0.5 rounded-md"
            style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
            {brand}
          </span>
          {bullets.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-md font-medium"
              style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
              🤖 AI摘要
            </span>
          )}
        </div>
        <p className="content-title text-sm line-clamp-2 leading-snug transition-colors">{article.title}</p>
        {bullets.length > 0 && (
          <div className="mt-2 rounded-lg px-2.5 py-2 space-y-0.5"
               style={{ background: '#f8fbff', border: '1px solid #dbeafe' }}>
            {bullets.map((pt, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs leading-relaxed" style={{ color: '#1e40af' }}>
                <span className="shrink-0 mt-0.5" style={{ color: '#3b82f6' }}>•</span>
                <span>{pt}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-500">
          <span style={{ color: '#dc2626' }}>{src}</span>
          <span>·</span>
          <span>{fmtDate(article.pubDate)}</span>
        </div>
      </div>
      <SentBadge s={s} />
    </a>
  );
}
