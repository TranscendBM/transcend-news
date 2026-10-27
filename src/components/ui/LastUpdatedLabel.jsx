// 「更新時間」標示：固定一種寫法，stale 時加上「（資料過期）」。
const fmt = d => d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function LastUpdatedLabel({ date, label = '更新', stale = false, className = '' }) {
  if (!date) return <span className={`text-xs text-ui-muted ${className}`}>尚未更新</span>;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return <span className={`text-xs text-ui-muted ${className}`}>更新時間未知</span>;
  return (
    <span className={`text-xs tabular-nums ${stale ? 'text-[color:var(--warn)]' : 'text-ui-muted'} ${className}`}>
      {label} <time dateTime={d.toISOString()}>{fmt(d)}</time>{stale ? '（資料過期）' : ''}
    </span>
  );
}
