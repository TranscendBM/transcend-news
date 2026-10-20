import { useMemo } from 'react';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import ShowMoreButton, { useShowMore } from '../../components/ShowMore.jsx';
import NewsCard from '../news/NewsCard.jsx';
import { COMPETITORS } from '../../config/competitors.js';
import { useNow } from '../../hooks/useNow.js';
import { BRAND_COUNT_PERIODS, COMPETITOR_TIME_FILTERS, brandExposureCounts, selectCompetitorNews } from './prData.js';
import { usePRState } from './prState.jsx';

// ═══════════════════════════════════════════════════════════
// PR — 競品動態監測：品牌篩選＋期間篩選＋完整清單
// 這裡的篩選狀態（品牌、期間）完全獨立於「新聞監測」的搜尋工具列：兩邊資料來源不同
// （這裡是 useNewsFeed 的競品新聞，新聞監測是 usePRNews 的創見報導），不共用篩選。
// ═══════════════════════════════════════════════════════════
function BrandExposureTable({ news, active, timeFilter, onBrand, onPeriod }) {
  const now = useNow();
  const rows = useMemo(() => brandExposureCounts(news, now), [news, now]);
  const max = Math.max(1, ...rows.filter(r => r.id !== 'all').map(r => r.counts[timeFilter] || 0));
  return (
    <div className="mb-4" data-testid="brand-exposure">
      <p className="text-xs text-gray-500 mb-1.5">各品牌新聞曝光數量（點品牌或期間可套用到下方清單）</p>
      <div className="overflow-x-auto rounded-xl border border-gray-700/60">
        <table className="w-full text-sm min-w-[360px]">
          <thead>
            <tr className="text-xs text-gray-500 bg-gray-800/40">
              <th scope="col" className="text-left font-medium px-3 py-2">品牌</th>
              {BRAND_COUNT_PERIODS.map(p => (
                <th key={p.id} scope="col" className="px-2 py-2 text-right font-medium">
                  <button type="button" onClick={() => onPeriod(p.id)} aria-pressed={timeFilter === p.id}
                    className={`px-1.5 rounded ${timeFilter === p.id ? 'text-red-700 font-bold' : 'hover:text-gray-200'}`}>{p.label}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={`border-t border-gray-700/40 ${r.id === 'all' ? 'bg-gray-800/30 font-semibold' : ''} ${active === r.id ? 'bg-red-50/40' : ''}`}>
                <th scope="row" className="text-left font-medium px-3 py-1.5">
                  <button type="button" onClick={() => onBrand(r.id)} aria-pressed={active === r.id} className="flex items-center gap-1.5 hover:text-red-700 text-left">
                    {r.color && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: r.color }} aria-hidden="true" />}
                    {r.name}
                  </button>
                </th>
                {BRAND_COUNT_PERIODS.map(p => (
                  <td key={p.id} className={`px-2 py-1.5 text-right tabular-nums ${timeFilter === p.id ? 'font-bold' : 'text-gray-400'}`}>
                    {r.counts[p.id]}
                    {r.id !== 'all' && timeFilter === p.id && (
                      <span className="block h-1 mt-0.5 rounded-full ml-auto" style={{ width: `${Math.round(r.counts[p.id] / max * 100)}%`, background: r.color }} aria-hidden="true" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
      <BrandExposureTable news={news} active={active} timeFilter={timeFilter} onBrand={setActive} onPeriod={setTimeFilter} />

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
