"""
DRAM/Flash 產業新聞摘要信件 — Phase 1（零 API 費用，沿用 intelligence.py 規則層）。

平日 08:00 寄台灣 DRAM/Flash 產業新聞、16:30 寄美國 DRAM/Flash 產業新聞
（實際排程設定見 main.py）。內容摘要用 intelligence.rule_summary()，
不呼叫任何付費 AI；之後若導入本機 Ollama 摘要，只需替換
build_digest_email() 產生的內文，其餘（篩選、寄信、進度追蹤）不動。

範圍鎖定「上游供應商 + 產業市場」新聞，不含創見自己或競品的公司新聞
（那些已有前端 PR/競品動態分頁可看，這封信只做產業情報）。

寄件帳號使用 Gmail SMTP（tselvis814@gmail.com + App Password），
App Password 存於 Secret Manager 的 DIGEST_EMAIL_APP_PASSWORD，
不進 repo、不進程式碼。
"""

import datetime
import html
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate

import fetch_news
import intelligence

SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 587
DIGEST_SENDER = 'tselvis814@gmail.com'
DIGEST_RECIPIENTS = ['ai_mkd@transcend-info.com']
DIGEST_MAX_ITEMS = 20

# 首次執行、尚無「上次寄送時間」紀錄時的保守預設回溯區間，
# 避免第一次執行把過往全部歷史新聞塞進一封信。
DIGEST_DEFAULT_LOOKBACK_HOURS = 48

DIGEST_CATS = {
    'tw': {'cat': 'twMarket', 'label': '台灣 DRAM/Flash 產業新聞'},
    'us': {'cat': 'usMarket', 'label': '美國 DRAM/Flash 產業新聞'},
}

# 競品公司代號（intelligence.COMPANIES 扣掉創見自己）：這封信只做上游供應商
# ／產業市場情報，創見自己與競品的公司新聞已有前端 PR／競品動態分頁可看，
# 提到這些公司的文章一律排除，避免跟那邊的內容重複。
_COMPETITOR_CODES = frozenset(intelligence.COMPANIES) - {'2451'}

# PNG，不是 SVG——不少信箱用戶端（尤其 Outlook 桌面版）不支援在信件裡
# 顯示 SVG 圖片，PNG 相容性才夠好。
LOGO_URL = 'https://transcend-news.web.app/logos/transcend-white.png'
BRAND_COLOR = '#960014'

# Outlook 桌面版用 Word 引擎渲染 HTML 信件，不會把 <body> 上設定的
# font-family 往下繼承到表格/div 裡，只寫在 body 會被忽略、退回 Outlook
# 自己的中文預設字型（新細明體）。因此下面 HTML 樣板裡每一個會顯示文字
# 的元素都要重複寫一次這個字型堆疊，不能只靠 CSS 繼承。
FONT_STACK = "Calibri,'Microsoft JhengHei','微軟正黑體',sans-serif"

EVENT_LABELS = {
    'crisis':       ('風險', '#dc2626'),
    'financial':    ('財務', '#2563eb'),
    'supply_chain': ('供應鏈', '#c2410c'),
    'product':      ('產品', '#16a34a'),
    'partnership':  ('合作', '#7c3aed'),
    'market':       ('市場', '#ca8a04'),
    'other':        ('新聞', '#6b7280'),
}


def _mentions_tracked_company(rules):
    """是否提及創見自己或任一競品（這幾家公司新聞已有前端分頁可看，這封信不重複收錄）。"""
    return any(e.get('code') in _COMPETITOR_CODES or e.get('code') == '2451'
               for e in rules.get('entities', []))


def select_digest_articles(articles, since_dt, limit=DIGEST_MAX_ITEMS):
    """
    純函式：從文章清單中挑出符合以下條件的文章：
      1. since_dt 之後發布
      2. 經 intelligence 規則判定為相關（relevant）
      3. 不是創見自己或競品的公司新聞（只保留上游供應商/產業市場情報）
      4. 標題正規化後不重複（同一則新聞被多個來源/搜尋條件重複收錄時，
         只留下重要性分數最高的那一則）

    依重要性分數（importanceScore）由高到低排序，最多回傳 limit 筆。
    回傳 [(article, rule_analysis), ...]。
    """
    scored = []
    for article in articles:
        pub_dt = article.get('pubDate')
        if not isinstance(pub_dt, datetime.datetime) or pub_dt <= since_dt:
            continue
        rules = intelligence.analyze_article_rules(article)
        if not rules.get('relevant'):
            continue
        if _mentions_tracked_company(rules):
            continue
        scored.append((article, rules))
    scored.sort(key=lambda pair: pair[1]['importanceScore'], reverse=True)

    deduped = []
    seen_titles = set()
    for article, rules in scored:
        key = fetch_news.normalize_title(article.get('title'))
        if key and key in seen_titles:
            continue
        seen_titles.add(key)
        deduped.append((article, rules))
    return deduped[:limit]


def _event_badge(event_type):
    return EVENT_LABELS.get(event_type, EVENT_LABELS['other'])


def build_digest_email(label, items, now=None):
    """
    純函式：把挑選出的文章組成信件標題、純文字內文與 HTML 內文
    （多數信箱優先顯示 HTML 版本，純文字版供不支援 HTML 的用戶端顯示）。
    回傳 (subject, text_body, html_body)。
    """
    now = now or datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    date_str = now.strftime('%Y-%m-%d')
    subject = f'[創見新聞監控] {date_str} {label}（共 {len(items)} 則）'

    text_lines = [f'{date_str} {label}，共 {len(items)} 則（依重要性排序）：', '']
    card_html_parts = []

    if not items:
        text_lines.append(f'目前沒有符合條件的{label}。')
    else:
        for i, (article, rules) in enumerate(items, 1):
            text_lines.append(f'{i}. {intelligence.rule_summary(article, rules)}')
            link = article.get('link')
            if link:
                text_lines.append(f'   {link}')
            text_lines.append('')

            title = html.escape(str(article.get('title') or ''))
            source = html.escape(str(article.get('mediaName') or article.get('sourceName') or '未知來源'))
            safe_link = html.escape(link or '#', quote=True)
            badge_label, badge_color = _event_badge(rules.get('eventType'))
            title_html = (
                f'<a href="{safe_link}" style="color:#1f2937;text-decoration:none;">{title}</a>'
                if link else title
            )
            card_html_parts.append(f'''
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e5e7eb;font-family:{FONT_STACK};">
            <span style="display:inline-block;font-family:{FONT_STACK};font-size:11px;font-weight:bold;color:#ffffff;
                         background:{badge_color};border-radius:10px;padding:2px 8px;margin-bottom:6px;">
              {html.escape(badge_label)}
            </span>
            <div style="font-family:{FONT_STACK};font-size:15px;font-weight:600;line-height:1.5;margin-top:4px;">{title_html}</div>
            <div style="font-family:{FONT_STACK};font-size:12px;color:#6b7280;margin-top:4px;">{source}</div>
          </td>
        </tr>''')

    text_body = '\n'.join(text_lines)

    items_html = (
        ''.join(card_html_parts) if items else
        f'<tr><td style="padding:24px 0;color:#6b7280;font-size:14px;font-family:{FONT_STACK};">目前沒有符合條件的{html.escape(label)}。</td></tr>'
    )

    html_body = f'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<!--[if mso]>
<style type="text/css">
  body, table, td, div, span, a {{ font-family: Calibri, "Microsoft JhengHei", sans-serif !important; }}
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:{FONT_STACK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:24px 0;font-family:{FONT_STACK};">
    <tr>
      <td align="center" style="font-family:{FONT_STACK};">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;font-family:{FONT_STACK};">
          <tr>
            <td style="background:{BRAND_COLOR};padding:20px 24px;font-family:{FONT_STACK};">
              <img src="{LOGO_URL}" alt="Transcend" height="22" style="display:block;border:0;">
              <div style="font-family:{FONT_STACK};color:#ffffff;font-size:16px;font-weight:bold;margin-top:10px;">{html.escape(label)}</div>
              <div style="font-family:{FONT_STACK};color:rgba(255,255,255,0.7);font-size:12px;margin-top:2px;">{date_str}・共 {len(items)} 則</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 4px 24px;font-family:{FONT_STACK};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:{FONT_STACK};">
                {items_html}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;background:#f8fafc;color:#9ca3af;font-size:11px;font-family:{FONT_STACK};">
              創見新聞監控系統自動產生・規則版摘要（零 API 費用）
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>'''

    return subject, text_body, html_body


def send_email(subject, text_body, html_body, to_addrs, app_password, from_addr=DIGEST_SENDER):
    """寄出信件（純文字 + HTML 雙版本，Gmail SMTP，587 埠 + STARTTLS）。"""
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = from_addr
    msg['To'] = ', '.join(to_addrs)
    msg['Date'] = formatdate(localtime=True)
    msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.starttls()
        server.login(from_addr, app_password)
        server.sendmail(from_addr, to_addrs, msg.as_string())


def _checkpoint_ref(db, name):
    return db.collection('meta').document(f'digest_{name}')


def get_last_digest_time(db, name, default_lookback_hours=DIGEST_DEFAULT_LOOKBACK_HOURS):
    """
    讀取上次成功寄出的時間戳；沒有紀錄時（第一次執行）回傳
    「現在往前推 default_lookback_hours 小時」。
    """
    snap = _checkpoint_ref(db, name).get()
    if getattr(snap, 'exists', False):
        ts = (snap.to_dict() or {}).get('lastSentAt')
        if ts is not None:
            return ts
    now = datetime.datetime.now(datetime.timezone.utc)
    return now - datetime.timedelta(hours=default_lookback_hours)


def set_last_digest_time(db, name, when):
    _checkpoint_ref(db, name).set({'lastSentAt': when}, merge=True)


def fetch_cat_articles(db, cat):
    """讀取指定分類（twMarket/usMarket）目前 Firestore 中的所有文章。"""
    docs = db.collection('news').where('cat', '==', cat).stream()
    return [d.to_dict() for d in docs]


def run_digest(db, key, app_password):
    """
    執行一次摘要寄信（key='tw' 或 'us'）。
    先讀取上次寄送時間、篩選新文章、組信、寄出，最後才更新寄送時間戳記——
    若寄信失敗會拋出例外、時間戳記不會更新，下次執行會用同一個區間重試，
    不會漏掉這中間的新聞。
    回傳 dict(count=已挑選則數)，供呼叫端印出執行結果。
    """
    cfg = DIGEST_CATS[key]
    since = get_last_digest_time(db, key)
    articles = fetch_cat_articles(db, cfg['cat'])
    items = select_digest_articles(articles, since)
    subject, text_body, html_body = build_digest_email(cfg['label'], items)
    send_email(subject, text_body, html_body, DIGEST_RECIPIENTS, app_password)
    set_last_digest_time(db, key, datetime.datetime.now(datetime.timezone.utc))
    return {'count': len(items)}
