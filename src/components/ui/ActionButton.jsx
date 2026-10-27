import Icon from '../Icon.jsx';

// 全站按鈕：同一組高度（手機 44px、桌機 36px）、同一組 focus 樣式。
// primary＝主操作（創見紅，一個區塊最多一個）；secondary＝一般操作；ghost＝輔助／文字按鈕。
const VARIANT = {
  primary: 'bg-brand text-white border border-brand hover:bg-brand-strong',
  secondary: 'bg-ui-surface text-ui-secondary border border-ui-strong hover:bg-ui-soft',
  ghost: 'bg-transparent text-ui-secondary border border-transparent hover:bg-ui-soft',
};

export default function ActionButton({ variant = 'secondary', icon, children, className = '', type = 'button', ...rest }) {
  return (
    <button type={type} {...rest}
      className={`ui-focus inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 min-h-11 md:min-h-9 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT[variant] || VARIANT.secondary} ${className}`}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** 只有圖示的按鈕：一定要有 label（成為 aria-label 與 title）。點擊區至少 44×44。 */
export function IconButton({ icon, label, variant = 'ghost', className = '', type = 'button', ...rest }) {
  return (
    <button type={type} aria-label={label} title={label} {...rest}
      className={`ui-focus inline-flex items-center justify-center rounded-lg min-h-11 min-w-11 md:min-h-9 md:min-w-9 text-ui-secondary hover:bg-ui-soft disabled:opacity-50 ${variant === 'secondary' ? 'border border-ui-strong bg-ui-surface' : ''} ${className}`}>
      <Icon name={icon} className="text-[1.25em]" />
    </button>
  );
}
