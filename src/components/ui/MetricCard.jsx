import { trend } from '../../features/ir/irData.js';

// 指標卡（統計卡／KPI 卡共用）。數字格式由呼叫端決定；缺值時顯示「尚無資料」而不是「—」，
// 並可帶 state（loading → 骨架、error → 失敗），讓使用者分得出是哪一種情況。
const TONE = { up: 'text-[color:var(--up)]', down: 'text-[color:var(--down)]', flat: 'text-ui-muted', none: 'text-ui-muted' };
const MARK = { up: '▲', down: '▼', flat: '─', none: '' };
const SR = { up: '上漲', down: '下跌', flat: '持平', none: '' };

/** 漲跌：▲／▼＋正負號＋顏色（台股：紅漲綠跌），並附讀屏文字。 */
export function Delta({ value, text, className = '' }) {
  const t = trend(value);
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${TONE[t]} ${className}`} data-trend={t}>
      {MARK[t] && <span aria-hidden="true">{MARK[t]}</span>}
      {SR[t] && <span className="sr-only">{SR[t]}</span>}{text}
    </span>
  );
}

export default function MetricCard({ label, value, hint, children, state = 'ready', tone = '', onClick, active, className = '' }) {
  const empty = value == null || value === '' || value === '—';
  const body = (
    <>
      <p className="text-xs text-ui-muted truncate">{label}</p>
      {state === 'loading' ? (
        <div role="status" aria-busy="true" aria-label="載入中" className="ui-skeleton h-7 w-20 rounded mt-1" />
      ) : state === 'error' ? (
        <p className="text-sm mt-1 text-[color:var(--danger)]">載入失敗</p>
      ) : (
        <p className={`font-bold tabular-nums break-words ${empty ? 'text-sm font-medium mt-1.5 text-ui-muted' : `text-xl mt-0.5 ${tone || 'text-ui-text'}`}`}>
          {empty ? '尚無資料' : value}
        </p>
      )}
      {state === 'ready' && children && <div className="text-xs mt-1 flex flex-wrap gap-x-2 text-ui-muted">{children}</div>}
      {hint && <p className="text-xs text-ui-muted mt-1">{hint}</p>}
    </>
  );
  const cls = `list-row rounded-lg border border-ui-line bg-ui-soft p-3 min-w-0 text-left ${className}`;
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={active === undefined ? undefined : !!active}
        className={`${cls} ui-focus w-full hover:border-ui-strong ${active ? 'ring-2 ring-brand/40 !bg-brand-soft' : ''}`}>{body}</button>
    : <div className={cls}>{body}</div>;
}
