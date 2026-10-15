/* global Event, URLSearchParams */

// 網址 query 參數的讀寫（?tab=pr&section=overview）。
//
// 寫入用 history.pushState，所以瀏覽器的上一頁／下一頁會在頁籤之間切換；
// pushState 本身不會觸發 popstate，所以寫入後另外發一個自訂事件，讓同一頁上
// 所有訂閱網址的 hook（useUrlParam）都能同步更新。

export const URL_CHANGE_EVENT = 'app:urlchange';

export function readParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * 更新一個或多個參數；值為 null／undefined 代表移除。其他參數與 hash 保持不變。
 * 網址沒有實際變動時什麼都不做（避免歷史紀錄堆出一堆重複項目）。
 * replace=true 用 replaceState（不新增歷史紀錄，用在「把壞掉的參數修正掉」）。
 */
export function writeParams(updates, { replace = false } = {}) {
  const params = new URLSearchParams(window.location.search);
  Object.entries(updates).forEach(([key, value]) => {
    if (value == null) params.delete(key); else params.set(key, value);
  });
  const query = params.toString();
  const next = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next === current) return;
  window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', next);
  window.dispatchEvent(new Event(URL_CHANGE_EVENT));
}
