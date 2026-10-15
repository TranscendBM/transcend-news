import { useMemo, useRef } from 'react';
import { usePanelState } from '../../hooks/usePanelState.jsx';

import Card from '../../components/Card.jsx';
import CopyChartButton from '../../components/CopyChartButton.jsx';
import HistoryToggle from '../../components/HistoryToggle.jsx';
import { useElementWidth } from '../../hooks/useElementWidth.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 月營收 SVG 圖表（純 SVG，無外部依賴，viewBox 自動縮放）
// ═══════════════════════════════════════════════════════════
function MonthRevSVG({ data, width }) {
  if (!data || !data.length) return null;
  const PL = 60, PR = 52, PT = 10, PB = 36, VW = width || 800, VH = 210, CW = VW - PL - PR, CH = VH - PT - PB;
  const maxR = Math.max(...data.map(d => Math.max(d.rev || 0, d.prevYr || 0)), 1);
  const yv = data.map(d => d.yoyPct).filter(v => v != null);
  const minY = yv.length ? Math.min(...yv, 0) : -10, maxY = yv.length ? Math.max(...yv, 0) : 10;
  const rY = Math.max(maxY - minY, 1);
  const step = CW / data.length, bw = step * 0.38;
  const toH = v => ((v || 0) / maxR) * CH;
  const toLY = v => v == null ? null : PT + CH * (1 - (v - minY) / rY);
  const fR = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : `${(v / 1e3).toFixed(0)}K`;
  const rT = [.25, .5, .75, 1].map(t => ({ y: PT + CH * (1 - t), v: maxR * t }));
  let lp = ''; data.forEach((d, i) => { const y = toLY(d.yoyPct); if (y != null) lp += `${lp ? 'L' : 'M'}${PL + i * step + step / 2},${y}`; });
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: 'block' }}>
      {rT.map((t, i) => <line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" />)}
      {minY < 0 && maxY > 0 && <line x1={PL} x2={VW - PR} y1={toLY(0)} y2={toLY(0)} stroke="#374151" strokeWidth="1" strokeDasharray="4,4" />}
      {data.map((d, i) => { const cx = PL + i * step + step / 2; return (<g key={i}>
        <rect x={cx - bw * 1.1} y={PT + CH - toH(d.rev)} width={bw} height={toH(d.rev)} fill="#960014" rx="1" opacity="0.9" />
        <rect x={cx + bw * 0.1} y={PT + CH - toH(d.prevYr)} width={bw} height={toH(d.prevYr)} fill="#374151" rx="1" opacity="0.75" />
      </g>); })}
      {lp && <path d={lp} fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />}
      {data.map((d, i) => i % Math.ceil(data.length / 30) === 0 && <text key={i} x={PL + i * step + step / 2} y={VH - PB + 14} textAnchor="middle" fill="#6b7280" fontSize={data.length > 16 ? 7 : 9}>{d.label}</text>)}
      {rT.map((t, i) => <text key={i} x={PL - 5} y={t.y + 4} textAnchor="end" fill="#6b7280" fontSize="9">{fR(t.v)}</text>)}
      {[minY, (minY + maxY) / 2, maxY].map((v, i) => <text key={i} x={VW - PR + 5} y={(toLY(v) || 0) + 4} textAnchor="start" fill="#6b7280" fontSize="9">{v > 0 ? '+' : ''}{v.toFixed(0)}%</text>)}
      <rect x={PL} y={VH - 5} width={10} height={5} fill="#960014" rx="1" />
      <text x={PL + 13} y={VH} fill="#9ca3af" fontSize="9">當月營收</text>
      <rect x={PL + 65} y={VH - 5} width={10} height={5} fill="#374151" rx="1" />
      <text x={PL + 78} y={VH} fill="#9ca3af" fontSize="9">去年同期</text>
      <line x1={PL + 135} x2={PL + 145} y1={VH - 2} y2={VH - 2} stroke="#4ade80" strokeWidth="2" />
      <text x={PL + 148} y={VH} fill="#9ca3af" fontSize="9">年增率</text>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 年度營收 SVG 圖表（純 SVG，無外部依賴）
// ═══════════════════════════════════════════════════════════
function AnnualRevSVG({ data, width }) {
  if (!data || !data.length) return null;
  const PL = 68, PR = 8, PT = 22, PB = 28, VW = width || 800, VH = 200, CW = VW - PL - PR, CH = VH - PT - PB;
  const maxR = Math.max(...data.map(d => d.total || 0), 1);
  const step = CW / data.length, bw = step * 0.65;
  const toH = v => ((v || 0) / maxR) * CH;
  const fR = v => v >= 1e10 ? `${(v / 1e10).toFixed(0)}百億` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
  const rT = [.25, .5, .75, 1].map(t => ({ y: PT + CH * (1 - t), v: maxR * t }));
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height={VH} style={{ display: 'block' }}>
      {rT.map((t, i) => <line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" />)}
      {data.map((d, i) => {
        const x = PL + i * step + (step - bw) / 2, bh = toH(d.total), y = PT + CH - bh;
        const c = d.yoy == null ? '#960014' : d.yoy >= 0 ? '#960014' : '#4b5563';
        return (<g key={i}>
          <rect x={x} y={y} width={bw} height={bh} fill={c} rx="2" opacity="0.85" />
          {/* 台股慣例：上漲用紅色、下跌用綠色（跟美股相反） */}
          {d.yoy != null && <text x={x + bw / 2} y={y - 5} textAnchor="middle" fill={d.yoy >= 0 ? '#f87171' : '#4ade80'} fontSize="8">{d.yoy > 0 ? '+' : ''}{d.yoy.toFixed(1)}%</text>}
        </g>);
      })}
      {data.map((d, i) => <text key={i} x={PL + i * step + step / 2} y={VH - PB + 14} textAnchor="middle" fill="#6b7280" fontSize="10">{d.year}</text>)}
      {rT.map((t, i) => <text key={i} x={PL - 5} y={t.y + 4} textAnchor="end" fill="#6b7280" fontSize="9">{fR(t.v)}</text>)}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 月營收圖表
// ═══════════════════════════════════════════════════════════
export function RevenueChart({ revenue }) {
  const monthChartRef = useRef(null);
  const annualChartRef = useRef(null);
  // 圖表用容器實際寬度繪製，才會填滿卡片（寫死寬度時寬螢幕兩側會留白）
  const monthChartWidth = useElementWidth(monthChartRef);
  const annualChartWidth = useElementWidth(annualChartRef);
  const [showAll, setShowAll] = usePanelState('financials.monthlyAll', false);
  const [showAllAnnual, setShowAllAnnual] = usePanelState('financials.annualAll', false);
  const fmtRev = v => Number(v).toLocaleString(); // 千分位，單位：元

  // 自行建立 lookup map，對照去年同期（不依賴 FinMind 的 revenue_year 欄位）
  const revMap = useMemo(() => {
    if (!revenue) return {};
    const m = {};
    revenue.forEach(r => { m[`${r.year}-${r.month}`] = r.revenue; });
    return m;
  }, [revenue]);

  const data = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    return revenue.slice(showAll ? 0 : -24).map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      return {
        label: `${String(r.year).slice(2)}/${r.month}`,
        rev: r.revenue,
        prevYr,
        yoyPct,
      };
    });
  }, [revenue, revMap, showAll]);

  // 近 10 年年度彙總（取 11 筆讓最早那年也能算 YoY）
  const annualData = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    const byYear = {};
    revenue.forEach(r => {
      if (!byYear[r.year]) byYear[r.year] = { year: r.year, total: 0, months: 0 };
      byYear[r.year].total += r.revenue;
      byYear[r.year].months += 1;
    });
    const years = Object.values(byYear).sort((a, b) => a.year - b.year);
    const base = showAllAnnual ? years : years.slice(-11); // 預設取 11 筆以計算最早年的 YoY
    return base.map((y, i, arr) => {
      const prev = arr[i - 1];
      const yoy = prev && prev.total > 0
        ? +((y.total - prev.total) / prev.total * 100).toFixed(2)
        : null;
      return { ...y, yoy };
    }).slice(showAllAnnual ? 0 : -10); // 預設只顯示 10 年
  }, [revenue, showAllAnnual]);

  const hasData = data.length > 0;
  const totalMonths = revenue ? revenue.length : 0;
  const totalYears = useMemo(() => new Set((revenue || []).map(r => r.year)).size, [revenue]);
  const monthTitle = showAll ? '創見月營收（全部歷史，' + totalMonths + ' 個月）' : '創見月營收（近 24 個月）';
  const annualTitle = showAllAnnual ? '年度營收趨勢（全部歷史，創見）' : '年度營收趨勢（近 10 年，創見）';
  const recent12 = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    return [...revenue].slice(showAll ? 0 : -12).reverse().map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      // label 沒有隨 r 的其他欄位一起帶著走（原始 revenue 記錄本身沒有
      // label 欄位，只有給圖表用的 data 陣列會另外算一次），漏了這行會讓
      // 明細表格的「年月」欄位整欄空白——曾經真的發生過。
      return { ...r, label: `${String(r.year).slice(2)}/${r.month}`, prevYrCalc: prevYr, yoyPctCalc: yoyPct };
    });
  }, [revenue, revMap, showAll]);

  return (
    <>
    <Card title={monthTitle} icon="coins"
      actions={hasData && (
        <div className="flex gap-1.5 flex-wrap justify-end">
          <HistoryToggle expanded={showAll} onToggle={() => setShowAll(v => !v)}
            total={totalMonths} defaultCount={24} unit="個月" />
          <CopyChartButton containerRef={monthChartRef} title={monthTitle}
            note="資料來源：FinMind，單位：新台幣元" />
        </div>
      )}>
      {hasData ? (
        <>
          <div ref={monthChartRef}><MonthRevSVG data={data} width={monthChartWidth} /></div>

          {/* 近 12 個月明細表 */}
          {/* 手機寬度下表格會超出可視範圍，靠橫向捲動看到其餘欄位（含
              年增率）——沒有這行提示的話，使用者很容易以為表格只有
              目前看得到的那幾欄，完全不會想到要往右滑。 */}
          <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看年增率 →</p>
          <div className={'mt-3 overflow-x-auto' + (showAll ? ' ir-scroll' : '')}>
            <table className="ir-table w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700/60 text-gray-500">
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">年月</th>
                  <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">當月營收（元）</th>
                  <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">去年同期（元）</th>
                  <th className="text-right pb-1.5 font-medium whitespace-nowrap">年增率</th>
                </tr>
              </thead>
              <tbody>
                {recent12.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                    <td className="py-1.5 pr-3 text-gray-300 tabular-nums">{r.label}</td>
                    <td className="text-right py-1.5 pr-3 text-ink tabular-nums font-medium">
                      {fmtRev(r.revenue)}
                    </td>
                    <td className="text-right py-1.5 pr-3 text-gray-500 tabular-nums">
                      {r.prevYrCalc > 0 ? fmtRev(r.prevYrCalc) : '—'}
                    </td>
                    <td className={`text-right py-1.5 font-bold tabular-nums ${r.yoyPctCalc == null ? 'text-gray-600' : r.yoyPctCalc > 0 ? 'text-red-400' : r.yoyPctCalc < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                      {r.yoyPctCalc == null ? '—' : (r.yoyPctCalc > 0 ? '+' : '') + r.yoyPctCalc + '%'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="h-40 flex items-center justify-center text-gray-600 text-sm">
          {revenue === null ? '載入中…' : '尚無月營收資料（Actions 跑完後自動更新）'}
        </div>
      )}
    </Card>

    {/* 近 10 年年度營收趨勢 */}
    {annualData.length > 0 && (
    <Card title={annualTitle} icon="chart"
      actions={
        <div className="flex gap-1.5 flex-wrap justify-end">
          <HistoryToggle expanded={showAllAnnual} onToggle={() => setShowAllAnnual(v => !v)}
            total={totalYears} defaultCount={10} unit="年" />
          <CopyChartButton containerRef={annualChartRef} title={annualTitle}
            note="資料來源：FinMind，各年度月營收合計，單位：新台幣元" />
        </div>
      }>
      {/* 折線圖 */}
      <div ref={annualChartRef}><AnnualRevSVG data={annualData} width={annualChartWidth} /></div>

      {/* 明細表 */}
      <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
      <div className={'mt-3 overflow-x-auto' + (showAllAnnual ? ' ir-scroll' : '')}>
        <table className="ir-table w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700/60 text-gray-500">
              <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">年度</th>
              <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">全年營收（元）</th>
              <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">年增率</th>
              <th className="text-right pb-1.5 font-medium whitespace-nowrap">涵蓋月數</th>
            </tr>
          </thead>
          <tbody>
            {[...annualData].reverse().map((y, i) => (
              <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                <td className="py-1.5 pr-3 text-gray-300 font-medium tabular-nums">{y.year}</td>
                <td className="text-right py-1.5 pr-3 text-ink tabular-nums font-medium">{fmtRev(y.total)}</td>
                <td className={`text-right py-1.5 pr-3 font-bold tabular-nums ${y.yoy == null ? 'text-gray-600' : y.yoy > 0 ? 'text-red-400' : y.yoy < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                  {y.yoy == null ? '—' : (y.yoy > 0 ? '+' : '') + y.yoy + '%'}
                </td>
                <td className="text-right py-1.5 tabular-nums">
                  {y.months < 12
                    ? <span className="text-yellow-500">{y.months} 月（統計中）</span>
                    : <span className="text-gray-600">12 月</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-700 mt-2">* 資料來源：FinMind 月營收加總，單位：新台幣元</p>
    </Card>
    )}
    </>
  );
}
