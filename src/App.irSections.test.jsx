/* global URLSearchParams */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';

// ── App 層測試用：Firestore 與各資料 hook 換成替身，登記「掛載幾次／建立幾個監聽器」
const counts = vi.hoisted(() => ({ feed: 0, pr: 0, exposure: 0, upstream: 0, snapshot: 0 }));
vi.mock('./services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  doc: () => ({ __fake: 'docRef' }),
  onSnapshot: () => { counts.snapshot += 1; return () => {}; },
  getDoc: async () => ({ exists: () => false }),
}));
vi.mock('./features/news/useNewsFeed.js', async () => {
  const { useEffect } = await import('react');
  return { useNewsFeed: () => { useEffect(() => { counts.feed += 1; }, []); return { news: [], loading: false, refresh: vi.fn() }; } };
});
vi.mock('./features/news/usePRNews.js', async () => {
  const { useEffect } = await import('react');
  return { usePRNews: () => { useEffect(() => { counts.pr += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/news/useUpstreamNews.js', async () => {
  const { useEffect } = await import('react');
  return { useUpstreamNews: () => { useEffect(() => { counts.upstream += 1; }, []); return { articles: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./features/pr/useMediaExposure.js', async () => {
  const { useEffect } = await import('react');
  return { useMediaExposure: () => { useEffect(() => { counts.exposure += 1; }, []); return { records: [], status: 'ready', refresh: vi.fn() }; } };
});
vi.mock('./utils/copyChart.js', () => ({ copyChartImage: vi.fn() }));

import App from './App.jsx';
import { IRTab } from './features/ir/IRTab.jsx';
import { IR_SECTIONS } from './features/ir/irSections.js';

// ═══════════════════════════════════════════════════════════
// 測試資料
// ═══════════════════════════════════════════════════════════
const fresh = () => ({ toDate: () => new Date() });
const mkStock = (price, changePct, change, extra = {}) => ({
  price, changePct, change, volume: 1200000, updatedAt: fresh(), ...extra,
});
const stocks = {
  '2451': mkStock(300, 2.5, 7.3),
  '3260': mkStock(80, -1.2, -1),
  '8271': mkStock(50, 0, 0),
};

// 2025/09 = 1,000 百萬、2026/08 = 1,100 百萬、2026/09 = 1,320 百萬 → 月增 +20.00%、年增 +32.00%
const revenue = [
  { year: 2025, month: 9, revenue: 1000e6 },
  { year: 2026, month: 8, revenue: 1100e6 },
  { year: 2026, month: 9, revenue: 1320e6 },
];
const financials = [
  { date: '2026-03-31', grossMargin: 20, opMargin: 5, netMargin: 4, eps: 1 },
  { date: '2026-06-30', grossMargin: 31.5, opMargin: 12.3, netMargin: 10, eps: 3.21 },
  { date: '2025-12-31', grossMargin: 18, opMargin: 3, netMargin: 2, eps: 0.5 },
];
// 2025 年的金額故意用字串：合計必須是數字相加（4 + 1 = 5），不能變成 "41"
const dividends = [
  { year: 2024, cashDividend: 5, stockDividend: 0, totalDividend: 5 },
  { year: 2025, cashDividend: '4', stockDividend: '1' },
];
const mkMaterial = (i, date, extra = {}) => ({
  code: '2451', date, summary: `重大訊息第${i}則`, link: `https://example.com/m${i}`, highlight: false, ...extra,
});
const material = [
  mkMaterial(1, '2025-01-10'),
  mkMaterial(2, '2026-09-01'),
  mkMaterial(3, '2026-08-15'),
  mkMaterial(4, '2026-09-10', { link: 'javascript:alert(1)' }),
  mkMaterial(5, '2026-07-20'),
  mkMaterial(6, '2026-09-05', { code: '3260' }),
  mkMaterial(7, '2024-12-31', { link: '' }),
];

const setUrl = search => window.history.replaceState(null, '', `/${search}`);
const tabNamed = name => screen.getByRole('tab', { name });
const selectedTab = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
const cardOf = title => screen.getByText(title, { selector: 'h3' }).closest('.bg-gray-900');

function renderIR(props = {}, section) {
  if (section) setUrl(`?tab=ir&section=${section}`);
  return render(<IRTab
    news={[]} community={[]} stocks={stocks} revenue={revenue} financials={financials}
    dividends={dividends} material={material} daily={{}} compRev={{}} loading={false} {...props} />);
}

beforeEach(() => {
  Object.keys(counts).forEach(k => { counts[k] = 0; });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════
describe('IR 子頁籤 — 預設與切換', () => {
  it('沒有 section 參數時預設進入「總覽」，四個子頁籤都存在', () => {
    renderIR();
    expect(IR_SECTIONS.map(s => s.label)).toEqual(['總覽', '股價與競品', '財務營運', '重大訊息與股利']);
    expect(screen.getAllByRole('tab').map(t => t.textContent.trim())).toEqual(['總覽', '股價與競品', '財務營運', '重大訊息與股利']);
    expect(selectedTab()).toBe('總覽');
    expect(cardOf('創見股價')).toBeTruthy();
  });

  it('四個子頁都能切換，網址同步成 ?tab=ir&section=…，aria-selected／aria-controls 正確', () => {
    renderIR();
    for (const s of IR_SECTIONS) {
      fireEvent.click(tabNamed(s.label));
      expect(selectedTab()).toBe(s.label);
      expect(window.location.search).toBe(`?tab=ir&section=${s.id}`);
      const panel = document.getElementById(tabNamed(s.label).getAttribute('aria-controls'));
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.hidden).toBe(false);
      expect(panel.getAttribute('aria-labelledby')).toBe(tabNamed(s.label).id);
    }
  });

  it('方向鍵、Home／End 切換子頁籤', () => {
    renderIR();
    tabNamed('總覽').focus();
    fireEvent.keyDown(tabNamed('總覽'), { key: 'ArrowRight' });
    expect(selectedTab()).toBe('股價與競品');
    fireEvent.keyDown(tabNamed('股價與競品'), { key: 'End' });
    expect(selectedTab()).toBe('重大訊息與股利');
    fireEvent.keyDown(tabNamed('重大訊息與股利'), { key: 'ArrowRight' });
    expect(selectedTab()).toBe('總覽');
    fireEvent.keyDown(tabNamed('總覽'), { key: 'ArrowLeft' });
    expect(selectedTab()).toBe('重大訊息與股利');
  });

  it('每個舊功能只出現在正確的子頁', () => {
    const { unmount } = renderIR();
    const has = text => !!screen.queryByText(text, { selector: 'h3' });
    // 總覽：只有摘要卡，沒有長表格與圖表
    expect(has('財務營運摘要')).toBe(true);
    expect(has('歷年股利配息（近 10 年）')).toBe(false);
    expect(has('季度損益摘要（近 8 季）')).toBe(false);
    expect(has('創見與競品 IR 新訊')).toBe(false);
    expect(has('創見 2451 每日交易資訊')).toBe(false);
    unmount();

    const market = renderIR({}, 'market');
    expect(has('創見 2451 每日交易資訊')).toBe(true);
    expect(screen.getAllByText('等待 Actions 更新').length).toBeGreaterThan(0);
    expect(has('歷年股利配息（近 10 年）')).toBe(false);
    market.unmount();

    const fin = renderIR({}, 'financials');
    expect(has('最新一期財務摘要')).toBe(true);
    expect(screen.getByText('創見月營收（近 24 個月）', { selector: 'h3' })).toBeTruthy();
    expect(has('創見與競品 IR 新訊')).toBe(false);
    fin.unmount();

    renderIR({}, 'disclosures');
    expect(has('創見與競品 IR 新訊')).toBe(true);
    expect(has('歷年股利配息（近 10 年）')).toBe(true);
    expect(has('創見月營收（近 24 個月）')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR 總覽 — 摘要內容', () => {
  it('顯示最新股價、漲跌、成交量、月營收（月增／年增）、EPS、毛利率、營業利益率、股利', () => {
    renderIR();
    const price = cardOf('創見股價');
    expect(within(price).getByText('$300.00')).toBeTruthy();
    expect(within(price).getByText('+2.50%（+7.3）')).toBeTruthy();
    expect(within(price).getByText(/成交量 1200 張/)).toBeTruthy();
    expect(within(price).getByText(/更新/)).toBeTruthy();

    const fin = cardOf('財務營運摘要');
    expect(within(fin).getByText('月營收（2026/09）')).toBeTruthy();
    expect(within(fin).getByText('1,320 百萬元')).toBeTruthy();
    expect(within(fin).getByText('+20.00%')).toBeTruthy();   // 月增率
    expect(within(fin).getByText('+32.00%')).toBeTruthy();   // 年增率
    expect(within(fin).getByText('EPS（2026-06）')).toBeTruthy();
    expect(within(fin).getByText('$3.21')).toBeTruthy();
    expect(within(fin).getByText('31.5%')).toBeTruthy();
    expect(within(fin).getByText('12.3%')).toBeTruthy();

    const div = cardOf('最新股利');
    expect(within(div).getByText('2025 現金股利')).toBeTruthy();
    expect(within(div).getByText('$4.00')).toBeTruthy();
    expect(within(div).getAllByText('$1.00').length).toBeGreaterThan(0);   // 股票股利
    expect(within(div).getByText('$5.00')).toBeTruthy();                   // 合計＝4＋1，不是字串 "41"
    expect(div.textContent).not.toContain('41');
  });

  it('最近重大訊息最多 5 則，依日期新→舊（數字比較）排序', () => {
    renderIR();
    const rows = within(cardOf('最近重大訊息')).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('2026-09-10'),
      expect.stringContaining('2026-09-05'),
      expect.stringContaining('2026-09-01'),
      expect.stringContaining('2026-08-15'),
      expect.stringContaining('2026-07-20'),
    ]);
  });

  it('競品股價摘要列出五家競品；沒有資料的顯示「—」', () => {
    renderIR();
    const card = cardOf('競品股價摘要');
    expect(within(card).getAllByRole('listitem')).toHaveLength(5);
    expect(within(card).getByText('$80.00')).toBeTruthy();
    expect(within(card).getByText('-1.20%')).toBeTruthy();
    expect(within(card).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('「查看全部」導向對應子頁，並捲回頂端', () => {
    renderIR();
    fireEvent.click(screen.getByRole('button', { name: '查看全部：創見股價' }));
    expect(selectedTab()).toBe('股價與競品');
    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(screen.getByRole('button', { name: '查看全部：財務營運摘要' }));
    expect(selectedTab()).toBe('財務營運');
    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(screen.getByRole('button', { name: '查看全部：最近重大訊息' }));
    expect(selectedTab()).toBe('重大訊息與股利');
    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(screen.getByRole('button', { name: '查看全部：最新股利' }));
    expect(selectedTab()).toBe('重大訊息與股利');
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('資料都還沒載入或為空時顯示「—」／尚無資料，不出現 NaN、undefined 或假的 0', () => {
    const { container, unmount } = renderIR({
      stocks: {}, revenue: null, financials: null, dividends: null, material: null, loading: true,
    });
    for (const bad of ['NaN', 'undefined', 'null', '$0', '0%']) expect(container.textContent).not.toContain(bad);
    expect(container.textContent).toContain('資料更新中');
    unmount();

    const empty = renderIR({ stocks: {}, revenue: [], financials: [], dividends: [], material: [], loading: false });
    for (const bad of ['NaN', 'undefined', 'null', '$0', '0%']) expect(empty.container.textContent).not.toContain(bad);
    expect(empty.container.textContent).toContain('尚無資料');
    expect(within(cardOf('財務營運摘要')).getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('資料缺欄位（EPS／毛利率為空、0）顯示「—」而不是 0', () => {
    renderIR({ financials: [{ date: '2026-06-30', grossMargin: 0, opMargin: null, netMargin: undefined, eps: null }] });
    const fin = cardOf('財務營運摘要');
    expect(within(fin).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(fin.textContent).not.toContain('0.0%');
    expect(fin.textContent).not.toContain('$0');
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR — 資料狀態（正常／更新中／過期／載入失敗／尚無資料）', () => {
  it('部分資料載入失敗：失敗的區塊標示「載入失敗」，其他區塊照常顯示', () => {
    renderIR({ revenue: [], loadErrors: { revenue: true } });
    expect(screen.getByText(/月營收：載入失敗/)).toBeTruthy();
    expect(within(cardOf('創見股價')).getByText('$300.00')).toBeTruthy();   // 股價仍在
    expect(within(cardOf('最近重大訊息')).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(within(cardOf('財務營運摘要')).getByText('$3.21')).toBeTruthy();   // 財報仍在
    // 過期／失敗的徽章可以點，前往相關子頁
    fireEvent.click(screen.getByRole('button', { name: '月營收載入失敗，前往查看' }));
    expect(selectedTab()).toBe('財務營運');
  });

  it('股價在交易時段內超過 30 分鐘沒更新 → 標示資料過期，並可從總覽前往股價子頁；不當作即時價格', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 15, 2, 30)));   // 週二 10:30 台北（交易時段）
    const old = mkStock(300, 2.5, 7.3, { updatedAt: { toDate: () => new Date(Date.UTC(2026, 8, 15, 1, 0)) } });
    renderIR({ stocks: { '2451': old } });
    expect(screen.getByText('股價：資料過期')).toBeTruthy();
    expect(within(cardOf('創見股價')).getByText(/非即時/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '股價資料過期，前往查看' }));
    expect(selectedTab()).toBe('股價與競品');
  });

  it('資料正常時狀態列顯示「正常」，且沒有可點的警示按鈕', () => {
    renderIR();
    expect(screen.getByText('股價：正常')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /前往查看/ })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR 股價與競品', () => {
  it('上漲紅色▲、下跌綠色▼、平盤中性色─，同時有正負號／文字，不只靠顏色', () => {
    renderIR({}, 'market');
    const up = screen.getByText('$300').closest('div.p-4');
    expect(up.querySelector('.text-red-400').textContent).toBe('▲+2.50%');
    const down = screen.getByText('$80').closest('div.p-4');
    expect(down.querySelector('.text-green-400').textContent).toBe('▼-1.20%');
    const flat = screen.getByText('$50').closest('div.p-4');
    expect(flat.querySelector('.text-gray-400').textContent).toBe('─0.00%');
  });

  it('總覽的漲跌標記：上漲 up／下跌 down／平盤 flat／缺值 none', () => {
    renderIR();
    const comp = cardOf('競品股價摘要');
    expect(comp.querySelector('[data-trend="down"]').textContent).toContain('▼');
    expect(comp.querySelector('[data-trend="flat"]').textContent).toContain('─');
    expect(comp.querySelector('[data-trend="none"]')).toBeTruthy();
    expect(cardOf('創見股價').querySelector('[data-trend="up"]').textContent).toContain('▲');
  });

  it('公司篩選只顯示選到的公司，切換子頁再回來仍保留', () => {
    renderIR({}, 'market');
    fireEvent.click(screen.getByRole('button', { name: '3260 威剛' }));
    expect(screen.queryByText('$300')).toBeNull();
    expect(screen.getByText('$80')).toBeTruthy();
    fireEvent.click(tabNamed('財務營運'));
    fireEvent.click(tabNamed('股價與競品'));
    expect(screen.getByRole('button', { name: '3260 威剛' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('$300')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR 財務營運', () => {
  it('頁面上方是最新一期摘要卡（含稅後淨利率），EPS 與利潤率文字使用深色可讀的 text-ink', () => {
    renderIR({}, 'financials');
    const card = cardOf('最新一期財務摘要');
    expect(within(card).getByText('稅後淨利率')).toBeTruthy();
    expect(within(card).getByText('10.0%')).toBeTruthy();
    for (const value of [within(card).getByText('$3.21'), within(card).getByText('31.5%')]) {
      expect(value.className).toContain('text-ink');
    }
  });

  it('月營收／季度損益／競品比較可以頁內切換，選擇在切換子頁後保留', () => {
    const compRev = { '3260': [{ year: 2026, month: 8, revenue: 800e6 }, { year: 2026, month: 9, revenue: 900e6 }] };
    renderIR({ compRev }, 'financials');
    const group = screen.getByRole('group', { name: '財務營運檢視' });
    expect(screen.getByText('創見月營收（近 24 個月）', { selector: 'h3' })).toBeTruthy();
    expect(screen.queryByText('季度損益摘要（近 8 季）', { selector: 'h3' })).toBeNull();

    fireEvent.click(within(group).getByRole('button', { name: '季度損益' }));
    expect(screen.getByText('季度損益摘要（近 8 季）', { selector: 'h3' })).toBeTruthy();
    expect(screen.queryByText('創見月營收（近 24 個月）', { selector: 'h3' })).toBeNull();
    // 季度表：最新一季在最上面（日期用數字比較）
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('2026-06');
    expect(rows[rows.length - 1].textContent).toContain('2025-12');

    fireEvent.click(within(group).getByRole('button', { name: '競品比較' }));
    expect(screen.getByText(/創見 vs 競品月營收比較/, { selector: 'h3' })).toBeTruthy();

    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(tabNamed('財務營運'));
    expect(within(screen.getByRole('group', { name: '財務營運檢視' })).getByRole('button', { name: '競品比較' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('財務表格有 caption、th scope，歷史表格預設近 8 季並可展開全部', () => {
    renderIR({}, 'financials');
    fireEvent.click(screen.getByRole('button', { name: '季度損益' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('季度損益摘要')).toBeTruthy();   // caption
    expect(within(table).getAllByRole('columnheader').every(th => th.getAttribute('scope') === 'col')).toBe(true);
    expect(within(table).getAllByRole('rowheader').length).toBe(3);
  });

  it('財務名詞說明可以用鍵盤開啟（focus）並用 Esc 關閉', () => {
    renderIR({}, 'financials');
    fireEvent.click(screen.getByRole('button', { name: '季度損益' }));
    const tip = screen.getByRole('button', { name: '毛利率說明' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(tip);
    expect(screen.getByRole('tooltip').textContent).toContain('毛利率越高');
    fireEvent.keyDown(tip, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(tip);
    fireEvent.blur(tip);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR 重大訊息與股利', () => {
  it('重大訊息依日期新→舊排序，可依年份篩選，狀態在切換子頁後保留', () => {
    renderIR({}, 'disclosures');
    const card = cardOf('創見與競品 IR 新訊');
    const list = () => within(card).getAllByText(/重大訊息第\d則/).map(e => e.textContent);
    expect(list()).toEqual(['重大訊息第4則', '重大訊息第6則', '重大訊息第2則', '重大訊息第3則', '重大訊息第5則', '重大訊息第1則', '重大訊息第7則']);

    fireEvent.change(screen.getByLabelText('依年份篩選重大訊息'), { target: { value: '2025' } });
    expect(list()).toEqual(['重大訊息第1則']);
    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(tabNamed('重大訊息與股利'));
    expect(screen.getByLabelText('依年份篩選重大訊息').value).toBe('2025');
    expect(list()).toEqual(['重大訊息第1則']);
  });

  it('外部連結只有通過安全驗證的 http(s) 網址才會變成連結；javascript: 與空連結不會輸出 <a>', () => {
    renderIR({}, 'disclosures');
    const card = cardOf('創見與競品 IR 新訊');
    const anchorFor = text => within(card).getByText(text).closest('a');
    expect(anchorFor('重大訊息第2則').getAttribute('href')).toBe('https://example.com/m2');
    expect(anchorFor('重大訊息第2則').getAttribute('rel')).toContain('noopener');
    expect(anchorFor('重大訊息第4則')).toBeNull();   // javascript:
    expect(anchorFor('重大訊息第7則')).toBeNull();   // 空連結
    expect([...card.querySelectorAll('a')].some(a => (a.getAttribute('href') || '').toLowerCase().startsWith('javascript:'))).toBe(false);
  });

  it('展開重大訊息：有安全來源連結的顯示「開啟來源」，沒有的顯示說明文字', () => {
    renderIR({}, 'disclosures');
    const card = cardOf('創見與競品 IR 新訊');
    const open = within(card).getByRole('button', { name: /展開重大訊息：創見資訊? 2026-09-01|展開重大訊息：.*2026-09-01/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(within(card).getByText(/開啟來源/).closest('a').getAttribute('href')).toBe('https://example.com/m2');
    const bad = within(card).getByRole('button', { name: /展開重大訊息：.*2026-09-10/ });
    fireEvent.click(bad);
    expect(within(card).getByText('此則訊息沒有可用的來源連結')).toBeTruthy();
    // 展開狀態在切換子頁後保留
    fireEvent.click(tabNamed('總覽'));
    fireEvent.click(tabNamed('重大訊息與股利'));
    expect(within(cardOf('創見與競品 IR 新訊')).getByRole('button', { name: /收合重大訊息：.*2026-09-01/ })).toBeTruthy();
  });

  it('歷年股利：現金／股票／合計文字顏色一致（text-ink），無資料顯示「—」，合計不是字串拼接', () => {
    renderIR({}, 'disclosures');
    const table = within(cardOf('歷年股利配息（近 10 年）')).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('2025');           // 新→舊
    const cells2025 = within(rows[0]).getAllByRole('cell');
    expect(cells2025.map(c => c.textContent)).toEqual(['$4.00', '$1.00', '$5.00']);
    const cells2024 = within(rows[1]).getAllByRole('cell');
    expect(cells2024.map(c => c.textContent)).toEqual(['$5.00', '—', '$5.00']);
    for (const cell of [...cells2025, ...cells2024]) expect(cell.className).toContain('text-ink');
  });

  it('沒有除息日資料時，不顯示「除息」資訊', () => {
    renderIR({}, 'disclosures');
    expect(screen.queryByText(/除息/)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR — 網址與瀏覽器上一頁／下一頁', () => {
  it('依網址 ?section= 初始化；不認識的值回到總覽並從網址移除', () => {
    for (const s of IR_SECTIONS) {
      setUrl(`?tab=ir&section=${s.id}`);
      const { unmount } = renderIR();
      expect(selectedTab()).toBe(s.label);
      unmount();
    }
    setUrl('?tab=ir&section=%3Cscript%3E');
    renderIR();
    expect(selectedTab()).toBe('總覽');
    expect(new URLSearchParams(window.location.search).has('section')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('ir');
  });

  it('上一頁／下一頁依序切換子頁', async () => {
    renderIR();
    fireEvent.click(tabNamed('股價與競品'));
    fireEvent.click(tabNamed('重大訊息與股利'));
    expect(selectedTab()).toBe('重大訊息與股利');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(selectedTab()).toBe('股價與競品'));
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(selectedTab()).toBe('總覽'));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(selectedTab()).toBe('股價與競品'));
  });
});

// ═══════════════════════════════════════════════════════════
describe('App — PR 與 IR 的子頁互不覆蓋，切換子頁不重建 Firestore 監聽、不重啟計時器', () => {
  async function renderApp() {
    const utils = render(<App />);
    await act(async () => {});
    return utils;
  }
  const clickTop = async name => { await act(async () => { fireEvent.click(screen.getByText(name)); }); await act(async () => {}); };

  it('PR 停在「新聞監測」、IR 停在「財務營運」，來回切換主分頁各自回到原本的子頁', async () => {
    await renderApp();
    await screen.findByRole('tab', { name: '新聞監測' }, { timeout: 5000 });
    fireEvent.click(tabNamed('新聞監測'));
    await clickTop('IR 投資情報');
    await screen.findByRole('tab', { name: '財務營運' }, { timeout: 5000 });
    expect(selectedTab()).toBe('總覽');                       // IR 第一次進來是預設總覽
    expect(window.location.search).toBe('?tab=ir');
    fireEvent.click(tabNamed('財務營運'));
    expect(window.location.search).toBe('?tab=ir&section=financials');
    await clickTop('PR 媒體戰情');
    expect(selectedTab()).toBe('新聞監測');                   // PR 沒被 IR 的 section 覆蓋
    expect(window.location.search).toBe('?tab=pr&section=news');
    await clickTop('IR 投資情報');
    expect(selectedTab()).toBe('財務營運');
    expect(window.location.search).toBe('?tab=ir&section=financials');
  });

  it('在 IR 的四個子頁間切換、再離開又回來：資料 hook 只掛載一次，股價監聽只建立一次，沒有新的 setInterval', async () => {
    const spy = vi.spyOn(window, 'setInterval');
    await renderApp();
    await clickTop('IR 投資情報');
    await screen.findByRole('tab', { name: '財務營運' }, { timeout: 5000 });
    const intervalsAfterMount = spy.mock.calls.length;
    const snapshotsAfterMount = counts.snapshot;
    expect(snapshotsAfterMount).toBe(1);

    for (const name of ['股價與競品', '財務營運', '重大訊息與股利', '總覽', '財務營運']) {
      await act(async () => { fireEvent.click(tabNamed(name)); });
    }
    // 在 IR 內切換子頁：沒有新的計時器（股價自動更新倒數不會被重建或重設）、沒有新的監聽
    expect(spy.mock.calls.length).toBe(intervalsAfterMount);
    expect(counts.snapshot).toBe(snapshotsAfterMount);

    // 離開 IR 再回來：App 層的資料 hook 與股價監聽仍然只有一份
    await clickTop('PR 媒體戰情');
    await clickTop('IR 投資情報');
    await screen.findByRole('tab', { name: '財務營運' }, { timeout: 5000 });
    expect(counts.snapshot).toBe(snapshotsAfterMount);
    expect(counts).toMatchObject({ feed: 1, pr: 1, exposure: 1, upstream: 1 });
  });
});

// ═══════════════════════════════════════════════════════════
describe('IR — 手機版與無障礙結構', () => {
  it('子頁籤列可橫向捲動、標籤不換行；各子頁內容區不撐出頁面寬度', () => {
    renderIR();
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('whitespace-nowrap');
    screen.getAllByRole('tab').forEach(t => expect(t.className).toContain('shrink-0'));
    expect(list.parentElement.className).toContain('sticky');
    // 只有目前的 tab 在 Tab 鍵順序內（roving tabindex）
    expect(screen.getAllByRole('tab').map(t => t.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('財務表格外層是區塊內橫向捲動（overflow-x-auto），不會讓整頁水平溢出', () => {
    renderIR({}, 'disclosures');
    const table = within(cardOf('歷年股利配息（近 10 年）')).getByRole('table');
    expect(table.parentElement.className).toContain('overflow-x-auto');
  });
});
