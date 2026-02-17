from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List
from urllib.parse import quote

import pandas as pd
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.responses import HTMLResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .schemas import (
    CleanedPoint,
    CleaningAnalysisResponse,
    CleaningConfigRequest,
    CleaningResultResponse,
    ComparisonMetrics,
    ComparisonResult,
    LoadAnalysisResponse,
    MetaInfo,
    NegativeSpanDetail,
    NullSpanDetail,
    ProjectSummaryRequest,
    ProjectSummaryResponse,
    QualityReport,
    StorageCyclesDay,
    StorageCyclesMonth,
    StorageCyclesResponse,
    StorageCyclesYear,
    StorageCurvesPoint,
    StorageCurvesResponse,
    StorageCurvesSummary,
    StorageProfit,
    StorageProfitWithFormulas,
    StorageQC,
    StorageWindowMonthSummary,
    ZeroSpanDetail,
    StorageEconomicsInput,
    StorageEconomicsResult,
    StaticEconomicsMetrics,
    YearlyCashflowItem,
    ReportPdfRequest,
)
from .services import loader, quality
from .services import cycles as cycles_svc
from .services import cleaning as cleaning_svc
from .services import economics as economics_svc
from .services import local_sync as local_sync_svc
from .services import report_pdf as report_pdf_svc
from .services import report_ai_polish as report_ai_polish_svc
from .services.app_paths import OUTPUTS_DIR, ensure_dirs as _ensure_data_dirs


logger = logging.getLogger("load-analysis")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    formatter = logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.DEBUG)
logger.propagate = False


app = FastAPI(title="Load Data Analysis", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 启动时确保可写数据目录存在（桌面版落到 AppData）
_ensure_data_dirs()

# 挂载 outputs 目录用于下载导出报表（CSV/ZIP 等）
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")


@app.post("/api/load/analyze", response_model=LoadAnalysisResponse)
async def analyze_load(file: UploadFile = File(...)) -> LoadAnalysisResponse:
    """上传文件 -> 解析 -> 质量报告 + 原始点位（供前端复用）"""

    filename = file.filename or "<uploaded>"
    try:
        file_bytes = await file.read()
    except Exception as exc:  # pragma: no cover
        logger.exception("read file failed: %s", filename)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="failed to read upload file",
        ) from exc

    logger.debug(
        "received upload: name=%s size=%s bytes content_type=%s",
        filename,
        len(file_bytes),
        getattr(file, "content_type", None),
    )

    try:
        raw_df = loader.load_dataframe(file_bytes)
    except loader.LoaderError as exc:
        logger.exception("parse file failed: %s", filename)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    # 质量统计
    report_dict, meta_dict = quality.build_quality_report(raw_df)

    # 透传原始点（timestamp, load -> load_kwh）
    cleaned_points: List[CleanedPoint] = []
    if "timestamp" in raw_df.columns and "load" in raw_df.columns:
        raw_df_copy = raw_df.copy()
        raw_df_copy["timestamp"] = pd.to_datetime(raw_df_copy["timestamp"], errors="coerce")
        raw_df_copy["load"] = pd.to_numeric(raw_df_copy["load"], errors="coerce")
        for _, row in raw_df_copy.iterrows():
            ts: pd.Timestamp = row["timestamp"]  # type: ignore[assignment]
            load: float = row["load"]  # type: ignore[assignment]
            if not pd.isna(ts):
                load_val: float = float(load) if not pd.isna(load) else 0.0
                cleaned_points.append(
                    CleanedPoint(
                        timestamp=ts.to_pydatetime().isoformat(),
                        load_kwh=round(load_val, 6),
                    )
                )

    response = LoadAnalysisResponse(
        cleaned_points=cleaned_points,
        report=QualityReport.model_validate(report_dict),
        meta=MetaInfo.model_validate(meta_dict),
    )

    logger.info("file %s analyzed: records=%s", filename, meta_dict.get("total_records"))
    return response


# =========================
# 本地跨浏览器同步（Local Sync）
# =========================


@app.get("/api/local-sync/snapshot")
async def get_local_sync_snapshot() -> Dict[str, Any]:
    """返回本机保存的同步快照（用于跨浏览器自动同步）"""
    snap = local_sync_svc.read_snapshot()
    return {"exists": bool(snap), "snapshot": snap}


@app.post("/api/local-sync/snapshot")
async def put_local_sync_snapshot(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """写入同步快照（简单 LWW：拒绝比现有更旧的 exported_at）"""
    if not isinstance(body, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="body must be an object")

    incoming = body.get("snapshot") if isinstance(body.get("snapshot"), dict) else body
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="snapshot must be an object")

    existing = local_sync_svc.read_snapshot()
    ok, reason = local_sync_svc.should_accept_incoming(existing, incoming)
    if not ok:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)

    local_sync_svc.write_snapshot(incoming)
    return {"ok": True, "reason": reason}


# =========================
# 数据清洗相关 API
# =========================


@app.post("/api/cleaning/analyze", response_model=CleaningAnalysisResponse)
async def analyze_for_cleaning(
    file: UploadFile | None = File(None),
    payload: str = Form("{}"),
) -> CleaningAnalysisResponse:
    """分析数据质量，返回零值/负值/空值详情，供用户确认清洗策略
    
    可以通过上传文件或传入 payload.points 数组提供数据
    """
    file_bytes: bytes | None = None
    if file is not None:
        try:
            file_bytes = await file.read()
        except Exception as exc:
            logger.exception("read file failed")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="failed to read upload file",
            ) from exc

    payload_obj = _parse_payload(payload)
    
    # 构建 DataFrame
    try:
        if file_bytes:
            raw_df = loader.load_dataframe(file_bytes)
            # loader 返回的 DataFrame 可能是 ['timestamp', 'load'] 列，需要转换为以 timestamp 为索引的格式
            if "timestamp" in raw_df.columns:
                raw_df["timestamp"] = pd.to_datetime(raw_df["timestamp"], errors="coerce")
                load_col = "load" if "load" in raw_df.columns else "load_kw"
                if load_col != "load_kw" and load_col in raw_df.columns:
                    raw_df = raw_df.rename(columns={load_col: "load_kw"})
                raw_df = raw_df.set_index("timestamp").sort_index()
                if "load_kw" not in raw_df.columns and "load" not in raw_df.columns:
                    # 取第一列作为负荷列
                    first_col = raw_df.columns[0] if len(raw_df.columns) > 0 else None
                    if first_col:
                        raw_df = raw_df.rename(columns={first_col: "load_kw"})
            logger.debug("Loaded DataFrame shape: %s, columns: %s, index type: %s", 
                        raw_df.shape, raw_df.columns.tolist(), type(raw_df.index).__name__)
        else:
            points = payload_obj.get("points", [])
            if not points:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="no file or points provided",
                )
            # 从 points 构建 DataFrame
            df = pd.DataFrame(points)
            if "timestamp" not in df.columns:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="points must contain timestamp field",
                )
            df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
            load_col = "load_kwh" if "load_kwh" in df.columns else "load"
            if load_col not in df.columns:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="points must contain load_kwh or load field",
                )
            df = df.rename(columns={load_col: "load_kw"})
            df = df.set_index("timestamp").sort_index()
            raw_df = df[["load_kw"]]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("parse data failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"parse data failed: {exc}",
        ) from exc

    # 推断采样间隔
    interval_minutes = 15
    if len(raw_df) > 1:
        diffs = raw_df.index.to_series().diff().dropna()
        if not diffs.empty:
            mode_seconds = diffs.dt.total_seconds().mode()
            if len(mode_seconds) > 0:
                interval_minutes = int(mode_seconds.iloc[0] / 60)
                interval_minutes = max(1, min(interval_minutes, 60))

    # 执行清洗分析
    analysis = cleaning_svc.analyze_data_for_cleaning(raw_df, interval_minutes)
    analysis_dict = cleaning_svc.analysis_to_dict(analysis)
    
    # 转换为响应模型
    return CleaningAnalysisResponse(
        null_point_count=analysis_dict["null_point_count"],
        null_hours=analysis_dict["null_hours"],
        null_spans=[NullSpanDetail(**span) for span in analysis_dict["null_spans"]],
        zero_spans=[ZeroSpanDetail(**span) for span in analysis_dict["zero_spans"]],
        total_zero_hours=analysis_dict["total_zero_hours"],
        negative_spans=[NegativeSpanDetail(**span) for span in analysis_dict["negative_spans"]],
        total_negative_points=analysis_dict["total_negative_points"],
        total_expected_points=analysis_dict["total_expected_points"],
        total_actual_points=analysis_dict["total_actual_points"],
        completeness_ratio=analysis_dict["completeness_ratio"],
    )


@app.post("/api/cleaning/apply", response_model=CleaningResultResponse)
async def apply_cleaning(
    file: UploadFile | None = File(None),
    payload: str = Form("{}"),
) -> CleaningResultResponse:
    """应用清洗配置，返回清洗后的数据
    
    payload 中应包含:
    - points: 数据点数组（可选，如果不上传文件）
    - config: 清洗配置
      - null_strategy: 'interpolate' | 'delete' | 'keep'
      - negative_strategy: 'keep' | 'abs' | 'zero'
      - zero_decisions: {span_id: 'normal' | 'abnormal'}
    """
    file_bytes: bytes | None = None
    if file is not None:
        try:
            file_bytes = await file.read()
        except Exception as exc:
            logger.exception("read file failed")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="failed to read upload file",
            ) from exc

    payload_obj = _parse_payload(payload)
    
    # 构建 DataFrame
    try:
        if file_bytes:
            raw_df = loader.load_dataframe(file_bytes)
            # 转换列名
            if "load" in raw_df.columns and "load_kw" not in raw_df.columns:
                raw_df = raw_df.rename(columns={"load": "load_kw"})
            raw_df = raw_df.set_index("timestamp") if "timestamp" in raw_df.columns else raw_df
        else:
            points = payload_obj.get("points", [])
            if not points:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="no file or points provided",
                )
            df = pd.DataFrame(points)
            df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
            load_col = "load_kwh" if "load_kwh" in df.columns else "load"
            df = df.rename(columns={load_col: "load_kw"})
            df = df.set_index("timestamp").sort_index()
            raw_df = df[["load_kw"]]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("parse data failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"parse data failed: {exc}",
        ) from exc

    # 推断采样间隔
    interval_minutes = 15
    if len(raw_df) > 1:
        diffs = raw_df.index.to_series().diff().dropna()
        if not diffs.empty:
            mode_seconds = diffs.dt.total_seconds().mode()
            if len(mode_seconds) > 0:
                interval_minutes = int(mode_seconds.iloc[0] / 60)
                interval_minutes = max(1, min(interval_minutes, 60))

    # 执行清洗分析
    analysis = cleaning_svc.analyze_data_for_cleaning(raw_df, interval_minutes)
    
    # 解析清洗配置
    config_dict = payload_obj.get("config", {})
    config = cleaning_svc.CleaningConfig(
        null_strategy=config_dict.get("null_strategy", "interpolate"),
        negative_strategy=config_dict.get("negative_strategy", "keep"),
        zero_decisions=config_dict.get("zero_decisions", {}),
    )
    
    # 应用清洗
    result = cleaning_svc.apply_cleaning(raw_df, config, analysis, interval_minutes)
    
    # 转换清洗后的数据为 CleanedPoint 列表
    cleaned_points: List[CleanedPoint] = []
    for ts, row in result.cleaned_df.iterrows():
        load_val = float(row["load_kw"]) if pd.notna(row["load_kw"]) else 0.0
        cleaned_points.append(
            CleanedPoint(
                timestamp=ts.isoformat(),
                load_kwh=round(load_val, 6),
            )
        )
    
    return CleaningResultResponse(
        null_points_interpolated=result.null_points_interpolated,
        zero_spans_kept=result.zero_spans_kept,
        zero_spans_interpolated=result.zero_spans_interpolated,
        negative_points_kept=result.negative_points_kept,
        negative_points_modified=result.negative_points_modified,
        interpolated_count=int(result.interpolated_mask.sum()),
        cleaned_points=cleaned_points,
    )


@app.get("/health")
async def health_check() -> dict[str, str]:
    """简单健康检查"""

    return {"status": "ok"}


@app.get("/api/debug/runtime")
async def debug_runtime() -> Dict[str, Any]:
    """运行时自检：用于排查“端口指向对了但路由缺失/代码未更新”等问题（仅本地调试使用）"""

    paths = sorted({getattr(r, "path", "") for r in app.routes})
    return {
        "python": {"executable": os.sys.executable, "version": os.sys.version},
        "cwd": os.getcwd(),
        "app_file": __file__,
        "has_local_sync": "/api/local-sync/snapshot" in paths,
        "paths": paths,
    }


def _parse_payload(payload: str | Dict[str, Any]) -> Dict[str, Any]:
    """解析前端 FormData 中的 payload 字段"""

    try:
        obj = json.loads(payload) if isinstance(payload, str) else payload
        if not isinstance(obj, dict):
            raise ValueError("payload must be an object")
        return obj
    except Exception as exc:  # pragma: no cover - 防御性兜底
        logger.exception(
            "payload parse failed: %s",
            payload[:200] if isinstance(payload, str) else type(payload),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="payload is not a valid JSON object string",
        ) from exc


def _build_series_15m_from_payload(
    payload_obj: Dict[str, Any],
    file_bytes: bytes | None,
) -> pd.DataFrame:
    """根据 payload.points 或上传文件构建 15min 负荷序列"""

    points = payload_obj.get("points")
    if isinstance(points, list) and points:
        try:
            return cycles_svc.parse_points_series(points)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"points parse failed: {exc}",
            ) from exc

    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="no upload file or points provided",
        )
    try:
        return cycles_svc.parse_load_series(file_bytes)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


@app.post("/api/storage/cycles", response_model=StorageCyclesResponse)
async def compute_storage_cycles(
    file: UploadFile | None = File(None),
    payload: str = Form(...),
    export_excel: bool = Form(False),
    export_mode: str = Form("debug"),
) -> StorageCyclesResponse:
    """储能等效满充满放次数 + 收益 + 质量指标.

    当 ``export_excel=True`` 时，后端会在完成测算的基础上按需导出 Excel 报表。
    为保持向后兼容：
    - 旧版前端只传 ``export_excel=true``，默认导出“详细调试报表”（原有行为保持不变）；
    - 新版前端可通过额外的表单字段 ``export_mode=business|debug`` 指定导出报表类型。
    """

    filename: str | None = None
    file_bytes: bytes | None = None

    if file is not None:
        try:
            filename = file.filename or "<uploaded>"
            file_bytes = await file.read()
        except Exception as exc:  # pragma: no cover
            logger.exception("read file failed: %s", filename)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="failed to read upload file",
            ) from exc

    payload_obj = _parse_payload(payload)

    # 15min 负荷序列
    series_15m = _build_series_15m_from_payload(payload_obj, file_bytes)

    # 储能配置
    storage_cfg = payload_obj.get("storage") if isinstance(payload_obj, dict) else None
    if not isinstance(storage_cfg, dict):
        storage_cfg = {}
    metering_mode = storage_cfg.get("metering_mode", "monthly_demand_max")
    transformer_capacity_kva = storage_cfg.get("transformer_capacity_kva")
    transformer_power_factor = storage_cfg.get("transformer_power_factor")
    merge_threshold_minutes = storage_cfg.get("merge_threshold_minutes", 30)

    # 限值信息
    limit_info = cycles_svc.compute_limit_info(
        series_15m,
        metering_mode=metering_mode,
        transformer_capacity_kva=transformer_capacity_kva,
        transformer_power_factor=transformer_power_factor,
    )

    # 策略 -> daily_ops / daily_masks
    strategy_src = payload_obj.get("strategySource") if isinstance(payload_obj, dict) else None
    if not isinstance(strategy_src, dict):
        strategy_src = {}
    monthly_schedule = strategy_src.get("monthlySchedule")
    date_rules = strategy_src.get("dateRules")

    try:
        daily_ops = cycles_svc.build_daily_ops(series_15m, monthly_schedule, date_rules)
        daily_masks, merged_cnt, runs_debug = cycles_svc.build_daily_cycles_masks(
            daily_ops,
            merge_threshold_minutes=merge_threshold_minutes,
            wrap_across_midnight=True,
        )
    except Exception as exc:
        logger.exception("strategy build failed: %s", exc)
        daily_ops = {}
        daily_masks = {}
        merged_cnt = 0
        runs_debug = []
        extra_notes: List[str] = ["strategy build failed: " + str(exc)]
    else:
        extra_notes = []

    # TOU 映射（用于价格与 QC）
    monthly_prices = payload_obj.get("monthlyTouPrices") if isinstance(payload_obj, dict) else None
    try:
        price_series, missing_points_cnt = cycles_svc.build_price_series(
            series_15m,
            monthly_schedule=monthly_schedule,
            date_rules=date_rules,
            monthly_prices=monthly_prices,
        )
    except Exception as exc:
        logger.exception("TOU map failed: %s", exc)
        price_series = pd.DataFrame(index=series_15m.index, data={"tier": [], "price": []})
        missing_points_cnt = 0
        extra_notes.append("TOU map failed: " + str(exc))
    else:
        if missing_points_cnt > 0:
            extra_notes.append(
                f"TOU 价格缺失 {missing_points_cnt} 个 15 分钟点，收益按 0 处理并记录到 missing_prices。"
            )

    # 核心 window_avg 计算
    energy_formula = storage_cfg.get("energy_formula", "physics") or "physics"
    try:
        days_raw, window_debug = cycles_svc.compute_window_avg_days_with_debug(
            series_15m,
            daily_masks=daily_masks,
            storage_cfg=storage_cfg,
            limit_info=limit_info,
            energy_formula=energy_formula,
        )
    except Exception as exc:
        logger.exception("window_avg compute failed: %s", exc)
        days_raw, window_debug = [], []

    # 获取放电策略（新增参数）
    discharge_strategy = storage_cfg.get("discharge_strategy", "sequential") or "sequential"
    if discharge_strategy not in ("sequential", "price-priority"):
        discharge_strategy = "sequential"
    
    # 基于 step_15min 的收益汇总
    try:
        if daily_ops and not price_series.empty:
            profit_summary = cycles_svc.compute_profit_summary_step15(
                series_15m,
                daily_ops=daily_ops,
                limit_info=limit_info,
                storage_cfg=storage_cfg,
                price_series=price_series,
                energy_formula=energy_formula,
                window_debug=window_debug,
                discharge_strategy=discharge_strategy,
            )
        else:
            profit_summary = {"days": {}, "months": {}, "year": None}
    except Exception as exc:
        logger.exception("profit compute failed: %s", exc)
        extra_notes.append("profit compute failed: " + str(exc))
        profit_summary = {"days": {}, "months": {}, "year": None}

    profit_days = (profit_summary or {}).get("days") or {}
    profit_months = (profit_summary or {}).get("months") or {}
    profit_year = (profit_summary or {}).get("year") or None

    # 日 / 月 / 年 cycles + profit 映射
    days: List[StorageCyclesDay] = []
    month_map: Dict[str, float] = {}
    month_valid_days: Dict[str, int] = {}  # 新增：月度有效天数统计
    year_set: set[int] = set()
    total_valid_days = 0  # 新增：全年有效天数
    
    for d in days_raw:
        date_str = str(d.get("date"))
        cycles_val = float(d.get("cycles", 0.0) or 0.0)
        is_valid = bool(d.get("is_valid", True))
        point_count = int(d.get("point_count", 96) or 96)
        
        ym = date_str[:7]
        month_map[ym] = month_map.get(ym, 0.0) + cycles_val
        
        # 统计有效天数
        if is_valid:
            month_valid_days[ym] = month_valid_days.get(ym, 0) + 1
            total_valid_days += 1
        
        try:
            year_set.add(int(date_str[:4]))
        except Exception:
            pass

        profit_payload = profit_days.get(date_str) or {}
        day_profit_obj: StorageProfitWithFormulas | None = None
        if profit_payload:
            day_profit_obj = StorageProfitWithFormulas(
                main=StorageProfit(**profit_payload["main"]) if profit_payload.get("main") else None,
                physics=StorageProfit(**profit_payload["physics"]) if profit_payload.get("physics") else None,
                sample=StorageProfit(**profit_payload["sample"]) if profit_payload.get("sample") else None,
            )
        days.append(
            StorageCyclesDay(
                date=date_str,
                cycles=cycles_val,
                profit=day_profit_obj,
                is_valid=is_valid,
                point_count=point_count,
            )
        )

    months: List[StorageCyclesMonth] = []
    for ym, cyc in sorted(month_map.items()):
        profit_payload = profit_months.get(ym) or {}
        month_profit_obj: StorageProfitWithFormulas | None = None
        if profit_payload:
            month_profit_obj = StorageProfitWithFormulas(
                main=StorageProfit(**profit_payload["main"]) if profit_payload.get("main") else None,
                physics=StorageProfit(**profit_payload["physics"]) if profit_payload.get("physics") else None,
                sample=StorageProfit(**profit_payload["sample"]) if profit_payload.get("sample") else None,
            )
        months.append(
            StorageCyclesMonth(
                year_month=ym,
                cycles=float(cyc),
                profit=month_profit_obj,
                valid_days=month_valid_days.get(ym, 0),  # 新增：月度有效天数
            )
        )

    total_cycles = sum(float(m.cycles) for m in months)
    year_val = list(year_set)[0] if len(year_set) == 1 else 0
    year_profit_obj: StorageProfitWithFormulas | None = None
    if isinstance(profit_year, dict) and profit_year:
        year_profit_obj = StorageProfitWithFormulas(
            main=StorageProfit(**profit_year["main"]) if profit_year.get("main") else None,
            physics=StorageProfit(**profit_year["physics"]) if profit_year.get("physics") else None,
            sample=StorageProfit(**profit_year["sample"]) if profit_year.get("sample") else None,
        )
    year_summary = StorageCyclesYear(
        year=year_val,
        cycles=float(total_cycles),
        profit=year_profit_obj,
        valid_days=total_valid_days,  # 新增：全年有效天数
    )

    qc = StorageQC(
        notes=(limit_info.get("notes", []) + extra_notes),
        limit_mode=limit_info.get("limit_mode"),
        transformer_limit_kw=limit_info.get("transformer_limit_kw"),
        monthly_demand_max=limit_info.get("monthly_demand_max", []),
        merged_segments=int(merged_cnt) if "merged_cnt" in locals() else 0,
        missing_prices=int(missing_points_cnt),
    )

    # 尖段放电占比
    try:
        tip_summary_dict = (
            cycles_svc.compute_tip_discharge_summary(
                series_15m,
                price_series,
                daily_ops=daily_ops,
                daily_masks=daily_masks,
                storage_cfg=storage_cfg,
            )
            if not price_series.empty
            else None
        )
    except Exception as exc:  # pragma: no cover
        tip_summary_dict = None
        qc.notes.append(f"tip summary failed: {exc}")

    # Window_debug -> WindowMonthSummary
    window_month_summary: List[StorageWindowMonthSummary] = []
    if window_debug:
        agg: Dict[str, Dict[str, float]] = {}
        for row in window_debug:
            try:
                date_str = str(row.get("date") or "")
                if len(date_str) < 7:
                    continue
                ym = date_str[:7]
                win = str(row.get("window") or "").lower()
                kind = str(row.get("kind") or "").lower()
                if energy_formula == "physics":
                    ratio = float(row.get("full_ratio_physics_step15", 0.0) or 0.0)
                else:
                    ratio = float(row.get("full_ratio_sample_step15", 0.0) or 0.0)
                if ratio == 0.0:
                    continue
                bucket = agg.setdefault(
                    ym,
                    {
                        "first_charge_cycles": 0.0,
                        "first_discharge_cycles": 0.0,
                        "second_charge_cycles": 0.0,
                        "second_discharge_cycles": 0.0,
                    },
                )
                if win == "c1" and kind == "charge":
                    bucket["first_charge_cycles"] += ratio
                elif win == "c1" and kind == "discharge":
                    bucket["first_discharge_cycles"] += ratio
                elif win == "c2" and kind == "charge":
                    bucket["second_charge_cycles"] += ratio
                elif win == "c2" and kind == "discharge":
                    bucket["second_discharge_cycles"] += ratio
            except Exception:
                # 单行异常不影响整体
                continue

        for ym, vals in sorted(agg.items()):
            window_month_summary.append(
                StorageWindowMonthSummary(
                    year_month=ym,
                    first_charge_cycles=float(vals.get("first_charge_cycles", 0.0) or 0.0),
                    first_discharge_cycles=float(vals.get("first_discharge_cycles", 0.0) or 0.0),
                    second_charge_cycles=float(vals.get("second_charge_cycles", 0.0) or 0.0),
                    second_discharge_cycles=float(vals.get("second_discharge_cycles", 0.0) or 0.0),
                )
            )

    logger.info("/api/storage/cycles: source=%s points=%s", filename, isinstance(payload_obj.get("points"), list) and len(payload_obj.get("points") or []))
    logger.info(
        "/api/storage/cycles done: days=%s months=%s year_cycles=%s window_months=%s",
        len(days),
        len(months),
        total_cycles,
        len(window_month_summary),
    )

    # Excel 导出改为“按需触发”：仅当 export_excel=True 时才生成报表，
    # 默认情况下不导出，以减少每次测算的耗时。
    excel_rel: str | None = None
    if export_excel:
        from datetime import datetime as _dt  # noqa: WPS433
        from pathlib import Path as _Path  # noqa: WPS433

        ts_dir = _dt.now().strftime("%Y%m%d_%H%M%S")
        out_dir = OUTPUTS_DIR / ts_dir
        try:
            # 生成逐 15 分钟功率 / 负荷序列，供导出调试
            try:
                step15_df = cycles_svc.build_step15_power_series(
                    series_15m,
                    daily_ops=daily_ops,
                    limit_info=limit_info,
                    storage_cfg=storage_cfg,
                    price_series=price_series,
                    window_debug=window_debug,
                    energy_formula=energy_formula,
                )
            except Exception as exc:  # pragma: no cover - 调试容错
                logger.exception(
                    "build_step15_power_series failed during export: %s",
                    exc,
                )
                step15_df = pd.DataFrame()

            ops_rows: List[Dict[str, Any]] = []
            for dkey, ops in sorted(daily_ops.items(), key=lambda kv: kv[0]):
                row = {"date": dkey}
                for h in range(24):
                    keyh = f"h{h:02d}"
                    row[keyh] = ops[h] if h < len(ops) else None
                ops_rows.append(row)

            # 根据导出模式选择报表类型：
            # - business: 运行与收益业务报表（多 Sheet，面向汇报与复用）；
            # - 其他/默认: 详细调试报表（原有结构，包含 window_debug 等）。
            mode = (export_mode or "debug").strip().lower()
            if mode == "business":
                xlsx_path = cycles_svc.export_business_report(
                    out_dir,
                    source_filename=filename or "points_payload",
                    days=[d.model_dump() for d in days],
                    months=[{"year_month": m.year_month, "cycles": m.cycles} for m in months],
                    year={"year": year_summary.year, "cycles": year_summary.cycles},
                    profit_summary=profit_summary,
                    step15_df=step15_df,
                    window_debug=window_debug,
                    energy_formula=energy_formula,
                )
                # 转换为可通过 /outputs 静态路径访问的相对 URL
                try:
                    rel = xlsx_path.relative_to(OUTPUTS_DIR)
                    excel_rel = f"/outputs/{rel.as_posix()}"
                except Exception:
                    excel_rel = f"/outputs/{xlsx_path.name}"
            else:
                xlsx_path, summary_csv_path = cycles_svc.export_excel_report(
                    out_dir,
                    source_filename=filename or "points_payload",
                    days=[d.model_dump() for d in days],
                    months=[{"year_month": m.year_month, "cycles": m.cycles} for m in months],
                    year={"year": year_summary.year, "cycles": year_summary.cycles},
                    monthly_prices=monthly_prices if isinstance(monthly_prices, list) else None,
                    limit_info=limit_info,
                    qc_dict=qc.model_dump(),
                    window_debug=window_debug,
                    ops_by_hour=ops_rows,
                    runs_debug=runs_debug,
                    profit_summary=profit_summary,
                    step15_df=step15_df,
                    energy_formula=energy_formula,
                )
                try:
                    rel = xlsx_path.relative_to(OUTPUTS_DIR)
                    excel_rel = f"/outputs/{rel.as_posix()}"
                except Exception:
                    excel_rel = f"/outputs/{xlsx_path.name}"
                if summary_csv_path:
                    try:
                        qc.notes.append(f"summary csv: {summary_csv_path.as_posix()}")
                    except Exception:
                        pass
        except Exception as exc:  # pragma: no cover
            logger.exception("export excel failed: %s", exc)
            excel_rel = None
            qc.notes.append("export excel failed: " + str(exc))

    return StorageCyclesResponse(
        year=year_summary,
        months=months,
        days=days,
        qc=qc,
        excel_path=excel_rel,
        window_month_summary=window_month_summary or None,
        tip_discharge_summary=tip_summary_dict,
    )


@app.post("/api/storage/cycles/curves", response_model=StorageCurvesResponse)
async def compute_storage_curves(
    body: Dict[str, Any] = Body(..., description="payload + date"),
) -> StorageCurvesResponse:
    """根据与 /cycles 相同的 payload + 指定 date，返回原始负荷与储能后的对比曲线."""

    if not isinstance(body, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="body must be an object")

    payload_obj = body.get("payload")
    date_str = body.get("date")
    if not isinstance(payload_obj, (dict, str)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="payload is required")
    if not isinstance(date_str, str) or len(date_str) != 10:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="date must be YYYY-MM-DD")

    # 为了避免与 /cycles 行为不一致，这里仅支持 points 模式，不再处理上传文件
    payload_dict = _parse_payload(payload_obj)
    series_15m = _build_series_15m_from_payload(payload_dict, file_bytes=None)

    # 储能配置与策略
    storage_cfg = payload_dict.get("storage") if isinstance(payload_dict, dict) else None
    if not isinstance(storage_cfg, dict):
        storage_cfg = {}
    
    # 添加日志调试
    logger.info(
        "[curves API] storage_cfg received: capacity_kwh=%s, c_rate=%s",
        storage_cfg.get("capacity_kwh"),
        storage_cfg.get("c_rate"),
    )
    logger.info("[curves API] full storage_cfg: %s", storage_cfg)

    strategy_src = payload_dict.get("strategySource") if isinstance(payload_dict, dict) else None
    if not isinstance(strategy_src, dict):
        strategy_src = {}
    monthly_schedule = strategy_src.get("monthlySchedule")
    date_rules = strategy_src.get("dateRules")

    try:
        daily_ops = cycles_svc.build_daily_ops(series_15m, monthly_schedule, date_rules)
    except Exception as exc:
        logger.exception("strategy build failed (curves): %s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"strategy build failed: {exc}") from exc

    # TOU 价格
    monthly_prices = payload_dict.get("monthlyTouPrices") if isinstance(payload_dict, dict) else None
    try:
        price_series, _ = cycles_svc.build_price_series(
            series_15m,
            monthly_schedule=monthly_schedule,
            date_rules=date_rules,
            monthly_prices=monthly_prices,
        )
    except Exception as exc:
        logger.exception("TOU map failed (curves): %s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"TOU map failed: {exc}") from exc

    # 限值信息（与 /cycles 保持一致）
    metering_mode = storage_cfg.get("metering_mode", "monthly_demand_max")
    transformer_capacity_kva = storage_cfg.get("transformer_capacity_kva")
    transformer_power_factor = storage_cfg.get("transformer_power_factor")
    limit_info = cycles_svc.compute_limit_info(
        series_15m,
        metering_mode=metering_mode,
        transformer_capacity_kva=transformer_capacity_kva,
        transformer_power_factor=transformer_power_factor,
    )

    energy_formula = storage_cfg.get("energy_formula", "physics") or "physics"

    # 为了与 /api/storage/cycles 行为保持一致，这里也构造 daily_masks 和 window_debug，
    # 使 step15 功率/能量计算与次数计算使用同一套窗口约束。
    merge_threshold_minutes = storage_cfg.get("merge_threshold_minutes", 30)
    try:
        daily_masks, _, window_debug = cycles_svc.build_daily_cycles_masks(
            daily_ops,
            merge_threshold_minutes=merge_threshold_minutes,
            wrap_across_midnight=True,
        )
        _, window_debug = cycles_svc.compute_window_avg_days_with_debug(
            series_15m,
            daily_masks=daily_masks,
            storage_cfg=storage_cfg,
            limit_info=limit_info,
            energy_formula=energy_formula,
        )
    except Exception as exc:  # pragma: no cover - 降级为无窗口目标的行为
        logger.exception("window_debug build failed (curves): %s", exc)
        daily_masks = {}
        window_debug = None

    # 重用 step15 功率/电量序列，传入 filter_date 以仅计算单日数据，大幅提升性能
    df = cycles_svc.build_step15_power_series(
        series_15m,
        daily_ops=daily_ops,
        limit_info=limit_info,
        storage_cfg=storage_cfg,
        price_series=price_series,
        window_debug=window_debug,
        energy_formula=energy_formula,
        filter_date=date_str,
    )
    if df.empty:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"no data for date={date_str}")

    # 使用过滤后的数据（filter_date 已在 build_step15_power_series 中完成过滤）
    df_day = df

    # 原始负荷与储能后的负荷
    dt_hours = 0.25
    if energy_formula == "physics":
        p_grid_effect = df_day["p_grid_effect_physics_kw"]
    else:
        p_grid_effect = df_day["p_grid_effect_sample_kw"]

    load_original = df_day["load_kw"]
    load_with_storage = load_original + p_grid_effect

    # 调试日志：输出关键计算参数
    p_max_debug = float(storage_cfg.get("capacity_kwh", 0) or 0) * float(storage_cfg.get("c_rate", 0.5) or 0.5)
    logger.info(
        "[curves API] DEBUG: p_max=%s, max(p_grid_effect)=%s, min(p_grid_effect)=%s, max(load_with_storage)=%s",
        p_max_debug,
        float(p_grid_effect.max()) if not p_grid_effect.empty else 0,
        float(p_grid_effect.min()) if not p_grid_effect.empty else 0,
        float(load_with_storage.max()) if not load_with_storage.empty else 0,
    )
    # 检查是否有 p_batt_kw 列
    if "p_batt_kw" in df_day.columns:
        logger.info(
            "[curves API] DEBUG: max(p_batt_kw)=%s, min(p_batt_kw)=%s",
            float(df_day["p_batt_kw"].max()),
            float(df_day["p_batt_kw"].min()),
        )

    points_original: List[StorageCurvesPoint] = []
    points_with_storage: List[StorageCurvesPoint] = []
    for ts, row in df_day.iterrows():
        ts_iso = pd.to_datetime(ts).to_pydatetime().isoformat()
        points_original.append(
            StorageCurvesPoint(timestamp=ts_iso, load_kw=float(row["load_kw"] or 0.0)),
        )
        points_with_storage.append(
            StorageCurvesPoint(timestamp=ts_iso, load_kw=float(row["load_kw"] + p_grid_effect.loc[ts])),
        )

    # 关键指标汇总
    max_demand_original_kw = float(load_original.max() or 0.0)
    max_demand_new_kw = float(load_with_storage.max() or 0.0)
    max_demand_reduction_kw = max_demand_original_kw - max_demand_new_kw
    max_demand_reduction_ratio = (
        max_demand_reduction_kw / max_demand_original_kw if max_demand_original_kw > 0 else 0.0
    )

    # 分 TOU 分段的电量与电费
    energy_by_tier_original: Dict[str, float] = {}
    energy_by_tier_new: Dict[str, float] = {}
    bill_by_tier_original: Dict[str, float] = {}
    bill_by_tier_new: Dict[str, float] = {}

    for _, row in df_day.iterrows():
        tier = str(row.get("tier") or "")
        if not tier:
            continue
        load_orig = float(row["load_kw"] or 0.0)
        load_new = float(load_orig + p_grid_effect.loc[row.name])
        e_orig = load_orig * dt_hours
        e_new = load_new * dt_hours
        price = row.get("price")
        try:
            price_val = float(price) if price is not None and pd.notna(price) else 0.0
        except Exception:
            price_val = 0.0

        energy_by_tier_original[tier] = energy_by_tier_original.get(tier, 0.0) + e_orig
        energy_by_tier_new[tier] = energy_by_tier_new.get(tier, 0.0) + e_new
        bill_by_tier_original[tier] = bill_by_tier_original.get(tier, 0.0) + e_orig * price_val
        bill_by_tier_new[tier] = bill_by_tier_new.get(tier, 0.0) + e_new * price_val

    # 使用已实现的收益汇总，提取该日主口径收益
    profit_day_main: StorageProfit | None = None
    try:
        if energy_formula == "physics":
            e_in_col = "e_in_physics_kwh"
            e_out_col = "e_out_physics_kwh"
        else:
            e_in_col = "e_in_sample_kwh"
            e_out_col = "e_out_sample_kwh"

        e_in = float(df_day[e_in_col].sum())
        e_out = float(df_day[e_out_col].sum())
        price_series_day = df_day["price"].fillna(0.0)
        cost = float((df_day[e_in_col] * price_series_day).sum())
        revenue = float((df_day[e_out_col] * price_series_day).sum())
        profit_val = revenue - cost
        profit_day_main = StorageProfit(
            revenue=revenue,
            cost=cost,
            profit=profit_val,
            discharge_energy_kwh=e_out,
            charge_energy_kwh=e_in,
            profit_per_kwh=(profit_val / e_out) if e_out > 0 else 0.0,
        )
    except Exception:
        profit_day_main = None

    summary = StorageCurvesSummary(
        max_demand_original_kw=max_demand_original_kw,
        max_demand_new_kw=max_demand_new_kw,
        max_demand_reduction_kw=max_demand_reduction_kw,
        max_demand_reduction_ratio=max_demand_reduction_ratio,
        energy_by_tier_original=energy_by_tier_original,
        energy_by_tier_new=energy_by_tier_new,
        bill_by_tier_original=bill_by_tier_original,
        bill_by_tier_new=bill_by_tier_new,
        profit_day_main=profit_day_main,
    )

    return StorageCurvesResponse(
        date=date_str,
        points_original=points_original,
        points_with_storage=points_with_storage,
        summary=summary,
    )


@app.post("/api/deepseek/project-summary", response_model=ProjectSummaryResponse)
async def generate_project_summary_endpoint(
    request: ProjectSummaryRequest,
) -> ProjectSummaryResponse:
    """
    生成项目评估报告（基于 DeepSeek）。
    
    前端传入项目基本信息与各模块可选数据，后端调用 DeepSeek API 生成 Markdown 报告。
    """
    from datetime import datetime, timezone
    from .services.deepseek_summary import generate_project_summary, DeepSeekError
    
    # 构建项目信息
    project_info = {
        "name": request.project_name,
        "location": request.project_location,
        "periodStart": request.period_start,
        "periodEnd": request.period_end,
        "periodDescription": f"{request.period_start} 至 {request.period_end}",
        "loadDataSource": "用户提供的 CSV 数据",
        "touSource": "当前 TOU 配置",
        "simulationVersion": "v1.0",
        "reportDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    
    try:
        markdown_report = await generate_project_summary(
            project_info=project_info,
            load_profile=request.load_profile,
            tou_config=request.tou_config,
            storage_config=request.storage_config,
            storage_results=request.storage_results,
            quality_report=request.quality_report,
        )
    except DeepSeekError as exc:
        logger.exception("生成项目评估报告失败")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"生成报告失败: {str(exc)}",
        ) from exc
    
    # 生成报告 ID
    report_id = f"report_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    
    # 从 storage_results 提取关键摘要（如有）
    summary_dict = {}
    if request.storage_results:
        summary_dict = {
            "firstYearRevenue": request.storage_results.get("firstYearRevenueDetail", ""),
            "dailyCycles": request.storage_results.get("dailyCycles", ""),
            "utilizationHoursRange": request.storage_results.get("utilizationHoursRangeDetail", ""),
            "loadDataCompleteness": request.quality_report.get("loadMissingRateDescription", "") if request.quality_report else "",
            "overallConclusion": "请参考报告正文",
        }
    
    return ProjectSummaryResponse(
        report_id=report_id,
        project_name=request.project_name,
        period_start=request.period_start,
        period_end=request.period_end,
        generated_at=datetime.now(timezone.utc).isoformat(),
        markdown=markdown_report,
        summary=summary_dict,
    )


@app.post("/api/storage/economics", response_model=StorageEconomicsResult)
async def compute_storage_economics(
    request: StorageEconomicsInput,
) -> StorageEconomicsResult:
    """
    储能经济性测算接口。
    
    基于首年收益、项目年限、运维成本、衰减率、投资成本等参数，
    计算 IRR、静态回收期和年度现金流序列。
    
    请求体字段说明：
    - first_year_revenue: 首年收益（已扣电费、未扣运维），单位：元
    - project_years: 项目年限，默认 15 年
    - annual_om_cost: 年运维成本单位成本，单位：元/Wh。实际年运维成本 = annual_om_cost × 容量(kWh) ÷ 10（万元）
    - first_year_decay_rate: 首年衰减率（0–1），默认 0.03（3%）
    - subsequent_decay_rate: 次年至末年衰减率（0–1），默认 0.015（1.5%）
    - capex_per_wh: 单 Wh 投资，单位：元/Wh
    - installed_capacity_kwh: 储能装机容量，单位：kWh
    - cell_replacement_cost: 电芯更换成本单位成本（可选），单位：元/Wh。实际成本 = cell_replacement_cost × 容量(kWh) ÷ 10（万元）
    - cell_replacement_year: 电芯更换年份（可选），第 N 年
    - second_phase_first_year_revenue: 更换后新的首年收益（可选）
    
    返回：
    - capex_total: 总投资 CAPEX（元）
    - irr: 内部收益率（0–1），如 0.12 表示 12%
    - static_payback_years: 静态回收期（年）
    - final_cumulative_net_cashflow: 项目期末累计净现金流
    - yearly_cashflows: 年度现金流序列
    """
    logger.info(
        "[economics API] received: first_year_revenue=%s, project_years=%s, capacity=%s kWh, capex_per_wh=%s",
        request.first_year_revenue,
        request.project_years,
        request.installed_capacity_kwh,
        request.capex_per_wh,
    )
    
    try:
        # 将单位成本（元/Wh）转换为实际年成本（万元）：成本 = 单位成本 × 容量(kWh) ÷ 10
        actual_annual_om_cost = (request.annual_om_cost * request.installed_capacity_kwh) / 10
        actual_cell_replacement_cost = None
        if request.cell_replacement_cost is not None:
            actual_cell_replacement_cost = (request.cell_replacement_cost * request.installed_capacity_kwh) / 10
        
        result = economics_svc.compute_economics(
            first_year_revenue=request.first_year_revenue,
            project_years=request.project_years,
            annual_om_cost=actual_annual_om_cost,
            first_year_decay_rate=request.first_year_decay_rate,
            subsequent_decay_rate=request.subsequent_decay_rate,
            capex_per_wh=request.capex_per_wh,
            installed_capacity_kwh=request.installed_capacity_kwh,
            first_year_energy_kwh=request.first_year_energy_kwh,
            cell_replacement_year=request.cell_replacement_year,
            cell_replacement_cost=actual_cell_replacement_cost,
            second_phase_first_year_revenue=request.second_phase_first_year_revenue,
        )
    except Exception as exc:
        logger.exception("economics compute failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"经济性计算失败: {str(exc)}",
        ) from exc
    
    # 转换为响应模型
    yearly_cashflows = [
        YearlyCashflowItem(
            year_index=cf.year_index,
            year_revenue=cf.year_revenue,
            annual_om_cost=cf.annual_om_cost,
            cell_replacement_cost=cf.cell_replacement_cost,
            net_cashflow=cf.net_cashflow,
            cumulative_net_cashflow=cf.cumulative_net_cashflow,
        )
        for cf in result.yearly_cashflows
    ]
    
    logger.info(
        "[economics API] result: capex=%s, irr=%s, payback=%s years, lcoe_ratio=%s",
        result.capex_total,
        result.irr,
        result.static_payback_years,
        result.lcoe_ratio,
    )
    
    # 构建静态指标对象（如果有）
    static_metrics = None
    if result.static_lcoe is not None:
        static_metrics = StaticEconomicsMetrics(
            static_lcoe=result.static_lcoe,
            annual_energy_kwh=result.annual_energy_kwh,
            annual_revenue_yuan=result.annual_revenue_yuan,
            revenue_per_kwh=result.revenue_per_kwh,
            lcoe_ratio=result.lcoe_ratio,
            screening_result=result.screening_result,
        )
    
    return StorageEconomicsResult(
        capex_total=result.capex_total,
        irr=result.irr,
        static_payback_years=result.static_payback_years,
        final_cumulative_net_cashflow=result.final_cumulative_net_cashflow,
        yearly_cashflows=yearly_cashflows,
        static_metrics=static_metrics,
    )


@app.post("/api/storage/economics/export")
async def export_economics_cashflow_report(
    body: dict = Body(...),
) -> Dict[str, Any]:
    """
    导出多年期经济性现金流明细报表（CSV格式）
    
    与 /api/storage/economics 接口参数相同，但返回报表下载地址而非JSON结果。
    
    请求体包含：
    - StorageEconomicsInput 的所有字段
    - user_share_percent: 用户收益分成比例（0-100），用于计算原年度总收益
    
    返回：
    - excel_path: 报表文件下载路径（相对于 /outputs）
    """
    logger.info(
        "[economics export API] received body keys: %s",
        list(body.keys()),
    )
    
    # 提取user_share_percent，默认0
    user_share_percent = body.pop('user_share_percent', 0.0)
    
    # 将剩余参数解析为StorageEconomicsInput
    try:
        request = StorageEconomicsInput(**body)
    except Exception as e:
        logger.exception("Invalid request parameters")
        logger.error("Request body: %s", body)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"参数解析失败: {str(e)}",
        ) from e
    
    logger.info(
        "[economics export API] received: first_year_revenue=%s, project_years=%s, capacity=%s kWh, user_share=%s%%",
        request.first_year_revenue,
        request.project_years,
        request.installed_capacity_kwh,
        user_share_percent,
    )
    
    try:
        # 计算经济性结果（与上面相同）
        actual_annual_om_cost = (request.annual_om_cost * request.installed_capacity_kwh) / 10
        actual_cell_replacement_cost = None
        if request.cell_replacement_cost is not None:
            actual_cell_replacement_cost = (request.cell_replacement_cost * request.installed_capacity_kwh) / 10
        
        result = economics_svc.compute_economics(
            first_year_revenue=request.first_year_revenue,
            project_years=request.project_years,
            annual_om_cost=actual_annual_om_cost,
            first_year_decay_rate=request.first_year_decay_rate,
            subsequent_decay_rate=request.subsequent_decay_rate,
            capex_per_wh=request.capex_per_wh,
            installed_capacity_kwh=request.installed_capacity_kwh,
            first_year_energy_kwh=request.first_year_energy_kwh,
            cell_replacement_year=request.cell_replacement_year,
            cell_replacement_cost=actual_cell_replacement_cost,
            second_phase_first_year_revenue=request.second_phase_first_year_revenue,
        )
        
        # 计算各年度放电量（kWh）
        yearly_discharge_energy_kwh = None
        if request.first_year_energy_kwh and request.first_year_energy_kwh > 0:
            yearly_discharge_energy_kwh = []
            current_base_energy = request.first_year_energy_kwh
            phase_start_year = 1
            
            for year_index in range(1, request.project_years + 1):
                # 换电芯年份视为新阶段首年：放电量重置为首年水平
                if request.cell_replacement_year and year_index == request.cell_replacement_year:
                    current_base_energy = request.first_year_energy_kwh
                    phase_start_year = year_index
                
                years_in_phase = year_index - phase_start_year  # 0 表示阶段首年
                energy_this_year = (
                    current_base_energy *
                    (1 - request.first_year_decay_rate) *
                    pow(1 - request.subsequent_decay_rate, years_in_phase)
                )
                yearly_discharge_energy_kwh.append(energy_this_year)
        
        # 导出报表
        zip_filename = economics_svc.export_economics_cashflow_report(
            result=result,
            user_share_percent=user_share_percent,
            yearly_discharge_energy_kwh=yearly_discharge_energy_kwh,
        )
        
        logger.info("[economics export API] report generated: %s", zip_filename)
        
        return {
            "excel_path": zip_filename,  # 前端会拼接 /outputs/ 前缀
            "message": "经济性现金流报表生成成功"
        }
        
    except Exception as exc:
        logger.exception("economics export failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"报表生成失败: {str(exc)}",
        ) from exc


# =========================
# PDF / HTML 报告路由（桌面版禁用）
# =========================

_DESKTOP_MODE = os.environ.get("DESKTOP_MODE", "").strip() == "1"

if not _DESKTOP_MODE:
    @app.post("/api/report/html", response_class=HTMLResponse)
    async def debug_render_report_html(request: ReportPdfRequest) -> HTMLResponse:
        """
        返回报告 HTML（用于调试排版/字体/分页）。
        """
        report = request.report_data
        if not report.meta.project_name.strip():
            raise HTTPException(status_code=422, detail="必填项缺失：project_name")
        if not report.meta.period_start.strip() or not report.meta.period_end.strip():
            raise HTTPException(status_code=422, detail="必填项缺失：period_start/period_end")
        if report.meta.total_investment_wanyuan is None:
            raise HTTPException(status_code=422, detail="必填项缺失：total_investment_wanyuan")

        if getattr(report.ai_polish, "enabled", False):
            try:
                report.narrative = await report_ai_polish_svc.polish_report_narrative(report)
                report.ai_polish.provider = report.ai_polish.provider or "deepseek"
            except Exception as exc:
                logger.warning("report ai polish failed, fallback to template: %s", str(exc))

        html_text = report_pdf_svc.build_report_html(report)
        return HTMLResponse(content=html_text)


    @app.post("/api/report/pdf")
    async def render_report_pdf(request: ReportPdfRequest) -> Response:
        """
        生成并下载项目经济性评估报告 PDF（图文版）。
        """
        report = request.report_data
        if not report.meta.project_name.strip():
            raise HTTPException(status_code=422, detail="必填项缺失：project_name")
        if not report.meta.period_start.strip() or not report.meta.period_end.strip():
            raise HTTPException(status_code=422, detail="必填项缺失：period_start/period_end")
        if report.meta.total_investment_wanyuan is None:
            raise HTTPException(status_code=422, detail="必填项缺失：total_investment_wanyuan")

        try:
            if getattr(report.ai_polish, "enabled", False):
                try:
                    report.narrative = await report_ai_polish_svc.polish_report_narrative(report)
                    report.ai_polish.provider = report.ai_polish.provider or "deepseek"
                except Exception as exc:
                    logger.warning("report ai polish failed, fallback to template: %s", str(exc))

            html_text = report_pdf_svc.build_report_html(report)
            header_title = f"{(report.meta.owner_name or '').strip()}-储能项目经济性评估报告" if report.meta.owner_name else "储能项目经济性评估报告"
            pdf_bytes = await report_pdf_svc.render_pdf_from_html(
                html_text=html_text,
                header_title=header_title,
                generated_at=report.meta.generated_at,
            )
            filename = report_pdf_svc.suggest_pdf_filename(report)
            filename_ascii = report_pdf_svc.suggest_pdf_filename_ascii(report)
            content_disposition = f"attachment; filename=\"{filename_ascii}\"; filename*=UTF-8''{quote(filename)}"
            return Response(
                content=pdf_bytes,
                media_type="application/pdf",
                headers={
                    "Content-Disposition": content_disposition,
                    "Cache-Control": "no-store",
                },
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("report pdf render failed")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"PDF 渲染失败: {str(exc)}",
            ) from exc
else:
    logger.info("DESKTOP_MODE=1: PDF/HTML report routes disabled")

