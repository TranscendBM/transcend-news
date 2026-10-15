import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import { exportNewsExcel, exportMediaExposureExcel, exportExposureInsightsExcel, exportExposurePerformanceExcel } from './formatting.js';
import { buildExposureInsights } from '../features/pr/exposureInsights.js';
import { buildDetailRows, buildSummaryRows, groupByTopic, toPublicRecords, PRIVATE_FIELD_NAMES } from '../features/pr/exposurePerformance.js';

// 只 mock 真的會操作檔案系統／觸發瀏覽器下載的部分（writeFile），
// json_to_sheet / book_new / book_append_sheet 都是 xlsx 真正的資料轉換
// 邏輯，直接使用，才能驗證 exportNewsExcel 餵給它的資料格狀正確。
vi.mock('xlsx', async () => {
  const actual = await vi.importActual('xlsx');
  return { ...actual, writeFile: vi.fn() };
});

describe('exportNewsExcel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does nothing when there are no articles', async () => {
    await exportNewsExcel([], '創見最新報導', '創見最新報導');
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });

  it('builds a sheet with the expected Chinese column headers and row values', async () => {
    const articles = [{
      title: '創見資訊發布新品',
      mediaName: '經濟日報',
      pubDate: new Date('2026-07-20T03:00:00Z'),
      sentiment: 'positive',
      link: 'https://example.com/a1',
    }];

    await exportNewsExcel(articles, '創見最新報導', '創見最新報導');

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    const sheetName = wb.SheetNames[0];
    expect(sheetName).toBe('創見最新報導');

    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);
    expect(rows).toEqual([{
      標題: '創見資訊發布新品',
      媒體: '經濟日報',
      日期: expect.any(String),
      情緒: '正面',
      連結: 'https://example.com/a1',
    }]);

    expect(filename).toMatch(/^創見最新報導_\d{8}\.xlsx$/);
  });

  it('falls back to a computed sentiment label when the article has none stored', async () => {
    const articles = [{
      title: '威剛虧損擴大',
      content: '威剛虧損擴大財報',
      pubDate: new Date('2026-07-20T03:00:00Z'),
    }];
    await exportNewsExcel(articles, '競品動態', '競品動態');
    const [wb] = XLSX.writeFile.mock.calls[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    expect(rows[0].情緒).toBe('負面');
  });

  it('adds extra columns between 情緒 and 連結', async () => {
    const articles = [{ title: 'Micron 擴產', mediaName: 'Reuters', link: 'https://example.com/m', sentiment: 'neutral', pubDate: new Date('2026-09-10T03:00:00Z') }];
    await exportNewsExcel(articles, '上游市場新聞', '上游市場新聞_上月', { 品牌: () => 'Micron' });
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
    expect(header).toEqual(['標題', '媒體', '日期', '情緒', '品牌', '連結']);
    expect(XLSX.utils.sheet_to_json(sheet)[0].品牌).toBe('Micron');
    expect(filename).toMatch(/^上游市場新聞_上月_\d{8}\.xlsx$/);
  });
});

describe('exportMediaExposureExcel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('exports only public exposure fields and never includes an internal note', async () => {
    await exportMediaExposureExcel([{
      title: '創見新品人工確認曝光',
      mediaName: '經濟日報',
      reporter: '王記者',
      exposureDate: new Date('2026-08-03T03:00:00Z'),
      exposureType: 'online',
      link: 'https://example.com/manual',
      noteInternal: '不可公開的內部備註',
    }]);

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['人工確認曝光']);
    expect(rows).toEqual([{
      日期: expect.any(String),
      媒體: '經濟日報',
      記者: '王記者',
      新聞標題: '創見新品人工確認曝光',
      曝光類型: 'online',
      連結: 'https://example.com/manual',
    }]);
    expect(JSON.stringify(rows)).not.toContain('不可公開的內部備註');
    expect(filename).toMatch(/^人工確認曝光_\d{8}\.xlsx$/);
  });
});

describe('exportExposureInsightsExcel', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const tw = (m, d) => new Date(Date.UTC(2026, m - 1, d, 4));
  const ins = buildExposureInsights([
    { exposureDate: tw(7, 6), mediaName: '經濟日報', reporter: '王一', title: '創見營收創新高', link: 'https://e.com/1' },
    { exposureDate: tw(8, 5), mediaName: '經濟日報', reporter: '王一', title: '創見7月營收', link: 'https://e.com/2' },
    { exposureDate: tw(8, 6), mediaName: '鉅亨網', reporter: '', title: '創見新品', link: 'https://e.com/3' },
  ]);

  it('沒有資料時不下載', async () => {
    await exportExposureInsightsExcel(buildExposureInsights([]));
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });

  it('輸出月趨勢、媒體×月、記者×月、題材×月四張工作表，月份是欄位', async () => {
    await exportExposureInsightsExcel(ins);
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    expect(wb.SheetNames).toEqual(['月趨勢', '媒體×月', '記者×月', '題材×月']);
    expect(filename).toMatch(/^人工確認曝光分析_\d{8}\.xlsx$/);

    const media = XLSX.utils.sheet_to_json(wb.Sheets['媒體×月']);
    expect(media[0]).toMatchObject({ 媒體: '經濟日報', '2026-07': 1, '2026-08': 1, 合計: 2, 主力記者: '王一' });
    const reporters = XLSX.utils.sheet_to_json(wb.Sheets['記者×月']);
    expect(reporters).toHaveLength(1);                 // 未署名不列入記者表
    const monthly = XLSX.utils.sheet_to_json(wb.Sheets['月趨勢']);
    expect(monthly.map(m => m.曝光篇數)).toEqual([1, 2]);
  });
});

describe('exportExposurePerformanceExcel', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const day = d => new Date(Date.UTC(2026, 8, d, 4));
  const topics = groupByTopic(toPublicRecords([
    { id: '1', exposureDate: day(1), mediaName: '經濟日報', reporter: '王一', title: '創見推出新品', link: 'https://e.com/1',
      exposureType: 'online', noteInternal: '內部備註不可外流', file: 'secret.xlsx', sheet: '09', row: 7, rawLink: 'https://raw.e.com' },
    { id: '2', exposureDate: day(2), mediaName: '=EVIL()', reporter: '', title: '創見推出新品', link: 'javascript:alert(1)',
      exposureType: 'video' },
  ]));

  it('沒有明細時不下載', async () => {
    await exportExposurePerformanceExcel({ summaryRows: [], detailRows: [] });
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });

  it('全部篩選結果：兩張工作表（主題彙整、曝光明細），欄位固定且不含私人欄位與公式', async () => {
    await exportExposurePerformanceExcel({ summaryRows: buildSummaryRows(topics), detailRows: buildDetailRows(topics) });
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    expect(wb.SheetNames).toEqual(['主題彙整', '曝光明細']);
    expect(filename).toMatch(/^新聞稿曝光成效_\d{8}\.xlsx$/);

    const summary = XLSX.utils.sheet_to_json(wb.Sheets['主題彙整']);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ '新聞稿／主題': '創見推出新品', 曝光總數: 2, 不重複媒體數: 2 });

    const detail = XLSX.utils.sheet_to_json(wb.Sheets['曝光明細']);
    expect(detail).toHaveLength(2);
    expect(Object.keys(detail[0])).toEqual(['新聞稿／主題', '配對依據', '配對狀態', '曝光分類', '分類方法', '信心程度', '日期', '媒體', '記者', '新聞標題', '曝光類型', '連結']);
    const raw = JSON.stringify(detail) + JSON.stringify(summary);
    [...PRIVATE_FIELD_NAMES, '內部備註', 'secret.xlsx', 'raw.e.com', 'javascript:'].forEach(s => expect(raw, s).not.toContain(s));
    // 公式注入：以 = 開頭的媒體名稱前面補了單引號，且儲存格是純文字（不是公式）
    const evil = detail.find(r => r.媒體.includes('EVIL'));
    expect(evil.媒體).toBe("'=EVIL()");
    const cell = Object.values(wb.Sheets['曝光明細']).find(c => c && c.v === "'=EVIL()");
    expect(cell.t).toBe('s');
    expect(cell.f).toBeUndefined();
  });

  it('單一主題：只有曝光明細一張工作表，檔名帶主題名稱（不合法字元已清掉）', async () => {
    await exportExposurePerformanceExcel({ detailRows: buildDetailRows([topics[0]]), suffix: '創見: 推出/新品?*' });
    const [wb, filename] = XLSX.writeFile.mock.calls[0];
    expect(wb.SheetNames).toEqual(['曝光明細']);
    expect(filename).toMatch(/^新聞稿曝光成效_創見_推出_新品_\d{8}\.xlsx$/);
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
  });
});
