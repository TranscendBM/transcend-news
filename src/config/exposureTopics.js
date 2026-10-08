// 人工確認曝光的「題材」與「媒體類型」對照表（給曝光分析頁用）。
// 都是用關鍵字／名稱比對的預設值，不準的地方直接改這個檔案就會生效。

// 一則報導標題可以同時符合多個題材；都不符合會歸到「其他」。
export const EXPOSURE_TOPICS = [
  { id: 'finance', label: '營收・財報', keywords: ['營收', '財報', '獲利', 'EPS', '毛利', '季報', '法說', '年增', '月增', '賺'] },
  { id: 'product', label: '新品・產品', keywords: ['新品', '推出', '發表', '推兩款', '推2款', '鏡頭', '模組', 'SSD', '固態', '記憶卡', '隨身碟', '工業級', '嵌入式'] },
  { id: 'partner', label: '合作・展覽', keywords: ['攜手', '合作', '研華', '聯手', '結盟', '參展', '展覽', '輝達', 'NVIDIA'] },
  { id: 'market', label: '記憶體市況', keywords: ['記憶體', 'DRAM', 'NAND', '報價', '漲價', '缺貨', '供不應求', '供需', '現貨', '合約價'] },
  { id: 'corporate', label: '股務・公司治理', keywords: ['股利', '配息', '股東會', '庫藏股', '公司債', '增資', '董事會', '處分', '持股', '申請展延'] },
  { id: 'ai', label: 'AI・邊緣運算', keywords: ['AI', 'Edge', '邊緣', '輝達'] },
];

// 媒體類型（預設對照，沒列到的歸「其他」）。
const CATEGORY_MEMBERS = {
  報紙: ['經濟日報', '工商時報', '聯合報', '自由時報', '時報資訊', '中國時報', '中時新聞網'],
  通訊社: ['中央社'],
  電視: ['非凡新聞', '三立新聞', 'TVBS新聞網', '東森新聞', '中天新聞網', '民視財經網'],
  財經網站: ['鉅亨網', 'MoneyDJ理財網', '財訊快報', 'FTNN新聞網', '知新聞', 'CMoney', '旺得富理財網',
    '財報新聞', 'MoneyLink富聯網', '理財周刊', '優分析', 'Yahoo財經', '精實財經'],
  科技專業: ['電子時報', '科技新報', 'iThome'],
  綜合網媒: ['ETtoday', 'Nownews', '壹蘋新聞網', '鏡報新聞網', '鏡周刊'],
};

export function mediaCategoryOf(name) {
  for (const [category, members] of Object.entries(CATEGORY_MEMBERS)) {
    if (members.includes(name)) return category;
  }
  return '其他';
}
