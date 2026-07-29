import { sortByDate } from './dates.js';

export const BRAND = '#960014';

/**
 * 新聞篩選工具列（搜尋框 + 媒體 + 情緒下拉）套用在一則新聞上的判斷式。
 * 由 App.jsx 的 filteredNews 抽出，供元件與測試共用同一份邏輯。
 */
export function matchesNewsFilters(article, { query = '', media = 'all', sentiment = 'all' } = {}) {
  const source = article.mediaName || article.sourceName || '未知媒體';
  if (media !== 'all' && source !== media) return false;
  const articleSentiment = article.sentiment || getSentiment(article.title, article.content);
  if (sentiment !== 'all' && articleSentiment !== sentiment) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [article.title, article.content, source, article.sourceName, article.brand]
    .map(v => String(v || '').toLowerCase()).join(' ');
  return haystack.includes(q);
}

/** 對一批新聞套用 matchesNewsFilters，回傳符合條件的子集合（保留原順序）。 */
export function filterNewsList(articles, filters) {
  return articles.filter(a => matchesNewsFilters(a, filters));
}

export function getSentiment(title = '', content = '') {
  const t = (title + ' ' + content).toLowerCase();
  const pos = ['獲獎', '營收', '新高', '成長', '獲利', '上漲', '突破', '合作', '推出', '亮眼', 'award', 'growth', 'record', 'profit', 'surge'].filter(k => t.includes(k)).length;
  const neg = ['虧損', '下滑', '召回', '訴訟', '下跌', '危機', '裁員', '倒閉', '利空', 'loss', 'lawsuit', 'crash', 'decline', 'layoff'].filter(k => t.includes(k)).length;
  return pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
}

export function normalizeNewsTitle(title = '') {
  return title.toLowerCase().replace(/[\s\-–—_:：，,。.!！?？()（）「」『』]/g, '');
}

// 已由原始媒體頁面人工核對的歷史日期錯誤（與 functions/fetch_news.py 的
// VERIFIED_NEWS_DATE_CORRECTIONS 對應同一筆紀錄，前後端各自保留一份
// 供尚未被後端遷移覆蓋到的既有 Firestore 文件顯示時使用）。
export const VERIFIED_ARTICLE_CORRECTIONS = {
  [normalizeNewsTitle('台股擂台／挑戰者「股市擺渡人」陳玠儒 本周押偉詮電、創見')]: {
    pubDate: new Date('2026-03-14T16:42:28Z'),
    link: 'https://money.udn.com/money/story/123397/9380328',
    mediaName: '經濟日報',
    dateSource: 'publisher_verified',
  },
};

export function dedupeArticlesByTitle(articles) {
  const merged = new Map();
  articles.forEach(rawArticle => {
    const correction = VERIFIED_ARTICLE_CORRECTIONS[normalizeNewsTitle(rawArticle.title)];
    const article = correction ? { ...rawArticle, ...correction } : rawArticle;
    const key = normalizeNewsTitle(article.title);
    if (!key) return;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, article);
      return;
    }

    // 同一篇新聞可能有數個 Google News cluster URL；日期衝突時使用
    // 最早的有效日期，避免重新收錄日被顯示成原始發布日。
    const time = article => {
      const d = article.pubDate?.toDate ? article.pubDate.toDate() : new Date(article.pubDate || 0);
      const ms = d.getTime();
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    };
    const currentTime = time(current);
    const newTime = time(article);
    const currentGoogle = (current.link || '').includes('news.google.com');
    const newDirect = article.link && !(article.link || '').includes('news.google.com');
    const preferred = currentGoogle && newDirect ? { ...article } : { ...current };
    if (currentTime !== null || newTime !== null) {
      preferred.pubDate = newTime !== null && (currentTime === null || newTime < currentTime)
        ? article.pubDate : current.pubDate;
    }
    merged.set(key, preferred);
  });
  return sortByDate([...merged.values()]);
}

export const EXCLUDED_NEWS_PHRASES = ['創見文化事業'];
export function isExcludedNews(n) {
  const text = `${n?.title || ''} ${n?.content || ''}`.toLowerCase();
  return EXCLUDED_NEWS_PHRASES.some(phrase => text.includes(phrase.toLowerCase()));
}

export const SENT_CFG = {
  positive: { label: '正面', cls: 'bg-green-900/40 text-green-300 border-green-700/50' },
  neutral: { label: '中立', cls: 'bg-gray-800    text-gray-400  border-gray-600/50' },
  negative: { label: '負面', cls: 'bg-red-900/40  text-red-300   border-red-700/50' },
};

export const BRIEFING_RULES = [
  { kind: 'risk', label: '風險', score: 40, words: ['虧損', '下跌', '急跌', '召回', '訴訟', '裁員', '停產', '危機', '資安', '衰退'] },
  { kind: 'finance', label: '財務', score: 32, words: ['營收', '獲利', '財報', '財務報告', 'eps', '股利', '法說', '毛利率', '淨利'] },
  { kind: 'opportunity', label: '機會', score: 26, words: ['成長', '新高', '合作', '推出', '新品', '擴產', '得獎', '突破', '上漲'] },
  { kind: 'market', label: '市場', score: 18, words: ['記憶體', 'dram', 'nand', 'ssd', 'hbm', '供應鏈', '漲價', '需求', '庫存'] },
];

// PR 重點媒體監控清單
export const KEY_MEDIA = [
  { name: '電子時報', en: 'Digitimes' },
  { name: '科技新報', en: 'TechNews' },
  { name: '經濟日報', en: 'Economic Daily' },
  { name: '工商時報', en: 'Commercial Times' },
  { name: '中央社', en: 'CNA' },
  { name: 'iThome', en: 'iThome' },
  { name: '鉅亨網', en: 'Anue/CNyes' },
  { name: 'MoneyDJ', en: 'MoneyDJ' },
  { name: '自由時報', en: 'Liberty Times' },
  { name: 'ETtoday財經雲', en: 'ETtoday Finance' },
  { name: '聯合報', en: 'UDN' },
  { name: '中時新聞網', en: 'China Times' },
];

export function getBriefingMeta(article) {
  const text = `${article.title || ''} ${article.content || ''}`.toLowerCase();
  const matched = BRIEFING_RULES.filter(rule => rule.words.some(word => text.includes(word)));
  const primary = matched.sort((a, b) => b.score - a.score)[0] || { kind: 'news', label: '關注', score: 8 };
  const d = article.pubDate?.toDate ? article.pubDate.toDate() : new Date(article.pubDate || 0);
  const ageHours = Math.max(0, (Date.now() - d.getTime()) / 3600000);
  const recency = ageHours <= 24 ? 24 : ageHours <= 72 ? 16 : ageHours <= 168 ? 8 : 0;
  const isSelf = /創見|transcend information/i.test(text);
  const media = article.mediaName || article.sourceName || '';
  const keyMedia = KEY_MEDIA.some(m => media.includes(m.name) || media.toLowerCase().includes(m.en.toLowerCase()));
  const reasons = [primary.label];
  if (ageHours <= 24) reasons.push('24 小時內');
  if (isSelf) reasons.push('直接提及創見');
  if (keyMedia) reasons.push('重點媒體');
  return { ...primary, score: primary.score + recency + (isSelf ? 20 : 0) + (keyMedia ? 8 : 0), reasons };
}

export function getActionSuggestion(article, meta) {
  const text = `${article.title || ''} ${article.content || ''}`.toLowerCase();
  const isSelf = /創見|transcend information/i.test(text) && article.cat === 'transcend';
  const actions = {
    risk: isSelf
      ? '立即確認事件影響，準備內部說明與對外回應重點。'
      : '持續追蹤後續發展，評估是否影響創見品牌或產品。',
    finance: isSelf
      ? '核對公開資訊與官網內容，整理可供主管使用的財務重點。'
      : '整理與創見的營運差異，納入下一次競品報告。',
    opportunity: isSelf
      ? '評估延伸新聞稿、官網或社群曝光，放大正面聲量。'
      : '比較產品賣點與市場定位，更新競品資料。',
    market: '整理對記憶體價格、供應與產品策略的可能影響。',
    news: '確認與創見的關聯性，再決定是否持續追蹤。',
  };
  return actions[meta.kind] || actions.news;
}

// PR 過濾函式 — 排除 CMoney / 股市爆料同學會 / 券商明細 / 鉅亨盤中速報
export function isValidTranscendPR(n) {
  if (n.cat !== 'transcend') return false;
  if (isExcludedNews(n)) return false;
  // 標題或內文必須含創見 / Transcend
  const text = (n.title + ' ' + (n.content || '')).toLowerCase();
  if (!text.includes('創見') && !text.includes('transcend')) return false;
  // 排除 CMoney / 股市爆料同學會
  const link = (n.link || '').toLowerCase();
  const media = (n.mediaName || n.sourceName || '').toLowerCase();
  if (link.includes('cmoney') || media.includes('cmoney') || media.includes('爆料')) return false;
  // 「盤中速報」屬自動股價快訊，避免淹沒真正的媒體報導。
  const isCnyes = link.includes('cnyes.com') || media.includes('鉅亨') || media.includes('cnyes');
  if (isCnyes && (n.title || '').includes('盤中速報')) return false;
  // 排除券商個股歷史明細類頁面
  const title = n.title || '';
  const BLOCKED = ['明細', '歷史明細', '庫存', '個股異動', '集保', '買賣明細', '交割明細', '籌碼'];
  if (BLOCKED.some(k => title.includes(k))) return false;
  return true;
}

export function isBriefingCandidate(n) {
  if (n.cat === 'transcend') return isValidTranscendPR(n);
  if (n.cat !== 'competitor' || (n.title || '').includes('盤中速報')) return false;
  const link = (n.link || '').toLowerCase();
  const media = (n.mediaName || n.sourceName || '').toLowerCase();
  if (link.includes('cmoney') || media.includes('cmoney') || media.includes('爆料')) return false;
  const text = `${n.title || ''} ${n.content || ''}`.toLowerCase();
  if (['盤後成交金額', '前30名', '排行榜', '買賣明細'].some(term => text.includes(term))) return false;
  const trackedTerms = [
    '威剛', 'adata', '3260', '十銓', 'teamgroup', 'team group', '4967',
    '宜鼎', 'innodisk', '5289', '宇瞻', 'apacer', '8271',
    '廣穎', 'silicon power', '4973',
  ];
  return trackedTerms.some(term => text.includes(term));
}

// 上游市場 TAB — 品牌輔助函式
export function getUSBrand(n) {
  if (n.brand) return n.brand; // supplier cat 已有 brand 欄位
  const src = (n.sourceName || '') + ' ' + (n.mediaName || '');
  if (/Samsung/i.test(src)) return 'Samsung';
  if (/Micron/i.test(src)) return 'Micron';
  if (/Hynix/i.test(src)) return 'SK Hynix';
  if (/Kioxia/i.test(src)) return 'Kioxia';
  if (/SanDisk|Western Digital|WD/i.test(src)) return 'SanDisk/WD';
  if (/SMI|Silicon Motion|慧榮/i.test(src)) return 'SMI';
  if (/Phison|群聯/i.test(src)) return 'Phison';
  if (/Realtek|瑞昱/i.test(src)) return 'Realtek';
  if (/Kingston|金士頓/i.test(src)) return 'Kingston';
  if (/HBM/i.test(src)) return 'HBM';
  if (/DRAM/i.test(src)) return 'DRAM市場';
  if (/NAND|Flash/i.test(src)) return 'NAND Flash';
  if (/Transcend/i.test(src)) return '創見(英文)';
  return '其他';
}

export const US_BRAND_CFG = [
  { id: 'all', label: '全部' },
  { id: 'Samsung', label: 'Samsung', color: '#1d4ed8' },
  { id: 'Micron', label: 'Micron', color: '#dc2626' },
  { id: 'SK Hynix', label: 'SK Hynix', color: '#16a34a' },
  { id: 'Kioxia', label: 'Kioxia', color: '#7c3aed' },
  { id: 'SanDisk/WD', label: 'SanDisk/WD', color: '#ea580c' },
  { id: 'SMI', label: 'SMI 慧榮', color: '#0891b2' },
  { id: 'Phison', label: 'Phison 群聯', color: '#0e7490' },
  { id: 'Realtek', label: 'Realtek 瑞昱', color: '#0369a1' },
  { id: 'Kingston', label: 'Kingston 金士頓', color: '#db2777' },
  { id: 'HBM', label: 'HBM', color: '#06b6d4' },
  { id: 'DRAM市場', label: 'DRAM市場', color: '#ca8a04' },
  { id: 'NAND Flash', label: 'NAND Flash', color: '#9333ea' },
  { id: '創見(英文)', label: '創見(英文)', color: BRAND },
];

// ─── 媒體 domain 對照表（既有既存但目前無畫面引用；隨模組搬移原樣保留）───
export const MEDIA_MAP = {
  'udn.com': '聯合報', 'money.udn.com': '經濟日報', 'ctee.com.tw': '工商時報',
  'chinatimes.com': '中時新聞網', 'technews.tw': '科技新報', 'ithome.com.tw': 'iThome',
  'digitimes.com.tw': '電子時報', 'digitimes.com': '電子時報',
  'anue.com.tw': '鉅亨網', 'cnyes.com': '鉅亨網', 'news.cnyes.com': '鉅亨網', 'm.cnyes.com': '鉅亨網',
  'wantrich.chinatimes.com': '旺得富理財網',
  'ltn.com.tw': '自由時報', 'ec.ltn.com.tw': '自由時報',
  'ettoday.net': 'ETtoday', 'finance.ettoday.net': 'ETtoday財經雲',
  'nextapple.com': '壹蘋新聞網', 'news.nextapple.com': '壹蘋新聞網',
  'mnews.tw': '鏡報', 'mirrordaily.news': '鏡報', 'mirrormedia.mg': '鏡週刊',
  'newtalk.tw': 'Newtalk', 'moneydj.com': 'MoneyDJ', 'storm.mg': '風傳媒',
  'cna.com.tw': '中央社', 'wealth.com.tw': '財訊', 'gvm.com.tw': '遠見',
  'ustv.com.tw': '非凡財經', 'trendforce.com': 'TrendForce',
};

// ─── 股票代號偵測（既有既存但目前無畫面引用；隨模組搬移原樣保留）───
export const STOCK_CMONEY = {
  '2451': 'https://www.cmoney.tw/forum/stock/2451',
  '3260': 'https://www.cmoney.tw/forum/stock/3260',
  '4967': 'https://www.cmoney.tw/forum/stock/4967',
  '4973': 'https://www.cmoney.tw/forum/stock/4973',
  '5289': 'https://www.cmoney.tw/forum/stock/5289',
  '8271': 'https://www.cmoney.tw/forum/stock/8271',
};

export const STOCK_KW_MAP = {
  '2451': ['創見', '2451', 'transcend'],
  '3260': ['威剛', '3260', 'adata'],
  '4967': ['十銓', '4967', 'teamgroup'],
  '4973': ['廣穎', '4973', 'silicon power'],
  '5289': ['宜鼎', '5289', 'innodisk'],
  '8271': ['宇瞻', '8271', 'apacer'],
};

export function detectStockCode(title, content) {
  const t = (title + ' ' + (content || '')).toLowerCase();
  for (const [code, kws] of Object.entries(STOCK_KW_MAP)) {
    if (kws.some(kw => t.includes(kw))) return code;
  }
  return null;
}

// ─── 社群觀測 mock（既有既存但目前無畫面引用；隨模組搬移原樣保留）───
export const MOCK_COMMUNITY = [
  { id: 1, src: 'PTT Stock', title: '[情報] 創見元月EPS 6.49元，年增15倍，今年挑戰20元有望', link: 'https://www.ptt.cc/bbs/Stock/index.html', s: 'positive', time: '3h前', author: 'investor2451' },
  { id: 4, src: 'PTT Stock', title: '[新聞] 創見Q1淡季不淡，外資持續加碼', link: 'https://www.ptt.cc/bbs/Stock/index.html', s: 'positive', time: '12h前', author: 'bull_tw88' },
  { id: 5, src: 'CMoney', title: '威剛 vs 創見：Q1財報誰更強？記憶體廠大比較', link: 'https://www.cmoney.tw/forum/stock/2451', s: 'neutral', time: '1天前', author: 'compare_master' },
  { id: 6, src: 'PTT Stock', title: '記憶體股近期回檔，是買點還是轉弱訊號？', link: 'https://www.ptt.cc/bbs/Stock/index.html', s: 'negative', time: '1天前', author: 'risk_mgr' },
];

export const SRC_COLOR = {
  'PTT Stock': '#f97316',
  '股市爆料同學會 (CMoney)': '#10b981',
  'CMoney': '#10b981',
};
