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
from datetime import date
from urllib.parse import urlsplit

STATUS_CONFIRMED = 'confirmed'
STATUS_AUTO = 'auto_matched'
STATUS_SUGGESTED = 'suggested'
STATUS_UNMATCHED = 'unmatched'

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
    """兩邊都要有相同的期間；一邊有、另一邊沒有，也視為不相容（保守）。"""
    for kind in set(a) | set(b):
        if kind not in a or kind not in b:
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


def mentions_company(title) -> bool:
    text = norm_text(title)
    return any(k in text for k in ('創見', 'transcend', '2451'))


def compatible(p, ex_sigs, title='') -> bool:
    """新聞稿與曝光標題的期間（月份／季度）是否相容。"""
    if (p.get('_generic_rev') or 'month' in p['_sigs']) and not mentions_company(title):
        return False          # 月營收這類通用標題：曝光標題一定要提到創見，避免把競品的營收報導算進來
    if p.get('_generic_rev'):
        months = ex_sigs.get('month')
        return (p.get('_implied_month') is not None and months == frozenset({str(p['_implied_month'])})
                and 'quarter' not in ex_sigs)
    return periods_compatible(p['_sigs'], ex_sigs)


def _result(status, method=None, confidence=None, pr=None, suggestion=None, reason=None):
    return {
        'matchStatus': status,
        'matchMethod': method,
        'matchConfidence': confidence,
        'pressReleaseId': pr['id'] if pr and status in (STATUS_AUTO, STATUS_CONFIRMED) else None,
        'pressReleaseTitle': pr['_display'] if pr and status in (STATUS_AUTO, STATUS_CONFIRMED) else None,
        'suggestedPressReleaseId': suggestion['id'] if suggestion else None,
        'suggestedPressReleaseTitle': suggestion['_display'] if suggestion else None,
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
            return _result(STATUS_AUTO, 'explicit_id', 1.0, hits[0])

    # 2. 官方連結完全相同
    url = normalize_url(exposure.get('link'))
    if url:
        hits = [p for p in prs if p['_url'] and p['_url'] == url]
        if len(hits) == 1:
            return _result(STATUS_AUTO, 'official_url', 0.99, hits[0])
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
            return _result(STATUS_AUTO, 'exact_title', 0.95, hits[0])

    # 4. 日期（日精度）＋關鍵字
    if ex_day is not None and ex_tokens:
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
                                   round(best[0] * 0.8, 2), suggestion=more_specific[0])
                return _result(STATUS_UNMATCHED, reason='ambiguous_specificity')
            return _result(STATUS_AUTO, 'date_keyword', round(0.7 + 0.2 * best[0], 2), chosen)

    # 5. 標題相似度 → 只建議
    cand = []
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
            return _result(STATUS_SUGGESTED, 'title_similarity', round(cand[0][0], 2), suggestion=cand[0][1])
        return _result(STATUS_UNMATCHED, reason='ambiguous_similarity')

    return _result(STATUS_UNMATCHED)
