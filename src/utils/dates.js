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

// ─────────────────────────────────────────────────────────────
// 台灣時間（Asia/Taipei，固定 UTC+8、無日光節約）的「今天/本週/本月」
// 起點計算，回傳的是實際時刻（Date，內部時間戳正確，可直接跟 pubDate
// 比較），不是「看起來是台灣時間的假本地時間」。
//
// 用固定 +8 小時位移換算，而不是瀏覽器本地時區或 Intl：這個網站的
// 使用者、伺服器（Cloud Functions）都在台灣，但瀏覽器的「本地時區」
// 不可控（例如筆電系統時區設成別的地方），若用 new Date().getDate()
// 這類本地時區讀法，換了時區看到的「今天/本週/本月」會跟着變、
// 跟後端 functions/news_cleanup.py 用 Asia/Taipei 日曆月份算出的
// 保留範圍對不上。台灣沒有 DST，固定位移在任何時候都精確。
// ─────────────────────────────────────────────────────────────
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiPartsOf(date) {
  const shifted = new Date(date.getTime() + TAIPEI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    day: shifted.getUTCDay(), // 0=週日 .. 6=週六
  };
}

function taipeiInstant(year, month, date) {
  // Date.UTC 對超出範圍的 date（例如 0 或負數）會自動正確地跨月/跨年
  // 往前借位，不需要自己手算月份天數。
  return new Date(Date.UTC(year, month, date) - TAIPEI_OFFSET_MS);
}

/** 台灣時間「今天」00:00 對應的實際時刻。 */
export function taipeiDayStart(now = new Date()) {
  const { year, month, date } = taipeiPartsOf(now);
  return taipeiInstant(year, month, date);
}

/** 台灣時間「本週一」00:00 對應的實際時刻（週一為一週起點，不是最近 7 天）。 */
export function taipeiWeekStart(now = new Date()) {
  const { year, month, date, day } = taipeiPartsOf(now);
  const diffToMonday = (day + 6) % 7; // 週日(0)->6, 週一(1)->0, ..., 週六(6)->5
  return taipeiInstant(year, month, date - diffToMonday);
}

/** 台灣時間「本月 1 日」00:00 對應的實際時刻。 */
export function taipeiMonthStart(now = new Date()) {
  const { year, month } = taipeiPartsOf(now);
  return taipeiInstant(year, month, 1);
}

export function sortByDate(arr) {
  return [...arr].sort((a, b) => {
    const da = a.pubDate?.toDate ? a.pubDate.toDate() : new Date(a.pubDate || 0);
    const db = b.pubDate?.toDate ? b.pubDate.toDate() : new Date(b.pubDate || 0);
    return db - da;
  });
}
