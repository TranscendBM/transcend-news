"""
functions/main.py（Cloud Functions 排程進入點）單元測試 — 完全離線

firebase_functions / firebase_admin 皆以 stub 取代：
- on_schedule 裝飾器改為 passthrough，排程參數存於 fn._schedule_opts 供驗證
- SecretParam 可注入測試值
不連接 Secret Manager、Firestore 或任何外部服務。
"""

import datetime
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── stub 外部相依（必須在 import main 之前）──────────────────────
for _mod in ('requests', 'feedparser', 'firebase_admin',
             'firebase_admin.credentials', 'firebase_admin.firestore'):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock(name=_mod)

_ff = types.ModuleType('firebase_functions')
_sched = types.ModuleType('firebase_functions.scheduler_fn')


def _on_schedule(**opts):
    def deco(fn):
        fn._schedule_opts = opts     # 保留排程參數供測試驗證
        return fn
    return deco


_sched.on_schedule = _on_schedule
_sched.ScheduledEvent = object

_https = types.ModuleType('firebase_functions.https_fn')


def _on_request(**opts):
    def deco(fn):
        fn._request_opts = opts
        return fn
    return deco


class _Response:
    def __init__(self, body, status=200, mimetype=None):
        self.body, self.status, self.mimetype = body, status, mimetype


_https.on_request = _on_request
_https.Request = object
_https.Response = _Response

_opts = types.ModuleType('firebase_functions.options')


class _MemoryOption:
    MB_256 = 256
    MB_512 = 512


_opts.MemoryOption = _MemoryOption
_opts.CorsOptions = lambda **kw: kw

_params = types.ModuleType('firebase_functions.params')


class _SecretParam:
    def __init__(self, name):
        self.name = name
        self.value = ''              # 測試中直接覆寫


_params.SecretParam = _SecretParam

_ff.scheduler_fn = _sched
_ff.https_fn = _https
_ff.options = _opts
_ff.params = _params
sys.modules.setdefault('firebase_functions', _ff)
sys.modules.setdefault('firebase_functions.scheduler_fn', _sched)
sys.modules.setdefault('firebase_functions.https_fn', _https)
sys.modules.setdefault('firebase_functions.options', _opts)
sys.modules.setdefault('firebase_functions.params', _params)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'functions'))

import fetch_news  # noqa: E402
import main        # noqa: E402
import db_same_project  # noqa: E402


class TestGetDb(unittest.TestCase):
    def test_main_get_db_is_db_same_project_get_db(self):
        """main.py 已經切換成同專案 Application Default Credentials：
        不再自己定義跨專案的 get_db()，而是直接沿用
        db_same_project.get_db()（同一個函式物件，不是重新包一層）——
        該函式本身的 get_app()-優先/新建/singleton 行為已經在
        tests/test_db_same_project.py 完整測試過，這裡不重複測。"""
        self.assertIs(main.get_db, db_same_project.get_db)


class TestRunLocked(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock(name='db')
        self.patch_getdb = patch.object(main, 'get_db', return_value=self.db)
        self.patch_getdb.start()
        self.addCleanup(self.patch_getdb.stop)

    def test_skips_when_lock_busy(self):
        work = MagicMock()
        with patch.object(fetch_news, 'acquire_lock', return_value=None), \
             patch.object(fetch_news, 'release_lock') as mrel:
            result = main._run_locked('news', work, ttl_minutes=12)
        self.assertFalse(result)
        work.assert_not_called()
        mrel.assert_not_called()

    def test_runs_and_releases_with_own_token(self):
        work = MagicMock()
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-123'), \
             patch.object(fetch_news, 'release_lock') as mrel:
            result = main._run_locked('news', work, ttl_minutes=12)
        self.assertTrue(result)
        work.assert_called_once_with(self.db)
        mrel.assert_called_once_with(self.db, 'news', 'tok-123')

    def test_releases_lock_even_when_work_raises(self):
        work = MagicMock(side_effect=RuntimeError('外部服務爆炸'))
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-456'), \
             patch.object(fetch_news, 'release_lock') as mrel:
            with self.assertRaises(RuntimeError):
                main._run_locked('news', work, ttl_minutes=12)
        mrel.assert_called_once_with(self.db, 'news', 'tok-456')

    def test_writes_job_status_success_on_success(self):
        # job_status/{lock_name} 是前端「系統健康」頁面唯一的資料來源，
        # 必須在每次成功執行後正確清掉舊的錯誤紀錄（lastError/lastErrorAt
        # 設回 None），否則舊錯誤會一直顯示成「目前有錯誤」。
        work = MagicMock()
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-123'), \
             patch.object(fetch_news, 'release_lock'):
            main._run_locked('news', work, ttl_minutes=12)
        self.db.collection.assert_any_call('job_status')
        status_ref = self.db.collection.return_value.document.return_value
        self.db.collection.return_value.document.assert_any_call('news')
        payload = status_ref.set.call_args.args[0]
        self.assertIn('lastSuccessAt', payload)
        self.assertIsNone(payload['lastError'])
        self.assertIsNone(payload['lastErrorAt'])

    def test_writes_job_status_error_on_failure(self):
        work = MagicMock(side_effect=RuntimeError('外部服務爆炸'))
        with patch.object(fetch_news, 'acquire_lock', return_value='tok-456'), \
             patch.object(fetch_news, 'release_lock'):
            with self.assertRaises(RuntimeError):
                main._run_locked('news', work, ttl_minutes=12)
        status_ref = self.db.collection.return_value.document.return_value
        payload = status_ref.set.call_args.args[0]
        self.assertEqual(payload['lastError'], '外部服務爆炸')
        self.assertIn('lastErrorAt', payload)
        self.assertNotIn('lastSuccessAt', payload)


class TestScheduledEntrypoints(unittest.TestCase):
    def test_all_jobs_have_max_instances_1(self):
        jobs = [main.stocks_job, main.news_job,
                main.trading_job, main.finance_job, main.finance_early_month_job,
                main.tw_dram_digest_job, main.us_dram_digest_job,
                main.news_cleanup_job, main.ai_worker_health_job]
        for job in jobs:
            self.assertEqual(job._schedule_opts.get('max_instances'), 1,
                             f'{job.__name__} 必須設 max_instances=1')

    def test_lock_ttl_exceeds_function_timeout(self):
        """鎖 TTL 必須大於函式 timeout，否則執行中的鎖可能被誤接管"""
        # (job, 對應 _run_locked ttl_minutes)——與 main.py 內設定同步維護
        ttls = {'stocks_job': 3, 'news_job': 12,
                'trading_job': 8, 'finance_job': 12, 'finance_early_month_job': 12,
                'tw_dram_digest_job': 5, 'us_dram_digest_job': 5,
                'news_cleanup_job': 15, 'ai_worker_health_job': 5}
        for job_name, ttl in ttls.items():
            timeout_sec = getattr(main, job_name)._schedule_opts['timeout_sec']
            self.assertGreater(ttl * 60, timeout_sec,
                               f'{job_name}: 鎖 TTL({ttl}分) 必須 > timeout({timeout_sec}秒)')

    def test_digest_jobs_use_independent_locks(self):
        names = []
        with patch.object(main, '_run_locked', side_effect=lambda n, *a, **k: names.append(n)):
            main.tw_dram_digest_job(None)
            main.us_dram_digest_job(None)
        self.assertEqual(names, ['digest_tw', 'digest_us'],
                         '台灣/美國摘要信各自獨立追蹤寄送進度，不得共用同一把鎖')

    def test_digest_jobs_require_email_secret(self):
        for job_name in ('tw_dram_digest_job', 'us_dram_digest_job'):
            secrets = getattr(main, job_name)._schedule_opts['secrets']
            self.assertIn(main.MAIL2000_SMTP_PASSWORD, secrets,
                         f'{job_name} 必須帶入 MAIL2000_SMTP_PASSWORD 才能寄信')

    def test_finmind_dependent_jobs_require_finmind_secret(self):
        # stocks_job/trading_job/finance_job/finance_early_month_job 都會呼叫
        # FinMind API（股價備援/三大法人/月營收/季損益/股利），必須帶入
        # FINMIND_API_TOKEN，否則 FinMind 匿名配額用盡時整批失敗（見
        # fetch_news._finmind_token()）。
        for job_name in ('stocks_job', 'trading_job', 'finance_job', 'finance_early_month_job'):
            secrets = getattr(main, job_name)._schedule_opts['secrets']
            self.assertIn(main.FINMIND_API_TOKEN, secrets,
                         f'{job_name} 必須帶入 FINMIND_API_TOKEN 才能呼叫 FinMind')

    def test_news_job_routes_through_lock(self):
        with patch.object(main, '_run_locked') as mrun:
            main.news_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'news')

    def test_finance_jobs_share_same_lock(self):
        names = []
        with patch.object(main, '_run_locked', side_effect=lambda n, *a, **k: names.append(n)):
            main.finance_job(None)
            main.finance_early_month_job(None)
        self.assertEqual(names, ['finance', 'finance'],
                         '每日與月初加密排程必須共用同一把鎖')

    def test_stocks_job_skips_outside_market_hours(self):
        night = datetime.datetime(2026, 7, 15, 20, 0)   # 週三晚上
        with patch.object(main, '_tw_now',
                          return_value=night.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))), \
             patch.object(main, '_run_locked') as mrun:
            main.stocks_job(None)
        mrun.assert_not_called()

    def test_stocks_job_runs_during_market_hours(self):
        trading = datetime.datetime(2026, 7, 15, 10, 30)  # 週三盤中
        with patch.object(main, '_tw_now',
                          return_value=trading.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))), \
             patch.object(main, '_run_locked') as mrun:
            main.stocks_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'stocks')

    def test_news_cleanup_job_routes_through_lock(self):
        with patch.object(main, '_run_locked') as mrun:
            main.news_cleanup_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'news_cleanup')

    def test_news_cleanup_job_schedule_is_daily_at_0230_taipei(self):
        opts = main.news_cleanup_job._schedule_opts
        self.assertEqual(opts['schedule'], '30 2 * * *')
        self.assertEqual(opts['timezone'], main.TZ)
        self.assertEqual(opts['region'], main.REGION)
        self.assertEqual(opts['max_instances'], 1)
        # 同專案 ADC 不需要任何 Secret；只有寄信的兩個 digest job 才需要
        # MAIL2000_SMTP_PASSWORD，清理本身完全不用帶 secrets。
        self.assertNotIn('secrets', opts,
                         '清理只需要同專案 ADC 寫入權限，不需要任何 Secret')

    def test_news_cleanup_job_calls_cleanup_with_dry_run_false(self):
        db = MagicMock(name='db')
        with patch.object(main, 'get_db', return_value=db), \
             patch.object(fetch_news, 'acquire_lock', return_value='tok-cleanup'), \
             patch.object(fetch_news, 'release_lock') as mrel, \
             patch.object(main.news_cleanup, 'cleanup_expired_news',
                          return_value={'deleted': 3, 'skipped_invalid': 0, 'remaining': False}) as mcleanup:
            main.news_cleanup_job(None)
        mcleanup.assert_called_once_with(db, dry_run=False)
        mrel.assert_called_once_with(db, 'news_cleanup', 'tok-cleanup')

    def test_news_cleanup_job_releases_lock_even_when_cleanup_raises(self):
        db = MagicMock(name='db')
        with patch.object(main, 'get_db', return_value=db), \
             patch.object(fetch_news, 'acquire_lock', return_value='tok-cleanup'), \
             patch.object(fetch_news, 'release_lock') as mrel, \
             patch.object(main.news_cleanup, 'cleanup_expired_news',
                          side_effect=RuntimeError('Firestore 寫入失敗')):
            with self.assertRaises(RuntimeError):
                main.news_cleanup_job(None)
        mrel.assert_called_once_with(db, 'news_cleanup', 'tok-cleanup')

    def test_ai_worker_health_job_routes_through_lock(self):
        with patch.object(main, '_run_locked') as mrun:
            main.ai_worker_health_job(None)
        mrun.assert_called_once()
        self.assertEqual(mrun.call_args[0][0], 'ai_worker_health')

    def test_ai_worker_health_job_schedule_is_daily_shortly_after_news_cleanup(self):
        opts = main.ai_worker_health_job._schedule_opts
        self.assertEqual(opts['schedule'], '35 2 * * *')
        self.assertEqual(opts['timezone'], main.TZ)
        self.assertEqual(opts['region'], main.REGION)
        self.assertEqual(opts['max_instances'], 1)
        # 唯讀彙總，不寄信、不呼叫任何需要 Secret 的外部 API
        self.assertNotIn('secrets', opts,
                         'ai_worker_health_job 只做 Firestore 唯讀彙總，不需要任何 Secret')

    def test_ai_worker_health_job_calls_check_ai_worker_health(self):
        db = MagicMock(name='db')
        with patch.object(main, 'get_db', return_value=db), \
             patch.object(fetch_news, 'acquire_lock', return_value='tok-health'), \
             patch.object(fetch_news, 'release_lock') as mrel, \
             patch.object(main.ai_worker_health, 'check_ai_worker_health',
                          return_value={'pendingCount': 5, 'lastInsightAt': None}) as mcheck:
            main.ai_worker_health_job(None)
        mcheck.assert_called_once_with(db)
        mrel.assert_called_once_with(db, 'ai_worker_health', 'tok-health')


if __name__ == '__main__':
    unittest.main()
