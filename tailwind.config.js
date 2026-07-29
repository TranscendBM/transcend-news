/**
 * 統一字級（單位 pt，換算 px = pt × 4/3）：
 *   text-xs    9pt(12px)   — 附註／標籤類文字下限
 *   text-sm   12pt(16px)   — 內文字級下限
 *   text-base 15pt(20px)   — 小標題／<h3>（h2 層級）
 *   text-lg   14pt(18.67px) — 大標題（h1 層級，頁首標題用）
 * 註：base(15pt) > lg(14pt) 只是沿用 Tailwind 既有 class 名稱掛自訂數值，
 * 兩者用在完全不同的地方（base 給 <h3>，lg 給頁首主標題），不影響顯示。
 * xl 以上（數字型大字）維持 Tailwind 預設，不受此限。
 * （原本是 public/index.html 內 <script> 的 tailwind.config，
 * 搬到這裡改由 build 期產生固定的 CSS，不再依賴 CDN 執行期執行。）
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontSize: {
        xs: ['9pt', { lineHeight: '1.4' }],
        sm: ['12pt', { lineHeight: '1.5' }],
        base: ['15pt', { lineHeight: '1.5' }],
        lg: ['14pt', { lineHeight: '1.4' }],
      },
    },
  },
  plugins: [],
};
