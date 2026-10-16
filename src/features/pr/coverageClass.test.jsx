import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const exportExposurePerformanceExcel = vi.fn();
vi.mock('../../utils/formatting.js', () => ({
  exportExposurePerformanceExcel: (...args) => exportExposurePerformanceExcel(...args),
}));

import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';
import { PROverview } from './PROverview.jsx';
import {
  toPublicRecord, toPublicRecords, coverageOf, hasCoverageData, defaultCoverageFilter, filterByCoverage, countByCoverage,
  coverageScopeText, buildPerformance, groupByTopic, buildDetailRows, COVERAGE_FILTERS,
} from './exposurePerformance.js';

const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);
const NOTE = '內部備註-絕不外流';

function raw(id, day, title, cls, extra = {}) {
  return {
    id, exposureDate: tw(2026, 9, day), mediaName: `媒體${id}`, reporter: '', title, link: `https://example.com/${id}`,
    exposureType: 'online', coverageClass: cls, coverageClassMethod: cls ? 'rule' : undefined, coverageClassConfidence: cls ? 0.85 : undefined,
    noteInternal: NOTE, sources: [{ file: 'secret.xlsx' }], ...extra,
  };
}

// 派生 3（2 組）、公司 2、產業 2、待確認 1、不相關 1
const RECORDS = [
  raw('d1', 1, '創見9月營收60.4億元', 'press_release_derived', { matchStatus: 'auto_matched', pressReleaseId: 'pr9', pressReleaseTitle: '9月營收' }),
  raw('d2', 2, '創見 9 月營收年增 290%', 'press_release_derived', { matchStatus: 'auto_matched', pressReleaseId: 'pr9', pressReleaseTitle: '9月營收' }),
  raw('d3', 3, '創見推出 DDR5 7200', 'press_release_derived', { matchStatus: 'confirmed', pressReleaseId: 'pr_ddr', pressReleaseTitle: 'DDR5 7200 新品' }),
  raw('c1', 4, '創見董座談產業', 'company_coverage', { matchStatus: 'unmatched' }),
  raw('c2', 5, '創見4月營收創高', 'company_coverage', { matchStatus: 'unmatched' }),
  raw('i1', 6, '威剛與創見營收齊創高', 'industry_related', { matchStatus: 'unmatched' }),
  raw('i2', 7, '新門取得創見股票400張', 'industry_related', { matchStatus: 'unmatched' }),
  raw('r1', 8, '創見參展 COMPUTEX 2026', 'review', { matchStatus: 'suggested', suggestedPressReleaseTitle: 'COMPUTEX' }),
  raw('u1', 9, '創見文化事業新書', 'unrelated', { matchStatus: 'unmatched' }),
];
const pub = rows => toPublicRecords(rows);

beforeEach(() => { exportExposurePerformanceExcel.mockClear(); });

describe('曝光分類 — 資料層', () => {
  it('toPublicRecord 只收白名單的分類值', () => {
    const r = toPublicRecord(raw('x', 1, 't', 'company_coverage'));
    expect(r).toMatchObject({ coverageClass: 'company_coverage', coverageMethod: 'rule', coverageConfidence: 0.85 });
    expect(toPublicRecord(raw('y', 1, 't', 'hacked')).coverageClass).toBe('');
    expect(toPublicRecord({ ...raw('z', 1, 't', 'review'), coverageClassMethod: 'evil' }).coverageMethod).toBe('');
    expect(toPublicRecord({ ...raw('w', 1, 't', 'review'), coverageClassConfidence: null }).coverageConfidence).toBeNull();
  });

  it('分類與配對狀態是兩個獨立欄位：建議配對不會變成新聞稿衍生曝光', () => {
    const records = pub(RECORDS);
    const suggested = records.find(r => r.id === 'r1');
    expect(suggested.matchStatus).toBe('suggested');
    expect(coverageOf(suggested)).toBe('review');
    expect(suggested.campaignId).toBe('');
    // 未配對（unmatched）可以是一般公司報導
    expect(coverageOf(records.find(r => r.id === 'c1'))).toBe('company_coverage');
  });

  it('沒有分類欄位的舊資料：人工確認／自動配對視為衍生，其他算待確認；預設範圍是全部', () => {
    const old = pub([raw('a', 1, 't', undefined, { matchStatus: 'auto_matched' }), raw('b', 2, 't2', undefined, { matchStatus: 'unmatched' }), raw('c', 3, 't3', undefined)]);
    expect(hasCoverageData(old)).toBe(false);
    expect(defaultCoverageFilter(old)).toBe('all');
    expect(old.map(coverageOf)).toEqual(['press_release_derived', 'review', 'review']);
  });

  it('預設範圍＝新聞稿衍生曝光；篩選與計數', () => {
    const records = pub(RECORDS);
    expect(defaultCoverageFilter(records)).toBe('derived');
    expect(countByCoverage(records)).toEqual({ derived: 3, company: 2, industry: 2, review: 1, unrelated: 1 });
    expect(filterByCoverage(records, 'derived').map(r => r.id)).toEqual(['d1', 'd2', 'd3']);
    expect(filterByCoverage(records, 'all')).toHaveLength(9);
    expect(filterByCoverage(records, 'unrelated').map(r => r.id)).toEqual(['u1']);
    expect(Object.values(COVERAGE_FILTERS)).toEqual(['全部', '新聞稿衍生曝光', '一般公司報導', '產業連帶報導', '待確認', '不相關']);
  });

  it('正式 KPI 只算衍生曝光：suggested／review／公司／產業／不相關都不混入', () => {
    const records = pub(RECORDS);
    const official = buildPerformance(filterByCoverage(records, defaultCoverageFilter(records)));
    expect(official.total).toBe(3);
    expect(official.topicCount).toBe(2);
    expect(coverageScopeText('derived', official.total)).toBe('範圍：新聞稿衍生曝光（3 則）');
    expect(coverageScopeText('all', 9)).toContain('含各類報導');
    expect(buildPerformance(records).total).toBe(9);
  });

  it('Excel 明細有配對狀態、曝光分類、分類方法、信心程度，沒有備註與私人欄位', () => {
    const topics = groupByTopic(pub(RECORDS));
    const rows = buildDetailRows(topics);
    const r1 = rows.find(r => r.新聞標題 === '創見參展 COMPUTEX 2026');
    expect(r1).toMatchObject({ 配對狀態: '稿單建議配對', 曝光分類: '待確認', 分類方法: '規則', 信心程度: '85%（高）' });
    expect(rows.find(r => r.新聞標題 === '創見9月營收60.4億元')).toMatchObject({ 配對狀態: '稿單自動配對', 曝光分類: '新聞稿衍生曝光' });
    const dump = JSON.stringify(rows);
    for (const bad of [NOTE, 'secret.xlsx', 'noteInternal']) expect(dump).not.toContain(bad);
  });
});

const renderPanel = (props = {}) => render(
  <ExposurePerformancePanel records={RECORDS} status="ready" onRetry={vi.fn()} sync={{ lastSyncAt: tw(2026, 9, 9, 6) }} {...props} />);
const kpi = label => screen.getByText(label, { selector: 'p' }).nextElementSibling.textContent;

describe('曝光分類 — 曝光成效面板', () => {
  it('預設只計算新聞稿衍生曝光，並明確標示統計範圍與其他分類數量', () => {
    renderPanel();
    expect(kpi('人工彙整曝光')).toBe('3');
    expect(screen.getByTestId('coverage-scope').textContent).toBe('範圍：新聞稿衍生曝光（3 則）');
    const box = screen.getByTestId('coverage-filter');
    expect(box.textContent).toContain('只計算「新聞稿衍生曝光」');
    expect(box.textContent).toContain('一般公司報導 2');
    expect(box.textContent).toContain('產業連帶報導 2');
    expect(box.textContent).toContain('待確認 1');
    expect(box.textContent).toContain('不相關 1');
    // 列表只有衍生曝光的主題，沒有混入其他報導
    expect(screen.queryByText('創見董座談產業')).toBeNull();
    expect(screen.queryByText('創見文化事業新書')).toBeNull();
    expect(screen.getByText('9月營收')).toBeTruthy();
  });

  it('六種分類篩選：全部／新聞稿衍生曝光／一般公司報導／產業連帶報導／待確認／不相關', () => {
    renderPanel();
    const group = within(screen.getByTestId('coverage-filter')).getByRole('group', { name: '曝光分類篩選' });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual([
      '全部 9', '新聞稿衍生曝光 3', '一般公司報導 2', '產業連帶報導 2', '待確認 1', '不相關 1']);
    const expectKpi = (name, total) => {
      fireEvent.click(within(group).getByRole('button', { name }));
      expect(kpi('人工彙整曝光')).toBe(String(total));
    };
    expectKpi('全部 9', 9);
    expect(screen.getByTestId('coverage-scope').textContent).toContain('含各類報導');
    expectKpi('一般公司報導 2', 2);
    expect(screen.getByText('創見董座談產業')).toBeTruthy();
    expectKpi('產業連帶報導 2', 2);
    expectKpi('待確認 1', 1);
    expectKpi('不相關 1', 1);
    expect(screen.getByText('創見文化事業新書')).toBeTruthy();
    expectKpi('新聞稿衍生曝光 3', 3);
  });

  it('分類篩選在 Excel 匯出時一起生效（匯出目前看到的範圍）', () => {
    renderPanel();
    fireEvent.click(within(screen.getByTestId('coverage-filter')).getByRole('button', { name: '一般公司報導 2' }));
    fireEvent.click(screen.getByText(/匯出新聞稿成效/));
    const { detailRows } = exportExposurePerformanceExcel.mock.calls.at(-1)[0];
    expect(detailRows.map(r => r.曝光分類)).toEqual(['一般公司報導', '一般公司報導']);
    expect(JSON.stringify(detailRows)).not.toContain(NOTE);
  });

  it('還沒有任何分類資料時：沿用舊的全部顯示，不顯示分類篩選', () => {
    const old = RECORDS.map(r => ({ ...r, coverageClass: undefined, coverageClassMethod: undefined, coverageClassConfidence: undefined }));
    renderPanel({ records: old });
    expect(screen.queryByTestId('coverage-filter')).toBeNull();
    expect(kpi('人工彙整曝光')).toBe('9');
  });

  it('備註、來源檔名不會出現在畫面；沒有修改分類的按鈕', () => {
    renderPanel();
    fireEvent.click(within(screen.getByTestId('coverage-filter')).getByRole('button', { name: '全部 9' }));
    screen.getAllByRole('button', { expanded: false }).forEach(b => fireEvent.click(b));
    expect(document.body.textContent).not.toContain(NOTE);
    expect(document.body.textContent).not.toContain('secret.xlsx');
    expect(screen.queryByRole('button', { name: /修改分類|設為|標記為|人工分類/ })).toBeNull();
  });
});

describe('曝光分類 — PR 總覽', () => {
  it('總覽的新聞稿曝光成效摘要也只算新聞稿衍生曝光，並標示範圍', () => {
    render(<PROverview news={[]} validTranscend={[]} prStatus="ready" refreshPRNews={vi.fn()}
      mediaExposure={RECORDS} mediaExposureStatus="ready" refreshMediaExposure={vi.fn()} onNavigate={vi.fn()} />);
    const scope = screen.getByTestId('overview-exposure-scope');
    expect(scope.textContent).toBe('範圍：新聞稿衍生曝光（3 則）');
    const card = scope.closest('.bg-gray-900');
    expect(within(card).getByText('人工彙整曝光').nextElementSibling.textContent).toBe('3');
  });
});

// 靜態檢查：前端沒有任何分類寫入入口
const sources = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/*.test.*'], { query: '?raw', import: 'default', eager: true });
describe('曝光分類 — 程式碼結構', () => {
  it('前端不會寫 coverageClass，也沒有 Firestore 寫入 API', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(60);
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch)\b/);
      if (!name.endsWith('exposurePerformance.js')) expect(text, `${name} 不應處理 coverageClass 寫入`).not.toMatch(/coverageClass\s*:\s*['"]/);
    }
  });
});
