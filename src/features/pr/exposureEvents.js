// 事件規則：把「同一件事、各媒體各寫各的標題」的報導認成同一個事件。
//
// 為什麼需要：創見每個月初公布月營收、每季公布財報，各家媒體會在同一兩天內用完全
// 不同的標題報導（「9月營收年增290%」「前七月營收超越全年」「Q3營收160.7億」…），
// 只比對標題文字永遠對不上，但它們其實是同一則新聞稿。
//
// 做法（可解釋、不靠 AI）：
//   1. 從標題抽出「期間」——月份（9月、前七月、1—9月、4、5月）、季（Q3、第2季、首季、前3季）、
//      半年（上半年、H1）——再用發布日推定年份，且期間必須「已經結束、且在發布日前 75 天內」。
//   2. 標題講營收 → 「月營收公告」；講 EPS／獲利／財報 → 「季度財報／獲利」。
//      同一個期間的所有報導合成同一個事件（key 相同）。
//   3. 標題有「創見」且提到展覽名單（config/exposureShows.js）裡的展 → 「該展覽、該月」的參展事件；
//      同一個展的別名（智慧製造展＝Touch Taiwan）、預告與開展期間的報導都合成同一個事件。
//   4. 沒有明確期間時，只有在「標題有創見＋營收＋月／季字眼、且發布日在每月 12 日前
//      （營收公布期）」才推定為上個月營收；否則不歸類（寧可不合併）。
// 規則是推定，畫面上會標示「依事件規則」，可展開查看每一則；之後有人工 campaignId 就優先用它。

import { EXPO_SHOWS } from '../../config/exposureShows.js';

const NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const toInt = s => (/^\d+$/.test(s) ? Number(s) : NUM[s] ?? null);
const DAY_MS = 86400000;

/** 期間結束後多少天內的報導，才算是那一期的公告報導。 */
export const MAX_DELAY_DAYS = 75;
/** 沒有明確期間時，只在每月這一天以前才推定為「上個月營收」。 */
export const REVENUE_ANNOUNCE_BY_DAY = 12;

export const EVENT_KIND_LABELS = { revenue: '月營收公告', earnings: '季度財報／獲利', expo: '展覽參展' };

const dayNum = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };

/**
 * 期間（結束於某月）→ 發布日推定出的 { y, m }。
 * 年份用發布日推定：取「最近一個已結束」的該月；必須已結束（發布日晚於期末）且在 75 天內。
 */
function resolvePeriod(endMonth, day) {
  const eventDay = dayNum(day);
  const eventYear = Number(day.slice(0, 4));
  for (const y of [eventYear, eventYear - 1]) {
    const delay = (eventDay - Date.UTC(y, endMonth, 0)) / DAY_MS;   // Date.UTC(y, m, 0)＝該月最後一天
    if (delay >= 1 && delay <= MAX_DELAY_DAYS) return { y, m: endMonth };
  }
  return null;
}

const latest = periods => periods.sort((a, b) => b.y * 100 + b.m - (a.y * 100 + a.m))[0];

// ── 期間抽取 ──────────────────────────────────────────────
const MONTH_TOKEN = /(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?!底|初|起|中旬|上旬|下旬|日|份起)/g;   // 9月、七月
const MONTH_RANGE = /(\d{1,2})\s*[~\-–—至到、,，]\s*(\d{1,2})\s*月/g;                              // 1—9月、4、5月、4~5月
const MONTH_FRONT = /前\s*(\d{1,2}|[一二三四五六七八九十]{1,2})\s*(?:個)?月/g;                      // 前9月、前七月、前9個月

function monthEnds(text) {
  const out = new Set();
  for (const m of text.matchAll(MONTH_RANGE)) out.add(Number(m[2]));
  for (const m of text.matchAll(MONTH_FRONT)) { const n = toInt(m[1]); if (n) out.add(n); }
  for (const m of text.matchAll(MONTH_TOKEN)) { const n = toInt(m[1]); if (n) out.add(n); }
  return [...out].filter(n => n >= 1 && n <= 12);
}

function quarterEnds(text) {
  const out = new Set();
  const q = n => { if (n >= 1 && n <= 4) out.add(n * 3); };
  for (const m of text.matchAll(/Q\s*([1-4])/gi)) q(Number(m[1]));                  // Q3
  for (const m of text.matchAll(/(?<![0-9])([1-4])\s*Q/gi)) q(Number(m[1]));         // 2Q26
  for (const m of text.matchAll(/[第前]\s*([1-4一二三四])\s*季/g)) q(toInt(m[1]));      // 第2季、前3季
  if (/首季|一季/.test(text)) q(1);
  if (/二季/.test(text)) q(2);
  if (/三季/.test(text)) q(3);
  if (/四季/.test(text)) q(4);
  if (/上半年|半年|H1/i.test(text)) out.add(6);
  if (/下半年|H2/i.test(text)) out.add(12);
  return [...out];
}

const EARNINGS_WORDS = /(EPS|每股|獲利|稅後|綜合損益|財報|盈餘|純益|賺)/i;
// 標題明確寫「N月營收」「月營收」→ 是營收公告，就算同時有「獲利」字眼
const EXPLICIT_MONTH_REVENUE = /\d{1,2}\s*月(?:份)?\s*(?:合併|自結)?\s*營收|月營收/;

/**
 * 標題＋發布日（台灣日曆日 YYYY-MM-DD）→ 事件，認不出來回傳 null。
 * 回傳 { kind, key, label, inferred? }；key 相同＝同一個事件。
 */
export function detectEvent(title, day) {
  if (!title || !day) return null;
  const text = String(title).normalize('NFKC');
  const hasRevenue = /營收/.test(text);

  // 季度財報／獲利：講 EPS／獲利／財報、且不是明確的「N月營收」標題
  if (EARNINGS_WORDS.test(text) && !EXPLICIT_MONTH_REVENUE.test(text)) {
    const periods = quarterEnds(text).map(m => resolvePeriod(m, day)).filter(Boolean);
    if (periods.length) {
      const p = latest(periods);
      return { kind: 'earnings', key: `earnings:${p.y}-${p.m}`, label: `${p.y}年第${p.m / 3}季財報／獲利` };
    }
  }

  if (hasRevenue) {
    const periods = [...monthEnds(text), ...quarterEnds(text)].map(m => resolvePeriod(m, day)).filter(Boolean);
    if (periods.length) {
      const p = latest(periods);
      return { kind: 'revenue', key: `revenue:${p.y}-${p.m}`, label: `${p.y}年${p.m}月營收公告` };
    }
    // 沒有可用的期間：保守推定（見檔頭說明）
    const dayOfMonth = Number(day.slice(8, 10));
    if (/創見/.test(text) && /[月季]|累計|單月|年增|月增|近兩|前兩/.test(text) && dayOfMonth <= REVENUE_ANNOUNCE_BY_DAY) {
      const [y, m] = day.split('-').map(Number);
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { kind: 'revenue', key: `revenue:${py}-${pm}`, label: `${py}年${pm}月營收公告`, inferred: true };
    }
  }

  // 展覽參展：營收／財報規則都沒命中時才套用（營收標題裡順帶提到「將參展…」仍歸營收公告）
  if (/創見/.test(text)) {
    const show = EXPO_SHOWS.find(s => s.patterns.some(p => p.test(text)));
    if (show) {
      const [y, m] = day.split('-').map(Number);
      return { kind: 'expo', key: `expo:${show.id}:${y}-${m}`, label: `${y}年${m}月 ${show.label} 參展` };
    }
  }
  return null;
}
