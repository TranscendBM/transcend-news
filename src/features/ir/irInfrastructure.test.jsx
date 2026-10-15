import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  dateKey, sortMaterial, materialYears, filterMaterial, latestRevenueSummary, latestQuarterSummary,
  latestDividendSummary, dividendTotal, sortDividends, dataStatus, stocksStatus, fmtNum, fmtPct,
  fmtSignedPct, fmtMillions, trend,
} from './irData.js';
import { useSectionNav, rememberedSection } from '../../hooks/useSectionNav.js';
import { IR_SECTION_IDS } from './irSections.js';

describe('irData — 日期用數字比較，不用字串排序', () => {
  it('dateKey 解析 YYYY-MM-DD、YYYY/M、YYYY，無法解析回傳 0', () => {
    expect(dateKey('2026-09-10')).toBe(20260910);
    expect(dateKey('2026/9')).toBe(20260900);
    expect(dateKey(2025)).toBe(20250000);
    expect(dateKey('abc')).toBe(0);
    expect(dateKey(undefined)).toBe(0);
  });

  it('sortMaterial 新→舊；日期格式不一致（2026-9-1 vs 2026-09-02）也排得對', () => {
    const sorted = sortMaterial([{ date: '2026-9-1' }, { date: '2026-09-02' }, { date: '2025-12-31' }, { date: '' }]);
    expect(sorted.map(r => r.date)).toEqual(['2026-09-02', '2026-9-1', '2025-12-31', '']);
    expect(sortMaterial(null)).toEqual([]);
  });

  it('materialYears／filterMaterial', () => {
    const rows = [{ code: '2451', date: '2026-01-01' }, { code: '3260', date: '2025-05-05' }, { code: '2451', date: '2025-06-06' }];
    expect(materialYears(rows)).toEqual([2026, 2025]);
    expect(filterMaterial(rows, { code: '2451', year: '2025' })).toEqual([rows[2]]);
    expect(filterMaterial(rows, {})).toHaveLength(3);
  });
});

describe('irData — 最新營收／財報／股利', () => {
  it('月營收：月增率對上個月、年增率對去年同月；1 月的月增率對的是前一年 12 月', () => {
    const rev = [
      { year: 2025, month: 12, revenue: 100 }, { year: 2025, month: 1, revenue: 50 },
      { year: 2026, month: 1, revenue: 120 },
    ];
    const s = latestRevenueSummary(rev);
    expect(s).toMatchObject({ year: 2026, month: 1, revenue: 120, mom: 20, yoy: 140 });
  });

  it('沒有上個月／去年同月資料時，增率是 null（不是 0）；亂序輸入也取到最新的月份', () => {
    const s = latestRevenueSummary([{ year: 2026, month: 3, revenue: 10 }, { year: 2024, month: 1, revenue: 5 }]);
    expect(s).toMatchObject({ year: 2026, month: 3, mom: null, yoy: null });
    expect(latestRevenueSummary([])).toBeNull();
    expect(latestRevenueSummary(null)).toBeNull();
    expect(latestRevenueSummary([{ year: 2026, month: 3, revenue: 'abc' }])).toBeNull();
  });

  it('上個月營收為 0 時月增率是 null（避免除以 0／無限大）', () => {
    expect(latestRevenueSummary([{ year: 2026, month: 2, revenue: 0 }, { year: 2026, month: 3, revenue: 10 }]).mom).toBeNull();
  });

  it('財報取最新一季；0、空值的利潤率是 null（顯示「—」），EPS 為 0 仍是 0', () => {
    const q = latestQuarterSummary([
      { date: '2025-12-31', eps: 9, grossMargin: 50 },
      { date: '2026-03-31', eps: 0, grossMargin: 0, opMargin: null, netMargin: '12.5' },
    ]);
    expect(q).toEqual({ date: '2026-03-31', grossMargin: null, opMargin: null, netMargin: 12.5, eps: 0 });
    expect(latestQuarterSummary([])).toBeNull();
  });

  it('dividendTotal：字串金額先轉成數字再相加；優先用 totalDividend；缺值為 0', () => {
    expect(dividendTotal({ cashDividend: '4', stockDividend: '1' })).toBe(5);
    expect(dividendTotal({ cashDividend: 4, stockDividend: 1, totalDividend: 6 })).toBe(6);
    expect(dividendTotal({})).toBe(0);
    expect(dividendTotal({ cashDividend: 'x' })).toBe(0);
  });

  it('股利依年度數字排序，最新年度摘要的 0 值是 null', () => {
    const rows = [{ year: 2024, cashDividend: 5 }, { year: '2025', cashDividend: 0, stockDividend: 0 }];
    expect(sortDividends(rows).map(r => r.year)).toEqual(['2025', 2024]);
    expect(latestDividendSummary(rows)).toMatchObject({ year: '2025', cash: null, stock: null, total: null });
    expect(latestDividendSummary([])).toBeNull();
  });
});

describe('irData — 資料狀態與格式化', () => {
  it('dataStatus：null=更新中、失敗優先、空=尚無資料、過期、正常', () => {
    expect(dataStatus(null)).toBe('loading');
    expect(dataStatus(undefined)).toBe('loading');
    expect(dataStatus([], {})).toBe('empty');
    expect(dataStatus({}, {})).toBe('empty');
    expect(dataStatus([1])).toBe('ok');
    expect(dataStatus([1], { stale: true })).toBe('stale');
    expect(dataStatus(null, { hasError: true })).toBe('error');
    expect(dataStatus([1], { hasError: true })).toBe('error');
  });

  it('stocksStatus：尚未收到=更新中；收完仍沒有=尚無資料；失敗優先', () => {
    expect(stocksStatus({})).toBe('loading');
    expect(stocksStatus({}, { receivedAny: true })).toBe('empty');
    expect(stocksStatus({}, { hasError: true })).toBe('error');
    expect(stocksStatus({ '2451': { updatedAt: { toDate: () => new Date() } } })).toBe('ok');
  });

  it('格式化：缺值一律是「—」，不會出現 NaN／undefined／0', () => {
    for (const bad of [null, undefined, '', 'abc', NaN]) {
      expect(fmtNum(bad)).toBe('—');
      expect(fmtPct(bad)).toBe('—');
      expect(fmtSignedPct(bad)).toBe('—');
      expect(fmtMillions(bad)).toBe('—');
      expect(trend(bad)).toBe('none');
    }
    expect(fmtNum(1234.5)).toBe('1,234.50');
    expect(fmtSignedPct(2.5)).toBe('+2.50%');
    expect(fmtSignedPct(-1.2)).toBe('-1.20%');
    expect(fmtSignedPct(0)).toBe('0.00%');
    expect(fmtPct(12.34)).toBe('12.3%');
    expect(fmtMillions(1320e6)).toBe('1,320 百萬元');
    expect([trend(1), trend(-1), trend(0)]).toEqual(['up', 'down', 'flat']);
  });
});

describe('useSectionNav — PR 與 IR 各自記住子頁', () => {
  it('記住每個主分頁最後的子頁；預設子頁不記（回到網址乾淨的預設）', () => {
    window.history.replaceState(null, '', '/?tab=ir');
    const ir = renderHook(() => useSectionNav('ir', IR_SECTION_IDS, 'overview'));
    expect(ir.result.current[0]).toBe('overview');
    expect(rememberedSection('ir')).toBeNull();
    act(() => ir.result.current[1]('financials'));
    expect(ir.result.current[0]).toBe('financials');
    expect(rememberedSection('ir')).toBe('financials');
    expect(rememberedSection('pr')).toBeNull();          // 不會覆蓋 PR 的
    act(() => ir.result.current[1]('overview'));
    expect(rememberedSection('ir')).toBeNull();
    ir.unmount();
  });
});

// ═══════════════════════════════════════════════════════════
// 靜態檢查：IR 子頁只做「顯示」，不能自己碰 Firestore、也不能自己開計時器
// ═══════════════════════════════════════════════════════════
const sources = import.meta.glob('./*.{js,jsx}', { query: '?raw', import: 'default', eager: true });
const productionSources = Object.entries(sources).filter(([name]) => !/\.test\./.test(name));

describe('IR 程式碼結構', () => {
  it('掃描涵蓋所有 IR 檔案', () => {
    expect(productionSources.length).toBeGreaterThan(18);
  });

  it('IR 畫面程式不直接使用 Firestore、不建立 setInterval／setTimeout', () => {
    for (const [name, text] of productionSources) {
      expect(text, `${name} 不應碰 Firestore`).not.toMatch(/onSnapshot|getDoc\(|services\/firebase|firebase\/firestore/);
      expect(text, `${name} 不應自己建立計時器`).not.toMatch(/setInterval|setTimeout/);
    }
  });

  it('IRTab 只是外殼（不再把所有區塊塞在同一個檔案）', () => {
    const tab = sources['./IRTab.jsx'];
    expect(tab.split('\n').length).toBeLessThan(80);
    expect(tab).not.toMatch(/function (StockCard|RevenueChart|QuarterlyPnL|DividendHistory|CompetitorMaterial)/);
  });

  it('每個 IR 元件檔都有被引用（沒有留下失效的舊程式碼）', () => {
    const all = productionSources.map(([, text]) => text).join('\n');
    for (const [name] of productionSources) {
      const base = name.replace('./', '').replace(/\.(jsx|js)$/, '');
      if (base === 'IRTab') continue;     // 由 App 引用
      expect(all, `${base} 沒有被引用`).toMatch(new RegExp(`/${base}(\\.jsx?)?['"]`));
    }
  });
});
