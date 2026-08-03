import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PRStatsPanel, KeyMediaPanel } from './App.jsx';

// 建構「台灣時間 y-m-d h:mi:s」對應的實際時刻，不依賴測試環境本身的時區
// （這個 sandbox 是 UTC）：台灣沒有 DST，固定 UTC+8，所以台灣的實際時刻
// = 同樣數字當作 UTC 讀取後再減 8 小時。跟 src/utils/dates.js 內部
// taipeiInstant() 用的是同一個換算方式。month 為 1-based（1=一月），
// 跟一般人講日期的方式一致，內部才轉成 JS 的 0-based month index。
function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

function mkArticle(pubDate, mediaName = '電子時報') {
  return { id: `${Math.random()}`, title: 't', mediaName, pubDate };
}

function statValue(label) {
  const labelEl = screen.getByText(`媒體曝光｜${label}`);
  return labelEl.parentElement.textContent;
}

// PRStatsPanel/KeyMediaPanel 內部用 useNow(60000)：這裡跟它的 interval
// 對齊，用 60 秒推進讓 useNow 的 setInterval 觸發、元件重新渲染。
const TICK_MS = 60000;

describe('PRStatsPanel — 日期邊界不會卡在建立當下的舊值（Asia/Taipei）', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('今日統計在跨過台灣時間午夜後會更新（articles 不變、頁面不重新整理）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 7, 20, 23, 59, 0));

    // 這篇文章發布於台灣時間 7/20 23:58（跨午夜前的「今天」）
    const articles = [mkArticle(taipei(2026, 7, 20, 23, 58, 0))];

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('今天')).toContain('1');

    // 推進 60 秒，跨過台灣時間午夜（23:59 + 60s = 隔天 00:00），articles 完全沒變
    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); });

    expect(statValue('今天')).toContain('0');
  });

  it('本週統計以週一為起點，不是「最近 7 天」', () => {
    // 2026-08-03（台灣時間）是週一
    vi.setSystemTime(taipei(2026, 8, 5, 10, 0, 0)); // 週三
    const thisWeekMonday = mkArticle(taipei(2026, 8, 3, 8, 0, 0));   // 本週一，應算入
    const lastWeekSunday = mkArticle(taipei(2026, 8, 2, 23, 0, 0));  // 上週日，不應算入
    render(<PRStatsPanel articles={[thisWeekMonday, lastWeekSunday]} />);
    expect(statValue('本週')).toContain('1');
  });

  it('本週統計在跨過新的一週後會更新', async () => {
    vi.useFakeTimers();
    // 2026-08-09 是週日，2026-08-10 是下一週的週一
    vi.setSystemTime(taipei(2026, 8, 9, 23, 59, 0));
    const articles = [mkArticle(taipei(2026, 8, 9, 23, 58, 0))]; // 本週（週日）發布

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('本週')).toContain('1');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 週一 00:00，新的一週開始

    expect(statValue('本週')).toContain('0');
  });

  it('本月統計在跨月後會更新', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 6, 30, 23, 59, 0)); // 6/30 23:59
    const articles = [mkArticle(taipei(2026, 6, 30, 12, 0, 0))];

    render(<PRStatsPanel articles={articles} />);
    expect(statValue('本月')).toContain('1');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 7/1 00:00

    expect(statValue('本月')).toContain('0');
  });

  it('沒有「本年」欄位（已改成只顯示今天/本週/本月）', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    render(<PRStatsPanel articles={[]} />);
    expect(screen.queryByText('媒體曝光｜本年')).toBeNull();
  });

  it('查詢失敗時明確顯示錯誤，不悄悄顯示 0', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    render(<PRStatsPanel articles={[]} status="error" />);
    expect(screen.getAllByText('⚠ 載入失敗').length).toBeGreaterThan(0);
    // 錯誤狀態下不應該顯示看起來正常的「0 篇」
    expect(screen.queryByText('篇')).toBeNull();
  });
});

describe('KeyMediaPanel — 只統計本月，不再有本年', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('本月累計曝光在跨月後會反映新的邊界', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(taipei(2026, 12, 31, 23, 59, 0));
    const articles = [mkArticle(taipei(2026, 12, 31, 12, 0, 0), '電子時報')];

    render(<KeyMediaPanel articles={articles} />);
    // 該列文字內容是「1電子時報Digitimes1」：排名徽章(1) + 名稱 +
    // 英文名 + 本月數(1)。只有一個數字欄位（本年欄位已移除）。
    const row = screen.getByText('電子時報').closest('.group');
    expect(row.textContent).toBe('1電子時報Digitimes1');

    await act(async () => { await vi.advanceTimersByTimeAsync(TICK_MS); }); // → 隔年 1/1 00:00，新的一個月

    const rowAfter = screen.getByText('電子時報').closest('.group');
    expect(rowAfter.textContent).toBe('1電子時報Digitimes0');
  });

  it('不再顯示本年欄位標題或本年數字欄位', () => {
    vi.setSystemTime(taipei(2026, 7, 20, 12, 0, 0));
    render(<KeyMediaPanel articles={[mkArticle(taipei(2026, 7, 20, 8, 0, 0), '電子時報')]} />);
    expect(screen.queryByText('本年累計曝光篇數（各媒體佔比）')).toBeNull();
    expect(screen.getByText('本月累計曝光篇數（各媒體佔比）')).toBeTruthy();
  });

  it('查詢失敗時顯示錯誤訊息，不是空白排行榜', () => {
    render(<KeyMediaPanel articles={[]} status="error" />);
    expect(screen.getByText('⚠ 資料載入失敗，請稍後重新整理')).toBeTruthy();
  });
});
