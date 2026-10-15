import { trend } from './irData.js';

// 摘要用的小指標：標籤、大數字、輔助說明。漲跌用 ▲／▼＋正負號＋顏色（台股：紅漲綠跌），不只靠顏色。
const TONE = { up: 'text-red-400', down: 'text-green-400', flat: 'text-gray-400', none: 'text-gray-500' };
const MARK = { up: '▲', down: '▼', flat: '─', none: '' };

export function Delta({ value, text }) {
  const t = trend(value);
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${TONE[t]}`} data-trend={t}>
      {MARK[t] && <span aria-hidden="true">{MARK[t]}</span>}{text}
    </span>
  );
}

export default function FinancialMetricCard({ label, value, hint, children, className = '' }) {
  const empty = value === '—' || value == null;
  return (
    <div className={`rounded-xl border border-gray-700/40 bg-gray-800/40 p-3 min-w-0 ${className}`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-bold tabular-nums mt-0.5 break-words ${empty ? 'text-gray-500' : 'text-ink'}`}>{empty ? '—' : value}</p>
      {children && <div className="text-xs mt-1 flex flex-wrap gap-x-2 text-gray-500">{children}</div>}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
