import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const exportExposureInsightsExcel = vi.fn();
vi.mock('../../utils/formatting.js', () => ({
  exportExposureInsightsExcel: (...args) => exportExposureInsightsExcel(...args),
}));

import ExposureInsightsPage from './ExposureInsightsPage.jsx';

const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);
function rec(id, date, media, reporter, title) {
  return { id, exposureDate: date, mediaName: media, reporter, title, link: 'https://example.com/' + id, exposureType: 'online' };
}
const RECORDS = [
  rec('a1', tw(2026, 7, 6), '經濟日報', '王一', '創見6月營收創新高'),
  rec('a2', tw(2026, 7, 6), '鉅亨網', '李二', '創見營收年增381%'),
  rec('a3', tw(2026, 7, 6), '非凡新聞', '', '創見營收公告'),
  rec('a4', tw(2026, 7, 20), '經濟日報', '王一', '創見推出新品固態硬碟'),
  rec('b1', tw(2026, 8, 5), '經濟日報', '王一', '創見7月營收'),
  rec('b2', tw(2026, 8, 5), '鉅亨網', '李二', '創見7月營收年增'),
  rec('b3', tw(2026, 8, 20), '工商時報', '張三', '創見與研華攜手推出嵌入式鏡頭'),
  rec('c1', tw(2026, 9, 3), '經濟日報', '王一', '創見DRAM報價看漲'),
  rec('c2', tw(2026, 9, 3), '時報資訊', '趙四、錢五', '記憶體缺貨 創見受惠'),
  rec('c3', tw(2026, 9, 10), '工商時報', '張三', '創見公告庫藏股'),
];

function renderPage(props = {}) {
  return render(<ExposureInsightsPage records={RECORDS} autoArticles={[]} onBack={vi.fn()} {...props} />);
}
const tab = name => screen.getByRole('button', { name });

beforeEach(() => { exportExposureInsightsExcel.mockClear(); });

describe('ExposureInsightsPage', () => {
  it('標頭顯示期間與規模，並有返回與匯出按鈕', () => {
    const onBack = vi.fn();
    renderPage({ onBack });
    expect(screen.getByText('人工確認曝光分析')).toBeTruthy();
    expect(screen.getByText(/共 10 篇・5 家媒體・5 位記者/)).toBeTruthy();
    fireEvent.click(screen.getByText('← 返回 PR 媒體戰情'));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('⬇ 匯出分析 Excel'));
    expect(exportExposureInsightsExcel).toHaveBeenCalledTimes(1);
    expect(exportExposureInsightsExcel.mock.calls[0][0].total).toBe(10);
  });

  it('預設是「總覽」：重點發現、KPI、每月篇數表（新到舊）', () => {
    renderPage();
    expect(screen.getByText('重點發現')).toBeTruthy();
    expect(screen.getByText(/經濟日報 是最大曝光來源/)).toBeTruthy();
    const monthsTable = screen.getByText('每月曝光篇數').closest('.bg-gray-900').querySelector('table');
    const rows = [...monthsTable.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
    expect(rows[0].slice(0, 2)).toEqual(['2026-09', '3']);
    expect(rows[1].slice(0, 3)).toEqual(['2026-08', '3', '-25%']);
    expect(rows[2].slice(0, 2)).toEqual(['2026-07', '4']);
    expect(screen.getByText('📋 複製圖表')).toBeTruthy();
  });

  it('媒體分頁：每月熱度表與合計、佔比、主力記者', () => {
    renderPage();
    fireEvent.click(tab('媒體'));
    const row = screen.getByText('經濟日報').closest('tr');
    const cells = [...row.querySelectorAll('td')].map(td => td.textContent);
    expect(cells[0]).toBe('經濟日報');
    expect(cells.slice(2, 5)).toEqual(['2', '1', '1']);          // 7、8、9 月
    expect(cells[5]).toBe('4');                                  // 合計
    expect(row.textContent).toContain('王一（100%）');
  });

  it('記者分頁：共同署名各算一篇，可用狀態篩選', () => {
    renderPage();
    fireEvent.click(tab('記者'));
    expect(screen.getByText('錢五')).toBeTruthy();
    fireEvent.click(screen.getByText('穩定（每月都有）'));
    expect(screen.getByText('王一')).toBeTruthy();
    expect(screen.queryByText('錢五')).toBeNull();
    fireEvent.click(screen.getByText('本月新增'));
    expect(screen.getByText('錢五')).toBeTruthy();
    expect(screen.queryByText('王一')).toBeNull();
    expect(screen.getByText(/未署名報導/)).toBeTruthy();
  });

  it('關係變化分頁：本月 vs 上月新增／流失', () => {
    renderPage();
    fireEvent.click(tab('關係變化'));
    expect(screen.getByText('2026/9 相較 2026/8 的變化')).toBeTruthy();
    const card = screen.getByText('2026/9 相較 2026/8 的變化').closest('.bg-gray-900');
    expect(within(card).getAllByText('時報資訊').length).toBeGreaterThan(0);   // 9 月首次出現的媒體
    expect(within(card).getAllByText('李二').length).toBeGreaterThan(0);       // 9 月沒出現的記者
  });

  it('題材與高峰分頁：題材 × 月份矩陣與高峰日', () => {
    renderPage();
    fireEvent.click(tab('題材與高峰'));
    expect(screen.getAllByText('營收・財報').length).toBeGreaterThan(0);
    expect(screen.getByText('2026-07-06')).toBeTruthy();       // 3 篇的高峰日
  });

  it('自動監測比對分頁：沒有資料時說明原因；有資料時顯示涵蓋率與漏網清單', () => {
    // 只有 7 月的紀錄，超出自動監測保留範圍（本月＋上個月）
    const { unmount } = renderPage({ records: RECORDS.slice(0, 4) });
    fireEvent.click(tab('自動監測比對'));
    expect(screen.getByText(/目前沒有可比對的資料/)).toBeTruthy();
    unmount();

    const now = new Date();
    const records = [
      rec('n1', now, '經濟日報', '王一', '本月曝光一'),
      rec('n2', now, '鉅亨網', '李二', '本月曝光二'),
    ];
    render(<ExposureInsightsPage records={records}
      autoArticles={[{ title: '本月曝光一', link: 'https://x.com/1', pubDate: now }]} />);
    fireEvent.click(tab('自動監測比對'));
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('本月曝光二')).toBeTruthy();       // 自動監測沒抓到的
  });

  it('沒有資料時顯示空狀態，匯出按鈕停用', () => {
    renderPage({ records: [] });
    expect(screen.getByText('尚無資料')).toBeTruthy();
    expect(screen.getByText('⬇ 匯出分析 Excel').disabled).toBe(true);
  });
});
