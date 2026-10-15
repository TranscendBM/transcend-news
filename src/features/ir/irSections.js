// IR 投資情報的第二層導覽（子頁）。id 同時是網址參數 ?section= 的值。
export const IR_SECTIONS = [
  { id: 'overview', label: '總覽', icon: 'layers' },
  { id: 'market', label: '股價與競品', icon: 'trend' },
  { id: 'financials', label: '財務營運', icon: 'coins' },
  { id: 'disclosures', label: '重大訊息與股利', icon: 'bell' },
];

export const IR_SECTION_IDS = IR_SECTIONS.map(s => s.id);
export const DEFAULT_IR_SECTION = 'overview';
