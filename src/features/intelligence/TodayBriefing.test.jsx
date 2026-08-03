import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import TodayBriefing from './TodayBriefing.jsx';

// 建構「台灣時間 y-m-d h:mi:s」對應的實際時刻，不依賴測試環境本身的時區
// （測試環境跟大多數 CI 一樣預設 TZ=UTC，若用本地時區的 Date 建構子，
// 邊界測試會受執行環境時區影響）。
function taipei(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000);
}

function mkArticle(overrides = {}) {
  return {
    id: 'a1',
    title: '創見資訊財報虧損擴大',
    content: '創見資訊 財報 虧損',
    cat: 'transcend',
    pubDate: new Date(),
    ...overrides,
  };
}

describe('TodayBriefing', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the empty state when there is nothing to report today', () => {
    render(<TodayBriefing articles={[]} />);
    expect(screen.getByText('今天目前沒有需要處理的重要情報')).toBeInTheDocument();
  });

  it('surfaces a risk-worthy article published today', () => {
    const article = mkArticle();
    render(<TodayBriefing articles={[article]} />);
    expect(screen.getByText('創見資訊財報虧損擴大')).toBeInTheDocument();
    expect(screen.getByText('風險')).toBeInTheDocument();
  });

  it('accepts a custom title (used by the upstream-market tab)', () => {
    render(<TodayBriefing articles={[]} title="上游市場今日重要情報" />);
    expect(screen.getByText('上游市場今日重要情報')).toBeInTheDocument();
  });

  describe('「今天」使用 Asia/Taipei 日曆邊界，不是測試環境本地時區', () => {
    it('counts an article just after Taipei midnight as today, and one just before as not today', () => {
      // 現在是台灣時間 8/3 00:30。
      vi.setSystemTime(taipei(2026, 8, 3, 0, 30, 0));
      // 兩篇都保留預設 content（含財報/虧損關鍵字），確保兩者都會被判定
      // 為 kind !== 'news'——唯一的差異只在 pubDate，藉此單獨驗證日期
      // 邊界判斷，不會被「這篇文章本來就不算重要情報」混淆。
      const today = mkArticle({
        id: 'today', title: '創見今天凌晨快訊', pubDate: taipei(2026, 8, 3, 0, 10, 0), // 8/3 00:10 台灣時間
      });
      const yesterday = mkArticle({
        id: 'yesterday', title: '創見昨晚收盤快訊', pubDate: taipei(2026, 8, 2, 23, 59, 0), // 8/2 23:59 台灣時間
      });
      render(<TodayBriefing articles={[today, yesterday]} />);

      expect(screen.getByText('創見今天凌晨快訊')).toBeInTheDocument();
      expect(screen.queryByText('創見昨晚收盤快訊')).toBeNull();
    });

    it('automatically drops an article from today once the page stays open across the Taipei midnight boundary, even though the articles prop never changes', async () => {
      vi.useFakeTimers();
      // 現在是台灣時間 8/3 23:59，文章是台灣時間 8/3 20:00 發布——此時算「今天」。
      vi.setSystemTime(taipei(2026, 8, 3, 23, 59, 0));
      const article = mkArticle({
        id: 'late-night', title: '創見晚間收盤快訊', pubDate: taipei(2026, 8, 3, 20, 0, 0),
      });
      render(<TodayBriefing articles={[article]} />);
      expect(screen.getByText('創見晚間收盤快訊')).toBeInTheDocument();

      // 推進到台灣時間 8/4 00:01，並讓 useNow() 的 60 秒 interval 至少
      // 觸發一次——articles prop 完全沒變，但這篇文章已經不屬於新的
      // 「今天」（8/4），必須自動從清單移除，不能停留在舊的邊界。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      });

      expect(screen.queryByText('創見晚間收盤快訊')).toBeNull();
      expect(screen.getByText('今天目前沒有需要處理的重要情報')).toBeInTheDocument();
    });
  });
});
