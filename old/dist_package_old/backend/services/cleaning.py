"""
数据清洗服务模块

职责：
- 检测零值/负值/空值时段
- 提供零值时段的周边数据参考
- 实现自适应插值策略
- 支持清洗预览和应用
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any, Union

import numpy as np
import pandas as pd

logger = logging.getLogger("load-analysis")


# ============================================================================
# 数据结构定义
# ============================================================================

@dataclass
class ZeroSpanDetail:
    """零值时段详情"""
    id: str
    start_time: str              # ISO格式
    end_time: str                # ISO格式
    duration_hours: float
    point_count: int = 0         # 数据点数量
    
    # 周边数据参考
    prev_day_avg_load: Optional[float] = None      # 前一天同时段平均负荷
    next_day_avg_load: Optional[float] = None      # 后一天同时段平均负荷
    prev_month_same_day_avg: Optional[float] = None  # 上月同日平均负荷
    next_month_same_day_avg: Optional[float] = None  # 下月同日平均负荷
    
    # 日期标签
    weekday: str = ""            # "周一" ~ "周日"
    is_holiday: bool = False     # 是否节假日（暂不实现）
    
    # 用户判断
    user_decision: Optional[str] = None  # 'normal' | 'abnormal' | None


@dataclass
class NullSpanDetail:
    """空值时段详情"""
    id: str
    start_time: str              # ISO格式
    end_time: str                # ISO格式
    duration_hours: float
    point_count: int
    weekday: str = ""            # "周一" ~ "周日"


@dataclass
class NegativeSpanDetail:
    """负值时段详情"""
    id: str
    date: str
    start_hour: int
    end_hour: int
    min_value: float             # 最小负值
    max_value: float             # 最大负值（绝对值最小）
    point_count: int
    treatment: str = "keep"      # 'keep' | 'abs' | 'zero'


@dataclass
class CleaningAnalysis:
    """清洗分析结果"""
    # 空值统计
    null_point_count: int = 0
    null_hours: float = 0.0
    null_spans: List[NullSpanDetail] = field(default_factory=list)  # 空值时段列表
    
    # 零值时段
    zero_spans: List[ZeroSpanDetail] = field(default_factory=list)
    total_zero_hours: float = 0.0
    
    # 负值时段
    negative_spans: List[NegativeSpanDetail] = field(default_factory=list)
    total_negative_points: int = 0
    
    # 数据完整度
    total_expected_points: int = 0
    total_actual_points: int = 0
    completeness_ratio: float = 0.0


@dataclass
class CleaningConfig:
    """清洗配置"""
    # 空值策略: 'interpolate' | 'delete' | 'keep'
    null_strategy: str = "interpolate"
    
    # 负值策略: 'keep' | 'abs' | 'zero'
    negative_strategy: str = "keep"
    
    # 零值判断（按时段ID）
    zero_decisions: Dict[str, str] = field(default_factory=dict)  # span_id -> 'normal' | 'abnormal'


@dataclass
class CleaningResult:
    """清洗结果"""
    cleaned_df: pd.DataFrame
    original_df: pd.DataFrame
    
    # 清洗操作统计
    null_points_interpolated: int = 0
    zero_spans_kept: int = 0
    zero_spans_interpolated: int = 0
    negative_points_kept: int = 0
    negative_points_modified: int = 0
    
    # 插值标记
    interpolated_mask: pd.Series = field(default_factory=lambda: pd.Series(dtype=bool))


# ============================================================================
# 中文星期映射
# ============================================================================

WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def _get_weekday_name(dt: datetime) -> str:
    """获取中文星期名称"""
    return WEEKDAY_NAMES[dt.weekday()]


# ============================================================================
# 零值时段检测
# ============================================================================

def _find_zero_spans(
    df: pd.DataFrame,
    min_duration_hours: float = 1.0,
) -> List[Tuple[pd.Timestamp, pd.Timestamp]]:
    """找出连续零值时段
    
    参数:
        df: 包含 timestamp 索引和 load_kw 列的 DataFrame
        min_duration_hours: 最小连续时长（小时），默认1小时
        
    返回:
        [(start_time, end_time), ...] 列表
    """
    if df.empty or "load_kw" not in df.columns:
        return []
    
    # 确保索引是 DatetimeIndex
    if not isinstance(df.index, pd.DatetimeIndex):
        return []
    
    # 识别零值点（包括非常接近零的值）
    is_zero_arr = np.isclose(df["load_kw"].fillna(0).values, 0.0, atol=1e-6)
    # 转为 Series 以便用索引访问
    is_zero = pd.Series(is_zero_arr, index=df.index)
    
    spans: List[Tuple[pd.Timestamp, pd.Timestamp]] = []
    start_ts: Optional[pd.Timestamp] = None
    
    sorted_index = df.index.sort_values()
    
    for i, ts in enumerate(sorted_index):
        if is_zero[ts]:
            if start_ts is None:
                start_ts = ts
        else:
            if start_ts is not None:
                end_ts = sorted_index[i - 1]
                # 计算时长
                duration = (end_ts - start_ts).total_seconds() / 3600.0
                if duration >= min_duration_hours:
                    spans.append((start_ts, end_ts))
                start_ts = None
    
    # 处理末尾的零值段
    if start_ts is not None:
        end_ts = sorted_index[-1]
        duration = (end_ts - start_ts).total_seconds() / 3600.0
        if duration >= min_duration_hours:
            spans.append((start_ts, end_ts))
    
    return spans


def _get_neighbor_avg_load(
    df: pd.DataFrame,
    target_date: datetime,
    start_hour: int,
    end_hour: int,
    offset_days: int,
) -> Optional[float]:
    """获取邻近日期同时段的平均负荷
    
    参数:
        df: 数据
        target_date: 目标日期
        start_hour: 开始小时
        end_hour: 结束小时
        offset_days: 偏移天数（正数为后，负数为前）
        
    返回:
        平均负荷或 None
    """
    neighbor_date = target_date + timedelta(days=offset_days)
    
    try:
        # 构造时间范围
        start_dt = datetime(neighbor_date.year, neighbor_date.month, neighbor_date.day, start_hour)
        end_dt = datetime(neighbor_date.year, neighbor_date.month, neighbor_date.day, end_hour)
        
        # 筛选数据
        mask = (df.index >= start_dt) & (df.index <= end_dt)
        subset = df.loc[mask, "load_kw"]
        
        if subset.empty or subset.isna().all():
            return None
        
        avg = float(subset.mean())
        return avg if not np.isnan(avg) else None
    except Exception:
        return None


def _get_same_day_prev_next_month_avg(
    df: pd.DataFrame,
    target_date: datetime,
) -> Tuple[Optional[float], Optional[float]]:
    """获取上月和下月同日的平均负荷
    
    参数:
        df: 数据
        target_date: 目标日期
        
    返回:
        (上月同日平均, 下月同日平均)
    """
    day = target_date.day
    
    # 上月同日
    prev_month_avg = None
    try:
        if target_date.month == 1:
            prev_month = datetime(target_date.year - 1, 12, min(day, 31))
        else:
            prev_month_days = (datetime(target_date.year, target_date.month, 1) - timedelta(days=1)).day
            prev_month = datetime(target_date.year, target_date.month - 1, min(day, prev_month_days))
        
        start_dt = datetime(prev_month.year, prev_month.month, prev_month.day, 0)
        end_dt = datetime(prev_month.year, prev_month.month, prev_month.day, 23, 59, 59)
        mask = (df.index >= start_dt) & (df.index <= end_dt)
        subset = df.loc[mask, "load_kw"]
        if not subset.empty and not subset.isna().all():
            prev_month_avg = float(subset.mean())
    except Exception:
        pass
    
    # 下月同日
    next_month_avg = None
    try:
        if target_date.month == 12:
            next_month = datetime(target_date.year + 1, 1, min(day, 31))
        else:
            # 获取下月天数
            if target_date.month + 1 == 12:
                next_month_days = 31
            else:
                next_month_days = (datetime(target_date.year, target_date.month + 2, 1) - timedelta(days=1)).day
            next_month = datetime(target_date.year, target_date.month + 1, min(day, next_month_days))
        
        start_dt = datetime(next_month.year, next_month.month, next_month.day, 0)
        end_dt = datetime(next_month.year, next_month.month, next_month.day, 23, 59, 59)
        mask = (df.index >= start_dt) & (df.index <= end_dt)
        subset = df.loc[mask, "load_kw"]
        if not subset.empty and not subset.isna().all():
            next_month_avg = float(subset.mean())
    except Exception:
        pass
    
    return prev_month_avg, next_month_avg


def analyze_null_spans(
    df: pd.DataFrame,
    min_consecutive: int = 1,
) -> List[NullSpanDetail]:
    """分析空值时段，找出连续的空值区间
    
    参数:
        df: 包含 timestamp 索引和 load_kw 列的 DataFrame
        min_consecutive: 最小连续点数（默认1，即单个空值也算一个时段）
        
    返回:
        空值时段详情列表
    """
    if df.empty or "load_kw" not in df.columns:
        return []
    
    null_mask = df["load_kw"].isna()
    if not null_mask.any():
        return []
    
    # 推断时间间隔
    if len(df) > 1:
        diffs = df.index.to_series().diff().dropna()
        if not diffs.empty:
            interval = diffs.mode().iloc[0] if len(diffs.mode()) > 0 else pd.Timedelta(minutes=15)
        else:
            interval = pd.Timedelta(minutes=15)
    else:
        interval = pd.Timedelta(minutes=15)
    
    interval_minutes = interval.total_seconds() / 60.0
    
    # 找连续空值区间
    null_indices = df.index[null_mask]
    if len(null_indices) == 0:
        return []
    
    spans: List[NullSpanDetail] = []
    span_start = null_indices[0]
    span_end = null_indices[0]
    point_count = 1
    
    for i in range(1, len(null_indices)):
        current = null_indices[i]
        prev = null_indices[i - 1]
        
        # 判断是否连续（允许一个时间间隔的容差）
        if (current - prev) <= interval * 1.5:
            span_end = current
            point_count += 1
        else:
            # 保存上一个时段
            if point_count >= min_consecutive:
                duration = (span_end - span_start).total_seconds() / 3600.0 + (interval_minutes / 60.0)
                spans.append(NullSpanDetail(
                    id=f"null_{len(spans)+1}",
                    start_time=span_start.isoformat(),
                    end_time=span_end.isoformat(),
                    duration_hours=round(duration, 2),
                    point_count=point_count,
                    weekday=_get_weekday_name(span_start.to_pydatetime()),
                ))
            # 开始新时段
            span_start = current
            span_end = current
            point_count = 1
    
    # 保存最后一个时段
    if point_count >= min_consecutive:
        duration = (span_end - span_start).total_seconds() / 3600.0 + (interval_minutes / 60.0)
        spans.append(NullSpanDetail(
            id=f"null_{len(spans)+1}",
            start_time=span_start.isoformat(),
            end_time=span_end.isoformat(),
            duration_hours=round(duration, 2),
            point_count=point_count,
            weekday=_get_weekday_name(span_start.to_pydatetime()),
        ))
    
    return spans


def analyze_zero_spans(
    df: pd.DataFrame,
    min_duration_hours: float = 1.0,
) -> List[ZeroSpanDetail]:
    """分析零值时段，生成详细信息
    
    参数:
        df: 包含 timestamp 索引和 load_kw 列的 DataFrame
        min_duration_hours: 最小连续时长
        
    返回:
        零值时段详情列表
    """
    spans = _find_zero_spans(df, min_duration_hours)
    
    results: List[ZeroSpanDetail] = []
    
    for i, (start_ts, end_ts) in enumerate(spans):
        span_id = f"zero_{i+1}"
        duration = (end_ts - start_ts).total_seconds() / 3600.0
        
        # 计算时段内的点数
        span_mask = (df.index >= start_ts) & (df.index <= end_ts)
        point_count = int(span_mask.sum())
        
        target_date = start_ts.to_pydatetime()
        start_hour = start_ts.hour
        end_hour = end_ts.hour
        
        # 获取周边数据
        prev_day_avg = _get_neighbor_avg_load(df, target_date, start_hour, end_hour, -1)
        next_day_avg = _get_neighbor_avg_load(df, target_date, start_hour, end_hour, 1)
        prev_month_avg, next_month_avg = _get_same_day_prev_next_month_avg(df, target_date)
        
        detail = ZeroSpanDetail(
            id=span_id,
            start_time=start_ts.isoformat(),
            end_time=end_ts.isoformat(),
            duration_hours=round(duration, 2),
            point_count=point_count,
            prev_day_avg_load=round(prev_day_avg, 2) if prev_day_avg is not None else None,
            next_day_avg_load=round(next_day_avg, 2) if next_day_avg is not None else None,
            prev_month_same_day_avg=round(prev_month_avg, 2) if prev_month_avg is not None else None,
            next_month_same_day_avg=round(next_month_avg, 2) if next_month_avg is not None else None,
            weekday=_get_weekday_name(target_date),
            is_holiday=False,  # 暂不实现节假日检测
            user_decision=None,
        )
        results.append(detail)
    
    return results


# ============================================================================
# 负值时段检测
# ============================================================================

def analyze_negative_spans(df: pd.DataFrame) -> List[NegativeSpanDetail]:
    """分析负值时段
    
    参数:
        df: 包含 timestamp 索引和 load_kw 列的 DataFrame
        
    返回:
        负值时段详情列表
    """
    if df.empty or "load_kw" not in df.columns:
        return []
    
    # 筛选负值点
    neg_mask = df["load_kw"] < 0
    neg_df = df.loc[neg_mask].copy()
    
    if neg_df.empty:
        return []
    
    # 按日期分组
    neg_df["date"] = neg_df.index.date
    
    results: List[NegativeSpanDetail] = []
    
    for date_val, group in neg_df.groupby("date"):
        date_str = str(date_val)
        hours = sorted(set(group.index.hour))
        
        # 找连续时段
        spans: List[Tuple[int, int]] = []
        start_h = hours[0]
        prev_h = hours[0]
        
        for h in hours[1:]:
            if h == prev_h + 1:
                prev_h = h
            else:
                spans.append((start_h, prev_h))
                start_h = h
                prev_h = h
        spans.append((start_h, prev_h))
        
        for i, (sh, eh) in enumerate(spans):
            span_id = f"neg_{date_str}_{i+1}"
            subset = group.loc[group.index.hour.isin(range(sh, eh + 1))]
            
            detail = NegativeSpanDetail(
                id=span_id,
                date=date_str,
                start_hour=sh,
                end_hour=eh + 1,  # 半开区间
                min_value=round(float(subset["load_kw"].min()), 2),
                max_value=round(float(subset["load_kw"].max()), 2),
                point_count=len(subset),
                treatment="keep",
            )
            results.append(detail)
    
    return results


# ============================================================================
# 完整清洗分析
# ============================================================================

def analyze_data_for_cleaning(
    df: pd.DataFrame,
    interval_minutes: int = 15,
) -> CleaningAnalysis:
    """分析数据，生成清洗分析报告
    
    参数:
        df: 包含 timestamp 索引和 load_kw 列的 DataFrame
        interval_minutes: 数据采样间隔（分钟）
        
    返回:
        CleaningAnalysis 对象
    """
    if df.empty:
        return CleaningAnalysis()
    
    # 确保索引是 DatetimeIndex
    if not isinstance(df.index, pd.DatetimeIndex):
        logger.warning("DataFrame 索引不是 DatetimeIndex，无法分析")
        return CleaningAnalysis()
    
    # 空值统计
    null_mask = df["load_kw"].isna()
    null_count = int(null_mask.sum())
    null_hours = null_count * (interval_minutes / 60.0)
    
    # 空值时段分析
    null_spans = analyze_null_spans(df, min_consecutive=1)
    
    # 零值时段分析
    zero_spans = analyze_zero_spans(df, min_duration_hours=1.0)
    total_zero_hours = sum(span.duration_hours for span in zero_spans)
    
    # 负值时段分析
    negative_spans = analyze_negative_spans(df)
    total_negative_points = sum(span.point_count for span in negative_spans)
    
    # 数据完整度计算
    if not df.index.empty:
        start_dt = df.index.min()
        end_dt = df.index.max()
        expected_points = int((end_dt - start_dt).total_seconds() / (interval_minutes * 60)) + 1
    else:
        expected_points = 0
    
    actual_points = len(df) - null_count
    completeness = actual_points / expected_points if expected_points > 0 else 0.0
    
    return CleaningAnalysis(
        null_point_count=null_count,
        null_hours=round(null_hours, 2),
        null_spans=null_spans,
        zero_spans=zero_spans,
        total_zero_hours=round(total_zero_hours, 2),
        negative_spans=negative_spans,
        total_negative_points=total_negative_points,
        total_expected_points=expected_points,
        total_actual_points=actual_points,
        completeness_ratio=round(completeness, 4),
    )


# ============================================================================
# 插值策略实现
# ============================================================================

def _linear_interpolate(
    series: pd.Series,
    mask: pd.Series,
) -> pd.Series:
    """线性插值
    
    参数:
        series: 原始序列
        mask: 需要插值的位置（True 表示需要插值）
        
    返回:
        插值后的序列
    """
    result = series.copy()
    result.loc[mask] = np.nan
    result = result.interpolate(method="time", limit_direction="both")
    # 边界处理：如果首尾仍有 NaN，使用前向/后向填充
    result = result.ffill().bfill()
    return result


def _neighbor_day_interpolate(
    df: pd.DataFrame,
    mask: pd.Series,
) -> pd.Series:
    """使用邻近天同时段平均值插值
    
    参数:
        df: 原始数据（含 load_kw 列）
        mask: 需要插值的位置
        
    返回:
        插值后的 load_kw 序列
    """
    result = df["load_kw"].copy()
    
    for ts in df.index[mask]:
        hour = ts.hour
        
        # 获取前后一天同时段的值
        prev_day = ts - pd.Timedelta(days=1)
        next_day = ts + pd.Timedelta(days=1)
        
        values = []
        
        # 前一天同时段
        prev_mask = (df.index.date == prev_day.date()) & (df.index.hour == hour)
        if prev_mask.any():
            val = df.loc[prev_mask, "load_kw"].mean()
            if not np.isnan(val):
                values.append(val)
        
        # 后一天同时段
        next_mask = (df.index.date == next_day.date()) & (df.index.hour == hour)
        if next_mask.any():
            val = df.loc[next_mask, "load_kw"].mean()
            if not np.isnan(val):
                values.append(val)
        
        if values:
            result.loc[ts] = np.mean(values)
        else:
            # 回退到线性插值
            result.loc[ts] = np.nan
    
    # 处理剩余的 NaN
    result = result.interpolate(method="time", limit_direction="both")
    result = result.ffill().bfill()
    
    return result


def _weekday_weighted_interpolate(
    df: pd.DataFrame,
    mask: pd.Series,
) -> pd.Series:
    """使用同周几历史加权平均插值
    
    参数:
        df: 原始数据
        mask: 需要插值的位置
        
    返回:
        插值后的序列
    """
    result = df["load_kw"].copy()
    
    for ts in df.index[mask]:
        weekday = ts.weekday()
        hour = ts.hour
        
        # 找最近4个同周几、同小时的值
        same_weekday_mask = (
            (df.index.weekday == weekday) &
            (df.index.hour == hour) &
            (~df["load_kw"].isna()) &
            (df.index != ts)
        )
        
        candidates = df.loc[same_weekday_mask, "load_kw"].dropna()
        
        if len(candidates) > 0:
            # 按时间距离加权（越近权重越高）
            time_diffs = abs((candidates.index - ts).total_seconds())
            weights = 1.0 / (time_diffs + 1)
            weighted_avg = np.average(candidates.values, weights=weights)
            result.loc[ts] = weighted_avg
        else:
            result.loc[ts] = np.nan
    
    # 处理剩余的 NaN
    result = result.interpolate(method="time", limit_direction="both")
    result = result.ffill().bfill()
    
    return result


def adaptive_interpolate(
    df: pd.DataFrame,
    mask: Union[pd.Series, np.ndarray],
    interval_minutes: int = 15,
) -> pd.Series:
    """自适应插值策略
    
    根据缺失时长选择不同的插值方法：
    - ≤4小时：线性插值
    - 4~24小时：邻近天同时段平均
    - >24小时：同周几历史加权
    
    参数:
        df: 原始数据
        mask: 需要插值的位置（True 表示需要插值），可以是 Series 或 ndarray
        interval_minutes: 数据间隔
        
    返回:
        插值后的 load_kw 序列
    """
    # 先将 mask 转换为 pandas Series（如果是 numpy array）
    if isinstance(mask, np.ndarray):
        mask = pd.Series(mask, index=df.index)
    
    if not mask.any():
        return df["load_kw"].copy()
    
    result = df["load_kw"].copy()
    
    # 确保 mask 与 df 索引对齐
    if not mask.index.equals(df.index):
        mask = mask.reindex(df.index, fill_value=False)
    
    # 找出连续缺失段
    spans: List[Tuple[pd.Timestamp, pd.Timestamp, int]] = []
    sorted_index = df.index.sort_values()
    
    start_idx: Optional[int] = None
    
    for i, ts in enumerate(sorted_index):
        is_masked = bool(mask.get(ts, False))
        if is_masked:
            if start_idx is None:
                start_idx = i
        else:
            if start_idx is not None:
                end_idx = i - 1
                spans.append((sorted_index[start_idx], sorted_index[end_idx], end_idx - start_idx + 1))
                start_idx = None
    
    if start_idx is not None:
        spans.append((sorted_index[start_idx], sorted_index[-1], len(sorted_index) - start_idx))
    
    # 按缺失时长分组处理
    for start_ts, end_ts, point_count in spans:
        duration_hours = point_count * (interval_minutes / 60.0)
        span_mask = (df.index >= start_ts) & (df.index <= end_ts) & mask
        
        if duration_hours <= 4:
            # 短时间：线性插值
            interpolated = _linear_interpolate(result, span_mask)
            result.loc[span_mask] = interpolated.loc[span_mask]
        elif duration_hours <= 24:
            # 中等时间：邻近天同时段平均
            interpolated = _neighbor_day_interpolate(df, span_mask)
            result.loc[span_mask] = interpolated.loc[span_mask]
        else:
            # 长时间：同周几历史加权
            interpolated = _weekday_weighted_interpolate(df, span_mask)
            result.loc[span_mask] = interpolated.loc[span_mask]
    
    # 最后兜底处理剩余 NaN
    result = result.ffill().bfill()
    
    return result


# ============================================================================
# 清洗应用
# ============================================================================

def apply_cleaning(
    df: pd.DataFrame,
    config: CleaningConfig,
    analysis: CleaningAnalysis,
    interval_minutes: int = 15,
) -> CleaningResult:
    """应用清洗配置
    
    参数:
        df: 原始数据
        config: 清洗配置
        analysis: 清洗分析结果
        interval_minutes: 数据间隔
        
    返回:
        CleaningResult 对象
    """
    original_df = df.copy()
    cleaned_df = df.copy()
    
    interpolated_mask = pd.Series(False, index=df.index)
    
    stats = {
        "null_points_interpolated": 0,
        "zero_spans_kept": 0,
        "zero_spans_interpolated": 0,
        "negative_points_kept": 0,
        "negative_points_modified": 0,
    }
    
    # 1. 处理空值
    null_mask = cleaned_df["load_kw"].isna()
    if null_mask.any():
        if config.null_strategy == "interpolate":
            cleaned_df["load_kw"] = adaptive_interpolate(cleaned_df, null_mask, interval_minutes)
            interpolated_mask |= null_mask
            stats["null_points_interpolated"] = int(null_mask.sum())
        elif config.null_strategy == "delete":
            cleaned_df = cleaned_df.loc[~null_mask].copy()
            interpolated_mask = interpolated_mask.loc[~null_mask]
        # 'keep' 不做处理
    
    # 2. 处理零值时段
    for span in analysis.zero_spans:
        decision = config.zero_decisions.get(span.id, "normal")
        
        start_ts = pd.Timestamp(span.start_time)
        end_ts = pd.Timestamp(span.end_time)
        span_mask = (cleaned_df.index >= start_ts) & (cleaned_df.index <= end_ts)
        
        if decision == "abnormal":
            # 需要插值
            zero_mask = span_mask & np.isclose(cleaned_df["load_kw"].fillna(0), 0.0, atol=1e-6)
            if zero_mask.any():
                cleaned_df["load_kw"] = adaptive_interpolate(cleaned_df, zero_mask, interval_minutes)
                interpolated_mask |= zero_mask
                stats["zero_spans_interpolated"] += 1
        else:
            # 保留
            stats["zero_spans_kept"] += 1
    
    # 3. 处理负值
    neg_mask = cleaned_df["load_kw"] < 0
    if neg_mask.any():
        if config.negative_strategy == "keep":
            stats["negative_points_kept"] = int(neg_mask.sum())
        elif config.negative_strategy == "abs":
            cleaned_df.loc[neg_mask, "load_kw"] = cleaned_df.loc[neg_mask, "load_kw"].abs()
            stats["negative_points_modified"] = int(neg_mask.sum())
        elif config.negative_strategy == "zero":
            cleaned_df.loc[neg_mask, "load_kw"] = 0.0
            stats["negative_points_modified"] = int(neg_mask.sum())
    
    return CleaningResult(
        cleaned_df=cleaned_df,
        original_df=original_df,
        null_points_interpolated=stats["null_points_interpolated"],
        zero_spans_kept=stats["zero_spans_kept"],
        zero_spans_interpolated=stats["zero_spans_interpolated"],
        negative_points_kept=stats["negative_points_kept"],
        negative_points_modified=stats["negative_points_modified"],
        interpolated_mask=interpolated_mask,
    )


# ============================================================================
# 序列化工具
# ============================================================================

def analysis_to_dict(analysis: CleaningAnalysis) -> Dict[str, Any]:
    """将 CleaningAnalysis 转换为字典（用于 API 返回）"""
    return {
        "null_point_count": analysis.null_point_count,
        "null_hours": analysis.null_hours,
        "null_spans": [
            {
                "id": span.id,
                "start_time": span.start_time,
                "end_time": span.end_time,
                "duration_hours": span.duration_hours,
                "point_count": span.point_count,
                "weekday": span.weekday,
            }
            for span in analysis.null_spans
        ],
        "zero_spans": [
            {
                "id": span.id,
                "start_time": span.start_time,
                "end_time": span.end_time,
                "duration_hours": span.duration_hours,
                "point_count": span.point_count,
                "prev_day_avg_load": span.prev_day_avg_load,
                "next_day_avg_load": span.next_day_avg_load,
                "prev_month_same_day_avg": span.prev_month_same_day_avg,
                "next_month_same_day_avg": span.next_month_same_day_avg,
                "weekday": span.weekday,
                "is_holiday": span.is_holiday,
                "user_decision": span.user_decision,
            }
            for span in analysis.zero_spans
        ],
        "total_zero_hours": analysis.total_zero_hours,
        "negative_spans": [
            {
                "id": span.id,
                "date": span.date,
                "start_hour": span.start_hour,
                "end_hour": span.end_hour,
                "min_value": span.min_value,
                "max_value": span.max_value,
                "point_count": span.point_count,
                "treatment": span.treatment,
            }
            for span in analysis.negative_spans
        ],
        "total_negative_points": analysis.total_negative_points,
        "total_expected_points": analysis.total_expected_points,
        "total_actual_points": analysis.total_actual_points,
        "completeness_ratio": analysis.completeness_ratio,
    }


def result_to_dict(result: CleaningResult) -> Dict[str, Any]:
    """将 CleaningResult 转换为字典（用于 API 返回）"""
    return {
        "null_points_interpolated": result.null_points_interpolated,
        "zero_spans_kept": result.zero_spans_kept,
        "zero_spans_interpolated": result.zero_spans_interpolated,
        "negative_points_kept": result.negative_points_kept,
        "negative_points_modified": result.negative_points_modified,
        "interpolated_count": int(result.interpolated_mask.sum()),
    }
