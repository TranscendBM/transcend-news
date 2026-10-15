/* global XMLSerializer, URL, Blob, Image, navigator, ClipboardItem */
// 把頁面上的 SVG 圖表轉成 PNG 圖片，複製到剪貼簿（可直接貼進 PowerPoint /
// Word / Google Slides）。圖片是白底、含標題、圖例與資料來源說明，
// 這樣貼出去不用再補文字。剪貼簿不支援圖片時（舊瀏覽器、非 https）
// 改成下載 PNG 檔。

const SCALE = 3;          // 輸出解析度倍率，投影片放大時才不會糊
const PAD = 16;
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';

function svgSize(svg) {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width && vb.height) return { w: vb.width, h: vb.height };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 700, h: r.height || 220 };
}

function loadSvgImage(svg) {
  const { w, h } = svgSize(svg);
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.removeAttribute('style');
  clone.setAttribute('style', `font-family:${FONT.replace(/"/g, "'")}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ img, w, h }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 轉圖片失敗')); };
    img.src = url;
  });
}

/**
 * 組出一張 PNG：標題 → 圖例（會自動換行）→ 圖表本體 → 說明文字。
 * legend: [{ name, color }]；note: 圖表下方的小字（例如資料來源、單位）。
 */
export async function renderChartPng(svg, { title, legend = [], note = '' } = {}) {
  const { img, w, h } = await loadSvgImage(svg);
  const width = Math.max(w, 560) + PAD * 2;

  // 先量圖例需要幾行，才知道畫布高度
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `12px ${FONT}`;
  const ITEM_GAP = 18, SWATCH = 18;
  const rows = [[]];
  let rowW = 0;
  legend.forEach(item => {
    const itemW = SWATCH + 5 + measure.measureText(item.name).width + ITEM_GAP;
    if (rowW + itemW > width - PAD * 2 && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
    rows[rows.length - 1].push(item);
    rowW += itemW;
  });
  const legendH = legend.length ? rows.length * 20 + 6 : 0;
  const titleH = title ? 30 : 0;
  const noteH = note ? 24 : 0;
  const height = PAD + titleH + legendH + h + noteH + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let y = PAD;
  if (title) {
    ctx.fillStyle = '#1f2937';
    ctx.font = `bold 16px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(title, PAD, y + 2);
    y += titleH;
  }
  if (legend.length) {
    ctx.font = `12px ${FONT}`;
    ctx.textBaseline = 'middle';
    rows.forEach(row => {
      let x = PAD;
      row.forEach(item => {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y + 8, SWATCH, 3);
        ctx.fillStyle = '#475569';
        ctx.fillText(item.name, x + SWATCH + 5, y + 10);
        x += SWATCH + 5 + ctx.measureText(item.name).width + ITEM_GAP;
      });
      y += 20;
    });
    y += 6;
  }
  ctx.drawImage(img, PAD + (width - PAD * 2 - w) / 2, y, w, h);
  y += h;
  if (note) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(note, PAD, y + 6);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('產生 PNG 失敗'))), 'image/png');
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 回傳 'copied'（已複製到剪貼簿）或 'downloaded'（瀏覽器不支援，改下載）。 */
export async function copyChartImage(svg, opts = {}) {
  const pngPromise = renderChartPng(svg, opts);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      // 直接把 Promise 交給 ClipboardItem：使用者點擊後的授權不會因為
      // 等待圖片產生而過期（Safari 要求這樣做，Chrome 也支援）。
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
      return 'copied';
    } catch (e) {
      console.warn('複製圖表到剪貼簿失敗，改下載 PNG:', e);
    }
  }
  const name = `${(opts.title || '圖表').replace(/[\\/:*?"<>|]/g, '_')}.png`;
  downloadBlob(await pngPromise, name);
  return 'downloaded';
}
