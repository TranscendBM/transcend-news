"""零 API 預算情報工作流的共用規則層。

這個模組刻意不呼叫任何外部 AI 服務：Cloud Functions 可先用規則判斷
文章相關性與優先順序，再把值得分析的文章放進 ``ai_jobs``。公司電腦上的
本機 worker（tools/local_ai_worker.py）之後才使用 Ollama 產生摘要。
"""

import re


WORKFLOW_VERSION = 'local-ai-v1'
RULE_VERSION = 'rules-v1'
QUEUE_THRESHOLD = 20

# 與創見資訊同名、但實際上是其他公司的固定誤判詞。
EXCLUDED_ARTICLE_PHRASES = ('創見文化事業',)

COMPANIES = {
    # 不使用單獨的英文字 transcend：它也是常見動詞，容易誤判。
    '2451': {'name': '創見資訊', 'aliases': ('創見', 'transcend information')},
    '3260': {'name': '威剛科技', 'aliases': ('威剛', 'adata')},
    '4967': {'name': '十銓科技', 'aliases': ('十銓', 'teamgroup', 'team group')},
    '4973': {'name': '廣穎電通', 'aliases': ('廣穎', 'silicon power')},
    '5289': {'name': '宜鼎國際', 'aliases': ('宜鼎', 'innodisk')},
    '8271': {'name': '宇瞻科技', 'aliases': ('宇瞻', 'apacer')},
}

INDUSTRY_TERMS = (
    'dram', 'nand', 'hbm', 'ssd', 'memory', 'storage', 'flash', '記憶體',
    '快閃', '儲存', '固態硬碟', '模組', '工控', '邊緣運算', 'ai server',
)

EVENT_RULES = (
    ('crisis', ('召回', '事故', '停產', '裁員', '訴訟', '罰款', '資安', '中斷',
                'recall', 'lawsuit', 'layoff', 'outage', 'breach'), 35),
    ('financial', ('營收', '獲利', '虧損', '財報', '股利', '法說', 'eps', 'revenue',
                   'profit', 'earnings', 'dividend'), 25),
    ('supply_chain', ('供應鏈', '缺貨', '漲價', '降價', '產能', '庫存', '短缺',
                      'supply', 'shortage', 'capacity', 'inventory', 'price'), 22),
    ('product', ('新品', '推出', '發布', '上市', 'ssd', '記憶卡', '產品', 'launch',
                 'unveil', 'release'), 18),
    ('partnership', ('合作', '策略聯盟', '投資', '併購', '收購', 'partnership',
                     'acquisition', 'investment'), 20),
    ('market', ('市場', '趨勢', '需求', '展望', '市占', 'market', 'demand',
                'forecast', 'outlook'), 14),
)

NEGATIVE_TERMS = ('虧損', '下滑', '召回', '訴訟', '罰款', '裁員', '停產', '中斷',
                  'loss', 'decline', 'recall', 'lawsuit', 'layoff', 'risk')
POSITIVE_TERMS = ('成長', '新高', '獲利', '合作', '推出', '擴產', '得獎',
                  'growth', 'record high', 'profit', 'partnership', 'launch')


def _text(article):
    """只把人類可見的文章資料當成判斷文字。

    ``cat=transcend`` 這類系統分類不可參與公司別名比對，否則會把
    整個分類的文章都誤判為「內容提及 Transcend」。
    """
    return ' '.join(str(article.get(k) or '') for k in (
        'title', 'content', 'sourceName', 'mediaName', 'brand'
    )).lower()


def _matched_terms(text, terms):
    return [term for term in terms if term.lower() in text]


def is_excluded_article(article):
    """判斷文章是否明確屬於同名但無關的公司。"""
    visible_text = ' '.join(str(article.get(k) or '') for k in ('title', 'content')).lower()
    return any(phrase.lower() in visible_text for phrase in EXCLUDED_ARTICLE_PHRASES)


def _contains_alias(text, alias):
    value = alias.lower()
    if re.fullmatch(r'[a-z0-9 ]+', value):
        return bool(re.search(rf'(?<![a-z0-9]){re.escape(value)}(?![a-z0-9])', text))
    return value in text


def analyze_article_rules(article):
    """以透明規則產生初步情報標籤，不使用付費 AI。"""
    if is_excluded_article(article):
        return {
            'ruleVersion': RULE_VERSION,
            'relevant': False,
            'relevanceScore': 0,
            'importanceScore': 0,
            'eventType': 'other',
            'entities': [],
            'impact': 'neutral',
            'matchedTerms': [],
            'reasons': ['排除同名非本公司'],
            'requiresReview': False,
        }
    text = _text(article)
    entities = []
    reasons = []

    for code, meta in COMPANIES.items():
        if any(_contains_alias(text, alias) for alias in meta['aliases']):
            entities.append({'code': code, 'name': meta['name']})

    industry_hits = _matched_terms(text, INDUSTRY_TERMS)
    cat = str(article.get('cat') or '')
    relevance = 0
    if any(e['code'] == '2451' for e in entities):
        relevance += 55
        reasons.append('提及創見')
    if entities and not any(e['code'] == '2451' for e in entities):
        relevance += 35
        reasons.append('提及追蹤中的競品')
    if industry_hits:
        relevance += min(30, 6 * len(set(industry_hits)))
        reasons.append('涉及記憶體或儲存產業')
    if cat in ('transcend', 'competitor', 'supplier'):
        relevance += 15
    elif cat in ('usMarket', 'twMarket'):
        relevance += 8
    relevance = min(100, relevance)

    event_type = 'other'
    event_weight = 0
    event_hits = []
    for candidate, terms, weight in EVENT_RULES:
        hits = _matched_terms(text, terms)
        if hits and weight > event_weight:
            event_type, event_weight, event_hits = candidate, weight, hits

    negative_hits = _matched_terms(text, NEGATIVE_TERMS)
    positive_hits = _matched_terms(text, POSITIVE_TERMS)
    if negative_hits and not positive_hits:
        impact = 'risk'
    elif positive_hits and not negative_hits:
        impact = 'opportunity'
    elif negative_hits and positive_hits:
        impact = 'mixed'
    else:
        impact = 'neutral'

    source_bonus = 8 if str(article.get('sourceName') or '').startswith(('創見', 'TWSE', 'TPEX')) else 0
    importance = min(100, round(relevance * 0.55 + event_weight + source_bonus))
    if event_hits:
        reasons.append(f'事件類型：{event_type}')

    return {
        'ruleVersion': RULE_VERSION,
        'relevant': relevance >= QUEUE_THRESHOLD,
        'relevanceScore': relevance,
        'importanceScore': importance,
        'eventType': event_type,
        'entities': entities,
        'impact': impact,
        'matchedTerms': sorted(set(industry_hits + event_hits + negative_hits + positive_hits))[:20],
        'reasons': reasons[:6],
        'requiresReview': importance >= 70 or event_type == 'crisis',
    }


def should_queue_article(rule_analysis):
    return bool(rule_analysis.get('relevant'))


def build_ai_job(article, content_hash, server_timestamp):
    """建立可安全重跑的 ai_jobs 文件；不複製全文、不包含任何 Secret。"""
    rules = analyze_article_rules(article)
    if not should_queue_article(rules):
        return None
    return {
        'articleId': article['id'],
        'contentHash': content_hash,
        'status': 'pending',
        'priority': rules['importanceScore'],
        'attempts': 0,
        'owner': None,
        'leaseUntil': None,
        'nextAttemptAt': None,
        'lastError': None,
        'completedAt': None,
        'workflowVersion': WORKFLOW_VERSION,
        'ruleAnalysis': rules,
        'requestedAt': server_timestamp,
        'updatedAt': server_timestamp,
    }


def rule_summary(article, rule_analysis):
    """沒有本機模型時的可讀摘要備援。"""
    title = re.sub(r'\s+', ' ', str(article.get('title') or '')).strip()
    source = str(article.get('mediaName') or article.get('sourceName') or '未知來源')
    event = rule_analysis.get('eventType', 'other')
    return f'{title}（來源：{source}；類型：{event}）'[:300]
