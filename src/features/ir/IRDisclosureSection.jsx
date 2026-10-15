import SummaryCard from '../../components/SummaryCard.jsx';
import { CompetitorMaterial } from './CompetitorMaterial.jsx';
import { DividendHistory } from './DividendHistory.jsx';
import { DividendSnapshot, RecentMaterialList, StatusStrip, useIRStatuses } from './irViews.jsx';
import { sortMaterial } from './irData.js';

/** 重大訊息與股利：上方摘要（最近重大訊息、最新股利、資料狀態），下方完整的重大訊息列表與歷年股利。 */
export function IRDisclosureSection({ material, dividends, loadErrors }) {
  const statuses = useIRStatuses({ stocks: {}, material, dividends, loadErrors, loading: true });
  const latest = sortMaterial(material)[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SummaryCard title="最近重大訊息" icon="bell">
          <RecentMaterialList material={material} limit={1} status={statuses.material} />
          <p className="text-xs text-gray-600 mt-2">資料最新日期：{latest ? latest.date : '—'}</p>
        </SummaryCard>
        <SummaryCard title="最新股利" icon="coins">
          <DividendSnapshot dividends={dividends} status={statuses.dividends} />
        </SummaryCard>
      </div>
      <StatusStrip statuses={statuses} keys={['material', 'dividends']} />
      <CompetitorMaterial material={material} />
      <DividendHistory dividends={dividends} />
    </div>
  );
}
