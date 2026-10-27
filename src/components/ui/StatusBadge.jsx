// 狀態徽章：符號＋文字＋顏色三者並用（不只靠紅綠辨識）。
const TONES = {
  ok: { cls: 'text-[color:var(--ok)] bg-[color:var(--ok-bg)] border-[color:var(--ok-line)]', mark: '●' },
  info: { cls: 'text-[color:var(--info)] bg-[color:var(--info-bg)] border-[color:var(--info-line)]', mark: 'i' },
  warn: { cls: 'text-[color:var(--warn)] bg-[color:var(--warn-bg)] border-[color:var(--warn-line)]', mark: '!' },
  error: { cls: 'text-[color:var(--danger)] bg-[color:var(--danger-bg)] border-[color:var(--danger-line)]', mark: '✕' },
  neutral: { cls: 'text-[color:var(--neutral)] bg-[color:var(--neutral-bg)] border-[color:var(--neutral-line)]', mark: '○' },
};

export default function StatusBadge({ tone = 'neutral', children, className = '', ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span data-tone={tone} {...rest}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${t.cls} ${className}`}>
      <span aria-hidden="true">{t.mark}</span>
      {children}
    </span>
  );
}
