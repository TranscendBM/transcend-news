import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const exportMatchReviewExcel = vi.fn();
const exportExposurePerformanceExcel = vi.fn();
vi.mock('../../utils/formatting.js', () => ({
  exportMatchReviewExcel: (...a) => exportMatchReviewExcel(...a),
  exportExposurePerformanceExcel: (...a) => exportExposurePerformanceExcel(...a),
}));

import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';
import MatchReviewPanel from './MatchReviewPanel.jsx';
import {
  toPublicRecords, groupByTopic, reviewStatusOf, selectReviewItems, filterReviewItems, countReviewStatuses, buildReviewRows,
  buildPressReleaseListRows, buildDetailRows, buildSummaryRows, MATCH_STATUS_LABELS, MATCH_KIND_LABELS, percentText,
} from './exposurePerformance.js';

const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);
const NOTE = '覆核備註-內部資訊-絕不外流';

function raw(id, month, day, title, extra = {}) {
  return {
    id, exposureDate: tw(2026, month, day), mediaName: `媒體${id.slice(-1)}`, reporter: '', title, link: `https://example.com/${id}`,
    exposureType: 'online', coverageClass: 'review', coverageClassMethod: 'fallback', coverageClassConfidence: 0.5,
    noteInternal: NOTE, note: NOTE, sources: [{ file: 'secret.xlsx' }], ...extra,
  };
}

const RECORDS = [
  raw('exp_auto1', 9, 13, '創見推64GB DDR5工業記憶體 搶攻邊緣AI', {
    coverageClass: 'press_release_derived', matchStatus: 'auto_matched', matchMethod: 'high_confidence_anchors', matchConfidence: 0.88,
    matchReason: '前後 1 天＋創見＋64GB＋DDR5＋工業記憶體', pressReleaseId: 'pr_d64', pressReleaseTitle: '創見推出64GB DDR5工業用記憶體',
  }),
  raw('exp_auto2', 9, 14, '創見推出64GB DDR5工業用記憶體 提升效能', {
    coverageClass: 'press_release_derived', matchStatus: 'auto_matched', matchMethod: 'exact_title', matchConfidence: 0.95,
    matchReason: '標題與新聞稿完全相同', pressReleaseId: 'pr_d64', pressReleaseTitle: '創見推出64GB DDR5工業用記憶體',
  }),
  raw('exp_sug1', 8, 12, '創見業績爆表加上參加自動化展新品齊發 早盤股價急拉漲停', {
    matchStatus: 'suggested', matchMethod: 'title_similarity', matchConfidence: 0.62, suggestedPressReleaseId: 'pr_auto',
    suggestedPressReleaseTitle: '創見資訊參展自動化展', matchReason: '標題與新聞稿相似度約 62%；未自動配對：同時包含股價與多個事件內容',
  }),
  raw('exp_sug2', 10, 13, '創見參加台北電子展 秀嵌入式鏡頭', {
    matchStatus: 'suggested', matchMethod: 'title_similarity', matchConfidence: 0.55, suggestedPressReleaseId: 'pr_expo',
    suggestedPressReleaseTitle: '創見參展台北國際電子展', matchReason: '標題與新聞稿相似度約 55%；未自動配對：只有 1 個明確關鍵字（需要至少 2 個）',
  }),
  raw('exp_unm1', 6, 3, '記憶體價格走揚！「這檔」H1每股賺46.63元', {
    matchStatus: 'unmatched', matchReason: '標題、日期與任何新聞稿的關鍵字都對不上（多半是一般報導）',
  }),
  raw('exp_conf1', 5, 5, '創見董事長談經營', {
    coverageClass: 'press_release_derived', matchStatus: 'confirmed', matchMethod: 'manual_confirm', matchConfidence: 1,
    matchReason: '人工確認配對（Google Sheet 覆核）', pressReleaseId: 'pr_x', pressReleaseTitle: '董事長談經營新聞稿', matchSource: 'google_sheet_review',
  }),
  raw('exp_rej1', 4, 4, '創見股價大漲 法人買超', {
    coverageClass: 'company_coverage', matchStatus: 'rejected', matchMethod: 'manual_reject', matchConfidence: 1,
    matchReason: '人工排除：不屬於任何新聞稿衍生曝光', matchSource: 'google_sheet_review',
  }),
  // 一般報導、股市評論：不在待確認區，也不被硬配給新聞稿
  raw('exp_gen1', 7, 7, '盤中速報 - 創見(2451)大漲7%', { coverageClass: 'company_coverage', matchStatus: 'unmatched', matchReason: '標題、日期與任何新聞稿的關鍵字都對不上' }),
  raw('exp_ind1', 7, 8, '威剛與創見營收齊創高', { coverageClass: 'industry_related', matchStatus: 'unmatched' }),
];
const SYNC = { lastSyncAt: tw(2026, 10, 15, 6), pressReleases: [{ id: 'pr_d64', title: '創見推出64GB DDR5工業用記憶體', date: '2026-09-14' }, { id: 'pr_expo', title: '創見參展台北國際電子展', date: '2026-10-13' }] };
const pub = () => toPublicRecords(RECORDS);

beforeEach(() => { exportMatchReviewExcel.mockClear(); exportExposurePerformanceExcel.mockClear(); });

describe('文案：人工彙整曝光 vs 人工確認配對', () => {
  it('資料集叫「人工彙整曝光」；只有 matchStatus=confirmed 才是「人工確認配對」', () => {
    expect(MATCH_STATUS_LABELS.confirmed).toBe('人工確認配對');
    expect(MATCH_KIND_LABELS.confirmed).toBe('人工確認配對');
    expect(MATCH_STATUS_LABELS.rejected).toBe('人工排除');
    render(<ExposurePerformancePanel records={RECORDS} status="ready" onRetry={vi.fn()} sync={SYNC} />);
    expect(screen.getByText('人工彙整曝光', { selector: 'p' })).toBeTruthy();           // KPI 名稱
    expect(document.body.textContent).not.toContain('人工確認曝光');
    const confirmedTopic = screen.getAllByText('人工確認配對').length;
    expect(confirmedTopic).toBeGreaterThan(0);
    // 自動配對的主題不會被標成人工確認配對
    const auto = screen.getByText('創見推出64GB DDR5工業用記憶體', { selector: 'p' }).closest('[class~="bg-gray-800/40"]');
    expect(within(auto).queryByText('人工確認配對')).toBeNull();
    expect(within(auto).getByText('稿單自動配對')).toBeTruthy();
  });
});

describe('配對信心與理由（畫面）', () => {
  it('自動配對主題顯示信心（最低值）、配對方式與理由', () => {
    render(<ExposurePerformancePanel records={RECORDS} status="ready" onRetry={vi.fn()} sync={SYNC} />);
    const auto = screen.getByText('創見推出64GB DDR5工業用記憶體', { selector: 'p' }).closest('[class~="bg-gray-800/40"]');
    const line = within(auto).getByTestId('topic-match').textContent;
    expect(line).toContain('信心 88%');                                                    // 兩則裡最低的 88%
    expect(line).toContain('高信心規則（日期＋多個關鍵詞）');
    expect(line).toContain('標題與新聞稿完全相同');
    expect(line).toContain('前後 1 天＋創見＋64GB＋DDR5＋工業記憶體');
  });

  it('percentText 與理由文字：沒有數值不輸出 NaN，理由不含技術代碼', () => {
    expect(percentText(0.876)).toBe('88%');
    expect(percentText(null)).toBe('');
    expect(percentText(undefined)).toBe('');
    expect(percentText('abc')).toBe('');
    for (const r of pub()) if (r.matchReason) expect(r.matchReason).not.toMatch(/ambiguous_|peer_led|no_anchor|title_similarity|_/);
  });
});

describe('待確認配對：選取、篩選、統計與 Excel 使用同一份資料', () => {
  it('只把需要覆核的放進來：建議配對、資訊不足的未配對、已人工確認、已人工排除；一般報導與股市評論不硬塞', () => {
    const status = Object.fromEntries(pub().map(r => [r.id, reviewStatusOf(r)]));
    expect(status).toMatchObject({ exp_sug1: 'suggested', exp_sug2: 'suggested', exp_unm1: 'unmatched', exp_conf1: 'confirmed', exp_rej1: 'rejected' });
    expect(status.exp_auto1).toBeNull();
    expect(status.exp_gen1).toBeNull();
    expect(status.exp_ind1).toBeNull();
    expect(selectReviewItems(pub())).toHaveLength(5);
    expect(countReviewStatuses(selectReviewItems(pub()))).toEqual({ suggested: 2, unmatched: 1, confirmed: 1, rejected: 1 });
  });

  it('可依狀態、媒體、新聞稿、日期、關鍵字篩選', () => {
    const items = selectReviewItems(pub());
    const ids = f => filterReviewItems(items, f).map(i => i.record.id).sort();
    expect(ids({ status: 'suggested' })).toEqual(['exp_sug1', 'exp_sug2']);
    expect(ids({ status: 'rejected' })).toEqual(['exp_rej1']);
    expect(ids({ media: '媒體2' })).toEqual(['exp_sug2']);
    expect(ids({ pressRelease: 'pr_expo' })).toEqual(['exp_sug2']);
    expect(ids({ pressRelease: 'pr_x' })).toEqual(['exp_conf1']);
    expect(ids({ from: '2026-09-01' })).toEqual(['exp_sug2']);
    expect(ids({ to: '2026-05-31' })).toEqual(['exp_conf1', 'exp_rej1']);
    expect(ids({ query: '自動化展' })).toEqual(['exp_sug1']);
    expect(ids({ from: '2026-10-01', to: '2026-01-01' })).toEqual(ids({ from: '2026-01-01', to: '2026-10-01' }));          // 起訖顛倒自動對調
  });

  it('面板：狀態計數、清單、Excel 匯出筆數一致；匯出前四欄是覆核分頁欄位', () => {
    render(<MatchReviewPanel records={RECORDS} status="ready" sync={SYNC} />);
    const chips = within(screen.getByTestId('review-status'));
    expect(chips.getByRole('button', { name: '全部 5' })).toBeTruthy();
    expect(chips.getByRole('button', { name: '建議配對 2' })).toBeTruthy();
    expect(chips.getByRole('button', { name: '未配對 1' })).toBeTruthy();
    expect(chips.getByRole('button', { name: '已人工確認 1' })).toBeTruthy();
    expect(chips.getByRole('button', { name: '已人工排除 1' })).toBeTruthy();
    expect(screen.getAllByTestId('review-item')).toHaveLength(5);
    expect(screen.getByTestId('review-count').textContent).toBe('符合 5 / 共 5 則');

    fireEvent.click(chips.getByRole('button', { name: '建議配對 2' }));
    expect(screen.getAllByTestId('review-item')).toHaveLength(2);
    expect(screen.getByTestId('review-count').textContent).toBe('符合 2 / 共 5 則');
    fireEvent.click(screen.getByRole('button', { name: /匯出待確認 Excel/ }));
    const { rows, pressReleases } = exportMatchReviewExcel.mock.calls.at(-1)[0];
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).slice(0, 4)).toEqual(['exposureId', 'decision', 'pressReleaseId', 'note']);
    expect(rows.map(r => r.exposureId).sort()).toEqual(['exp_sug1', 'exp_sug2']);
    expect(rows[0].decision).toBe('');
    expect(rows[0].note).toBe('');
    expect(pressReleases).toEqual([{ pressReleaseId: 'pr_d64', 日期: '2026-09-14', 新聞稿標題: '創見推出64GB DDR5工業用記憶體' },
      { pressReleaseId: 'pr_expo', 日期: '2026-10-13', 新聞稿標題: '創見參展台北國際電子展' }]);
  });

  it('每則待確認項目顯示狀態、信心、建議配對到哪篇新聞稿與理由；未配對顯示未通過的原因', () => {
    render(<MatchReviewPanel records={RECORDS} status="ready" sync={SYNC} />);
    const sug = screen.getAllByTestId('review-item').find(i => i.textContent.includes('參加自動化展'));
    expect(sug.textContent).toContain('建議配對');
    expect(sug.textContent).toContain('信心 62%');
    expect(sug.textContent).toContain('標題相似（僅建議）');
    expect(sug.textContent).toContain('建議配對到：創見資訊參展自動化展');
    expect(sug.textContent).toContain('同時包含股價與多個事件內容');
    const unm = screen.getAllByTestId('review-item').find(i => i.textContent.includes('「這檔」'));
    expect(unm.textContent).toContain('未配對原因：標題、日期與任何新聞稿的關鍵字都對不上');
    expect(document.body.textContent).not.toMatch(/ambiguous_|peer_led|title_similarity/);
  });

  it('篩選控制項（媒體、新聞稿、日期、搜尋）作用在清單與匯出，並可清除', () => {
    render(<MatchReviewPanel records={RECORDS} status="ready" sync={SYNC} />);
    fireEvent.change(screen.getByLabelText('待確認新聞稿篩選'), { target: { value: 'pr_expo' } });
    expect(screen.getAllByTestId('review-item')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /匯出待確認 Excel/ }));
    expect(exportMatchReviewExcel.mock.calls.at(-1)[0].rows).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '清除篩選' }));
    expect(screen.getAllByTestId('review-item')).toHaveLength(5);
    fireEvent.change(screen.getByLabelText('待確認媒體篩選'), { target: { value: '媒體1' } });
    expect(screen.getAllByTestId('review-item').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('搜尋待確認曝光'), { target: { value: '完全不存在' } });
    expect(screen.getByText('沒有符合條件的曝光')).toBeTruthy();
  });

  it('公開網站沒有任何確認／修改／排除的寫入按鈕；內部備註與來源檔名不會出現在畫面或匯出', () => {
    render(<MatchReviewPanel records={RECORDS} status="ready" sync={SYNC} />);
    expect(screen.queryByRole('button', { name: /^(確認|修改|排除|套用|接受|拒絕)/ })).toBeNull();
    expect(document.body.textContent).not.toContain(NOTE);
    expect(document.body.textContent).not.toContain('secret.xlsx');
    fireEvent.click(screen.getByRole('button', { name: /匯出待確認 Excel/ }));
    const dump = JSON.stringify(exportMatchReviewExcel.mock.calls.at(-1)[0]);
    expect(dump).not.toContain(NOTE);
    expect(dump).not.toContain('secret.xlsx');
    expect(dump).not.toContain('noteInternal');
  });

  it('沒有待確認項目或資料載入失敗時不顯示面板；沒有資料時說明', () => {
    const empty = render(<MatchReviewPanel records={RECORDS.filter(r => r.matchStatus === 'auto_matched')} status="ready" sync={null} />);
    expect(screen.getByText('目前沒有需要覆核的曝光')).toBeTruthy();
    empty.unmount();
    const none = render(<MatchReviewPanel records={[]} status="ready" />);
    expect(none.container.firstChild).toBeNull();
    none.unmount();
    const failed = render(<MatchReviewPanel records={RECORDS} status="error" />);
    expect(failed.container.firstChild).toBeNull();
  });
});

describe('Excel：匯出資料與畫面同一份', () => {
  it('主題彙整與明細帶配對狀態、信心、理由；數字與畫面一致', () => {
    const topics = groupByTopic(pub());
    const summary = buildSummaryRows(topics);
    const detail = buildDetailRows(topics);
    expect(detail).toHaveLength(pub().length);
    const auto = detail.find(r => r.新聞標題.startsWith('創見推64GB'));
    expect(auto).toMatchObject({ 配對狀態: '稿單自動配對', 配對信心: '88%', 配對理由: '前後 1 天＋創見＋64GB＋DDR5＋工業記憶體' });
    expect(detail.find(r => r.新聞標題.startsWith('創見董事長談經營')).配對狀態).toBe('人工確認配對');
    expect(detail.find(r => r.新聞標題.startsWith('創見股價大漲')).配對狀態).toBe('人工排除');
    const top = summary.find(r => r['新聞稿／主題'].includes('64GB'));
    expect(top).toMatchObject({ 曝光總數: 2, 配對信心: '88%' });
    expect(summary.reduce((n, r) => n + r.曝光總數, 0)).toBe(detail.length);
    const dump = JSON.stringify({ summary, detail });
    expect(dump).not.toContain(NOTE);
  });

  it('待確認 Excel 列：公式注入防護、沒有備註', () => {
    const evil = toPublicRecords([raw('exp_evil', 9, 9, '=HYPERLINK("http://evil") 標題', { matchStatus: 'suggested', suggestedPressReleaseId: 'p', suggestedPressReleaseTitle: '+惡意稿', matchReason: '@理由' })]);
    const rows = buildReviewRows(selectReviewItems(evil));
    expect(rows[0].新聞標題.startsWith("'=")).toBe(true);
    expect(rows[0].建議或已配對的新聞稿.startsWith("'+")).toBe(true);
    expect(rows[0].配對理由.startsWith("'@")).toBe(true);
    expect(buildPressReleaseListRows([{ id: '=1', title: 't', date: '' }])[0].pressReleaseId.startsWith("'=")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(NOTE);
  });
});

const sources = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/*.test.*'], { query: '?raw', import: 'default', eager: true });
describe('程式碼結構', () => {
  it('待確認配對面板與資料函式沒有任何 Firestore 存取或寫入 API', () => {
    for (const name of ['./MatchReviewPanel.jsx', './exposurePerformance.js']) {
      expect(sources[name], name).not.toMatch(/services\/firebase|firebase\/firestore|\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|getDocs|onSnapshot)\b/);
    }
    for (const [name, text] of Object.entries(sources)) {
      expect(text, name).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch)\b/);
    }
  });

  it('全站不再出現「人工確認曝光」這個容易誤解的名稱', () => {
    for (const [name, text] of Object.entries(sources)) expect(text, name).not.toContain('人工確認曝光');
  });
});
