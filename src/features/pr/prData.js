import { inPeriod, sortByDate, taipeiPeriodRange } from '../../utils/dates.js';
import { COMPETITORS } from '../../config/competitors.js';
import { dedupeArticlesByTitle, isValidTranscendPR } from '../../utils/news.js';

// PR 媒體戰情各子頁共用的「資料選取」規則。總覽、新聞監測、競品動態都用這裡的函式，
// 不在各元件各寫一份，才不會出現兩套「什麼算有效創見報導／什麼算競品新聞」的定義。

/**
 * 所有有效創見 PR 文章（已排除 CMoney／券商明細），並先去重——同一則報導可能因為不同
 * RSS／搜尋條件被存成多筆 Firestore 文件。搜尋、統計、清單、匯出、總覽摘要都共用這份結果，
 * 數字才會彼此一致。
 */
export const selectValidTranscend = prArticles => dedupeArticlesByTitle((prArticles || []).filter(isValidTranscendPR));

/** 時間篩選：競品動態用的 5 個選項（今天／本週／本月／上月／已載入資料）。新聞只保留本月＋上個月，所以沒有「本年」。 */
export const COMPETITOR_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
  { id: 'lastMonth', label: '上月' },
  { id: 'all', label: '已載入資料' },
];

/** 品牌曝光量表的期間欄（不含「已載入資料」）。 */
export const BRAND_COUNT_PERIODS = COMPETITOR_TIME_FILTERS.filter(f => f.id !== 'all');

/**
 * 各競品品牌的新聞曝光則數：每個品牌 × 今天／本週／本月／上月。
 * 與下方清單共用 selectCompetitorNews（同樣的去重、排除 CMoney 規則），數字一定對得上清單筆數。
 * 回傳 [{ id, name, color, counts: { today, week, month, lastMonth } }]，最後一列 id='all' 為全部品牌合計（跨品牌去重後）。
 */
export function brandExposureCounts(news, now = new Date()) {
  const row = brand => Object.fromEntries(BRAND_COUNT_PERIODS.map(p => [p.id, selectCompetitorNews(news, { brand, timeFilter: p.id, now }).length]));
  return [
    ...COMPETITORS.map(c => ({ id: c.id, name: c.name, color: c.color, counts: row(c.id) })),
    { id: 'all', name: '全部品牌', color: null, counts: row('all') },
  ];
}

/** 時間篩選：創見最新報導用的 4 個選項（今天／本週／本月／上月）。 */
export const PR_LIST_TIME_FILTERS = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本週' },
  { id: 'month', label: '本月' },
  { id: 'lastMonth', label: '上月' },
];

const pubDateOf = n => (n.pubDate?.toDate ? n.pubDate.toDate() : new Date(n.pubDate || 0));

/**
 * 競品新聞：cat=competitor，排除 CMoney／股市爆料同學會（移至 IR 網路輿情），依時間新到舊並去重。
 * brand='all' 不篩品牌；timeFilter='all'（預設）不篩時間。
 * 競品動態子頁與總覽的「競品最新動態」共用這一個函式。
 */
export function selectCompetitorNews(news, { brand = 'all', timeFilter = 'all', now = new Date() } = {}) {
  const cutoffs = {
    today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    month: new Date(now.getFullYear(), now.getMonth(), 1),
    all: null,
  };
  const cutoff = cutoffs[timeFilter];
  // 上月：台灣時間上個月 1 日 ≤ 發布時間 < 本月 1 日（本月的新聞不會混進來）
  const lastMonth = timeFilter === 'lastMonth' ? taipeiPeriodRange('lastMonth', now) : null;
  return dedupeArticlesByTitle(sortByDate(
    (news || []).filter(n => {
      if (n.cat !== 'competitor') return false;
      if (brand !== 'all' && n.brand !== brand) return false;
      const link = (n.link || '').toLowerCase();
      const media = (n.mediaName || n.sourceName || '').toLowerCase();
      if (link.includes('cmoney') || media.includes('cmoney') || media.includes('爆料')) return false;
      if (lastMonth) return inPeriod(n, lastMonth);
      if (!cutoff) return true;
      return pubDateOf(n) >= cutoff;
    })
  ));
}
