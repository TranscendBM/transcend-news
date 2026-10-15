// 「新聞稿曝光成效」的展覽名單：標題有「創見」且提到下面任一展覽，就歸成「該展覽、該月」
// 的參展事件（見 features/pr/exposureEvents.js）。同一個展常有好幾種寫法，所以每個展列出
// 所有別名（patterns，正規表示式，不分大小寫）。新增展覽直接在這裡加一筆即可。
//
//   id       事件識別（同一個 id、同一個月 → 同一個事件）
//   label    畫面上顯示的展覽名稱
//   patterns 標題裡出現其中任何一個就算（智慧能源週 的 patterns 用「能源週」，
//            「能源週」「智慧能源週」「2026能源週」都能命中）
export const EXPO_SHOWS = [
  { id: 'computex', label: 'COMPUTEX 台北國際電腦展', patterns: [/computex/i] },
  { id: 'touch-taiwan', label: 'Touch Taiwan／智慧製造展', patterns: [/touch\s*taiwan/i, /智慧製造展/] },
  { id: 'automation', label: '台北國際自動化工業大展', patterns: [/自動化(?:工業)?(?:大)?展/] },
  { id: 'energy-week', label: '智慧能源週', patterns: [/能源週/] },
  { id: 'embedded-world', label: 'Embedded World', patterns: [/embedded\s*world/i] },
  { id: 'semicon', label: 'SEMICON Taiwan', patterns: [/semicon/i] },
  { id: 'ces', label: 'CES', patterns: [/\bCES\b/] },
];
