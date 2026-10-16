"""
新聞話題聚類（事件中心）：把不同媒體對「同一事件」的報導聚成一個話題（news_topics）。

第一版完全是透明規則，沒有任何付費 AI／外部服務：
  特徵   標題正規化、公司、產品型號／容量／速度、事件類型、月份／季度、財務數字、展覽名稱、關鍵詞 n-gram
  候選   先用倒排索引（公司＋事件、型號、展覽名稱、期間…）找候選話題，不做全部新聞兩兩比較
  分數   標題相似度（排除通用詞）＋公司重疊＋事件類型＋財務數字＋期間＋時間；要有「錨點」才算（通用詞不能單獨造成合併）
  防誤合併（硬性不合併）
         時間窗口（一般 72 小時；價格／供需這類持續性議題 7 天；營收／財報要同月份／季度）、
         月份或季度不同、公司主體不同、產品型號／容量／速度不同、展覽名稱不同、財務數字明顯衝突
  低信心保持獨立：寧可多幾個話題，也不為了減少話題數量而強制合併

穩定性：topicId＝sha1(最早那篇文章 id)；新文章加入既有話題不改 id；已分組的文章不重算（冪等）；
不合併既有話題（避免 id 搬家）；失敗不清除既有話題；每次只處理上限內的新增／變更文章。
所有計算都是純函式；Firestore 讀寫在 topic_cluster_job.py。
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import press_release_match as pm

ALGORITHM_VERSION = 'topic-v2'      # v2：嚴格判定「涉及創見」（只看標題實際提到的公司，不看新聞來源分類）；版本不同的既有話題會被重新計算一次

WINDOW_DEFAULT = timedelta(hours=72)
WINDOW_PERSISTENT = timedelta(days=7)
WINDOW_PERIOD = timedelta(days=7)
MERGE_THRESHOLD = 0.5
MERGE_THRESHOLD_TITLE_ONLY = 0.4     # 只靠標題極度相似時的門檻（沒有公司／型號／展覽錨點）
TITLE_ONLY_SIMILARITY = 0.75
MAX_MEMBERS = 120               # 單一話題成員上限（超過就另開話題）
MAX_CANDIDATES = 60
BLOCKED_MEMBER_RATIO = 0.34

COMPANIES = {
    '創見': ['創見', 'transcend', '2451'], '威剛': ['威剛', 'adata', '3260'], '宜鼎': ['宜鼎', 'innodisk', '5289'],
    '十銓': ['十銓', 'teamgroup', '4967'], '宇瞻': ['宇瞻', 'apacer', '8271'], '廣穎': ['廣穎', 'silicon power', '4973'],
    '群聯': ['群聯', 'phison', '8299'], '南亞科': ['南亞科', 'nanya', '2408'], '華邦電': ['華邦電', 'winbond', '2344'],
    '旺宏': ['旺宏', 'macronix', '2337'], '美光': ['美光', 'micron'], '三星': ['三星', 'samsung'],
    'SK海力士': ['海力士', 'hynix'], '晶豪科': ['晶豪科'], '力積電': ['力積電', 'psmc'], '鎧俠': ['鎧俠', 'kioxia'],
    '閃迪': ['sandisk', '晟碟', '閃迪'], '慧榮': ['慧榮', 'silicon motion'], '台積電': ['台積電', 'tsmc'],
    '輝達': ['輝達', 'nvidia'], '研華': ['研華', 'advantech'], '金士頓': ['金士頓', 'kingston'],
    '長鑫': ['長鑫', 'cxmt'], '長江存儲': ['長江存儲', 'ymtc'],
}
TRANSCEND = '創見'
COMPETITORS = {'威剛', '宜鼎', '十銓', '宇瞻', '廣穎'}
UPSTREAM_COMPANIES = {'群聯', '南亞科', '華邦電', '旺宏', '美光', '三星', 'SK海力士', '晶豪科', '力積電', '鎧俠', '閃迪',
                      '慧榮', '長鑫', '長江存儲'}

EVENT_NAMES = {
    'computex': ['computex'], '自動化展': ['自動化展', '自動化工業大展', '自動化工業展'],
    '電子展': ['電子展', '電子產業科技展', '電子產業展'], '能源週': ['能源週', '能源周'],
    '智慧製造展': ['智慧製造展', 'touch taiwan'], 'embedded world': ['embedded world'], 'ise': ['ise歐洲', '歐洲整合系統展'],
    'ces': ['ces 20', 'ces2'], 'mwc': ['mwc'],
}

# 事件類型（依序判斷，先符合者為準）
EVENT_PATTERNS = [
    ('revenue', r'營收|revenue'),
    ('earnings', r'財報|eps|每股盈餘|每股純益|每股賺|每股獲利|獲利|季報|淨利|毛利率'),
    ('risk', r'罰鍰|裁罰|訴訟|違反|召回|火災|停工|罷工|地震|斷鏈|危機|詐|調查|違約'),
    ('exhibition', r'參展|展出|展會|展場|大展|博覽|computex|能源週|電子展|自動化展|製造展|embedded world'),
    ('supply', r'缺貨|供不應求|供需|產能|擴產|擴廠|外包|委外|轉單|庫存'),
    ('price', r'漲價|跌價|報價|價格|asp|合約價|現貨價'),
    ('product', r'推出|發表|新品|登場|亮相|模組|解決方案|量產|發布'),
    ('stock', r'漲停|跌停|股價|盤中|買超|賣超|注意股|處置股|目標價|大漲|大跌|急拉|急殺|權證'),
    ('corporate', r'董事長|董座|總經理|法說|股東會|增資|可轉債|股利|庫藏|公告'),
]
PERSISTENT_TYPES = {'price', 'supply'}
FINANCE_TYPES = {'revenue', 'earnings'}

GENERIC_WORDS = {
    'ai', 'ssd', 'dram', 'nand', 'flash', 'hbm', 'pc', 'edge', 'iot', 'cloud', 'server', 'memory', 'storage', 'data',
    'market', 'tw', 'news', 'the', 'and', 'for', 'with', 'new', 'of', 'in', 'to', 'a', 'an',
}
GENERIC_BIGRAMS = {
    '記憶', '憶體', '體族', '族群', '半導', '導體', '產業', '市場', '價格', '需求', '缺貨', '漲價', '報價', '供應', '供需',
    '台廠', '台股', '股價', '大盤', '營收', '財報', '獲利', '應用', '產品', '市場', '全球', '市場', '成長', '創高', '新高',
    '年增', '月增', '季增', '預估', '預期', '看好', '受惠', '商機', '布局', '搶攻', '推出', '發表', '亮相', '公司', '集團',
}
KEY_MEDIA = ('電子時報', 'digitimes', '工商時報', '經濟日報', '中央社', '鉅亨', '財訊', '聯合報', '自由時報', '時報資訊', 'cna')
NEG_WORDS = ('虧損', '下滑', '召回', '訴訟', '下跌', '危機', '裁員', '罰', '違反', '停工', '罷工', '斷鏈', '衰退', '跌停')

_UNIT_NUMBER = re.compile(r'(\d+(?:\.\d+)?)\s*(兆|億|萬|千|元|%|％|倍|張|檔|點|月|日|季|年|層|nm|g|gb|tb|mb|mhz)', re.I)
_ALNUM = re.compile(r'[a-z0-9]+(?:[.+][a-z0-9]+)*')
_CJK_RUN = re.compile(r'[一-鿿]+')
_YEAR = re.compile(r'^(19|20)\d\d$')
_BRACKETS = re.compile(r'《[^》]*》|【[^】]*】|\[[^\]]*\]')
_PREFIX_TAGS = re.compile(r'^(個股|營收|財報|焦點股|熱門股|營收速報|營收特報|專訪|公告|盤中速報|即時新聞|產業分析|台股焦點)\s*[：:\-－／/]\s*')
_DATE_LIKE = re.compile(r'\d{1,2}\s*/\s*\d{1,2}')
_TICKER = re.compile(r'[(（]\s*\d{3,5}\s*[)）]')


def _norm(text) -> str:
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(text or ''))).strip().lower()


def _strip_title(title: str) -> str:
    text = _BRACKETS.sub(' ', _norm(title))
    for _ in range(2):
        text = _PREFIX_TAGS.sub('', text.strip())
    return text.strip()


def to_dt(value):
    if value is None:
        return None
    if hasattr(value, 'to_datetime'):
        value = value.to_datetime()
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


# 同名但不是創見資訊的組織（創見文化、創見出版…）：比對前先遮掉，避免誤判成創見
_SAME_NAME_ORG = re.compile(r'創見(?:文化|出版|國際文教|文教|教育|藝術|建設)')
# 股票代號 2451 只有「獨立出現」才算：前後不能緊鄰數字、小數點、千分位逗號，後面也不能接金額／數量單位
_TICKER_2451 = re.compile(r'(?<![a-z0-9.,])2451(?![a-z0-9.,]|\s*(?:億|萬|千|元|%|點|張|檔|件|人|年|月|日|季|倍|層|gb|tb|mb|mhz|nm))', re.I)


def find_companies(text: str) -> set:
    found = set()
    masked = _SAME_NAME_ORG.sub(' ', text)
    for name, aliases in COMPANIES.items():
        for alias in aliases:
            if alias == '2451':
                if _TICKER_2451.search(masked):
                    found.add(name)
                    break
            elif alias.isascii():
                if re.search(r'(?<![a-z0-9])' + re.escape(alias) + r'(?![a-z0-9])', text):
                    found.add(name)
                    break
            elif alias in masked:
                found.add(name)
                break
    return found


def find_event_names(text: str) -> set:
    return {name for name, aliases in EVENT_NAMES.items() if any(a in text for a in aliases)}


def detect_event_type(text: str) -> str:
    for kind, pattern in EVENT_PATTERNS:
        if re.search(pattern, text):
            return kind
    return 'other'


def numeric_tokens(text: str) -> list[tuple[float, str]]:
    """財務數字：數值＋單位（億／萬／元／%／倍…）。只用來比對財務事件，不當產品型號。"""
    out = []
    for m in _UNIT_NUMBER.finditer(text):
        try:
            out.append((float(m.group(1)), m.group(2).lower().replace('％', '%')))
        except ValueError:
            continue
    return out


def product_tokens(text: str) -> set:
    """產品型號／容量／速度：含字母＋數字的字串（ddr5、usd710s、64gb），以及去掉財務數字、日期、年份、股票代號後剩下的 3～5 位數（7200、6400）。"""
    cleaned = _UNIT_NUMBER.sub(' ', text)
    cleaned = _DATE_LIKE.sub(' ', cleaned)
    cleaned = _TICKER.sub(' ', cleaned)
    for aliases in COMPANIES.values():
        for alias in aliases:
            if alias.isdigit():
                cleaned = cleaned.replace(alias, ' ')
    tokens = set()
    for tok in _ALNUM.findall(cleaned):
        if _YEAR.match(tok) or re.fullmatch(r'q[1-4]', tok):
            continue
        if any(c.isdigit() for c in tok) and (any(c.isalpha() for c in tok) or 3 <= len(tok) <= 5):
            tokens.add(tok)
    # 帶單位的容量／速度也算型號的一部分（64GB、218層）
    for m in re.finditer(r'(\d+)\s*(gb|tb|mb|mhz|層|nm)', text):
        tokens.add(m.group(1) + m.group(2))
    return tokens


def title_tokens(text: str, drop: set) -> set:
    tokens = {t for t in _ALNUM.findall(_UNIT_NUMBER.sub(' ', text)) if t not in GENERIC_WORDS and not t.isdigit() and t not in drop and len(t) >= 2}
    for run in _CJK_RUN.findall(text):
        for i in range(len(run) - 1):
            gram = run[i:i + 2]
            if gram not in GENERIC_BIGRAMS and gram not in drop:
                tokens.add(gram)
    return tokens


# 論壇貼文、站內索引頁、個股資料頁不是新聞事件：不進話題
_NOT_NEWS = re.compile(r'股市爆料同學會|相關專利權資料|相關電子產業資訊|專題周報|日報$')


def is_clusterable(article: dict) -> bool:
    title = str(article.get('title') or '')
    return bool(title.strip()) and not _NOT_NEWS.search(title) and article.get('cat') != 'community'


def article_id_of(article) -> str:
    return str(article.get('id') or '')


def build_features(article: dict) -> dict:
    """文章 → 聚類特徵。只用標題（加 cat／媒體／時間），結果是確定性的。"""
    title = str(article.get('title') or '')
    text = _strip_title(title)
    companies = find_companies(text)
    alias_tokens = {a for name in companies for a in COMPANIES[name]}
    alias_bigrams = {a[i:i + 2] for a in alias_tokens if not a.isascii() for i in range(len(a) - 1)}
    products = product_tokens(text)
    sigs = pm.period_signatures(text)
    return {
        'id': article_id_of(article),
        'title': title,
        'text': text,
        'time': to_dt(article.get('pubDate')),
        'media': str(article.get('mediaName') or article.get('sourceName') or ''),
        'sentiment': article.get('sentiment') if article.get('sentiment') in ('positive', 'neutral', 'negative') else 'neutral',
        'cat': str(article.get('cat') or ''),
        'link': str(article.get('link') or ''),
        'companies': companies,
        'event_type': detect_event_type(text),
        'event_names': find_event_names(text),
        'products': products,
        'periods': sigs,
        'numbers': numeric_tokens(text),
        'tokens': title_tokens(text, alias_tokens | alias_bigrams | products),
    }


def _dice(a: set, b: set) -> float:
    return 2 * len(a & b) / (len(a) + len(b)) if a and b else 0.0


def _window(fa: dict, fb: dict) -> timedelta:
    if fa['event_type'] in FINANCE_TYPES and fb['event_type'] in FINANCE_TYPES and fa['periods'] and fa['periods'] == fb['periods']:
        return WINDOW_PERIOD
    if fa['event_type'] in PERSISTENT_TYPES and fb['event_type'] in PERSISTENT_TYPES:
        return WINDOW_PERSISTENT
    return WINDOW_DEFAULT


def _numbers_conflict(fa: dict, fb: dict, similarity: float) -> bool:
    """營收／財報：兩邊都有「億／元」金額卻沒有任何一組相近（±3%），而且標題不夠像 → 視為不同事件。"""
    if fa['event_type'] not in FINANCE_TYPES or fb['event_type'] not in FINANCE_TYPES:
        return False
    a = [v for v, u in fa['numbers'] if u in ('億', '兆', '萬', '元')]
    b = [v for v, u in fb['numbers'] if u in ('億', '兆', '萬', '元')]
    if not a or not b:
        return False
    close = any(abs(x - y) <= 0.03 * max(abs(x), abs(y), 1e-9) for x in a for y in b)
    return not close       # 財務事件的金額對不上就不合併（標題相似度會因為數字被拿掉而偏高，不能當理由）


def blocked_reason(fa: dict, fb: dict, similarity: float | None = None):
    """硬性不合併的原因；可以合併回傳 None。"""
    ta, tb = fa['time'], fb['time']
    if ta is None or tb is None:
        return 'no_time'
    if abs(ta - tb) > _window(fa, fb):
        return 'time_window'
    ma, mb = fa['periods'], fb['periods']
    for kind in set(ma) | set(mb):
        if kind in ma and kind in mb:
            if kind == 'quarter':
                qa = {s[-2:] for s in ma[kind]}
                qb = {s[-2:] for s in mb[kind]}
                if qa != qb:
                    return 'quarter_mismatch'
            elif ma[kind] != mb[kind]:
                return 'month_mismatch'
    if fa['event_type'] in FINANCE_TYPES and fb['event_type'] in FINANCE_TYPES and set(ma) != set(mb):
        return 'finance_period_missing'     # 一邊有月份／季度、另一邊沒有：不確定是同一期，保持獨立
    if fa['companies'] and fb['companies'] and not (fa['companies'] & fb['companies']):
        return 'company_mismatch'
    pa, pb = fa['products'], fb['products']
    if pa and pb and not (pa <= pb or pb <= pa):
        return 'product_mismatch'
    if fa['event_names'] and fb['event_names'] and not (fa['event_names'] & fb['event_names']):
        return 'event_name_mismatch'
    if _numbers_conflict(fa, fb, similarity if similarity is not None else _dice(fa['tokens'], fb['tokens'])):
        return 'financial_number_conflict'
    return None


def pair_score(fa: dict, fb: dict):
    """(分數, 原因清單) 或 (0, [block_reason])。分數 >= MERGE_THRESHOLD 且有錨點才算同一事件。"""
    sim = _dice(fa['tokens'], fb['tokens'])
    block = blocked_reason(fa, fb, sim)
    if block:
        return 0.0, [block]
    reasons = []
    score = 0.55 * sim
    shared_companies = fa['companies'] & fb['companies']
    if shared_companies:
        score += 0.15 * len(shared_companies) / len(fa['companies'] | fb['companies'])
        reasons.append('shared_company')
    anchors = bool(shared_companies)
    if fa['event_type'] == fb['event_type'] and fa['event_type'] != 'other':
        score += 0.1
        reasons.append('same_event_type')
    shared_products = fa['products'] & fb['products']
    if shared_products:
        score += 0.12
        anchors = True
        reasons.append('shared_product')
    if fa['event_names'] & fb['event_names']:
        score += 0.12
        anchors = True
        reasons.append('shared_event_name')
    if fa['periods'] and fa['periods'] == fb['periods']:
        score += 0.06
        reasons.append('same_period')
    na = [v for v, u in fa['numbers'] if u in ('億', '元', '%', '倍')]
    nb = [v for v, u in fb['numbers'] if u in ('億', '元', '%', '倍')]
    if any(abs(x - y) <= 0.03 * max(abs(x), abs(y), 1e-9) for x in na for y in nb):
        score += 0.08
        reasons.append('shared_number')
    gap = abs(fa['time'] - fb['time'])
    score += 0.05 * max(0.0, 1 - gap / _window(fa, fb))
    # 錨點：共同公司／型號／展覽；沒有這些時，標題（排除通用詞後）要非常像（>= TITLE_ONLY_SIMILARITY）才算。
    # 只有通用詞重疊、或只是同一天發布，都不算錨點。
    title_only = False
    if not anchors and sim >= TITLE_ONLY_SIMILARITY:
        anchors = title_only = True
        reasons.append('title_near_identical')
    if not anchors or sim < 0.2:
        return 0.0, ['no_anchor']
    score = round(min(score, 1.0), 3)
    if title_only and score < MERGE_THRESHOLD_TITLE_ONLY:
        return 0.0, ['no_anchor']
    return score, reasons


def blocking_keys(f: dict) -> set:
    keys = set()
    for c in f['companies']:
        keys.add(('co', c, f['event_type']))
        keys.add(('co', c))
    for p in f['products']:
        keys.add(('pd', p))
    for e in f['event_names']:
        keys.add(('ev', e))
    for kind, vals in f['periods'].items():
        for v in vals:
            keys.add(('per', kind, v, f['event_type']))
    for t in f['tokens']:
        if len(t) >= 3 or not t.isascii():
            keys.add(('tk', t))
    return keys


class Cluster:
    def __init__(self, cluster_id: str, members: list, existing: bool = False, doc: dict | None = None):
        self.id = cluster_id
        self.members = list(members)       # feature dicts
        self.existing = existing
        self.dirty = not existing
        self.doc = doc or {}
        self.scores = {}                   # 成員 id → 加入時的最佳分數
        self.methods = {}

    @property
    def member_ids(self):
        return {m['id'] for m in self.members}


def new_topic_id(seed_article_id: str) -> str:
    return 'tp_' + hashlib.sha1(('topic|' + seed_article_id).encode('utf-8')).hexdigest()[:20]


def assign_articles(articles: list[dict], clusters: list[Cluster]):
    """
    把新文章依序（pubDate, id）放進既有話題或新話題。回傳 (clusters, assignments)。
    assignments: {article_id: {'topicId', 'confidence', 'method', 'reasons'}}。
    已經是某個話題成員的文章不會重算。
    """
    by_key: dict = {}
    for cl in clusters:
        for m in cl.members:
            for k in blocking_keys(m):
                by_key.setdefault(k, set()).add(cl.id)
    by_id = {cl.id: cl for cl in clusters}
    assigned = {m['id'] for cl in clusters for m in cl.members}
    feats = sorted((build_features(a) for a in articles if is_clusterable(a)), key=lambda f: (f['time'] or datetime.max.replace(tzinfo=timezone.utc), f['id']))
    assignments = {}
    for f in feats:
        if not f['id'] or f['id'] in assigned or f['time'] is None:
            continue
        cand_ids = set()
        for k in blocking_keys(f):
            cand_ids |= by_key.get(k, set())
        cands = sorted((by_id[c] for c in cand_ids if len(by_id[c].members) < MAX_MEMBERS),
                       key=lambda c: min(abs(f['time'] - m['time']) for m in c.members if m['time']))[:MAX_CANDIDATES]
        best, best_score, best_reasons = None, 0.0, []
        for cl in cands:
            scored, blocked = [], 0
            for m in cl.members:
                s, why = pair_score(f, m)
                if s > 0:
                    scored.append((s, why))
                elif why and why[0] != 'no_anchor':
                    blocked += 1
            if not scored or blocked / len(cl.members) > BLOCKED_MEMBER_RATIO:
                continue
            s, why = max(scored, key=lambda x: x[0])
            if s >= (MERGE_THRESHOLD_TITLE_ONLY if 'title_near_identical' in why else MERGE_THRESHOLD) and s > best_score:
                best, best_score, best_reasons = cl, s, why
        if best is not None:
            best.members.append(f)
            best.dirty = True
            best.scores[f['id']] = best_score
            best.methods[f['id']] = 'rule'
            target = best
            confidence, method, reasons = best_score, 'rule', best_reasons
        else:
            target = Cluster(new_topic_id(f['id']), [f])
            clusters.append(target)
            by_id[target.id] = target
            confidence, method, reasons = 1.0, 'seed', ['new_topic']
        for k in blocking_keys(f):
            by_key.setdefault(k, set()).add(target.id)
        assigned.add(f['id'])
        assignments[f['id']] = {'topicId': target.id, 'confidence': round(confidence, 3), 'method': method, 'reasons': reasons}
    return clusters, assignments


# ── 話題文件（news_topics）─────────────────────────────────
def _key_media_count(media_names) -> int:
    return sum(1 for m in media_names if any(k in _norm(m) for k in KEY_MEDIA))


def sentiment_label(pos: int, neu: int, neg: int) -> tuple[str, float]:
    total = pos + neu + neg
    score = (pos - neg) / total if total else 0.0
    label = 'positive' if score > 0.3 else 'negative' if score < -0.3 else 'neutral'
    return label, round(score, 2)


def compute_importance(stats: dict) -> tuple[int, list[str]]:
    """可解釋的重要性（0–100）與「重要原因」。每一項都寫出加了幾分。"""
    score, reasons = 0, []

    def add(points, text):
        nonlocal score
        if points > 0:
            score += points
            reasons.append(f'{text} +{points}')
    add(min(30, 5 * stats['mediaCount']), f"{stats['mediaCount']} 家媒體報導")
    add(min(15, 2 * stats['articleCount']), f"{stats['articleCount']} 篇報導")
    add(min(10, 2 * stats['keyMediaCount']), f"{stats['keyMediaCount']} 家重點媒體")
    if TRANSCEND in stats['companies']:
        add(15, '提及創見')
    if COMPETITORS & set(stats['companies']):
        add(5, '涉及競品')
    kind_points = {'revenue': 8, 'earnings': 8, 'risk': 12, 'supply': 8, 'price': 6}
    if stats['eventType'] in kind_points:
        label = {'revenue': '營收', 'earnings': '財報', 'risk': '風險', 'supply': '供應鏈', 'price': '價格'}[stats['eventType']]
        add(kind_points[stats['eventType']], f'{label}事件')
    if stats['articleCount'] and stats['negativeCount'] / stats['articleCount'] >= 0.5:
        add(8, '負面報導占多數')
    if stats['count24h'] >= 3 and stats['count24h'] > stats['countPrev24h']:
        add(min(10, 2 * (stats['count24h'] - stats['countPrev24h'])), '24 小時內聲量上升')
    return min(100, score), reasons


def tags_for(companies, event_type, cats) -> list[str]:
    tags = []
    # 「涉及創見」只看標題實際提到的公司；新聞來源的 cat 分類（transcend）不可靠，不能單獨拿來判定
    if TRANSCEND in companies:
        tags.append('transcend')
    if COMPETITORS & set(companies) or 'competitor' in cats:
        tags.append('competitor')
    if UPSTREAM_COMPANIES & set(companies) or 'usMarket' in cats or 'twMarket' in cats or 'supplier' in cats:
        tags.append('upstream')
    if event_type in FINANCE_TYPES:
        tags.append('finance')
    if event_type in ('product', 'exhibition'):
        tags.append('product')
    if event_type in ('supply', 'price'):
        tags.append('supply')
    if event_type == 'risk':
        tags.append('risk')
    return tags


def _snapshot(f: dict) -> dict:
    return {'id': f['id'], 'title': f['title'], 'link': f['link'], 'mediaName': f['media'],
            'pubDate': f['time'], 'sentiment': f['sentiment'], 'cat': f['cat']}


def build_topic_doc(cluster: Cluster, now: datetime, previous: dict | None = None) -> dict:
    members = sorted(cluster.members, key=lambda m: (m['time'], m['id']))
    times = [m['time'] for m in members]
    media = sorted({m['media'] for m in members if m['media']})
    pos = sum(1 for m in members if m['sentiment'] == 'positive')
    neg = sum(1 for m in members if m['sentiment'] == 'negative')
    neu = len(members) - pos - neg
    counted = {}
    for m in members:
        for c in m['companies']:
            counted[c] = counted.get(c, 0) + 1
    companies = [c for c, _ in sorted(counted.items(), key=lambda kv: (-kv[1], kv[0]))]
    types = {}
    for m in members:
        types[m['event_type']] = types.get(m['event_type'], 0) + 1
    typed = {k: v for k, v in types.items() if k != 'other'}
    event_type = max(typed, key=lambda k: (typed[k], k)) if typed else 'other'
    products = sorted({p for m in members for p in m['products']})
    numerics = sorted({f'{v:g}{u}' for m in members for v, u in m['numbers'] if u in ('億', '元', '%', '倍')})[:12]
    # 代表標題：和其他標題平均最像的那篇；同分取最早
    def centrality(m):
        others = [o for o in members if o is not m]
        return (sum(_dice(m['tokens'], o['tokens']) for o in others) / len(others)) if others else 0
    title_member = max(members, key=lambda m: (round(centrality(m), 4), -m['time'].timestamp()))
    media_for_rep = sorted(members, key=lambda m: (not any(k in _norm(m['media']) for k in KEY_MEDIA), m['time']))
    rep_ids = [m['id'] for m in media_for_rep[:3]]
    cutoff24, cutoff48 = now - timedelta(hours=24), now - timedelta(hours=48)
    count24 = sum(1 for t in times if t >= cutoff24)
    prev24 = sum(1 for t in times if cutoff48 <= t < cutoff24)
    # 聲量變化率（%）：前一個 24 小時沒有報導時無法算比例，記 None（畫面顯示「新話題」）
    velocity = round((count24 - prev24) / prev24 * 100, 1) if prev24 else None
    stats = {
        'mediaCount': len(media), 'articleCount': len(members), 'keyMediaCount': _key_media_count(media),
        'companies': companies, 'eventType': event_type, 'negativeCount': neg, 'count24h': count24, 'countPrev24h': prev24,
    }
    importance, reasons = compute_importance(stats)
    label, score = sentiment_label(pos, neu, neg)
    cats = {m['cat'] for m in members}
    scores = list(cluster.scores.values())
    confidence = round(min(scores), 2) if scores else 1.0
    summary = (f"{len(members)} 篇報導、{len(media)} 家媒體，{times[0].astimezone(timezone(timedelta(hours=8))):%m/%d %H:%M} 起"
               f"{'，涉及 ' + '、'.join(companies[:4]) if companies else ''}。")
    doc = {
        'id': cluster.id,
        'title': title_member['title'],
        'normalizedTitle': title_member['text'],
        'summary': summary,
        'category': 'transcend' if TRANSCEND in companies else ('competitor' if COMPETITORS & set(companies) else 'industry'),
        'eventType': event_type,
        'tags': tags_for(companies, event_type, cats),
        'entities': companies,
        'companies': companies,
        'products': products[:12],
        'keywords': sorted({t for m in members for t in m['tokens']}, key=lambda t: (-sum(t in m['tokens'] for m in members), t))[:10],
        'numericTokens': numerics,
        'articleIds': [m['id'] for m in members],
        'representativeArticleIds': rep_ids,
        'articles': [_snapshot(m) for m in sorted(members, key=lambda m: (m['time'], m['id']), reverse=True)],
        'articleCount': len(members),
        'mediaCount': len(media),
        'mediaNames': media,
        'positiveCount': pos, 'neutralCount': neu, 'negativeCount': neg,
        'sentiment': label, 'sentimentScore': score,
        'importanceScore': importance, 'importanceReasons': reasons,
        'count24h': count24, 'countPrev24h': prev24, 'velocity24h': velocity,
        'firstPublishedAt': times[0], 'lastPublishedAt': times[-1],
        'algorithmVersion': ALGORITHM_VERSION,
        'status': 'active',
        'confidence': confidence,
        'needsReview': bool(confidence < 0.6 and len(members) > 1),
        'seedArticleId': (previous or {}).get('seedArticleId') or members[0]['id'],
    }
    return doc


COMPARE_KEYS = ('title', 'summary', 'category', 'eventType', 'tags', 'companies', 'products', 'articleIds', 'articleCount', 'mediaCount',
                'mediaNames', 'positiveCount', 'neutralCount', 'negativeCount', 'sentiment', 'importanceScore', 'importanceReasons',
                'count24h', 'countPrev24h', 'velocity24h', 'lastPublishedAt', 'firstPublishedAt', 'needsReview', 'algorithmVersion')


def doc_changed(old: dict | None, new: dict) -> bool:
    if not old:
        return True
    for k in COMPARE_KEYS:
        a, b = old.get(k), new.get(k)
        if hasattr(a, 'to_datetime'):
            a = a.to_datetime()
        if a != b:
            return True
    return False


def clusters_from_topics(topic_docs: list[dict]) -> list[Cluster]:
    """既有話題 → Cluster（成員用快照重建特徵）。"""
    out = []
    for doc in topic_docs:
        arts = doc.get('articles') or []
        members = [build_features(a) for a in arts if a.get('id')]
        members = [m for m in members if m['time'] is not None]
        if not members:
            continue
        cl = Cluster(doc['id'], members, existing=True, doc=doc)
        cl.dirty = False
        out.append(cl)
    return out


def refresh_velocity_only(cluster: Cluster, now: datetime) -> dict:
    return build_topic_doc(cluster, now, cluster.doc)
