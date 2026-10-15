import { useMemo, useRef } from 'react';
import { usePanelState } from '../../hooks/usePanelState.jsx';

import Card from '../../components/Card.jsx';
import CopyChartButton from '../../components/CopyChartButton.jsx';
import HistoryToggle from '../../components/HistoryToggle.jsx';
import { COMPETITOR_ORDER } from '../../config/competitors.js';

// ═══════════════════════════════════════════════════════════
// IR TAB
// ═══════════════════════════════════════════════════════════
// ─── 競品營收比較圖表 ─────────────────────────────────────
const COMP_REV_META = {
  '2451': { name: '創見', color: '#960014' },
  '3260': { name: 'ADATA 威剛', color: '#ef4444' },
  '5289': { name: '宜鼎國際', color: '#eab308' },
  '4967': { name: '十銓科技', color: '#a855f7' },
  '8271': { name: 'Apacer 宇瞻', color: '#f97316' },
  '4973': { name: '廣穎科技', color: '#3b82f6' },
};

export function CompetitorRevenueChart({ revenue, compRev }) {
  const chartRef = useRef(null);
  const [showAll, setShowAll] = usePanelState('financials.compareMonthlyAll', false);
  // series 用完整歷史建立（不只近 24 個月），表格的月增率才找得到
  // 最早那個月的「上個月」。
  const { allSeries, byKey, totalMonths } = useMemo(() => {
    const series = {};
    const addSeries = (code, records) => {
      if (!records || !records.length) return;
      records.forEach(r => {
        const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
        if (!series[key]) series[key] = { key, label: `${String(r.year).slice(2)}/${r.month}`, year: r.year, month: r.month };
        series[key][code] = r.revenue;
      });
    };
    addSeries('2451', revenue || []);
    Object.entries(compRev || {}).forEach(([code, recs]) => addSeries(code, recs));
    return {
      allSeries: Object.values(series).sort((a, b) => a.key < b.key ? -1 : 1).slice(showAll ? 0 : -24),
      byKey: series,
      totalMonths: Object.keys(series).length,
    };
  }, [revenue, compRev, showAll]);

  const compKeys = new Set(Object.keys(compRev || {}));
  const hasCodes = ['2451', ...COMPETITOR_ORDER.filter(c => compKeys.has(c))].filter(c => COMP_REV_META[c]);
  if (!allSeries.length || hasCodes.length < 2) {
    return (
      <div className="text-sm text-gray-600 text-center py-6">
        競品營收資料載入中（Actions 跑完後自動更新）
      </div>
    );
  }

  // SVG 參數
  const W = 700, H = 220, PL = 52, PR = 16, PT = 20, PB = 32;
  const VW = W - PL - PR, VH = H - PT - PB;
  const maxVal = Math.max(...allSeries.flatMap(d => hasCodes.map(c => d[c] || 0)), 1);
  const step = VW / Math.max(allSeries.length - 1, 1);

  const line = (code) => allSeries.map((d, i) => {
    const v = d[code] || 0;
    const x = PL + i * step;
    const y = PT + VH - (v / maxVal) * VH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fmtB = v => v >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}萬` : String(v);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(r => ({ r, v: maxVal * r }));

  // 月增率：跟上個月比（1 月對上年 12 月），找不到上個月或上個月為 0 時回傳 null
  const mom = (d, code) => {
    const py = d.month === 1 ? d.year - 1 : d.year;
    const pm = d.month === 1 ? 12 : d.month - 1;
    const prev = byKey[`${py}-${String(pm).padStart(2, '0')}`]?.[code];
    const cur = d[code];
    return cur != null && prev > 0 ? +((cur - prev) / prev * 100).toFixed(1) : null;
  };
  const fmtM = v => v == null ? '—' : Math.round(v / 1e6).toLocaleString(); // 百萬元
  // 全部歷史時資料點多，X 軸標籤隔幾個顯示一個（24 個月以內每個月都顯示）
  const labelStep = Math.ceil(allSeries.length / 30);
  const chartTitle = showAll ? '創見 vs 競品月營收比較（全部歷史）' : '創見 vs 競品月營收比較（近 24 個月）';
  const momCls = v => v == null ? 'text-gray-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-400';

  return (
    <Card title={chartTitle} icon="chart"
      actions={
        <div className="flex gap-1.5 flex-wrap justify-end">
          <HistoryToggle expanded={showAll} onToggle={() => setShowAll(v => !v)}
            total={totalMonths} defaultCount={24} unit="個月" />
          <CopyChartButton containerRef={chartRef} title={chartTitle}
            legend={hasCodes.map(c => ({ name: COMP_REV_META[c].name + '（' + c + '）', color: COMP_REV_META[c].color }))}
            note="資料來源：FinMind，單位：新台幣元" />
        </div>
      }>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3">
        {hasCodes.map(c => (
          <div key={c} className="flex items-center gap-1.5 text-xs text-gray-400">
            <div className="w-3 h-0.5 rounded" style={{ background: COMP_REV_META[c].color, height: '3px', width: '16px' }} />
            {COMP_REV_META[c].name}（{c}）
          </div>
        ))}
      </div>
      <div ref={chartRef}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
        {/* Y grid + labels */}
        {yTicks.map(t => {
          const y = PT + VH - t.r * VH;
          return (
            <g key={t.r}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#374151" strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PL - 4} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="8">{fmtB(t.v)}</text>
            </g>
          );
        })}
        {/* Lines */}
        {hasCodes.map(c => (
          <path key={c} d={line(c)} fill="none" stroke={COMP_REV_META[c].color} strokeWidth="1.8"
                strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* X labels：每個月都顯示 */}
        {allSeries.map((d, i) => i % labelStep === 0 && (
          <text key={d.key} x={PL + i * step} y={H - PB + 12} textAnchor="middle" fill="#6b7280" fontSize="8">
            {d.label}
          </text>
        ))}
      </svg>
      </div>
      <p className="text-xs text-gray-700 mt-1">* 資料來源：FinMind，單位：新台幣元</p>

      {/* 各公司月營收＋月增率明細（新到舊） */}
      <p className="text-xs text-gray-600 sm:hidden mt-3 mb-1">← 左右滑動可看其他公司 →</p>
      <div className={'mt-3 overflow-x-auto' + (showAll ? ' ir-scroll' : '')}>
        <table className="ir-table w-full text-sm">
          <thead>
            <tr className="text-gray-500">
              <th rowSpan={2} className="sticky left-0 bg-gray-900 text-left pb-1.5 pr-3 font-medium whitespace-nowrap align-bottom border-b border-gray-700/60">年月</th>
              {hasCodes.map(c => (
                <th key={c} colSpan={2} className="text-center px-2 pb-1 font-medium whitespace-nowrap" style={{ color: COMP_REV_META[c].color }}>
                  {COMP_REV_META[c].name}
                </th>
              ))}
            </tr>
            <tr className="border-b border-gray-700/60 text-gray-500 text-xs">
              {hasCodes.map(c => [
                <th key={c + 'r'} className="text-right pl-3 pb-1.5 font-medium whitespace-nowrap">營收</th>,
                <th key={c + 'y'} className="text-right pl-2 pr-2 pb-1.5 font-medium whitespace-nowrap">月增率</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {[...allSeries].reverse().map(d => (
              <tr key={d.key} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                <td className="sticky left-0 bg-gray-900 py-1.5 pr-3 text-gray-300 tabular-nums whitespace-nowrap">{d.label}</td>
                {hasCodes.map(c => {
                  const y = mom(d, c);
                  return [
                    <td key={c + 'r'} className="text-right py-1.5 pl-3 text-ink tabular-nums">{fmtM(d[c])}</td>,
                    <td key={c + 'y'} className={`text-right py-1.5 pl-2 pr-2 tabular-nums font-medium ${momCls(y)}`}>
                      {y == null ? '—' : (y > 0 ? '+' : '') + y + '%'}
                    </td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-700 mt-1">* 表格營收單位：百萬元；月增率與上個月比較</p>
    </Card>
  );
}

// ─── 年度營收趨勢（近 10 年）─────────────────────────────
export function AnnualRevenueChart({ revenue, compRev }) {
  const chartRef = useRef(null);
  const [showAll, setShowAll] = usePanelState('financials.compareAnnualAll', false);
  const allYears = useMemo(() => {
    const series = {};
    const addSeries = (code, records) => {
      if (!records || !records.length) return;
      records.forEach(r => {
        const key = String(r.year);
        if (!series[key]) series[key] = { label: key };
        series[key][code] = (series[key][code] || 0) + r.revenue;
      });
    };
    addSeries('2451', revenue || []);
    Object.entries(compRev || {}).forEach(([code, recs]) => addSeries(code, recs));
    return Object.values(series)
      .sort((a, b) => a.label < b.label ? -1 : 1)
      .slice(showAll ? 0 : -10);
  }, [revenue, compRev, showAll]);

  const totalYears = new Set(
    [...(revenue || []), ...Object.values(compRev || {}).flat()].map(r => r.year)).size;
  const chartTitle = showAll ? '年度營收趨勢（全部歷史）' : '年度營收趨勢（近 10 年）';

  // 表格用：stat[年][公司] = { total, byMonth }。未滿 12 個月的年度（例如
  // 今年還沒結束，或某家公司少了一個月）不能直接拿去跟去年全年比，年增率
  // 改成「同樣這幾個月」對「去年同期」，不然今年一定看起來大幅衰退。
  const stat = useMemo(() => {
    const out = {};
    const add = (code, records) => (records || []).forEach(r => {
      const y = out[r.year] || (out[r.year] = {});
      const c = y[code] || (y[code] = { total: 0, byMonth: {} });
      c.total += r.revenue;
      c.byMonth[r.month] = r.revenue;
    });
    add('2451', revenue);
    Object.entries(compRev || {}).forEach(([code, recs]) => add(code, recs));
    return out;
  }, [revenue, compRev]);

  const compKeys = new Set(Object.keys(compRev || {}));
  const hasCodes = ['2451', ...COMPETITOR_ORDER.filter(c => compKeys.has(c))].filter(c => COMP_REV_META[c]);

  if (!allYears.length || hasCodes.length < 2) {
    return (
      <div className="text-sm text-gray-600 text-center py-6">
        年度營收資料載入中（Actions 跑完後自動更新）
      </div>
    );
  }

  const W = 700, H = 240, PL = 58, PR = 16, PT = 24, PB = 36;
  const VW = W - PL - PR, VH = H - PT - PB;
  const maxVal = Math.max(...allYears.flatMap(d => hasCodes.map(c => d[c] || 0)), 1);
  const step = VW / Math.max(allYears.length - 1, 1);

  const line = (code) => allYears.map((d, i) => {
    const v = d[code] || 0;
    const x = PL + i * step;
    const y = PT + VH - (v / maxVal) * VH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fmtB = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e8 ? `${(v / 1e8).toFixed(0)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(0)}萬` : String(v);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(r => ({ r, v: maxVal * r }));

  const fmtM = v => v == null ? '—' : Math.round(v / 1e6).toLocaleString(); // 百萬元
  const cellOf = (year, code) => {
    const cur = stat[year]?.[code];
    if (!cur) return { total: null, partial: false, yoy: null };
    const months = Object.keys(cur.byMonth);
    const partial = months.length < 12;
    const prev = stat[year - 1]?.[code];
    let yoy = null;
    if (prev && months.every(m => prev.byMonth[m] != null)) {
      const prevSum = months.reduce((sum, m) => sum + prev.byMonth[m], 0);
      if (prevSum > 0) yoy = +((cur.total - prevSum) / prevSum * 100).toFixed(1);
    }
    return { total: cur.total, partial, yoy };
  };
  const yoyCls = v => v == null ? 'text-gray-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-400';

  return (
    <Card title={chartTitle} icon="trend"
      actions={
        <div className="flex gap-1.5 flex-wrap justify-end">
          <HistoryToggle expanded={showAll} onToggle={() => setShowAll(v => !v)}
            total={totalYears} defaultCount={10} unit="年" />
          <CopyChartButton containerRef={chartRef} title={chartTitle}
            legend={hasCodes.map(c => ({ name: COMP_REV_META[c].name + '（' + c + '）', color: COMP_REV_META[c].color }))}
            note="資料來源：FinMind，各年度月營收合計，單位：新台幣元" />
        </div>
      }>
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3">
        {hasCodes.map(c => (
          <div key={c} className="flex items-center gap-1.5 text-xs text-gray-400">
            <div style={{ background: COMP_REV_META[c].color, height: '3px', width: '16px', borderRadius: '2px' }} />
            {COMP_REV_META[c].name}（{c}）
          </div>
        ))}
      </div>
      <div ref={chartRef}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }}>
        {/* Y grid + labels */}
        {yTicks.map(t => {
          const y = PT + VH - t.r * VH;
          return (
            <g key={t.r}>
              <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#374151" strokeWidth="0.5" strokeDasharray="3,3" />
              <text x={PL - 4} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="8">{fmtB(t.v)}</text>
            </g>
          );
        })}
        {/* Lines */}
        {hasCodes.map(c => (
          <path key={c} d={line(c)} fill="none" stroke={COMP_REV_META[c].color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* Dots at each year */}
        {hasCodes.map(c => allYears.map((d, i) => {
          if (!d[c]) return null;
          const x = PL + i * step;
          const y = PT + VH - ((d[c] || 0) / maxVal) * VH;
          return <circle key={`${c}-${i}`} cx={x} cy={y} r="3" fill={COMP_REV_META[c].color} />;
        }))}
        {/* X year labels */}
        {allYears.map((d, i) => (
          <text key={i} x={PL + i * step} y={H - PB + 14} textAnchor="middle" fill="#6b7280" fontSize="8">
            {d.label}
          </text>
        ))}
      </svg>
      </div>
      <p className="text-xs text-gray-700 mt-1">* 資料來源：FinMind，各年度月營收合計，單位：新台幣元</p>

      {/* 各公司年度營收＋年增率明細（新到舊） */}
      <p className="text-xs text-gray-600 sm:hidden mt-3 mb-1">← 左右滑動可看其他公司 →</p>
      <div className={'mt-3 overflow-x-auto' + (showAll ? ' ir-scroll' : '')}>
        <table className="ir-table w-full text-sm">
          <thead>
            <tr className="text-gray-500">
              <th rowSpan={2} className="sticky left-0 bg-gray-900 text-left pb-1.5 pr-3 font-medium whitespace-nowrap align-bottom">年度</th>
              {hasCodes.map(c => (
                <th key={c} colSpan={2} className="text-center px-2 pb-1 font-medium whitespace-nowrap" style={{ color: COMP_REV_META[c].color }}>
                  {COMP_REV_META[c].name}
                </th>
              ))}
            </tr>
            <tr className="text-gray-500 text-xs">
              {hasCodes.map(c => [
                <th key={c + 'r'} className="text-right pl-3 pb-1.5 font-medium whitespace-nowrap">營收</th>,
                <th key={c + 'y'} className="text-right pl-2 pr-2 pb-1.5 font-medium whitespace-nowrap">年增率</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {[...allYears].reverse().map(d => (
              <tr key={d.label} className="hover:bg-gray-800/20">
                <td className="sticky left-0 bg-gray-900 py-1.5 pr-3 text-gray-300 font-medium tabular-nums">{d.label}</td>
                {hasCodes.map(c => {
                  const { total, partial, yoy } = cellOf(Number(d.label), c);
                  return [
                    <td key={c + 'r'} className="text-right py-1.5 pl-3 text-ink tabular-nums">
                      {fmtM(total)}{partial && <span className="text-yellow-500">*</span>}
                    </td>,
                    <td key={c + 'y'} className={`text-right py-1.5 pl-2 pr-2 tabular-nums font-medium ${yoyCls(yoy)}`}>
                      {yoy == null ? '—' : (yoy > 0 ? '+' : '') + yoy + '%'}
                    </td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-700 mt-1">
        * 表格營收單位：百萬元；<span className="text-yellow-500">*</span> 為未滿 12 個月（統計中），年增率以去年同期相同月份比較
      </p>
    </Card>
  );
}
