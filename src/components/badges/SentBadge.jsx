import { SENT_CFG } from '../../utils/news.js';

export default function SentBadge({ s }) {
  const c = SENT_CFG[s] || SENT_CFG.neutral;
  return <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${c.cls}`}>{c.label}</span>;
}
