/**
 * 股價過期判斷（與 functions/fetch_news.py 的 is_stock_stale 邏輯一致）
 * 交易時段（週一~五 09:00–13:35 台灣時間）中超過 30 分鐘未更新即視為過期；
 * 非交易時段顯示的是最近收盤價，不視為過期。
 */
export function twNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

export function isTwMarketOpen(tw = twNow()) {
  const day = tw.getDay();
  if (day === 0 || day === 6) return false;
  const mins = tw.getHours() * 60 + tw.getMinutes();
  return mins >= 9 * 60 && mins <= 13 * 60 + 35;
}

export function stockUpdatedAtMs(data) {
  const u = data && data.updatedAt;
  if (!u) return null;
  if (typeof u.toDate === 'function') return u.toDate().getTime(); // Firestore Timestamp
  if (typeof u.seconds === 'number') return u.seconds * 1000;
  return null;
}

export function isStockStale(data, staleMinutes = 30) {
  const t = stockUpdatedAtMs(data);
  if (!t) return true; // 沒有 updatedAt 一律視為過期
  if (!isTwMarketOpen()) return false;
  return Date.now() - t > staleMinutes * 60 * 1000;
}

export function fmtStockUpdated(data) {
  const t = stockUpdatedAtMs(data);
  if (!t) return '更新時間不明';
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return sameDay ? `更新 ${hm}` : `更新 ${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return '';
  }
}

export function sortByDate(arr) {
  return [...arr].sort((a, b) => {
    const da = a.pubDate?.toDate ? a.pubDate.toDate() : new Date(a.pubDate || 0);
    const db = b.pubDate?.toDate ? b.pubDate.toDate() : new Date(b.pubDate || 0);
    return db - da;
  });
}
