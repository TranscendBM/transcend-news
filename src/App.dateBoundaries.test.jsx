import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PRStatsPanel, KeyMediaPanel } from './App.jsx';

function mkArticle(pubDate, mediaName = '電子時報') {
  return { id: `${Math.random()}`, title: 't', mediaName, pubDate };
}

function statValue(label) {
  const labelEl = screen.getByText(`媒體曝光｜${label}`);
  return labelEl.parentElement.textContent;
}

// PRStatsPanel/KeyMediaPanel 內部用 useNow(60000)：這裡跟它的 interval
// 對齊，用 60 秒推進讓 useNow 的 setInterval 觸發、元件重新渲染。
// 日期一律用 new Date(year, monthIndex, day, ...) 的本地建構子——跟元件
// 內部 now.getFullYear()/getDate() 這類「本地時區」讀法一致，避免測試
// 環境的時區（此沙盒是 UTC）跟寫死的 ISO 字串時區對不上而誤判。
const TICK_MS = 60000;

describe('PRStatsPanel — 日期邊界不會卡在建立當下的舊值', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('今日統計在跨過午夜後會更新（articles 不變、頁面不重新整理）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 23, 59, 0));

    // 這篇文章發布於 7/20 23:58（跨午夜前的「今天」）
    const articles = [mkArticle(new Date(2026, 6, 20, 23, 58, 0))];

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('今天')).toContain('1');

    // 推進 60 秒，跨過午夜（23:59 + 60s = 隔天 00:00），articles 完全沒變
    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); });

    expect(statValue('今天')).toContain('0');
  });

  it('本月統計在跨月後會更新', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 30, 23, 59, 0)); // 6/30 23:59
    const articles = [mkArticle(new Date(2026, 5, 30, 12, 0, 0))];

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('本月')).toContain('1');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 7/1 00:00

    expect(statValue('本月')).toContain('0');
  });

  it('本年統計在跨年後會更新', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 0)); // 12/31 23:59
    const articles = [mkArticle(new Date(2026, 11, 31, 12, 0, 0))];

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('本年')).toContain('1');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 隔年 1/1 00:00

    expect(statValue('本年')).toContain('0');
  });
});

describe('KeyMediaPanel — 日期邊界不會卡在建立當下的舊值', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('本月/本年累計曝光在跨月、跨年後會反映新的邊界', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 0));
    const articles = [mkArticle(new Date(2026, 11, 31, 12, 0, 0), '電子時報')];

    render(<KeyMediaPanel articles={articles} />);
    // 電子時報那一列文字內容是「1電子時報Digitimes11」：排名徽章(1) +
    // 名稱 + 英文名 + 本月數(1) + 本年數(1)，用 Digitimes 後面接的兩碼
    // 準確檢查本月/本年計數（不能只檢查「有沒有 1」，排名徽章一定有 1）。
    const row = screen.getByText('電子時報').closest('.group');
    expect(row.textContent).toContain('Digitimes11');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 隔年 1/1 00:00

    const rowAfter = screen.getByText('電子時報').closest('.group');
    // 新的一年/一月，這篇舊文章不再算入本月/本年累計，兩欄都應該是 0
    expect(rowAfter.textContent).toContain('Digitimes00');
  });
});
