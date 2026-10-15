import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';
import { resetRememberedSections } from '../hooks/useSectionNav.js';

// 網址現在會記錄目前的分頁（?tab=、?section=），每個測試開始前都回到乾淨的網址，
// 避免上一個測試切換過的分頁影響下一個測試。
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  resetRememberedSections();
});

// jsdom 沒有實作 scrollTo（呼叫會印出 "Not implemented" 錯誤訊息）；換頁時我們會捲回頂端。
window.scrollTo = vi.fn();
