// newsUrl：該公司官網的最新消息頁（競品動態表格的外部連結；宜鼎繁中站沒有新聞頁，連到英文站）
// 創見與競品的共用設定：跨 PR/IR 分頁與 App 本身（頁首股價 ticker）
// 共用，避免同一份資料在多個檔案各自宣告一份、日後改一邊漏改另一邊。
export const COMPETITORS = [
  { id: 'ADATA', name: 'ADATA 威剛', stock: '3260', color: '#ef4444', newsUrl: 'https://www.adata.com/tw/news/' },
  { id: 'Innodisk', name: 'Innodisk 宜鼎', stock: '5289', color: '#eab308', newsUrl: 'https://www.innodisk.com/en/news' },
  { id: 'Teamgroup', name: 'Teamgroup 十銓', stock: '4967', color: '#f97316', newsUrl: 'https://www.teamgroupinc.com/tw/news/' },
  { id: 'Apacer', name: 'Apacer 宇瞻', stock: '8271', color: '#22c55e', newsUrl: 'https://www.apacer.com/zh-tw/news/news-and-events' },
  { id: 'Silicon Power', name: 'Silicon Power 廣穎', stock: '4973', color: '#3b82f6', newsUrl: 'https://www.silicon-power.com/tw/news/' },
];

// 統一的競品顯示順序（威剛／宜鼎／十銓／宇瞻／廣穎）。
// 股票代號當 object key 時，JS 會自動依數字大小排序、無視物件字面量的
// 撰寫順序，所以凡是要照這個順序顯示的地方都要用這個陣列驅動，
// 不能直接 Object.keys()/Object.entries() 一個以代號為 key 的物件。
export const COMPETITOR_ORDER = ['3260', '5289', '4967', '8271', '4973'];

export const STOCK_META = {
  '2451': { name: '創見' },
  '3260': { name: '威剛' },
  '5289': { name: '宜鼎' },
  '4967': { name: '十銓科技' },
  '8271': { name: '宇瞻' },
  '4973': { name: '廣穎' },
};
