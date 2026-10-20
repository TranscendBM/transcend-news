import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { brandExposureCounts } from './prData.js';
import { CompetitorNews } from './CompetitorNews.jsx';
import { PRStateProvider } from './prState.jsx';

const NOW = new Date('2026-07-15T04:00:00Z'); // 台灣 7/15 12:00（週三）
const art = (id, brand, iso, extra = {}) => ({ id, title: `${brand} 報導 ${id}`, cat: 'competitor', brand, mediaName: '媒體', pubDate: new Date(iso), ...extra });
const NEWS = [
  art('a1', 'ADATA', '2026-07-15T02:00:00Z'),                 // 今天
  art('a2', 'ADATA', '2026-07-14T02:00:00Z'),                 // 本週、本月
  art('a3', 'ADATA', '2026-06-20T02:00:00Z'),                 // 上月
  art('i1', 'Innodisk', '2026-07-02T02:00:00Z'),              // 本月
  art('c1', 'ADATA', '2026-07-15T01:00:00Z', { mediaName: 'CMoney' }), // 排除
  { ...art('x', 'ADATA', '2026-07-15T02:00:00Z'), cat: 'usMarket' },   // 非競品
];

describe('各品牌新聞曝光數量', () => {
  it('依品牌與期間計數，排除 CMoney 與非競品，合計列與清單一致', () => {
    const rows = Object.fromEntries(brandExposureCounts(NEWS, NOW).map(r => [r.id, r.counts]));
    expect(rows.ADATA).toEqual({ today: 1, week: 2, month: 2, lastMonth: 1 });
    expect(rows.Innodisk).toEqual({ today: 0, week: 0, month: 1, lastMonth: 0 });
    expect(rows.Apacer).toEqual({ today: 0, week: 0, month: 0, lastMonth: 0 });
    expect(rows.all).toEqual({ today: 1, week: 2, month: 3, lastMonth: 1 });
  });

  it('表格顯示數字，點品牌與期間會套用到下方清單', () => {
    render(<PRStateProvider><CompetitorNews news={NEWS.map(n => ({ ...n, pubDate: new Date(n.pubDate.getTime() + (Date.now() - NOW.getTime())) }))} /></PRStateProvider>);
    const table = screen.getByTestId('brand-exposure');
    for (const label of ['今天', '本週', '本月', '上月', '全部品牌']) expect(within(table).getByText(label)).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: /Innodisk/ }));
    expect(within(table).getByRole('button', { name: /Innodisk/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(table).getByRole('button', { name: '上月' }));
    expect(within(table).getByRole('button', { name: '上月' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('競品官網最新消息連結', () => {
  it('每個競品列都有另開分頁的官網最新消息連結，合計列沒有', () => {
    render(<PRStateProvider><CompetitorNews news={[]} /></PRStateProvider>);
    const links = within(screen.getByTestId('brand-exposure')).getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });
});
