from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .app_paths import STORE_DIR, SNAPSHOT_PATH


def _ensure_store_dir() -> None:
    STORE_DIR.mkdir(parents=True, exist_ok=True)


def _parse_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        # 允许 ISO8601
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def read_snapshot() -> Optional[Dict[str, Any]]:
    if not SNAPSHOT_PATH.exists():
        return None
    try:
        raw = SNAPSHOT_PATH.read_text(encoding="utf-8")
        return json.loads(raw)
    except Exception:
        return None


def write_snapshot(snapshot: Dict[str, Any]) -> None:
    _ensure_store_dir()
    SNAPSHOT_PATH.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")


def should_accept_incoming(existing: Optional[Dict[str, Any]], incoming: Dict[str, Any]) -> Tuple[bool, str]:
    """
    简单冲突策略：以 exported_at 为准，拒绝写入更旧的快照。
    """
    inc_ts = _parse_dt(incoming.get("exported_at"))
    if inc_ts is None:
        return False, "incoming snapshot missing exported_at"

    if existing is None:
        return True, "no existing snapshot"

    ex_ts = _parse_dt(existing.get("exported_at"))
    if ex_ts is None:
        return True, "existing snapshot missing exported_at"

    if inc_ts >= ex_ts:
        return True, "incoming is newer or equal"
    return False, "incoming snapshot is older than existing"

