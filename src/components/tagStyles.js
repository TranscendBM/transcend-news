// 小標籤（pill）配色：淺色底＋深色字＋同色系細框，在白底上對比清楚。
// 不要用 bg-xxx-900/30 + text-xxx-500 這種暗色系配色——白底上會變成灰灰的看不清楚。
export const TAG_TONES = {
  green: 'bg-green-50 text-green-700 border border-green-300',
  red: 'bg-red-50 text-red-700 border border-red-300',
  blue: 'bg-blue-50 text-blue-700 border border-blue-300',
  amber: 'bg-amber-50 text-amber-800 border border-amber-300',
  gray: 'bg-slate-100 text-slate-600 border border-slate-300',
};

export const tagClass = (tone = 'gray', extra = '') =>
  `text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${TAG_TONES[tone] || TAG_TONES.gray} ${extra}`.trim();
