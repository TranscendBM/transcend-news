import { useId, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

// ═══════════════════════════════════════════════════════════
// IR TAB — 財務名詞 Tooltip
// ═══════════════════════════════════════════════════════════
export default function TermTip({ label, name, tip }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const tipId = useId();

  const showTip = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
  };
  const hideTip = () => setPos(null);

  return (
    <span className="inline-flex items-center gap-1.5">
      {label && <span>{label}</span>}
      <button type="button" ref={btnRef}
        aria-label={(name || label) ? `${name || label}說明` : '名詞說明'} aria-describedby={pos ? tipId : undefined}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        onKeyDown={e => { if (e.key === 'Escape') hideTip(); }}
        onClick={() => pos ? hideTip() : showTip()}
        className="inline-flex items-center justify-center w-4 h-4 p-0 rounded-full text-xs font-bold cursor-help select-none shrink-0 ir-tip-btn"
        style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>?</button>
      {pos && ReactDOM.createPortal(
        <span id={tipId} role="tooltip" style={{
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
