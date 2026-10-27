import { useMemo } from 'react';
import { usePanelState } from '../../hooks/usePanelState.jsx';

import Card from '../../components/Card.jsx';
import TabBtn from '../../components/TabBtn.jsx';
import Icon from '../../components/Icon.jsx';
import { BRAND } from '../../utils/news.js';
import { COMPETITOR_ORDER, COMPETITORS } from '../../config/competitors.js';
import BrandTag from '../../components/ui/BrandTag.jsx';
import { safeHttpUrl } from '../../utils/safeUrl.js';
import { sortMaterial, materialYears, filterMaterial } from './irData.js';

// ═══════════════════════════════════════════════════════════
// IR TAB — 競品重大訊息
// ═══════════════════════════════════════════════════════════
// 公開資訊觀測站（MOPS）各公司頁面，顯示在「創見與競品 IR 新訊」下方
const MOPS_LINKS = [
  { code: '2451', name: '創見' },
  { code: '3260', name: '威剛' },
  { code: '4973', name: '廣穎' },
  { code: '5289', name: '宜鼎' },
  { code: '4967', name: '十銓' },
  { code: '8271', name: '宇瞻' },
];
const mopsUrl = code => `https://mops.twse.com.tw/mops/#/web/t146sb05?companyId=${code}`;

export function CompetitorMaterial({ material }) {
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

  // 標籤名稱與「競品動態監測」一致（沿用 COMPETITORS 的 "ADATA 威剛"）；創見與未知公司退回原名稱
  const tagName = r => COMPETITORS.find(c => c.stock === r.code)?.name || COMP_META[r.code]?.name || r.name || r.code;

  // 日期用數字比較排序（新→舊），不用字串排序
  const records = useMemo(() => sortMaterial(material), [material]);
  const years = useMemo(() => materialYears(material), [material]);

  // 篩選與展開狀態放在 IR 的 panel state，切換子頁後仍保留
  const [filterCode, setFilterCode] = usePanelState('disclosures.code', 'all');
  const [filterYear, setFilterYear] = usePanelState('disclosures.year', 'all');
  const [expanded, setExpanded] = usePanelState('disclosures.expanded', {});
  const toggle = key => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const filtered = useMemo(
    () => filterMaterial(records, { code: filterCode, year: filterYear }),
    [records, filterCode, filterYear]
  );

  return (
    <Card title="創見與競品 IR 新訊" icon="bell">
      {/* 股票篩選 tabs */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <TabBtn active={filterCode === 'all'} onClick={() => setFilterCode('all')}>全部</TabBtn>
        {['2451', ...COMPETITOR_ORDER].map(code => [code, COMP_META[code]]).map(([code, m]) => (
          <TabBtn key={code} active={filterCode === code} onClick={() => setFilterCode(code)}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: m.color }} />
            {code} {m.name}
          </TabBtn>
        ))}
        {years.length > 0 && (
          <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-500">
            年份
            <select value={filterYear} onChange={e => setFilterYear(e.target.value)} aria-label="依年份篩選重大訊息"
              className="rounded-lg border border-gray-700/60 px-2 py-1 text-xs outline-none focus:border-red-700">
              <option value="all">全部年份</option>
              {years.map(y => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </label>
        )}
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
          {filtered.map((r, i) => {
            const meta = COMP_META[r.code] || {};
            const link = safeHttpUrl(r.link);   // 只有通過安全驗證的 http(s) 網址才會變成連結
            const key = `${r.code}|${r.date}|${i}`;
            const open = !!expanded[key];
            return (
              <div key={key} className={`rounded-xl px-3 py-2.5 text-sm border ${r.highlight ? 'border-gray-600/60 bg-gray-800/40' : 'border-gray-800/40 bg-gray-900/30'}`}>
                <div className="flex items-start gap-2">
                  <BrandTag name={tagName(r)} color={meta.color} />
                  <span className="text-gray-500 shrink-0 tabular-nums">{r.date}</span>
                  {link && !open
                    ? <a href={link} target="_blank" rel="noopener noreferrer"
                        className="content-title flex-1 min-w-0 leading-relaxed hover:underline transition-colors truncate">
                        {r.summary}
                      </a>
                    : <span className={`text-gray-300 flex-1 min-w-0 leading-relaxed ${open ? 'break-words' : 'truncate'}`}>{r.summary}</span>
                  }
                  <button type="button" onClick={() => toggle(key)} aria-expanded={open}
                    aria-label={`${open ? '收合' : '展開'}重大訊息：${meta.name || r.code} ${r.date}`}
                    className="text-xs px-2 py-0.5 rounded-lg border border-gray-700/60 text-gray-500 hover:text-gray-200 hover:bg-gray-800 shrink-0">
                    {open ? '收合' : '展開'}
                  </button>
                </div>
                {open && (
                  <div className="mt-2 pl-1 text-gray-300 leading-relaxed">
                    {link
                      ? <a href={link} target="_blank" rel="noopener noreferrer" className="content-title hover:underline">
                          開啟來源 <Icon name="external" />
                        </a>
                      : <span className="text-xs text-gray-500">此則訊息沒有可用的來源連結</span>}
                  </div>
                )}
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-gray-800/60">
        <span className="text-sm text-gray-500">公開資訊觀測站</span>
        {MOPS_LINKS.map(l => (
          <a key={l.code} href={mopsUrl(l.code)} target="_blank" rel="noopener noreferrer"
            aria-label={`${l.name} ${l.code} 公開資訊觀測站（另開新分頁）`}
            className="text-sm font-medium text-blue-600 hover:underline whitespace-nowrap inline-flex items-center gap-1 py-1">
            {l.name} {l.code} <Icon name="external" />
          </a>
        ))}
      </div>
    </Card>
  );
}
