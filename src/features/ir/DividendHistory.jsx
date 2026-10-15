import { useMemo } from 'react';
import { usePanelState } from '../../hooks/usePanelState.jsx';

import Card from '../../components/Card.jsx';
import HistoryToggle from '../../components/HistoryToggle.jsx';
import TermTip from './TermTip.jsx';
import { dividendTotal, sortDividends, fmtNum } from './irData.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 歷年股利配息
// ═══════════════════════════════════════════════════════════
export function DividendHistory({ dividends }) {
  const [showAll, setShowAll] = usePanelState('disclosures.dividendAll', false);
  const records = useMemo(() => {
    if (!dividends || !dividends.length) return [];
    return sortDividends(dividends).slice(0, showAll ? undefined : 10);
  }, [dividends, showAll]);

  const DIV_TIPS = [
    { label: '現金股利',
      tip: '公司把獲利以現金方式發給股東，是投資人「實際拿到手」的報酬。例：持有 1 張（1000 股）、現金股利 $5 = 實拿 5,000 元現金。' },
    { label: '股票股利',
      tip: '公司發給股東的是股票而非現金。股票張數增加，但每股價值同步稀釋，通常代表公司保留盈餘用於擴充。' },
    { label: '殖利率',
      tip: '現金股利 ÷ 當時股價 × 100%。代表「以此價格買進，一年的配息報酬率」。一般台股殖利率高於 5% 視為高殖利率股，創見近年殖利率約 5-8%。' },
  ];

  const divTipMap = Object.fromEntries(DIV_TIPS.map(d => [d.label, d.tip]));

  return (
    <Card title={showAll ? '歷年股利配息（全部歷史）' : '歷年股利配息（近 10 年）'} icon="coins"
      actions={
        <HistoryToggle expanded={showAll} onToggle={() => setShowAll(v => !v)}
          total={dividends ? dividends.length : 0} defaultCount={10} unit="年" />
      }>
      {records.length > 0 ? (
        <>
        <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
        <div className={'overflow-x-auto' + (showAll ? ' ir-scroll' : '')}>
          <table className="ir-table w-full text-sm">
            <caption className="sr-only">歷年股利配息（每股新台幣元）</caption>
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th scope="col" className="text-left pb-2 pr-3 font-medium whitespace-nowrap">配息年度</th>
                <th scope="col" className="text-right pb-2 pr-3 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>現金股利（元）</span>
                    <TermTip name="現金股利" tip={divTipMap['現金股利']} />
                  </span>
                </th>
                <th scope="col" className="text-right pb-2 pr-3 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>股票股利（元）</span>
                    <TermTip name="股票股利" tip={divTipMap['股票股利']} />
                  </span>
                </th>
                <th scope="col" className="text-right pb-2 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>合計（元）</span>
                    <TermTip name="合計（殖利率）" tip={divTipMap['殖利率']} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <th scope="row" className="text-left py-1.5 pr-3 text-ink font-medium tabular-nums">{r.year}</th>
                  <td className="text-right py-1.5 pr-3 text-ink tabular-nums">
                    {Number(r.cashDividend) > 0 ? `$${fmtNum(r.cashDividend)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 pr-3 text-ink tabular-nums">
                    {Number(r.stockDividend) > 0 ? `$${fmtNum(r.stockDividend)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 text-ink tabular-nums font-bold">
                    {dividendTotal(r) > 0 ? `$${fmtNum(dividendTotal(r))}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {dividends === null ? '載入中…' : '尚無股利資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 股利資料，金額為每股新台幣元</p>
    </Card>
  );
}
