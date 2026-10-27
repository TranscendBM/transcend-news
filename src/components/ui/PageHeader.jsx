/** 頁面標題列：標題、說明、右側動作（匯出等放這裡，不要散在內容中）、meta（更新時間等）。 */
export default function PageHeader({ title, description, actions, meta, className = '' }) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-4 gap-y-2 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-ui-text leading-tight">{title}</h2>
        {description && <p className="text-xs text-ui-muted mt-0.5 max-w-3xl">{description}</p>}
        {meta && <div className="mt-1">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
