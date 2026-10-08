import { useMemo, useRef, useState } from 'react';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import CopyChartButton from '../../components/CopyChartButton.jsx';
import { exportExposureInsightsExcel } from '../../utils/formatting.js';
import { buildExposureInsights } from './exposureInsights.js';

// 人工確認曝光分析：PR 頁面「人工確認曝光」卡片按「📊 曝光分析」進來的下一頁。
// 資訊分成幾個分頁，避免一次塞滿：總覽／媒體／記者／關係變化／題材／自動監測比對。

const SECTIONS = [
  { id: 'overview', label: '總覽' },
  { id: 'media', label: '媒體' },
  { id: 'reporter', label: '記者' },
  { id: 'relation', label: '關係變化' },
  { id: 'topic', label: '題材與高峰' },
  { id: 'coverage', label: '自動監測比對' },
];

const TYPE_LABEL = { online: '網路新聞', video: '影片', social: '社群' };
const BRAND = '150,0,20';

const fmtMonth = m => `${m.slice(0, 4)}/${Number(m.slice(5))}`;
const fmtDate = d => d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;

function Kpi({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900 p-3 text-center">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-ink mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}

// 數字越大底色越深（熱度圖），0 顯示「·」
function Heat({ value, max }) {
  if (!value) return <td className="text-center py-1.5 text-gray-600">·</td>;
  const alpha = 0.08 + 0.5 * (value / Math.max(max, 1));
  return (
    <td className="text-center py-1.5 tabular-nums font-medium text-ink" style={{ background: `rgba(${BRAND},${alpha.toFixed(2)})` }}>
      {value}
    </td>
  );
}

function Bar({ value, max, color = `rgb(${BRAND})` }) {
  return (
    <div className="h-2 rounded-full bg-gray-800 overflow-hidden min-w-[60px]">
      <div className="h-full rounded-full" style={{ width: `${Math.round(value / Math.max(max, 1) * 100)}%`, background: color }} />
    </div>
  );
}

function Chips({ title, names, tone = 'gray', empty = '—' }) {
  const toneCls = {
    green: 'bg-green-900/30 text-green-500',
    red: 'bg-red-900/30 text-red-400',
    blue: 'bg-blue-900/30 text-blue-400',
    gray: 'bg-gray-800 text-gray-400',
  }[tone];
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{title}（{names.length}）</p>
      <div className="flex flex-wrap gap-1.5">
        {names.length
          ? names.map(n => <span key={n} className={`text-xs px-2 py-0.5 rounded-full ${toneCls}`}>{n}</span>)
          : <span className="text-xs text-gray-600">{empty}</span>}
      </div>
    </div>
  );
}

// ── 每月篇數長條圖（SVG，可用「複製圖表」貼進簡報）────────────
function MonthlyChart({ monthly }) {
  const W = 700, H = 200, PL = 36, PR = 12, PT = 24, PB = 30;
  const VW = W - PL - PR, VH = H - PT - PB;
  const max = Math.max(...monthly.map(m => m.count), 1);
  const step = VW / monthly.length;
  const bw = Math.min(step * 0.55, 56);
  const ticks = [0, 0.5, 1].map(r => ({ r, v: Math.round(max * r) }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
      {ticks.map(t => {
        const y = PT + VH - t.r * VH;
        return (
          <g key={t.r}>
            <line x1={PL} x2={W - PR} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PL - 5} y={y + 3} textAnchor="end" fill="#6b7280" fontSize="9">{t.v}</text>
          </g>
        );
      })}
      {monthly.map((m, i) => {
        const h = (m.count / max) * VH;
        const x = PL + i * step + (step - bw) / 2;
        return (
          <g key={m.month}>
            <rect x={x} y={PT + VH - h} width={bw} height={h} rx="2" fill={`rgb(${BRAND})`} opacity="0.88" />
            <text x={x + bw / 2} y={PT + VH - h - 5} textAnchor="middle" fill="#334155" fontSize="11" fontWeight="600">{m.count}</text>
            <text x={x + bw / 2} y={H - PB + 14} textAnchor="middle" fill="#6b7280" fontSize="10">{fmtMonth(m.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
function Overview({ ins }) {
  const chartRef = useRef(null);
  const latest = ins.monthly[ins.monthly.length - 1];
  const prev = ins.monthly.length > 1 ? ins.monthly[ins.monthly.length - 2] : null;
  const growth = prev && prev.count ? (latest.count - prev.count) / prev.count : null;
  const maxCat = Math.max(...ins.categories.map(c => c.total), 1);

  return (
    <div className="space-y-4">
      <Card title="重點發現" icon="💡">
        <ul className="space-y-2 text-sm text-gray-300 leading-relaxed">
          {ins.highlights.map((h, i) => <li key={i} className="flex gap-2"><span className="text-gray-600">•</span><span>{h}</span></li>)}
        </ul>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="曝光總篇數" value={ins.total} hint={`${fmtDate(ins.firstDate)} – ${fmtDate(ins.lastDate)}`} />
        <Kpi label="涵蓋媒體" value={ins.media.length} hint={`等效 ${ins.concentration.effectiveMedia} 家`} />
        <Kpi label="具名記者" value={ins.reporters.length} hint={`未署名 ${ins.unsigned.count} 篇（${pct(ins.unsigned.share)}）`} />
        <Kpi label="每月平均" value={(ins.total / ins.months.length).toFixed(1)} hint={`共 ${ins.months.length} 個月`} />
        <Kpi label={`${fmtMonth(ins.latestMonth)} 較上月`}
          value={growth == null ? '—' : `${growth > 0 ? '+' : ''}${Math.round(growth * 100)}%`}
          hint={prev ? `${prev.count} → ${latest.count} 篇` : '只有一個月資料'} />
      </div>

      <Card title="每月曝光篇數" icon="📊"
        actions={<CopyChartButton containerRef={chartRef} title="人工確認曝光：每月篇數" note="資料來源：人工確認曝光" />}>
        <div ref={chartRef}><MonthlyChart monthly={ins.monthly} /></div>
        <div className="overflow-x-auto mt-3">
          <table className="ir-table w-full text-sm">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left pb-1.5 pr-3 font-medium">月份</th>
                <th className="text-right pb-1.5 pr-3 font-medium">篇數</th>
                <th className="text-right pb-1.5 pr-3 font-medium">較上月</th>
                <th className="text-right pb-1.5 pr-3 font-medium">媒體數</th>
                <th className="text-right pb-1.5 pr-3 font-medium">具名記者</th>
                <th className="text-right pb-1.5 font-medium">未署名</th>
              </tr>
            </thead>
            <tbody>
              {[...ins.monthly].reverse().map((m, idx, arr) => {
                const before = arr[idx + 1];
                const g = before && before.count ? (m.count - before.count) / before.count : null;
                return (
                  <tr key={m.month}>
                    <td className="py-1.5 pr-3 text-gray-300 tabular-nums">{m.month}</td>
                    <td className="text-right py-1.5 pr-3 text-ink font-medium tabular-nums">{m.count}</td>
                    <td className={`text-right py-1.5 pr-3 tabular-nums ${g == null ? 'text-gray-600' : g > 0 ? 'text-red-400' : g < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                      {g == null ? '—' : `${g > 0 ? '+' : ''}${Math.round(g * 100)}%`}
                    </td>
                    <td className="text-right py-1.5 pr-3 tabular-nums">{m.mediaCount}</td>
                    <td className="text-right py-1.5 pr-3 tabular-nums">{m.reporterCount}</td>
                    <td className="text-right py-1.5 tabular-nums text-gray-500">{m.unsignedCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="媒體類型分布" icon="🗂️">
          <div className="space-y-2">
            {ins.categories.map(c => (
              <div key={c.name} className="flex items-center gap-2 text-sm">
                <span className="w-20 shrink-0 text-gray-300">{c.name}</span>
                <div className="flex-1"><Bar value={c.total} max={maxCat} /></div>
                <span className="w-24 text-right text-xs text-gray-500 tabular-nums">{c.total} 篇・{pct(c.share)}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-3">分類是預設對照，可在 src/config/exposureTopics.js 調整。</p>
        </Card>
        <Card title="曝光集中度與類型" icon="🎯">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Kpi label="第 1 大媒體" value={pct(ins.concentration.top1)} />
            <Kpi label="前 3 大" value={pct(ins.concentration.top3)} />
            <Kpi label="前 5 大" value={pct(ins.concentration.top5)} />
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            等效媒體數 {ins.concentration.effectiveMedia}（實際 {ins.media.length} 家）：數字越接近實際家數，
            代表曝光越分散、不依賴少數幾家。
          </p>
          <p className="text-xs text-gray-500 mt-3">
            類型：{Object.entries(ins.types).map(([k, v]) => `${TYPE_LABEL[k] || k} ${v} 篇`).join('、')}
          </p>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
function MediaSection({ ins }) {
  const max = Math.max(...ins.media.flatMap(m => Object.values(m.byMonth)), 1);
  const maxTotal = ins.media[0]?.total || 1;
  return (
    <Card title="各媒體每月報導篇數" icon="📰">
      <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
      <div className="overflow-x-auto">
        <table className="ir-table w-full text-sm">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">媒體</th>
              <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">類型</th>
              {ins.months.map(m => <th key={m} className="text-center pb-1.5 px-2 font-medium whitespace-nowrap">{fmtMonth(m)}</th>)}
              <th className="text-right pb-1.5 px-3 font-medium whitespace-nowrap">合計</th>
              <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap min-w-[90px]">佔比</th>
              <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">記者數</th>
              <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">主力記者</th>
              <th className="text-right pb-1.5 font-medium whitespace-nowrap">最近報導</th>
            </tr>
          </thead>
          <tbody>
            {ins.media.map(m => (
              <tr key={m.name} className="hover:bg-gray-800/20">
                <td className="py-1.5 pr-3 text-ink font-medium whitespace-nowrap">{m.name}</td>
                <td className="py-1.5 pr-3 text-xs text-gray-500 whitespace-nowrap">{m.category}</td>
                {ins.months.map(mo => <Heat key={mo} value={m.byMonth[mo] || 0} max={max} />)}
                <td className="text-right py-1.5 px-3 font-bold text-ink tabular-nums">{m.total}</td>
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1"><Bar value={m.total} max={maxTotal} /></div>
                    <span className="text-xs text-gray-500 tabular-nums w-9 text-right">{pct(m.share)}</span>
                  </div>
                </td>
                <td className="text-right py-1.5 pr-3 tabular-nums text-gray-400">{m.reporterCount || '—'}</td>
                <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap text-xs">
                  {m.topReporter ? `${m.topReporter}（${pct(m.topReporterShare)}）` : '未署名'}
                </td>
                <td className="text-right py-1.5 text-gray-500 tabular-nums whitespace-nowrap text-xs">{fmtDate(m.lastDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-600 mt-2">
        「主力記者」＝該媒體報導最多的記者，括號是佔該媒體全部篇數的比例。
      </p>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
const STATUS = {
  stable: { label: '穩定', cls: 'bg-green-900/30 text-green-500' },
  new: { label: '本月新增', cls: 'bg-blue-900/30 text-blue-400' },
  lapsed: { label: '本月缺席', cls: 'bg-yellow-900/30 text-yellow-500' },
  active: { label: '', cls: '' },
};
const REPORTER_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'stable', label: '穩定（每月都有）' },
  { id: 'new', label: '本月新增' },
  { id: 'lapsed', label: '本月缺席' },
  { id: 'cross', label: '跨媒體' },
];

function ReporterSection({ ins }) {
  const [filter, setFilter] = useState('all');
  const list = useMemo(() => ins.reporters.filter(r => (
    filter === 'all' ? true : filter === 'cross' ? r.mediaCount >= 2 : r.status === filter)), [ins, filter]);
  const max = Math.max(...ins.reporters.flatMap(r => Object.values(r.byMonth)), 1);
  return (
    <div className="space-y-4">
      <Card title="各記者每月報導篇數" icon="✍️">
        <div className="flex flex-wrap gap-1.5 mb-3">
          {REPORTER_FILTERS.map(f => (
            <TabBtn key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</TabBtn>
          ))}
        </div>
        <p className="text-xs text-gray-600 sm:hidden mb-1">← 左右滑動可看更多欄位 →</p>
        <div className="overflow-x-auto">
          <table className="ir-table w-full text-sm">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">記者</th>
                <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">媒體</th>
                {ins.months.map(m => <th key={m} className="text-center pb-1.5 px-2 font-medium whitespace-nowrap">{fmtMonth(m)}</th>)}
                <th className="text-right pb-1.5 px-3 font-medium whitespace-nowrap">合計</th>
                <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">最近報導</th>
                <th className="text-left pb-1.5 font-medium whitespace-nowrap">狀態</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.name} className="hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-ink font-medium whitespace-nowrap">{r.name}</td>
                  <td className="py-1.5 pr-3 text-xs text-gray-400">
                    {r.media.map(m => (r.media.length > 1 ? `${m.name}（${m.count}）` : m.name)).join('、')}
                  </td>
                  {ins.months.map(mo => <Heat key={mo} value={r.byMonth[mo] || 0} max={max} />)}
                  <td className="text-right py-1.5 px-3 font-bold text-ink tabular-nums">{r.total}</td>
                  <td className="text-right py-1.5 pr-3 text-gray-500 tabular-nums whitespace-nowrap text-xs">{fmtDate(r.lastDate)}</td>
                  <td className="py-1.5">
                    {STATUS[r.status].label && (
                      <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length === 0 && <p className="text-sm text-gray-600 text-center py-6">沒有符合的記者</p>}
        <p className="text-xs text-gray-600 mt-2">共同署名的報導，每位記者各算一篇，所以記者合計可能略多於曝光總篇數。</p>
      </Card>

      <Card title="未署名報導" icon="🕶️">
        <p className="text-sm text-gray-300">
          共 {ins.unsigned.count} 篇（{pct(ins.unsigned.share)}）沒有記者署名，通常是網站轉載、編譯稿或新聞稿原文。
        </p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {ins.unsigned.byMedia.slice(0, 10).map(m => (
            <span key={m.name} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{m.name} {m.total}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
function RelationSection({ ins }) {
  const c = ins.changes;
  return (
    <div className="space-y-4">
      {c ? (
        <Card title={`${fmtMonth(c.latestMonth)} 相較 ${fmtMonth(c.prevMonth)} 的變化`} icon="🔄">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-300">媒體</p>
              <Chips title="首次出現" names={c.newMedia} tone="green" />
              <Chips title="暌違後回來" names={c.returningMedia} tone="blue" />
              <Chips title="本月沒有報導" names={c.lostMedia} tone="red" />
            </div>
            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-300">記者</p>
              <Chips title="首次出現" names={c.newReporters} tone="green" />
              <Chips title="暌違後回來" names={c.returningReporters} tone="blue" />
              <Chips title="本月沒有報導" names={c.lostReporters} tone="red" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
            {[['媒體篇數變化最大', c.mediaMovers], ['記者篇數變化最大', c.reporterMovers]].map(([title, movers]) => (
              <div key={title}>
                <p className="text-xs text-gray-500 mb-1">{title}</p>
                {movers.length ? (
                  <table className="ir-table w-full text-sm">
                    <tbody>
                      {movers.map(m => (
                        <tr key={m.name}>
                          <td className="py-1.5 pr-2 text-ink">{m.name}</td>
                          <td className="text-right py-1.5 pr-2 text-gray-500 tabular-nums">{m.prev} → {m.latest}</td>
                          <td className={`text-right py-1.5 font-bold tabular-nums ${m.delta > 0 ? 'text-red-400' : 'text-green-400'}`}>
                            {m.delta > 0 ? '+' : ''}{m.delta}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-gray-600">沒有變化</p>}
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card title="月份變化" icon="🔄"><p className="text-sm text-gray-600">需要至少兩個月的資料才能比較。</p></Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="穩定的關係" icon="🤝">
          <div className="space-y-3">
            <Chips title="每月都有報導的媒體" names={ins.stableMedia.map(m => m.name)} tone="green" empty="目前沒有（或資料不足兩個月）" />
            <Chips title="每月都有報導的記者" names={ins.stableReporters.map(r => `${r.name}（${r.total}）`)} tone="green" empty="目前沒有（或資料不足兩個月）" />
          </div>
        </Card>
        <Card title="需要留意" icon="⚠️">
          <div className="space-y-3">
            <Chips title="曾常報導（≥3 篇）但本月缺席的記者" tone="red"
              names={ins.coreLapsed.map(r => `${r.name}（${r.media[0].name}，最近 ${fmtDate(r.lastDate)}）`)} empty="沒有" />
            <Chips title="曝光高度集中於單一記者的媒體（≥60%）" tone="red"
              names={ins.dependence.map(m => `${m.name}：${m.topReporter} ${pct(m.topReporterShare)}`)} empty="沒有" />
          </div>
        </Card>
      </div>

      <Card title="跨媒體的記者" icon="🔀">
        {ins.crossMediaReporters.length ? (
          <div className="flex flex-wrap gap-2">
            {ins.crossMediaReporters.map(r => (
              <span key={r.name} className="text-xs px-2.5 py-1 rounded-lg bg-gray-800 text-gray-300">
                {r.name}：{r.media.map(m => `${m.name} ${m.count}`).join('、')}
              </span>
            ))}
          </div>
        ) : <p className="text-sm text-gray-600">目前沒有同一位記者出現在多家媒體。</p>}
        <p className="text-xs text-gray-600 mt-2">記者換跑道或同時供稿多家媒體時，可以沿著這個人延續關係。</p>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
function TopicSection({ ins }) {
  const max = Math.max(...ins.topics.flatMap(t => Object.values(t.byMonth)), 1);
  return (
    <div className="space-y-4">
      <Card title="題材 × 月份" icon="🏷️">
        <p className="text-xs text-gray-500 mb-3">
          用標題關鍵字歸類（一則報導可以同時屬於多個題材），關鍵字在 src/config/exposureTopics.js 可調整。
        </p>
        <div className="overflow-x-auto">
          <table className="ir-table w-full text-sm">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">題材</th>
                {ins.months.map(m => <th key={m} className="text-center pb-1.5 px-2 font-medium whitespace-nowrap">{fmtMonth(m)}</th>)}
                <th className="text-right pb-1.5 px-3 font-medium whitespace-nowrap">合計</th>
                <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">佔比</th>
                <th className="text-left pb-1.5 font-medium whitespace-nowrap">主要媒體</th>
              </tr>
            </thead>
            <tbody>
              {ins.topics.map(t => (
                <tr key={t.id} className="hover:bg-gray-800/20">
                  <td className="py-1.5 pr-3 text-ink font-medium whitespace-nowrap">{t.label}</td>
                  {ins.months.map(mo => <Heat key={mo} value={t.byMonth[mo] || 0} max={max} />)}
                  <td className="text-right py-1.5 px-3 font-bold text-ink tabular-nums">{t.total}</td>
                  <td className="text-right py-1.5 pr-3 text-gray-500 tabular-nums">{pct(t.share)}</td>
                  <td className="py-1.5 text-xs text-gray-400">{t.topMedia.map(m => `${m.name}（${m.count}）`).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="曝光高峰日" icon="📈">
        {ins.bursts.length ? (
          <div className="overflow-x-auto">
            <table className="ir-table w-full text-sm">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">日期</th>
                  <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">篇數</th>
                  <th className="text-right pb-1.5 pr-3 font-medium whitespace-nowrap">媒體數</th>
                  <th className="text-left pb-1.5 pr-3 font-medium whitespace-nowrap">主要題材</th>
                  <th className="text-left pb-1.5 font-medium">範例標題</th>
                </tr>
              </thead>
              <tbody>
                {ins.bursts.map(b => (
                  <tr key={b.day}>
                    <td className="py-1.5 pr-3 text-gray-300 tabular-nums whitespace-nowrap">{b.day}</td>
                    <td className="text-right py-1.5 pr-3 font-bold text-ink tabular-nums">{b.count}</td>
                    <td className="text-right py-1.5 pr-3 tabular-nums">{b.mediaCount}</td>
                    <td className="py-1.5 pr-3 text-xs text-gray-400 whitespace-nowrap">{b.topics.join('、')}</td>
                    <td className="py-1.5 text-xs text-gray-500">{b.titles[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-gray-600">沒有單日 2 篇以上的曝光。</p>}
        <p className="text-xs text-gray-600 mt-2">高峰日通常對應營收公告、法說或新品發表，可以對照當天發了什麼稿。</p>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
function CoverageSection({ ins }) {
  const cov = ins.coverage;
  if (!cov || !cov.manual) {
    return (
      <Card title="自動監測比對" icon="🛰️">
        <p className="text-sm text-gray-600">目前沒有可比對的資料（自動監測只保留本月與上個月，且需要這段期間內有人工確認的曝光）。</p>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="人工確認（比對範圍內）" value={cov.manual} hint={`${fmtDate(cov.windowStart)} 起`} />
        <Kpi label="自動監測也抓到" value={cov.matched} />
        <Kpi label="自動監測漏掉" value={cov.missed.length} />
        <Kpi label="自動監測涵蓋率" value={pct(cov.rate)} hint={`自動監測共 ${cov.autoCount} 篇`} />
      </div>
      <Card title="自動監測沒抓到的曝光" icon="🔍">
        <p className="text-xs text-gray-500 mb-3">
          以「網址相同」或「標題相同」判斷。Google News 轉址的網址對不上時會被誤判為漏掉，數字僅供估計。
        </p>
        <div className="divide-y divide-gray-800/70 max-h-[420px] overflow-y-auto">
          {cov.missed.map((m, i) => (
            <div key={i} className="py-2 flex gap-3 items-start">
              <span className="text-xs text-gray-500 tabular-nums shrink-0 w-20">{fmtDate(m.date)}</span>
              <div className="min-w-0 flex-1">
                <a href={m.link} target="_blank" rel="noopener noreferrer" className="text-sm text-ink hover:text-red-500 leading-snug">{m.title}</a>
                <p className="text-xs text-gray-500 mt-0.5">{m.media}{m.reporter ? `｜${m.reporter}` : ''}</p>
              </div>
            </div>
          ))}
          {cov.missed.length === 0 && <p className="text-sm text-green-500 py-4 text-center">人工確認的曝光，自動監測都抓到了 🎉</p>}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
export default function ExposureInsightsPage({ records = [], autoArticles = [], onBack = () => {} }) {
  const [section, setSection] = useState('overview');
  const [now] = useState(() => new Date());
  const ins = useMemo(() => buildExposureInsights(records, { autoArticles, now }), [records, autoArticles, now]);

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBack}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-700/60 text-gray-300 hover:bg-gray-800 transition">
          ← 返回 PR 媒體戰情
        </button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-200">人工確認曝光分析</h2>
          {!ins.empty && (
            <p className="text-xs text-gray-500">
              {fmtDate(ins.firstDate)} – {fmtDate(ins.lastDate)}・共 {ins.total} 篇・{ins.media.length} 家媒體・{ins.reporters.length} 位記者
            </p>
          )}
        </div>
        <button onClick={() => exportExposureInsightsExcel(ins)} disabled={ins.empty}
          className="ml-auto text-sm px-3.5 py-1.5 rounded-lg border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition disabled:opacity-40 disabled:cursor-not-allowed">
          ⬇ 匯出分析 Excel
        </button>
      </div>

      {ins.empty ? (
        <Card title="尚無資料" icon="📭">
          <p className="text-sm text-gray-600">還沒有人工確認曝光，先在上一頁用「⬆ 上傳 Excel」匯入。</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {SECTIONS.map(s => (
              <TabBtn key={s.id} active={section === s.id} onClick={() => setSection(s.id)}>{s.label}</TabBtn>
            ))}
          </div>
          {section === 'overview' && <Overview ins={ins} />}
          {section === 'media' && <MediaSection ins={ins} />}
          {section === 'reporter' && <ReporterSection ins={ins} />}
          {section === 'relation' && <RelationSection ins={ins} />}
          {section === 'topic' && <TopicSection ins={ins} />}
          {section === 'coverage' && <CoverageSection ins={ins} />}
        </>
      )}
    </div>
  );
}
