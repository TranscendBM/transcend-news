import { describe, it, expect } from 'vitest';

import {
  EMPTY_FILTERS, PRIVATE_FIELD_NAMES, applyFilters, buildDetailRows, buildPerformance, buildSummaryRows,
  filterOptions, groupByTopic, hasActiveFilters, normalizeTitleKey, sanitizeCell, toPublicRecord,
  sortTopics, titleSimilarity, toPublicRecords, typeLabel,
} from './exposurePerformance.js';

// 台灣時間 y-m-d h:00 的實際時刻
const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);

function raw(id, date, media, reporter, title, extra = {}) {
  return {
    id, exposureDate: date, mediaName: media, reporter, title,
    link: `https://example.com/${id}`, exposureType: 'online', ...extra,
  };
}
const pub = rows => toPublicRecords(rows);

describe('normalizeTitleKey — 保守的標題正規化', () => {
  it('忽略空白（含全形空白、多個空白、換行）、大小寫與全半形', () => {
    const base = normalizeTitleKey('創見推出新品 SSD');
    expect(normalizeTitleKey('創見 推出新品　SSD')).toBe(base);       // 全形空白
    expect(normalizeTitleKey('  創見推出新品    ssd  ')).toBe(base);   // 多餘空白、大小寫
    expect(normalizeTitleKey('創見推出新品\nＳＳＤ')).toBe(base);        // 換行、全形英文
    expect(normalizeTitleKey('Ｔｒａｎｓｃｅｎｄ ８月營收')).toBe(normalizeTitleKey('transcend 8月營收'));
  });

  it('只去掉「首尾」的標點與符號，標題中間的標點保留（不做寬鬆比對）', () => {
    expect(normalizeTitleKey('「創見推出新品」！')).toBe(normalizeTitleKey('創見推出新品'));
    expect(normalizeTitleKey('《半導體》創見營收')).toBe(normalizeTitleKey('半導體》創見營收'));
    expect(normalizeTitleKey('創見:公告庫藏股')).not.toBe(normalizeTitleKey('創見 公告庫藏股'));
  });

  it('不同內容不會被正規化成同一個鍵', () => {
    expect(normalizeTitleKey('創見公告庫藏股')).not.toBe(normalizeTitleKey('創見公告庫藏股買回'));
    expect(normalizeTitleKey('創見7月營收')).not.toBe(normalizeTitleKey('創見8月營收'));
    expect(normalizeTitleKey('')).toBe('');
    expect(normalizeTitleKey(null)).toBe('');
  });
});

describe('toPublicRecord — 公開欄位白名單與隱私', () => {
  const dirty = {
    ...raw('p1', tw(2026, 9, 1), '經濟日報', '王一', '創見新品'),
    // media_exposure_private 的欄位，就算意外混進來也不能帶出去
    noteInternal: '內部備註：絕對不可外流', sources: [{ file: 'Media exposure_09.xlsx', sheet: '09', row: 7 }],
    rawMediaName: '經濟日報記者', rawLink: 'https://raw.example.com/x', file: 'secret.xlsx', sheet: '09', row: 7,
  };

  it('只保留白名單欄位，沒有任何私人欄位', () => {
    const r = toPublicRecord(dirty);
    expect(Object.keys(r).sort()).toEqual(
      ['campaignId', 'campaignName', 'coverageClass', 'coverageConfidence', 'coverageMethod', 'date', 'day', 'exposureId', 'id', 'link', 'matchConfidence', 'matchMethod', 'matchReason', 'matchStatus', 'mediaName', 'reporter', 'suggestedId', 'suggestedName', 'title', 'type'].sort());
    PRIVATE_FIELD_NAMES.forEach(f => expect(r, f).not.toHaveProperty(f));
    const serialized = JSON.stringify(r);
    ['內部備註', 'secret.xlsx', 'Media exposure_09', 'raw.example.com', '經濟日報記者'].forEach(s => expect(serialized).not.toContain(s));
  });

  it('日期用台灣日曆日；Firestore Timestamp 也能處理；日期無效的紀錄被略過', () => {
    expect(toPublicRecord(raw('d1', tw(2026, 9, 30, 23), 'A', '', 't')).day).toBe('2026-09-30');
    expect(toPublicRecord(raw('d2', { toDate: () => tw(2026, 7, 1, 0) }, 'A', '', 't')).day).toBe('2026-07-01');
    expect(toPublicRecord(raw('d3', 'not a date', 'A', '', 't'))).toBeNull();
    expect(toPublicRecord(null)).toBeNull();
    expect(pub([raw('d4', 'bad', 'A', '', 't'), raw('d5', tw(2026, 9, 1), 'A', '', 't')])).toHaveLength(1);
  });

  it('不安全網址變成空字串，安全網址保留；缺媒體名稱顯示「未知媒體」', () => {
    expect(toPublicRecord({ ...dirty, link: 'javascript:alert(1)' }).link).toBe('');
    expect(toPublicRecord({ ...dirty, link: 'https://user:pw@example.com/' }).link).toBe('');
    expect(toPublicRecord(dirty).link).toBe('https://example.com/p1');
    expect(toPublicRecord({ ...dirty, mediaName: '  ' }).mediaName).toBe('未知媒體');
  });
});

describe('groupByTopic — 分組規則', () => {
  const group = rows => groupByTopic(pub(rows));

  it('標題只差空白、大小寫、全半形、首尾標點的曝光合成同一個主題（依標題相同）', () => {
    const topics = group([
      raw('1', tw(2026, 9, 1), '經濟日報', '', 'Transcend 推出新品 SSD'),
      raw('2', tw(2026, 9, 9), '鉅亨網', '', 'TRANSCEND　推出新品　ｓｓｄ！'),   // 日期差很多也合併：標題完全相同
      raw('3', tw(2026, 9, 20), '非凡新聞', '', ' transcend推出新品ssd '),
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ total: 3, mediaCount: 3, basis: 'title', basisLabel: '標題相同' });
  });

  it('使用者提供的「同一篇轉發」標題全部歸成同一個主題：2026年9月營收公告（依事件規則）', () => {
    const titles = [
      ['非凡新聞', '威剛9月營收年增2倍、Q3首破500億！創見前9月增370%創高'],
      ['壹蘋新聞網', '記憶體需求續旺！創見9月營收60.4億年月雙增 Q3營收大增291% 將參展智慧能源週 DDR5、企業級SSD搶AI商機'],
      ['MoneyDJ理財網', '創見 115年9月營收60.35億、年增290.42%'],
      ['鉅亨網', '創見9月營收60.35億元年增290.42% 1—9月達485.11億元'],
      ['聯合報', '創見9月營收60.4億元、年增290% 深化AI與工業應用布局'],
      ['電子時報', '創見9月營收回溫月增24.8% IPC、網通客戶專案出貨挹注'],
      ['鏡報新聞網', '創見9月營收達60.4億元年增290% AI伺服器記憶體、SSD需求同步升溫'],
      ['MoneyDJ理財網', '創見9月營收轉雙增/Q3寫次高；續拓AI應用'],
      ['科技新報', '創見資訊 9 月營收年增 290%，前 9 個月營收年增達到 370%'],
      ['鉅亨網', '創見Q3營收160.7億元創次高 深化AI及工控應用'],
    ];
    const topics = group(titles.map(([media, title], i) => raw('u' + i, tw(2026, 10, 6, 9 + (i % 8)), media, '', title)));
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      total: 10, basis: 'event', eventKind: 'revenue', name: '2026年9月營收公告', basisLabel: '事件規則',
    });
    expect(topics[0].mediaCount).toBe(8);   // MoneyDJ、鉅亨網各出現兩次，算一家
  });

  it('同一天不同月份／不同類型的事件不會混在一起（月營收、季財報、其他新聞分開）', () => {
    const topics = group([
      raw('1', tw(2026, 9, 2), 'A', '', '創見7月營收年增3倍'),
      raw('2', tw(2026, 9, 2), 'B', '', '創見8月營收年增2倍'),
      raw('3', tw(2026, 9, 2), 'C', '', '創見第2季EPS 27.7元創高'),
      raw('4', tw(2026, 9, 2), 'D', '', '創見獲選台灣企業100強'),
    ]);
    expect(topics).toHaveLength(4);
    expect(topics.every(t => t.total === 1 && t.basis === 'single')).toBe(true);
  });

  it('相似標題：發布日相差 1 天內、標題相似度夠高才合併（依標題相似）', () => {
    const topics = group([
      raw('1', tw(2026, 9, 23), '經濟日報', '', '創見擴充嵌入式鏡頭模組陣容 攜研華加速 Edge AI 視覺應用'),
      raw('2', tw(2026, 9, 23), '工商時報', '', '創見推AI嵌入式鏡頭模組 攜研華搶攻Edge AI商機'),
      raw('3', tw(2026, 9, 24), '自由時報', '', '創見推兩款嵌入式鏡頭模組 攜手研華搶攻AI視覺辨識商機'),
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ total: 3, basis: 'similar', basisLabel: '標題相似' });
  });

  it('相似標題但相隔超過 1 天，不合併（避免把不同次的新聞串起來）', () => {
    const topics = group([
      raw('1', tw(2026, 9, 1), 'A', '', '創見推出64GB DDR5工業用記憶體 提升高速運算效能'),
      raw('2', tw(2026, 9, 5), 'B', '', '創見推出64GB DDR5工業用記憶體 提升高速運算效能與穩定性'),
    ]);
    expect(topics).toHaveLength(2);
  });

  it('不同新聞稿不會被錯誤合併：同一天但內容不同的新聞各自獨立', () => {
    const topics = group([
      raw('1', tw(2026, 9, 10), 'A', '', '創見公告庫藏股買回'),
      raw('2', tw(2026, 9, 10), 'B', '', '創見推出新一代 SSD 搶攻 AI 伺服器'),
      raw('3', tw(2026, 9, 10), 'C', '', '創見董事長談記憶體缺貨將延續到明年'),
      raw('4', tw(2026, 9, 10), 'D', '', '創見榮獲 COMPUTEX 永續設計獎'),
    ]);
    expect(topics).toHaveLength(4);
    topics.forEach(t => expect(t.basis).toBe('single'));
  });

  it('標題沒有營收／財報字眼、也沒有期間的新聞，不會被事件規則亂歸類', () => {
    const topics = group([
      raw('1', tw(2026, 6, 3), 'A', '', '黃仁勳發表N1X、AI PC來臨！創見：記憶體再大爆發、營收貢獻可觀'),
      raw('2', tw(2026, 6, 3), 'B', '', '創見5月營收創歷史次高'),
    ]);
    expect(topics).toHaveLength(2);
    expect(topics.find(t => t.total === 1).basis).toBe('single');
  });

  it('有 campaignId／pressReleaseId 時優先用它（標題與日期不同也合併），且不跟其他規則混；沒有編號的才走規則', () => {
    const topics = group([
      raw('1', tw(2026, 9, 1), 'A', '', '標題甲', { campaignId: 'PR-001', campaignName: '九月新品發表' }),
      raw('2', tw(2026, 9, 20), 'B', '', '完全不同的標題乙', { pressReleaseId: 'PR-001' }),
      raw('3', tw(2026, 9, 3), 'C', '', '標題甲'),                          // 沒有編號：不會被拉進 PR-001
      raw('4', tw(2026, 9, 4), 'D', '', '創見9月營收創高', { campaignId: 'PR-002' }),   // 有編號：不再套用事件規則
      raw('5', tw(2026, 10, 6), 'E', '', '創見9月營收創高'),
    ]);
    const byId = topics.filter(t => t.basis === 'id');
    expect(byId).toHaveLength(2);
    const pr1 = byId.find(t => t.name === '九月新品發表');
    expect(pr1.total).toBe(2);
    expect(byId.find(t => t.total === 1).items[0].id).toBe('4');
    expect(topics.find(t => t.items.some(r => r.id === '5')).basis).toBe('single');
    expect(topics.find(t => t.items.some(r => r.id === '3')).total).toBe(1);
  });

  it('沒有標題的紀錄各自獨立，不會全部被塞進同一個主題', () => {
    const topics = group([
      raw('1', tw(2026, 9, 1), 'A', '', ''), raw('2', tw(2026, 9, 1), 'B', '', '   '),
    ]);
    expect(topics).toHaveLength(2);
    expect(topics[0].name).toBe('（無標題）');
  });

  it('每組的統計：曝光數、不重複媒體數、首次／最近日期、類型分布、主要媒體、明細新到舊', () => {
    const [t] = group([
      raw('1', tw(2026, 9, 3), 'A報', '', '同一則', { exposureType: 'online' }),
      raw('2', tw(2026, 9, 1), 'B網', '', '同一則', { exposureType: 'video' }),
      raw('3', tw(2026, 9, 5), 'A報', '', '同一則', { exposureType: 'online' }),
      raw('4', tw(2026, 9, 2), 'C台', '', '同一則', { exposureType: 'social' }),
    ]);
    expect(t.total).toBe(4);
    expect(t.mediaCount).toBe(3);
    expect(t.firstDate).toEqual(tw(2026, 9, 1));
    expect(t.lastDate).toEqual(tw(2026, 9, 5));
    expect(t.typeCounts[0]).toMatchObject({ label: '網路新聞', count: 2 });
    expect(t.typeCounts.reduce((n, c) => n + c.count, 0)).toBe(4);
    expect(t.topMedia[0]).toMatchObject({ label: 'A報', count: 2 });
    expect(t.items.map(r => r.id)).toEqual(['3', '1', '4', '2']);
  });

  it('主題名稱：事件組用事件名稱；其他組取出現最多次的原始標題；依曝光數、再依最近日期排序', () => {
    const topics = group([
      raw('1', tw(2026, 9, 1), 'A', '', '甲 標題'), raw('2', tw(2026, 9, 2), 'B', '', '甲標題'),
      raw('3', tw(2026, 9, 3), 'C', '', '甲標題'),
      raw('4', tw(2026, 9, 9), 'D', '', '乙標題'),
      raw('5', tw(2026, 9, 5), 'E', '', '丙標題'),
    ]);
    expect(topics[0].name).toBe('甲標題');
    expect(topics.map(t => t.total)).toEqual([3, 1, 1]);
    expect(topics.slice(1).map(t => t.name)).toEqual(['乙標題', '丙標題']);
  });

  it('標題相似度：相同標題為 1、完全不同接近 0、空白標題為 0', () => {
    expect(titleSimilarity('創見推出新品', '創見推出新品')).toBe(1);
    expect(titleSimilarity('創見推出新品', '今天天氣很好')).toBeLessThan(0.1);
    expect(titleSimilarity('', '創見')).toBe(0);
  });
});

describe('buildPerformance — 摘要、類型分布、媒體排行', () => {
  const records = pub([
    raw('1', tw(2026, 9, 1), '經濟日報', '', '主題一', { exposureType: 'online' }),
    raw('2', tw(2026, 9, 2), '經濟日報', '', '主題一', { exposureType: 'online' }),
    raw('3', tw(2026, 9, 3), '鉅亨網', '', '主題一', { exposureType: 'video' }),
    raw('4', tw(2026, 9, 8), '鉅亨網', '', '主題二', { exposureType: 'social' }),
    raw('5', tw(2026, 9, 9), '非凡新聞', '', '主題二', { exposureType: 'other-kind' }),
  ]);
  const perf = buildPerformance(records);

  it('曝光總數、不重複媒體數、主題數、首次與最近曝光日期', () => {
    expect(perf.total).toBe(5);
    expect(perf.mediaCount).toBe(3);
    expect(perf.topicCount).toBe(2);
    expect(perf.firstDate).toEqual(tw(2026, 9, 1));
    expect(perf.latestDate).toEqual(tw(2026, 9, 9));
  });

  it('類型分布：網路新聞／影音／社群，不認得的類型歸「其他」，份額加總為 1', () => {
    expect(perf.typeCounts.map(c => [c.label, c.count])).toEqual(
      [['其他', 1], ['影音', 1], ['社群', 1], ['網路新聞', 2]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant')));
    expect(perf.typeCounts.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1);
    expect(typeLabel('video')).toBe('影音');
    expect(typeLabel('whatever')).toBe('其他');
  });

  it('媒體排行：依曝光數由高到低，帶份額', () => {
    expect(perf.mediaRanking.map(m => [m.label, m.count])).toEqual([['經濟日報', 2], ['鉅亨網', 2], ['非凡新聞', 1]]);
    expect(perf.mediaRanking[0].share).toBeCloseTo(0.4);
  });

  it('沒有資料時不會丟錯', () => {
    const empty = buildPerformance([]);
    expect(empty).toMatchObject({ total: 0, mediaCount: 0, topicCount: 0, firstDate: null, latestDate: null, topics: [] });
  });
});

describe('applyFilters — 搜尋、媒體、類型、日期範圍', () => {
  const records = pub([
    raw('1', tw(2026, 7, 5), '經濟日報', '王一', '創見營收創新高', { exposureType: 'online' }),
    raw('2', tw(2026, 8, 5), '鉅亨網', '李二', 'Transcend 新品 SSD', { exposureType: 'online' }),
    raw('3', tw(2026, 9, 5), '鉅亨網', '', '創見法說會影片', { exposureType: 'video' }),
    raw('4', tw(2026, 9, 30, 23), '非凡新聞', '張三', '創見九月底消息', { exposureType: 'social' }),
  ]);
  const ids = f => applyFilters(records, { ...EMPTY_FILTERS, ...f }).map(r => r.id);

  it('沒有條件時全部通過', () => {
    expect(ids({})).toEqual(['1', '2', '3', '4']);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, query: ' ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, media: '鉅亨網' })).toBe(true);
  });

  it('關鍵字搜尋標題、媒體、記者；不分大小寫與全半形', () => {
    expect(ids({ query: '營收' })).toEqual(['1']);
    expect(ids({ query: 'transcend ssd' })).toEqual([]);          // 不做斷詞，整串要連續出現
    expect(ids({ query: 'ＳＳＤ' })).toEqual(['2']);
    expect(ids({ query: '鉅亨' })).toEqual(['2', '3']);            // 媒體名稱
    expect(ids({ query: '張三' })).toEqual(['4']);                 // 記者
  });

  it('媒體與類型篩選', () => {
    expect(ids({ media: '鉅亨網' })).toEqual(['2', '3']);
    expect(ids({ type: 'video' })).toEqual(['3']);
    expect(ids({ media: '鉅亨網', type: 'online' })).toEqual(['2']);
  });

  it('日期範圍用台灣日曆日、含起訖當天；起日晚於迄日時自動對調', () => {
    expect(ids({ from: '2026-08-05' })).toEqual(['2', '3', '4']);
    expect(ids({ to: '2026-08-05' })).toEqual(['1', '2']);
    expect(ids({ from: '2026-08-01', to: '2026-09-05' })).toEqual(['2', '3']);
    expect(ids({ from: '2026-09-30', to: '2026-09-30' })).toEqual(['4']);   // 台灣 23:00 仍是 9/30
    expect(ids({ from: '2026-09-05', to: '2026-08-01' })).toEqual(['2', '3']);
  });

  it('條件同時成立才通過', () => {
    expect(ids({ query: '創見', type: 'video', from: '2026-09-01' })).toEqual(['3']);
    expect(ids({ query: '創見', type: 'video', from: '2026-10-01' })).toEqual([]);
  });

  it('篩選選項：依全部資料產生媒體與類型清單', () => {
    expect(filterOptions(records)).toEqual({ media: ['非凡新聞', '經濟日報', '鉅亨網'].sort((a, b) => a.localeCompare(b, 'zh-Hant')), types: ['online', 'social', 'video'] });
  });
});

describe('Excel 資料列與公式注入防護', () => {
  it('sanitizeCell：以 = + - @ 開頭（含前置空白或控制字元）的文字前面補單引號；其他原樣', () => {
    ['=SUM(A1:A9)', '+1+1', '-2+3', '@SUM(1)', ' =cmd|calc', '\t=1+1', '\r=1+1'].forEach(v =>
      expect(sanitizeCell(v), JSON.stringify(v)).toBe(`'${v}`));
    ['創見新品', 'a=b', '2026-09-01', '', '1+1=2'].forEach(v => expect(sanitizeCell(v)).toBe(v));
    expect(sanitizeCell(5)).toBe(5);
    expect(sanitizeCell(null)).toBe(null);
  });

  const topics = groupByTopic(pub([
    raw('1', tw(2026, 9, 1), '=HYPERLINK("http://evil")', '+王一', '=cmd|calc 的標題', { link: 'https://example.com/ok' }),
    raw('2', tw(2026, 9, 2), '鉅亨網', '@李二', '正常標題', { link: 'javascript:alert(1)', noteInternal: '內部備註' }),
  ]));

  it('明細列只含白名單欄位，且文字欄位都已防公式注入', () => {
    const rows = buildDetailRows(topics);
    expect(rows).toHaveLength(2);
    rows.forEach(r => expect(Object.keys(r)).toEqual(['新聞稿／主題', '配對依據', '配對狀態', '配對信心', '配對理由', '曝光分類', '分類方法', '信心程度', '日期', '媒體', '記者', '新聞標題', '曝光類型', '連結']));
    const all = JSON.stringify(rows);
    ['內部備註', 'noteInternal', 'javascript:'].forEach(s => expect(all).not.toContain(s));
    rows.forEach(r => Object.values(r).forEach(v => expect(typeof v === 'string' && /^[=+\-@]/.test(v), String(v)).toBe(false)));
    const evil = rows.find(r => r.新聞標題.includes('cmd|calc'));
    expect(evil.媒體).toBe(`'=HYPERLINK("http://evil")`);
    expect(evil.記者).toBe("'+王一");
    expect(evil['新聞稿／主題']).toBe("'=cmd|calc 的標題");
  });

  it('不安全網址在匯出裡是空白，不會把 javascript: 寫進試算表', () => {
    const rows = buildDetailRows(topics);
    expect(rows.find(r => r.媒體 === '鉅亨網').連結).toBe('');
    expect(rows.find(r => r.連結).連結).toBe('https://example.com/ok');
  });

  it('主題彙整列：曝光數、不重複媒體數、首次／最近日期、主要媒體、類型分布', () => {
    const rows = buildSummaryRows(groupByTopic(pub([
      raw('1', tw(2026, 9, 1), 'A報', '', '同一則', { exposureType: 'online' }),
      raw('2', tw(2026, 9, 3), 'B網', '', '同一則', { exposureType: 'video' }),
      raw('3', tw(2026, 9, 2), 'A報', '', '同一則', { exposureType: 'online' }),
    ])));
    expect(rows).toEqual([{
      '新聞稿／主題': '同一則', 配對依據: '標題推定', 配對信心: '', 配對理由: '', 分組依據: '標題相同', 曝光總數: 3, 不重複媒體數: 2, 首次曝光: '2026-09-01', 最近曝光: '2026-09-03',
      主要媒體: 'A報（2）、B網（1）', 類型分布: '網路新聞 2、影音 1',
    }]);
  });
});

describe('sortTopics — 主題清單排序', () => {
  // 甲：3 則、最近 9/1；乙：1 則、最近 9/20；丙：2 則、最近 9/10；丁：1 則、最近 9/20（跟乙同一天）
  const topics = groupByTopic(pub([
    raw('a1', tw(2026, 8, 30), 'A', '', '甲甲甲 新品發表'), raw('a2', tw(2026, 8, 31), 'B', '', '甲甲甲 新品發表'), raw('a3', tw(2026, 9, 1), 'C', '', '甲甲甲 新品發表'),
    raw('b1', tw(2026, 9, 20, 10), 'D', '', '乙乙乙 獲獎'),
    raw('c1', tw(2026, 9, 9), 'E', '', '丙丙丙 展覽'), raw('c2', tw(2026, 9, 10), 'F', '', '丙丙丙 展覽'),
    raw('d1', tw(2026, 9, 20, 10), 'G', '', '丁丁丁 公告'),
  ]));
  const names = list => list.map(t => t.name.slice(0, 3));

  it('recent：依最近曝光時間由近到遠；同一時間再依曝光數、名稱', () => {
    const sorted = sortTopics(topics, 'recent');
    expect(sorted.map(t => t.lastDate.getTime())).toEqual([...sorted.map(t => t.lastDate.getTime())].sort((a, b) => b - a));
    expect(names(sorted).slice(2)).toEqual(['丙丙丙', '甲甲甲']);          // 9/10 比 9/1 近
    expect(new Set(names(sorted).slice(0, 2))).toEqual(new Set(['乙乙乙', '丁丁丁']));   // 9/20 同一天排前面
  });

  it('count：依曝光數由多到少，同數量再依最近時間', () => {
    expect(names(sortTopics(topics, 'count')).slice(0, 2)).toEqual(['甲甲甲', '丙丙丙']);
    expect(sortTopics(topics, 'count').map(t => t.total)).toEqual([3, 2, 1, 1]);
  });

  it('預設是 recent；不改動傳入的陣列', () => {
    const before = topics.map(t => t.key);
    expect(sortTopics(topics).map(t => t.key)).toEqual(sortTopics(topics, 'recent').map(t => t.key));
    expect(topics.map(t => t.key)).toEqual(before);
    expect(sortTopics([], 'recent')).toEqual([]);
  });
});

describe('groupByTopic — 展覽參展事件', () => {
  const group = rows => groupByTopic(pub(rows));

  it('使用者提供的兩篇「能源週」參展新聞歸成同一個主題（依事件規則：展覽參展）', () => {
    const topics = group([
      raw('e1', tw(2026, 10, 6), 'MoneyDJ理財網', '', '創見參展能源週，展示三大產品線'),
      raw('e2', tw(2026, 10, 6), '工商時報', '', '創見參展智慧能源週 聚焦AI視覺、高效運算'),
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      total: 2, basis: 'event', eventKind: 'expo', name: '2026年10月 智慧能源週 參展', mediaCount: 2,
    });
  });

  it('同一天不同的展、或同一個展不同月份，不會混在一起；營收新聞不會被拉進展覽組', () => {
    const topics = group([
      raw('1', tw(2026, 5, 19), 'A', '', '創見參展COMPUTEX 2026 秀AI嵌入式'),
      raw('2', tw(2026, 5, 19), 'B', '', '創見前進COMPUTEX 展示工用和消費產品'),
      raw('3', tw(2026, 6, 2), 'C', '', '創見資訊榮獲COMPUTEX 2026永續設計獎金獎'),
      raw('4', tw(2026, 5, 19), 'D', '', '創見參展智慧製造展 聚焦智慧影像'),
      raw('5', tw(2026, 10, 6), 'E', '', '創見9月營收60.4億 將參展智慧能源週'),
    ]);
    expect(topics).toHaveLength(4);
    const computexMay = topics.find(t => t.name.includes('2026年5月 COMPUTEX'));
    expect(computexMay.total).toBe(2);
    expect(topics.find(t => t.items.some(r => r.id === '5')).eventKind).toBeNull();   // 單篇營收，沒有成組
  });
});
