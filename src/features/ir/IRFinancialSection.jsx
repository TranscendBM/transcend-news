import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import { usePanelState } from '../../hooks/usePanelState.jsx';
import { RevenueChart } from './RevenueCharts.jsx';
import { CompetitorRevenueChart, AnnualRevenueChart } from './CompetitorRevenue.jsx';
import { QuarterlyPnL } from './QuarterlyPnL.jsx';
import { FinancialSnapshot, StatusStrip, useIRStatuses } from './irViews.jsx';

const VIEWS = [
  { id: 'revenue', label: '月營收' },
  { id: 'pnl', label: '季度損益' },
  { id: 'compare', label: '競品比較' },
];

/** 財務營運：最新一期摘要卡＋頁內切換（月營收／季度損益／競品比較）。歷史表格預設只顯示近期，可展開全部。 */
export function IRFinancialSection({ revenue, financials, compRev, loadErrors }) {
  const [view, setView] = usePanelState('financials.view', 'revenue');
  const statuses = useIRStatuses({ stocks: {}, revenue, financials, loadErrors, loading: true });
  const current = VIEWS.some(v => v.id === view) ? view : 'revenue';

  return (
    <div className="space-y-4">
      <Card title="最新一期財務摘要" icon="coins"
        actions={<StatusStrip statuses={statuses} keys={['revenue', 'financials']} />}>
        <FinancialSnapshot revenue={revenue} financials={financials} statuses={statuses} showNetMargin />
      </Card>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="財務營運檢視">
        {VIEWS.map(v => (
          <TabBtn key={v.id} active={current === v.id} onClick={() => setView(v.id)}>{v.label}</TabBtn>
        ))}
      </div>

      {current === 'revenue' && <RevenueChart revenue={revenue} />}
      {current === 'pnl' && <QuarterlyPnL financials={financials} />}
      {current === 'compare' && (
        <>
          <CompetitorRevenueChart revenue={revenue} compRev={compRev} />
          <AnnualRevenueChart revenue={revenue} compRev={compRev} />
        </>
      )}
    </div>
  );
}
