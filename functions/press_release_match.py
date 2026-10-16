"""
媒體曝光 ↔ 新聞稿主檔 配對引擎（純函式，不碰 Firestore／網路）。

保守原則：寧可「待確認」或「未配對」，也不要把不同的新聞稿合併。
  - 人工確認（confirmed）永遠不被覆蓋（由呼叫端略過，見 press_release_sync.build_plan）
  - 只有高信心規則才會寫成 auto_matched（才會有 pressReleaseId）
  - 低信心只寫 suggested（suggestedPressReleaseId），不會當成正式配對
  - 候選同分／互相包含時不任選一個
  - 不同月份營收、不同季度財報、不同產品型號（DDR5 7200 vs 6400）不會互相配對

配對順序（decide）：
  1. 曝光資料已有明確新聞稿 ID（campaignId）且對得上稿單的明確 ID
  2. 官方連結完全相同
  3. 正規化後的正式標題完全相同
  4. 發布日期（日精度）＋標題關鍵字的高信心比對
  5. 標題相似度 → 只產生 suggested
  都不符合 → unmatched
（「人工確認」「已存在的 pressReleaseId」兩條在 press_release_sync.decide_exposure 處理。）
"""

from __future__ import annotations

import re
import unicodedata

import coverage_classify as cc
from datetime import date
from urllib.parse import urlsplit

STATUS_CONFIRMED = 'confirmed'
STATUS_AUTO = 'auto_matched'
STATUS_SUGGESTED = 'suggested'
STATUS_UNMATCHED = 'unmatched'
STATUS_REJECTED = 'rejected'        # 人工排除：確認不屬於任何新聞稿衍生曝光（只由人工覆核產生）

# 曝光日相對於新聞稿日期的容許範圍（天）：媒體不會比發稿早報導，容許 1 天時差
WINDOW_BEFORE_DAYS = 1
WINDOW_AFTER_DAYS = 7
EXACT_TITLE_AFTER_DAYS = 21       # 同標題的重複型新聞稿（例如每月營收）用日期區分時的範圍
SUGGEST_MAX_DAYS = 45
COVERAGE_MIN = 0.75
SIMILARITY_MIN = 0.5
SIMILARITY_GAP = 0.08

STOPWORDS = {
    'transcend', '創見', '創見資訊', 'with', 'and', 'for', 'the', 'of', 'in', 'new', 'to', 'a', 'an',
}
_ALNUM = re.compile(r'[a-z0-9]+(?:[.+][a-z0-9]+)*')   # 連字號當分隔：DDR5-7200 ＝ DDR5 7200
_CJK_RUN = re.compile(r'[一-鿿]+')
_YEAR_LIKE = re.compile(r'^(19|20)\d\d$')
_TRACKING = {'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source'}


# ── 文字正規化 ────────────────────────────────────────────
def norm_text(value) -> str:
    """NFKC＋小寫＋空白折疊。不移除數字、月份、季度、型號、容量、速度等資訊。"""
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or '')).lower()).strip()


def normalize_title(value) -> str:
    """norm_text 後清掉「首尾」的標點與符號；中間的標點與數字一律保留。"""
    text = norm_text(value)
    while text and unicodedata.category(text[0])[0] in 'PSZ':
        text = text[1:]
    while text and unicodedata.category(text[-1])[0] in 'PSZ':
        text = text[:-1]
    return text.strip()


def alnum_tokens(value) -> set[str]:
    out = set()
    for tok in _ALNUM.findall(norm_text(value)):
        if tok in STOPWORDS:
            continue
        if len(tok) >= 2 or tok.isdigit():
            out.add(tok)
    return out


def strong_tokens(tokens: set[str]) -> set[str]:
    """帶數字的型號／規格 token（ddr5、7200、usd710s）。年份與季度不算。"""
    return {t for t in tokens if any(c.isdigit() for c in t) and len(t) >= 3
            and not _YEAR_LIKE.match(t) and not re.fullmatch(r'q[1-4]', t)}


def cjk_bigrams(value) -> set[str]:
    grams = set()
    for run in _CJK_RUN.findall(norm_text(value)):
        for i in range(len(run) - 1):
            gram = run[i:i + 2]
            if gram not in STOPWORDS:
                grams.add(gram)
    return grams


def title_tokens(value) -> set[str]:
    return alnum_tokens(value) | cjk_bigrams(value)


_CN_NUM = {'一': 1, '二': 2, '三': 3, '四': 4}
_MONTH_REV = re.compile(r'(?<!\d)(\d{1,2})\s*月份?\s*(?:合併|自結)?營收')
_QUARTER = re.compile(r'(?:(20\d\d)\s*年?\s*)?(?:q\s*([1-4])|第\s*([一二三四1-4])\s*季)')


def period_signatures(value) -> dict[str, frozenset]:
    """標題中的期間：{'month': {'7'}, 'quarter': {'2026q1' 或 'q1'}}。沒有就不出現該鍵。"""
    text = norm_text(value)
    sigs: dict[str, set] = {}
    for m in _MONTH_REV.finditer(text):
        month = int(m.group(1))
        if 1 <= month <= 12:
            sigs.setdefault('month', set()).add(str(month))
    for m in _QUARTER.finditer(text):
        q = m.group(2) or m.group(3)
        q = str(_CN_NUM.get(q, q))
        sigs.setdefault('quarter', set()).add((m.group(1) or '') + 'q' + q)
    return {k: frozenset(v) for k, v in sigs.items()}


def periods_compatible(a: dict, b: dict) -> bool:
    """
    a＝新聞稿、b＝曝光標題的期間。新聞稿有的期間（月份／季度）曝光標題也要有而且相同；
    曝光標題多提了月份 → 不相容（月營收報導不能配給沒寫月份的稿）；
    曝光標題順帶提到季度（「9月營收…Q3創高」）→ 只有月營收這類新聞稿允許。
    """
    for kind in a:
        if kind not in b:
            return False
        if kind == 'quarter':
            # 有年份的要年份一致；只有 q 的只比季別
            qa = {s[-2:] for s in a[kind]}
            qb = {s[-2:] for s in b[kind]}
            if qa != qb:
                return False
            ya = {s[:-2] for s in a[kind] if s[:-2]}
            yb = {s[:-2] for s in b[kind] if s[:-2]}
            if ya and yb and ya != yb:
                return False
        elif a[kind] != b[kind]:
            return False
    for kind in b:
        if kind in a:
            continue
        if kind == 'month':
            return False
        if kind == 'quarter' and 'month' not in a:
            return False
    return True


def normalize_url(value) -> str:
    """去掉協定、www、追蹤參數、fragment、結尾斜線；沒有實質路徑（只有網域）回傳空字串。"""
    raw = str(value or '').strip()
    if not raw:
        return ''
    try:
        parts = urlsplit(raw if '://' in raw else 'https://' + raw)
    except ValueError:
        return ''
    host = (parts.hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    path = parts.path.rstrip('/')
    if not host or len(path) <= 1:
        return ''
    query = '&'.join(sorted(
        p for p in parts.query.split('&')
        if p and p.split('=')[0].lower() not in _TRACKING and not p.lower().startswith('utm_')))
    return host + path + ('?' + query if query else '')


def dice(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


# ── 新聞稿索引 ────────────────────────────────────────────
def effective_date(pr) -> date | None:
    """比對用日期：優先實際發布日，否則稿單日期；只接受「日」精度，月份／不明一律 None。"""
    for key in ('actualReleaseDate', 'scheduledDate'):
        value = pr.get(key)
        if value:
            try:
                return date.fromisoformat(value)
            except ValueError:
                continue
    return None


def prepare_press_release(pr) -> dict:
    """附上比對用的衍生欄位（不寫回 Firestore）。"""
    names = [pr.get('topic'), pr.get('title'), pr.get('officialTitle'), pr.get('englishTitle')]
    titles = {normalize_title(n) for n in names if n}
    titles.discard('')
    # 稿單可能同時有簡稱（主題）與完整標題：每個名稱各自成一組關鍵字，比對時取最合的一組
    token_sets = []
    for n in names:
        t = title_tokens(n) if n else set()
        if t and t not in token_sets:
            token_sets.append(t)
    # 完整標題很長，各媒體只會引用其中一段：每個子句（以逗號、頓號、冒號切開，夠長才算）也各自成一組關鍵字
    for n in (pr.get('officialTitle'), pr.get('title')):
        for clause in re.split(r'[，,、；;：:]', n or ''):
            t = title_tokens(clause)
            if len(t) >= 5 and t not in token_sets:
                token_sets.append(t)
    primary = title_tokens(pr.get('topic') or pr.get('title') or pr.get('officialTitle') or '')
    tokens = primary
    display = pr.get('officialTitle') or pr.get('title') or pr.get('topic') or ''
    sigs = period_signatures(' '.join(n for n in names if n))
    day = effective_date(pr)
    # 「營收新聞稿」這種沒有寫月份的重複型標題：營收是「上個月」的，所以月份由發稿日推得
    # （3/6 發的是 2 月營收）；只用來判斷曝光標題裡的「N月營收」是否對得上，沒有日期就不配對
    generic_rev = (not sigs and '營收' in normalize_title(display)
                   and normalize_title(display) in {'營收新聞稿', '營收', '營收公告', '月營收', '營收新聞稿稿'})
    implied = None
    if generic_rev and day is not None:
        implied = day.month - 1 or 12
        tokens = {'營收'}
        token_sets = [tokens]
    return {
        **pr,
        '_generic_rev': generic_rev,
        '_implied_month': implied,
        '_titles': titles,
        '_tokens': tokens,
        '_sets': token_sets or [tokens],
        '_strong': strong_tokens(tokens),
        '_sigs': sigs,
        '_date': day,
        '_url': normalize_url(pr.get('officialUrl')),
        '_display': display,
    }


def peer_led(title) -> bool:
    """同業（威剛、美光、三星…）在標題裡比創見更前面出現：這是產業／競品比較報導，不是創見新聞稿的轉載。"""
    text = norm_text(title)
    peer_idx = [text.find(p) for p in cc.PEERS if p in text]
    if not peer_idx:
        return False
    company_idx = [text.find(c) for c in cc.COMPANY_NAMES if c in text]
    return not company_idx or min(peer_idx) < min(company_idx)


def mentions_company(title) -> bool:
    text = norm_text(title)
    return any(k in text for k in ('創見', 'transcend', '2451'))


def compatible(p, ex_sigs, title='') -> bool:
    """新聞稿與曝光標題的期間（月份／季度）是否相容。"""
    if p.get('_generic_rev'):
        months = ex_sigs.get('month')
        return p.get('_implied_month') is not None and months == frozenset({str(p['_implied_month'])})
    return periods_compatible(p['_sigs'], ex_sigs)


# ═══════════════════════════════════════════════════════════
# 高信心自動配對（HC 規則）與配對理由
# ═══════════════════════════════════════════════════════════
HC_MAX_GAP_DAYS = 1            # 曝光日期與新聞稿發布日：同日或前後 1 天
HC_MIN_ANCHORS = 2             # 至少兩個具辨識力的錨點
HC_MARGIN = 1                  # 最佳候選要比第二候選多至少 1 個錨點

EXECUTIVE_NAMES = ('束崇萬', '陳柏壽')
# 產品類別詞（同義寫法歸成同一個標籤）；只放有辨識力的產品名詞，不放 AI／記憶體／SSD 這類通用詞
PRODUCT_TERMS = {
    '嵌入式鏡頭': r'嵌入式鏡頭', '鏡頭模組': r'鏡頭模組', '工業記憶體': r'工業(?:級|用)?記憶體', '固態硬碟': r'固態硬碟',
    '企業級SSD': r'企業級\s*ssd', '記憶卡': r'記憶卡', '隨身碟': r'隨身碟', '車載': r'車用|車載', '電競記憶體': r'電競記憶體',
}
EXHIBITION_TERMS = {
    'COMPUTEX': r'computex', '自動化展': r'自動化(?:工業)?(?:大)?展', '電子展': r'電子(?:產業科技)?展', '能源週': r'能源[週周]',
    '智慧製造展': r'智慧製造展|touch taiwan', 'embedded world': r'embedded world',
}
AWARD_TERMS = {
    'HBR': r'hbr|哈佛商業評論', '台灣企業領袖100強': r'台灣企業領袖\s*100\s*強', '外資精選台灣企業100強': r'外資精選台灣企業\s*100\s*強',
    '永續設計獎': r'永續設計獎', '台北新貿獎': r'新貿獎', '台灣精品獎': r'台灣精品獎', '企業永續獎': r'企業永續獎',
}
_STOCK_CUES = re.compile(r'股價|漲停|跌停|盤中|急拉|急殺|急跌|大漲|大跌|買超|賣超|目標價|權證|法人買|外資買|成交量')
_FINANCE_CUES = re.compile(r'營收|業績|獲利|財報|eps|每股盈餘|毛利|淨利')
_EVENT_CUES = re.compile(r'參展|參加|展出|亮相|展會|大展|推出|推(?=\s*[a-z0-9])|發表|新品|登場|上市|量產|榮獲|獲選|肯定|再獲|獲獎')
_UNIT_NUMBER = re.compile(r'(\d+(?:\.\d+)?)\s*(兆|億|萬|元|%|倍)')


def stock_commentary(title) -> bool:
    return bool(_STOCK_CUES.search(norm_text(title)))


def is_mixed_article(title) -> bool:
    """同時混合多個事件的文章（股價＋營運＋展覽…）：不是單一新聞稿的轉載，不可自動配對。"""
    text = norm_text(title)
    stock, finance, event = bool(_STOCK_CUES.search(text)), bool(_FINANCE_CUES.search(text)), bool(_EVENT_CUES.search(text))
    return (stock and (finance or event)) or (finance and event)


def _term_hits(table, text) -> set:
    return {label for label, pattern in table.items() if re.search(pattern, text)}


def _display_token(tok) -> str:
    return tok.upper() if tok.isascii() else tok


def _numbers(text) -> list:
    return [(float(m.group(1)), m.group(2)) for m in _UNIT_NUMBER.finditer(text)]


def anchors_between(pr, title) -> list:
    """曝光標題與新聞稿共同具有的「具辨識力的錨點」（顯示用文字，依類別排序、去重）。"""
    text = norm_text(title)
    pr_text = ' '.join(norm_text(n) for n in (pr.get('topic'), pr.get('title'), pr.get('officialTitle'), pr.get('englishTitle')) if n)
    ex_strong = strong_tokens(alnum_tokens(title))
    pr_strong = set()
    for tokens in pr['_sets']:
        pr_strong |= strong_tokens(tokens)
    out = []
    award_labels = _term_hits(AWARD_TERMS, text) & _term_hits(AWARD_TERMS, pr_text)
    award_digits = {d for a in award_labels for d in re.findall(r'\d+', a)}
    for tok in sorted((ex_strong & pr_strong) - award_digits):
        out.append(_display_token(tok))
    out += sorted(_term_hits(PRODUCT_TERMS, text) & _term_hits(PRODUCT_TERMS, pr_text))
    out += sorted(_term_hits(EXHIBITION_TERMS, text) & _term_hits(EXHIBITION_TERMS, pr_text))
    out += [n for n in EXECUTIVE_NAMES if n in text and n in pr_text]
    out += sorted(award_labels)
    ex_sigs, pr_sigs = period_signatures(title), pr['_sigs']
    if ex_sigs and pr_sigs and ex_sigs == pr_sigs:
        for kind, vals in sorted(ex_sigs.items()):
            out += [(f'{v}月' if kind == 'month' else v.upper()) for v in sorted(vals)]
    pr_nums = _numbers(pr_text)
    if any(abs(x - y) <= 0.03 * max(abs(x), abs(y), 1e-9) and u == v for x, u in _numbers(text) for y, v in pr_nums):
        out.append('相同財務數字')
    return list(dict.fromkeys(out))


def day_phrase(gap) -> str:
    if gap is None:
        return '日期不明'
    return '同日' if gap == 0 else f'前後 {abs(gap)} 天'


def _company_mentioned(title) -> bool:
    text = norm_text(title)
    return mentions_company(title) or any(n in text for n in EXECUTIVE_NAMES)


def high_confidence_match(title, ex_day, ex_sigs, prs):
    """
    高信心自動配對（可解釋）：必須同時符合
      ① 曝光標題明確提到創見／Transcend／創見管理層
      ② 曝光日期與新聞稿發布日同日或前後 1 天（沒有日精度的日期不行）
      ③ 不是同業主導、不是股價評論、不是混合多個事件的文章
      ④ 期間（月份／季度）相容；曝光標題的規格 token（型號、容量、速度）都出現在新聞稿裡（不忽略任何規格差異）
      ⑤ 至少 2 個具辨識力的錨點（規格、產品名、展覽、管理層、獎項、月份／季度、財務數字）
      ⑥ 候選唯一，且最佳候選的錨點數比第二名至少多 1
    回傳 (結果 dict 或 None, 未通過原因的中文說明 或 None)。
    """
    if ex_day is None:
        return None, '曝光日期不明，無法做日期配對'
    if not _company_mentioned(title):
        return None, '標題沒有明確提到創見'
    if peer_led(title):
        return None, '同業公司在標題前方'
    if is_mixed_article(title):
        return None, '同時包含股價與多個事件內容'
    ex_strong = strong_tokens(alnum_tokens(title))
    ranked, why_not = [], None
    for p in prs:
        gap = _days_between(ex_day, p['_date'])
        if gap is None or abs(gap) > HC_MAX_GAP_DAYS:
            continue
        if not compatible(p, ex_sigs, title):
            why_not = why_not or '月份或季度與新聞稿不同'
            continue
        union = set()
        for tokens in p['_sets']:
            union |= strong_tokens(tokens)
        if not ex_strong <= union:
            why_not = why_not or '規格（型號、容量或速度）與新聞稿不同'
            continue
        found = anchors_between(p, title)
        if len(found) >= HC_MIN_ANCHORS:
            ranked.append((len(found), found, gap, p))
        else:
            why_not = why_not or f'只有 {len(found)} 個明確關鍵字（需要至少 {HC_MIN_ANCHORS} 個）'
    if not ranked:
        return None, why_not or '前後 1 天內沒有符合的新聞稿'
    ranked.sort(key=lambda r: (-r[0], abs(r[2]), r[3]['id']))
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < HC_MARGIN:
        return None, '有多篇新聞稿同樣吻合，無法唯一判定'
    count, found, gap, chosen = ranked[0]
    confidence = round(min(0.95, 0.82 + 0.03 * (count - 2)), 2)
    why = f"{day_phrase(gap)}＋創見＋{'＋'.join(found[:5])}"
    return _result(STATUS_AUTO, 'high_confidence_anchors', confidence, chosen, why=why), None


def shared_terms(pr, title, limit=5) -> list:
    """一般自動配對的理由用：曝光標題與新聞稿共有的關鍵字（取前幾個）。"""
    found = anchors_between(pr, title)
    if found:
        return found[:limit]
    ex_tokens, shared = title_tokens(title), []
    for tokens in pr['_sets']:
        shared += sorted(tokens & ex_tokens, key=lambda t: (-len(t), t))
    return list(dict.fromkeys(shared))[:limit]


REASON_TEXT = {
    'peer_led': '同業公司在標題前方，屬產業或競品報導，不當作創見新聞稿曝光',
    'ambiguous_url': '有多篇新聞稿使用相同連結，無法唯一判定',
    'ambiguous_title': '有多篇新聞稿標題相同，日期也無法區分',
    'ambiguous_date_keyword': '有多篇新聞稿同樣吻合，無法唯一判定',
    'ambiguous_specificity': '稿單中有多篇更具體的新聞稿，無法唯一判定',
    'ambiguous_similarity': '有多篇新聞稿相似度相近，無法唯一判定',
}
UNMATCHED_DEFAULT_TEXT = '標題、日期與任何新聞稿的關鍵字都對不上（多半是一般報導）'


def _result(status, method=None, confidence=None, pr=None, suggestion=None, reason=None, why=None):
    return {
        'matchStatus': status,
        'matchMethod': method,
        'matchConfidence': confidence,
        'pressReleaseId': pr['id'] if pr and status in (STATUS_AUTO, STATUS_CONFIRMED) else None,
        'pressReleaseTitle': pr['_display'] if pr and status in (STATUS_AUTO, STATUS_CONFIRMED) else None,
        'suggestedPressReleaseId': suggestion['id'] if suggestion else None,
        'suggestedPressReleaseTitle': suggestion['_display'] if suggestion else None,
        'matchReason': why or (REASON_TEXT.get(reason, UNMATCHED_DEFAULT_TEXT) if status == STATUS_UNMATCHED else None),
        'reason': reason,
    }


def _days_between(ex_day: date | None, pr_day: date | None):
    if ex_day is None or pr_day is None:
        return None
    return (ex_day - pr_day).days


def match_exposure(exposure: dict, prs: list[dict]) -> dict:
    """
    exposure：{'title','link','day'(date|None),'campaignId'}；prs：prepare_press_release 的結果（只含可比對者：
    非取消）。回傳 matchStatus／matchMethod／matchConfidence／pressReleaseId… 的 dict。
    """
    title = exposure.get('title') or ''
    ex_norm = normalize_title(title)
    ex_day = exposure.get('day')
    ex_tokens = title_tokens(title)
    ex_strong = strong_tokens(ex_tokens)
    ex_sigs = period_signatures(title)

    # 1. 明確新聞稿 ID
    cid = norm_text(exposure.get('campaignId'))
    if cid:
        hits = [p for p in prs if p.get('explicitPressReleaseId') and norm_text(p['explicitPressReleaseId']) == cid]
        if len(hits) == 1:
            return _result(STATUS_AUTO, 'explicit_id', 1.0, hits[0], why='新聞稿編號相同')

    # 2. 官方連結完全相同
    url = normalize_url(exposure.get('link'))
    if url:
        hits = [p for p in prs if p['_url'] and p['_url'] == url]
        if len(hits) == 1:
            return _result(STATUS_AUTO, 'official_url', 0.99, hits[0], why='官方連結相同')
        if len(hits) > 1:
            return _result(STATUS_UNMATCHED, reason='ambiguous_url')

    # 3. 正規化標題完全相同（重複型標題要靠日期區分）
    if ex_norm:
        hits = [p for p in prs if ex_norm in p['_titles']]
        if len(hits) > 1:
            hits = [p for p in hits if p['_date'] is not None and
                    -WINDOW_BEFORE_DAYS <= (_days_between(ex_day, p['_date']) if ex_day else 10 ** 6) <= EXACT_TITLE_AFTER_DAYS]
            if len(hits) > 1:
                hits.sort(key=lambda p: abs(_days_between(ex_day, p['_date'])))
                first, second = hits[0], hits[1]
                if abs(_days_between(ex_day, first['_date'])) == abs(_days_between(ex_day, second['_date'])):
                    return _result(STATUS_UNMATCHED, reason='ambiguous_title')
                hits = [first]
        if len(hits) == 1:
            return _result(STATUS_AUTO, 'exact_title', 0.95, hits[0], why='標題與新聞稿完全相同')

    # 4. 日期（日精度）＋關鍵字（同業在前的報導不算新聞稿轉載）
    led = peer_led(title)
    mixed_stock = stock_commentary(title) and is_mixed_article(title)       # 股價評論混合營運／展覽：不自動配對
    if ex_day is not None and ex_tokens and not led and not mixed_stock:
        scored = []
        for p in prs:
            gap = _days_between(ex_day, p['_date'])
            if gap is None or not (-WINDOW_BEFORE_DAYS <= gap <= WINDOW_AFTER_DAYS):
                continue
            if not compatible(p, ex_sigs, title):
                continue
            best_set = None
            for tokens in p['_sets']:
                strong = strong_tokens(tokens)
                if not strong <= ex_strong:
                    continue
                if len(tokens) < 2 and not p['_sigs'] and not strong and not p['_generic_rev']:
                    continue
                matched = len(tokens & ex_tokens)
                coverage = matched / len(tokens) if tokens else 0
                if coverage >= COVERAGE_MIN and (best_set is None or (coverage, matched) > best_set):
                    best_set = (coverage, matched)
            if best_set:
                scored.append((best_set[0], best_set[1], p))
        if scored:
            scored.sort(key=lambda s: (-s[0], -s[1]))
            best = scored[0]
            tie = len(scored) > 1 and (scored[1][0], scored[1][1]) == (best[0], best[1])
            if tie:
                return _result(STATUS_UNMATCHED, reason='ambiguous_date_keyword')
            chosen = best[2]
            # 稿單裡若有「更具體」的另一篇（標題包含這篇的全部關鍵字，且關鍵字也都出現在曝光標題），
            # 就不能把曝光直接算給比較籠統的這篇（ECM vs ECM with Housing）
            more_specific = [
                p for p in prs
                if p['id'] != chosen['id'] and chosen['_tokens'] < p['_tokens'] and p['_tokens'] <= ex_tokens
                and compatible(p, ex_sigs, title) and p['_strong'] <= ex_strong]
            if more_specific:
                if len(more_specific) == 1:
                    return _result(STATUS_SUGGESTED, 'more_specific_candidate',
                                   round(best[0] * 0.8, 2), suggestion=more_specific[0],
                                   why=f"稿單另有更具體的新聞稿「{more_specific[0]['_display'][:30]}」，需人工確認")
                return _result(STATUS_UNMATCHED, reason='ambiguous_specificity')
            terms = shared_terms(chosen, title)
            why = f"{day_phrase(_days_between(ex_day, chosen['_date']))}＋" + ('＋'.join(terms) if terms else '標題關鍵字吻合')
            return _result(STATUS_AUTO, 'date_keyword', round(0.7 + 0.2 * best[0], 2), chosen, why=why)

    # 4b. 高信心自動配對（可解釋規則；看的是具辨識力的錨點，不是調低相似度門檻）
    hc, hc_why_not = high_confidence_match(title, ex_day, ex_sigs, prs)
    if hc is not None:
        return hc

    # 5. 標題相似度 → 只建議
    cand = []
    if led:
        return _result(STATUS_UNMATCHED, reason='peer_led')
    for p in prs:
        if not compatible(p, ex_sigs, title):
            continue
        gap = _days_between(ex_day, p['_date'])
        if gap is not None and not (-WINDOW_BEFORE_DAYS <= gap <= SUGGEST_MAX_DAYS):
            continue
        sim = 0.0
        for tokens in p['_sets']:
            if not strong_tokens(tokens) <= ex_strong:
                continue
            value = dice(tokens, ex_tokens)
            # 關鍵字夠多的一組（新聞稿標題或其中一個子句）被曝光標題涵蓋六成以上 → 可建議
            if len(tokens) >= 5 and len(tokens & ex_tokens) / len(tokens) >= 0.6:
                value = max(value, 0.6)
            # 稿單標題的關鍵字全部出現在曝光標題裡（但曝光標題多了別的字）→ 也算可建議，分數固定偏低
            if len(tokens) >= 2 and tokens <= ex_tokens:
                value = max(value, 0.55)
            # 只有一個關鍵字的短標題（例如 COMPUTEX）：關鍵字夠長、曝光落在發稿日附近才建議
            if (len(tokens) == 1 and gap is not None and 0 <= gap <= WINDOW_AFTER_DAYS * 2
                    and tokens <= ex_tokens and len(next(iter(tokens))) >= 5):
                value = max(value, SIMILARITY_MIN)
            sim = max(sim, value)
        if sim >= SIMILARITY_MIN:
            cand.append((sim, p))
    if cand:
        cand.sort(key=lambda c: -c[0])
        if len(cand) == 1 or cand[0][0] - cand[1][0] >= SIMILARITY_GAP:
            sim_pct = round(cand[0][0] * 100)
            why = f'標題與新聞稿相似度約 {sim_pct}%' + (f'；未自動配對：{hc_why_not}' if hc_why_not else '；未自動配對：明確關鍵字不足')
            return _result(STATUS_SUGGESTED, 'title_similarity', round(cand[0][0], 2), suggestion=cand[0][1], why=why)
        return _result(STATUS_UNMATCHED, reason='ambiguous_similarity')

    return _result(STATUS_UNMATCHED)
