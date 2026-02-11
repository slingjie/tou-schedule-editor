from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from .cleaner import CleanResult


def _format_iso(dt: pd.Timestamp) -> str:
    return dt.to_pydatetime().isoformat()


def _collect_anomalies(raw: pd.DataFrame, total: int) -> Tuple[List[Dict], Dict]:
    """收集异常值统计，并按天聚合异常情况。
    
    返回:
        (anomalies_list, daily_anomaly_summary)
        - anomalies_list: 原有的异常统计列表
        - daily_anomaly_summary: 按天聚合的异常详情
    """
    results: List[Dict] = []
    conditions = {
        "null": raw["load"].isna(),
        "zero": (raw["load"].fillna(0) == 0) & (raw["load"].notna()),
        "negative": (raw["load"].fillna(0) < 0) & (raw["load"].notna()),
    }

    # 按天聚合异常统计
    raw_with_date = raw.copy()
    raw_with_date["date"] = pd.to_datetime(raw_with_date["timestamp"], errors="coerce").dt.date
    
    daily_anomaly_summary: Dict[str, Dict] = {}  # date -> {zero_count, negative_count, null_count}
    
    for kind, mask in conditions.items():
        count = int(mask.sum())
        ratio = round(count / total, 6) if total else 0.0
        timestamps = raw.loc[mask, "timestamp"].dropna().head(10)
        samples = [_format_iso(ts) for ts in timestamps]
        results.append({
            "kind": kind,
            "count": count,
            "ratio": ratio,
            "samples": samples,
        })
        
        # 按天聚合
        if count > 0:
            dates_with_anomaly = raw_with_date.loc[mask, "date"].dropna()
            for d in dates_with_anomaly:
                date_str = str(d)
                if date_str not in daily_anomaly_summary:
                    daily_anomaly_summary[date_str] = {"zero_count": 0, "negative_count": 0, "null_count": 0}
                daily_anomaly_summary[date_str][f"{kind}_count"] += 1

    return results, daily_anomaly_summary


def _collect_missing(raw: pd.DataFrame) -> Dict:
    """对原始数据进行完整性分析，按月分类统计缺失情况。

    逻辑说明：
    - 以导入数据的最晚一天为锚点，往前推364天（共365天）作为期望窗口
    - 不区分年份，只要保证导入的数据是完整的按顺序的365天
    - 统计完全缺失的天数和部分缺失小时数
    - 按月份分类返回缺失情况
    """

    raw = raw.copy()
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], errors="coerce")
    raw = raw.dropna(subset=["timestamp"])

    if raw.empty:
        return {
            "missing_days": [],
            "missing_hours_by_month": [],
            "partial_missing_days": [],
            "summary": {
                "total_missing_days": 0,
                "total_missing_hours": 0,
                "total_partial_missing_days": 0,
                "expected_days": 365,
                "actual_days": 0,
                "completeness_ratio": 0.0,
            }
        }

    # 提取所有存在的小时时间戳（去重并转为小时精度）
    timestamps = pd.to_datetime(raw["timestamp"].unique())
    # 转换为小时精度的时间戳
    hour_timestamps = pd.Series(timestamps).dt.floor("h").unique()
    hour_timestamps = pd.to_datetime(hour_timestamps)
    
    if len(hour_timestamps) == 0:
        return {
            "missing_days": [],
            "missing_hours_by_month": [],
            "partial_missing_days": [],
            "summary": {
                "total_missing_days": 0,
                "total_missing_hours": 0,
                "total_partial_missing_days": 0,
                "expected_days": 365,
                "actual_days": 0,
                "completeness_ratio": 0.0,
            }
        }

    # 构造期望的365天窗口（以最后一天为锚点，往前推364天）
    end_day = hour_timestamps.max().normalize()
    expected_start_day = (end_day - pd.Timedelta(days=364)).normalize()
    expected_days = pd.date_range(expected_start_day, end_day, freq="D")
    
    # 构造期望的完整小时序列（365天 × 24小时 = 8760小时）
    expected_hours = pd.date_range(expected_start_day, end_day + pd.Timedelta(hours=23), freq="h")
    present_hours_set = set(hour_timestamps)

    # 按天统计：哪些天完全缺失，哪些天部分缺失
    missing_days: List[str] = []
    partial_missing_days: List[Dict] = []
    
    for day in expected_days:
        day_start = day
        day_end = day + pd.Timedelta(hours=23)
        day_hours = pd.date_range(day_start, day_end, freq="h")
        
        present_count = sum(1 for h in day_hours if h in present_hours_set)
        missing_count = 24 - present_count
        
        if present_count == 0:
            # 完全缺失
            missing_days.append(day.strftime("%Y-%m-%d"))
        elif missing_count > 0:
            # 部分缺失
            partial_missing_days.append({
                "date": day.strftime("%Y-%m-%d"),
                "present_hours": present_count,
                "missing_hours": missing_count,
            })

    # 按月分类统计
    missing_hours_by_month: List[Dict] = []
    total_missing_hours = 0

    # 对齐到期望窗口的月份范围
    for month_start in pd.date_range(expected_start_day, end_day, freq="MS"):
        month_end = min(
            (month_start + pd.DateOffset(months=1)) - pd.Timedelta(days=1),
            end_day
        )
        month_days = pd.date_range(month_start.normalize(), month_end.normalize(), freq="D")

        month_missing_days = 0
        month_missing_hours = 0
        
        for day in month_days:
            day_start = day
            day_end = day + pd.Timedelta(hours=23)
            day_hours = pd.date_range(day_start, day_end, freq="h")
            
            present_count = sum(1 for h in day_hours if h in present_hours_set)
            missing_count = 24 - present_count
            
            if present_count == 0:
                month_missing_days += 1
            month_missing_hours += missing_count

        month_str = month_start.strftime("%Y-%m")

        if month_missing_hours > 0:
            missing_hours_by_month.append({
                "month": month_str,
                "missing_days": month_missing_days,
                "missing_hours": month_missing_hours,
            })
            total_missing_hours += month_missing_hours

    # 计算实际覆盖的天数
    present_days_set = set(pd.to_datetime(h).normalize() for h in present_hours_set)
    actual_days_in_window = sum(1 for day in expected_days if day in present_days_set)
    completeness_ratio = actual_days_in_window / 365.0 if 365 > 0 else 0.0

    return {
        "missing_days": missing_days,
        "missing_hours_by_month": missing_hours_by_month,
        "partial_missing_days": partial_missing_days,
        "summary": {
            "total_missing_days": len(missing_days),
            "total_missing_hours": total_missing_hours,
            "total_partial_missing_days": len(partial_missing_days),
            "expected_days": 365,
            "actual_days": actual_days_in_window,
            "completeness_ratio": round(completeness_ratio, 4),
        }
    }


def _collect_zero_spans(result: CleanResult) -> List[Dict]:
    index = result.hourly_energy.index
    values = result.hourly_energy.to_numpy()
    present = (~result.missing_hours).to_numpy()

    zero_mask = np.isclose(values, 0.0, atol=1e-6) & present

    spans: List[Dict] = []
    start_ts = None
    length = 0

    for idx, is_zero in enumerate(zero_mask):
        if is_zero:
            if start_ts is None:
                start_ts = index[idx]
                length = 1
            else:
                length += 1
        else:
            if start_ts is not None:
                end_ts = index[idx - 1]
                spans.append({
                    "start": _format_iso(start_ts),
                    "end": _format_iso(end_ts),
                    "length_hours": length,
                })
                start_ts = None
                length = 0

    if start_ts is not None:
        end_ts = index[len(zero_mask) - 1]
        spans.append({
            "start": _format_iso(start_ts),
            "end": _format_iso(end_ts),
            "length_hours": length,
        })

    return spans


def build_quality_report(raw: pd.DataFrame) -> Tuple[Dict, Dict]:
    """对原始数据进行完整性分析，不涉及数据清洗。

    参数:
        raw: 原始数据框，包含 'timestamp' 和 'load' 列

    返回:
        (report_dict, meta_dict) 元组
    """
    total_records = len(raw)

    raw_copy = raw.copy()
    raw_copy["timestamp"] = pd.to_datetime(raw_copy["timestamp"], errors="coerce")
    raw_valid = raw_copy.dropna(subset=["timestamp"])

    if raw_valid.empty:
        return {
            "missing": {
                "missing_days": [],
                "missing_hours_by_month": [],
                "partial_missing_days": [],
                "summary": {
                    "total_missing_days": 0,
                    "total_missing_hours": 0,
                    "total_partial_missing_days": 0,
                    "expected_days": 365,
                    "actual_days": 0,
                    "completeness_ratio": 0.0,
                }
            },
            "anomalies": [],
            "daily_anomalies": [],
            "continuous_zero_spans": [],
        }, {
            "source_interval_minutes": 0,
            "total_records": total_records,
            "start": None,
            "end": None,
        }

    timestamps = raw_valid["timestamp"]
    time_range_start = timestamps.min()
    time_range_end = timestamps.max()
    
    # 计算负荷统计数据
    raw_copy["load"] = pd.to_numeric(raw_copy["load"], errors="coerce")
    load_valid = raw_copy["load"].dropna()
    
    if len(load_valid) > 0:
        avg_load_kw = float(load_valid.mean())
        max_load_kw = float(load_valid.max())
        min_load_kw = float(load_valid.min())
    else:
        avg_load_kw = 0.0
        max_load_kw = 0.0
        min_load_kw = 0.0

    # 收集异常值统计
    anomalies_list, daily_anomaly_summary = _collect_anomalies(raw_copy, total_records)
    
    # 将按天异常汇总转为列表，便于前端展示
    daily_anomalies: List[Dict] = []
    for date_str, counts in sorted(daily_anomaly_summary.items()):
        daily_anomalies.append({
            "date": date_str,
            "zero_count": counts.get("zero_count", 0),
            "negative_count": counts.get("negative_count", 0),
            "null_count": counts.get("null_count", 0),
        })

    report = {
        "missing": _collect_missing(raw_copy),
        "anomalies": anomalies_list,
        "daily_anomalies": daily_anomalies,
        "continuous_zero_spans": [],  # 不再分析连续零段
    }

    meta = {
        "source_interval_minutes": 0,  # 原始数据不确定采样间隔，设为0
        "total_records": total_records,
        "start": _format_iso(time_range_start),
        "end": _format_iso(time_range_end),
        "avg_load_kw": round(avg_load_kw, 2),
        "max_load_kw": round(max_load_kw, 2),
        "min_load_kw": round(min_load_kw, 2),
    }

    return report, meta
