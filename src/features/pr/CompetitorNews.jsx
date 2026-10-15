import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import NewsCard from '../news/NewsCard.jsx';
import { COMPETITORS } from '../../config/competitors.js';
import { COMPETITOR_TIME_FILTERS, selectCompetitorNews } from './prData.js';
import { usePRState } from './prState.jsx';

// ═══════════════════════════════════════════════════════════
// PR — 競品動態監測：品牌篩選＋期間篩選＋完整清單
// 這裡的篩選狀態（品牌、期間）完全獨立於「新聞監測」的搜尋工具列：兩邊資料來源不同
// （這裡是 useNewsFeed 的競品新聞，新聞監測是 usePRNews 的創見報導），不共用篩選。
// ═══════════════════════════════════════════════════════════
export function CompetitorNews({ news }) {
  const [active, setActive] = usePRState('competitors.brand', 'all');
  const [timeFilter, setTimeFilter] = usePRState('competitors.period', 'month');
  const comp = COMPETITORS.find(c => c.id === active);

  const filtered = useMemo(
    () => selectCompetitorNews(news, { brand: active, timeFilter }),
    [news, active, timeFilter]);
  const more = useShowMore(filtered, 80, [active, timeFilter]);

  return (
    <Card title="競品動態監測" icon="search" className="h-full">
      {/* Brand tabs — 全部 + 各品牌 */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        <TabBtn active={active === 'all'} onClick={() => setActive('all')}>
          全部
        </TabBtn>
        {COMPETITORS.map(c => (
          <TabBtn key={c.id} active={active === c.id} onClick={() => setActive(c.id)}>
            {c.name}
          </TabBtn>
        ))}
      </div>

      {/* Time filter */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {COMPETITOR_TIME_FILTERS.map(f => (
          <TabBtn key={f.id} active={timeFilter === f.id} onClick={() => setTimeFilter(f.id)}>
            {f.label}
          </TabBtn>
        ))}
      </div>

      {filtered.length > 0
        ? <>
            <div className="space-y-2">{more.shown.map((n, i) => <NewsCard key={n.id || i} article={n} />)}</div>
            <ShowMoreButton remaining={more.remaining} step={80} onMore={more.showMore} onAll={more.showAll} />
          </>
        : <p className="text-sm text-gray-600 text-center py-8">
            {active === 'all' ? '暫無競品報導' : `暫無 ${comp?.name} 相關報導`}
          </p>
      }
    </Card>
  );
}
