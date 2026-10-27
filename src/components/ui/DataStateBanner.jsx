import Icon from '../Icon.jsx';
import ActionButton from './ActionButton.jsx';

// 全站統一的資料狀態橫幅。ready 不顯示（正常時不打擾）。
//   stale：黃色，保留最後資料並標示時間；error：紅色，可重試；
//   cache：藍色，正在使用快取／離線資料（不假裝是最新）；loading：中性。
const STATES = {
  loading: { icon: 'clock', cls: 'bg-[color:var(--neutral-bg)] border-[color:var(--neutral-line)] text-[color:var(--neutral)]', role: 'status', title: '載入中' },
  stale: { icon: 'alert', cls: 'bg-[color:var(--warn-bg)] border-[color:var(--warn-line)] text-[color:var(--warn)]', role: 'status', title: '資料過期' },
  error: { icon: 'alert', cls: 'bg-[color:var(--danger-bg)] border-[color:var(--danger-line)] text-[color:var(--danger)]', role: 'alert', title: '載入失敗' },
  cache: { icon: 'history', cls: 'bg-[color:var(--info-bg)] border-[color:var(--info-line)] text-[color:var(--info)]', role: 'status', title: '使用快取資料' },
};

export default function DataStateBanner({ state, title, children, onRetry, action, compact = false, className = '' }) {
  const s = STATES[state];
  if (!s) return null;
  return (
    <div role={s.role} aria-live={state === 'error' ? 'assertive' : 'polite'} data-state={state}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 ${compact ? 'py-1.5' : 'py-2.5'} text-sm ${s.cls} ${className}`}>
      <Icon name={s.icon} />
      <span className="font-medium">{title || s.title}</span>
      {children && <span className="min-w-0 text-xs opacity-90">{children}</span>}
      <span className="ml-auto flex items-center gap-2">
        {action}
        {onRetry && <ActionButton onClick={onRetry} className="min-h-9 md:min-h-8 py-0">重試</ActionButton>}
      </span>
    </div>
  );
}
