import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Card from './Card.jsx';

describe('Card', () => {
  it('renders title, icon and children', () => {
    render(<Card title="今日情報快報" icon="☀️"><p>內容文字</p></Card>);
    expect(screen.getByText('今日情報快報')).toBeInTheDocument();
    expect(screen.getByText('內容文字')).toBeInTheDocument();
  });

  it('renders children without a header when no title is given', () => {
    render(<Card><p>只有內容</p></Card>);
    expect(screen.getByText('只有內容')).toBeInTheDocument();
  });
});
