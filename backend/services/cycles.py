from __future__ import annotations

"""
储能充放次数测算 - 基础服务（MVP 占位）

职责：
- 解析上传负荷文件，标准化为 `timestamp, load_kw`
- 基础校验与 15 分钟重采样（不做插值策略，保持保守）
"""

from datetime import timedelta, datetime
import logging
from typing import Tuple, Optional, Dict, List, Any

import pandas as pd
import os
from pathlib import Path
import zipfile

from . import loader

TZ_NAME = os.environ.get("APP_LOCAL_TZ", "Asia/Shanghai")


logger = logging.getLogger("load-analysis")

# 全局 DOD 兜底值，避免遗留引用导致 NameError；实际计算使用各函数内部的 effective_dod
dod: float = 1.0


class CyclesError(ValueError):
    """储能测算前置校验错误。"""


def parse_load_series(file_bytes: bytes) -> pd.DataFrame:
    """解析负荷文件为 `timestamp, load_kw`，并重采样至 15 分钟。

    规则：
    - 支持 Excel/CSV（委托 loader.load_dataframe）
    - 列名标准化为 timestamp(datetime64[ns]), load_kw(float)
    - 时间索引去重与排序
    - 按 15 分钟重采样为守约（默认取均值，不做插值）；
    - 返回 DataFrame，索引为 DatetimeIndex，含列 `load_kw`
    """
    raw = loader.load_dataframe(file_bytes)

    # 兼容多种常见导出格式：
    # 1) 直接包含 timestamp, load_kw / load 列
    # 2) 拆分为「数据日期, 时间, 功率(KW)」等中文列名

    # 补齐 timestamp 列：优先使用已有列，其次尝试由「数据日期 + 时间」拼接
    if "timestamp" not in raw.columns:
        date_col_candidates = ["数据日期", "日期", "date"]
        time_col_candidates = ["时间", "时刻", "time"]
        date_col = next((c for c in date_col_candidates if c in raw.columns), None)
        time_col = next((c for c in time_col_candidates if c in raw.columns), None)
        if date_col and time_col:
            raw["timestamp"] = raw[date_col].astype(str).str.strip() + " " + raw[time_col].astype(str).str.strip()

    if "timestamp" not in raw.columns:
        raise CyclesError("未找到时间列（timestamp / 数据日期+时间）。")

    # 负荷列兼容：load_kw / load / 功率(KW) / 功率(kW) / 功率
    load_col = None
    for cand in ["load_kw", "load", "功率(KW)", "功率(kW)", "功率"]:
        if cand in raw.columns:
            load_col = cand
            break
    if load_col is None:
        raise CyclesError("未找到负荷列（load_kw / load / 功率(KW)）。")

    df = raw[["timestamp", load_col]].copy()
    # 统一将带时区的时间戳转换为“本地朴素时间”，与排程的本地日界一致
    ts = pd.to_datetime(df["timestamp"], errors="coerce")
    try:
        if getattr(ts.dt, "tz", None) is not None:
            ts = ts.dt.tz_convert(TZ_NAME).dt.tz_localize(None)
    except Exception:
        try:
            ts = ts.dt.tz_localize(None)
        except Exception:
            pass
    df["timestamp"] = ts
    df = df.dropna(subset=["timestamp"]).reset_index(drop=True)
    df.rename(columns={load_col: "load_kw"}, inplace=True)
    df["load_kw"] = pd.to_numeric(df["load_kw"], errors="coerce")

    # 设为索引并按时间排序，去重（保留首次）
    df = df.set_index("timestamp").sort_index()
    df = df[~df.index.duplicated(keep="first")]

    # 重采样至 15 分钟网格（取均值），不插值
    resampled = df.resample("15min").mean()

    # 返回标准化结构
    return resampled[["load_kw"]]


def parse_points_series(points: List[Dict[str, Any]]) -> pd.DataFrame:
    """将前端已分析的点数组（timestamp, load_kwh）转换为 15 分钟序列。

    参数:
      points: [{"timestamp": ISO8601字符串, "load_kwh": 数值}, ...]
    返回:
      索引为 DatetimeIndex 的 DataFrame，列为 load_kw，重采样至 15min 平均。
    """
    if not points:
        return pd.DataFrame(index=pd.to_datetime([]), data={"load_kw": []})
    df = pd.DataFrame(points)
    # 兼容键名 load 与 load_kwh
    if "load_kwh" not in df.columns and "load" in df.columns:
        df = df.rename(columns={"load": "load_kwh"})
    # 统一将带时区的时间戳转换为“本地朴素时间”，与排程的本地日界一致
    ts = pd.to_datetime(df["timestamp"], errors="coerce")
    try:
        if getattr(ts.dt, "tz", None) is not None:
            ts = ts.dt.tz_convert(TZ_NAME).dt.tz_localize(None)
    except Exception:
        try:
            ts = ts.dt.tz_localize(None)
        except Exception:
            pass
    df["timestamp"] = ts
    df["load_kwh"] = pd.to_numeric(df["load_kwh"], errors="coerce")
    df = df.dropna(subset=["timestamp"]).sort_values("timestamp").set_index("timestamp")
    df = df[~df.index.duplicated(keep="first")]
    resampled = df.resample("15min").mean()
    return resampled.rename(columns={"load_kwh": "load_kw"})[["load_kw"]]


def compute_limit_info(
    series_15m: pd.DataFrame,
    metering_mode: str,
    transformer_capacity_kva: Optional[float] = None,
    transformer_power_factor: Optional[float] = None,
) -> dict:
    """计算计费上限信息。

    - monthly_demand_max：按月统计 15 分钟负荷的最大值（kW）。
    - transformer_capacity：基于 `kva * power_factor` 计算上限（kW）。

    返回：
    {
      'limit_mode': 'monthly_demand_max' | 'transformer_capacity',
      'monthly_demand_max': List[{'year_month': 'YYYY-MM', 'max_kw': float}],
      'transformer_limit_kw': float | None,
      'notes': List[str]
    }
    """
    mode = (metering_mode or "monthly_demand_max").strip()
    mode = mode if mode in {"monthly_demand_max", "transformer_capacity"} else "monthly_demand_max"

    notes: List[str] = []
    monthly: List[dict] = []
    transformer_limit: Optional[float] = None

    if series_15m.empty or "load_kw" not in series_15m.columns:
        notes.append("负荷数据为空或缺少 load_kw 列，无法统计最大需量。")
    else:
        # 确保索引为 DatetimeIndex
        s = series_15m.copy()
        if not isinstance(s.index, pd.DatetimeIndex):
            s.index = pd.to_datetime(s.index, errors="coerce")
        s = s.dropna(subset=["load_kw"])  # 去除 NaN

        # 按月统计 15 分钟点的最大值（kW）
        if not s.empty:
            month_key = s.index.strftime("%Y-%m")
            grp = s.assign(_ym=month_key).groupby("_ym")["load_kw"].max()
            monthly = [
                {"year_month": ym, "max_kw": float(val) if pd.notna(val) else 0.0}
                for ym, val in grp.items()
            ]

    if mode == "transformer_capacity":
        if transformer_capacity_kva is None or transformer_power_factor is None:
            notes.append("变压器口径缺少参数：kVA 或功率因数。已回退为 monthly_demand_max。")
            mode = "monthly_demand_max"
        else:
            try:
                transformer_limit = float(transformer_capacity_kva) * float(transformer_power_factor)
            except Exception:  # pragma: no cover
                transformer_limit = None
                notes.append("变压器口径参数无法计算上限，已回退为 monthly_demand_max。")
                mode = "monthly_demand_max"

    return {
        "limit_mode": mode,
        "monthly_demand_max": monthly,
        "transformer_limit_kw": transformer_limit,
        "notes": notes,
    }


# -------------------------
# 策略 → 日度运行逻辑与连段（占位合并规则）
# -------------------------

def _date_range(start: datetime, end: datetime) -> List[datetime]:
    cur = datetime(start.year, start.month, start.day)
    days: List[datetime] = []
    while cur.date() <= end.date():
        days.append(cur)
        cur += timedelta(days=1)
    return days


def _match_rule(d: datetime, date_rules: List[dict]) -> Optional[dict]:
    for r in date_rules or []:
        try:
            start = datetime.fromisoformat(str(r.get("startDate")) + "T00:00:00")
            end = datetime.fromisoformat(str(r.get("endDate")) + "T23:59:59")
        except Exception:
            continue
        if start <= d <= end:
            return r
    return None


def _extract_hour_ops(cell: dict) -> str:
    op = (cell or {}).get("op", "待机")
    if op not in ("充", "放", "待机"):
        return "待机"
    return op


def build_daily_ops(
    series_15m: pd.DataFrame,
    monthly_schedule: List[List[dict]] | None,
    date_rules: List[dict] | None,
) -> Dict[str, List[str]]:
    """构造每一天 24 小时的运行逻辑（仅使用 op: 充/放/待机）。

    优先级：命中日期规则则使用规则的 24 小时表，否则采用月度 schedule 的相应月份。
    返回：{ 'YYYY-MM-DD': ['待机'|'充'|'放'] * 24 }
    """
    if series_15m.empty:
        return {}
    if not isinstance(series_15m.index, pd.DatetimeIndex):
        raise CyclesError("series_15m 索引必须是 DatetimeIndex")

    start = series_15m.index.min().to_pydatetime()
    end = series_15m.index.max().to_pydatetime()
    days = _date_range(start, end)

    daily: Dict[str, List[str]] = {}
    for d in days:
        key = d.strftime("%Y-%m-%d")
        rule = _match_rule(d, date_rules or [])
        if rule and isinstance(rule.get("schedule"), list) and len(rule["schedule"]) >= 24:
            ops = [
                _extract_hour_ops(rule["schedule"][h])
                for h in range(24)
            ]
        else:
            m_idx = d.month - 1
            row = (monthly_schedule[m_idx] if (monthly_schedule and 0 <= m_idx < len(monthly_schedule)) else None) or []
            ops = [
                _extract_hour_ops(row[h] if h < len(row) else None)
                for h in range(24)
            ]
        daily[key] = ops
    return daily


def _merge_head_tail_runs(runs: List[tuple[str, List[int]]], enabled: bool = False) -> List[tuple[str, List[int]]]:
    """可选地合并首尾同类（充/放）为一段；默认关闭以避免跨日误并造成窗口均值偏差。"""
    if not enabled:
        return runs
    if not runs:
        return runs
    if len(runs) == 1:
        return runs
    first_k, first_hours = runs[0]
    last_k, last_hours = runs[-1]
    if first_k == last_k:
        merged = (first_k, sorted(set(last_hours + first_hours)))
        return [merged] + runs[1:-1]
    return runs


def _hour_runs_from_ops(ops: List[str], wrap_across_midnight: bool = False) -> List[tuple[str, List[int]]]:
    """从 24 小时逻辑序列提取连续连段（忽略待机）。"""
    runs: List[tuple[str, List[int]]]= []
    cur_kind: Optional[str] = None
    cur_hours: List[int] = []
    for h in range(24):
        k = ops[h]
        if k not in ("充", "放"):
            if cur_kind is not None:
                runs.append((cur_kind, cur_hours))
                cur_kind, cur_hours = None, []
            continue
        if cur_kind != k:
            if cur_kind is not None:
                runs.append((cur_kind, cur_hours))
            cur_kind = k
            cur_hours = [h]
        else:
            cur_hours.append(h)
    if cur_kind is not None:
        runs.append((cur_kind, cur_hours))
    # 首尾同类合并（可选）
    runs = _merge_head_tail_runs(runs, enabled=wrap_across_midnight)
    return runs


def build_daily_cycles_masks(
    daily_ops: Dict[str, List[str]],
    merge_threshold_minutes: int = 30,
    wrap_across_midnight: bool = False,
) -> tuple[Dict[str, dict], int, List[dict]]:
    """基于日度逻辑构造 c1/c2 充/放掩码（按小时索引集合）。

    - 仅按小时粒度；后续窗口平均将映射到 15 分钟网格
    - 合并阈值：当连段总时长（小时*60）< 阈值时丢弃该段（视为噪声）
    - 超过两次的连段：第 3 段及以后并入 c2 的同类集合，并累计 merged 计数
    返回：(masks_by_date, merged_count)
      masks_by_date: {
        'YYYY-MM-DD': {
            'c1': { 'charge_hours': [...], 'discharge_hours': [...] },
            'c2': { 'charge_hours': [...], 'discharge_hours': [...] },
        }
      }
    """
    masks: Dict[str, dict] = {}
    merged_total = 0
    runs_debug: List[dict] = []
    for key, ops in daily_ops.items():
        runs_pre = _hour_runs_from_ops(ops, wrap_across_midnight=wrap_across_midnight)
        # 过滤小片段（按分钟阈值）
        runs_flt = []
        for i, (k, hrs) in enumerate(runs_pre):
            length_min = len(hrs) * 60
            filtered = length_min < (merge_threshold_minutes or 0)
            runs_debug.append({
                "date": key,
                "seq": i,
                "kind": k,
                "start_hour": min(hrs) if hrs else None,
                "end_hour": (max(hrs) + 1) if hrs else None,  # 半开区间
                "length_hours": len(hrs),
                "filtered_by_threshold": bool(filtered),
                "merged_to": None,
                "wrap_across_midnight": bool(wrap_across_midnight),
            })
            if not filtered:
                runs_flt.append((k, hrs))

        c1 = {"charge_hours": set(), "discharge_hours": set()}
        c2 = {"charge_hours": set(), "discharge_hours": set()}
        for i, (k, hrs) in enumerate(runs_flt):
            target = c1 if i < 2 else c2
            if i >= 4:
                merged_total += 1
            if k == "充":
                target["charge_hours"].update(hrs)
            elif k == "放":
                target["discharge_hours"].update(hrs)
            # 标注合并目标
            for dbg in runs_debug:
                if dbg["date"] == key and dbg["seq"] == i and not dbg["filtered_by_threshold"]:
                    dbg["merged_to"] = "c1" if i < 2 else "c2"
        masks[key] = {
            "c1": {"charge_hours": sorted(c1["charge_hours"]), "discharge_hours": sorted(c1["discharge_hours"])},
            "c2": {"charge_hours": sorted(c2["charge_hours"]), "discharge_hours": sorted(c2["discharge_hours"])},
        }
    return masks, merged_total, runs_debug


def count_missing_prices(monthly_prices: List[dict] | None) -> tuple[int, List[int]]:
    """统计月度 TOU 价格缺失项数量。

    参数：monthly_prices: 长度应为 12 的数组，每项为 { tierId: price | null }
    返回：(缺失数量, 异常月份索引列表)
    """
    if not monthly_prices:
        return 0, []
    missing = 0
    bad_months: List[int] = []
    for i, mp in enumerate(monthly_prices):
        if not isinstance(mp, dict):
            bad_months.append(i)
            continue
        for tier in ("尖", "峰", "平", "谷", "深"):
            v = mp.get(tier)
            if v is None:
                missing += 1
            else:
                try:
                    float(v)
                except Exception:
                    missing += 1
    return missing, bad_months


def build_price_series(
    series_15m: pd.DataFrame,
    monthly_schedule: List[List[dict]] | None,
    date_rules: List[dict] | None,
    monthly_prices: List[dict] | None,
) -> tuple[pd.DataFrame, int]:
    """将 TOU 档位映射到 15 分钟点位并附上价格。

    返回：(df, missing_points)
    - df: 与 series_15m 同索引，列 `tier` 和 `price`
    - missing_points: price 为 None/NaN 的 15 分钟点位计数
    """
    if series_15m.empty:
        return pd.DataFrame(index=series_15m.index, data={"tier": [], "price": []}), 0
    if not isinstance(series_15m.index, pd.DatetimeIndex):
        s = series_15m.copy()
        s.index = pd.to_datetime(s.index, errors="coerce")
        s = s.dropna()
    else:
        s = series_15m

    # 预构造每日 24 小时档位
    # 复用 daily_ops，但保留 tou 字段
    def _extract_hour_tou(cell: dict) -> str:
        tou = (cell or {}).get("tou", "平")
        return tou if tou in ("尖", "峰", "平", "谷", "深") else "平"

    start = s.index.min().to_pydatetime()
    end = s.index.max().to_pydatetime()
    days = _date_range(start, end)
    daily_tou: Dict[str, List[str]] = {}
    for d in days:
        key = d.strftime("%Y-%m-%d")
        rule = _match_rule(d, date_rules or [])
        if rule and isinstance(rule.get("schedule"), list) and len(rule["schedule"]) >= 24:
            tiers = [
                _extract_hour_tou(rule["schedule"][h])
                for h in range(24)
            ]
        else:
            m_idx = d.month - 1
            row = (monthly_schedule[m_idx] if (monthly_schedule and 0 <= m_idx < len(monthly_schedule)) else None) or []
            tiers = [
                _extract_hour_tou(row[h] if h < len(row) else None)
                for h in range(24)
            ]
        daily_tou[key] = tiers

    # 月度价格映射
    def _price_for(month_idx: int, tier: str) -> Optional[float]:
        if not monthly_prices or not (0 <= month_idx < len(monthly_prices)):
            return None
        pm = monthly_prices[month_idx]
        try:
            v = pm.get(tier)
            return float(v) if v is not None else None
        except Exception:
            return None

    records: List[dict] = []
    missing_points = 0
    for ts in s.index:
        day_key = ts.strftime("%Y-%m-%d")
        hour = ts.hour
        tiers = daily_tou.get(day_key)
        tier = tiers[hour] if tiers and 0 <= hour < len(tiers) else "平"
        month_idx = ts.month - 1
        price = _price_for(month_idx, tier)
        if price is None or not pd.notna(price):
            missing_points += 1
        records.append({"timestamp": ts, "tier": tier, "price": price})

    df = pd.DataFrame.from_records(records).set_index("timestamp").sort_index()
    return df, int(missing_points)


# -------------------------
# 尖段放电占比（基于 TOU=尖 且 op=放）
# -------------------------

def compute_tip_discharge_summary(
    series_15m: pd.DataFrame,
    price_series: Optional[pd.DataFrame],
    daily_ops: Dict[str, List[str]],
    daily_masks: Dict[str, dict] | None,
    storage_cfg: Dict,
) -> Optional[dict]:
    """计算尖段放电占比：仅统计 TOU=尖 且运行逻辑 op=放 的 15min 点。

    公式：占比 = min(1, 尖段能量需求 / (容量 × 放电次数))
      - 能量需求 = 尖段平均负荷 × 尖段时长（小时）
      - 放电次数：对有尖段的日期，统计 c1/c2 放电窗口中与尖小时有交集的窗口数，求平均
    """
    if series_15m is None or price_series is None:
        return None
    if series_15m.empty or price_series.empty:
        logger.debug("[tip_summary] empty series or price_series")
        return None
    s = series_15m.copy()
    p = price_series.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    if not isinstance(p.index, pd.DatetimeIndex):
        p.index = pd.to_datetime(p.index, errors="coerce")
    s = s.dropna(subset=["load_kw"]).sort_index()
    p = p.dropna(subset=["tier"]).sort_index()
    if s.empty or p.empty:
        return None

    df = s.join(p[["tier"]], how="inner")

    def _op_for_ts(ts: pd.Timestamp) -> Optional[str]:
        day_key = ts.strftime("%Y-%m-%d")
        ops = daily_ops.get(day_key)
        if not ops:
            return None
        h = ts.hour
        return ops[h] if 0 <= h < len(ops) else None

    df["op"] = [ _op_for_ts(ts) for ts in df.index ]
    df_tip = df[(df["tier"] == "尖") & (df["op"] == "放")]
    if df_tip.empty:
        logger.info("[tip_summary] no尖放点: total_points=%s tip_points=0", len(df))
        cap = float(storage_cfg.get("capacity_kwh", 0) or 0)
        return {
          "avg_tip_load_kw": 0.0,
          "tip_hours": 0.0,
          "energy_need_kwh": 0.0,
          "discharge_count": 0.0,
          "capacity_kwh": cap,
          "ratio": 0.0,
          "tip_points": [],
          "note": "无 TOU=尖 且运行逻辑=放 的 15 分钟点，尖放电占比记为 0",
        }

    day_keys = sorted(set(df_tip.index.date))
    cap = float(storage_cfg.get("capacity_kwh", 0) or 0)

    day_stats: List[dict] = []
    for dk in day_keys:
        day_str = pd.Timestamp(dk).strftime("%Y-%m-%d")
        day_sub = df_tip.loc[df_tip.index.date == dk]
        avg_day = float(day_sub["load_kw"].mean()) if not day_sub.empty else 0.0
        tip_hours_day = float(len(day_sub) * 0.25)
        energy_day = avg_day * tip_hours_day

        tip_hour_set = set(day_sub.index.hour)
        masks = (daily_masks or {}).get(day_str, {})
        cnt = 0
        for win in ("c1", "c2"):
            hours = masks.get(win, {}).get("discharge_hours", []) or []
            if set(int(h) for h in hours) & tip_hour_set:
                cnt += 1
        discharge_count_day = float(cnt)
        if discharge_count_day <= 0 or cap <= 0 or tip_hours_day <= 0:
            ratio_day = 0.0
        else:
            ratio_day = min(1.0, energy_day / (cap * discharge_count_day))

        day_stats.append({
            "date": day_str,
            "avg_load_kw": avg_day,
            "tip_hours": tip_hours_day,
            "energy_need_kwh": energy_day,
            "discharge_count": discharge_count_day,
            "ratio": ratio_day,
        })

    # 聚合为均值口径，防止跨天累加导致占比 100%
    if not day_stats:
        avg_tip_load = 0.0
        tip_hours = 0.0
        energy_need = 0.0
        discharge_count = 0.0
        ratio = 0.0
        month_stats: List[dict] = []
    else:
        avg_tip_load = float(sum(d["avg_load_kw"] for d in day_stats) / len(day_stats))
        tip_hours = float(sum(d["tip_hours"] for d in day_stats) / len(day_stats))
        energy_need = float(sum(d["energy_need_kwh"] for d in day_stats) / len(day_stats))
        discharge_count = float(sum(d["discharge_count"] for d in day_stats) / len(day_stats))
        ratio = float(sum(d["ratio"] for d in day_stats) / len(day_stats))
        month_bucket: Dict[int, List[float]] = {}
        for d in day_stats:
            try:
                m = int(str(d.get("date", ""))[5:7])
            except Exception:
                continue
            if 1 <= m <= 12:
                month_bucket.setdefault(m, []).append(float(d["ratio"]))
        month_stats = []
        for m in range(1, 13):
            arr = month_bucket.get(m, [])
            month_stats.append({"month": m, "ratio": float(sum(arr) / len(arr)) if arr else 0.0})

    # 尖段点位列表（仅时间与负荷，避免返回过大文本）
    # 裁剪点位，避免体积过大
    tip_points = [
        {"time": ts.strftime("%Y-%m-%d %H:%M"), "load_kw": float(val) if pd.notna(val) else 0.0}
        for ts, val in df_tip["load_kw"].items()
    ][:200]

    note = (
        f"基于 TOU=尖 且运行逻辑=放 的 15 分钟点，共 {len(df_tip)} 点，{len(day_keys)} 天；"
        f"按“逐日平均”口径汇总，防止跨天累加导致占比拉满。"
    )
    logger.info(
        "[tip_summary] points=%s days=%s avg=%.3f hours=%.2f energy=%.3f dis_cnt=%.3f cap=%.3f ratio=%s",
        len(df_tip),
        len(day_keys),
        avg_tip_load,
        tip_hours,
        energy_need,
        discharge_count,
        cap,
        ratio,
    )

    return {
        "avg_tip_load_kw": avg_tip_load,
        "tip_hours": tip_hours,
        "energy_need_kwh": energy_need,
        "discharge_count": discharge_count,
        "capacity_kwh": cap,
        "ratio": ratio,
        "tip_points": tip_points,
        "note": note,
        "day_stats": day_stats,
        "month_stats": month_stats,
    }


# -------------------------
# window_avg 计算（physics 默认）
# -------------------------

def _build_hourly_average(series_15m: pd.DataFrame) -> Dict[str, List[float]]:
    """从 15 分钟序列构造每天 24 小时的平均负荷（kW）。

    返回：{ 'YYYY-MM-DD': [avg_kW_h0, ..., avg_kW_h23] }
    """
    if series_15m.empty:
        return {}
    s = series_15m.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    s = s.dropna(subset=["load_kw"]).sort_index()
    # 每小时平均
    hourly = s["load_kw"].resample("1H").mean()
    by_day: Dict[str, List[float]] = {}
    # 遍历小时序列并按天收集
    for ts, val in hourly.items():
        key = ts.strftime("%Y-%m-%d")
        if key not in by_day:
            by_day[key] = [0.0] * 24
        by_day[key][ts.hour] = float(val) if pd.notna(val) else 0.0
    return by_day


def _month_key_of_date_str(date_str: str) -> str:
    return date_str[:7]


def compute_window_avg_days(
    series_15m: pd.DataFrame,
    daily_masks: Dict[str, dict],
    storage_cfg: Dict,
    limit_info: Dict,
    energy_formula: str = "physics",
) -> List[dict]:
    """基于“窗口平均 × 时长”的验收口径计算（对齐参考程序）。

    要点：
    - 以 15 分钟序列为基准，按掩码窗口选择点集，窗口平均负荷 × 窗口时长（小时）得到 base（电池侧能量基数）。
    - 许可功率：
      - 充：allow_ch = max(limit_kw - reserve_charge_kw - avg_load_window, 0)
      - 放：allow_dis = max(avg_load_window - reserve_discharge_kw, 0)
    - 窗口平均法不受 Pmax（c_rate*capacity）限制。
    - 电网侧折算（physics）：
      - E_in_grid = base_ch_kWh * DOD / η
      - E_out_grid = base_dis_kWh * DOD * η
    - 满充/放率裁剪至 1；当日次数为两次循环的 min(...) 之和。
    """
    cap = float(storage_cfg.get("capacity_kwh", 0) or 0)
    c_rate = float(storage_cfg.get("c_rate", 0) or 0)
    eta = float(storage_cfg.get("single_side_efficiency", 0.9) or 0.9)
    # 保持原变量名存在以兼容旧引用，但实际使用 effective_dod
    dod = effective_dod
    reserve_ch = float(storage_cfg.get("reserve_charge_kw", 0) or 0)
    reserve_dis = float(storage_cfg.get("reserve_discharge_kw", 0) or 0)

    # 月份→最大需量映射
    month_max_map: Dict[str, float] = {it.get("year_month"): float(it.get("max_kw", 0) or 0) for it in (limit_info.get("monthly_demand_max") or [])}
    transformer_limit_kw = limit_info.get("transformer_limit_kw")
    mode = limit_info.get("limit_mode", "monthly_demand_max")

    if series_15m.empty:
        return []
    s = series_15m.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    s = s.dropna(subset=["load_kw"]).sort_index()
    days: List[dict] = []
    for date_str, masks in daily_masks.items():
        ym = _month_key_of_date_str(date_str)
        if mode == "transformer_capacity" and transformer_limit_kw:
            limit_kw = float(transformer_limit_kw)
        else:
            limit_kw = float(month_max_map.get(ym, 0.0))

        # 当天的 15 分钟序列
        day_start = pd.to_datetime(date_str)
        day_end = day_start + pd.Timedelta(days=1)
        day_sub = s.loc[(s.index >= day_start) & (s.index < day_end)]

        # 判断该天数据是否有效：
        # 1. 有数据点（point_count > 0）
        # 2. 至少有一个正数负荷值（has_positive_load）
        point_count = len(day_sub)
        has_positive_load = bool((day_sub["load_kw"] > 0).any()) if point_count > 0 else False
        is_valid = point_count > 0 and has_positive_load

        # 无上限或容量→无法计算 cycles
        if limit_kw <= 0 or cap <= 0:
            days.append({
                "date": date_str,
                "cycles": 0.0,
                "is_valid": is_valid,
                "point_count": point_count,
            })
            continue

        c1 = masks.get("c1", {})
        c2 = masks.get("c2", {})

        def _window_energy(hour_list: List[int], is_charge: bool) -> float:
            if not hour_list:
                return 0.0
            hour_set = set(int(h) for h in hour_list)
            # 选中该窗口的 15 分钟点
            sel = day_sub.loc[day_sub.index.hour.map(lambda h: h in hour_set)]
            if sel.empty:
                return 0.0
            avg_load = float(sel["load_kw"].mean())
            hours = float(len(sel)) * 0.25
            if is_charge:
                allow = limit_kw - reserve_ch - avg_load
            else:
                allow = avg_load - reserve_dis
            allow = max(0.0, allow)
            return allow * hours

        def _cycle_contrib(cmask: dict) -> float:
            e_in_base = _window_energy(cmask.get("charge_hours", []), True)
            e_out_base = _window_energy(cmask.get("discharge_hours", []), False)

            if energy_formula == "physics":
                E_in_grid = e_in_base * dod / max(eta, 1e-9)
                E_out_grid = e_out_base * dod * eta
            else:
                E_in_grid = e_in_base / max(dod, 1e-9) * eta
                E_out_grid = e_out_base / max(dod, 1e-9) / max(eta, 1e-9)

            fc = min(E_in_grid / cap if cap > 0 else 0.0, 1.0)
            fd = min(E_out_grid / cap if cap > 0 else 0.0, 1.0)
            return min(fc, fd)

        cycles_day = _cycle_contrib(c1) + _cycle_contrib(c2)
        days.append({
            "date": date_str,
            "cycles": float(cycles_day),
            "is_valid": is_valid,
            "point_count": point_count,
        })

    # 按日期排序
    days.sort(key=lambda x: x["date"])
    return days


def compute_window_avg_days_with_debug(
    series_15m: pd.DataFrame,
    daily_masks: Dict[str, dict],
    storage_cfg: Dict,
    limit_info: Dict,
    energy_formula: str = "physics",
) -> tuple[List[dict], List[dict]]:
    """同 compute_window_avg_days，但额外返回“窗口汇总明细”行，用于 Excel 调试。

    返回：(
      days: [{date, cycles}],
      window_debug: [
        {date, window, kind, hour_list, points, avg_load_kw, hours, limit_kw, allow_kw, base_kwh, e_grid_kwh, full_ratio}
      ]
    )
    """

    # 复用已对齐窗口平均法的实现，增加调试行收集
    cap = float(storage_cfg.get("capacity_kwh", 0) or 0)
    eta = float(storage_cfg.get("single_side_efficiency", 0.9) or 0.9)
    dod = float(storage_cfg.get("depth_of_discharge", 1.0) or 1.0)
    reserve_ch = float(storage_cfg.get("reserve_charge_kw", 0) or 0)
    reserve_dis = float(storage_cfg.get("reserve_discharge_kw", 0) or 0)

    # 月份→最大需量映射
    month_max_map: Dict[str, float] = {it.get("year_month"): float(it.get("max_kw", 0) or 0) for it in (limit_info.get("monthly_demand_max") or [])}
    transformer_limit_kw = limit_info.get("transformer_limit_kw")
    mode = limit_info.get("limit_mode", "monthly_demand_max")

    if series_15m.empty:
        return [], []
    s = series_15m.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    s = s.dropna(subset=["load_kw"]).sort_index()

    def _day_limit_kw(ym: str) -> float:
        if mode == "transformer_capacity" and transformer_limit_kw:
            return float(transformer_limit_kw)
        return float(month_max_map.get(ym, 0.0))

    def _window_metrics(day_sub: pd.DataFrame, hour_list: List[int], limit_kw: float, is_charge: bool) -> tuple[dict, float, float]:
        hour_set = set(int(h) for h in (hour_list or []))
        sel = day_sub.loc[day_sub.index.hour.map(lambda h: h in hour_set)]
        points = int(len(sel))
        if points == 0:
            return {
                "points": 0,
                "avg_load_kw": 0.0,
                "hours": 0.0,
                "allow_kw": 0.0,
                "base_kwh": 0.0,
                "e_grid_kwh": 0.0,
                "full_ratio": 0.0,
                # 对照：逐点积分（step_15）
                "base_kwh_step15": 0.0,
                "e_grid_kwh_step15": 0.0,
                "full_ratio_step15": 0.0,
            }, 0.0, 0.0
        avg_load = float(sel["load_kw"].mean())
        hours = float(points) * 0.25
        allow = max(0.0, (limit_kw - reserve_ch - avg_load) if is_charge else (avg_load - reserve_dis))
        base_kwh = allow * hours
        # 两套口径同时计算（用于对拍）：physics 与 sample
        e_grid_physics = (base_kwh * dod / max(eta, 1e-9)) if is_charge else (base_kwh * dod * eta)
        e_grid_sample  = (base_kwh / max(dod, 1e-9) * eta) if is_charge else (base_kwh / max(dod, 1e-9) / max(eta, 1e-9))
        full_ratio_physics = min(e_grid_physics / cap if cap > 0 else 0.0, 1.0)
        full_ratio_sample  = min(e_grid_sample  / cap if cap > 0 else 0.0, 1.0)

        # 维持原有字段（随 energy_formula 切换），但同时返回两套对拍列
        if energy_formula == "physics":
            e_grid = e_grid_physics
            full_ratio = full_ratio_physics
        else:
            e_grid = e_grid_sample
            full_ratio = full_ratio_sample

        # 附加对照：逐 15 分钟积分（step_15，不改变主口径，仅用于报表对拍）
        if is_charge:
            allow_series = (limit_kw - reserve_ch - sel["load_kw"]).clip(lower=0.0)
            base_step15 = float((allow_series * 0.25).sum())
            e_grid_physics_step15 = base_step15 * (dod / max(eta, 1e-9))
            e_grid_sample_step15  = base_step15 * (eta / max(dod, 1e-9))
        else:
            allow_series = (sel["load_kw"] - reserve_dis).clip(lower=0.0)
            base_step15 = float((allow_series * 0.25).sum())
            e_grid_physics_step15 = base_step15 * (dod * eta)
            e_grid_sample_step15  = base_step15 * (1.0 / max(dod * eta, 1e-9))
        full_ratio_physics_step15 = min(e_grid_physics_step15 / cap if cap > 0 else 0.0, 1.0)
        full_ratio_sample_step15  = min(e_grid_sample_step15  / cap if cap > 0 else 0.0, 1.0)

        return {
            "points": points,
            "avg_load_kw": avg_load,
            "hours": hours,
            "allow_kw": allow,
            "base_kwh": base_kwh,
            # 主口径当前值（随 energy_formula 切换）
            "e_grid_kwh": e_grid,
            "full_ratio": full_ratio,
            # physics 与 sample 两套对拍（窗口平均）
            "e_grid_kwh_physics": e_grid_physics,
            "full_ratio_physics": full_ratio_physics,
            "e_grid_kwh_sample": e_grid_sample,
            "full_ratio_sample": full_ratio_sample,
            # 逐点积分对照（step_15）
            "base_kwh_step15": base_step15,
            "e_grid_kwh_physics_step15": e_grid_physics_step15,
            "full_ratio_physics_step15": full_ratio_physics_step15,
            "e_grid_kwh_sample_step15": e_grid_sample_step15,
            "full_ratio_sample_step15": full_ratio_sample_step15,
        }, full_ratio, e_grid

    days: List[dict] = []
    debug_rows: List[dict] = []
    for date_str, masks in sorted(daily_masks.items(), key=lambda kv: kv[0]):
        ym = date_str[:7]
        limit_kw = _day_limit_kw(ym)
        day_start = pd.to_datetime(date_str)
        day_end = day_start + pd.Timedelta(days=1)
        day_sub = s.loc[(s.index >= day_start) & (s.index < day_end)]

        # 判断该天数据是否有效
        point_count = len(day_sub)
        has_positive_load = bool((day_sub["load_kw"] > 0).any()) if point_count > 0 else False
        is_valid = point_count > 0 and has_positive_load

        c1 = masks.get("c1", {})
        c2 = masks.get("c2", {})

        # c1 charge/discharge
        m1c = c1.get("charge_hours", [])
        m1d = c1.get("discharge_hours", [])
        met1c, fc1, e1c = _window_metrics(day_sub, m1c, limit_kw, True)
        met1d, fd1, e1d = _window_metrics(day_sub, m1d, limit_kw, False)
        
        c1_cycles = min(fc1, fd1)

        debug_rows.append({
            "date": date_str,
            "window": "c1",
            "kind": "charge",
            "hour_list": ",".join(str(int(h)) for h in (m1c or [])),
            "limit_kw": limit_kw,
            **met1c,
        })
        debug_rows.append({
            "date": date_str,
            "window": "c1",
            "kind": "discharge",
            "hour_list": ",".join(str(int(h)) for h in (m1d or [])),
            "limit_kw": limit_kw,
            **met1d,
        })

        # c2 charge/discharge
        m2c = c2.get("charge_hours", [])
        m2d = c2.get("discharge_hours", [])
        met2c, fc2, e2c = _window_metrics(day_sub, m2c, limit_kw, True)
        met2d, fd2, e2d = _window_metrics(day_sub, m2d, limit_kw, False)
        
        c2_cycles = min(fc2, fd2)

        debug_rows.append({
            "date": date_str,
            "window": "c2",
            "kind": "charge",
            "hour_list": ",".join(str(int(h)) for h in (m2c or [])),
            "limit_kw": limit_kw,
            **met2c,
        })
        debug_rows.append({
            "date": date_str,
            "window": "c2",
            "kind": "discharge",
            "hour_list": ",".join(str(int(h)) for h in (m2d or [])),
            "limit_kw": limit_kw,
            **met2d,
        })

        days.append({
            "date": date_str,
            "cycles": float(c1_cycles + c2_cycles),
            "is_valid": is_valid,
            "point_count": point_count,
        })

    return days, debug_rows


# =========================
# 报表导出
# =========================


def _build_cycles_stats_from_window_debug(
    window_debug: Optional[List[dict]],
    *,
    energy_formula: str = "physics",
) -> pd.DataFrame:
    """从 window_debug 中提取每日“等效次数”和窗口数（physics/sample 两套口径）。

    返回 DataFrame 列：
      - date: 'YYYY-MM-DD'
      - eq_cycles_physics
      - eq_cycles_sample
      - window_count: 当日有效窗口数量（c1/c2 * 充/放 有任一非空即计数）
    """
    if not window_debug:
        return pd.DataFrame(columns=["date", "eq_cycles_physics", "eq_cycles_sample", "window_count"])

    # (date, window) -> per-window stats
    per_window: Dict[tuple[str, str], Dict[str, Any]] = {}
    for row in window_debug:
        try:
            date_str = str(row.get("date") or "")
            win = str(row.get("window") or "").lower()
            kind = str(row.get("kind") or "").lower()
            if not date_str or win not in {"c1", "c2"}:
                continue
            wkey = (date_str, win)
            rec = per_window.setdefault(
                wkey,
                {
                    "physics_charge": 0.0,
                    "physics_discharge": 0.0,
                    "sample_charge": 0.0,
                    "sample_discharge": 0.0,
                    "has_charge": False,
                    "has_discharge": False,
                },
            )

            phys = float(row.get("full_ratio_physics", 0.0) or 0.0)
            samp = float(row.get("full_ratio_sample", 0.0) or 0.0)

            if kind == "charge":
                rec["physics_charge"] = phys
                rec["sample_charge"] = samp
                rec["has_charge"] = rec.get("has_charge", False) or bool(row.get("hour_list"))
            elif kind == "discharge":
                rec["physics_discharge"] = phys
                rec["sample_discharge"] = samp
                rec["has_discharge"] = rec.get("has_discharge", False) or bool(row.get("hour_list"))
        except Exception:
            continue

    # 按日聚合
    per_day: Dict[str, Dict[str, Any]] = {}
    for (date_str, _win), rec in per_window.items():
        drec = per_day.setdefault(date_str, {
            "eq_cycles_physics": 0.0,
            "eq_cycles_sample": 0.0,
            "window_count": 0,
        })
        eq_phys = min(float(rec.get("physics_charge", 0.0) or 0.0), float(rec.get("physics_discharge", 0.0) or 0.0))
        eq_samp = min(float(rec.get("sample_charge", 0.0) or 0.0), float(rec.get("sample_discharge", 0.0) or 0.0))
        drec["eq_cycles_physics"] += eq_phys
        drec["eq_cycles_sample"] += eq_samp
        if rec.get("has_charge") or rec.get("has_discharge"):
            drec["window_count"] += 1

    rows = [
        {
            "date": d,
            "eq_cycles_physics": float(v.get("eq_cycles_physics", 0.0) or 0.0),
            "eq_cycles_sample": float(v.get("eq_cycles_sample", 0.0) or 0.0),
            "window_count": int(v.get("window_count", 0) or 0),
        }
        for d, v in sorted(per_day.items(), key=lambda kv: kv[0])
    ]
    return pd.DataFrame(rows)


def _build_step15_business_stats(
    step15_df: Optional[pd.DataFrame],
    *,
    energy_formula: str = "physics",
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """基于 step15 明细构造业务友好的日/月统计与精简曲线表.

    返回: (df_step15_slim, daily_stats_df, monthly_stats_df)
    """
    if step15_df is None or step15_df.empty:
        empty = pd.DataFrame()
        return empty, empty, empty

    s = step15_df.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    s = s.sort_index()

    main_formula = (energy_formula or "physics").strip()
    if main_formula not in ("physics", "sample"):
        main_formula = "physics"

    # 主口径能量与功率
    if main_formula == "physics":
        s["e_in_main_kwh"] = s.get("e_in_physics_kwh", 0.0)
        s["e_out_main_kwh"] = s.get("e_out_physics_kwh", 0.0)
        s["p_grid_main_kw"] = s.get("p_grid_effect_physics_kw", 0.0)
    else:
        s["e_in_main_kwh"] = s.get("e_in_sample_kwh", 0.0)
        s["e_out_main_kwh"] = s.get("e_out_sample_kwh", 0.0)
        s["p_grid_main_kw"] = s.get("p_grid_effect_sample_kw", 0.0)

    s["date_str"] = s.index.strftime("%Y-%m-%d")
    s["year_month"] = s.index.strftime("%Y-%m")
    s["load_with_storage_main_kw"] = s["load_kw"] + s["p_grid_main_kw"]

    # 精简 step15 曲线表
    def _net_revenue_row(row: pd.Series) -> float:
        price = row.get("price")
        try:
            price_f = float(price) if price is not None and pd.notna(price) else 0.0
        except Exception:
            price_f = 0.0
        e_in = float(row.get("e_in_main_kwh", 0.0) or 0.0)
        e_out = float(row.get("e_out_main_kwh", 0.0) or 0.0)
        return (e_out - e_in) * price_f

    slim = s[[
        "load_kw",
        "load_with_storage_main_kw",
        "p_batt_kw",
        "soc",
        "tier",
        "price",
        "e_in_main_kwh",
        "e_out_main_kwh",
    ]].copy()
    slim["net_revenue_step15_main"] = slim.apply(_net_revenue_row, axis=1)
    slim = slim.reset_index().rename(columns={"index": "timestamp"})
    try:
        slim["timestamp"] = pd.to_datetime(slim["timestamp"], errors="coerce").dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        pass

    # 日统计
    daily_stats = s.groupby("date_str").agg(
        max_load_kw=("load_kw", "max"),
        max_load_with_storage_kw=("load_with_storage_main_kw", "max"),
        charge_energy_kwh=("e_in_main_kwh", "sum"),
        discharge_energy_kwh=("e_out_main_kwh", "sum"),
    )
    daily_stats = daily_stats.reset_index().rename(columns={"date_str": "date"})

    # 月统计
    monthly_stats = s.groupby("year_month").agg(
        max_load_kw=("load_kw", "max"),
        max_load_with_storage_kw=("load_with_storage_main_kw", "max"),
        charge_energy_kwh=("e_in_main_kwh", "sum"),
        discharge_energy_kwh=("e_out_main_kwh", "sum"),
    )
    monthly_stats = monthly_stats.reset_index().rename(columns={"year_month": "year_month"})

    return slim, daily_stats, monthly_stats


def export_excel_report(
    out_dir: Path,
    source_filename: str,
    days: List[dict],
    months: List[dict],
    year: dict,
    monthly_prices: List[dict] | None,
    limit_info: Dict,
    qc_dict: Dict,
    window_debug: List[dict] | None = None,
    ops_by_hour: List[dict] | None = None,
    runs_debug: List[dict] | None = None,
    profit_summary: Dict | None = None,
    step15_df: Optional[pd.DataFrame] = None,
    energy_formula: str = "physics",
) -> tuple[Path, Path | None]:
    """导出调试报表（多张 CSV 打包为 ZIP）。

    原先为单个 XLSX 多 Sheet，这里改为：每个 Sheet 对应一份 CSV，
    最后统一打包为 `{base}_计算结果_csv.zip`，减少内存与文件体积。

    基础表：
    - 日度次数明细 / 月度次数明细 / 年度次数汇总
    - 分时电价
    - 质量与上限（拆成汇总、月度上限、备注三张 CSV）
    - 统计汇总

    调试表（如有数据）：
    - 日度收益明细 / 月度收益明细 / 年度收益汇总
    - 逐点功率与负荷
    - 窗口调试明细 / 逐小时运行逻辑 / 连段合并调试
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    base = os.path.splitext(os.path.basename(source_filename))[0] or "result"
    summary_csv: Path | None = None
    csv_files: List[Path] = []

    # 构造 DataFrame
    df_days = pd.DataFrame(days)
    df_months = pd.DataFrame(months)
    df_year = pd.DataFrame([year])
    df_prices = pd.DataFrame(monthly_prices or [])

    # QC 与上限信息
    monthly_limit = pd.DataFrame(limit_info.get("monthly_demand_max") or [])
    qc_notes = pd.DataFrame({"notes": qc_dict.get("notes", [])}) if qc_dict.get("notes") else pd.DataFrame({"notes": []})
    qc_head = pd.DataFrame({
        "missing_prices": [qc_dict.get("missing_prices", 0)],
        "merged_segments": [qc_dict.get("merged_segments", 0)],
        "limit_mode": [limit_info.get("limit_mode")],
        "transformer_limit_kw": [limit_info.get("transformer_limit_kw")],
    })

    def _build_profit_row(key_name: str, key_value: Any, entry: Dict[str, dict]) -> dict:
        """将单个 main/physics/sample 收益条目拍平成一行，便于导出调试。"""
        row: Dict[str, Any] = {key_name: key_value}
        for formula in ("main", "physics", "sample"):
            m = entry.get(formula) or {}
            prefix = f"{formula}_"
            row[prefix + "revenue"] = float(m.get("revenue", 0.0) or 0.0)
            row[prefix + "cost"] = float(m.get("cost", 0.0) or 0.0)
            row[prefix + "profit"] = float(m.get("profit", 0.0) or 0.0)
            row[prefix + "discharge_energy_kwh"] = float(m.get("discharge_energy_kwh", 0.0) or 0.0)
            row[prefix + "charge_energy_kwh"] = float(m.get("charge_energy_kwh", 0.0) or 0.0)
            row[prefix + "profit_per_kwh"] = float(m.get("profit_per_kwh", 0.0) or 0.0)
        return row

    # 结果汇总（中文列名）
    df_days_zh = (
        df_days.rename(
            columns={
                "date": "日期",
                "cycles": "等效次数",
                "is_valid": "是否有效",
                "point_count": "点位数量",
            }
        )
        if not df_days.empty
        else df_days
    )
    df_months_zh = (
        df_months.rename(
            columns={
                "year_month": "年月",
                "cycles": "等效次数",
            }
        )
        if not df_months.empty
        else df_months
    )
    df_year_zh = (
        df_year.rename(
            columns={
                "year": "年份",
                "cycles": "全年等效次数",
            }
        )
        if not df_year.empty
        else df_year
    )

    if not df_days_zh.empty:
        p = out_dir / f"{base}_日度次数明细.csv"
        df_days_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)
    if not df_months_zh.empty:
        p = out_dir / f"{base}_月度次数明细.csv"
        df_months_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)
    if not df_year_zh.empty:
        p = out_dir / f"{base}_年度次数汇总.csv"
        df_year_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 分时电价快照（本身以中文电价档位为列，保持不变）
    if not df_prices.empty:
        p = out_dir / f"{base}_分时电价.csv"
        df_prices.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 质量与上限信息
    qc_head_zh = qc_head.rename(
        columns={
            "missing_prices": "缺失电价点数",
            "merged_segments": "合并连段数量",
            "limit_mode": "计费口径",
            "transformer_limit_kw": "变压器上限(kW)",
        }
    )
    if not qc_head_zh.empty:
        p = out_dir / f"{base}_质量与上限-汇总.csv"
        qc_head_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    monthly_limit_zh = (
        monthly_limit.rename(columns={"year_month": "年月", "max_kw": "当月最大需量(kW)"})
        if not monthly_limit.empty
        else monthly_limit
    )
    if not monthly_limit_zh.empty:
        p = out_dir / f"{base}_质量与上限-月度上限.csv"
        monthly_limit_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    qc_notes_zh = (
        qc_notes.rename(columns={"notes": "备注说明"}) if not qc_notes.empty else qc_notes
    )
    if not qc_notes_zh.empty:
        p = out_dir / f"{base}_质量与上限-备注.csv"
        qc_notes_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # Summary（关键统计一页表）
    try:
        cy_m = (
            pd.to_numeric(df_months.get("cycles"), errors="coerce")
            if not df_months.empty
            else pd.Series([], dtype=float)
        )
        cy_d = (
            pd.to_numeric(df_days.get("cycles"), errors="coerce")
            if not df_days.empty
            else pd.Series([], dtype=float)
        )
        months_sum = float(cy_m.fillna(0).sum()) if not df_months.empty else 0.0
        months_nonzero = int((cy_m > 0).sum()) if not df_months.empty else 0
        months_total = int(len(df_months)) if not df_months.empty else 0
        days_nonzero = int((cy_d > 0).sum()) if not df_days.empty else 0
        days_total = int(len(df_days)) if not df_days.empty else 0

        summary_df = pd.DataFrame(
            [
                {
                    "year_cycles": (
                        float(
                            pd.to_numeric(
                                pd.Series([year.get("cycles", 0)]), errors="coerce"
                            ).fillna(0).iloc[0]
                        )
                        if isinstance(year, dict)
                        else 0.0
                    ),
                    "months_sum_cycles": months_sum,
                    "months_nonzero": months_nonzero,
                    "months_total": months_total,
                    "days_nonzero": days_nonzero,
                    "days_total": days_total,
                    "missing_prices": int(qc_dict.get("missing_prices", 0) or 0),
                    "merged_segments": int(qc_dict.get("merged_segments", 0) or 0),
                    "limit_mode": limit_info.get("limit_mode"),
                    "transformer_limit_kw": limit_info.get("transformer_limit_kw"),
                }
            ]
        )
        summary_df_zh = summary_df.rename(
            columns={
                "year_cycles": "全年等效次数",
                "months_sum_cycles": "月度次数合计",
                "months_nonzero": "有次数月份数",
                "months_total": "月份总数",
                "days_nonzero": "有次数天数",
                "days_total": "天数总数",
                "missing_prices": "缺失电价点数",
                "merged_segments": "合并连段数量",
                "limit_mode": "计费口径",
                "transformer_limit_kw": "变压器上限(kW)",
            }
        )
        p = out_dir / f"{base}_统计汇总.csv"
        summary_df_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)
    except Exception:
        pass

    # 收益明细（按日 / 按月 / 全年）
    if profit_summary:
        days_map = (profit_summary or {}).get("days") or {}
        months_map = (profit_summary or {}).get("months") or {}
        year_entry = (profit_summary or {}).get("year") or None

        def _rename_profit_df(df: pd.DataFrame) -> pd.DataFrame:
            mapping: Dict[str, str] = {}
            for col in df.columns:
                if col == "date":
                    mapping[col] = "日期"
                elif col == "year_month":
                    mapping[col] = "年月"
                elif col == "year":
                    mapping[col] = "年份"
                elif col.endswith("_revenue"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_电费收入(元)"
                elif col.endswith("_cost"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_电费成本(元)"
                elif col.endswith("_profit"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_净收益(元)"
                elif col.endswith("_discharge_energy_kwh"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_放电电量(kWh)"
                elif col.endswith("_charge_energy_kwh"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_充电电量(kWh)"
                elif col.endswith("_profit_per_kwh"):
                    prefix = col.split("_", 1)[0]
                    name = {
                        "main": "主口径",
                        "physics": "物理模型",
                        "sample": "样本模型",
                    }.get(prefix, prefix)
                    mapping[col] = f"{name}_单位收益(元/kWh)"
            return df.rename(columns=mapping)

        if days_map:
            rows_days: List[dict] = []
            for dkey in sorted(days_map.keys()):
                entry = days_map.get(dkey) or {}
                rows_days.append(_build_profit_row("date", dkey, entry))
            df_profit_days = pd.DataFrame(rows_days)
            df_profit_days_zh = _rename_profit_df(df_profit_days)
            p = out_dir / f"{base}_日度收益明细.csv"
            df_profit_days_zh.to_csv(p, index=False, encoding="utf-8-sig")
            csv_files.append(p)

        if months_map:
            rows_months: List[dict] = []
            for ym in sorted(months_map.keys()):
                entry = months_map.get(ym) or {}
                rows_months.append(_build_profit_row("year_month", ym, entry))
            df_profit_months = pd.DataFrame(rows_months)
            df_profit_months_zh = _rename_profit_df(df_profit_months)
            p = out_dir / f"{base}_月度收益明细.csv"
            df_profit_months_zh.to_csv(p, index=False, encoding="utf-8-sig")
            csv_files.append(p)

        if isinstance(year_entry, dict) and year_entry:
            year_val = year.get("year", 0) if isinstance(year, dict) else 0
            row_year = _build_profit_row("year", year_val, year_entry)
            df_profit_year = pd.DataFrame([row_year])
            df_profit_year_zh = _rename_profit_df(df_profit_year)
            p = out_dir / f"{base}_年度收益汇总.csv"
            df_profit_year_zh.to_csv(p, index=False, encoding="utf-8-sig")
            csv_files.append(p)

    # 逐 15 分钟功率 / 负荷明细（可选）
    if step15_df is not None and not step15_df.empty:
        df_power = step15_df.copy()
        df_power = df_power.reset_index().rename(columns={"index": "timestamp"})
        # 统一时间戳格式，便于在 CSV / Excel 中过滤
        try:
            df_power["timestamp"] = pd.to_datetime(df_power["timestamp"], errors="coerce").dt.strftime(
                "%Y-%m-%dT%H:%M:%S"
            )
        except Exception:  # pragma: no cover - 调试容错
            pass

        # 加上“引入储能后负荷”列（physics / sample 两套）
        for suffix, col in (("physics", "p_grid_effect_physics_kw"), ("sample", "p_grid_effect_sample_kw")):
            if col in df_power.columns:
                df_power[f"load_with_storage_{suffix}_kw"] = df_power["load_kw"] + df_power[col]

        # 标记主口径，便于对照 StorageProfit 页
        main_col = (
            "p_grid_effect_physics_kw"
            if (energy_formula or "physics").strip() == "physics"
            else "p_grid_effect_sample_kw"
        )
        if main_col in df_power.columns:
            df_power["p_grid_effect_main_kw"] = df_power[main_col]
            df_power["load_with_storage_main_kw"] = df_power["load_kw"] + df_power["p_grid_effect_main_kw"]

        df_power_zh = df_power.rename(
            columns={
                "timestamp": "时间",
                "load_kw": "原始负荷(kW)",
                "price": "电价(元/kWh)",
                "tier": "分时电价档位",
                "date_str": "日期",
                "year_month": "年月",
                "op": "运行模式",
                "limit_kw": "需量上限(kW)",
                "p_max_kw": "储能最大功率(kW)",
                "p_batt_kw": "储能功率(kW)",
                "soc": "SOC",
                "e_in_physics_kwh": "physics_充电电量(kWh)",
                "e_out_physics_kwh": "physics_放电电量(kWh)",
                "e_in_sample_kwh": "sample_充电电量(kWh)",
                "e_out_sample_kwh": "sample_放电电量(kWh)",
                "p_grid_effect_physics_kw": "physics_电网侧功率(kW)",
                "p_grid_effect_sample_kw": "sample_电网侧功率(kW)",
                "p_grid_effect_main_kw": "主口径_电网侧功率(kW)",
                "load_with_storage_physics_kw": "physics_储能后负荷(kW)",
                "load_with_storage_sample_kw": "sample_储能后负荷(kW)",
                "load_with_storage_main_kw": "主口径_储能后负荷(kW)",
            }
        )

        p = out_dir / f"{base}_逐点功率与负荷.csv"
        df_power_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 窗口汇总明细（可选）
    if window_debug:
        df_win = pd.DataFrame(window_debug)
        # 统一列顺序，确保便于人工核对
        cols = [
            "date",
            "window",
            "kind",
            "hour_list",
            "points",
            "hours",
            "limit_kw",
            "avg_load_kw",
            "allow_kw",
            # 窗口平均法（主口径当前值）
            "base_kwh",
            "e_grid_kwh",
            "full_ratio",
            # 窗口平均法（physics 与 sample 对拍）
            "e_grid_kwh_physics",
            "full_ratio_physics",
            "e_grid_kwh_sample",
            "full_ratio_sample",
            # 逐点积分（physics 与 sample 对拍）
            "base_kwh_step15",
            "e_grid_kwh_physics_step15",
            "full_ratio_physics_step15",
            "e_grid_kwh_sample_step15",
            "full_ratio_sample_step15",
        ]
        for c in cols:
            if c not in df_win.columns:
                df_win[c] = None
        df_win = df_win[cols]
        df_win_zh = df_win.rename(
            columns={
                "date": "日期",
                "window": "窗口(c1/c2)",
                "kind": "类型(充/放)",
                "hour_list": "涉及小时",
                "points": "点位数量",
                "hours": "小时数",
                "limit_kw": "需量上限(kW)",
                "avg_load_kw": "平均负荷(kW)",
                "allow_kw": "可用功率(kW)",
                "base_kwh": "基础电量(kWh)",
                "e_grid_kwh": "电网侧电量(kWh)",
                "full_ratio": "等效次数(当前口径)",
                "e_grid_kwh_physics": "physics_电网侧电量(kWh)",
                "full_ratio_physics": "physics_等效次数",
                "e_grid_kwh_sample": "sample_电网侧电量(kWh)",
                "full_ratio_sample": "sample_等效次数",
                "base_kwh_step15": "逐点_基础电量(kWh)",
                "e_grid_kwh_physics_step15": "逐点_physics_电网侧电量(kWh)",
                "full_ratio_physics_step15": "逐点_physics_等效次数",
                "e_grid_kwh_sample_step15": "逐点_sample_电网侧电量(kWh)",
                "full_ratio_sample_step15": "逐点_sample_等效次数",
            }
        )
        p = out_dir / f"{base}_窗口调试明细.csv"
        df_win_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 每小时运行逻辑（可选）
    if ops_by_hour:
        df_ops = pd.DataFrame(ops_by_hour)
        # 确保列顺序 date,h00..h23
        cols_ops = ["date"] + [f"h{h:02d}" for h in range(24)]
        for c in cols_ops:
            if c not in df_ops.columns:
                df_ops[c] = None
        df_ops = df_ops[cols_ops]
        df_ops_zh = df_ops.rename(columns={"date": "日期"})
        p = out_dir / f"{base}_逐小时运行逻辑.csv"
        df_ops_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 连段合并过程（可选）
    if runs_debug:
        df_runs = pd.DataFrame(runs_debug)
        cols_runs = [
            "date",
            "seq",
            "kind",
            "start_hour",
            "end_hour",
            "length_hours",
            "filtered_by_threshold",
            "merged_to",
            "wrap_across_midnight",
        ]
        for c in cols_runs:
            if c not in df_runs.columns:
                df_runs[c] = None
        df_runs = df_runs[cols_runs]
        df_runs_zh = df_runs.rename(
            columns={
                "date": "日期",
                "seq": "序号",
                "kind": "类型(充/放)",
                "start_hour": "起始小时",
                "end_hour": "结束小时",
                "length_hours": "持续小时数",
                "filtered_by_threshold": "是否被阈值过滤",
                "merged_to": "合并到窗口",
                "wrap_across_midnight": "是否跨零点合并",
            }
        )
        p = out_dir / f"{base}_连段合并调试.csv"
        df_runs_zh.to_csv(p, index=False, encoding="utf-8-sig")
        csv_files.append(p)

    # 生成 CSV 简表（与原行为保持一致，单独提供 summary.csv）
    try:
        summary_csv = out_dir / f"{base}_summary.csv"
        if 'summary_df' in locals():
            summary_df.to_csv(summary_csv, index=False, encoding="utf-8-sig")
        else:
            pd.DataFrame([year]).to_csv(summary_csv, index=False, encoding="utf-8-sig")
    except Exception:
        summary_csv = None

    # 若没有任何明细 CSV（极端情况），直接返回 summary_csv 或占位文件
    if not csv_files:
        if summary_csv is not None:
            return summary_csv, summary_csv
        placeholder = out_dir / f"{base}_计算结果_empty.csv"
        pd.DataFrame([]).to_csv(placeholder, index=False, encoding="utf-8-sig")
        return placeholder, summary_csv

    # 将所有 CSV 打包为一个 ZIP，供前端一次性下载
    zip_path = out_dir / f"{base}_计算结果_csv.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in csv_files:
            try:
                zf.write(f, arcname=f.name)
            except Exception:
                # 某个文件写入失败不影响整体报表
                continue

    return zip_path, summary_csv


def export_business_report(
    out_dir: Path,
    source_filename: str,
    days: List[dict],
    months: List[dict],
    year: dict,
    *,
    profit_summary: Optional[Dict[str, Any]] = None,
    step15_df: Optional[pd.DataFrame] = None,
    window_debug: Optional[List[dict]] = None,
    energy_formula: str = "physics",
) -> Path:
    """导出面向业务的“运行与收益”报表（CSV 多表打包）。

    由于 CSV 本身不支持多 Sheet，这里采用「多张表分别导出为 CSV，
    再打包为一个 ZIP 文件」的方式：
      - 日度运行统计:  {base}_日度运行统计.csv
      - 月度运行统计:  {base}_月度运行统计.csv
      - 运行看板:      {base}_运行看板.csv
      - 逐点曲线精简:  {base}_逐点曲线精简.csv
    最终返回的 Path 指向一个 ZIP 文件，前端仍通过 excel_path 下载。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    base = os.path.splitext(os.path.basename(source_filename))[0] or "result"

    df_days = pd.DataFrame(days or [])
    df_months = pd.DataFrame(months or [])

    main_formula = (energy_formula or "physics").strip()
    if main_formula not in ("physics", "sample"):
        main_formula = "physics"

    # 有效天数（用于“按月外推”的等效收益计算）
    # 规则：
    # - 零散缺天：按“该月有效天日均收益”外推到该月自然天数
    # - 整月缺失（该月有效天数=0）：不做外推，等效收益留空
    month_valid_days_map: Dict[str, int] = {}
    if not df_days.empty:
        for _, row in df_days.iterrows():
            date_str = str(row.get("date") or "")
            if len(date_str) < 7:
                continue
            ym = date_str[:7]
            if "is_valid" in df_days.columns:
                is_valid_val = row.get("is_valid")
                is_valid = True if pd.isna(is_valid_val) else bool(is_valid_val)
            else:
                is_valid = True
            if is_valid:
                month_valid_days_map[ym] = month_valid_days_map.get(ym, 0) + 1

    # 从 window_debug 提取每日等效次数与窗口数
    cycles_stats = _build_cycles_stats_from_window_debug(window_debug, energy_formula=energy_formula)

    # 从 step15 构造精简曲线与日/月统计
    step15_slim, step15_daily, step15_monthly = _build_step15_business_stats(
        step15_df,
        energy_formula=energy_formula,
    )

    profit_days = (profit_summary or {}).get("days") or {}
    profit_months = (profit_summary or {}).get("months") or {}

    csv_files: List[Path] = []

    # ========= 日度业务统计 =========
    daily_rows: List[dict] = []
    if not df_days.empty:
        for _, row in df_days.sort_values("date").iterrows():
            date_str = str(row.get("date"))
            base_cycles = float(row.get("cycles", 0.0) or 0.0)

            # 等效次数 & 窗口数
            cs = (
                cycles_stats[cycles_stats["date"] == date_str].iloc[0]
                if not cycles_stats.empty and (cycles_stats["date"] == date_str).any()
                else None
            )
            eq_phys = float(cs["eq_cycles_physics"]) if cs is not None else 0.0
            eq_samp = float(cs["eq_cycles_sample"]) if cs is not None else 0.0
            win_cnt = int(cs["window_count"]) if cs is not None else 0

            # 日度主口径收益与能量（来自 profit_days.main）
            p_entry = profit_days.get(date_str) or {}
            p_main = p_entry.get("main") or {}
            profit_main = float(p_main.get("profit", 0.0) or 0.0)
            charge_kwh = float(p_main.get("charge_energy_kwh", 0.0) or 0.0)
            discharge_kwh = float(p_main.get("discharge_energy_kwh", 0.0) or 0.0)

            # 日度最大需量（原始 / 储能后）
            srow = (
                step15_daily[step15_daily["date"] == date_str].iloc[0]
                if not step15_daily.empty and (step15_daily["date"] == date_str).any()
                else None
            )
            max_load = float(srow["max_load_kw"]) if srow is not None else 0.0
            max_load_with = float(srow["max_load_with_storage_kw"]) if srow is not None else 0.0

            daily_rows.append(
                {
                    "date": date_str,
                    "cycles_main": base_cycles,
                    "window_count": win_cnt,
                    "eq_cycles_physics": eq_phys,
                    "eq_cycles_sample": eq_samp,
                    "profit_main_yuan": profit_main,
                    "charge_energy_main_kwh": charge_kwh,
                    "discharge_energy_main_kwh": discharge_kwh,
                    "max_load_kw": max_load,
                    "max_load_with_storage_kw": max_load_with,
                }
            )

    if daily_rows:
        df_daily = pd.DataFrame(daily_rows)
        df_daily_zh = df_daily.rename(
            columns={
                "date": "日期",
                "cycles_main": "主口径_等效次数",
                "window_count": "窗口数量",
                "eq_cycles_physics": "physics_等效次数(窗口法)",
                "eq_cycles_sample": "sample_等效次数(窗口法)",
                "profit_main_yuan": "主口径_净收益(元)",
                "charge_energy_main_kwh": "主口径_充电电量(kWh)",
                "discharge_energy_main_kwh": "主口径_放电电量(kWh)",
                "max_load_kw": "原始最大需量(kW)",
                "max_load_with_storage_kw": "储能后最大需量(kW)",
            }
        )
        csv_path = out_dir / f"{base}_日度运行统计.csv"
        df_daily_zh.to_csv(csv_path, index=False, encoding="utf-8-sig")
        csv_files.append(csv_path)

    # ========= 月度业务统计 =========
    monthly_rows: List[dict] = []
    if not df_months.empty:
        # 预先按月聚合等效次数与窗口数
        if not cycles_stats.empty:
            cycles_stats["year_month"] = cycles_stats["date"].str[:7]
            cyc_month = (
                cycles_stats.groupby("year_month")[["eq_cycles_physics", "eq_cycles_sample", "window_count"]]
                .sum()
                .reset_index()
            )
        else:
            cyc_month = pd.DataFrame(
                columns=["year_month", "eq_cycles_physics", "eq_cycles_sample", "window_count"]
            )

        for _, row in df_months.sort_values("year_month").iterrows():
            ym = str(row.get("year_month"))
            base_cycles = float(row.get("cycles", 0.0) or 0.0)

            cs = (
                cyc_month[cyc_month["year_month"] == ym].iloc[0]
                if not cyc_month.empty and (cyc_month["year_month"] == ym).any()
                else None
            )
            eq_phys = float(cs["eq_cycles_physics"]) if cs is not None else 0.0
            eq_samp = float(cs["eq_cycles_sample"]) if cs is not None else 0.0
            win_cnt = int(cs["window_count"]) if cs is not None else 0

            # 月度主口径收益
            p_entry = profit_months.get(ym) or {}
            p_main = p_entry.get("main") or {}
            profit_main = float(p_main.get("profit", 0.0) or 0.0)

            # 月度等效收益（按月外推；整月缺失则留空）
            month_valid_days = int(month_valid_days_map.get(ym, 0) or 0)
            try:
                month_days_count = int(pd.Period(ym).days_in_month)
            except Exception:
                month_days_count = 0
            profit_main_equiv: float | None
            if month_valid_days > 0 and month_days_count > 0:
                profit_main_equiv = profit_main / month_valid_days * month_days_count
            else:
                profit_main_equiv = None

            # 月度充/放电量与最大需量
            srow = (
                step15_monthly[step15_monthly["year_month"] == ym].iloc[0]
                if not step15_monthly.empty and (step15_monthly["year_month"] == ym).any()
                else None
            )
            max_load = float(srow["max_load_kw"]) if srow is not None else 0.0
            max_load_with = float(srow["max_load_with_storage_kw"]) if srow is not None else 0.0
            charge_kwh = float(srow["charge_energy_kwh"]) if srow is not None else 0.0
            discharge_kwh = float(srow["discharge_energy_kwh"]) if srow is not None else 0.0

            # 主口径窗口法等效次数：根据 energy_formula 选择 physics 或 sample
            eq_cycles_main = eq_phys if main_formula == "physics" else eq_samp

            monthly_rows.append(
                {
                    "year_month": ym,
                    "cycles_main": base_cycles,
                    "window_count": win_cnt,
                    "eq_cycles_physics": eq_phys,
                    "eq_cycles_sample": eq_samp,
                    "valid_days": month_valid_days,
                    "profit_main_yuan": profit_main,
                    "profit_main_equiv_yuan": profit_main_equiv,
                    "charge_energy_main_kwh": charge_kwh,
                    "discharge_energy_main_kwh": discharge_kwh,
                    "max_load_kw": max_load,
                    "max_load_with_storage_kw": max_load_with,
                    "eq_cycles_main": eq_cycles_main,
                }
            )

    if monthly_rows:
        df_monthly = pd.DataFrame(monthly_rows)
        # 月度运行统计中不再单独展示“主口径_等效次数(窗口法)”，避免与主口径_等效次数混淆
        df_monthly_for_sheet = df_monthly.drop(columns=["eq_cycles_main"], errors="ignore")
        df_monthly_zh = df_monthly_for_sheet.rename(
            columns={
                "year_month": "年月",
                "cycles_main": "主口径_等效次数",
                "window_count": "窗口数量",
                "eq_cycles_physics": "physics_等效次数(窗口法)",
                "eq_cycles_sample": "sample_等效次数(窗口法)",
                "valid_days": "有效天数(天)",
                "profit_main_yuan": "主口径_净收益(元)",
                "profit_main_equiv_yuan": "主口径_等效净收益(元)",
                "charge_energy_main_kwh": "主口径_充电电量(kWh)",
                "discharge_energy_main_kwh": "主口径_放电电量(kWh)",
                "max_load_kw": "原始最大需量(kW)",
                "max_load_with_storage_kw": "储能后最大需量(kW)",
            }
        )
        csv_path = out_dir / f"{base}_月度运行统计.csv"
        df_monthly_zh.to_csv(csv_path, index=False, encoding="utf-8-sig")
        csv_files.append(csv_path)

    # ========= Dashboard（PPT 数据源） =========
    if monthly_rows:
        # 安全地创建 DataFrame
        try:
            df_temp = pd.DataFrame(monthly_rows)
            
            # 定义需要的列
            required_cols = [
                "year_month",
                "eq_cycles_main",
                "profit_main_yuan",
                "profit_main_equiv_yuan",
                "max_load_kw",
                "max_load_with_storage_kw",
                "charge_energy_main_kwh",
                "discharge_energy_main_kwh",
            ]
            
            # 确保所有需要的列都存在
            for col in required_cols:
                if col not in df_temp.columns:
                    df_temp[col] = None  # 填充缺失的列为 None
            
            # 只选择存在的列
            available_cols = [col for col in required_cols if col in df_temp.columns]
            dash_df = df_temp[available_cols] if available_cols else pd.DataFrame(columns=required_cols)
            
            # 重命名列
            rename_map = {
                "year_month": "年月",
                "eq_cycles_main": "主口径_等效次数(窗口法)",
                "profit_main_yuan": "主口径_净收益(元)",
                "profit_main_equiv_yuan": "主口径_等效净收益(元)",
                "max_load_kw": "原始最大需量(kW)",
                "max_load_with_storage_kw": "储能后最大需量(kW)",
                "charge_energy_main_kwh": "主口径_充电电量(kWh)",
                "discharge_energy_main_kwh": "主口径_放电电量(kWh)",
            }
            # 只重命名实际存在的列
            actual_rename = {k: v for k, v in rename_map.items() if k in dash_df.columns}
            dash_df_zh = dash_df.rename(columns=actual_rename)
            
            csv_path = out_dir / f"{base}_运行看板.csv"
            dash_df_zh.to_csv(csv_path, index=False, encoding="utf-8-sig")
            csv_files.append(csv_path)
        except Exception as e:
            # 创建空的 CSV 文件占位
            csv_path = out_dir / f"{base}_运行看板_empty.csv"
            pd.DataFrame(columns=["年月", "主口径_等效次数(窗口法)", "主口径_净收益(元)", "主口径_等效净收益(元)", 
                                 "原始最大需量(kW)", "储能后最大需量(kW)", "主口径_充电电量(kWh)", "主口径_放电电量(kWh)"]).to_csv(
                csv_path, index=False, encoding="utf-8-sig")
            csv_files.append(csv_path)

    # ========= 精简 step15 曲线 =========
    if step15_slim is not None and not step15_slim.empty:
        step15_zh = step15_slim.rename(
            columns={
                "timestamp": "时间",
                "load_kw": "原始负荷(kW)",
                "load_with_storage_main_kw": "主口径_储能后负荷(kW)",
                "p_batt_kw": "储能功率(kW)",
                "soc": "SOC",
                "tier": "分时电价档位",
                "price": "电价(元/kWh)",
                "e_in_main_kwh": "主口径_充电电量(kWh)",
                "e_out_main_kwh": "主口径_放电电量(kWh)",
                "net_revenue_step15_main": "主口径_当时点净收益(元)",
            }
        )
        csv_path = out_dir / f"{base}_逐点曲线精简.csv"
        step15_zh.to_csv(csv_path, index=False, encoding="utf-8-sig")
        csv_files.append(csv_path)

    # ========= 年度现金流明细 =========
    year_cashflow_rows: List[dict] = []
    if profit_summary:
        profit_year = (profit_summary or {}).get("year") or None
        if profit_year:
            # 主口径
            main_profit = profit_year.get("main") or {}
            main_revenue = float(main_profit.get("revenue", 0.0) or 0.0)
            main_cost = float(main_profit.get("cost", 0.0) or 0.0)
            main_profit_val = float(main_profit.get("profit", 0.0) or 0.0)
            main_charge_kwh = float(main_profit.get("charge_energy_kwh", 0.0) or 0.0)
            main_discharge_kwh = float(main_profit.get("discharge_energy_kwh", 0.0) or 0.0)

            # Physics 口径
            phys_profit = profit_year.get("physics") or {}
            phys_revenue = float(phys_profit.get("revenue", 0.0) or 0.0)
            phys_cost = float(phys_profit.get("cost", 0.0) or 0.0)
            phys_profit_val = float(phys_profit.get("profit", 0.0) or 0.0)
            phys_charge_kwh = float(phys_profit.get("charge_energy_kwh", 0.0) or 0.0)
            phys_discharge_kwh = float(phys_profit.get("discharge_energy_kwh", 0.0) or 0.0)

            # Sample 口径
            samp_profit = profit_year.get("sample") or {}
            samp_revenue = float(samp_profit.get("revenue", 0.0) or 0.0)
            samp_cost = float(samp_profit.get("cost", 0.0) or 0.0)
            samp_profit_val = float(samp_profit.get("profit", 0.0) or 0.0)
            samp_charge_kwh = float(samp_profit.get("charge_energy_kwh", 0.0) or 0.0)
            samp_discharge_kwh = float(samp_profit.get("discharge_energy_kwh", 0.0) or 0.0)

            # 获取年份
            year_val = int(year.get("year", 0) or 0) if isinstance(year, dict) else 0

            year_cashflow_rows.append({
                "year": year_val,
                "main_revenue": main_revenue,
                "main_cost": main_cost,
                "main_profit": main_profit_val,
                "main_charge_kwh": main_charge_kwh,
                "main_discharge_kwh": main_discharge_kwh,
                "physics_revenue": phys_revenue,
                "physics_cost": phys_cost,
                "physics_profit": phys_profit_val,
                "physics_charge_kwh": phys_charge_kwh,
                "physics_discharge_kwh": phys_discharge_kwh,
                "sample_revenue": samp_revenue,
                "sample_cost": samp_cost,
                "sample_profit": samp_profit_val,
                "sample_charge_kwh": samp_charge_kwh,
                "sample_discharge_kwh": samp_discharge_kwh,
            })

    if year_cashflow_rows:
        df_year_cashflow = pd.DataFrame(year_cashflow_rows)
        df_year_cashflow_zh = df_year_cashflow.rename(
            columns={
                "year": "年份",
                "main_revenue": "主口径_收入(元)",
                "main_cost": "主口径_成本(元)",
                "main_profit": "主口径_净利润(元)",
                "main_charge_kwh": "主口径_充电量(kWh)",
                "main_discharge_kwh": "主口径_放电量(kWh)",
                "physics_revenue": "Physics_收入(元)",
                "physics_cost": "Physics_成本(元)",
                "physics_profit": "Physics_净利润(元)",
                "physics_charge_kwh": "Physics_充电量(kWh)",
                "physics_discharge_kwh": "Physics_放电量(kWh)",
                "sample_revenue": "Sample_收入(元)",
                "sample_cost": "Sample_成本(元)",
                "sample_profit": "Sample_净利润(元)",
                "sample_charge_kwh": "Sample_充电量(kWh)",
                "sample_discharge_kwh": "Sample_放电量(kWh)",
            }
        )
        csv_path = out_dir / f"{base}_年度现金流明细.csv"
        df_year_cashflow_zh.to_csv(csv_path, index=False, encoding="utf-8-sig")
        csv_files.append(csv_path)

    # 若无任何 CSV，返回一个空文件占位，避免前端报错
    if not csv_files:
        empty_path = out_dir / f"{base}_运行收益报表_empty.csv"
        pd.DataFrame([]).to_csv(empty_path, index=False, encoding="utf-8-sig")
        return empty_path

    # 打包为 ZIP，减小传输体积，便于一次性下载全部表格
    zip_path = out_dir / f"{base}_运行收益报表_csv.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in csv_files:
            try:
                zf.write(f, arcname=f.name)
            except Exception:
                # 某个文件写入失败不影响整体报表
                continue

    return zip_path


def build_step15_power_series(
    series_15m: pd.DataFrame,
    daily_ops: Dict[str, List[str]],
    limit_info: Dict,
    storage_cfg: Dict,
    price_series: Optional[pd.DataFrame] | None,
    *,
    window_debug: Optional[List[dict]] = None,
    energy_formula: str = "physics",
    filter_date: Optional[str] = None,
) -> pd.DataFrame:
    """构建 15 分钟粒度的功率 / 电量序列，供收益计算和曲线对比复用.

    Args:
        filter_date: 可选，'YYYY-MM-DD' 格式。若指定，则仅计算该日期的数据，大幅提升单日查询性能。

    返回的 DataFrame 以 DatetimeIndex 为索引，至少包含：
    - load_kw: 原始负荷
    - price: 电价（可能为 NaN）
    - tier: TOU 分段 ID
    - date_str: 'YYYY-MM-DD'
    - year_month: 'YYYY-MM'
    - op: 每小时运行逻辑（充/放/待机）
    - p_batt_kw: 电池侧功率（对电池为正充电，负为放电）
    - e_in_physics_kwh / e_out_physics_kwh
    - e_in_sample_kwh / e_out_sample_kwh
    - p_grid_effect_physics_kw / p_grid_effect_sample_kw
    """
    if series_15m is None or series_15m.empty:
        return pd.DataFrame()

    # 统一时间索引与列名
    s = series_15m.copy()
    if not isinstance(s.index, pd.DatetimeIndex):
        s.index = pd.to_datetime(s.index, errors="coerce")
    s = s.dropna(subset=["load_kw"]).sort_index()
    if "load_kw" not in s.columns:
        logger.warning("[profit_step15] series_15m 缺少 load_kw 列，无法计算收益")
        return pd.DataFrame()

    # 若指定 filter_date，提前过滤数据，大幅减少计算量
    if filter_date:
        s = s[s.index.strftime("%Y-%m-%d") == filter_date]
        if s.empty:
            logger.warning("[profit_step15] filter_date=%s 未找到数据", filter_date)
            return pd.DataFrame()

    # 价格序列对齐，如果不存在则补空列
    if price_series is not None and not price_series.empty:
        p = price_series.copy()
        if not isinstance(p.index, pd.DatetimeIndex):
            p.index = pd.to_datetime(p.index, errors="coerce")
        p = p.sort_index()
        # 若指定了 filter_date，也过滤价格序列
        if filter_date:
            p = p[p.index.strftime("%Y-%m-%d") == filter_date]
        joined = s.join(p[["price", "tier"]], how="left")
    else:
        joined = s.copy()
        joined["price"] = None
        joined["tier"] = None

    joined = joined.sort_index()

    # 限值信息
    month_max_map: Dict[str, float] = {
        it.get("year_month"): float(it.get("max_kw", 0) or 0)
        for it in (limit_info.get("monthly_demand_max") or [])
    }
    transformer_limit_kw = limit_info.get("transformer_limit_kw")
    limit_mode = (limit_info.get("limit_mode") or "monthly_demand_max").strip() or "monthly_demand_max"

    def _day_limit_kw(ts: pd.Timestamp) -> float:
        ym = ts.strftime("%Y-%m")
        if limit_mode == "transformer_capacity" and transformer_limit_kw:
            try:
                return float(transformer_limit_kw)
            except Exception:  # pragma: no cover
                return 0.0
        return float(month_max_map.get(ym, 0.0))

    # 储能配置
    cap = float(storage_cfg.get("capacity_kwh", 0) or 0)
    c_rate = float(storage_cfg.get("c_rate", 0.5) or 0.5)
    # 计算储能最大功率 p_max = capacity * c_rate
    p_max = cap * c_rate if cap > 0 and c_rate > 0 else 0.0
    
    # 添加详细日志用于调试
    logger.info(
        "[build_step15] storage_cfg received: capacity_kwh=%s, c_rate=%s, p_max=%s",
        cap, c_rate, p_max
    )
    logger.info("[build_step15] full storage_cfg: %s", storage_cfg)
    
    eta = float(storage_cfg.get("single_side_efficiency", 0.9) or 0.9)
    dod_cfg = float(storage_cfg.get("depth_of_discharge", 1.0) or 1.0)
    soc_min = float(storage_cfg.get("soc_min", 0.05) or 0.05)
    soc_max = float(storage_cfg.get("soc_max", 0.95) or 0.95)
    effective_dod = max(0.0, min(dod_cfg, soc_max - soc_min))
    # 兼容遗留引用，防止 NameError
    dod = effective_dod
    reserve_ch = float(storage_cfg.get("reserve_charge_kw", 0) or 0)
    reserve_dis = float(storage_cfg.get("reserve_discharge_kw", 0) or 0)
    dt_hours = 0.25
    main_formula = (energy_formula or "physics").strip()
    main_formula = main_formula if main_formula in ("physics", "sample") else "physics"

    # 运行逻辑编码（与前端 / _extract_hour_ops 保持一致）
    OP_STANDBY = "待机"
    OP_CHARGE = "充"
    OP_DISCHARGE = "放"

    def _op_for_ts(ts: pd.Timestamp) -> Optional[str]:
        day_key = ts.strftime("%Y-%m-%d")
        ops = daily_ops.get(day_key) or []
        h = ts.hour
        return ops[h] if 0 <= h < len(ops) else None

    # 构造窗口目标（基于 window_debug 的 step15 full_ratio）
    window_targets: Dict[tuple[str, str], dict] = {}
    if window_debug:
        for row in window_debug:
            try:
                date_str = str(row.get("date") or "")
                window = str(row.get("window") or "").lower()
                kind = str(row.get("kind") or "").lower()
                hours_raw = str(row.get("hour_list") or "").split(",")
                hours_set = {int(h) for h in hours_raw if str(h).strip() != ""}
                full_main = None
                key_step = f"full_ratio_{main_formula}_step15"
                key_plain = f"full_ratio_{main_formula}"
                if key_step in row and row.get(key_step) is not None:
                    full_main = float(row.get(key_step) or 0.0)
                elif key_plain in row and row.get(key_plain) is not None:
                    full_main = float(row.get(key_plain) or 0.0)
                if full_main is None:
                    full_main = 1.0
                if not date_str or window not in ("c1", "c2"):
                    continue
                tgt = window_targets.setdefault((date_str, window), {
                    "charge_hours": set(),
                    "discharge_hours": set(),
                    "full_ratio_main": full_main,
                })
                # full_ratio 取同窗口内的最大值，保守
                prev_full = tgt.get("full_ratio_main")
                if prev_full is None:
                    tgt["full_ratio_main"] = full_main
                else:
                    tgt["full_ratio_main"] = min(prev_full, full_main)
                if kind == "charge":
                    tgt["charge_hours"].update(hours_set)
                elif kind == "discharge":
                    tgt["discharge_hours"].update(hours_set)
            except Exception:
                continue

    def _window_key(ts: pd.Timestamp, op: Optional[str]) -> Optional[tuple[str, str]]:
        date_str = ts.strftime("%Y-%m-%d")
        h = ts.hour
        # 仅在 window_targets 提供信息时使用
        if not window_targets:
            return None
        candidates = []
        for (d, w), info in window_targets.items():
            if d != date_str:
                continue
            if op == OP_CHARGE and h in info.get("charge_hours", set()):
                candidates.append((d, w))
            elif op == OP_DISCHARGE and h in info.get("discharge_hours", set()):
                candidates.append((d, w))
        return candidates[0] if candidates else None

    # 窗口累计状态：charged/discharged（电网侧）
    window_state: Dict[tuple[str, str], dict] = {}

    # SOC 跟踪（电池侧能量，非电网侧）
    # 初始 SOC：默认为 soc_min（空电池状态），可由配置覆盖
    initial_soc = float(storage_cfg.get("initial_soc") or soc_min)
    current_soc = max(soc_min, min(soc_max, initial_soc))  # 限制在有效范围
    usable_capacity = cap * (soc_max - soc_min) if cap > 0 else 0.0  # 可用容量

    records: List[dict] = []
    for ts, row in joined.iterrows():
        try:
            load_kw = float(row.get("load_kw", 0.0) or 0.0)
        except Exception:  # pragma: no cover
            load_kw = 0.0

        price_val = row.get("price")
        try:
            price = float(price_val) if price_val is not None and pd.notna(price_val) else None
        except Exception:  # pragma: no cover
            price = None

        tier = row.get("tier")
        op = _op_for_ts(ts)
        limit_kw = _day_limit_kw(ts)
        win_key = _window_key(ts, op)

        # 电池侧功率：对电池为正充电，负为放电
        # 重要：功率需要受到储能最大功率 p_max = c_rate * capacity 的限制
        p_batt = 0.0
        if op == OP_CHARGE:
            # 可用充电功率 = min(需量上限 - 预留 - 负荷, 储能最大功率)
            p_batt_raw = max(limit_kw - reserve_ch - load_kw, 0.0)
            p_batt = min(p_batt_raw, p_max) if p_max > 0 else p_batt_raw
        elif op == OP_DISCHARGE:
            # 可用放电功率 = min(负荷 - 预留, 储能最大功率)
            p_batt_raw = max(load_kw - reserve_dis, 0.0)
            p_batt = -min(p_batt_raw, p_max) if p_max > 0 else -p_batt_raw
        else:
            p_batt = 0.0

        # 分别在 physics / sample 口径下计算电网侧能量
        e_in_phys = 0.0
        e_out_phys = 0.0
        e_in_sample = 0.0
        e_out_sample = 0.0

        if p_batt > 0:  # 充电
            e_batt = p_batt * dt_hours
            # physics: E_in_grid = base_kwh * DOD / η
            e_in_phys = e_batt * (effective_dod / max(eta, 1e-9))
            # sample: E_in_grid = base_kwh / DOD * η
            e_in_sample = e_batt * (eta / max(effective_dod, 1e-9))
        elif p_batt < 0:  # 放电
            e_batt = -p_batt * dt_hours
            # physics: E_out_grid = base_kwh * DOD * η
            e_out_phys = e_batt * (effective_dod * eta)
            # sample: E_out_grid = base_kwh / DOD / η
            e_out_sample = e_batt * (1.0 / max(effective_dod * eta, 1e-9))

        # 对电网视角的等效功率（正：从电网取电，负：向电网送电）
        p_grid_phys = (e_in_phys - e_out_phys) / dt_hours if dt_hours > 0 else 0.0
        p_grid_sample = (e_in_sample - e_out_sample) / dt_hours if dt_hours > 0 else 0.0

        # 在变压器容量口径下，确保“引入储能后的负荷”不会在充电段进一步突破上限
        # 注意：原始负荷本身若已超过上限，这里不会强行截断，只保证储能本身不会再向上推高。
        if limit_mode == "transformer_capacity" and limit_kw and load_kw < limit_kw:
            max_p_grid_charge = max(p_grid_phys, p_grid_sample, 0.0)
            if max_p_grid_charge > 0:
                load_with_max = load_kw + max_p_grid_charge
                if load_with_max > limit_kw + 1e-6:
                    # 允许的电网侧“额外功率”
                    allowed_extra = max(limit_kw - load_kw, 0.0)
                    if allowed_extra <= 0:
                        scale_cap = 0.0
                    else:
                        scale_cap = allowed_extra / max_p_grid_charge
                    if scale_cap < 0:
                        scale_cap = 0.0
                    if scale_cap < 1.0:
                        # 按比例缩放所有与电池相关的量，保持 physics / sample 两个口径一致
                        p_batt *= scale_cap
                        e_in_phys *= scale_cap
                        e_out_phys *= scale_cap
                        e_in_sample *= scale_cap
                        e_out_sample *= scale_cap
                        p_grid_phys *= scale_cap
                        p_grid_sample *= scale_cap

        # 禁止“余电上网”：不允许引入储能后的负荷变为负值
        # 注意：这里是针对电网视角的总负荷（原始负荷 + 储能影响），与计费口径无关。
        if load_kw > 0:
            max_discharge = max(-p_grid_phys, -p_grid_sample, 0.0)
            if max_discharge > 0:
                allowed_discharge = max(load_kw - reserve_dis, 0.0)  # 保持放电余量 reserve_dis
                if max_discharge > allowed_discharge + 1e-6:
                    scale_dis = allowed_discharge / max_discharge if allowed_discharge > 0 else 0.0
                    if scale_dis < 0:
                        scale_dis = 0.0
                    if scale_dis < 1.0:
                        p_batt *= scale_dis
                        e_in_phys *= scale_dis
                        e_out_phys *= scale_dis
                        e_in_sample *= scale_dis
                        e_out_sample *= scale_dis
                        p_grid_phys *= scale_dis
                        p_grid_sample *= scale_dis

        # 窗口充放能量目标（对称约束）
        cum_charge = None
        cum_discharge = None
        charge_target = None
        discharge_target = None
        if win_key and cap > 0 and effective_dod > 0:
            state = window_state.setdefault(win_key, {
                "charged": 0.0,
                "discharged": 0.0,
                "charge_target": None,
                "discharge_target": None,
            })
            if state["charge_target"] is None or state["discharge_target"] is None:
                info = window_targets.get(win_key, {})
                full_main = float(info.get("full_ratio_main", 1.0) or 1.0)
                usable_batt = cap * full_main
                usable_batt_dod = usable_batt * effective_dod
                charge_target = usable_batt_dod / max(eta, 1e-9)
                discharge_target = usable_batt_dod * eta
                state["charge_target"] = charge_target
                state["discharge_target"] = discharge_target
            charge_target = state["charge_target"]
            discharge_target = state["discharge_target"]
            # 按主口径能量判断超额
            e_in_main = e_in_phys if main_formula == "physics" else e_in_sample
            e_out_main = e_out_phys if main_formula == "physics" else e_out_sample
            if op == OP_CHARGE and charge_target:
                allowed = max(charge_target - state["charged"], 0.0)
                if e_in_main > allowed + 1e-9:
                    scale_win = allowed / max(e_in_main, 1e-9)
                    # 缩放所有能量/功率
                    p_batt *= scale_win
                    e_in_phys *= scale_win
                    e_out_phys *= scale_win
                    e_in_sample *= scale_win
                    e_out_sample *= scale_win
                    p_grid_phys *= scale_win
                    p_grid_sample *= scale_win
                    e_in_main = e_in_phys if main_formula == "physics" else e_in_sample
            elif op == OP_DISCHARGE and discharge_target:
                allowed = max(discharge_target - state["discharged"], 0.0)
                if e_out_main > allowed + 1e-9:
                    scale_win = allowed / max(e_out_main, 1e-9)
                    p_batt *= scale_win
                    e_in_phys *= scale_win
                    e_out_phys *= scale_win
                    e_in_sample *= scale_win
                    e_out_sample *= scale_win
                    p_grid_phys *= scale_win
                    p_grid_sample *= scale_win
                    e_out_main = e_out_phys if main_formula == "physics" else e_out_sample
            # 更新累计
            state["charged"] += e_in_main
            state["discharged"] += e_out_main
            cum_charge = state["charged"]
            cum_discharge = state["discharged"]
        else:
            cum_charge = None
            cum_discharge = None
            charge_target = None
            discharge_target = None

        # 更新 SOC（基于电池侧能量，非电网侧）
        # p_batt > 0 表示充电，< 0 表示放电
        soc_before = current_soc
        if cap > 0:
            # 电池侧能量变化（kWh）
            e_batt_change = p_batt * dt_hours  # 正=充电增加，负=放电减少
            # SOC 变化
            delta_soc = e_batt_change / cap if cap > 0 else 0.0
            current_soc = max(soc_min, min(soc_max, current_soc + delta_soc))

        records.append(
            {
                "timestamp": ts,
                "load_kw": load_kw,
                "price": price,
                "tier": tier,
                "date_str": ts.strftime("%Y-%m-%d"),
                "year_month": ts.strftime("%Y-%m"),
                "op": op or OP_STANDBY,
                "limit_kw": float(limit_kw) if limit_kw is not None else None,
                "p_max_kw": p_max,  # 储能最大功率
                "p_batt_kw": p_batt,
                "soc": current_soc,  # 当前 SOC（时间点结束时的值）
                "e_in_physics_kwh": e_in_phys,
                "e_out_physics_kwh": e_out_phys,
                "e_in_sample_kwh": e_in_sample,
                "e_out_sample_kwh": e_out_sample,
                "p_grid_effect_physics_kw": p_grid_phys,
                "p_grid_effect_sample_kw": p_grid_sample,
                "cum_charge_grid_main": cum_charge,
                "cum_discharge_grid_main": cum_discharge,
                "charge_target_grid_main": charge_target,
                "discharge_target_grid_main": discharge_target,
            }
        )

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame.from_records(records).set_index("timestamp").sort_index()
    return df


def _allocate_discharge_by_price(
    discharge_points: pd.DataFrame,
    max_discharge_energy: float,
    storage_cfg: Dict[str, Any],
    price_series: pd.Series,
) -> pd.DataFrame:
    """
    按价格优先分配放电能量（尖段优先策略）。
    
    在放电窗口内，按电价从高到低排序，优先向高价时段分配电池可放电量。
    
    参数：
        discharge_points: 放电时段点集合（已过滤 op=='放'），需包含时间索引
        max_discharge_energy: 当日最大可放电量（kWh）
        storage_cfg: 储能配置字典，需包含：
            - battery_capacity_kwh: 电池容量（kWh）
            - c_rate: 充放电倍率
        price_series: 时间索引 -> 电价（元/kWh）的映射
    
    返回：
        分配后的 DataFrame，按原时间索引排序，新增 'allocated_energy_kwh' 列
    """
    if discharge_points.empty or max_discharge_energy <= 0:
        logger.debug(f"[尖段优先] ⚠️ 放电点为空或可用能量<=0: discharge_points.empty={discharge_points.empty}, max_discharge_energy={max_discharge_energy}")
        result = discharge_points.copy()
        result['allocated_energy_kwh'] = 0.0
        return result
    
    df = discharge_points.copy()
    
    # 添加价格列（从 price_series 映射）
    df['price'] = df.index.map(price_series)
    # 对于缺失价格的点，使用 0（这些点不会参与优先分配）
    df['price'] = df['price'].fillna(0.0)
    
    logger.debug(f"[尖段优先] 📊 放电窗口包含 {len(df)} 个点，可用能量 {max_discharge_energy:.2f} kWh")
    logger.debug(f"[尖段优先] 💰 价格范围: 最高={df['price'].max():.4f} 元/kWh, 最低={df['price'].min():.4f} 元/kWh, 平均={df['price'].mean():.4f} 元/kWh")
    
    # 价格分布分析
    unique_prices = df['price'].unique()
    logger.debug(f"[尖段优先] 📈 价格档位: {len(unique_prices)} 档")
    if len(unique_prices) <= 5:
        logger.debug(f"[尖段优先] 💵 所有价格: {sorted(unique_prices, reverse=True)}")
    else:
        logger.debug(f"[尖段优先] 💵 前5高价: {sorted(unique_prices, reverse=True)[:5]}")
    
    # 按价格降序排列（价格相同时，保持原时间顺序）
    # 先重置索引以便排序
    df = df.reset_index().sort_values(['price', 'timestamp'], ascending=[False, True]).set_index('timestamp')
    
    remaining_energy = max_discharge_energy
    df['allocated_energy_kwh'] = 0.0
    
    # 这里不再重新计算“理论最大功率”，而是完全依赖传入的 per-point 上限
    # （来自时序策略或前序物理计算），仅做价格排序下的能量重分配。
    reserve_dis = float(storage_cfg.get('reserve_discharge_kw', 0) or 0)
    logger.debug(f"[尖段优先] 🔋 放电保留={reserve_dis:.2f} kW；将基于每点已有上限进行价格优先分配")
    
    allocation_count = 0
    for idx, row in df.iterrows():
        if remaining_energy <= 1e-6:  # 能量耗尽
            logger.debug(f"[尖段优先] ⚠️ 能量已耗尽，停止分配（已分配 {allocation_count} 个点）")
            break
        
        # 该点最大可放电能量：使用事先算好的 "max_e_out_main_kwh" 作为物理上限
        # 若不存在该列，则退化为使用当前时序放电量作为上限
        max_energy_this_point = float(row.get("max_e_out_main_kwh", row.get("e_out_main_kwh", 0.0)) or 0.0)

        # 再根据负荷保留做一次防御性裁剪
        load_kw = float(row.get('load_kw', 0.0) or 0.0)
        allow_by_load = max(load_kw - reserve_dis, 0.0) * 0.25
        max_energy_this_point = max(0.0, min(max_energy_this_point, allow_by_load))

        if max_energy_this_point <= 1e-9:
            continue
        
        # 实际分配能量
        allocated = min(max_energy_this_point, remaining_energy)
        df.at[idx, 'allocated_energy_kwh'] = allocated
        remaining_energy -= allocated
        allocation_count += 1
        
        if allocation_count <= 3:  # 只打印前3个分配点的详情
            logger.debug(f"[尖段优先]   → 点 {idx} (价格={row['price']:.4f}元/kWh): 分配 {allocated:.2f} kWh (剩余={remaining_energy:.2f} kWh)")
    
    total_allocated = df['allocated_energy_kwh'].sum()
    logger.debug(f"[尖段优先] ✅ 分配完成: 共分配 {total_allocated:.2f} kWh / {max_discharge_energy:.2f} kWh ({total_allocated/max_discharge_energy*100:.1f}%)")
    
    # 恢复原时间顺序
    df = df.sort_index()
    
    return df


def compute_profit_summary_step15(
    series_15m: pd.DataFrame,
    daily_ops: Dict[str, List[str]],
    limit_info: Dict,
    storage_cfg: Dict,
    price_series: Optional[pd.DataFrame] | None,
    energy_formula: str = "physics",
    window_debug: Optional[List[dict]] = None,
    discharge_strategy: str = "sequential",
) -> dict:
    """基于 step_15min 逐点积分的收益计算.
    
    v1.2.0: 新增 discharge_strategy 参数支持尖段优先策略

    参数:
        discharge_strategy: 放电能量分配策略
            - "sequential": 时序放电（默认），按时间顺序线性分配
            - "price-priority": 尖段优先，优先向高价时段分配电量

    返回结构：
    {
      "days":   { "YYYY-MM-DD": { "main": {...}, "physics": {...}, "sample": {...} } },
      "months": { "YYYY-MM":    { "main": {...}, "physics": {...}, "sample": {...} } },
      "year":   { "main": {...}, "physics": {...}, "sample": {...} } | None,
    }
    其中 {...} 对应 StorageProfit 的字段字典。
    """
    # === 函数入口日志 - 移除 emoji 避免 GBK 编码错误 ===
    import sys
    from datetime import datetime
    
    # 完整的 storage_cfg 诊断
    capacity = storage_cfg.get('batch_capacity_kwh') or storage_cfg.get('capacity_kwh')
    c_rate = storage_cfg.get('c_rate')
    
    log_msg = (
        f"\n{'='*80}\n"
        f"[ENTRY] compute_profit_summary_step15\n"
        f"  策略: {discharge_strategy}\n"
        f"  数据点数: {len(series_15m)}\n"
        f"  电池容量: {capacity} kWh\n"
        f"  C倍率: {c_rate}\n"
        f"  storage_cfg keys: {list(storage_cfg.keys())}\n"
        f"{'='*80}\n"
    )
    
    # 写入调试文件（使用 UTF-8）
    with open("debug_cycles.log", "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now()}] {log_msg}")
    
    # 只输出到 logger，不用 print（避免 GBK 编码问题）
    logger.info(log_msg)
    
    if series_15m is None or series_15m.empty:
        logger.warning(f"[{discharge_strategy}] series_15m is empty, returning empty result")
        return {"days": {}, "months": {}, "year": None}

    # 诊断daily_ops
    daily_ops_count = len(daily_ops) if daily_ops else 0
    logger.info(f"[{discharge_strategy}] daily_ops count: {daily_ops_count}, price_series length: {len(price_series) if price_series is not None else 0}")
    
    df = build_step15_power_series(
        series_15m,
        daily_ops,
        limit_info,
        storage_cfg,
        price_series,
        window_debug=window_debug,
        energy_formula=energy_formula,
    )
    
    logger.info(f"[{discharge_strategy}] build_step15_power_series returned df with {len(df)} rows")
    
    if df.empty:
        logger.warning(f"[{discharge_strategy}] df is empty after build_step15_power_series, returning empty result")
        return {"days": {}, "months": {}, "year": None}

    main_formula = (energy_formula or "physics").strip() or "physics"
    if main_formula not in ("physics", "sample"):
        main_formula = "physics"

    formulas = ("physics", "sample")

    # 调试：记录缺价点数量，便于定位收益为 0 的原因
    try:
        missing_price_points = int(df["price"].isna().sum())
        if missing_price_points > 0:
            logger.debug(
                "profit step15: missing price points=%s/%s",
                missing_price_points,
                len(df),
            )
    except Exception:  # pragma: no cover - 调试容错
        missing_price_points = 0

    # 按日聚合
    # formulas: physics/sample 两个能量口径
    # 额外增加 baseline_physical：在不重排价格的前提下，强制守住日能量上限的物理基线
    day_metrics: Dict[str, Dict[str, dict]] = {f: {} for f in formulas}
    day_metrics["baseline_physical"] = {}

    for formula in formulas:
        e_in_col = f"e_in_{formula}_kwh"
        e_out_col = f"e_out_{formula}_kwh"

        for date_str, sub in df.groupby("date_str"):
            # 深拷贝避免修改原始数据
            day_df = sub.copy()
            
            # 打印当日充电情况（每天都打印前3天的详情）
            if date_str <= df["date_str"].iloc[0] or (discharge_strategy == "price-priority" and date_str == df["date_str"].iloc[0]):
                charge_mask_debug = day_df["op"] == "充"
                discharge_mask_debug = day_df["op"] == "放"
                standby_mask_debug = day_df["op"] == "待机"
                
                logger.debug(f"\n{'='*70}")
                logger.debug(f"[{date_str}] 📅 当日运营情况诊断 (策略: {discharge_strategy or 'sequential'}):")
                logger.debug(f"{'='*70}")
                
                # 运营逻辑统计
                logger.debug(f"运营逻辑分布:")
                logger.debug(f"  充电点数: {charge_mask_debug.sum()} 个")
                logger.debug(f"  放电点数: {discharge_mask_debug.sum()} 个")
                logger.debug(f"  待机点数: {standby_mask_debug.sum()} 个")
                logger.debug(f"  总点数: {len(day_df)} 个 (应该是96个/天)")
                
                # 充电详情
                if charge_mask_debug.any():
                    charge_energy = day_df.loc[charge_mask_debug, e_in_col].sum()
                    charge_prices = day_df.loc[charge_mask_debug, "price"]
                    logger.debug(f"\n充电详情:")
                    logger.debug(f"  充电量: {charge_energy:.2f} kWh")
                    logger.debug(f"  充电价格: 最高={charge_prices.max():.4f}, 最低={charge_prices.min():.4f}, 平均={charge_prices.mean():.4f} 元/kWh")
                    logger.debug(f"  充电时段示例: {day_df.loc[charge_mask_debug].index[:3].tolist()}")
                else:
                    logger.debug(f"\n无充电点！可能导致无可放电能量")
                
                # 放电详情
                if discharge_mask_debug.any():
                    discharge_energy_orig = day_df.loc[discharge_mask_debug, e_out_col].sum()
                    discharge_prices = day_df.loc[discharge_mask_debug, "price"]
                    unique_prices = discharge_prices.unique()
                    
                    logger.debug(f"\n放电详情:")
                    logger.debug(f"  放电量(当前): {discharge_energy_orig:.2f} kWh")
                    logger.debug(f"  放电价格: 最高={discharge_prices.max():.4f}, 最低={discharge_prices.min():.4f}, 平均={discharge_prices.mean():.4f} 元/kWh")
                    logger.debug(f"  价格档位数: {len(unique_prices)} 档 (价格越多样，策略差异越大)")
                    logger.debug(f"  价格档位: {sorted(unique_prices, reverse=True)[:5]}")  # 显示前5个最高价
                    logger.debug(f"  放电时段示例: {day_df.loc[discharge_mask_debug].index[:3].tolist()}")
                    
                    # 关键诊断：价格是否有差异
                    if len(unique_prices) == 1:
                        logger.warning(f"  警告：放电窗口内所有价格相同！两种策略结果必然一致！")
                    elif discharge_prices.max() - discharge_prices.min() < 0.1:
                        logger.warning(f"  警告：价格差异很小 ({discharge_prices.max() - discharge_prices.min():.4f}元)，策略效果可能不明显")
                    else:
                        logger.info(f"  价格有差异 (相差{discharge_prices.max() - discharge_prices.min():.4f}元)，尖段优先策略应该有效")
                else:
                    logger.error(f"\n无放电点！请检查运营逻辑配置")
                
                logger.debug(f"{'='*70}\n")
            
            # 如果启用价格优先策略，重新分配放电能量（仅在 physics 口径下重排，保持物理上限不变）
            if discharge_strategy == "price-priority" and formula == main_formula:
                # 为后续分配准备：记录当前时序放电作为物理上限
                day_df["e_out_main_kwh"] = day_df[e_out_col].copy()

                # 筛选放电点（op == '放'）
                discharge_mask = day_df["op"] == "放"
                if discharge_mask.any():
                    # 计算当日最大可放电量（基于当日充电量）
                    e_in_day = float(day_df[e_in_col].sum())
                    effective_dod = storage_cfg.get("depth_of_discharge", 0.9)
                    single_side_eff = storage_cfg.get("single_side_efficiency", 0.92)
                    max_discharge = e_in_day * effective_dod * single_side_eff

                    # 提取价格序列
                    price_series_for_alloc = day_df["price"]

                    # 调用价格优先分配函数（只在当前物理上限内重排）
                    discharge_points = day_df[discharge_mask].copy()
                    logger.debug(f"\n[{date_str}] 使用尖段优先策略: 放电窗口 {len(discharge_points)} 个点，最大可放电 {max_discharge:.2f} kWh（物理上限总和={discharge_points['e_out_main_kwh'].sum():.2f} kWh）")
                    allocated_df = _allocate_discharge_by_price(
                        discharge_points,
                        max_discharge,
                        storage_cfg,
                        price_series_for_alloc,
                    )

                    # 更新放电能量
                    day_df.loc[discharge_mask, e_out_col] = allocated_df["allocated_energy_kwh"]
                    logger.debug(
                        f"[{date_str}] 放电分配完成: 实际放电 {day_df.loc[discharge_mask, e_out_col].sum():.2f} kWh / "
                        f"物理上限 {discharge_points['e_out_main_kwh'].sum():.2f} kWh\n"
                    )
            
            e_in = float(day_df[e_in_col].sum())
            e_out = float(day_df[e_out_col].sum())

            price_series_day = day_df["price"].fillna(0.0)
            cost = float((day_df[e_in_col] * price_series_day).sum())
            revenue = float((day_df[e_out_col] * price_series_day).sum())
            profit = revenue - cost
            
            # 如果是第一天，打印时序策略的对比信息
            if discharge_strategy == "sequential" and date_str == df["date_str"].iloc[0]:
                discharge_mask_seq = day_df["op"] == "放"
                if discharge_mask_seq.any():
                    logger.debug(f"\n[{date_str}] 使用时序放电策略: 放电窗口 {discharge_mask_seq.sum()} 个点")
                    logger.debug(f"[{date_str}] 时序策略收益: 放电={e_out:.2f} kWh, 收入={revenue:.2f} 元, 净利润={profit:.2f} 元\n")

            metrics = {
                "revenue": revenue,
                "cost": cost,
                "profit": profit,
                "discharge_energy_kwh": e_out,
                "charge_energy_kwh": e_in,
            }
            if e_out > 0:
                metrics["profit_per_kwh"] = profit / e_out
            else:
                metrics["profit_per_kwh"] = 0.0

            day_metrics[formula][date_str] = metrics

            # 计算物理基线（仅在主公式口径下；不改变日内形状，只裁掉超出日能量上限的部分）
            if formula == main_formula:
                effective_dod = storage_cfg.get("depth_of_discharge", 0.9)
                single_side_eff = storage_cfg.get("single_side_efficiency", 0.92)
                max_discharge = e_in * effective_dod * single_side_eff

                if e_out <= max_discharge + 1e-9:
                    # 未超出上限，基线与当前结果一致
                    baseline_e_out = e_out
                    baseline_cost = cost
                    baseline_revenue = revenue
                    baseline_profit = profit
                else:
                    # 超出上限：按比例缩放放电能量，保持形状不变
                    scale = max_discharge / max(e_out, 1e-9)
                    # 放电能量缩放只影响收入，不反向调整充电成本
                    baseline_revenue = float(((day_df[e_out_col] * scale) * price_series_day).sum())
                    baseline_e_out = float((day_df[e_out_col] * scale).sum())
                    baseline_cost = cost
                    baseline_profit = baseline_revenue - baseline_cost

                baseline_metrics = {
                    "revenue": baseline_revenue,
                    "cost": baseline_cost,
                    "profit": baseline_profit,
                    "discharge_energy_kwh": baseline_e_out,
                    "charge_energy_kwh": e_in,
                    "profit_per_kwh": baseline_profit / baseline_e_out if baseline_e_out > 0 else 0.0,
                }
                day_metrics["baseline_physical"][date_str] = baseline_metrics

    # 按月与年度聚合（基于日结果累加，避免重复计算）
    month_metrics: Dict[str, Dict[str, dict]] = {f: {} for f in formulas}
    month_metrics["baseline_physical"] = {}
    year_metrics: Dict[str, dict] = {
        f: {"revenue": 0.0, "cost": 0.0, "profit": 0.0, "discharge_energy_kwh": 0.0, "charge_energy_kwh": 0.0}
        for f in formulas
    }
    year_metrics["baseline_physical"] = {"revenue": 0.0, "cost": 0.0, "profit": 0.0, "discharge_energy_kwh": 0.0, "charge_energy_kwh": 0.0}

    for formula in list(day_metrics.keys()):
        for date_str, m in day_metrics[formula].items():
            ym = date_str[:7]
            bucket = month_metrics[formula].setdefault(
                ym,
                {"revenue": 0.0, "cost": 0.0, "profit": 0.0, "discharge_energy_kwh": 0.0, "charge_energy_kwh": 0.0},
            )
            for k in ("revenue", "cost", "profit", "discharge_energy_kwh", "charge_energy_kwh"):
                bucket[k] += float(m.get(k, 0.0) or 0.0)
                year_metrics[formula][k] += float(m.get(k, 0.0) or 0.0)

        # 计算月度单位收益
        for ym, m in month_metrics[formula].items():
            e_out = m["discharge_energy_kwh"]
            if e_out > 0:
                m["profit_per_kwh"] = m["profit"] / e_out
            else:
                m["profit_per_kwh"] = 0.0

        # 年度单位收益
        e_out_year = year_metrics[formula]["discharge_energy_kwh"]
        if e_out_year > 0:
            year_metrics[formula]["profit_per_kwh"] = year_metrics[formula]["profit"] / e_out_year
        else:
            year_metrics[formula]["profit_per_kwh"] = 0.0

    def _to_profit_dict(src: dict) -> dict:
        return {
            "revenue": float(src.get("revenue", 0.0) or 0.0),
            "cost": float(src.get("cost", 0.0) or 0.0),
            "profit": float(src.get("profit", 0.0) or 0.0),
            "discharge_energy_kwh": float(src.get("discharge_energy_kwh", 0.0) or 0.0),
            "charge_energy_kwh": float(src.get("charge_energy_kwh", 0.0) or 0.0),
            "profit_per_kwh": float(src.get("profit_per_kwh", 0.0) or 0.0),
        }

    # 组装返回结构
    days_result: Dict[str, Dict[str, dict]] = {}
    for date_str in sorted(set(df["date_str"].unique())):
        entry: Dict[str, dict] = {}
        for formula in formulas:
            m = day_metrics[formula].get(date_str)
            if m:
                entry[formula] = _to_profit_dict(m)
        if entry:
            if main_formula in entry:
                entry["main"] = entry[main_formula]
            days_result[date_str] = entry

    months_result: Dict[str, Dict[str, dict]] = {}
    all_months = set()
    for formula in formulas:
        all_months.update(month_metrics[formula].keys())
    for ym in sorted(all_months):
        entry: Dict[str, dict] = {}
        for formula in formulas:
            m = month_metrics[formula].get(ym)
            if m:
                entry[formula] = _to_profit_dict(m)
        if entry:
            if main_formula in entry:
                entry["main"] = entry[main_formula]
            months_result[ym] = entry

    year_entry: Dict[str, dict] = {}
    for formula in formulas:
        m = year_metrics[formula]
        # 如果全年完全为 0，可以认为缺少有效数据，依然返回 0 结构，便于前端展示
        year_entry[formula] = _to_profit_dict(m)
    if year_entry:
        if main_formula in year_entry:
            year_entry["main"] = year_entry[main_formula]
        year_result: Optional[dict] = year_entry
    else:
        year_result = None

    # 打印策略执行汇总
    strategy_label = "尖段优先" if discharge_strategy == "price-priority" else "时序放电"
    if year_result and "main" in year_result:
        year_profit = year_result["main"].get("profit", 0)
        year_revenue = year_result["main"].get("revenue", 0)
        year_discharge = year_result["main"].get("discharge_energy_kwh", 0)
        logger.info(f"\n{'='*60}")
        logger.info(f"{strategy_label} 策略执行完成 - 年度汇总:")
        logger.info(f"  净利润: {year_profit:.2f} 元")
        logger.info(f"  放电收入: {year_revenue:.2f} 元")
        logger.info(f"  放电量: {year_discharge:.2f} kWh")
        logger.info(f"{'='*60}\n")

    return {
        "days": days_result,
        "months": months_result,
        "year": year_result,
    }
