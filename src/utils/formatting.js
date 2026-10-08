import { getSentiment, SENT_CFG } from './news.js';

// xlsx 只在真的要匯出時才動態載入——它是目前 bundle 裡最大的相依套件
// 之一，大多數使用者從頭到尾不會按「匯出 Excel」，沒必要讓每個人的
// 第一次載入都背這個成本。
// extraColumns：選用，{ 欄名: article => 值 }，插在「情緒」與「連結」之間
// （例如上游市場要多一欄品牌）。
export async function exportNewsExcel(articles, sheetName, filenamePrefix, extraColumns = {}) {
  if (!articles || articles.length === 0) return;
  const XLSX = await import('xlsx');
  const extra = Object.entries(extraColumns);
  const rows = articles.map(n => {
    const d = n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0);
    return {
      標題: n.title || '',
      媒體: n.mediaName || n.sourceName || '',
      日期: isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW'),
      情緒: SENT_CFG[n.sentiment || getSentiment(n.title, n.content)]?.label || '',
      ...Object.fromEntries(extra.map(([col, fn]) => [col, fn(n) ?? ''])),
      連結: n.link || '',
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = [{ wch: 50 }, { wch: 16 }, { wch: 18 }, { wch: 8 }, ...extra.map(() => ({ wch: 14 })), { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `${filenamePrefix}_${stamp}.xlsx`);
}

export async function exportMediaExposureExcel(records) {
  if (!records || records.length === 0) return;
  const XLSX = await import('xlsx');
  const rows = records.map(record => {
    const date = record.exposureDate?.toDate
      ? record.exposureDate.toDate()
      : new Date(record.exposureDate || 0);
    return {
      日期: isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
      媒體: record.mediaName || '',
      記者: record.reporter || '',
      新聞標題: record.title || '',
      曝光類型: record.exposureType || '',
      連結: record.link || '',
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 54 }, { wch: 12 }, { wch: 64 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '人工確認曝光');
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `人工確認曝光_${stamp}.xlsx`);
}

// 人工確認曝光分析 → Excel：月趨勢／媒體×月／記者×月／題材×月，各一張工作表。
export async function exportExposureInsightsExcel(ins) {
  if (!ins || ins.empty) return;
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const add = (name, rows, widths) => {
    const sheet = XLSX.utils.json_to_sheet(rows);
    if (widths) sheet['!cols'] = widths.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, sheet, name);
  };
  const perMonth = byMonth => Object.fromEntries(ins.months.map(m => [m, byMonth[m] || 0]));
  add('月趨勢', ins.monthly.map(m => ({
    月份: m.month, 曝光篇數: m.count, 媒體數: m.mediaCount, 具名記者數: m.reporterCount, 未署名篇數: m.unsignedCount,
  })));
  add('媒體×月', ins.media.map(m => ({
    媒體: m.name, 類型: m.category, ...perMonth(m.byMonth), 合計: m.total, 佔比: +(m.share * 100).toFixed(1) + '%',
    記者數: m.reporterCount, 主力記者: m.topReporter || '', 最近報導: m.lastDate.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
  })), [18, 10]);
  add('記者×月', ins.reporters.map(r => ({
    記者: r.name, 媒體: r.media.map(x => x.name + '(' + x.count + ')').join('、'), ...perMonth(r.byMonth), 合計: r.total,
    最近報導: r.lastDate.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
  })), [12, 28]);
  add('題材×月', ins.topics.map(t => ({
    題材: t.label, ...perMonth(t.byMonth), 合計: t.total, 佔比: +(t.share * 100).toFixed(1) + '%',
  })), [16]);
  const today = new Date();
  const stamp = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
  XLSX.writeFile(wb, '人工確認曝光分析_' + stamp + '.xlsx');
}
