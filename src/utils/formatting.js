import { getSentiment, SENT_CFG } from './news.js';

// xlsx 只在真的要匯出時才動態載入——它是目前 bundle 裡最大的相依套件
// 之一，大多數使用者從頭到尾不會按「匯出 Excel」，沒必要讓每個人的
// 第一次載入都背這個成本。
export async function exportNewsExcel(articles, sheetName, filenamePrefix) {
  if (!articles || articles.length === 0) return;
  const XLSX = await import('xlsx');
  const rows = articles.map(n => {
    const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
    return {
      標題: n.title || '',
      媒體: n.mediaName || n.sourceName || '',
      日期: isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW'),
      情緒: SENT_CFG[n.sentiment || getSentiment(n.title, n.content)]?.label || '',
      連結: n.link || '',
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = [{ wch: 50 }, { wch: 16 }, { wch: 18 }, { wch: 8 }, { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `${filenamePrefix}_${stamp}.xlsx`);
}
