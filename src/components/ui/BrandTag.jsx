// 品牌標籤：列表中標示「這則是哪一家公司」的統一樣式（品牌色圓角色塊＋白字）。
// PR 競品新聞（NewsCard）與 IR 重大訊息列表共用，避免兩邊各寫一套不同的視覺。
export default function BrandTag({ name, color, className = '', ...rest }) {
  return (
    <span {...rest} className={`inline-block shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold text-white align-middle ${className}`}
      style={{ background: color || '#6b7280' }}>{name}</span>
  );
}
