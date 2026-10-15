import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { URL_CHANGE_EVENT, readParam, writeParams } from '../utils/urlState.js';

function subscribe(callback) {
  window.addEventListener('popstate', callback);
  window.addEventListener(URL_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(URL_CHANGE_EVENT, callback);
  };
}

/**
 * 把一個 URL query 參數當成 state 使用，例如 useUrlParam('section', ids, 'overview')。
 *
 *   - 網址沒有這個參數、或參數是不認識的值 → 一律回退到 fallback，不會出現空白頁
 *   - 參數是不認識的值時，會用 replaceState 把壞掉的參數從網址上移除（不新增歷史紀錄）
 *   - 回傳的 setter 用 pushState，所以上一頁／下一頁可以回到前一個值
 *   - 瀏覽器上一頁／下一頁（popstate）與同頁其他 useUrlParam 的更新都會即時反映
 */
export function useUrlParam(name, allowed, fallback) {
  const raw = useSyncExternalStore(subscribe, () => readParam(name), () => null);
  const valid = raw != null && allowed.includes(raw);
  const value = valid ? raw : fallback;

  useEffect(() => {
    if (raw != null && !valid) writeParams({ [name]: null }, { replace: true });
  }, [raw, valid, name]);

  const setValue = useCallback((next, options) => writeParams({ [name]: next }, options), [name]);
  return [value, setValue];
}
