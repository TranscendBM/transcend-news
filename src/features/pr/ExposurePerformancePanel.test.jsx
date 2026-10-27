import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const exportExposurePerformanceExcel = vi.fn();
vi.mock('../../utils/formatting.js', () => ({
  exportExposurePerformanceExcel: (...args) => exportExposurePerformanceExcel(...args),
}));

import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';

const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);
function raw(id, date, media, reporter, title, extra = {}) {
  return {
    id, exposureDate: date, mediaName: media, reporter, title,
    link: `https://example.com/${id}`, exposureType: 'online',
    // 私人欄位：就算資料物件意外帶著，也不能出現在畫面或匯出
    noteInternal: '內部備註不可外流', sources: [{ file: 'secret.xlsx', sheet: '09', row: 7 }],
    rawLink: 'https://raw.example.com/leak', rawMediaName: '原始媒體名稱', file: 'secret.xlsx', sheet: '09', row: 7,
    ...extra,
  };
}

// 4 個主題：SSD 新品（3 則、3 家媒體）、庫藏股、庫藏股買回、Transcend revenue
const RECORDS = [
  raw('1', tw(2026, 9, 1), '經濟日報', '王一', '創見推出新品 SSD'),
  raw('2', tw(2026, 9, 2), '鉅亨網', '', '創見推出新品　ssd！'),
  raw('3', tw(2026, 9, 3), '非凡新聞', '張三', '創見推出新品SSD', { exposureType: 'video' }),
  raw('4', tw(2026, 9, 10), '經濟日報', '王一', '創見公告庫藏股'),
  raw('5', tw(2026, 9, 15), '鉅亨網', '李二', '創見公告庫藏股買回', { exposureType: 'social' }),
  raw('6', tw(2026, 9, 20), 'MoneyDJ理財網', '', 'Transcend August revenue', { link: 'javascript:alert(1)' }),
];

function renderPanel(props = {}) {
  return render(<ExposurePerformancePanel records={RECORDS} status="ready" onRetry={vi.fn()} {...props} />);
}
const kpi = label => screen.getByText(label, { selector: 'p' }).nextElementSibling.textContent;
const topicButtons = () => screen.getAllByRole('button', { expanded: false });
const select = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const expandAll = () => topicButtons().forEach(b => fireEvent.click(b));
const lastExportArgs = () => exportExposurePerformanceExcel.mock.calls.at(-1)[0];

beforeEach(() => { exportExposurePerformanceExcel.mockClear(); });

describe('ExposurePerformancePanel — 顯示狀態', () => {
  it('載入中：第一次還沒有資料時顯示載入中，不顯示統計', () => {
    renderPanel({ records: [], status: 'loading' });
    expect(screen.getByText('載入中…')).toBeTruthy();
    expect(screen.queryByText('涵蓋媒體')).toBeNull();
    expect(screen.queryByLabelText('曝光媒體篩選')).toBeNull();
  });

  it('查詢失敗：顯示錯誤訊息與重試按鈕，按重試會呼叫 onRetry；統計不會顯示成 0', () => {
    const onRetry = vi.fn();
    renderPanel({ records: [], status: 'error', onRetry });
    expect(screen.getByRole('alert').textContent).toContain('新聞稿曝光成效載入失敗');
    expect(screen.queryByText('尚未匯入人工彙整曝光資料')).toBeNull();
    fireEvent.click(screen.getByText('重試'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('尚未匯入資料（ready 或 idle）：顯示空狀態，不崩潰，匯出按鈕停用', () => {
    const { unmount } = renderPanel({ records: [] });
    expect(screen.getByText('尚未匯入人工彙整曝光資料')).toBeTruthy();
    expect(screen.getByText('匯出新聞稿成效').closest('button').disabled).toBe(true);
    unmount();
    renderPanel({ records: [], status: 'idle' });
    expect(screen.getByText('尚未匯入人工彙整曝光資料')).toBeTruthy();
    renderPanel({ records: undefined });   // 預設值也不會崩潰
  });

  it('標示分組依據（編號、事件規則、標題相同、相似標題）與「推定」，並說明統計依目前已載入資料', () => {
    renderPanel();
    expect(screen.getByText(/依「新聞稿／主題」彙整/)).toBeTruthy();
    expect(screen.getByText(/事件規則——同一期的月營收公告、同一季的財報／獲利/)).toBeTruthy();
    expect(screen.getByText(/這是推定而非正式新聞稿編號/)).toBeTruthy();
    expect(screen.getByText(/統計依目前已載入的 6 筆人工彙整曝光/)).toBeTruthy();
    expect(screen.queryByText(/已達讀取上限/)).toBeNull();
  });

  it('資料筆數達到讀取上限時，誠實提示更早的資料未納入統計', () => {
    renderPanel({ maxRecords: 6 });
    expect(screen.getByText(/已達讀取上限 6 筆，更早的資料未納入統計/)).toBeTruthy();
  });
});

describe('ExposurePerformancePanel — 整體摘要', () => {
  it('曝光總數、涵蓋媒體、新聞稿／主題數、最近曝光日期', () => {
    renderPanel();
    expect(kpi('人工彙整曝光')).toContain('6');
    expect(kpi('涵蓋媒體')).toContain('4');
    expect(kpi('新聞稿／主題')).toContain('4');
    expect(kpi('最近曝光')).toContain('2026/9/20');
    expect(screen.getByText('最近曝光', { selector: 'p' }).nextElementSibling.nextElementSibling.textContent).toBe('首次 2026/9/1');
  });

  it('曝光類型分布與媒體排行', () => {
    renderPanel();
    const panel = screen.getByText('新聞稿曝光成效').closest('[data-card]');
    expect(within(panel).getByText(/網路新聞 4（67%）/)).toBeTruthy();
    expect(within(panel).getByText(/影音 1（17%）/)).toBeTruthy();
    expect(within(panel).getByText(/社群 1（17%）/)).toBeTruthy();
    const ranking = screen.getByText('曝光量最高的媒體').nextElementSibling;
    const counts = [...ranking.querySelectorAll('li')].map(li => Number(li.lastElementChild.textContent));
    expect(counts).toEqual([2, 2, 1, 1]);
    expect(ranking.textContent).toContain('經濟日報');
    expect(ranking.textContent).toContain('鉅亨網');
  });
});

describe('ExposurePerformancePanel — 新聞稿／主題與明細', () => {
  it('依標題彙整：只差空白／大小寫／全半形／標點的合成一個主題，不同新聞稿分開', () => {
    renderPanel();
    expect(topicButtons()).toHaveLength(4);
    const ssd = topicButtons().find(b => b.textContent.includes('創見推出新品'));
    expect(ssd.textContent).toContain('3 家媒體');
    expect(ssd.textContent).toContain('首次 2026/9/1');
    expect(ssd.textContent).toContain('最近 2026/9/3');
    expect(ssd.textContent).toContain('網路新聞 2');
    expect(ssd.textContent).toContain('影音 1');
    expect(ssd.textContent).toContain('經濟日報 1');                       // 主要媒體
    expect(within(ssd).getByText('3').nextElementSibling.textContent).toBe('則曝光');
    // 庫藏股 vs 庫藏股買回：不合併
    expect(topicButtons().filter(b => b.textContent.includes('庫藏股'))).toHaveLength(2);
  });

  it('展開顯示完整曝光明細（公開欄位），再按一次收合', () => {
    renderPanel();
    const ssd = topicButtons().find(b => b.textContent.includes('創見推出新品'));
    fireEvent.click(ssd);
    expect(ssd.getAttribute('aria-expanded')).toBe('true');
    const detail = document.getElementById(ssd.getAttribute('aria-controls'));
    const rows = [...detail.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
    expect(rows).toEqual([                                                 // 新到舊
      ['2026-09-03', '非凡新聞', '張三', '創見推出新品SSD', '—', '影音'],
      ['2026-09-02', '鉅亨網', '—', '創見推出新品 ssd！', '—', '網路新聞'],
      ['2026-09-01', '經濟日報', '王一', '創見推出新品 SSD', '—', '網路新聞'],
    ]);
    expect(within(detail).getByText('創見推出新品SSD').closest('a').getAttribute('href')).toBe('https://example.com/3');

    fireEvent.click(ssd);
    expect(ssd.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(ssd.getAttribute('aria-controls'))).toBeNull();
  });

  it('主題很多時先顯示一批，按「顯示更多」再展開', () => {
    // 每個標題用不同的字，彼此不會被「相似標題」規則合併
    const many = Array.from({ length: 20 }, (_, i) => raw(`m${i}`, tw(2026, 9, 1 + i), 'A報', '',
      [0, 1, 2, 3].map(k => String.fromCharCode(0x4e00 + i * 37 + k * 11)).join('')));
    renderPanel({ records: many });
    expect(topicButtons()).toHaveLength(15);
    fireEvent.click(screen.getByText(/顯示更多（再 5 則）/));
    expect(topicButtons()).toHaveLength(20);
  });
});

describe('ExposurePerformancePanel — 篩選（所有數字共用同一份篩選結果）', () => {
  // 檢查畫面上每個區塊的數字都來自同一份篩選結果
  function expectConsistent(total, media, topics) {
    expect(kpi('人工彙整曝光')).toContain(String(total));
    expect(kpi('涵蓋媒體')).toContain(String(media));
    expect(kpi('新聞稿／主題')).toContain(String(topics));
    expect(screen.getByText(`符合 ${total} / 共 6 筆`)).toBeTruthy();
    const ranking = screen.getByText('曝光量最高的媒體').nextElementSibling;
    const rankSum = [...ranking.querySelectorAll('li')].reduce((n, li) => n + Number(li.lastElementChild.textContent), 0);
    expect(rankSum).toBe(total);
    expect(topicButtons()).toHaveLength(topics);
    const topicSum = topicButtons().reduce((n, b) => n + Number(within(b).getByText('則曝光').previousElementSibling.textContent), 0);
    expect(topicSum).toBe(total);
    expandAll();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(total);
    fireEvent.click(screen.getByText(/^匯出新聞稿成效/));
    expect(lastExportArgs().detailRows).toHaveLength(total);
    expect(lastExportArgs().summaryRows).toHaveLength(topics);
      }

  it('媒體篩選：統計卡、類型分布、媒體排行、主題、明細與匯出同步', () => {
    renderPanel();
    select('曝光媒體篩選', '鉅亨網');
    expectConsistent(2, 1, 2);
    const ranking = screen.getByText('曝光量最高的媒體').nextElementSibling;
    expect(ranking.querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByText(/社群 1（50%）/)).toBeTruthy();
  });

  it('類型篩選', () => {
    renderPanel();
    select('曝光類型篩選', 'video');
    expectConsistent(1, 1, 1);
  });

  it('關鍵字搜尋（標題、媒體、記者；不分大小寫與全半形）', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('搜尋曝光（標題、媒體、記者）'), { target: { value: 'ＳＳＤ' } });
    expectConsistent(3, 3, 1);
  });

  it('日期範圍（含起訖當天）', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('曝光起始日'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText('曝光結束日'), { target: { value: '2026-09-15' } });
    expectConsistent(2, 2, 2);
  });

  it('多個條件同時成立；清除篩選回到全部資料', () => {
    renderPanel();
    expect(screen.queryByText('清除篩選')).toBeNull();
    select('曝光媒體篩選', '經濟日報');
    fireEvent.change(screen.getByLabelText('搜尋曝光（標題、媒體、記者）'), { target: { value: '庫藏股' } });
    expect(kpi('人工彙整曝光')).toContain('1');
    expect(screen.getByText('匯出新聞稿成效（目前篩選）')).toBeTruthy();
    fireEvent.click(screen.getByText('清除篩選'));
    expect(kpi('人工彙整曝光')).toContain('6');
    expect(screen.getByLabelText('曝光媒體篩選').value).toBe('all');
    expect(screen.getByLabelText('搜尋曝光（標題、媒體、記者）').value).toBe('');
    expect(screen.queryByText('清除篩選')).toBeNull();
  });

  it('篩選後沒有結果：顯示說明與清除篩選，不崩潰，匯出停用', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('搜尋曝光（標題、媒體、記者）'), { target: { value: '完全找不到的字串' } });
    expect(screen.getByText(/沒有符合篩選條件的曝光/)).toBeTruthy();
    expect(screen.queryByText('涵蓋媒體')).toBeNull();
    expect(screen.getByText(/^匯出新聞稿成效/).closest('button').disabled).toBe(true);
    fireEvent.click(screen.getAllByText('清除篩選')[0]);
    expect(kpi('人工彙整曝光')).toContain('6');
  });
});

describe('ExposurePerformancePanel — Excel 匯出', () => {
  it('沒有選主題：匯出目前全部篩選結果（主題彙整＋曝光明細）', () => {
    renderPanel();
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    expect(exportExposurePerformanceExcel).toHaveBeenCalledTimes(1);
    const { summaryRows, detailRows } = lastExportArgs();
    expect(summaryRows).toHaveLength(4);
    expect(detailRows).toHaveLength(6);
  });

  it('選定某個主題：只匯出該主題的曝光明細，檔名帶主題名稱', () => {
    renderPanel();
    const ssd = topicButtons().find(b => b.textContent.includes('創見推出新品'));
    fireEvent.click(ssd);
    fireEvent.click(screen.getByText('匯出此主題'));
    const args = lastExportArgs();
    expect(args.summaryRows).toBeUndefined();
    expect(args.detailRows).toHaveLength(3);
    expect(args.detailRows.every(r => r['新聞稿／主題'].includes('創見推出新品'))).toBe(true);
    expect(args.suffix).toContain('創見推出新品');
  });

  it('匯出資料只有白名單欄位：沒有內部備註、來源檔名、工作表、列號', () => {
    renderPanel();
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    const { summaryRows, detailRows } = lastExportArgs();
    detailRows.forEach(r => expect(Object.keys(r)).toEqual(
      ['新聞稿／主題', '配對依據', '配對狀態', '配對信心', '配對理由', '曝光分類', '分類方法', '信心程度', '日期', '媒體', '記者', '新聞標題', '曝光類型', '連結']));
    const all = JSON.stringify({ summaryRows, detailRows });
    ['內部備註', 'secret.xlsx', 'raw.example.com', '原始媒體名稱', 'noteInternal', 'sources', 'rawLink'].forEach(s =>
      expect(all, s).not.toContain(s));
  });

  it('匯出的文字欄位已做公式注入防護；不安全網址不會寫進匯出', () => {
    renderPanel({ records: [
      raw('x1', tw(2026, 9, 1), '=HYPERLINK("http://evil")', '+王一', '@SUM(1) 惡意標題', { link: 'javascript:alert(1)' }),
    ] });
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    const [row] = lastExportArgs().detailRows;
    expect(row.媒體.startsWith("'=")).toBe(true);
    expect(row.記者.startsWith("'+")).toBe(true);
    expect(row.新聞標題.startsWith("'@")).toBe(true);
    expect(row.連結).toBe('');
  });
});

describe('ExposurePerformancePanel — 隱私與連結安全', () => {
  it('畫面（含展開後的明細）不會出現任何私人欄位內容', () => {
    renderPanel();
    expandAll();
    const text = document.body.textContent;
    ['內部備註不可外流', 'secret.xlsx', 'raw.example.com', '原始媒體名稱'].forEach(s => expect(text, s).not.toContain(s));
    expect(document.body.innerHTML).not.toContain('noteInternal');
    expect(document.body.innerHTML).not.toContain('raw.example.com');
  });

  it('不安全網址不會輸出成可點擊連結；標題仍以純文字顯示', () => {
    renderPanel();
    expandAll();
    const anchors = [...document.querySelectorAll('a')];
    expect(anchors.length).toBe(5);                                        // 6 則裡 1 則網址不安全
    anchors.forEach(a => expect(a.getAttribute('href')).toMatch(/^https?:\/\//));
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    const unsafeRow = screen.getByText('Transcend August revenue', { selector: 'td span' });
    expect(unsafeRow.closest('a')).toBeNull();
  });

  it('危險協定（data:、vbscript:、帳號密碼網址）一律不輸出連結', () => {
    renderPanel({ records: [
      raw('u1', tw(2026, 9, 1), 'A', '', '標題一', { link: 'data:text/html,<script>alert(1)</script>' }),
      raw('u2', tw(2026, 9, 2), 'B', '', '標題二', { link: 'vbscript:msgbox(1)' }),
      raw('u3', tw(2026, 9, 3), 'C', '', '標題三', { link: 'https://user:pw@example.com/' }),
    ] });
    expandAll();
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('標題三', { selector: 'td span' })).toBeTruthy();   // 標題仍以純文字顯示
  });
});

describe('ExposurePerformancePanel — 分組依據標籤', () => {
  const REVENUE = [
    ['鉅亨網', '創見9月營收60.35億元年增290.42% 1—9月達485.11億元'],
    ['聯合報', '創見9月營收60.4億元、年增290% 深化AI與工業應用布局'],
    ['電子時報', '創見Q3營收160.7億元創次高 深化AI及工控應用'],
    ['非凡新聞', '威剛9月營收年增2倍、Q3首破500億！創見前9月增370%創高'],
  ];
  const revenueRecords = REVENUE.map(([media, title], i) => raw('rv' + i, tw(2026, 10, 6, 9 + i), media, '', title));

  it('事件規則分出的主題：名稱是事件名稱、標示「分組依據：依事件規則：月營收公告」，展開可看每一則', () => {
    renderPanel({ records: [...revenueRecords, raw('solo', tw(2026, 9, 3), '經濟日報', '', '創見獲選台灣企業100強')] });
    const buttons = topicButtons();
    expect(buttons).toHaveLength(2);
    const event = buttons.find(b => b.textContent.includes('2026年9月營收公告'));
    expect(within(event).getByText('分組依據：事件規則（月營收公告）')).toBeTruthy();
    expect(within(event).getByText('4').nextElementSibling.textContent).toBe('則曝光');
    // 只有一篇的主題不顯示分組依據
    const solo = buttons.find(b => b.textContent.includes('創見獲選台灣企業100強'));
    expect(solo.textContent).not.toContain('分組依據');
    fireEvent.click(event);
    const detail = document.getElementById(event.getAttribute('aria-controls'));
    expect(detail.querySelectorAll('tbody tr')).toHaveLength(4);
  });

  it('標題相似與標題相同的主題各自標示依據；匯出的主題彙整帶「分組依據」欄', () => {
    renderPanel({ records: [
      raw('s1', tw(2026, 9, 23), '經濟日報', '', '創見擴充嵌入式鏡頭模組陣容 攜研華加速 Edge AI 視覺應用'),
      raw('s2', tw(2026, 9, 23), '工商時報', '', '創見推AI嵌入式鏡頭模組 攜研華搶攻Edge AI商機'),
      raw('t1', tw(2026, 9, 1), '鉅亨網', '', '創見公告庫藏股'),
      raw('t2', tw(2026, 9, 9), '聯合報', '', '創見 公告庫藏股！'),
    ] });
    expect(screen.getByText('分組依據：標題相似')).toBeTruthy();
    expect(screen.getByText('分組依據：標題相同')).toBeTruthy();
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    expect(lastExportArgs().summaryRows.map(r => r['分組依據']).sort()).toEqual(['標題相似', '標題相同'].sort());
  });
});

describe('ExposurePerformancePanel — 主題排序（依新聞時間由近到遠）', () => {
  // 曝光數最多的是 9/1 那組（3 則），但最近的是 9/20（1 則）
  const SORT_RECORDS = [
    raw('a1', tw(2026, 8, 30), 'A', '', '甲甲甲 新品發表'), raw('a2', tw(2026, 8, 31), 'B', '', '甲甲甲 新品發表'),
    raw('a3', tw(2026, 9, 1), 'C', '', '甲甲甲 新品發表'),
    raw('c1', tw(2026, 9, 9), 'E', '', '丙丙丙 展覽'), raw('c2', tw(2026, 9, 10), 'F', '', '丙丙丙 展覽'),
    raw('b1', tw(2026, 9, 20), 'D', '', '乙乙乙 獲獎'),
  ];
  const order = () => topicButtons().map(b => b.querySelector('p').textContent.slice(0, 3));

  it('預設依最近曝光時間由近到遠（不是依曝光數）', () => {
    renderPanel({ records: SORT_RECORDS });
    expect(order()).toEqual(['乙乙乙', '丙丙丙', '甲甲甲']);
    expect(screen.getByText(/依最近曝光時間由近到遠排序/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '最新優先' }).className).toContain('text-white');
  });

  it('可切換成「曝光數最多」，再切回「最新優先」', () => {
    renderPanel({ records: SORT_RECORDS });
    fireEvent.click(screen.getByRole('button', { name: '曝光數最多' }));
    expect(order()).toEqual(['甲甲甲', '丙丙丙', '乙乙乙']);
    expect(screen.getByText(/依曝光數由多到少排序/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '最新優先' }));
    expect(order()).toEqual(['乙乙乙', '丙丙丙', '甲甲甲']);
  });

  it('篩選後仍依時間排序；Excel 匯出的主題順序跟畫面一致', () => {
    renderPanel({ records: SORT_RECORDS });
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    expect(lastExportArgs().summaryRows.map(r => r['新聞稿／主題'].slice(0, 3))).toEqual(['乙乙乙', '丙丙丙', '甲甲甲']);
    expect(lastExportArgs().detailRows.map(r => r['新聞稿／主題'].slice(0, 3))).toEqual(
      ['乙乙乙', '丙丙丙', '丙丙丙', '甲甲甲', '甲甲甲', '甲甲甲']);
    fireEvent.click(screen.getByRole('button', { name: '曝光數最多' }));
    fireEvent.click(screen.getByText('匯出新聞稿成效'));
    expect(lastExportArgs().summaryRows.map(r => r['新聞稿／主題'].slice(0, 3))).toEqual(['甲甲甲', '丙丙丙', '乙乙乙']);
    fireEvent.click(screen.getByRole('button', { name: '最新優先' }));
    select('曝光媒體篩選', 'F');
    expect(order()).toEqual(['丙丙丙']);
  });
});
