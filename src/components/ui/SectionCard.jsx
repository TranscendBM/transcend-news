import Icon from '../Icon.jsx';
import ActionButton from './ActionButton.jsx';

/** 「查看全部」：所有總覽區塊共用同一個入口（文字、樣式、aria-label 一致）。 */
export function ViewAllButton({ onClick, label }) {
  return (
    <ActionButton variant="ghost" onClick={onClick} aria-label={`查看全部：${label}`} className="text-ui-secondary border-ui-line">
      查看全部 <Icon name="chevronright" />
    </ActionButton>
  );
}

/** 全站唯一的區塊卡片：標題列（圖示＋標題＋可選說明／動作／查看全部）＋內容。 */
export default function SectionCard({ title, icon, description, actions, onViewAll, children, className = '', as: Tag = 'section' }) {
  return (
    <Tag data-card className={`ui-card ${className}`} aria-label={title || undefined}>
      {(title || actions || onViewAll) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3">
          {title && (
            <h3 className="text-base font-semibold text-ui-text flex items-center gap-2 min-w-0">
              {icon && <Icon name={icon} className="text-ui-muted" />}{title}
            </h3>
          )}
          <div className="flex items-center gap-2 ml-auto">
            {actions}
            {onViewAll && <ViewAllButton onClick={onViewAll} label={title} />}
          </div>
        </div>
      )}
      {description && <p className="text-xs text-ui-muted -mt-1.5 mb-3">{description}</p>}
      {children}
    </Tag>
  );
}
