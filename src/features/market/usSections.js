// 上游市場的第二層導覽（子頁）。id 同時是網址參數 ?section= 的值。
// 事件（話題聚類）原本是獨立頁籤，已整合進這裡；舊網址 ?tab=events 會導向 ?tab=us&section=events。
export const US_SECTIONS = [
  { id: 'overview', label: '總覽', icon: 'layers' },
  { id: 'events', label: '事件', icon: 'radar' },
  { id: 'news', label: '新聞清單', icon: 'news' },
];

export const US_SECTION_IDS = US_SECTIONS.map(s => s.id);
export const DEFAULT_US_SECTION = 'overview';
