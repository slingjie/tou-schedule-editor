from __future__ import annotations

from io import BytesIO
from typing import Optional
import itertools
import logging
import re
from datetime import datetime

import pandas as pd


TIMESTAMP_ALIASES = {
    "timestamp",
    "时间戳",
    "采集时间",
    "记录时间",
    "datetime",
    "日期时间",
}

DATE_ALIASES = {
    "date",
    "日期",
    "数据日期",
    "记录日期",
}

TIME_ALIASES = {
    "time",
    "时间",
    "时刻",
}

LOAD_ALIASES = {
    "load",
    "负荷",
    "负荷kw",
    "负荷(k w)",  # 某些导出会出现异常空格
    "负荷(kw)",    # 常见英文括号写法
    "负荷(kW)",    # 大写W
    "负荷（kW）",   # 中文括号写法
    "功率(kw)",
    "功率(kW)",
    "功率(KW)",
    "功率",
}
logger = logging.getLogger("load-analysis")


class LoaderError(ValueError):
    """文件解析相关异常。"""


def _normalize_columns(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    frame.columns = [str(col).strip().lower() for col in frame.columns]
    return frame


def _locate_column(candidates: set[str], columns: list[str]) -> Optional[str]:
    candidates_norm = {str(c).strip().lower() for c in candidates}
    for name in columns:
        if name in candidates_norm:
            return name
    return None


def _try_read_csv(file_bytes: bytes) -> pd.DataFrame:
    """尝试以多种常见编码读取 CSV，解决 GBK/GB18030 导致的中文列名乱码问题。"""
    encodings = [
        "utf-8",
        "utf-8-sig",
        "gb18030",
        "gbk",
        "cp936",
    ]
    last_exc: Exception | None = None
    for enc in encodings:
        try:
            buffer = BytesIO(file_bytes)
            df = pd.read_csv(buffer, encoding=enc)
            logger.debug("CSV 解析成功，编码=%s，形状=%s", enc, getattr(df, "shape", None))
            return df
        except Exception as exc:  # pragma: no cover - 仅记录最后一次异常
            last_exc = exc
            continue
    raise LoaderError(
        f"无法解析CSV，请确认文件编码。已尝试编码：{', '.join(encodings)}。"
    ) from last_exc


def load_dataframe(file_bytes: bytes) -> pd.DataFrame:
    """读取 Excel/CSV 文件并提取时间戳与负荷列。"""
    if not file_bytes:
        raise LoaderError("上传文件为空。")

    buffer = BytesIO(file_bytes)
    try:
        frame = pd.read_excel(buffer)
        logger.debug("Excel 解析成功，形状=%s", getattr(frame, "shape", None))
    except Exception:
        # 尝试 CSV 解析作为兜底（含编码探测）
        frame = _try_read_csv(file_bytes)

    frame = _normalize_columns(frame)
    columns = list(frame.columns)
    logger.debug("标准化列名=%s", columns)

    timestamp_col = _locate_column(TIMESTAMP_ALIASES, columns)
    load_col = _locate_column(LOAD_ALIASES, columns)

    def _guess_timestamp_by_content() -> tuple[Optional[pd.Series], Optional[str], Optional[str]]:
        n = len(frame)
        if n == 0:
            return None, None, None
        cols = columns[:]
        # 仅在前 8 列内尝试，避免宽表性能问题
        cols = cols[: min(8, len(cols))]
        # 先尝试 两列组合 -> "日期"+"时间" 情况
        best_pair: tuple[Optional[pd.Series], Optional[str], Optional[str], int] = (None, None, None, -1)
        as_str = {c: frame[c].astype(str).str.strip() for c in cols}
        for a, b in itertools.combinations(cols, 2):
            ts = pd.to_datetime(as_str[a] + " " + as_str[b], errors="coerce")
            cnt = int(ts.notna().sum())
            if cnt > best_pair[3]:
                best_pair = (ts, a, b, cnt)
        # 再尝试 单列 直接可解析的情况
        best_single: tuple[Optional[pd.Series], Optional[str], int] = (None, None, -1)
        for c in cols:
            ts = pd.to_datetime(frame[c], errors="coerce")
            cnt = int(ts.notna().sum())
            if cnt > best_single[2]:
                best_single = (ts, c, cnt)
        threshold = max(10, int(n * 0.6))  # 至少 10 行或覆盖 60%
        if best_pair[3] >= threshold:
            logger.debug("通过内容推断时间列对: (%s, %s) 命中=%s/%s", best_pair[1], best_pair[2], best_pair[3], n)
            return best_pair[0], best_pair[1], best_pair[2]
        if best_single[2] >= threshold:
            logger.debug("通过内容推断单列时间: %s 命中=%s/%s", best_single[1], best_single[2], n)
            return best_single[0], best_single[1], None
        return None, None, None

    def _guess_load_column(excluded: set[str]) -> Optional[str]:
        best: tuple[Optional[str], float] = (None, -1.0)
        for c in columns:
            if c in excluded:
                continue
            s = pd.to_numeric(frame[c], errors="coerce")
            ratio = float(s.notna().mean()) if len(s) else 0.0
            if ratio > best[1]:
                best = (c, ratio)
        if best[0] is not None:
            logger.debug("通过内容推断负荷列: %s 命中率=%.3f", best[0], best[1])
        return best[0]

    if not timestamp_col:
        date_col = _locate_column(DATE_ALIASES, columns)
        time_col = _locate_column(TIME_ALIASES, columns)
        logger.debug("未找到单列时间戳，尝试二列组合：date=%s, time=%s", date_col, time_col)
        if date_col and time_col:
            # 先按原始“日期+时间”尝试解析
            date_str = frame[date_col].astype(str).str.strip()
            time_str = frame[time_col].astype(str).str.strip()
            timestamp_series = pd.to_datetime(
                date_str + " " + time_str,
                errors="coerce",
            )

            # 若解析率偏低，尝试中文“X月Y日/YYYY年M月D日/全角数字”等规范化后重试
            def _fullwidth_to_halfwidth(s: pd.Series) -> pd.Series:
                mapping = str.maketrans({
                    "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
                    "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
                })
                return s.astype(str).str.translate(mapping)

            def _normalize_cn_date(s: pd.Series) -> pd.Series:
                # 将“YYYY年MM月DD日”->“YYYY/MM/DD”，将“MM月DD日”->“MM/DD”，并移除多余斜杠
                s2 = _fullwidth_to_halfwidth(s).str.strip()
                s2 = (
                    s2.str.replace("年", "/", regex=False)
                       .str.replace("月", "/", regex=False)
                       .str.replace("日", "", regex=False)
                )
                s2 = s2.str.replace(r"/+", "/", regex=True).str.strip("/")
                return s2

            def _fill_year_if_missing(s: pd.Series, default_year: int) -> pd.Series:
                # 如果形如 M/D 或 MM/DD，补充默认年份
                def ensure_year(tok: str) -> str:
                    if re.match(r"^\d{1,2}/\d{1,2}$", tok or ""):
                        return f"{default_year}/" + tok
                    return tok
                return s.astype(str).apply(ensure_year)

            parse_ratio = float(timestamp_series.notna().mean()) if len(timestamp_series) else 0.0
            if parse_ratio < 0.6:
                logger.debug("标准解析率偏低(%.3f)，尝试中文日期规范化后重试", parse_ratio)
                norm_date = _normalize_cn_date(date_str)
                default_year = datetime.now().year
                norm_date = _fill_year_if_missing(norm_date, default_year)
                ts2 = pd.to_datetime(norm_date + " " + time_str, errors="coerce")
                if ts2.notna().sum() > timestamp_series.notna().sum():
                    logger.debug("中文日期规范化提升解析：%s -> %s", int(timestamp_series.notna().sum()), int(ts2.notna().sum()))
                    timestamp_series = ts2
        else:
            # 进入容错猜测：扫描列内容推断时间戳
            guessed_ts, g_date, g_time = _guess_timestamp_by_content()
            if guessed_ts is None:
                raise LoaderError(
                    f"未检测到时间戳字段，请包含 'timestamp' 或 'date'+'time' 列。实际列={columns}"
                )
            timestamp_series = guessed_ts
            # 若未命中负荷列，则基于内容再猜一次
            if load_col is None:
                used = {c for c in [g_date, g_time] if c}
                load_col = _guess_load_column(used)
    else:
        logger.debug("使用单列时间戳列：%s", timestamp_col)
        timestamp_series = pd.to_datetime(frame[timestamp_col], errors="coerce")

    if load_col is None:
        # 最后再做一次容错：按内容猜测负荷列（排除已使用的时间字段）
        used_cols: set[str] = set()
        if timestamp_col:
            used_cols.add(timestamp_col)
        # 对于二列组合的情况，上面已在猜测时处理；此处尽量不重复排除
        load_col = _guess_load_column(used_cols)
        if load_col is None:
            raise LoaderError(f"未检测到负荷字段，请包含 'load' 或 '负荷' 列。实际列={columns}")

    load_series = pd.to_numeric(frame[load_col], errors="coerce")

    df = pd.DataFrame({"timestamp": timestamp_series, "load": load_series})
    before = len(df)
    df = df.dropna(subset=["timestamp"])
    logger.debug("丢弃无效时间戳记录：%s -> %s", before, len(df))

    if df.empty:
        raise LoaderError("文件中未找到有效的时间戳记录。")

    return df
