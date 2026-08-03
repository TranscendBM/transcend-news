"""
準備中、尚未啟用的 Firestore 連線方式：同專案 Application Default
Credentials（給 Firestore 資料庫合併到 transcend-news-tbm 之後用）。

⚠️ 這個檔案目前完全沒有被 main.py 或任何其他模組 import／呼叫，純粹是
「準備好、審查用」的參考實作，部署後也只是多一個沒人用的檔案，不會
改變任何現有排程的行為。

背景：functions/main.py 現在的 get_db()（見該檔案）用 Secret Manager 的
MONITOR_SERVICE_ACCOUNT 憑證，跨專案指向 transcend-news-monitor。等
tools/migrate_firestore.py 把資料搬到 transcend-news-tbm、驗證完成、
且確定要正式切換之後，Cloud Functions 才需要改成連自己所在的專案
（transcend-news-tbm）——這時不再需要任何跨專案憑證，直接用 Cloud
Functions 執行環境本身的 Application Default Credentials 即可，
firebase_admin.initialize_app() 不帶 credential 參數會自動使用它，
且會自動指向部署所在的專案（不會像目前的 named app 那樣需要手動指定
projectId 來避免連錯專案）。

正式切換時（不是現在）的動作：
  1. 把 functions/main.py 裡所有 `from db_same_project import get_db` 換掉
     `def get_db()`（目前 main.py 自己定義的那個跨專案版本），改成
     `from db_same_project import get_db`
  2. 移除 main.py 裡的 MONITOR_SERVICE_ACCOUNT = SecretParam(...) 與所有
     @scheduler_fn.on_schedule(..., secrets=[MONITOR_SERVICE_ACCOUNT, ...])
     裡的 MONITOR_SERVICE_ACCOUNT（保留 MAIL2000_SMTP_PASSWORD 等其他
     secret 不動）
  3. firebase deploy --only functions --project transcend-news-tbm
  4. 確認排程正常寫入 transcend-news-tbm 的 Firestore 後，才能考慮撤銷
     MONITOR_SERVICE_ACCOUNT 這個 Secret 本身，以及 transcend-news-monitor
     專案那把對應的 service account 金鑰（撤銷前務必確認沒有其他用途
     還在用它）。

Rollback（切換後如果需要退回）：見 docs/firestore-migration/README.md
的「Rollback 步驟」——切換後一旦 transcend-news-tbm 已經有新寫入，回退
不再是「單純改回舊設定」這麼簡單，必須先暫停 writer、決定以哪邊資料為
準、同步資料後才能切回，避免兩個專案同時接受寫入造成 split-brain。
"""

import firebase_admin
from firebase_admin import firestore

_db = None


def get_db():
    """
    Application Default Credentials，明確指向 Cloud Functions 執行環境
    自己所在的專案（不需要、也不應該再傳 projectId——ADC 在 Cloud
    Functions 環境下已經知道自己是哪個專案，手動指定反而增加打錯的
    風險）。

    先呼叫 firebase_admin.get_app() 確認有沒有現成的 default app，只有
    在真的不存在（ValueError）時才 initialize_app()——直接呼叫
    initialize_app() 在 default app 已經存在時會拋出
    'The default Firebase app already exists' 錯誤（例如同一個執行環境
    中有其他模組已經先建立過 default app），先檢查再視情況建立可以
    正確重用既有的 app，不會因為呼叫順序而炸掉。
    """
    global _db
    if _db is None:
        try:
            app = firebase_admin.get_app()
        except ValueError:
            app = firebase_admin.initialize_app()
        _db = firestore.client(app=app)
        print('✅ Firestore 已連線（同專案 Application Default Credentials）')
    return _db
