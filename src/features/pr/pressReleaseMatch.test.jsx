import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const exportExposurePerformanceExcel = vi.fn();
vi.mock('../../utils/formatting.js', () => ({
  exportExposurePerformanceExcel: (...args) => exportExposurePerformanceExcel(...args),
}));

import ExposurePerformancePanel from './ExposurePerformancePanel.jsx';
import {
  toPublicRecord, groupByTopic, filterTopicsByMatch, countMatchKinds, buildSummaryRows, buildDetailRows,
  toPublicRecords,
} from './exposurePerformance.js';

const tw = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - 8 * 3600e3);
const NOTE = 'Google Sheet 備註-不可外流-ABC';

function raw(id, day, title, extra = {}) {
  return {
    id, exposureDate: tw(2026, 9, day), mediaName: `媒體${id}`, reporter: '', title,
    link: `https://example.com/${id}`, exposureType: 'online',
    // 就算資料物件意外帶著稿單備註，也不能進畫面／匯出
    sheetNote: NOTE, 備註: NOTE, note: NOTE,
    ...extra,
  };
}

// 5 個主題：人工確認（兩則）、稿單自動配對（兩則）、稿單建議（一則）、標題推定（兩則相同標題）、尚未配對（一則）
const RECORDS = [
  raw('c1', 1, '創見推出新品 A', { matchStatus: 'confirmed', pressReleaseId: 'pr_conf', pressReleaseTitle: '人工確認的新聞稿' }),
  raw('c2', 2, '創見新品 A 登場', { matchStatus: 'confirmed', pressReleaseId: 'pr_conf', pressReleaseTitle: '人工確認的新聞稿' }),
  raw('a1', 3, '創見 8 月營收創高', { matchStatus: 'auto_matched', matchMethod: 'date_keyword', pressReleaseId: 'pr_auto', pressReleaseTitle: '8月營收' }),
  raw('a2', 4, '創見營收 8 月年增', { matchStatus: 'auto_matched', pressReleaseId: 'pr_auto', pressReleaseTitle: '8月營收' }),
  raw('s1', 5, '創見亮相 COMPUTEX 展出新品', {
    matchStatus: 'suggested', matchMethod: 'title_similarity', suggestedPressReleaseId: 'pr_sug', suggestedPressReleaseTitle: 'COMPUTEX',
  }),
  raw('t1', 6, '創見公告庫藏股', { matchStatus: 'unmatched' }),
  raw('t2', 7, '創見公告庫藏股', { matchStatus: 'unmatched' }),
  raw('u1', 8, '創見董事長談產業', { matchStatus: 'unmatched' }),
];
const SYNC = { lastSyncAt: tw(2026, 9, 9, 6), failedSinceSuccess: false, report: { read: 56 } };

const topicsOf = records => groupByTopic(toPublicRecords(records));
const renderPanel = (props = {}) => render(
  <ExposurePerformancePanel records={RECORDS} status="ready" onRetry={vi.fn()} sync={SYNC} {...props} />);

beforeEach(() => { exportExposurePerformanceExcel.mockClear(); });

describe('toPublicRecord — 配對欄位', () => {
  it('pressReleaseId 只有人工確認／自動配對才會當成分組編號；建議與未配對不會', () => {
    expect(toPublicRecord(RECORDS[0]).campaignId).toBe('pr_conf');
    expect(toPublicRecord(RECORDS[2]).campaignId).toBe('pr_auto');
    expect(toPublicRecord(RECORDS[2]).campaignName).toBe('8月營收');
    const suggested = toPublicRecord(RECORDS[4]);
    expect(suggested.campaignId).toBe('');
    expect(suggested.suggestedName).toBe('COMPUTEX');
    // 就算資料帶了 pressReleaseId，狀態是 suggested／unmatched 也不能拿來分組
    expect(toPublicRecord(raw('x', 1, 't', { matchStatus: 'suggested', pressReleaseId: 'pr_bad' })).campaignId).toBe('');
    expect(toPublicRecord(raw('y', 1, 't', { matchStatus: 'unmatched', pressReleaseId: 'pr_bad' })).campaignId).toBe('');
  });

  it('不認識的 matchStatus 會被忽略；備註欄位不會進公開紀錄', () => {
    expect(toPublicRecord(raw('x', 1, 't', { matchStatus: 'hacked' })).matchStatus).toBe('');
    const serialized = JSON.stringify(toPublicRecord(RECORDS[0]));
    expect(serialized).not.toContain(NOTE);
    expect(Object.keys(toPublicRecord(RECORDS[0]))).not.toContain('sheetNote');
  });
});

describe('groupByTopic — 配對依據', () => {
  const kindsByName = Object.fromEntries(topicsOf(RECORDS).map(t => [t.name, t.matchKind]));

  it('依 pressReleaseId 分組，並標出配對依據', () => {
    const topics = topicsOf(RECORDS);
    const conf = topics.find(t => t.name === '人工確認的新聞稿');
    expect(conf.total).toBe(2);
    expect(conf.matchKind).toBe('confirmed');
    expect(conf.matchLabel).toBe('人工確認配對');
    const auto = topics.find(t => t.name === '8月營收');
    expect(auto.total).toBe(2);
    expect(auto.matchKind).toBe('auto');
    expect(auto.matchLabel).toBe('稿單自動配對');
    expect(auto.fromPressReleaseSheet).toBe(true);
    expect(kindsByName['創見亮相 COMPUTEX 展出新品']).toBe('suggested');
    expect(kindsByName['創見公告庫藏股']).toBe('inferred');
    expect(kindsByName['創見董事長談產業']).toBe('none');
  });

  it('建議配對只標示建議名稱，不會把曝光併進該新聞稿', () => {
    const t = topicsOf(RECORDS).find(x => x.matchKind === 'suggested');
    expect(t.suggestedName).toBe('COMPUTEX');
    expect(t.total).toBe(1);
    expect(t.key.startsWith('id:')).toBe(false);
  });

  it('沒有任何配對資料（尚未同步）時，一律是標題推定／尚未配對，舊規則照常分組', () => {
    const plain = RECORDS.map(r => ({ ...r, matchStatus: undefined, pressReleaseId: undefined }));
    const topics = topicsOf(plain);
    expect(topics.every(t => t.matchKind === 'inferred' || t.matchKind === 'none')).toBe(true);
    expect(topics.find(t => t.name === '創見公告庫藏股').total).toBe(2);
  });

  it('既有的 pressReleaseId（沒有 matchStatus）視為人工提供的編號', () => {
    const t = topicsOf([raw('l1', 1, '標題一', { pressReleaseId: 'legacy' }), raw('l2', 2, '完全不同的標題二', { pressReleaseId: 'legacy' })]);
    expect(t).toHaveLength(1);
    expect(t[0].matchKind).toBe('confirmed');
  });
});

describe('篩選與統計', () => {
  const topics = topicsOf(RECORDS);

  it('countMatchKinds：已確認／自動配對／待確認／未配對（未配對含標題推定與尚未配對）', () => {
    expect(countMatchKinds(topics)).toEqual({ confirmed: 1, auto: 1, suggested: 1, unmatched: 2 });
  });

  it('filterTopicsByMatch', () => {
    expect(filterTopicsByMatch(topics, 'all')).toHaveLength(5);
    expect(filterTopicsByMatch(topics, 'confirmed').map(t => t.name)).toEqual(['人工確認的新聞稿']);
    expect(filterTopicsByMatch(topics, 'auto').map(t => t.name)).toEqual(['8月營收']);
    expect(filterTopicsByMatch(topics, 'suggested')).toHaveLength(1);
    expect(filterTopicsByMatch(topics, 'unmatched')).toHaveLength(2);
  });

  it('Excel 帶配對依據欄，沒有備註', () => {
    const summary = buildSummaryRows(topics);
    expect(summary.find(r => r['新聞稿／主題'] === '8月營收').配對依據).toBe('稿單自動配對');
    expect(summary.find(r => r.配對依據.startsWith('稿單建議配對')).配對依據).toBe('稿單建議配對：COMPUTEX');
    const dump = JSON.stringify({ summary, detail: buildDetailRows(topics) });
    expect(dump).not.toContain(NOTE);
    expect(dump).not.toContain('備註');
  });
});

describe('ExposurePerformancePanel — 新聞稿主檔配對', () => {
  it('顯示資料來源、最後同步時間、待確認與未配對數量', () => {
    renderPanel();
    const status = screen.getByTestId('press-sync-status');
    expect(status.textContent).toContain('Google Sheet 新聞稿主檔＋人工曝光資料');
    expect(status.textContent).toContain('最後同步');
    expect(status.textContent).toContain('2026');
    const filter = screen.getByTestId('match-filter');
    expect(filter.textContent).toContain('待確認 1');
    expect(filter.textContent).toContain('未配對 2');
    expect(within(filter).getByRole('button', { name: '人工確認配對 1' })).toBeTruthy();
    expect(within(filter).getByRole('button', { name: '自動配對 1' })).toBeTruthy();
  });

  it('每個主題標示配對依據與資料來源', () => {
    renderPanel();
    const labels = ['人工確認配對', '稿單自動配對', '稿單建議配對：COMPUTEX', '標題推定', '尚未配對'];
    labels.forEach(l => expect(screen.getAllByText(l).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/^來源：Google Sheet 新聞稿主檔＋人工曝光資料/).length).toBe(2);   // 人工確認＋自動
    expect(screen.getAllByText('來源：人工曝光資料').length).toBeGreaterThan(0);
  });

  it('可以依配對狀態篩選，並可再切回全部', () => {
    renderPanel();
    const filter = screen.getByTestId('match-filter');
    fireEvent.click(within(filter).getByRole('button', { name: '待確認 1' }));
    expect(screen.getByText('創見亮相 COMPUTEX 展出新品')).toBeTruthy();
    expect(screen.queryByText('8月營收')).toBeNull();
    fireEvent.click(within(filter).getByRole('button', { name: '未配對 2' }));
    expect(screen.getByText('創見公告庫藏股')).toBeTruthy();
    expect(screen.getByText('創見董事長談產業')).toBeTruthy();
    expect(screen.queryByText('人工確認的新聞稿')).toBeNull();
    fireEvent.click(within(filter).getByRole('button', { name: /^全部/ }));
    expect(screen.getByText('人工確認的新聞稿')).toBeTruthy();
  });

  it('匯出依目前的配對篩選', () => {
    renderPanel();
    fireEvent.click(within(screen.getByTestId('match-filter')).getByRole('button', { name: '自動配對 1' }));
    fireEvent.click(screen.getByText(/匯出新聞稿成效/));
    const { summaryRows } = exportExposurePerformanceExcel.mock.calls.at(-1)[0];
    expect(summaryRows.map(r => r['新聞稿／主題'])).toEqual(['8月營收']);
  });

  it('沒有新聞稿主檔（尚未同步）或讀取失敗：頁面照常顯示，說明目前用標題推定', () => {
    const noMatches = RECORDS.map(r => ({ ...r, matchStatus: undefined, pressReleaseId: undefined, pressReleaseTitle: undefined }));
    const { unmount } = renderPanel({ records: noMatches, sync: { missing: true } });
    expect(screen.getByTestId('press-sync-status').textContent).toContain('尚未同步 Google Sheet 新聞稿主檔');
    expect(screen.queryByTestId('match-filter')).toBeNull();     // 沒有配對資料就不顯示配對篩選
    expect(screen.getByText('創見公告庫藏股')).toBeTruthy();      // 舊規則的分組照常
    unmount();
    const err = renderPanel({ records: noMatches, sync: { error: true } });
    expect(screen.getByTestId('press-sync-status').textContent).toContain('讀取失敗');
    expect(screen.getByText('創見公告庫藏股')).toBeTruthy();
    err.unmount();
    renderPanel({ records: noMatches, sync: null });
    expect(screen.getByTestId('press-sync-status').textContent).toContain('讀取中');
  });

  it('最近一次同步失敗時標示沿用上次資料', () => {
    renderPanel({ sync: { ...SYNC, failedSinceSuccess: true } });
    expect(screen.getByTestId('press-sync-status').textContent).toContain('最近一次同步失敗');
  });

  it('備註不會出現在畫面（含展開後的明細）', () => {
    renderPanel();
    screen.getAllByRole('button', { expanded: false }).forEach(b => fireEvent.click(b));
    expect(document.body.textContent).not.toContain(NOTE);
    expect(document.body.innerHTML).not.toContain('sheetNote');
  });

  it('公開網站沒有任何確認／修改配對的按鈕', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /^(確認配對|修改配對|套用建議|接受建議|確認|修改)/ })).toBeNull();
  });

  it('不安全的連結不會變成可點擊連結', () => {
    renderPanel({ records: [raw('z', 1, '創見 JS 連結', { link: 'javascript:alert(1)', matchStatus: 'unmatched' })] });
    screen.getAllByRole('button', { expanded: false }).forEach(b => fireEvent.click(b));
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 靜態檢查：前端不能寫 Firestore，也不能為了同步狀態新增監聽器
// ═══════════════════════════════════════════════════════════
const sources = import.meta.glob(['../../**/*.{js,jsx}', '!../../**/*.test.*'], { query: '?raw', import: 'default', eager: true });

describe('程式碼結構', () => {
  it('掃描涵蓋整個 src', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(60);
  });

  it('前端沒有任何 Firestore 寫入 API', () => {
    for (const [name, text] of Object.entries(sources)) {
      expect(text, `${name} 不應寫入 Firestore`).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b/);
    }
  });

  it('新聞稿主檔同步狀態只用一次性 getDoc（job_status/press_release_sync），沒有 onSnapshot、沒有讀 press_releases 集合', () => {
    const app = sources['../../App.jsx'];
    expect(app).toMatch(/getDoc\(doc\(getDb\(\), 'job_status', 'press_release_sync'\)\)/);
    expect(app.match(/'job_status', 'press_release_sync'/g)).toHaveLength(1);
    for (const [name, text] of Object.entries(sources)) {
      expect(text, `${name} 不應讀 press_releases 內部集合`).not.toMatch(/['"]press_releases['"]/);
    }
    expect(app.match(/onSnapshot\(/g)).toHaveLength(1);   // 仍然只有原本的股價監聽
  });
});
