import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import {
  ActionButton, DataStateBanner, DataTable, EmptyState, ErrorState, FilterBar, IconButton, LastUpdatedLabel,
  ListStatus, LoadingSkeleton, MetricCard, PageHeader, SearchField, SectionCard, SegmentedControl, StatusBadge,
} from './index.js';
import PrimaryNavigation from '../shell/PrimaryNavigation.jsx';
import MarketSummary from '../shell/MarketSummary.jsx';
import SubNavigation from '../SubNavigation.jsx';

afterEach(() => { delete window.matchMedia; });

// ── 資料狀態：loading／empty／error／stale／cache 各有各的樣子，不全部畫成「—」
describe('資料狀態元件', () => {
  it('MetricCard：loading＝骨架、error＝載入失敗、empty＝尚無資料、ready 單欄缺值＝「—」', () => {
    const { rerender } = render(<MetricCard label="EPS" value="$3.2" />);
    expect(screen.getByText('$3.2')).toBeTruthy();
    rerender(<MetricCard label="EPS" value={null} state="loading" />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    rerender(<MetricCard label="EPS" value={null} state="error" />);
    expect(screen.getByText('載入失敗')).toBeTruthy();
    rerender(<MetricCard label="EPS" value={null} state="empty" />);
    expect(screen.getByText('尚無資料')).toBeTruthy();
    rerender(<MetricCard label="EPS" value={null} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('MetricCard 可點擊時是 button，aria-pressed 反映套用狀態', () => {
    const onClick = vi.fn();
    render(<MetricCard label="負面事件" value="3" onClick={onClick} active />);
    const btn = screen.getByRole('button', { name: /負面事件/ });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('DataStateBanner：error 用 alert、stale／cache／loading 用 status；沒有狀態時不顯示', () => {
    const { rerender, container } = render(<DataStateBanner state="error">連線失敗</DataStateBanner>);
    expect(screen.getByRole('alert').textContent).toContain('載入失敗');
    rerender(<DataStateBanner state="stale">最後資料 11:50</DataStateBanner>);
    expect(screen.getByRole('status').textContent).toContain('資料過期');
    rerender(<DataStateBanner state="cache" />);
    expect(screen.getByRole('status').textContent).toContain('使用快取資料');
    rerender(<DataStateBanner state="ready" />);
    expect(container.textContent).toBe('');
  });

  it('DataStateBanner 的重試按鈕可用', () => {
    const onRetry = vi.fn();
    render(<DataStateBanner state="error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('ListStatus：error／empty／loading／ready 四種狀態', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ListStatus status="error" count={0} onRetry={onRetry}><p>內容</p></ListStatus>);
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<ListStatus status="ready" count={0} emptyText="沒有報導" emptyHint="調整篩選"><p>內容</p></ListStatus>);
    expect(screen.getByText('沒有報導')).toBeTruthy();
    expect(screen.getByText('調整篩選')).toBeTruthy();
    rerender(<ListStatus status="loading" count={0}><p>內容</p></ListStatus>);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    rerender(<ListStatus status="ready" count={2}><p>內容</p></ListStatus>);
    expect(screen.getByText('內容')).toBeTruthy();
  });

  it('EmptyState／ErrorState／LoadingSkeleton 有適當的 role', () => {
    render(<><EmptyState title="沒有資料" /><ErrorState message="壞了" /><LoadingSkeleton label="載入新聞" /></>);
    expect(screen.getByText('沒有資料')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('壞了');
    expect(screen.getByRole('status', { name: '載入新聞' })).toBeTruthy();
  });

  it('LastUpdatedLabel：有時間、過期、沒有時間、時間無效', () => {
    const d = new Date('2026-10-27T03:50:00Z');
    const { rerender, container } = render(<LastUpdatedLabel date={d} />);
    expect(container.querySelector('time').getAttribute('datetime')).toBe(d.toISOString());
    rerender(<LastUpdatedLabel date={d} stale />);
    expect(container.textContent).toContain('資料過期');
    rerender(<LastUpdatedLabel date={null} />);
    expect(container.textContent).toContain('尚未更新');
    rerender(<LastUpdatedLabel date="not-a-date" />);
    expect(container.textContent).toContain('更新時間未知');
  });

  it('StatusBadge 同時有符號與文字（不只靠顏色）', () => {
    render(<StatusBadge tone="error">執行失敗</StatusBadge>);
    const badge = screen.getByText('執行失敗').closest('span[data-tone]');
    expect(badge.getAttribute('data-tone')).toBe('error');
    expect(badge.textContent).toContain('✕');
  });
});

// ── 篩選列：條件晶片、清除、手機收合、Escape
describe('FilterBar', () => {
  function setup(extra = {}) {
    const onClearAll = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterBar active={[{ key: 'm', label: '媒體：經濟日報', onClear }]} onClearAll={onClearAll} resultText="顯示 3 / 9 則" {...extra}>
        <SearchField value="" onChange={() => {}} label="搜尋新聞" />
      </FilterBar>);
    return { onClearAll, onClear };
  }

  it('目前生效的條件顯示成晶片，可個別移除，也可一鍵清除', () => {
    const { onClearAll, onClear } = setup();
    fireEvent.click(screen.getByRole('button', { name: '移除篩選：媒體：經濟日報' }));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '清除條件' }));
    expect(onClearAll).toHaveBeenCalled();
    expect(screen.getAllByText('顯示 3 / 9 則')).toHaveLength(1);       // 結果數在 DOM 裡只有一份
  });

  it('手機的「篩選（N）」按鈕有 aria-expanded，Escape 可收合', () => {
    setup();
    const toggle = screen.getByRole('button', { name: '篩選（1）' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('沒有條件時不顯示晶片列與清除按鈕', () => {
    render(<FilterBar active={[]}><SearchField value="" onChange={() => {}} label="搜尋" /></FilterBar>);
    expect(screen.queryByRole('button', { name: '清除條件' })).toBeNull();
  });
});

describe('SegmentedControl／ActionButton／IconButton／SectionCard／PageHeader', () => {
  it('SegmentedControl 用 aria-pressed 表示目前選項，點擊回傳 id', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="期間" value="week" onChange={onChange} options={[{ id: 'today', label: '今天' }, { id: 'week', label: '本週' }]} />);
    expect(screen.getByRole('button', { name: '本週' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    expect(onChange).toHaveBeenCalledWith('today');
  });

  it('IconButton 一定有 accessible name；ActionButton 預設 type=button 且點擊區不小於 44px（min-h-11）', () => {
    render(<><IconButton icon="refresh" label="重新整理" /><ActionButton>匯出</ActionButton></>);
    expect(screen.getByRole('button', { name: '重新整理' })).toBeTruthy();
    const btn = screen.getByRole('button', { name: '匯出' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toContain('min-h-11');
  });

  it('SectionCard 的「查看全部」帶卡片名稱，PageHeader 的動作放在標題列', () => {
    const onViewAll = vi.fn();
    render(<><SectionCard title="最近重大訊息" onViewAll={onViewAll}>內容</SectionCard>
      <PageHeader title="新聞監測" actions={<ActionButton>匯出 Excel</ActionButton>} /></>);
    fireEvent.click(screen.getByRole('button', { name: '查看全部：最近重大訊息' }));
    expect(onViewAll).toHaveBeenCalled();
    expect(within(screen.getByRole('heading', { name: '新聞監測' }).parentElement.parentElement).getByRole('button', { name: '匯出 Excel' })).toBeTruthy();
  });
});

// ── 響應式：同一份資料，桌機是表格、手機是卡片
describe('DataTable：桌機表格／手機卡片切換', () => {
  const columns = [
    { key: 'name', header: '公司', primary: true },
    { key: 'price', header: '股價', align: 'right' },
  ];
  const rows = [{ id: 'a', name: '創見', price: '$275' }, { id: 'b', name: '威剛', price: '$330' }];

  it('桌機（沒有 matchMedia 或 ≥768px）渲染表格', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => r.id} caption="股價" />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByTestId('mobile-card-list')).toBeNull();
  });

  it('手機（<768px）改渲染卡片清單，內容不重複、不是表格', () => {
    window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    render(<DataTable columns={columns} rows={rows} rowKey={r => r.id} />);
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByTestId('mobile-card-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByText('創見')).toHaveLength(1);
  });

  it('沒有資料時顯示傳入的 empty', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={r => r.id} empty={<p>沒有股價</p>} />);
    expect(screen.getByText('沒有股價')).toBeTruthy();
  });
});

// ── 導覽
describe('導覽', () => {
  const items = [{ id: 'pr', icon: 'megaphone', label: 'PR 媒體戰情' }, { id: 'ir', icon: 'trend', label: 'IR 投資情報' }];

  it('第一層導覽：目前頁 aria-current="page"，點擊切換', () => {
    const onChange = vi.fn();
    render(<PrimaryNavigation items={items} active="ir" onChange={onChange} />);
    expect(screen.getByRole('navigation', { name: '主要導覽' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'IR 投資情報' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'PR 媒體戰情' }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'PR 媒體戰情' }));
    expect(onChange).toHaveBeenCalledWith('pr');
  });

  it('第二層頁籤：tablist／aria-selected，方向鍵切換', () => {
    const onChange = vi.fn();
    render(<SubNavigation sections={[{ id: 'a', label: '總覽', icon: 'layers' }, { id: 'b', label: '事件', icon: 'radar' }]}
      active="a" onChange={onChange} prefix="t" label="測試子頁" />);
    expect(screen.getByRole('tab', { name: '總覽' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: '總覽' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('市場摘要預設收合（aria-expanded=false），展開才列出競品；股價過期時收合狀態也看得到警示', () => {
    const self = { price: 275, changePct: 0.5 };
    render(<MarketSummary self={self} stale quotes={[{ code: '3260', name: '威剛', stock: { price: 330, changePct: -1 } }]} />);
    const toggle = screen.getByRole('button', { name: /市場摘要/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('股價資料過期')).toBeTruthy();
    expect(screen.queryByText('威剛')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('威剛')).toBeTruthy();
  });
});
