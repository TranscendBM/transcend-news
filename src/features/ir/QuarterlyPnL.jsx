import { useMemo } from 'react';
import { usePanelState } from '../../hooks/usePanelState.jsx';

import Card from '../../components/Card.jsx';
import HistoryToggle from '../../components/HistoryToggle.jsx';
import TermTip from './TermTip.jsx';
import { dateKey } from './irData.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 季度損益摘要
// ═══════════════════════════════════════════════════════════
export function QuarterlyPnL({ financials }) {
  const [showAll, setShowAll] = usePanelState('financials.pnlAll', false);
  const quarters = useMemo(() => {
    if (!financials || !financials.length) return [];
    return [...financials].sort((a, b) => dateKey(b.date) - dateKey(a.date)).slice(0, showAll ? undefined : 8);
  }, [financials, showAll]);

  const pctCell = v => {
    if (v == null || v === 0) return <span className="text-gray-600">—</span>;
    const cls = v >= 30 ? 'text-green-400' : v >= 15 ? 'text-yellow-400' : 'text-red-400';
    return <span className={cls}>{v.toFixed(1)}%</span>;
  };

  const TERM_TIPS = {
    grossMargin: { label: '毛利率', tip: '賣東西的收入，扣掉原料和直接製造成本後剩下的比例。毛利率越高，代表產品越有競爭力。例：毛利率 30% = 每賣 100 元有 30 元是毛利。' },
    opMargin: { label: '營業利益率', tip: '毛利再扣掉員工薪資、行銷廣告、管理費用後的比例。反映公司整體營運效率，能看出公司是否「賺了卻花光」。' },
    netMargin: { label: '稅後淨利率', tip: '全部費用和稅都扣完後，公司真正賺到的比例。這是最終「實際入袋」的錢，是評估獲利能力最關鍵的指標之一。' },
    eps: { label: 'EPS', tip: '每股盈餘 = 公司季度獲利 ÷ 發行總股數。EPS 越高代表每股賺越多。例：EPS $2 = 持有 1 張（1000 股）的股東，該季理論上貢獻公司獲利 2,000 元。' },
  };

  return (
    <Card title={showAll ? '季度損益摘要（全部歷史）' : '季度損益摘要（近 8 季）'} icon="table"
      actions={
        <HistoryToggle expanded={showAll} onToggle={() => setShowAll(v => !v)}
          total={financials ? financials.length : 0} defaultCount={8} unit="季" />
      }>
      {quarters.length > 0 ? (
        <>
        <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
        <div className={'overflow-x-auto' + (showAll ? ' ir-scroll' : '')}>
          <table className="ir-table w-full text-sm">
            <caption className="sr-only">季度損益摘要</caption>
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th scope="col" className="text-left pb-2 pr-3 font-medium whitespace-nowrap">季度</th>
                {['grossMargin', 'opMargin', 'netMargin', 'eps'].map(k => (
                  <th key={k} scope="col" className="text-right pb-2 pr-3 font-medium last:pr-0 whitespace-nowrap">
                    <span className="inline-flex items-center justify-end gap-1">
                      <span>{TERM_TIPS[k].label}</span>
                      <TermTip name={TERM_TIPS[k].label} tip={TERM_TIPS[k].tip} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quarters.map((q, i) => (
                <tr key={q.date || i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <th scope="row" className="text-left py-1.5 pr-3 text-ink font-normal tabular-nums">{(q.date || '').slice(0, 7)}</th>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.grossMargin)}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.opMargin)}</td>
                  <td className="text-right py-1.5 pr-3 tabular-nums">{pctCell(q.netMargin)}</td>
                  <td className={`text-right py-1.5 pr-0 font-bold tabular-nums ${(q.eps || 0) > 0 ? 'text-ink' : (q.eps || 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {q.eps != null ? `$${Number(q.eps).toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {financials === null ? '載入中…' : '尚無季度損益資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 季度財報 · 顏色：≥30% 綠、15-30% 黃、&lt;15% 紅</p>
    </Card>
  );
}
