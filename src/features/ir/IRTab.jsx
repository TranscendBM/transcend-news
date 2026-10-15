import { useSectionNav } from '../../hooks/useSectionNav.js';
import { PanelStateProvider } from '../../hooks/usePanelState.jsx';
import { subPanelId, subTabId } from '../../components/SubNavigation.jsx';
import IRSubNavigation from './IRSubNavigation.jsx';
import { IROverview } from './IROverview.jsx';
import { IRMarketSection } from './IRMarketSection.jsx';
import { IRFinancialSection } from './IRFinancialSection.jsx';
import { IRDisclosureSection } from './IRDisclosureSection.jsx';
import { DEFAULT_IR_SECTION, IR_SECTIONS, IR_SECTION_IDS } from './irSections.js';

// ═══════════════════════════════════════════════════════════
// IR 投資情報 — 第二層導覽（總覽／股價與競品／財務營運／重大訊息與股利）
//
// 資料與 Firestore 監聽、股價更新倒數都在 App 層，由 props 傳進來；
// 這裡切換子頁只是換掉「顯示哪一塊」，不會建立新的查詢、不會重設計時器。
// 目前的子頁存在網址 ?tab=ir&section=（沒有或不認識的值 → 總覽），上一頁／下一頁會切換子頁。
// 各子頁的篩選／展開狀態放在 PanelStateProvider，切換子頁後仍保留。
// ═══════════════════════════════════════════════════════════
// news/community 為既有但目前無畫面引用的 props，原樣保留。
// eslint-disable-next-line no-unused-vars
export function IRTab({ news, stocks, community, revenue, financials, dividends, material, daily, compRev, loadErrors = {}, loading = false }) {
  const [section, navigate] = useSectionNav('ir', IR_SECTION_IDS, DEFAULT_IR_SECTION);

  const content = {
    overview: (
      <IROverview stocks={stocks} revenue={revenue} financials={financials} dividends={dividends}
        material={material} loadErrors={loadErrors} loading={loading} onNavigate={navigate} />
    ),
    market: <IRMarketSection stocks={stocks} daily={daily} loadErrors={loadErrors} loading={loading} />,
    financials: <IRFinancialSection revenue={revenue} financials={financials} compRev={compRev} loadErrors={loadErrors} />,
    disclosures: <IRDisclosureSection material={material} dividends={dividends} loadErrors={loadErrors} />,
  }[section];

  return (
    <PanelStateProvider>
      <div className="space-y-4 fade-in">
        <IRSubNavigation active={section} onChange={navigate} />
        {IR_SECTIONS.map(s => (
          <div key={s.id} role="tabpanel" id={subPanelId('ir', s.id)} aria-labelledby={subTabId('ir', s.id)}
            hidden={s.id !== section} tabIndex={s.id === section ? 0 : undefined}
            className="outline-none focus-visible:ring-2 focus-visible:ring-red-700 rounded-xl">
            {s.id === section ? content : null}
          </div>
        ))}
      </div>
    </PanelStateProvider>
  );
}
