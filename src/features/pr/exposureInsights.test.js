import { describe, it, expect } from 'vitest';

import { buildExposureInsights, splitReporters, monthKeyOf, dayKeyOf, urlKey, titleKey } from './exposureInsights.js';

// 台灣時間 y-m-d h:mi 的實際時刻
const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);

function rec(id, date, media, reporter, title, extra = {}) {
  return {
    id, exposureDate: date, mediaName: media, reporter, title,
    link: 'https://example.com/' + id, exposureType: 'online', ...extra,
  };
}

// 7 月 4 篇、8 月 3 篇、9 月 5 篇
const RECORDS = [
  rec('a1', tw(2026, 7, 6), 'A報', '王一', '創見6月營收創新高'),
  rec('a2', tw(2026, 7, 6), 'B網', '李二', '創見營收年增381%'),
  rec('a3', tw(2026, 7, 6, 1), 'C台', '', '創見營收公告'),
  rec('a4', tw(2026, 7, 20), 'A報', '王一', '創見推出新品固態硬碟'),
  rec('b1', tw(2026, 8, 5), 'A報', '王一', '創見7月營收'),
  rec('b2', tw(2026, 8, 5), 'B網', '李二', '創見7月營收年增'),
  rec('b3', tw(2026, 8, 20), 'D報', '張三', '創見與研華攜手推出嵌入式鏡頭'),
  rec('c1', tw(2026, 9, 3), 'A報', '王一', '創見DRAM報價看漲'),
  rec('c2', tw(2026, 9, 3), 'E網', '趙四、錢五', '記憶體缺貨 創見受惠'),
  rec('c3', tw(2026, 9, 10), 'D報', '張三', '創見公告庫藏股'),
  rec('c4', tw(2026, 9, 11), 'E網', '趙四', '創見AI邊緣運算新品', { exposureType: 'video' }),
  rec('c5', tw(2026, 9, 30, 23), 'F台', '', '創見9月消息'),
];

describe('helpers', () => {
  it('月份與日期用台灣時間：台灣 9/30 23:00 還是 9 月，台灣 7/1 00:30 已經是 7 月', () => {
    expect(monthKeyOf(tw(2026, 9, 30, 23))).toBe('2026-09');
    expect(monthKeyOf(tw(2026, 7, 1, 0))).toBe('2026-07');
    expect(dayKeyOf(tw(2026, 7, 1, 0))).toBe('2026-07-01');
  });

  it('多位記者共同署名會拆開；空白代表未署名；重複的名字只算一次', () => {
    expect(splitReporters('趙四、錢五')).toEqual(['趙四', '錢五']);
    expect(splitReporters('王一/王一')).toEqual(['王一']);
    expect(splitReporters('  ')).toEqual([]);
    expect(splitReporters(undefined)).toEqual([]);
  });

  it('網址正規化：忽略 http/https、www、結尾斜線、追蹤參數；標題正規化：忽略空白與標點', () => {
    expect(urlKey('http://www.Example.com/a/?utm_source=x')).toBe(urlKey('https://example.com/a'));
    expect(urlKey('https://example.com/a?id=1')).not.toBe(urlKey('https://example.com/a?id=2'));
    expect(titleKey('創見：營收 創新高！')).toBe(titleKey('創見營收創新高'));
  });
});

describe('buildExposureInsights', () => {
  const ins = buildExposureInsights(RECORDS, { now: tw(2026, 10, 7) });

  it('沒有資料時回傳 empty，不會丟錯', () => {
    expect(buildExposureInsights([]).empty).toBe(true);
    expect(buildExposureInsights(null).empty).toBe(true);
    expect(buildExposureInsights([{ exposureDate: 'not a date', mediaName: 'x' }]).empty).toBe(true);
  });

  it('月趨勢：每月篇數、媒體數、記者數、未署名數', () => {
    expect(ins.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(ins.total).toBe(12);
    expect(ins.monthly.map(m => m.count)).toEqual([4, 3, 5]);
    expect(ins.monthly.map(m => m.mediaCount)).toEqual([3, 3, 4]);
    expect(ins.monthly[0].reporterCount).toBe(2);   // 王一、李二（C台未署名）
    expect(ins.monthly[0].unsignedCount).toBe(1);
    expect(ins.monthly[2].reporterCount).toBe(4);   // 王一、趙四、錢五、張三
  });

  it('月份即使中間某月沒有資料也會補上（0 篇），圖表才不會跳月', () => {
    const gap = buildExposureInsights([
      rec('x1', tw(2026, 5, 3), 'A報', '王一', 't1'), rec('x2', tw(2026, 7, 3), 'A報', '王一', 't2'),
    ]);
    expect(gap.months).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(gap.monthly.map(m => m.count)).toEqual([1, 0, 1]);
  });

  it('媒體排行：篇數、佔比、各月分布、主力記者與依賴度', () => {
    const [first, ...rest] = ins.media;
    expect(first.name).toBe('A報');
    expect(first.total).toBe(4);
    expect(first.share).toBeCloseTo(4 / 12);
    expect(first.byMonth).toEqual({ '2026-07': 2, '2026-08': 1, '2026-09': 1 });
    expect(first.topReporter).toBe('王一');
    expect(first.topReporterShare).toBe(1);
    expect(first.activeMonths).toBe(3);
    expect(first.category).toBe('其他');
    expect(rest.map(m => m.total)).toEqual([...rest.map(m => m.total)].sort((a, b) => b - a));
  });

  it('記者排行：共同署名各算一篇、跨媒體、狀態（穩定／新增／本月沒出現）', () => {
    const byName = Object.fromEntries(ins.reporters.map(r => [r.name, r]));
    expect(byName['王一'].total).toBe(4);
    expect(byName['王一'].status).toBe('stable');           // 7、8、9 月都有
    expect(byName['趙四'].total).toBe(2);
    expect(byName['錢五'].total).toBe(1);
    expect(byName['錢五'].status).toBe('new');               // 9 月才首次出現
    expect(byName['李二'].status).toBe('lapsed');           // 7、8 月有，9 月沒有
    expect(ins.unsigned.count).toBe(2);
    expect(ins.unsigned.share).toBeCloseTo(2 / 12);
  });

  it('集中度：前 N 大佔比與等效媒體數', () => {
    expect(ins.concentration.top1).toBeCloseTo(4 / 12);
    expect(ins.concentration.top3).toBeGreaterThan(ins.concentration.top1);
    expect(ins.concentration.top5).toBeLessThanOrEqual(1);
    expect(ins.concentration.effectiveMedia).toBeGreaterThan(1);
  });

  it('本月 vs 上月：新增／回流／流失的媒體與記者', () => {
    const c = ins.changes;
    expect([c.latestMonth, c.prevMonth]).toEqual(['2026-09', '2026-08']);
    expect(c.newMedia.sort()).toEqual(['E網', 'F台']);       // 9 月才首次出現
    expect(c.lostMedia.sort()).toEqual(['B網']);              // 8 月有、9 月沒有
    expect(c.returningMedia).toEqual([]);
    expect(c.newReporters.sort()).toEqual(['趙四', '錢五']);
    expect(c.lostReporters).toEqual(['李二']);
    expect(c.mediaMovers[0].delta).not.toBe(0);
  });

  it('只有一個月的資料時沒有月比較', () => {
    const one = buildExposureInsights(RECORDS.slice(0, 4));
    expect(one.changes).toBeNull();
    expect(one.prevMonth).toBeNull();
    expect(one.reporters.every(r => r.status !== 'new' && r.status !== 'stable')).toBe(true);
  });

  it('曝光高峰日：只列 2 篇以上的日子，依篇數排序，帶出題材', () => {
    expect(ins.bursts[0]).toMatchObject({ day: '2026-07-06', count: 3, mediaCount: 3 });
    expect(ins.bursts[0].topics).toContain('營收・財報');
    expect(ins.bursts.every(b => b.count >= 2)).toBe(true);
  });

  it('題材：一則標題可同時屬於多個題材；都沒中歸「其他」', () => {
    const byId = Object.fromEntries(ins.topics.map(t => [t.id, t]));
    expect(byId.finance.total).toBe(5);                      // 營收×5
    expect(byId.product.byMonth['2026-07']).toBe(1);         // 新品固態硬碟
    expect(byId.partner.total).toBe(1);                      // 研華
    expect(byId.market.total).toBe(2);                       // DRAM報價、記憶體缺貨
    expect(byId.corporate.total).toBe(1);                    // 庫藏股
    expect(byId.other.total).toBe(1);                        // 創見9月消息
    expect(byId.finance.topMedia[0].name).toBe('A報');
  });

  it('曝光類型與媒體類型彙總', () => {
    expect(ins.types).toEqual({ online: 11, video: 1 });
    expect(ins.categories.reduce((n, c) => n + c.total, 0)).toBe(12);
  });

  it('關係觀察：單一記者依賴、跨媒體記者、穩定關係、曾經常報導但本月缺席', () => {
    expect(ins.dependence.map(m => m.name)).toContain('A報');
    expect(ins.stableReporters.map(r => r.name)).toEqual(['王一']);
    expect(ins.stableMedia.map(m => m.name)).toEqual(['A報']);
    const multi = buildExposureInsights([
      rec('m1', tw(2026, 8, 1), 'A報', '趙四', 't1'), rec('m2', tw(2026, 8, 2), 'B網', '趙四', 't2'),
    ]);
    expect(multi.crossMediaReporters.map(r => r.name)).toEqual(['趙四']);
    const lapsed = buildExposureInsights([
      rec('l1', tw(2026, 7, 1), 'A報', '孫六', 't1'), rec('l2', tw(2026, 7, 2), 'A報', '孫六', 't2'),
      rec('l3', tw(2026, 7, 3), 'A報', '孫六', 't3'), rec('l4', tw(2026, 8, 3), 'B網', '周七', 't4'),
    ]);
    expect(lapsed.coreLapsed.map(r => r.name)).toEqual(['孫六']);
  });

  it('自動產生的重點發現包含最大媒體、月變化與高峰日', () => {
    const text = ins.highlights.join('\n');
    expect(text).toContain('A報 是最大曝光來源');
    expect(text).toContain('2026-09 共 5 篇');
    expect(text).toContain('曝光高峰是 2026-07-06');
  });
});

describe('buildExposureInsights — 自動監測比對', () => {
  const now = tw(2026, 10, 7);
  const auto = [
    { title: '創見推出新品固態硬碟', link: 'https://other.com/x', pubDate: tw(2026, 9, 3) },   // 標題相同
    { title: 'whatever', link: 'http://www.example.com/c3/?utm_source=rss', pubDate: tw(2026, 9, 10) }, // 網址相同
  ];
  const ins = buildExposureInsights(RECORDS, { autoArticles: auto, now });

  it('只比對自動監測保留的範圍（上個月 1 日之後），用網址或標題判斷是否被抓到', () => {
    const cov = ins.coverage;
    expect(cov.manual).toBe(5);                  // 9 月 5 篇（8 月以前超出範圍）
    expect(cov.matched).toBe(1);                 // 只有 c3 網址相同（a4 在 7 月，不在範圍內）
    expect(cov.rate).toBeCloseTo(1 / 5);
    expect(cov.missed).toHaveLength(4);
    expect(cov.missed[0].date >= cov.missed[1].date).toBe(true);   // 新到舊
  });

  it('沒有傳入自動監測資料時不計算', () => {
    expect(buildExposureInsights(RECORDS, { now }).coverage).toBeNull();
  });
});
