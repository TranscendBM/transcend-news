"""
媒體曝光分類（純函式，不碰 Firestore／網路）。

與 matchStatus 完全分開：
  matchStatus   ＝ 這篇曝光有沒有配對到某一篇新聞稿
  coverageClass ＝ 這篇曝光「本身」是哪一種報導

分類（coverageClass）
  press_release_derived  新聞稿衍生曝光
  company_coverage       一般公司報導（創見的產品、營運、活動、管理層，但不是新聞稿轉載）
  industry_related       產業／市場連帶報導（創見只是被提及的公司：股市、競品、供應鏈、漲價缺貨…）
  unrelated              不相關（同名公司、錯誤抓取）
  review                 待人工判定（資訊不足、只有建議配對、有新聞稿特徵但無法唯一配對）

方法（coverageClassMethod）：manual（人工，永遠不被自動程序覆蓋）｜press_release_match｜rule｜fallback

保守原則：高信心（>= AUTO_MIN_CONFIDENCE）才自動分類，否則一律 review；
不為了降低 unmatched 數量而強迫配對新聞稿。規則只看文字，不會把月份、季度、型號等數字洗掉。
"""

from __future__ import annotations

import re
import unicodedata

CLASSIFICATION_VERSION = '2026-10-v1'
AUTO_MIN_CONFIDENCE = 0.7

DERIVED = 'press_release_derived'
COMPANY = 'company_coverage'
INDUSTRY = 'industry_related'
UNRELATED = 'unrelated'
REVIEW = 'review'

CLASS_LABELS = {
    DERIVED: '新聞稿衍生曝光',
    COMPANY: '一般公司報導',
    INDUSTRY: '產業連帶報導',
    UNRELATED: '不相關',
    REVIEW: '待確認',
}
METHODS = ('manual', 'press_release_match', 'rule', 'fallback')

COMPANY_NAMES = ('創見', 'transcend', '2451')
EXECUTIVES = ('束崇萬', '陳柏壽')

# 同業／記憶體產業的公司與原廠（創見的合作夥伴例如研華、輝達不算）
PEERS = (
    '威剛', '宜鼎', '十銓', '宇瞻', '廣穎', '群聯', '南亞科', '華邦電', '旺宏', '美光', '晟碟', '三星', '海力士',
    '晶豪科', '力積電', '慧榮', '鎧俠', '長江存儲', '長鑫', '兆易創新', '金士頓', 'adata', 'innodisk', 'micron',
    'samsung', 'kioxia', 'sandisk', 'kingston', 'apacer', 'silicon power', 'sk hynix',
)
INDUSTRY_TERMS = (
    '記憶體', 'dram', 'nand', 'flash', '半導體', '模組廠', '供應鏈', '族群', '台股', '大盤', '缺貨', '漲價', '報價',
    '原廠', '外包', '委外', '罷工', '產業', 'hbm', '晶圓', '電子上游',
)
STOCK_TERMS = (
    '盤中速報', '漲停', '跌停', '大漲', '大跌', '急拉', '急跌', '急殺', '注意股', '處置股', '買超', '賣超', '券商評等',
    '目標價', '權證', '法人', '外資', '投信', '融資', '成交', '股價', '個股', '焦點股', '熱門股', '飆',
)
MANAGEMENT_SPEAKER = re.compile(
    r'創見(?:董座|董事長|副總|總座|總經理|束崇萬|陳柏壽)?(?:：|:|喊|看|表示|指出|直言|認為|預期|強調|曝|揭|說|談|坦言|破除)')
COMPANY_SIGNALS = (
    '董座', '董事長', '副總', '總經理', '法說', '股東會', '財報', '營收', 'eps', '每股', '盈餘', '股利', '現金增資',
    '可轉債', '轉換公司債', '公告', '裁罰', '罰鍰', '庫存', '募資', '獲利', '毛利', '推出', '發表', '登場', '亮相',
    '參展', '參加', '展出', '攜手', '布局', '搶攻', '新品', '解決方案', '模組', '鏡頭', 'ssd', 'ddr', '榮獲', '獲選',
    '肯定', '聯手', '擴展', '擴充',
)
ANON_SUBJECT = re.compile(r'[「『][^」』]{1,12}[」』]|這檔|這大廠|這家|模組巨頭|記憶體巨頭|記憶體大廠')
SAME_NAME = re.compile(r'創見(?:文化|出版|國際文教|教育|藝術|建設)')
TICKER = re.compile(r'[(（]\s*\d{3,5}\s*[)）]')     # 股票代號（括號內 3～5 碼）；單獨的 7200、6400 是型號不是代號


def _norm(value) -> str:
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or ''))).strip().lower()


def _first_index(text: str, needles) -> int:
    hits = [text.find(n) for n in needles if n in text]
    return min(hits) if hits else -1


def _any(text: str, needles) -> bool:
    return any(n in text for n in needles)


def _result(cls, method, confidence, reasons):
    return {
        'coverageClass': cls,
        'coverageClassLabel': CLASS_LABELS[cls],
        'coverageClassMethod': method,
        'coverageClassConfidence': round(float(confidence), 2),
        'coverageClassReasons': list(reasons),
        'classificationVersion': CLASSIFICATION_VERSION,
    }


def classify_by_text(title) -> tuple[str, float, list[str]]:
    """只看標題文字的分類（沒有配對資訊）。回傳 (類別, 信心, 原因)；信心不足時類別仍可能是 industry／company，
    由 classify_exposure 依 AUTO_MIN_CONFIDENCE 決定要不要降成 review。"""
    raw = str(title or '')
    text = _norm(raw)
    if not text:
        return REVIEW, 0.0, ['empty_title']

    has_company = _any(text, COMPANY_NAMES) or _any(raw, EXECUTIVES)
    # 同名公司（創見文化事業…）：沒有任何記憶體／股票線索才算不相關
    if SAME_NAME.search(raw) and not _any(text, ('2451', 'transcend', '記憶體', 'dram', 'nand', 'ssd', '束崇萬')):
        return UNRELATED, 0.95, ['same_name_company']

    # 持股轉讓：別的公司取得／處分創見股票（創見只是標的）
    if re.search(r'(取得|處分|買進|賣出|轉讓|持有|持股)[^，。]{0,12}創見|創見[^，。]{0,4}(股票|股份)', raw) \
            and re.search(r'張|股', raw):
        return INDUSTRY, 0.9, ['shareholding_transfer']

    # 指數／ETF 成分股調整
    if re.search(r'指數|成分股|etf|00\d{3}', text) and re.search(r'納入|納|刪除|刪|剔除|成分|調整|換血|首曝光', raw):
        return INDUSTRY, 0.88, ['index_rebalance']

    if not has_company:
        if ANON_SUBJECT.search(raw):
            return REVIEW, 0.5, ['anonymized_subject']
        if _any(text, INDUSTRY_TERMS) or _any(text, PEERS):
            return INDUSTRY, 0.75, ['industry_without_company']
        return REVIEW, 0.4, ['no_company_no_industry_signal']

    idx_company = _first_index(text, COMPANY_NAMES)
    if idx_company < 0:
        idx_company = _first_index(raw, EXECUTIVES)

    # 創見管理層談話（創見是說話的人）→ 公司報導，即使內容談產業與原廠報價
    if MANAGEMENT_SPEAKER.search(raw) and idx_company <= 12:
        return COMPANY, 0.85, ['management_statement']

    peers = [p for p in PEERS if p in text]
    tickers = set(TICKER.findall(raw))
    if peers or len(tickers) >= 2:
        reasons = ['peer_companies'] if peers else ['multi_stock_list']
        if peers and _first_index(text, peers) < idx_company:
            reasons.append('peer_mentioned_first')
        return INDUSTRY, 0.85, reasons

    stock = _any(text, STOCK_TERMS)
    if idx_company <= 15:
        if stock and not _any(text, COMPANY_SIGNALS):
            return COMPANY, 0.75, ['single_company_stock']
        if _any(text, COMPANY_SIGNALS):
            return COMPANY, 0.85, ['company_subject']
        return COMPANY, 0.7, ['company_subject_weak']

    # 創見出現在標題後半：多半是市場／產業新聞順帶提到
    if stock or _any(text, INDUSTRY_TERMS):
        return INDUSTRY, 0.75, ['mentioned_in_market_context']
    return REVIEW, 0.5, ['company_mention_unclear']


def classify_exposure(exposure: dict, match_status: str | None, match_confidence=None, match_reason=None) -> dict:
    """
    exposure：含 title；match_status：這次配對決策之後的 matchStatus（confirmed／auto_matched／suggested／unmatched）。
    match_reason：配對引擎回傳的 reason（例如 ambiguous_title）。
    回傳 coverageClass 相關欄位（不含 classifiedAt）。
    """
    status = match_status or 'unmatched'
    if status == 'confirmed':
        return _result(DERIVED, 'press_release_match', 1.0, ['confirmed_match'])
    if status == 'auto_matched':
        conf = match_confidence if isinstance(match_confidence, (int, float)) else 0.9
        return _result(DERIVED, 'press_release_match', max(conf, AUTO_MIN_CONFIDENCE), ['auto_match'])
    if status == 'suggested':
        return _result(REVIEW, 'rule', 0.5, ['suggested_match_unconfirmed'])
    if match_reason and str(match_reason).startswith('ambiguous'):
        return _result(REVIEW, 'rule', 0.5, ['press_release_features_ambiguous', str(match_reason)])

    cls, confidence, reasons = classify_by_text(exposure.get('title'))
    if cls == REVIEW:
        return _result(REVIEW, 'fallback', confidence, reasons)
    if confidence < AUTO_MIN_CONFIDENCE:
        return _result(REVIEW, 'fallback', confidence, reasons + ['low_confidence'])
    return _result(cls, 'rule', confidence, reasons)


CLASS_FIELDS = ('coverageClass', 'coverageClassLabel', 'coverageClassMethod', 'coverageClassConfidence',
                'coverageClassReasons', 'classificationVersion')


def is_manual(exposure: dict) -> bool:
    return exposure.get('coverageClassMethod') == 'manual' and bool(exposure.get('coverageClass'))


def class_changed(exposure: dict, result: dict) -> bool:
    """只有分類結果有變動才需要寫入（版本不同也算變動，讓規則升級後能安全重跑）。"""
    for key in CLASS_FIELDS:
        old, new = exposure.get(key), result[key]
        if key == 'coverageClassReasons':
            old = list(old or [])
        if old != new:
            return True
    return False
