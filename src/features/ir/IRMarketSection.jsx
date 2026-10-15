import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import { usePanelState } from '../../hooks/usePanelState.jsx';
import { STOCK_META } from '../../config/competitors.js';
import { DailyTrading } from './DailyTrading.jsx';
import StockCardsGrid, { ALL_STOCK_CODES } from './StockCardsGrid.jsx';
import { StatusStrip, useIRStatuses } from './irViews.jsx';
import { latestStockUpdate } from './irData.js';

const fmtTime = ms => new Date(ms).toLocaleString('zh-TW', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** 股價與競品：創見與競品股價卡（可依公司篩選）、創見每日交易資訊。 */
export function IRMarketSection({ stocks, daily, loadErrors, loading }) {
  const [company, setCompany] = usePanelState('market.company', 'all');
  const statuses = useIRStatuses({ stocks, loadErrors, loading });
  const codes = company === 'all' ? ALL_STOCK_CODES : ALL_STOCK_CODES.filter(c => c === company);
  const updated = latestStockUpdate(stocks);

  return (
    <div className="space-y-4">
      <Card title="股價與競品" icon="trend"
        actions={<StatusStrip statuses={statuses} keys={['stocks']} />}>
        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="公司篩選">
          <TabBtn active={company === 'all'} onClick={() => setCompany('all')}>全部</TabBtn>
          {ALL_STOCK_CODES.map(code => (
            <TabBtn key={code} active={company === code} onClick={() => setCompany(code)}>
              {code} {STOCK_META[code].name}
            </TabBtn>
          ))}
        </div>
        <StockCardsGrid stocks={stocks} codes={codes} />
        <p className="text-xs text-gray-600 mt-3">
          最後更新：{updated ? fmtTime(updated) : '更新時間不明'} · 上漲紅色（▲）、下跌綠色（▼）；交易時段內超過 30 分鐘未更新會標示「資料過期」
        </p>
      </Card>
      <DailyTrading daily={daily} />
    </div>
  );
}
