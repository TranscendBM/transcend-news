import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import { exportNewsExcel } from './formatting.js';

// 只 mock 真的會操作檔案系統／觸發瀏覽器下載的部分（writeFile），
// json_to_sheet / book_new / book_append_sheet 都是 xlsx 真正的資料轉換
// 邏輯，直接使用，才能驗證 exportNewsExcel 餵給它的資料格狀正確。
vi.mock('xlsx', async () => {
  const actual = await vi.importActual('xlsx');
  return { ...actual, writeFile: vi.fn() };
});

describe('exportNewsExcel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does nothing when there are no articles', () => {
    exportNewsExcel([], '創見最新報導', '創見最新報導');
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });

  it('builds a sheet with the expected Chinese column headers and row values', () => {
    const articles = [{
      title: '創見資訊發布新品',
      mediaName: '經濟日報',
      pubDate: new Date('2026-07-20T03:00:00Z'),
      sentiment: 'positive',
      link: 'https://example.com/a1',
    }];

    exportNewsExcel(articles, '創見最新報導', '創見最新報導');

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

  it('falls back to a computed sentiment label when the article has none stored', () => {
    const articles = [{
      title: '威剛虧損擴大',
      content: '威剛虧損擴大財報',
      pubDate: new Date('2026-07-20T03:00:00Z'),
    }];
    exportNewsExcel(articles, '競品動態', '競品動態');
    const [wb] = XLSX.writeFile.mock.calls[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    expect(rows[0].情緒).toBe('負面');
  });
});
