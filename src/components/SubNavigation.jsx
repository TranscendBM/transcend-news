import { useEffect, useRef } from 'react';

import Icon from './Icon.jsx';

export const subTabId = (prefix, id) => `${prefix}-tab-${id}`;
export const subPanelId = (prefix, id) => `${prefix}-panel-${id}`;

/**
 * 第二層導覽（PR 媒體戰情、IR 投資情報共用）。
 *
 * - 無障礙：role="tablist"／"tab"，aria-selected、aria-controls 指向對應的 tabpanel；
 *   只有目前的 tab 在 Tab 鍵順序內（roving tabindex），其他用方向鍵切換。
 *   鍵盤：← → 切換（頭尾循環）、Home／End 跳到第一個／最後一個；Enter／Space 為按鈕原生行為。
 * - 版面：sticky 在主 Header（h-14）下方；手機上標籤不換行、整列可橫向捲動，
 *   目前的標籤會自動捲到可視範圍內；只有這一列自己捲動，不會讓整個頁面出現水平捲軸。
 * - 目前所在位置用深紅底白字標示，不依賴動畫。
 *
 * sections: [{ id, label, icon }]；prefix 用來組出 tab／panel 的 id（如 pr-tab-news）。
 */
export default function SubNavigation({ sections, active, onChange, prefix, label }) {
  const buttonRefs = useRef({});

  // 目前的標籤切換後，確保它在橫向捲動的可視範圍內（手機）
  useEffect(() => {
    const el = buttonRefs.current[active];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [active]);

  const move = (fromIndex, delta) => {
    const next = sections[(fromIndex + delta + sections.length) % sections.length];
    onChange(next.id);
    buttonRefs.current[next.id]?.focus();
  };

  const onKeyDown = (event, index) => {
    switch (event.key) {
      case 'ArrowRight': event.preventDefault(); move(index, 1); break;
      case 'ArrowLeft': event.preventDefault(); move(index, -1); break;
      case 'Home': event.preventDefault(); move(0, 0); break;
      case 'End': event.preventDefault(); move(sections.length - 1, 0); break;
      default: break;
    }
  };

  return (
    <div className="pr-subnav sticky top-14 z-40 -mx-4 px-4 pt-1 pb-2 border-b border-gray-700/60"
      style={{ background: '#f5f6f8' }}>
      <div role="tablist" aria-label={label} aria-orientation="horizontal"
        className="flex gap-1 overflow-x-auto whitespace-nowrap">
        {sections.map((section, index) => {
          const selected = section.id === active;
          return (
            <button key={section.id} type="button" role="tab"
              id={subTabId(prefix, section.id)} aria-selected={selected}
              aria-controls={subPanelId(prefix, section.id)}
              tabIndex={selected ? 0 : -1}
              ref={el => { buttonRefs.current[section.id] = el; }}
              onClick={() => onChange(section.id)} onKeyDown={e => onKeyDown(e, index)}
              className={`pr-subtab shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${
                selected ? 'text-white shadow-sm' : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800'}`}
              style={selected ? { background: 'rgb(150,0,20)' } : undefined}>
              <Icon name={section.icon} />
              {section.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
