import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { IRTab } from './IRTab.jsx';
import { copyChartImage } from '../../utils/copyChart.js';

// jsdom 沒有 canvas／ClipboardItem，圖片產生與寫入剪貼簿的細節改在瀏覽器實測；
// 這裡只驗證按鈕有把正確的 <svg>、標題、圖例交給複製函式。
vi.mock('../../utils/copyChart.js', () => ({ copyChartImage: vi.fn() }));

function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

function mkStock(price, changePct, overrides = {}) {
  return {
    name: undefined, price, changePct, change: changePct, volume: 1200000,
    // 固定給「剛剛」的 updatedAt，避免 isStockStale 因為測試執行當下
    // 真實時間剛好落在台股交易時段而產生不穩定的假警告。
    updatedAt: { toDate: () => new Date() },
    ...overrides,
  };
}

function renderIR(overrides = {}) {
  return render(<IRTab
    news={[]} community={[]}
    stocks={{}} revenue={null} financials={null} dividends={null}
    material={null} daily={null} compRev={{}}
    {...overrides}
  />);
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('IRTab — 股價卡片', () => {
  it('renders red for a positive change and green for a negative change (台股慣例)', () => {
    renderIR({ stocks: {
      '2451': mkStock(300, 2.5),
      '3260': mkStock(80, -1.2),
    } });

    const redCard = screen.getByText('$300').closest('div.p-4');
    expect(redCard.querySelector('.text-red-400')).toBeTruthy();

    const greenCard = screen.getByText('$80').closest('div.p-4');
    expect(greenCard.querySelector('.text-green-400')).toBeTruthy();
  });

  it('shows a placeholder for competitor codes that have no stock data yet', () => {
    renderIR({ stocks: { '2451': mkStock(300, 1) } });
    // 5 個競品都還沒資料
    expect(screen.getAllByText('等待 Actions 更新')).toHaveLength(5);
  });

  it('shows the missing-data warning banner only when stocks is completely empty', () => {
    const { rerender } = renderIR({ stocks: {} });
    expect(screen.getByText(/尚未取得股價/)).toBeTruthy();

    rerender(<IRTab news={[]} community={[]} stocks={{ '2451': mkStock(300, 1) }}
      revenue={null} financials={null} dividends={null} material={null} daily={null} compRev={{}} />);
    expect(screen.queryByText(/尚未取得股價/)).toBeNull();
  });

  it('flags a stock as stale when its updatedAt is more than 30 minutes old during trading hours', () => {
    // 2026-08-21 是週五，10:00 台北時間在交易時段（09:00–13:35）內
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 8, 21, 10, 0, 0));
    const staleStock = mkStock(300, 1, { updatedAt: { toDate: () => taipei(2026, 8, 21, 9, 0, 0) } });
    renderIR({ stocks: { '2451': staleStock } });
    expect(screen.getByText('資料過期')).toBeTruthy();
  });
});

describe('IRTab — 每日交易資訊（開收盤／外資／投信）', () => {
  it('shows a loading state while daily is null, and an empty state once it resolves to no data', () => {
    const { rerender } = renderIR({ daily: null });
    const card = screen.getByText('創見 2451 每日交易資訊').closest('div.bg-gray-900');
    expect(within(card).getByText('載入中…')).toBeTruthy();

    rerender(<IRTab news={[]} community={[]} stocks={{}} revenue={null} financials={null}
      dividends={null} material={null} daily={{}} compRev={{}} />);
    const card2 = screen.getByText('創見 2451 每日交易資訊').closest('div.bg-gray-900');
    expect(within(card2).getByText('尚無資料（Actions 跑完後自動更新）')).toBeTruthy();
  });

  it('colors the daily price change red when up and green when down (台股慣例)', () => {
    const { rerender } = renderIR({ daily: { open: 100, close: 105, high: 106, low: 99, volume: 500000 } });
    const card = screen.getByText('創見 2451 每日交易資訊').closest('div.bg-gray-900');
    expect(within(card).getByText('+5')).toHaveClass('text-red-400');

    rerender(<IRTab news={[]} community={[]} stocks={{}} revenue={null} financials={null}
      dividends={null} material={null}
      daily={{ open: 105, close: 100, high: 106, low: 99, volume: 500000 }} compRev={{}} />);
    const card2 = screen.getByText('創見 2451 每日交易資訊').closest('div.bg-gray-900');
    expect(within(card2).getByText('-5')).toHaveClass('text-green-400');
  });

  it('always shows buy amounts in red and sell amounts in green regardless of the net direction', () => {
    renderIR({ daily: {
      open: 100, close: 100,
      // fmtK：>=10000 才會用「萬」為單位，所以要用夠大的數字才會顯示 XX萬
      foreignNet: -500000, foreignBuy: 1_000_000, foreignSell: 1_500_000,
      trustNet: 200000, trustBuy: 800_000, trustSell: 600_000,
    } });
    const card = screen.getByText('創見 2451 每日交易資訊').closest('div.bg-gray-900');
    // 買進固定紅色、賣出固定綠色，跟淨額本身漲跌方向無關
    expect(within(card).getByText('100萬')).toHaveClass('text-red-400/80');   // foreignBuy
    expect(within(card).getByText('150萬')).toHaveClass('text-green-400/80'); // foreignSell
    expect(within(card).getByText('80萬')).toHaveClass('text-red-400/80');    // trustBuy
    expect(within(card).getByText('60萬')).toHaveClass('text-green-400/80');  // trustSell
  });
});

describe('IRTab — 創見與競品重大訊息', () => {
  const records = [
    { code: '2451', date: '2026-07-01', summary: '創見召開法人說明會', highlight: true, highlightKw: ['法人說明會'] },
    { code: '3260', date: '2026-06-15', summary: '威剛董事會決議股利分派' },
  ];

  it('shows an empty state once material has loaded with no records', () => {
    renderIR({ material: [] });
    expect(screen.getByText('尚無重大訊息資料（Actions 跑完後自動更新）')).toBeTruthy();
  });

  it('filters the list by stock code when a tab is clicked', () => {
    renderIR({ material: records });
    expect(screen.getByText('創見召開法人說明會')).toBeTruthy();
    expect(screen.getByText('威剛董事會決議股利分派')).toBeTruthy();

    fireEvent.click(screen.getByText(/2451 創見資訊/));
    expect(screen.getByText('創見召開法人說明會')).toBeTruthy();
    expect(screen.queryByText('威剛董事會決議股利分派')).toBeNull();
  });

  it('applies the known badge color for a highlighted keyword like 法人說明會', () => {
    renderIR({ material: records });
    // 「法人說明會」在畫面上出現兩次：這裡的重訊 badge，以及卡片下方
    // 固定的圖例說明文字——用 badge 特有的 class 篩出真正要驗證的那個。
    const badge = screen.getAllByText('法人說明會').find(el => el.classList.contains('bg-blue-900/60'));
    expect(badge).toBeTruthy();
  });
});

describe('IRTab — 月營收 / 年度營收', () => {
  const revenue = [
    { year: 2025, month: 5, revenue: 1_000_000 },
    { year: 2026, month: 5, revenue: 1_200_000 },
    { year: 2025, month: 6, revenue: 1_100_000 },
    { year: 2026, month: 6, revenue: 900_000 },
  ];

  it('shows a loading state when revenue is null and an empty state once it resolves empty', () => {
    const { rerender } = renderIR({ revenue: null });
    const card = screen.getByText('創見月營收（近 24 個月）').closest('div.bg-gray-900');
    expect(within(card).getByText('載入中…')).toBeTruthy();

    rerender(<IRTab news={[]} community={[]} stocks={{}} revenue={[]} financials={null}
      dividends={null} material={null} daily={null} compRev={{}} />);
    const card2 = screen.getByText('創見月營收（近 24 個月）').closest('div.bg-gray-900');
    expect(within(card2).getByText('尚無月營收資料（Actions 跑完後自動更新）')).toBeTruthy();
  });

  it('colors YoY green when revenue fell and red when it grew (台股慣例)', () => {
    renderIR({ revenue });
    // 「26/6」同時出現在 SVG 圖表的 X 軸標籤與明細表格列——只挑表格
    // 裡的 <td>，SVG <text> 元素不在任何 <tr> 底下。
    const declineLabel = screen.getAllByText('26/6').find(el => el.tagName === 'TD');
    const declineRow = declineLabel.closest('tr');
    // 2026/6 較去年同期衰退（900,000 < 1,100,000）→ 綠色
    expect(within(declineRow).getByText(/^-/)).toHaveClass('text-green-400');

    const growthLabel = screen.getAllByText('26/5').find(el => el.tagName === 'TD');
    const growthRow = growthLabel.closest('tr');
    // 2026/5 較去年同期成長（1,200,000 > 1,000,000）→ 紅色
    expect(within(growthRow).getByText(/^\+/)).toHaveClass('text-red-400');
  });
});

describe('IRTab — 季度損益摘要', () => {
  const financials = [
    { date: '2026-06-30', grossMargin: 35, opMargin: 20, netMargin: 5, eps: 3.2 },
    { date: '2026-03-31', grossMargin: 10, opMargin: null, netMargin: 0, eps: -1.5 },
  ];

  it('shows an empty state when there is no data yet', () => {
    renderIR({ financials: [] });
    expect(screen.getByText('尚無季度損益資料（Actions 跑完後自動更新）')).toBeTruthy();
  });

  it('colors margin tiers correctly: >=30 green, 15-29 yellow, <15 red', () => {
    renderIR({ financials });
    expect(screen.getByText('35.0%')).toHaveClass('text-green-400'); // grossMargin 35
    expect(screen.getByText('20.0%')).toHaveClass('text-yellow-400'); // opMargin 20
    expect(screen.getByText('10.0%')).toHaveClass('text-red-400'); // grossMargin 10
  });

  it('colors a positive EPS with ink and a negative EPS with red', () => {
    renderIR({ financials });
    expect(screen.getByText('$3.20')).toHaveClass('text-ink');
    expect(screen.getByText('$-1.50')).toHaveClass('text-red-400');
  });
});

describe('IRTab — 歷年股利配息', () => {
  it('shows an empty state when there is no data yet', () => {
    renderIR({ dividends: [] });
    expect(screen.getByText('尚無股利資料（Actions 跑完後自動更新）')).toBeTruthy();
  });

  it('renders cash/stock/total dividend amounts for a given year', () => {
    renderIR({ dividends: [{ year: 2025, cashDividend: 6.09, stockDividend: 1.5, totalDividend: 7.59 }] });
    expect(screen.getByText('2025')).toBeTruthy();
    expect(screen.getByText('$6.09')).toBeTruthy(); // 現金股利
    expect(screen.getByText('$1.50')).toBeTruthy(); // 股票股利
    expect(screen.getByText('$7.59')).toBeTruthy(); // 合計
  });
});

describe('IRTab — 競品月營收比較：每月橫軸與月增率表格', () => {
  // 創見＋威剛各 26 個月（2024/6–2026/7）。創見營收每月固定 +10 百萬
  // （100、110、…、350）；威剛固定 50 百萬；廣穎只有最新一個月的資料。
  const months = [];
  for (let y = 2024, m = 6; y < 2026 || m <= 7; m++) {
    if (m > 12) { m = 1; y++; }
    months.push({ year: y, month: m });
  }
  const revenue = months.map(({ year, month }, i) => ({ year, month, revenue: (100 + i * 10) * 1e6 }));
  const compRev = {
    '3260': months.map(({ year, month }) => ({ year, month, revenue: 50e6 })),
    '4973': [{ year: 2026, month: 7, revenue: 20e6 }],
  };

  function chartCard() {
    return screen.getByText('創見 vs 競品月營收比較（近 24 個月）').closest('div.bg-gray-900');
  }
  const cells = tr => [...tr.querySelectorAll('td')].map(td => td.textContent);

  it('X 軸每個月都有標籤（24 個，不是每三個月一個）', () => {
    renderIR({ revenue, compRev });
    const labels = [...chartCard().querySelectorAll('svg text')].filter(t => /^\d{2}\/\d{1,2}$/.test(t.textContent));
    expect(labels).toHaveLength(24);
  });

  it('表頭是「月增率」，不再有「年增率」', () => {
    renderIR({ revenue, compRev });
    const heads = [...chartCard().querySelectorAll('thead th')].map(t => t.textContent);
    expect(heads.filter(h => h === '月增率')).toHaveLength(3);
    expect(heads).not.toContain('年增率');
  });

  it('表格列出每個公司的營收（百萬元）與月增率，最新月份在最上面', () => {
    renderIR({ revenue, compRev });
    const rows = chartCard().querySelectorAll('tbody tr');
    expect(rows).toHaveLength(24);
    // 年月、創見營收、創見月增、威剛營收、威剛月增、廣穎營收、廣穎月增
    expect(cells(rows[0])).toEqual(['26/7', '350', '+2.9%', '50', '0%', '20', '—']);
  });

  it('1 月的月增率對的是前一年 12 月', () => {
    renderIR({ revenue, compRev });
    const row = [...chartCard().querySelectorAll('tbody tr')].find(tr => cells(tr)[0] === '26/1');
    expect(cells(row).slice(0, 3)).toEqual(['26/1', '290', '+3.6%']); // 2025/12 = 280
  });

  it('近 24 個月最早的那個月，月增率仍能對到視窗之外的上個月', () => {
    renderIR({ revenue, compRev });
    const rows = chartCard().querySelectorAll('tbody tr');
    expect(cells(rows[rows.length - 1]).slice(0, 3)).toEqual(['24/8', '120', '+9.1%']); // 2024/7 = 110
  });
});

describe('IRTab — 圖表複製按鈕', () => {
  const revenue = [];
  for (let y = 2024, m = 6; y < 2026 || m <= 7; m++) {
    if (m > 12) { m = 1; y++; }
    revenue.push({ year: y, month: m, revenue: 100e6 });
  }
  const compRev = { '3260': revenue.map(r => ({ ...r, revenue: 50e6 })) };

  beforeEach(() => { copyChartImage.mockClear(); copyChartImage.mockResolvedValue('copied'); });

  it('四張圖表（創見月營收、創見年度、競品月營收、競品年度）各有一個複製按鈕', () => {
    renderIR({ revenue, compRev });
    expect(screen.getAllByText('📋 複製圖表')).toHaveLength(4);
  });

  it('按下後把該卡片的 <svg> 連同標題、圖例、說明傳給複製函式，並顯示已複製', async () => {
    renderIR({ revenue, compRev });
    const card = screen.getByText('創見 vs 競品月營收比較（近 24 個月）').closest('div.bg-gray-900');
    fireEvent.click(within(card).getByText('📋 複製圖表'));

    expect(copyChartImage).toHaveBeenCalledTimes(1);
    const [svg, opts] = copyChartImage.mock.calls[0];
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(card.contains(svg)).toBe(true);
    expect(opts.title).toBe('創見 vs 競品月營收比較（近 24 個月）');
    expect(opts.legend.map(l => l.name)).toEqual(['創見（2451）', 'ADATA 威剛（3260）']);
    expect(opts.note).toContain('FinMind');
    expect(await within(card).findByText(/已複製/)).toBeTruthy();
  });

  it('複製失敗時顯示失敗訊息', async () => {
    copyChartImage.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderIR({ revenue, compRev });
    const card = screen.getByText('創見月營收（近 24 個月）').closest('div.bg-gray-900');
    fireEvent.click(within(card).getByText('📋 複製圖表'));
    expect(await within(card).findByText('⚠ 複製失敗')).toBeTruthy();
    spy.mockRestore();
  });

  it('沒有資料時不顯示複製按鈕', () => {
    renderIR({ revenue: [], compRev: {} });
    expect(screen.queryByText('📋 複製圖表')).toBeNull();
  });
});

describe('IRTab — 表格淺灰橫線', () => {
  it('IR 頁面所有表格都套用 ir-table（樣式在 base.css）', () => {
    const revenue = [{ year: 2026, month: 6, revenue: 900_000 }, { year: 2025, month: 6, revenue: 1_100_000 }];
    renderIR({
      revenue,
      dividends: [{ year: 2025, cashDividend: 6.09, stockDividend: 1.5, totalDividend: 7.59 }],
    });
    const tables = document.querySelectorAll('table');
    expect(tables.length).toBeGreaterThanOrEqual(2);
    tables.forEach(t => expect(t.classList.contains('ir-table')).toBe(true));
  });
});

describe('IRTab — 公開資訊觀測站連結', () => {
  it('在「創見與競品 IR 新訊」下方列出五家競品的 MOPS 連結', () => {
    renderIR();
    const card = screen.getByText('創見與競品 IR 新訊').closest('div.bg-gray-900');
    const expected = {
      '威剛': '3260', '廣穎': '4973', '宜鼎': '5289', '十銓': '4967', '宇瞻': '8271',
    };
    Object.entries(expected).forEach(([name, code]) => {
      const a = within(card).getByText(new RegExp('^' + name + ' ' + code)).closest('a');
      expect(a.getAttribute('href')).toBe('https://mops.twse.com.tw/mops/#/web/t146sb05?companyId=' + code);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    });
  });
});
