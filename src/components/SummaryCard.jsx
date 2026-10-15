import Card from './Card.jsx';
import Icon from './Icon.jsx';

/** 摘要卡右上角的「查看全部」：點了切換到對應子頁。aria-label 帶上卡片名稱，讀屏時分得出是哪一張。 */
export function ViewAllButton({ onClick, label }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="text-sm px-3 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition shrink-0 whitespace-nowrap">
      查看全部 <Icon name="chevronright" />
    </button>
  );
}

/**
 * 總覽的摘要卡（PR、IR 共用）：標題＋「查看全部」＋內容。內容由呼叫端自己限制筆數，
 * 這裡用 h-full 讓同一列的卡片等高，避免高度落差太大。
 */
export default function SummaryCard({ title, icon, onViewAll, children, className = '' }) {
  return (
    <Card title={title} icon={icon} className={`h-full ${className}`}
      actions={onViewAll ? <ViewAllButton onClick={onViewAll} label={`查看全部：${title}`} /> : undefined}>
      {children}
    </Card>
  );
}
