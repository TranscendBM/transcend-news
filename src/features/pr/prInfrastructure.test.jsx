/* global URLSearchParams */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';

import { useUrlParam } from '../../hooks/useUrlParam.js';
import { readParam, writeParams } from '../../utils/urlState.js';
import { PRStateProvider, usePRState } from './prState.jsx';
import { selectCompetitorNews, selectValidTranscend } from './prData.js';
import { PR_SECTION_IDS, DEFAULT_PR_SECTION, prPanelId, prTabId } from './prSections.js';

const setUrl = search => window.history.replaceState(null, '', `/${search}`);

// ═══════════════════════════════════════════════════════════
describe('urlState — 網址參數讀寫', () => {
  it('寫入、移除參數；其他參數與 hash 保持不變', () => {
    setUrl('?a=1&b=2#top');
    writeParams({ b: null, c: '3' });
    expect(window.location.search).toBe('?a=1&c=3');
    expect(window.location.hash).toBe('#top');
    expect(readParam('a')).toBe('1');
    expect(readParam('b')).toBeNull();
  });

  it('網址沒有實際變動時不新增歷史紀錄；replace 也不新增', () => {
    setUrl('?section=news');
    const before = window.history.length;
    writeParams({ section: 'news' });
    expect(window.history.length).toBe(before);
    writeParams({ section: 'exposure' });
    expect(window.history.length).toBe(before + 1);
    writeParams({ section: 'overview' }, { replace: true });
    expect(window.history.length).toBe(before + 1);
    expect(readParam('section')).toBe('overview');
  });
});

describe('useUrlParam', () => {
  function Probe({ name = 'section', label = 'a' }) {
    const [value, setValue] = useUrlParam(name, PR_SECTION_IDS, DEFAULT_PR_SECTION);
    return (
      <div>
        <span data-testid={label}>{value}</span>
        <button onClick={() => setValue('news')}>{label}-go-news</button>
      </div>
    );
  }

  it('沒有參數、或參數不認識時回退到預設值（不會出現空值）', () => {
    setUrl('');
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('a').textContent).toBe('overview');
    unmount();
    setUrl('?section=does-not-exist');
    render(<Probe />);
    expect(screen.getByTestId('a').textContent).toBe('overview');
  });

  it('參數合法時直接使用；setter 會改網址並更新畫面', () => {
    setUrl('?section=exposure');
    render(<Probe />);
    expect(screen.getByTestId('a').textContent).toBe('exposure');
    fireEvent.click(screen.getByText('a-go-news'));
    expect(screen.getByTestId('a').textContent).toBe('news');
    expect(readParam('section')).toBe('news');
  });

  it('同一頁上多個 useUrlParam 會一起更新；瀏覽器上一頁（popstate）會同步', async () => {
    setUrl('');
    render(<><Probe label="a" /><Probe label="b" /></>);
    fireEvent.click(screen.getByText('a-go-news'));
    expect(screen.getByTestId('b').textContent).toBe('news');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('overview'));
  });

  it('壞掉的參數會被 replaceState 清掉（不留下無效網址、也不增加歷史紀錄）', async () => {
    setUrl('?section=%00bad');
    const before = window.history.length;
    render(<Probe />);
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('section')).toBe(false));
    expect(window.history.length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════
describe('usePRState — 跨子頁保存畫面狀態', () => {
  function Field({ k = 'q', initial = '' }) {
    const [value, setValue] = usePRState(k, initial);
    return <input aria-label={k} value={value} onChange={e => setValue(e.target.value)} />;
  }
  function Toggle() {
    const [shown, setShown] = useState(true);
    return <><button onClick={() => setShown(s => !s)}>toggle</button>{shown && <Field />}</>;
  }

  it('元件卸載再掛載（切換子頁）後，值仍在 PRStateProvider 裡', () => {
    render(<PRStateProvider><Toggle /></PRStateProvider>);
    fireEvent.change(screen.getByLabelText('q'), { target: { value: '保留我' } });
    fireEvent.click(screen.getByText('toggle'));      // 卸載
    expect(screen.queryByLabelText('q')).toBeNull();
    fireEvent.click(screen.getByText('toggle'));      // 重新掛載
    expect(screen.getByLabelText('q').value).toBe('保留我');
  });

  it('不同的 key 互不影響；初始值可以是函式且只呼叫一次；支援 updater 函式', () => {
    let calls = 0;
    function Counter() {
      const [n, setN] = usePRState('n', () => { calls += 1; return 5; });
      return <button onClick={() => setN(v => v + 1)}>n={n}</button>;
    }
    render(<PRStateProvider><Field k="a" /><Field k="b" initial="B" /><Counter /></PRStateProvider>);
    fireEvent.change(screen.getByLabelText('a'), { target: { value: 'A!' } });
    expect(screen.getByLabelText('b').value).toBe('B');
    fireEvent.click(screen.getByText('n=5'));
    fireEvent.click(screen.getByText('n=6'));
    expect(screen.getByText('n=7')).toBeTruthy();
    expect(calls).toBe(1);
  });

  it('沒有 PRStateProvider 時退回一般 useState（單獨使用元件也能運作，但卸載後不保留）', () => {
    render(<Toggle />);
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'x' } });
    expect(screen.getByLabelText('q').value).toBe('x');
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByLabelText('q').value).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
describe('prData — 總覽與各子頁共用的資料選取', () => {
  const at = h => new Date(Date.now() - h * 3600e3);

  it('selectValidTranscend：排除不是創見 PR 的文章，並把正規化後標題相同的去重', () => {
    const rows = selectValidTranscend([
      { id: 'a', title: '創見發布新品', cat: 'transcend', mediaName: '經濟日報', content: '創見資訊', pubDate: at(1) },
      { id: 'b', title: '創見發布新品！', cat: 'transcend', mediaName: '鉅亨網', content: '創見資訊', pubDate: at(2) },
      { id: 'c', title: '創見股價盤中速報', cat: 'transcend', mediaName: 'CMoney', link: 'https://cmoney.tw/x', content: '創見', pubDate: at(3) },
      { id: 'd', title: '威剛新聞', cat: 'competitor', mediaName: '經濟日報', content: '威剛', pubDate: at(4) },
    ]);
    expect(rows.map(r => r.id)).toEqual(['a']);
    expect(selectValidTranscend(undefined)).toEqual([]);
  });

  it('selectCompetitorNews：只取競品、排除 CMoney／爆料、新到舊、去重；可依品牌與期間篩選', () => {
    const day = (m, d, y = 2026) => new Date(y, m - 1, d, 12);   // 固定日期，不依賴執行當下的時間
    const news = [
      { id: 'c1', title: '威剛一', cat: 'competitor', brand: 'ADATA', mediaName: 'A', pubDate: day(9, 8) },
      { id: 'c2', title: '宜鼎二', cat: 'competitor', brand: 'Innodisk', mediaName: 'B', pubDate: day(9, 12) },
      { id: 'c3', title: '威剛一！', cat: 'competitor', brand: 'ADATA', mediaName: 'C', pubDate: day(9, 10) },   // 與 c1 去重，留較新的 c3
      { id: 'c4', title: '股市爆料', cat: 'competitor', brand: 'ADATA', mediaName: '股市爆料同學會', pubDate: day(9, 12) },
      { id: 'c5', title: 'CMoney 文章', cat: 'competitor', brand: 'ADATA', mediaName: 'CMoney 投資網誌', pubDate: day(9, 12) },
      { id: 'c6', title: '去年的舊聞', cat: 'competitor', brand: 'ADATA', mediaName: 'D', pubDate: day(1, 1, 2025) },
      { id: 'c7', title: '宜鼎上月新品', cat: 'competitor', brand: 'Innodisk', mediaName: 'F', pubDate: day(8, 15) },        // 上個月
      { id: 't1', title: '創見新聞', cat: 'transcend', mediaName: 'E', pubDate: day(9, 12) },
    ];
    const now = day(9, 20);
    expect(selectCompetitorNews(news, { now }).map(n => n.id)).toEqual(['c2', 'c3', 'c7', 'c6']);   // 新到舊
    expect(selectCompetitorNews(news, { brand: 'Innodisk', now }).map(n => n.id)).toEqual(['c2', 'c7']);
    expect(selectCompetitorNews(news, { timeFilter: 'month', now }).map(n => n.id)).toEqual(['c2', 'c3']);
    expect(selectCompetitorNews(news, { timeFilter: 'lastMonth', now }).map(n => n.id)).toEqual(['c7']);   // 上月：本月與更早的都不含
    expect(selectCompetitorNews(news, { timeFilter: 'year', now }).map(n => n.id)).toEqual(selectCompetitorNews(news, { now }).map(n => n.id));   // 已移除的選項不會讓清單變空
    expect(selectCompetitorNews(news, { timeFilter: 'all', now }).map(n => n.id)).toEqual(['c2', 'c3', 'c7', 'c6']);
    expect(selectCompetitorNews(undefined)).toEqual([]);
  });

  it('子頁定義：id、預設子頁與 tab／panel 的 id 規則', () => {
    expect(PR_SECTION_IDS).toEqual(['overview', 'news', 'competitors', 'exposure']);
    expect(DEFAULT_PR_SECTION).toBe('overview');
    expect(prTabId('news')).toBe('pr-tab-news');
    expect(prPanelId('news')).toBe('pr-panel-news');
  });
});

// ═══════════════════════════════════════════════════════════
// 靜態防護（掃描原始碼）
// ═══════════════════════════════════════════════════════════
const sources = import.meta.glob('../../**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true });
const appFiles = Object.entries(sources).filter(([path]) => !/\.test\./.test(path));
// 同一目錄（features/pr）的檔案 key 是 './X.jsx'，其他目錄是 '../../features/pr/X.jsx'
const prFiles = appFiles.filter(([path]) => path.startsWith('./') || /\/features\/pr\//.test(path));

describe('靜態防護', () => {
  it('掃描範圍正確（避免檢查空轉）：確實掃到 PR 的元件與整個 src', () => {
    expect(prFiles.length).toBeGreaterThan(20);
    ['PRTab.jsx', 'PROverview.jsx', 'PRSubNavigation.jsx', 'PRExposureSection.jsx'].forEach(f =>
      expect(prFiles.some(([path]) => path.endsWith('/' + f)), f).toBe(true));
    expect(appFiles.length).toBeGreaterThan(60);
  });

  it('PR 子頁與共用檔案不直接碰 Firestore（沒有 firebase 匯入、onSnapshot、getDocs）——資料只來自 App 層的 hook', () => {
    const uiFiles = prFiles.filter(([path]) => !/useMediaExposure\.js$/.test(path));
    uiFiles.forEach(([path, text]) => {
      expect(text, path).not.toMatch(/services\/firebase/);
      expect(text, path).not.toMatch(/\bonSnapshot\s*\(/);
      expect(text, path).not.toMatch(/\bgetDocs?\s*\(/);
    });
  });

  it('前端沒有任何地方讀取 media_exposure_private（只在註解或隱私白名單常數出現）', () => {
    appFiles.forEach(([path, text]) => {
      const code = text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, path).not.toMatch(/collection\([^)]*media_exposure_private/);
      expect(code, path).not.toMatch(/['"`]media_exposure_private['"`]/);
    });
  });

  it('沒有未使用的 PR 畫面檔案：features/pr 裡的每個 .jsx 元件都被其他檔案匯入（沒有留下舊版畫面程式碼）', () => {
    const all = appFiles.map(([, text]) => text).join('\n');
    prFiles.filter(([path]) => path.endsWith('.jsx')).forEach(([path]) => {
      const base = path.split('/').pop();
      const importedElsewhere = appFiles.some(([other, text]) => other !== path
        // 一般匯入（from './X.jsx'）或動態匯入（lazy(() => import('./X.jsx'))）
        && new RegExp(`(?:from\\s*|import\\s*\\(\\s*)['"][./]*(?:[\\w./-]*/)?${base.replace('.', '\\.')}['"]`).test(text));
      expect(importedElsewhere, `${base} 沒有被任何檔案匯入`).toBe(true);
    });
    expect(all).toContain('PRSubNavigation');
  });

  it('PRTab.jsx 只是外殼：不再內嵌舊版的單頁畫面（篩選工具列、清單、競品列表都在各子頁元件）', () => {
    const [, text] = prFiles.find(([path]) => path.endsWith('/PRTab.jsx'));
    expect(text).not.toContain('NewsFilterToolbar');
    expect(text).not.toContain('NewsCard');
    expect(text).not.toContain('exportNewsExcel');
    expect(text.split('\n').length).toBeLessThan(120);
  });
});

describe('樣式防護', () => {
  const css = readFileSync('src/styles/base.css', 'utf8');   // vitest 從專案根目錄執行

  it('尊重 prefers-reduced-motion（關閉轉場與動畫）', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  it('子頁籤有清楚的鍵盤焦點樣式', () => {
    expect(css).toMatch(/\.pr-subtab:focus-visible\s*\{[^}]*outline:\s*2px/);
  });
});
