import { useIsWide } from './useMediaQuery.js';

/**
 * 響應式資料表：平板／桌機（≥ 768px）渲染表格，手機改渲染卡片清單——
 * 同一時間 DOM 只有一種，不重複文字、也不強迫縮小完整桌面表格。
 *
 * columns: [{ key, header, render?(row), align?: 'right', primary?: true, hideOnMobile?: true }]
 *   primary 欄位在手機卡片作為標題；其餘欄位以「標籤：值」列出。
 */
export default function DataTable({ columns, rows, rowKey, caption, className = '', empty = null }) {
  const wide = useIsWide();
  if (!rows.length) return empty;
  const cell = (c, row) => (c.render ? c.render(row) : row[c.key]);
  if (!wide) return <MobileCardList columns={columns} rows={rows} rowKey={rowKey} cell={cell} />;
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full text-sm ir-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="text-xs text-ui-muted">
            {columns.map(c => (
              <th key={c.key} scope="col" className={`py-2 px-3 font-medium whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map(c => (
                <td key={c.key} className={`py-2 px-3 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>{cell(c, row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 手機的卡片清單：primary 欄位當標題，其餘「標籤：值」；長文字可換行，不截字。 */
export function MobileCardList({ columns, rows, rowKey, cell }) {
  const primary = columns.find(c => c.primary) || columns[0];
  const rest = columns.filter(c => c !== primary && !c.hideOnMobile);
  return (
    <ul className="space-y-2" data-testid="mobile-card-list">
      {rows.map((row, i) => (
        <li key={rowKey(row, i)} className="list-row rounded-lg border border-ui-line bg-ui-soft p-3">
          <div className="text-sm font-medium text-ui-text break-words">{cell(primary, row)}</div>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {rest.map(c => (
              <div key={c.key} className="min-w-0">
                <dt className="text-ui-muted">{c.header}</dt>
                <dd className="text-ui-text tabular-nums break-words">{cell(c, row)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
