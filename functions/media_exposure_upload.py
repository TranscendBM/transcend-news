"""網站上傳「人工確認曝光」Excel 的後端邏輯。

由 main.py 的 upload_media_exposure（HTTPS Cloud Function）呼叫。流程跟
CLI（tools/import_media_exposure.py）一致，解析／去重／寫入都用同一份
media_exposure.py：

  mode="check"   只解析、回報筆數與無效列位置，不寫入（等同 CLI dry-run）
  mode="commit"  實際寫入；有無效列時必須帶 approveSkippingInvalid，且數字
                 要跟 check 回報的無效列數完全相同（等同 CLI 的
                 --approve-skipping-invalid）

網站本身沒有登入機制、Firestore 也禁止客戶端寫入，所以這個端點用「上傳
通行碼」（Secret Manager 的 MEDIA_EXPOSURE_UPLOAD_PASSCODE）把關：沒有
通行碼不能解析、不能寫入。回應只含筆數與無效列位置，不含新聞標題或
內部備註。
"""

from __future__ import annotations

import base64
import binascii
import hmac
import io
import time
from datetime import datetime
from typing import Any, Callable

import media_exposure as core

MAX_FILES = 6
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_UNIQUE_RECORDS = 5000
FAILED_PASSCODE_DELAY_SEC = 1.5


class UploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _check_passcode(given: Any, expected: str) -> None:
    ok = (
        isinstance(given, str) and bool(expected)
        and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
    )
    if not ok:
        # 拖慢暴力猜測；通行碼夠長時這已足夠
        time.sleep(FAILED_PASSCODE_DELAY_SEC)
        raise UploadError(403, "上傳通行碼不正確")


def _decode_files(raw: Any) -> list[tuple[str, io.BytesIO]]:
    if not isinstance(raw, list) or not raw:
        raise UploadError(400, "請選擇至少一個 Excel 檔案")
    if len(raw) > MAX_FILES:
        raise UploadError(400, f"一次最多上傳 {MAX_FILES} 個檔案")
    files: list[tuple[str, io.BytesIO]] = []
    total = 0
    for item in raw:
        name = item.get("name") if isinstance(item, dict) else None
        data = item.get("data") if isinstance(item, dict) else None
        if not isinstance(name, str) or not isinstance(data, str) or not name.strip():
            raise UploadError(400, "檔案格式不正確")
        name = name.strip()[:120]
        if not name.lower().endswith(".xlsx"):
            raise UploadError(400, f"「{name}」不是 .xlsx 檔案")
        if len(data) > MAX_FILE_BYTES * 4 // 3 + 8:
            raise UploadError(413, f"「{name}」超過 {MAX_FILE_BYTES // 1024 // 1024} MB 上限")
        try:
            blob = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise UploadError(400, f"「{name}」內容無法解碼") from None
        total += len(blob)
        if len(blob) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise UploadError(413, "檔案太大")
        if not blob.startswith(b"PK"):  # .xlsx 是 zip 格式
            raise UploadError(400, f"「{name}」不是有效的 .xlsx 檔案")
        files.append((name, io.BytesIO(blob)))
    return files


def _validate_workbooks(files: list[tuple[str, io.BytesIO]]) -> None:
    """逐一試開，才能在檔案壞掉時指出是哪一個。"""
    from openpyxl import load_workbook
    for name, stream in files:
        try:
            wb = load_workbook(stream, read_only=True, data_only=True)
            wb.close()
        except Exception:  # openpyxl 對壞檔案會丟多種例外
            raise UploadError(400, f"無法讀取「{name}」，請確認是正常的 .xlsx 檔案") from None
        stream.seek(0)


def _existing_count(db, ids: list[str]) -> int:
    existing = 0
    for start in range(0, len(ids), 300):
        refs = [db.collection(core.PUBLIC_COLLECTION).document(i) for i in ids[start:start + 300]]
        existing += sum(1 for snap in db.get_all(refs) if snap.exists)
    return existing


def _summary(report: core.ParseReport, db) -> dict[str, Any]:
    base = report.summary()
    by_month: dict[str, int] = {}
    for record in report.records.values():
        month = record.public["exposureDate"].astimezone(core.TAIPEI).strftime("%Y-%m")
        by_month[month] = by_month.get(month, 0) + 1
    existing = _existing_count(db, list(report.records)) if report.records else 0
    return {
        "rowsSeen": base["rows_seen"],
        "validRows": base["valid_rows"],
        "uniqueRecords": base["unique_records"],
        "duplicateRows": base["duplicate_rows"],
        "invalidRows": report.invalid_rows,
        "uniqueMedia": base["unique_media"],
        "exposureTypes": base["exposure_types"],
        "byMonth": dict(sorted(by_month.items())),
        "newRecords": base["unique_records"] - existing,
        "existingRecords": existing,
    }


def handle_upload(payload: Any, *, passcode: str, db) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise UploadError(400, "請求格式不正確")
    _check_passcode(payload.get("passcode"), passcode)
    mode = payload.get("mode")
    if mode not in ("check", "commit"):
        raise UploadError(400, "mode 必須是 check 或 commit")

    files = _decode_files(payload.get("files"))
    _validate_workbooks(files)
    report = core.parse_workbooks(files)
    if len(report.records) > MAX_UNIQUE_RECORDS:
        raise UploadError(413, f"單次最多匯入 {MAX_UNIQUE_RECORDS} 筆")

    summary = _summary(report, db)
    if mode == "check":
        return {"ok": True, "mode": "check", **summary}

    if not report.records:
        raise UploadError(400, "沒有可匯入的有效資料")
    invalid = len(report.invalid_rows)
    if invalid and payload.get("approveSkippingInvalid") != invalid:
        raise UploadError(409, f"仍有 {invalid} 列無效資料。請修正，或確認略過這 {invalid} 列後再匯入")

    batch = "web-upload-" + datetime.now(core.TAIPEI).strftime("%Y%m%d-%H%M%S")
    written = core.write_records(db, report.records.values(), batch)
    return {"ok": True, "mode": "commit", "written": written, "importBatch": batch, **summary}


def respond(method: str, payload: Any, *, passcode: str, get_db: Callable[[], Any]) -> tuple[int, dict[str, Any]]:
    """HTTP 層：回傳 (status, JSON body)。get_db 延遲呼叫，只有通過驗證才會連資料庫。"""
    if method != "POST":
        return 405, {"ok": False, "error": "只接受 POST"}

    class _LazyDb:
        def __getattr__(self, name):
            return getattr(get_db(), name)

    try:
        return 200, handle_upload(payload, passcode=passcode, db=_LazyDb())
    except UploadError as exc:
        return exc.status, {"ok": False, "error": exc.message}
    except Exception as exc:  # 未預期錯誤：記錄細節，不把內部訊息回給使用者
        print(f"❌ upload_media_exposure 失敗: {type(exc).__name__}: {exc}")
        return 500, {"ok": False, "error": "伺服器處理失敗，請稍後再試"}
