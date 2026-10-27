import LoadingSkeleton from '../../components/ui/LoadingSkeleton.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import ErrorState from '../../components/ui/ErrorState.jsx';
import { STATUS_LABEL } from './irData.js';

// 資料新鮮度：全站 IR 統一用這個徽章，文字＋符號，不只靠顏色。
const STYLE = {
  ok: { color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0', mark: '●' },
  loading: { color: '#475569', bg: '#f1f5f9', border: '#e2e8f0', mark: '…' },
  stale: { color: '#b45309', bg: '#fffbeb', border: '#fde68a', mark: '!' },
  error: { color: '#b91c1c', bg: '#fef2f2', border: '#fecaca', mark: '✕' },
  empty: { color: '#475569', bg: '#f1f5f9', border: '#e2e8f0', mark: '—' },
};

export function DataStatusBadge({ status, label, updated }) {
  const st = STYLE[status] || STYLE.empty;
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border whitespace-nowrap"
      data-status={status} style={{ color: st.color, background: st.bg, borderColor: st.border }}>
      <span aria-hidden="true">{st.mark}</span>
      {label ? `${label}：` : ''}{STATUS_LABEL[status] || status}
      {updated ? <span className="opacity-80">· {updated}</span> : null}
    </span>
  );
}

/** 沒有資料時的狀態：載入中＝骨架；載入失敗＝紅色錯誤＋下一步；尚無資料＝說明（不會出現 0、NaN、undefined）。 */
export function EmptyFinancialState({ status = 'empty', emptyText = '尚無資料', height = 'h-24' }) {
  if (status === 'loading') return <LoadingSkeleton lines={3} label="資料更新中" className={`${height} py-2`} />;
  if (status === 'error') return <ErrorState message="載入失敗，請按右上角「重新整理」再試一次" />;
  return <EmptyState title={emptyText} className="py-5" />;
}
