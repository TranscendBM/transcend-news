import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import NewsCard from './NewsCard.jsx';

describe('NewsCard', () => {
  it('renders the title, media name and a link to the article', () => {
    const article = {
      id: 'a1',
      title: '創見資訊發布新款 SSD',
      mediaName: '經濟日報',
      link: 'https://example.com/a1',
      pubDate: new Date('2026-07-20T03:00:00Z'),
      sentiment: 'positive',
    };
    render(<NewsCard article={article} />);
    expect(screen.getByText('創見資訊發布新款 SSD')).toBeInTheDocument();
    expect(screen.getByText('經濟日報')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/a1');
    expect(screen.getByText('正面')).toBeInTheDocument();
  });

  it('falls back to a computed sentiment when none is stored', () => {
    const article = {
      id: 'a2',
      title: '威剛虧損擴大',
      content: '威剛虧損擴大財報',
      sourceName: '未知來源',
      pubDate: new Date('2026-07-20T03:00:00Z'),
    };
    render(<NewsCard article={article} />);
    expect(screen.getByText('負面')).toBeInTheDocument();
  });
});
