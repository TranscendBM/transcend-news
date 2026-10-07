import { useState, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import CopyChartButton from '../../components/CopyChartButton.jsx';
import CompanyLogo from '../../components/logos/CompanyLogo.jsx';
import { isStockStale, fmtStockUpdated } from '../../utils/dates.js';
import { BRAND } from '../../utils/news.js';
import { COMPETITOR_ORDER, STOCK_META } from '../../config/competitors.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 股價卡片
// ═══════════════════════════════════════════════════════════
function StockCard({ code, data }) {
  const meta = STOCK_META[code] || {};
  const up = data.changePct > 0, dn = data.changePct < 0;
  const stale = isStockStale(data);
  return (
    <div className="p-4 rounded-2xl bg-gray-900 transition-all">
      <div className="mb-2">
        <CompanyLogo code={code} height={24} />
      </div>
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="text-xs text-gray-500">{code}</p>
          <p className="font-bold text-ink">{data.name || meta.name}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {stale && (
            <span className="text-xs px-2 py-0.5 rounded-full border" title="交易時段中超過 30 分鐘未更新"
              style={{ background: 'rgba(217,119,6,0.15)', color: '#fbbf24', borderColor: 'rgba(217,119,6,0.4)' }}>
              資料過期
            </span>
          )}
        </div>
      </div>
      <p className="text-2xl font-bold text-ink">${data.price ?? '--'}</p>
      {/* 台股慣例：上漲用紅色、下跌用綠色（跟美股相反） */}
      <div className={`flex items-center gap-1 text-sm font-semibold mt-1 ${up ? 'text-red-400' : dn ? 'text-green-400' : 'text-gray-400'}`}>
        <span>{up ? '▲' : dn ? '▼' : '─'}</span>
        <span>{up ? '+' : ''}{data.changePct?.toFixed(2) ?? '--'}%</span>
      </div>
      <p className="text-sm text-gray-600 mt-1">
        {up ? '+' : ''}{data.change?.toFixed(1) ?? '--'} ·
        量 {data.volume ? (data.volume / 1000).toFixed(0) + '張' : '--'}
      </p>
      <p className={`text-xs mt-1 ${stale ? 'text-amber-500/80' : 'text-gray-600'}`}>{fmtStockUpdated(data)}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 月營收 SVG 圖表（純 SVG，無外部依賴，viewBox 自動縮放）
// ═══════════════════════════════════════════════════════════
function MonthRevSVG({ data }) {
  if (!data || !data.length) return null;
  const PL = 60, PR = 52, PT = 10, PB = 36, VW = 800, VH = 210, CW = VW - PL - PR, CH = VH - PT - PB;
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
      {data.map((d, i) => <text key={i} x={PL + i * step + step / 2} y={VH - PB + 14} textAnchor="middle" fill="#6b7280" fontSize={data.length > 16 ? 7 : 9}>{d.label}</text>)}
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
function AnnualRevSVG({ data }) {
  if (!data || !data.length) return null;
  const PL = 68, PR = 8, PT = 22, PB = 28, VW = 800, VH = 200, CW = VW - PL - PR, CH = VH - PT - PB;
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
function RevenueChart({ revenue }) {
  const monthChartRef = useRef(null);
  const annualChartRef = useRef(null);
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
    return revenue.slice(-24).map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      return {
        label: `${String(r.year).slice(2)}/${r.month}`,
        rev: r.revenue,
        prevYr,
        yoyPct,
      };
    });
  }, [revenue, revMap]);

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
    const base = years.slice(-11); // 取 11 筆以計算最早年的 YoY
    return base.map((y, i, arr) => {
      const prev = arr[i - 1];
      const yoy = prev && prev.total > 0
        ? +((y.total - prev.total) / prev.total * 100).toFixed(2)
        : null;
      return { ...y, yoy };
    }).slice(-10); // 最終只顯示 10 年
  }, [revenue]);

  const hasData = data.length > 0;
  const recent12 = useMemo(() => {
    if (!revenue || !revenue.length) return [];
    return [...revenue].slice(-12).reverse().map(r => {
      const prevYr = revMap[`${r.year - 1}-${r.month}`] || 0;
      const yoyPct = prevYr > 0 ? +((r.revenue - prevYr) / prevYr * 100).toFixed(2) : null;
      // label 沒有隨 r 的其他欄位一起帶著走（原始 revenue 記錄本身沒有
      // label 欄位，只有給圖表用的 data 陣列會另外算一次），漏了這行會讓
      // 明細表格的「年月」欄位整欄空白——曾經真的發生過。
      return { ...r, label: `${String(r.year).slice(2)}/${r.month}`, prevYrCalc: prevYr, yoyPctCalc: yoyPct };
    });
  }, [revenue, revMap]);

  return (
    <>
    <Card title="創見月營收（近 24 個月）" icon="💰"
      actions={hasData && (
        <CopyChartButton containerRef={monthChartRef} title="創見月營收（近 24 個月）"
          note="資料來源：FinMind，單位：新台幣元" />
      )}>
      {hasData ? (
        <>
          <div ref={monthChartRef}><MonthRevSVG data={data} /></div>

          {/* 近 12 個月明細表 */}
          {/* 手機寬度下表格會超出可視範圍，靠橫向捲動看到其餘欄位（含
              年增率）——沒有這行提示的話，使用者很容易以為表格只有
              目前看得到的那幾欄，完全不會想到要往右滑。 */}
          <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看年增率 →</p>
          <div className="mt-3 overflow-x-auto">
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
    <Card title="年度營收趨勢（近 10 年，創見）" icon="📊"
      actions={<CopyChartButton containerRef={annualChartRef} title="年度營收趨勢（近 10 年，創見）"
        note="資料來源：FinMind，各年度月營收合計，單位：新台幣元" />}>
      {/* 折線圖 */}
      <div ref={annualChartRef}><AnnualRevSVG data={annualData} /></div>

      {/* 明細表 */}
      <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
      <div className="mt-3 overflow-x-auto">
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

// ═══════════════════════════════════════════════════════════
// IR TAB — 財務名詞 Tooltip
// ═══════════════════════════════════════════════════════════
function TermTip({ label, tip }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);

  const showTip = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  const hideTip = () => setPos(null);

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span>{label}</span>}
      <span ref={btnRef}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onClick={() => pos ? hideTip() : showTip()}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-xs font-bold cursor-help select-none shrink-0"
        style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>?</span>
      {pos && ReactDOM.createPortal(
        <span style={{
          position: 'fixed', left: `${pos.x}px`, top: `${pos.y - 10}px`,
          transform: 'translate(-50%, -100%)', zIndex: 9999, width: '260px',
          background: '#ffffff', border: '1px solid #e5e7eb', color: '#334155',
          borderRadius: '12px', padding: '12px', fontSize: '12px', lineHeight: '1.6',
          boxShadow: '0 8px 32px rgba(15,23,42,0.14)', pointerEvents: 'none',
          whiteSpace: 'normal', textAlign: 'left', fontWeight: 'normal',
        }}>
          {tip}
          <span style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0, borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent', borderTop: '5px solid #ffffff',
          }} />
        </span>,
        document.body
      )}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 季度損益摘要
// ═══════════════════════════════════════════════════════════
function QuarterlyPnL({ financials }) {
  const quarters = useMemo(() => {
    if (!financials || !financials.length) return [];
    return [...financials].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [financials]);

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
    <Card title="季度損益摘要（近 8 季）" icon="📋">
      {quarters.length > 0 ? (
        <>
        <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
        <div className="overflow-x-auto">
          <table className="ir-table w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th className="text-left pb-2 pr-3 font-medium whitespace-nowrap">季度</th>
                {['grossMargin', 'opMargin', 'netMargin', 'eps'].map(k => (
                  <th key={k} className="text-right pb-2 pr-3 font-medium last:pr-0 whitespace-nowrap">
                    <span className="inline-flex items-center justify-end gap-1">
                      <span>{TERM_TIPS[k].label}</span>
                      <TermTip tip={TERM_TIPS[k].tip} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quarters.map((q, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-gray-300 tabular-nums">{(q.date || '').slice(0, 7)}</td>
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

// ═══════════════════════════════════════════════════════════
// IR TAB — 歷年股利配息
// ═══════════════════════════════════════════════════════════
function DividendHistory({ dividends }) {
  const records = useMemo(() => {
    if (!dividends || !dividends.length) return [];
    return [...dividends].sort((a, b) => String(b.year).localeCompare(String(a.year))).slice(0, 10);
  }, [dividends]);

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
    <Card title="歷年股利配息（近 10 年）" icon="💵">
      {records.length > 0 ? (
        <>
        <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
        <div className="overflow-x-auto">
          <table className="ir-table w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700/60 text-gray-500">
                <th className="text-left pb-2 pr-3 font-medium whitespace-nowrap">配息年度</th>
                <th className="text-right pb-2 pr-3 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>現金股利（元）</span>
                    <TermTip tip={divTipMap['現金股利']} />
                  </span>
                </th>
                <th className="text-right pb-2 pr-3 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>股票股利（元）</span>
                    <TermTip tip={divTipMap['股票股利']} />
                  </span>
                </th>
                <th className="text-right pb-2 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center justify-end gap-1">
                    <span>合計（元）</span>
                    <TermTip tip={divTipMap['殖利率']} />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-gray-300 font-medium tabular-nums">{r.year}</td>
                  <td className="text-right py-1.5 pr-3 text-green-400 tabular-nums font-medium">
                    {r.cashDividend > 0 ? `$${Number(r.cashDividend).toFixed(2)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 pr-3 text-blue-400 tabular-nums">
                    {r.stockDividend > 0 ? `$${Number(r.stockDividend).toFixed(2)}` : '—'}
                  </td>
                  <td className="text-right py-1.5 text-ink tabular-nums font-bold">
                    ${Number(r.totalDividend > 0 ? r.totalDividend : (r.cashDividend + r.stockDividend)).toFixed(2)}
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

// ═══════════════════════════════════════════════════════════
// IR TAB — 競品重大訊息
// ═══════════════════════════════════════════════════════════
// 公開資訊觀測站（MOPS）各公司頁面，顯示在「創見與競品 IR 新訊」下方
const MOPS_LINKS = [
  { code: '3260', name: '威剛' },
  { code: '4973', name: '廣穎' },
  { code: '5289', name: '宜鼎' },
  { code: '4967', name: '十銓' },
  { code: '8271', name: '宇瞻' },
];
const mopsUrl = code => `https://mops.twse.com.tw/mops/#/web/t146sb05?companyId=${code}`;

function CompetitorMaterial({ material }) {
  const COMP_META = {
    '2451': { name: '創見資訊', color: BRAND },
    '3260': { name: '威剛科技', color: '#ef4444' },
    '5289': { name: '宜鼎國際', color: '#eab308' },
    '4967': { name: '十銓科技', color: '#f97316' },
    '8271': { name: '宇瞻科技', color: '#22c55e' },
    '4973': { name: '廣穎電通', color: '#3b82f6' },
  };
  const BADGE_COLOR = {
    '董事會': 'bg-red-900/60 text-red-300 border-red-700/50',
    '股東會': 'bg-purple-900/60 text-purple-300 border-purple-700/50',
    '法人說明會': 'bg-blue-900/60 text-blue-300 border-blue-700/50',
    '股利': 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
    '盈餘分配': 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
    '現金增資': 'bg-orange-900/60 text-orange-300 border-orange-700/50',
    '減資': 'bg-pink-900/60 text-pink-300 border-pink-700/50',
    '下市': 'bg-gray-800/80 text-gray-400 border-gray-600/50',
    '合併': 'bg-cyan-900/60 text-cyan-300 border-cyan-700/50',
  };

  const records = useMemo(() => {
    if (!material || !material.length) return [];
    return [...material].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }, [material]);

  const [filterCode, setFilterCode] = useState('all');

  const filtered = useMemo(() =>
    filterCode === 'all' ? records : records.filter(r => r.code === filterCode),
    [records, filterCode]
  );

  return (
    <Card title="創見與競品 IR 新訊" icon="📢">
      {/* 股票篩選 tabs */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <TabBtn active={filterCode === 'all'} onClick={() => setFilterCode('all')}>全部</TabBtn>
        {['2451', ...COMPETITOR_ORDER].map(code => [code, COMP_META[code]]).map(([code, m]) => (
          <TabBtn key={code} active={filterCode === code} onClick={() => setFilterCode(code)}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: m.color }} />
            {code} {m.name}
          </TabBtn>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
          {filtered.map((r, i) => {
            const meta = COMP_META[r.code] || {};
            return (
              <div key={i} className={`rounded-xl px-3 py-2.5 text-sm border ${r.highlight ? 'border-gray-600/60 bg-gray-800/40' : 'border-gray-800/40 bg-gray-900/30'}`}>
                <div className="flex items-start gap-2">
                  <span className="font-bold shrink-0" style={{ color: meta.color || '#9ca3af' }}>
                    {meta.name || r.name || r.code}
                  </span>
                  <span className="text-gray-500 shrink-0 tabular-nums">{r.date}</span>
                  {r.link
                    ? <a href={r.link} target="_blank" rel="noopener noreferrer"
                        className="content-title flex-1 leading-relaxed hover:underline transition-colors">
                        {r.summary}
                      </a>
                    : <span className="text-gray-300 flex-1 leading-relaxed">{r.summary}</span>
                  }
                </div>
                {r.highlight && r.highlightKw && r.highlightKw.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5 pl-14">
                    {r.highlightKw.map(kw => (
                      <span key={kw} className={`px-1.5 py-0.5 rounded text-xs border font-medium ${BADGE_COLOR[kw] || 'bg-gray-700 text-gray-300 border-gray-600'}`}>
                        {kw}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="h-28 flex items-center justify-center text-gray-600 text-sm">
          {material === null ? '載入中…' : '尚無重大訊息資料（Actions 跑完後自動更新）'}
        </div>
      )}
      <p className="text-xs text-gray-700 mt-2">
        * 資料來源：FinMind TaiwanStockMaterial ·
        <span className="text-red-400/70"> 董事會</span>
        <span className="text-purple-400/70"> 股東會</span>
        <span className="text-blue-400/70"> 法人說明會</span> 特別標注
      </p>

      {/* 公開資訊觀測站連結 */}
      <div className="flex flex-wrap items-center gap-1.5 mt-3 pt-3 border-t border-gray-800/60">
        <span className="text-xs text-gray-500 mr-1">公開資訊觀測站</span>
        {MOPS_LINKS.map(l => (
          <a key={l.code} href={mopsUrl(l.code)} target="_blank" rel="noopener noreferrer"
            className="text-xs px-2.5 py-1 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition">
            {l.name} {l.code} ↗
          </a>
        ))}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// IR TAB — 每日交易資訊（開收盤、三大法人）
// ═══════════════════════════════════════════════════════════
function DailyTrading({ daily }) {
  const fmtK = v => {
    const n = Math.abs(Number(v || 0));
    if (n >= 10000) return `${(n / 10000).toFixed(0)}萬`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}千`;
    return n.toLocaleString();
  };
  const netStr = (v, unit = '') => {
    if (v == null) return '—';
    return (v > 0 ? '+' : '') + fmtK(v) + unit;
  };
  // 台股慣例：上漲/買超用紅色、下跌/賣超用綠色（跟美股相反）
  const nc = v => v == null ? 'text-gray-400' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-400';

  if (!daily || (!daily.close && !daily.open)) return (
    <Card title="創見 2451 每日交易資訊" icon="📊">
      <div className="h-20 flex items-center justify-center text-gray-600 text-sm">
        {daily === null ? '載入中…' : '尚無資料（Actions 跑完後自動更新）'}
      </div>
    </Card>
  );

  const change = (daily.close != null && daily.open != null)
    ? +(daily.close - daily.open).toFixed(2) : null;

  return (
    <Card title="創見 2451 每日交易資訊" icon="📊">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 股價 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.priceDate || ''} 股價</p>
          {change != null && (
            <p className={`text-2xl font-bold mb-2 ${nc(change)}`}>
              {change > 0 ? '+' : ''}{change}
            </p>
          )}
          <div className="space-y-1.5">
            {[['開盤', daily.open], ['收盤', daily.close], ['最高', daily.high], ['最低', daily.low]].map(([k, v]) => (
              <div key={k} className="flex justify-between text-sm">
                <span className="text-gray-500">{k}</span>
                <span className="text-ink tabular-nums">{v != null ? v : '—'}</span>
              </div>
            ))}
            <div className="flex justify-between text-sm border-t border-gray-700/40 pt-1 mt-1">
              <span className="text-gray-500">交易量</span>
              <span className="text-ink tabular-nums">{daily.volume ? fmtK(daily.volume) + ' 股' : '—'}</span>
            </div>
          </div>
        </div>

        {/* 外資 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 外資</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.foreignNet)}`}>
            {netStr(daily.foreignNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-red-400/80 tabular-nums">{daily.foreignBuy != null ? fmtK(daily.foreignBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-green-400/80 tabular-nums">{daily.foreignSell != null ? fmtK(daily.foreignSell) : '—'}</span>
            </div>
          </div>
          {daily.foreignBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>

        {/* 投信 */}
        <div className="bg-gray-800/40 rounded-xl p-3 border border-gray-700/40">
          <p className="text-xs text-gray-500 mb-1">{daily.institutionalDate || daily.priceDate || ''} 投信</p>
          <p className={`text-2xl font-bold mb-2 ${nc(daily.trustNet)}`}>
            {netStr(daily.trustNet)}
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">買進</span>
              <span className="text-red-400/80 tabular-nums">{daily.trustBuy != null ? fmtK(daily.trustBuy) : '—'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">賣出</span>
              <span className="text-green-400/80 tabular-nums">{daily.trustSell != null ? fmtK(daily.trustSell) : '—'}</span>
            </div>
          </div>
          {daily.trustBuy == null && <p className="text-xs text-gray-600 mt-2">暫無法人資料</p>}
        </div>
      </div>
      <p className="text-xs text-gray-700 mt-2">* 股價：TWSE 即時報價 · 法人：FinMind · 數量單位：股</p>
    </Card>
  );
}

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

function CompetitorRevenueChart({ revenue, compRev }) {
  const chartRef = useRef(null);
  // series 用完整歷史建立（不只近 24 個月），表格的月增率才找得到
  // 最早那個月的「上個月」。
  const { allSeries, byKey } = useMemo(() => {
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
      allSeries: Object.values(series).sort((a, b) => a.key < b.key ? -1 : 1).slice(-24),
      byKey: series,
    };
  }, [revenue, compRev]);

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
  const momCls = v => v == null ? 'text-gray-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-gray-400';

  return (
    <Card title="創見 vs 競品月營收比較（近 24 個月）" icon="📊"
      actions={<CopyChartButton containerRef={chartRef} title="創見 vs 競品月營收比較（近 24 個月）"
        legend={hasCodes.map(c => ({ name: `${COMP_REV_META[c].name}（${c}）`, color: COMP_REV_META[c].color }))}
        note="資料來源：FinMind，單位：新台幣元" />}>
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
        {allSeries.map((d, i) => (
          <text key={d.key} x={PL + i * step} y={H - PB + 12} textAnchor="middle" fill="#6b7280" fontSize="8">
            {d.label}
          </text>
        ))}
      </svg>
      </div>
      <p className="text-xs text-gray-700 mt-1">* 資料來源：FinMind，單位：新台幣元</p>

      {/* 各公司月營收＋月增率明細（新到舊） */}
      <p className="text-xs text-gray-600 sm:hidden mt-3 mb-1">← 左右滑動可看其他公司 →</p>
      <div className="mt-3 overflow-x-auto">
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
function AnnualRevenueChart({ revenue, compRev }) {
  const chartRef = useRef(null);
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
      .slice(-10);
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

  return (
    <Card title="年度營收趨勢（近 10 年）" icon="📈"
      actions={<CopyChartButton containerRef={chartRef} title="年度營收趨勢（近 10 年）"
        legend={hasCodes.map(c => ({ name: `${COMP_REV_META[c].name}（${c}）`, color: COMP_REV_META[c].color }))}
        note="資料來源：FinMind，各年度月營收合計，單位：新台幣元" />}>
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
    </Card>
  );
}

// news/community 為既有既存但目前無畫面引用的 props（原始檔案的 IRTab
// 也是接了這兩個參數卻未在畫面中使用），隨模組搬移原樣保留。
// eslint-disable-next-line no-unused-vars
export function IRTab({ news, stocks, community, revenue, financials, dividends, material, daily, compRev }) {
  return (
    <div className="space-y-4 fade-in">
      {/* Stock cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {['2451', ...COMPETITOR_ORDER].map(code => (
          stocks[code]
            ? <StockCard key={code} code={code} data={stocks[code]} />
            : <div key={code} className="p-4 rounded-2xl border border-gray-700/60 bg-gray-900 flex flex-col items-center justify-center gap-2 min-h-[100px]">
                <span className="text-xs text-gray-500 font-bold">{code}</span>
                <span className="text-xs text-gray-600">{STOCK_META[code].name}</span>
                <span className="text-xs text-gray-700">等待 Actions 更新</span>
              </div>
        ))}
      </div>
      {Object.keys(stocks).length === 0 && (
        <div className="text-xs text-yellow-600/70 bg-yellow-900/10 border border-yellow-800/30 rounded-xl px-4 py-3">
          ⚠ 尚未取得股價 — 請先在 GitHub Actions 手動執行一次 fetch-news workflow，確認 Firebase stocks/latest 文件已建立。
        </div>
      )}
      <DailyTrading daily={daily} />
      <CompetitorMaterial material={material} />
      <RevenueChart revenue={revenue} />
      <CompetitorRevenueChart revenue={revenue} compRev={compRev} />
      <AnnualRevenueChart revenue={revenue} compRev={compRev} />
      <QuarterlyPnL financials={financials} />
      <DividendHistory dividends={dividends} />
    </div>
  );
}
