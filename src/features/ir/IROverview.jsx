import SummaryCard from '../../components/SummaryCard.jsx';
import { COMPETITOR_ORDER } from '../../config/competitors.js';
import { EmptyFinancialState } from './DataStatus.jsx';
import {
  CompetitorStockRows, DividendSnapshot, FinancialSnapshot, RecentMaterialList, SelfStockSummary,
  IRStatusBar, useIRStatuses,
} from './irViews.jsx';

const OVERVIEW_MATERIAL_LIMIT = 5;

/**
 * IR 總覽：只放摘要，每塊有「查看全部」。所有數字都來自 App 已載入的資料（沒有新的 Firestore 查詢），
 * 長表格與圖表都留在各自的子頁。
 */
export function IROverview({ stocks, revenue, financials, dividends, material, loadErrors, loading, onNavigate }) {
  const statuses = useIRStatuses({ stocks, revenue, financials, dividends, material, loadErrors, loading });
  const self = stocks['2451'];

  return (
    <div className="space-y-4">
      <IRStatusBar statuses={statuses} onNavigate={onNavigate} />

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <SummaryCard title="創見股價" className="lg:col-span-2" icon="trend" onViewAll={() => onNavigate('market')}>
          {self
            ? <SelfStockSummary stock={self} status={statuses.stocks} />
            : <EmptyFinancialState status={statuses.stocks === 'ok' || statuses.stocks === 'stale' ? 'empty' : statuses.stocks} />}
        </SummaryCard>
        <SummaryCard title="競品股價摘要" icon="target" className="lg:col-span-3" onViewAll={() => onNavigate('market')}>
          <CompetitorStockRows stocks={stocks} codes={COMPETITOR_ORDER} />
        </SummaryCard>
      </div>

      <SummaryCard title="財務營運摘要" icon="coins" onViewAll={() => onNavigate('financials')}>
        <FinancialSnapshot revenue={revenue} financials={financials} statuses={statuses} />
      </SummaryCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SummaryCard title="最近重大訊息" icon="bell" onViewAll={() => onNavigate('disclosures')}>
          <RecentMaterialList material={material} limit={OVERVIEW_MATERIAL_LIMIT} status={statuses.material} />
        </SummaryCard>
        <SummaryCard title="最新股利" icon="coins" onViewAll={() => onNavigate('disclosures')}>
          <DividendSnapshot dividends={dividends} status={statuses.dividends} />
        </SummaryCard>
      </div>
    </div>
  );
}
