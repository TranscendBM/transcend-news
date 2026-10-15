// 單色線條圖示（取代彩色 emoji）：顏色跟著文字顏色（currentColor）走，
// 所以放在灰色標題旁就是灰色、放在紅色按鈕裡就是紅色。
// 圖形是 24×24 的線條路徑；沒有對應名稱時什麼都不畫（不會當成文字顯示）。

const PATHS = {
  // 分頁／導覽
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z M15 9a4 4 0 0 1 0 6 M18 6.5a8 8 0 0 1 0 11',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  // 卡片標題
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2z M17 9h3v8a2 2 0 0 1-2 2 M7 9h7 M7 13h7',
  coins: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M15 9.5c-.3-1-1.4-1.5-3-1.5-1.7 0-3 .8-3 2s1.2 1.7 3 2 3 .7 3 2-1.3 2-3 2c-1.6 0-2.7-.5-3-1.5 M12 6v2 M12 16v2',
  chart: 'M5 20V10 M12 20V4 M19 20v-7',
  table: 'M9 4h6v3H9z M7 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1 M9 12h6 M9 16h6',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8 M10 20a2 2 0 0 0 4 0',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12h.01',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  pen: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  eyeoff: 'M3 3l18 18 M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a14 14 0 0 1-2.2 3 M6.6 6.6C4.6 8 3.2 10.2 2.5 12c1 2 4.5 6 9.5 6 1.5 0 2.8-.4 4-1',
  refresh: 'M20 11a8 8 0 0 0-14.9-3 M4 4v4h4 M4 13a8 8 0 0 0 14.9 3 M20 20v-4h-4',
  users: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M21 20v-2a4 4 0 0 0-3-3.9 M16 3.1a3.5 3.5 0 0 1 0 6.8',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  shuffle: 'M16 3h5v5 M4 20L21 3 M21 16v5h-5 M15 15l6 6 M4 4l5 5',
  tag: 'M3 12V4h8l10 10-8 8z M7.5 7.5h.01',
  radar: 'M12 12l5-5 M21 12a9 9 0 1 1-9-9 M17 12a5 5 0 1 1-5-5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkcircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l3 3 5-6',
  bot: 'M5 8h14v10H5z M12 4v4 M9 13h.01 M15 13h.01 M3 12v3 M21 12v3',
  // 按鈕
  copy: 'M9 9h11v11H9z M5 15V4h10',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 20V9 M7 13l5-5 5 5 M5 4h14',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M12 7v5l3 2',
  chevronright: 'M9 6l6 6-6 6',
  arrowleft: 'M19 12H5 M11 6l-6 6 6 6',
  external: 'M14 4h6v6 M10 14L20 4 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  dot: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

export const ICON_NAMES = Object.keys(PATHS);

export default function Icon({ name, className = '' }) {
  const d = PATHS[name];
  if (!d) return null;
  const filled = name === 'dot';
  return (
    <svg viewBox="0 0 24 24" width="1.15em" height="1.15em" aria-hidden="true" focusable="false"
      className={`inline-block shrink-0 align-[-0.2em] ${className}`}
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      {d.split(' M').map((seg, i) => <path key={i} d={i === 0 ? seg : 'M' + seg} />)}
    </svg>
  );
}
