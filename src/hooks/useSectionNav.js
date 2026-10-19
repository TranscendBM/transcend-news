import { useCallback } from 'react';

import { useUrlParam } from './useUrlParam.js';
import { writeParams } from '../utils/urlState.js';

// 每個主分頁最後停留的子頁。主分頁切換時網址的 section 會被清掉，
// 這裡記住它，切回來時回到原本的子頁（PR 與 IR 各記各的，不會互相覆蓋）。
const lastSection = {};
export const rememberedSection = tab => lastSection[tab] ?? null;
export function resetRememberedSections() {
  Object.keys(lastSection).forEach(key => delete lastSection[key]);
}

/**
 * 第二層導覽的共用邏輯：網址 ?tab=<tab>&section=<id>。
 * 沒有或不認識的 section → fallback；回傳的 navigate 用 pushState（上一頁／下一頁可切換）並捲回頂端。
 */
export function useSectionNav(tab, ids, fallback) {
  const [section] = useUrlParam('section', ids, fallback);
  lastSection[tab] = section === fallback ? null : section;
  // extra：換子頁時一併改的其他網址參數（例如離開「事件」子頁時清掉 filter）
  const navigate = useCallback((next, extra) => {
    lastSection[tab] = next === fallback ? null : next;
    writeParams({ tab, section: next, ...extra });
    try { window.scrollTo(0, 0); } catch { /* 非瀏覽器環境略過 */ }
  }, [tab, fallback]);
  return [section, navigate];
}
