import * as XLSX from 'xlsx';
import { getSentiment, SENT_CFG } from './news.js';

export function exportNewsExcel(articles, sheetName, filenamePrefix) {
  if (!articles || articles.length === 0) return;
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
