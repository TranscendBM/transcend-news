import { describe, it, expect } from 'vitest';
import {
  normalizeNewsTitle, dedupeArticlesByTitle, isExcludedNews, isValidTranscendPR,
  isBriefingCandidate, filterNewsList, matchesNewsFilters, getUSBrand,
} from './news.js';

function mkArticle(overrides = {}) {
  return {
    id: 'a1',
    title: '創見資訊發布新品',
    content: '創見資訊 SSD 新品上市',
    link: 'https://example.com/a1',
    cat: 'transcend',
    mediaName: '經濟日報',
    pubDate: new Date('2026-07-20T03:00:00Z'),
    ...overrides,
  };
}

describe('normalizeNewsTitle', () => {
  it('strips whitespace/punctuation and lowercases', () => {
    expect(normalizeNewsTitle('創見 資訊：發布 新品！')).toBe(normalizeNewsTitle('創見資訊發布新品'));
  });

  it('treats differently-punctuated titles as equal', () => {
    const a = normalizeNewsTitle('Transcend-Info: New SSD Launch!');
    const b = normalizeNewsTitle('transcend info new ssd launch');
    expect(a).toBe(b);
  });
});

describe('dedupeArticlesByTitle', () => {
  it('collapses same-title articles into one', () => {
    const a = mkArticle({ id: 'a', title: '創見 SSD 新品', pubDate: new Date('2026-07-20T03:00:00Z') });
    const b = mkArticle({ id: 'b', title: '創見，SSD，新品', pubDate: new Date('2026-07-20T05:00:00Z') });
    const result = dedupeArticlesByTitle([a, b]);
    expect(result.length).toBe(1);
  });

  it('keeps the earliest valid pubDate among duplicates (date correction)', () => {
    const early = mkArticle({ id: 'early', title: '創見 SSD 新品', pubDate: new Date('2026-07-18T00:00:00Z') });
    const late = mkArticle({ id: 'late', title: '創見 SSD 新品', pubDate: new Date('2026-07-20T00:00:00Z') });
    const result = dedupeArticlesByTitle([late, early]);
    expect(result.length).toBe(1);
    const merged = result[0].pubDate?.toDate ? result[0].pubDate.toDate() : new Date(result[0].pubDate);
    expect(merged.getTime()).toBe(early.pubDate.getTime());
  });

  it('prefers the direct media link over a Google News redirect link', () => {
    const google = mkArticle({
      id: 'google', title: '創見 SSD 新品',
      link: 'https://news.google.com/rss/articles/xyz',
      pubDate: new Date('2026-07-20T00:00:00Z'),
    });
    const direct = mkArticle({
      id: 'direct', title: '創見，SSD，新品',
      link: 'https://money.udn.com/money/story/123/456',
      pubDate: new Date('2026-07-20T00:00:00Z'),
    });
    const result = dedupeArticlesByTitle([google, direct]);
    expect(result.length).toBe(1);
    expect(result[0].link).toBe('https://money.udn.com/money/story/123/456');
  });

  it('does not merge distinct titles', () => {
    const a = mkArticle({ id: 'a', title: '創見 SSD 新品' });
    const b = mkArticle({ id: 'b', title: '威剛 記憶體 財報' });
    expect(dedupeArticlesByTitle([a, b]).length).toBe(2);
  });

  it('applies the verified historical date correction by title', () => {
    const wrong = mkArticle({
      id: 'w', title: '台股擂台／挑戰者「股市擺渡人」陳玠儒 本周押偉詮電、創見',
      link: 'https://news.google.com/rss/articles/whatever',
      pubDate: new Date('2026-01-01T00:00:00Z'),
    });
    const [fixed] = dedupeArticlesByTitle([wrong]);
    const d = fixed.pubDate?.toDate ? fixed.pubDate.toDate() : new Date(fixed.pubDate);
    expect(d.toISOString()).toBe(new Date('2026-03-14T16:42:28Z').toISOString());
    expect(fixed.link).toBe('https://money.udn.com/money/story/123397/9380328');
  });
});

describe('isExcludedNews / 排除創見文化事業', () => {
  it('excludes articles mentioning 創見文化事業', () => {
    const n = mkArticle({ title: '創見文化事業股份有限公司舉辦活動', content: '' });
    expect(isExcludedNews(n)).toBe(true);
  });

  it('does not exclude ordinary 創見資訊 articles', () => {
    const n = mkArticle({ title: '創見資訊發布新品', content: '' });
    expect(isExcludedNews(n)).toBe(false);
  });
});

describe('isValidTranscendPR / 排除鉅亨盤中速報', () => {
  it('excludes Cnyes 盤中速報 (intraday briefs)', () => {
    const n = mkArticle({
      title: '創見 (2451) 盤中速報：股價上漲',
      mediaName: '鉅亨網',
      link: 'https://news.cnyes.com/news/id/12345',
    });
    expect(isValidTranscendPR(n)).toBe(false);
  });

  it('keeps ordinary Cnyes coverage that is not an intraday brief', () => {
    const n = mkArticle({
      title: '創見資訊發布新款 SSD',
      mediaName: '鉅亨網',
      link: 'https://news.cnyes.com/news/id/12345',
    });
    expect(isValidTranscendPR(n)).toBe(true);
  });

  it('excludes CMoney forum content', () => {
    const n = mkArticle({ mediaName: 'CMoney', link: 'https://www.cmoney.tw/forum/stock/2451' });
    expect(isValidTranscendPR(n)).toBe(false);
  });

  it('excludes broker detail-page style titles', () => {
    const n = mkArticle({ title: '創見 2451 個股籌碼明細' });
    expect(isValidTranscendPR(n)).toBe(false);
  });

  it('rejects articles not about transcend at all', () => {
    const n = mkArticle({ cat: 'transcend', title: '今天天氣很好', content: '氣象局發布豪雨特報' });
    expect(isValidTranscendPR(n)).toBe(false);
  });
});

describe('isBriefingCandidate', () => {
  it('excludes competitor 盤中速報 the same way', () => {
    const n = mkArticle({ cat: 'competitor', brand: 'ADATA', title: '威剛 (3260) 盤中速報' });
    expect(isBriefingCandidate(n)).toBe(false);
  });

  it('accepts competitor articles mentioning a tracked competitor term', () => {
    const n = mkArticle({ cat: 'competitor', brand: 'ADATA', title: '威剛科技公布新產品線', content: 'adata' });
    expect(isBriefingCandidate(n)).toBe(true);
  });
});

describe('matchesNewsFilters / filterNewsList（搜尋與篩選）', () => {
  const pool = [
    mkArticle({ id: '1', title: 'DRAM 價格上漲', mediaName: '電子時報', sentiment: 'positive' }),
    mkArticle({ id: '2', title: 'NAND Flash 需求疲弱', mediaName: '科技新報', sentiment: 'negative' }),
    mkArticle({ id: '3', title: '創見資訊財報公布', mediaName: '電子時報', sentiment: 'neutral' }),
  ];

  it('filters by free-text query across title/content/media', () => {
    const result = filterNewsList(pool, { query: 'nand' });
    expect(result.map(n => n.id)).toEqual(['2']);
  });

  it('filters by media', () => {
    const result = filterNewsList(pool, { media: '電子時報' });
    expect(result.map(n => n.id).sort()).toEqual(['1', '3']);
  });

  it('filters by sentiment', () => {
    const result = filterNewsList(pool, { sentiment: 'negative' });
    expect(result.map(n => n.id)).toEqual(['2']);
  });

  it('combines query + media + sentiment (AND semantics)', () => {
    const result = filterNewsList(pool, { query: '創見', media: '電子時報', sentiment: 'neutral' });
    expect(result.map(n => n.id)).toEqual(['3']);
  });

  it('returns everything when filters are at defaults', () => {
    expect(filterNewsList(pool, {}).length).toBe(pool.length);
  });

  it('matchesNewsFilters is the single-article building block used by filterNewsList', () => {
    expect(matchesNewsFilters(pool[0], { query: 'dram' })).toBe(true);
    expect(matchesNewsFilters(pool[0], { query: 'nand' })).toBe(false);
  });
});

describe('getUSBrand', () => {
  it('detects Kingston from source text', () => {
    expect(getUSBrand({ sourceName: 'Kingston EN', mediaName: '' })).toBe('Kingston');
  });

  it('prefers an explicit brand field when present', () => {
    expect(getUSBrand({ brand: 'Micron', sourceName: 'anything' })).toBe('Micron');
  });
});
