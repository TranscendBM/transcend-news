// 載入中的骨架：取代一整片「—」與「資料更新中」。aria-busy 讓讀屏知道仍在載入，
// 動畫在 prefers-reduced-motion 下由 base.css 關閉。
export default function LoadingSkeleton({ lines = 3, className = '', label = '載入中' }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" aria-label={label} className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="ui-skeleton h-4 rounded" style={{ width: `${100 - (i % 3) * 18}%` }} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** 指標卡形狀的骨架。 */
export function MetricSkeleton({ count = 4 }) {
  return (
    <div role="status" aria-busy="true" aria-label="載入中" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-ui-line bg-ui-soft p-3 space-y-2">
          <div className="ui-skeleton h-3 w-16 rounded" />
          <div className="ui-skeleton h-6 w-24 rounded" />
        </div>
      ))}
    </div>
  );
}
