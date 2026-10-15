// PR 媒體戰情的第二層導覽（子頁）。id 同時是網址參數 ?section= 的值。
export const PR_SECTIONS = [
  { id: 'overview', label: '總覽', icon: 'layers' },
  { id: 'news', label: '新聞監測', icon: 'news' },
  { id: 'competitors', label: '競品動態', icon: 'target' },
  { id: 'exposure', label: '曝光成效', icon: 'chart' },
];

export const PR_SECTION_IDS = PR_SECTIONS.map(s => s.id);
export const DEFAULT_PR_SECTION = 'overview';

export const prTabId = id => `pr-tab-${id}`;
export const prPanelId = id => `pr-panel-${id}`;
