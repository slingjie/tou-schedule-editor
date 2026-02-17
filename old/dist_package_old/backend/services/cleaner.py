from __future__ import annotations

from dataclasses import dataclass
import logging

import pandas as pd

logger = logging.getLogger("load-analysis")


class CleaningError(ValueError):
    """清洗过程中出现的问题。"""


@dataclass
class CleanResult:
    hourly_energy: pd.Series
    missing_hours: pd.Series
    interval_minutes: int


def _infer_interval_minutes(timestamps: pd.Series) -> int:
    diffs = timestamps.sort_values().diff().dropna()
    if diffs.empty:
        return 60

    minutes = diffs.dt.total_seconds() / 60
    minutes = minutes[minutes > 0]
    if minutes.empty:
        return 60

    mode_value = minutes.mode().iloc[0]
    interval = int(round(mode_value))
    return max(interval, 1)


def clean_and_aggregate(df: pd.DataFrame) -> CleanResult:
    if df.empty:
        raise CleaningError("缺少有效数据记录。")

    logger.debug("开始清洗：记录数=%s", len(df))
    working = df.copy()
    working = working.sort_values("timestamp")
    before = len(working)
    working = working.drop_duplicates(subset=["timestamp"], keep="first")
    logger.debug("去重后：%s -> %s", before, len(working))

    if working["load"].dropna().empty:
        raise CleaningError("负荷列全部为空，无法计算。")

    interval_minutes = _infer_interval_minutes(working["timestamp"])
    logger.debug("推断采样间隔（分钟）=%s", interval_minutes)

    working.set_index("timestamp", inplace=True)
    working.index = working.index.tz_localize(None)

    # 时间插值保障后续聚合可执行
    working["load"] = working["load"].interpolate(method="time", limit_direction="both")
    working["load"] = working["load"].fillna(method="ffill").fillna(method="bfill")

    interval_hours = max(interval_minutes / 60.0, 1e-9)
    hourly = working["load"].resample("1H").sum(min_count=1) * interval_hours
    if not hourly.index.empty:
        logger.debug(
            "聚合后小时序列：范围=%s ~ %s，长度=%s",
            hourly.index.min(),
            hourly.index.max(),
            len(hourly),
        )

    missing_hours = hourly.isna()

    if hourly.index.empty:
        raise CleaningError("无法生成小时级数据，请检查时间戳是否连续。")

    full_index = pd.date_range(hourly.index.min(), hourly.index.max(), freq="1H")
    hourly = hourly.reindex(full_index)
    missing_hours = missing_hours.reindex(full_index, fill_value=True)

    hourly = hourly.fillna(0.0)

    return CleanResult(hourly_energy=hourly, missing_hours=missing_hours, interval_minutes=interval_minutes)
