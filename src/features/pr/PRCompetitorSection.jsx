import { CompetitorNews } from './CompetitorNews.jsx';

// ═══════════════════════════════════════════════════════════
// PR 競品動態：競品動態監測（品牌＋期間篩選＋完整清單）。
// 篩選狀態與「新聞監測」的搜尋工具列各自獨立，這個子頁沒有搜尋工具列，避免被誤會成
// 同一個篩選器同時控制兩種資料。
// ═══════════════════════════════════════════════════════════
export function PRCompetitorSection({ news }) {
  return <CompetitorNews news={news} />;
}
