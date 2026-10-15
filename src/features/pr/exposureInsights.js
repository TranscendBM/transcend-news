/* global URL */
import { EXPOSURE_TOPICS, mediaCategoryOf } from '../../config/exposureTopics.js';
import { taipeiPrevMonthStart } from '../../utils/dates.js';

// 人工確認曝光的分析計算（純函式，不碰畫面與 Firestore）。
// 所有「月」「日」都用 Asia/Taipei 日曆（固定 UTC+8），跟網站其他地方一致。

const TAIPEI_MS = 8 * 60 * 60 * 1000;

const toDate = v => (v?.toDate ? v.toDate() : new Date(v || 0));
export const monthKeyOf = d => new Date(d.getTime() + TAIPEI_MS).toISOString().slice(0, 7);
export const dayKeyOf = d => new Date(d.getTime() + TAIPEI_MS).toISOString().slice(0, 10);

function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** 「A、B」「A/B」這種多位記者共同署名拆開，各算一篇；空白代表未署名。 */
export function splitReporters(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return [...new Set(text.split(/[、,，/＆&]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }
const sortDesc = (a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name), 'zh-Hant');

function topicsOf(title, topics) {
  const text = String(title || '');
  const hit = topics.filter(t => t.keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))).map(t => t.id);
  return hit.length ? hit : ['other'];
}

// ── 自動監測比對用的網址／標題正規化 ─────────────────────────
export function urlKey(link) {
  try {
    const u = new URL(/^https?:\/\//i.test(link) ? link : 'https://' + link);
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !/^utm_/i.test(k) && !['fbclid', 'gclid', 'ref', 'source'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}=${v}`).sort().join('&');
    return u.hostname.replace(/^www\./i, '').toLowerCase() + u.pathname.replace(/\/+$/, '') + (params ? '?' + params : '');
  } catch { return ''; }
}
export const titleKey = title => String(title || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 10 && l.includes(s);
}

/**
 * 人工確認曝光 vs 自動新聞監測：同一段期間內，人工確認的曝光有多少也被自動監測
 * 抓到（網址相同或標題相同）。沒被抓到的就是自動監測的漏網之魚。
 * 自動監測只保留「本月＋上個月」，所以只比對這個範圍內的人工紀錄。
 */
function compareWithAuto(items, autoArticles, now) {
  const windowStart = taipeiPrevMonthStart(now);
  const manual = items.filter(i => i.date >= windowStart);
  const autoUrls = new Set();
  const autoTitles = [];
  autoArticles.forEach(a => {
    const k = urlKey(a.link || ''); if (k) autoUrls.add(k);
    const t = titleKey(a.title); if (t) autoTitles.push(t);
  });
  const missed = [];
  let matched = 0;
  manual.forEach(i => {
    const hit = (i.link && autoUrls.has(urlKey(i.link)))
      || autoTitles.some(t => sameTitle(t, titleKey(i.title)));
    if (hit) matched += 1;
    else missed.push({ title: i.title, media: i.media, reporter: i.reporterRaw, date: i.date, link: i.link });
  });
  missed.sort((a, b) => b.date - a.date);
  return {
    windowStart, autoCount: autoArticles.length, manual: manual.length, matched,
    rate: manual.length ? matched / manual.length : null,
    missed,
  };
}

export function buildExposureInsights(records, {
  autoArticles = null, now = new Date(), topics = EXPOSURE_TOPICS,
} = {}) {
  const items = [];
  (records || []).forEach(r => {
    const date = toDate(r.exposureDate);
    if (isNaN(date.getTime())) return;
    items.push({
      date, month: monthKeyOf(date), day: dayKeyOf(date),
      media: r.mediaName || '未知媒體',
      reporterRaw: String(r.reporter || '').trim(),
      reporters: splitReporters(r.reporter),
      title: r.title || '', link: r.link || '', type: r.exposureType || 'online',
      topicIds: topicsOf(r.title, topics),
    });
  });
  if (!items.length) return { empty: true, total: 0, months: [], highlights: [] };

  items.sort((a, b) => a.date - b.date);
  const months = monthsBetween(items[0].month, items[items.length - 1].month);
  const latestMonth = months[months.length - 1];
  const prevMonth = months.length > 1 ? months[months.length - 2] : null;
  const total = items.length;

  // ── 月趨勢 ──
  const monthly = months.map(month => {
    const inMonth = items.filter(i => i.month === month);
    const names = new Set(inMonth.flatMap(i => i.reporters));
    return {
      month, count: inMonth.length,
      mediaCount: new Set(inMonth.map(i => i.media)).size,
      reporterCount: names.size,
      unsignedCount: inMonth.filter(i => !i.reporters.length).length,
    };
  });

  // ── 媒體 ──
  const mediaMap = {};
  items.forEach(i => {
    const m = mediaMap[i.media] || (mediaMap[i.media] = {
      name: i.media, total: 0, byMonth: {}, reporterCounts: {}, firstDate: i.date, lastDate: i.date,
    });
    m.total += 1; bump(m.byMonth, i.month); m.lastDate = i.date;
    i.reporters.forEach(r => bump(m.reporterCounts, r));
  });
  const media = Object.values(mediaMap).map(m => {
    const reps = Object.entries(m.reporterCounts).sort((a, b) => b[1] - a[1]);
    return {
      name: m.name, total: m.total, share: m.total / total, byMonth: m.byMonth,
      category: mediaCategoryOf(m.name),
      reporterCount: reps.length,
      topReporter: reps[0]?.[0] || null,
      topReporterShare: reps[0] ? reps[0][1] / m.total : 0,
      firstDate: m.firstDate, lastDate: m.lastDate,
      activeMonths: months.filter(mo => m.byMonth[mo]).length,
    };
  }).sort(sortDesc);

  // ── 記者 ──
  const repMap = {};
  items.forEach(i => i.reporters.forEach(name => {
    const r = repMap[name] || (repMap[name] = { name, total: 0, byMonth: {}, mediaCounts: {}, firstDate: i.date, lastDate: i.date });
    r.total += 1; bump(r.byMonth, i.month); bump(r.mediaCounts, i.media); r.lastDate = i.date;
  }));
  const reporters = Object.values(repMap).map(r => {
    const mediaList = Object.entries(r.mediaCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    const activeMonths = months.filter(mo => r.byMonth[mo]).length;
    const firstMonth = monthKeyOf(r.firstDate);
    let status = 'active';
    if (months.length > 1 && firstMonth === latestMonth) status = 'new';
    else if (months.length > 1 && activeMonths === months.length) status = 'stable';
    else if (!r.byMonth[latestMonth]) status = 'lapsed';
    return {
      name: r.name, total: r.total, byMonth: r.byMonth, media: mediaList, mediaCount: mediaList.length,
      firstDate: r.firstDate, lastDate: r.lastDate, activeMonths, status,
    };
  }).sort(sortDesc);

  const unsigned = {
    count: items.filter(i => !i.reporters.length).length,
    byMedia: Object.entries(items.filter(i => !i.reporters.length).reduce((acc, i) => { bump(acc, i.media); return acc; }, {}))
      .map(([name, count]) => ({ name, total: count })).sort(sortDesc),
  };
  unsigned.share = unsigned.count / total;

  // ── 集中度 ──
  const shares = media.map(m => m.share);
  const topShare = n => shares.slice(0, n).reduce((a, b) => a + b, 0);
  const hhi = shares.reduce((a, s) => a + s * s, 0);
  const concentration = {
    top1: topShare(1), top3: topShare(3), top5: topShare(5),
    hhi: Math.round(hhi * 10000), effectiveMedia: hhi ? +(1 / hhi).toFixed(1) : 0,
  };

  // ── 本月 vs 上月的關係變化 ──
  const namesIn = (list, key, month) => new Set(list.filter(x => x.byMonth[month]).map(x => x[key]));
  const earlier = (list, month) => new Set(list.filter(x => months.some(m => m < month && x.byMonth[m])).map(x => x.name));
  let changes = null;
  if (prevMonth) {
    const mediaLatest = namesIn(media, 'name', latestMonth);
    const mediaPrev = namesIn(media, 'name', prevMonth);
    const mediaEarlier = earlier(media, latestMonth);
    const repLatest = namesIn(reporters, 'name', latestMonth);
    const repPrev = namesIn(reporters, 'name', prevMonth);
    const repEarlier = earlier(reporters, latestMonth);
    const diff = (a, b) => [...a].filter(x => !b.has(x));
    const delta = list => list
      .map(x => ({ name: x.name, latest: x.byMonth[latestMonth] || 0, prev: x.byMonth[prevMonth] || 0 }))
      .map(x => ({ ...x, delta: x.latest - x.prev }));
    changes = {
      latestMonth, prevMonth,
      newMedia: diff(mediaLatest, mediaEarlier),
      returningMedia: diff(mediaLatest, mediaPrev).filter(n => mediaEarlier.has(n)),
      lostMedia: diff(mediaPrev, mediaLatest),
      newReporters: diff(repLatest, repEarlier),
      returningReporters: diff(repLatest, repPrev).filter(n => repEarlier.has(n)),
      lostReporters: diff(repPrev, repLatest),
      mediaMovers: delta(media).filter(x => x.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6),
      reporterMovers: delta(reporters).filter(x => x.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6),
    };
  }

  // ── 關係觀察 ──
  const dependence = media.filter(m => m.total >= 3 && m.topReporter && m.topReporterShare >= 0.6);
  const crossMediaReporters = reporters.filter(r => r.mediaCount >= 2);
  const coreLapsed = reporters.filter(r => r.status === 'lapsed' && r.total >= 3);
  const stableReporters = reporters.filter(r => r.status === 'stable');
  const stableMedia = months.length > 1 ? media.filter(m => m.activeMonths === months.length) : [];

  // ── 曝光高峰日 ──
  const byDay = {};
  items.forEach(i => { (byDay[i.day] || (byDay[i.day] = [])).push(i); });
  const topicLabel = Object.fromEntries([...topics.map(t => [t.id, t.label]), ['other', '其他']]);
  const bursts = Object.entries(byDay)
    .map(([day, list]) => {
      const tc = {};
      list.forEach(i => i.topicIds.forEach(t => bump(tc, t)));
      return {
        day, count: list.length, mediaCount: new Set(list.map(i => i.media)).size,
        topics: Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => topicLabel[id]),
        titles: list.slice(0, 3).map(i => i.title),
      };
    })
    .filter(b => b.count >= 2)
    .sort((a, b) => b.count - a.count || (a.day < b.day ? 1 : -1))
    .slice(0, 8);

  // ── 題材 ──
  const topicDefs = [...topics, { id: 'other', label: '其他' }];
  const topicStats = topicDefs.map(t => {
    const list = items.filter(i => i.topicIds.includes(t.id));
    const byMonth = {}; const mediaCounts = {};
    list.forEach(i => { bump(byMonth, i.month); bump(mediaCounts, i.media); });
    return {
      id: t.id, label: t.label, total: list.length, share: list.length / total, byMonth,
      topMedia: Object.entries(mediaCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count })),
    };
  }).filter(t => t.total > 0).sort(sortDesc);

  // ── 類型／媒體類型 ──
  const types = {};
  items.forEach(i => bump(types, i.type));
  const catMap = {};
  media.forEach(m => {
    const c = catMap[m.category] || (catMap[m.category] = { name: m.category, total: 0, byMonth: {}, mediaCount: 0 });
    c.total += m.total; c.mediaCount += 1;
    Object.entries(m.byMonth).forEach(([mo, n]) => bump(c.byMonth, mo, n));
  });
  const categories = Object.values(catMap).map(c => ({ ...c, share: c.total / total })).sort(sortDesc);

  // ── 自動產生的重點發現 ──
  const pct = v => `${(v * 100).toFixed(0)}%`;
  const highlights = [];
  const m1 = media[0];
  highlights.push(`${m1.name} 是最大曝光來源：${m1.total} 篇（${pct(m1.share)}）；前 3 大媒體合計佔 ${pct(concentration.top3)}。`);
  const r1 = reporters[0];
  if (r1) highlights.push(`報導最多的記者是 ${r1.name}（${r1.media[0].name}，${r1.total} 篇）；共 ${reporters.length} 位具名記者，另有 ${unsigned.count} 篇（${pct(unsigned.share)}）未署名。`);
  if (prevMonth) {
    const a = monthly[monthly.length - 1], b = monthly[monthly.length - 2];
    const diffText = b.count ? `${a.count >= b.count ? '增加' : '減少'} ${Math.abs(Math.round((a.count - b.count) / b.count * 100))}%` : '';
    highlights.push(`${latestMonth} 共 ${a.count} 篇、${a.mediaCount} 家媒體，較 ${prevMonth}（${b.count} 篇）${diffText}。`);
  }
  if (bursts[0]) highlights.push(`曝光高峰是 ${bursts[0].day}：一天 ${bursts[0].count} 篇、${bursts[0].mediaCount} 家媒體，題材以「${bursts[0].topics.join('、')}」為主。`);
  if (stableReporters.length) highlights.push(`有 ${stableReporters.length} 位記者每個月都有報導（${stableReporters.slice(0, 4).map(r => r.name).join('、')}${stableReporters.length > 4 ? ' …' : ''}），是穩定的關係。`);
  if (coreLapsed.length) highlights.push(`${coreLapsed.length} 位原本常報導（≥3 篇）的記者 ${latestMonth} 沒有新報導：${coreLapsed.slice(0, 4).map(r => r.name).join('、')}${coreLapsed.length > 4 ? ' …' : ''}，可以關心一下。`);
  if (dependence.length) highlights.push(`${dependence.map(m => m.name).slice(0, 3).join('、')} 的報導高度集中在單一記者，記者異動時曝光會有風險。`);

  const insights = {
    empty: false, total, months, latestMonth, prevMonth,
    firstDate: items[0].date, lastDate: items[items.length - 1].date,
    monthly, media, reporters, unsigned, concentration, changes,
    dependence, crossMediaReporters, coreLapsed, stableReporters, stableMedia,
    bursts, topics: topicStats, types, categories, highlights,
    coverage: null,
  };
  if (autoArticles) insights.coverage = compareWithAuto(items, autoArticles, now);
  return insights;
}
