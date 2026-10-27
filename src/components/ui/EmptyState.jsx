import Icon from '../Icon.jsx';

/** 沒有資料：說明「為什麼沒有」與下一步，不顯示空白或「—」。 */
export default function EmptyState({ title = '目前沒有資料', hint, action, icon = 'inbox', className = '' }) {
  return (
    <div role="status" className={`flex flex-col items-center gap-1.5 py-8 px-4 text-center ${className}`}>
      <Icon name={icon} className="text-[1.6em] text-ui-muted" />
      <p className="text-sm font-medium text-ui-secondary">{title}</p>
      {hint && <p className="text-xs text-ui-muted max-w-md">{hint}</p>}
      {action}
    </div>
  );
}
