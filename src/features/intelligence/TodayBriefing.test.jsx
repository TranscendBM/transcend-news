import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import TodayBriefing from './TodayBriefing.jsx';

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
});
