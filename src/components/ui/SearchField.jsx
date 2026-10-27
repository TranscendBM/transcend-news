import Icon from '../Icon.jsx';

/** 搜尋欄：全站同一種外觀（左側放大鏡）。label 同時是 aria-label。 */
export default function SearchField({ value, onChange, label, placeholder, className = '' }) {
  return (
    <label className={`relative block min-w-0 ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-ui-muted pointer-events-none" />
      <input type="search" value={value} onChange={e => onChange(e.target.value)} aria-label={label} placeholder={placeholder}
        className="ui-field w-full pl-9" />
    </label>
  );
}
