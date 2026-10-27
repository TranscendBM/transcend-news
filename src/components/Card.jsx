import SectionCard from './ui/SectionCard.jsx';

// 舊名稱 Card：全站區塊卡片已統一為 ui/SectionCard（同一套 token、標題列與間距）。
export default function Card({ title, icon, children, className = '', actions }) {
  return <SectionCard title={title} icon={icon} actions={actions} className={className} as="div">{children}</SectionCard>;
}
