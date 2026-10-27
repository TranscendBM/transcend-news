import SectionCard, { ViewAllButton } from './ui/SectionCard.jsx';

// 舊匯入路徑保留：ViewAllButton 與 SummaryCard 都改由 ui/SectionCard 提供，全站「查看全部」只有一種。
export { ViewAllButton };

/** 總覽的摘要卡（PR、IR 共用）：h-full 讓同一列的卡片等高。內容筆數由呼叫端限制（最多 3～5 筆）。 */
export default function SummaryCard({ title, icon, onViewAll, children, className = '' }) {
  return <SectionCard title={title} icon={icon} onViewAll={onViewAll} className={`h-full ${className}`}>{children}</SectionCard>;
}
