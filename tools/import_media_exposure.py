"""Import manually verified media exposure workbooks into Firestore (CLI).

Safety defaults:
  * Running without ``--copy`` is read-only and only prints a dry-run report.
  * Source workbooks are never modified.
  * Public records never contain internal notes, source filenames, or row numbers.
  * Firestore writes require an explicit project id and approval flag.
  * The importer never deletes documents.

解析／去重／寫入邏輯在 functions/media_exposure.py（網站上傳功能共用）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "functions"))

from media_exposure import (  # noqa: E402,F401  (部分名稱供測試與外部直接引用)
    DEST_PROJECT, PUBLIC_COLLECTION, PRIVATE_COLLECTION, TAIPEI,
    ExposureRecord, ParseReport,
    canonicalize_url, normalize_media, parse_workbooks, write_records,
)


def build_client(project_id: str, credentials_path: str | None = None):
    if project_id != DEST_PROJECT:
        raise RuntimeError(f"拒絕寫入非目標專案：{project_id}")
    import firebase_admin
    from firebase_admin import credentials, firestore

    app_name = "media-exposure-import"
    try:
        app = firebase_admin.get_app(app_name)
    except ValueError:
        if credentials_path:
            path = Path(credentials_path)
            if not path.is_file():
                raise RuntimeError("指定的 Service Account 檔案不存在")
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError("Service Account 檔案無法讀取或格式錯誤") from exc
            if payload.get("project_id") != project_id:
                raise RuntimeError("Service Account 所屬專案與 --project 不一致")
            cred = credentials.Certificate(str(path))
            app = firebase_admin.initialize_app(cred, {"projectId": project_id}, name=app_name)
        else:
            app = firebase_admin.initialize_app(options={"projectId": project_id}, name=app_name)
    return firestore.client(app=app)


def _json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="人工媒體曝光 Excel 匯入工具（預設 dry-run）")
    parser.add_argument("workbooks", nargs="+", type=Path, help="一個或多個 .xlsx 檔案")
    parser.add_argument("--report", type=Path, help="將 dry-run 摘要寫成 JSON（不含新聞內容）")
    parser.add_argument("--copy", action="store_true", help="實際寫入 Firestore")
    parser.add_argument(
        "--approve-skipping-invalid",
        type=int,
        metavar="COUNT",
        help="明確核准略過的無效列數；必須與 dry-run 實際數量完全相同",
    )
    parser.add_argument("--project", default=DEST_PROJECT)
    parser.add_argument("--credentials", default=os.getenv("FIREBASE_SERVICE_ACCOUNT"))
    parser.add_argument("--i-approve-writing-to-transcend-news-tbm", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    missing = [str(path) for path in args.workbooks if not path.is_file()]
    if missing:
        print("找不到檔案：" + "、".join(missing), file=sys.stderr)
        return 2

    report = parse_workbooks(args.workbooks)
    payload = {
        "mode": "copy" if args.copy else "dry-run",
        "project": args.project,
        **report.summary(),
        "invalid_details": report.invalid_rows,
    }
    print(json.dumps(_json_safe(payload), ensure_ascii=False, indent=2))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(_json_safe(payload), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    if not args.copy:
        return 0
    if not args.i_approve_writing_to_transcend_news_tbm:
        print("拒絕寫入：缺少明確核准旗標", file=sys.stderr)
        return 2
    if args.project != DEST_PROJECT:
        print("拒絕寫入：--project 必須是 transcend-news-tbm", file=sys.stderr)
        return 2
    if report.invalid_rows and args.approve_skipping_invalid != len(report.invalid_rows):
        print(
            "拒絕寫入：仍有無效資料列。請先修正，或用 "
            f"--approve-skipping-invalid {len(report.invalid_rows)} 明確核准略過",
            file=sys.stderr,
        )
        return 1

    db = build_client(args.project, args.credentials)
    batch_name = "media-exposure-" + datetime.now(TAIPEI).strftime("%Y%m%d-%H%M%S")
    written = write_records(db, report.records.values(), batch_name)
    print(f"完成：寫入 {written} 筆公開資料與 {written} 筆私密來源資料")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
