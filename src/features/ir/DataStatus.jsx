import Icon from '../../components/Icon.jsx';
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

/** 沒有資料時的空狀態：更新中／載入失敗／尚無資料（不會出現 0、NaN、undefined）。 */
export function EmptyFinancialState({ status = 'empty', emptyText = '尚無資料', height = 'h-24' }) {
  const text = status === 'loading' ? '資料更新中…' : status === 'error' ? '載入失敗，請按右上角「重新整理」再試一次' : emptyText;
  return (
    <div role={status === 'error' ? 'alert' : 'status'} className={`${height} flex items-center justify-center gap-2 text-sm text-gray-500 text-center`}>
      {status === 'error' && <Icon name="alert" />}
      {text}
    </div>
  );
}
