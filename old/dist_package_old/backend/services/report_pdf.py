from __future__ import annotations

import html
import re
from datetime import datetime
from typing import Optional

from ..schemas import ReportDataV3


def _safe_text(value: Optional[str]) -> str:
    return html.escape((value or "").strip())


def _safe_filename(value: str, fallback: str = "report") -> str:
    name = (value or "").strip() or fallback
    name = re.sub(r"[\\/:*?\"<>|]+", "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:80] if len(name) > 80 else name


def build_report_html(report: ReportDataV3) -> str:
    meta = report.meta
    completeness = report.completeness
    narrative = getattr(report, "narrative", None)

    project_name = _safe_text(meta.project_name)
    owner_name = _safe_text(meta.owner_name)
    project_location = _safe_text(meta.project_location)
    author_org = _safe_text(meta.author_org)
    subtitle_raw = (meta.subtitle or "").strip()
    if not subtitle_raw:
        subtitle_raw = f"基于 {meta.project_name.strip()} 的模拟分析"
    subtitle = html.escape(subtitle_raw)
    period = f"{_safe_text(meta.period_start)} ~ {_safe_text(meta.period_end)}"

    logo_img = ""
    if meta.logo_data_url and str(meta.logo_data_url).startswith("data:image/"):
        logo_img = f'<img class="logo" src="{html.escape(meta.logo_data_url)}" alt="logo" />'

    missing = completeness.missing_items or []
    missing_html = (
        "<ul class='missing'>"
        + "".join(f"<li>{html.escape(str(x))}</li>" for x in missing)
        + "</ul>"
        if missing
        else "<div class='ok'>无</div>"
    )

    def img_or_placeholder(data_url: Optional[str], title: str) -> str:
        if data_url and str(data_url).startswith("data:image/"):
            return f'<img class="chart" src="{html.escape(str(data_url))}" alt="{html.escape(title)}" />'
        return (
            '<div class="placeholder">'
            f"<div class='placeholder-title'>{html.escape(title)}</div>"
            "<div class='placeholder-sub'>图表未提供或数据不足</div>"
            "</div>"
        )

    charts = report.charts

    summary_text = _safe_text(getattr(narrative, "summary", "") if narrative else "")
    conclusion_text = _safe_text(getattr(narrative, "conclusion", "") if narrative else "")
    risks = list(getattr(narrative, "risks", []) if narrative else [])
    suggestions = list(getattr(narrative, "suggestions", []) if narrative else [])

    risks_html = (
        "<ul class='missing'>"
        + "".join(f"<li>{html.escape(str(x))}</li>" for x in risks)
        + "</ul>"
        if risks
        else "<div class='muted'>无</div>"
    )
    suggestions_html = (
        "<ul class='missing'>"
        + "".join(f"<li>{html.escape(str(x))}</li>" for x in suggestions)
        + "</ul>"
        if suggestions
        else "<div class='muted'>无</div>"
    )

    ai_status = "未启用"
    if getattr(report.ai_polish, "enabled", False):
        provider = getattr(report.ai_polish, "provider", None)
        ai_status = f"已启用（{html.escape(str(provider or 'provider 未知'))}）"

    best_day = None
    max_day = None
    try:
        best_day = (report.storage or {}).get("typical_days", {}).get("best_profit_day", {}).get("date")
        max_day = (report.storage or {}).get("typical_days", {}).get("max_load_day", {}).get("date")
    except Exception:
        best_day = None
        max_day = None
    same_typical_day = bool(best_day and max_day and str(best_day) == str(max_day))

    cashflows = []
    try:
        cashflows = (report.storage or {}).get("economics", {}).get("result", {}).get("yearly_cashflows") or []
    except Exception:
        cashflows = []

    def _fmt_money(v: object) -> str:
        try:
            n = float(v)  # type: ignore[arg-type]
            if n != n:  # NaN
                return "—"
            return f"{int(round(n)):,}"
        except Exception:
            return "—"

    def _fmt_percent01(v: object) -> str:
        try:
            n = float(v)  # type: ignore[arg-type]
            if n != n:
                return "—"
            return f"{n * 100:.2f}%"
        except Exception:
            return "—"

    def _fmt_years(v: object) -> str:
        try:
            n = float(v)  # type: ignore[arg-type]
            if n != n:
                return "—"
            return f"{n:.2f} 年"
        except Exception:
            return "—"

    def _fmt_num(v: object, digits: int = 2) -> str:
        try:
            n = float(v)  # type: ignore[arg-type]
            if n != n:
                return "—"
            return f"{n:.{digits}f}"
        except Exception:
            return "—"

    # 第 4/5 章通用：cycles 与 economics 指标（用于指标卡/表格）
    cycles_year = {}
    econ_result = {}
    econ_static = {}
    try:
        cycles_year = (report.storage or {}).get("cycles", {}).get("year", {}) or {}
    except Exception:
        cycles_year = {}
    try:
        econ_result = (report.storage or {}).get("economics", {}).get("result", {}) or {}
        econ_static = (econ_result or {}).get("static_metrics") or {}
    except Exception:
        econ_result = {}
        econ_static = {}

    cycles_baseline_table_html = (
        "<table class='tbl'>"
        "<thead><tr><th>指标</th><th class='num'>值</th><th>来源</th></tr></thead>"
        "<tbody>"
        + "".join(
            "<tr>"
            f"<td>{html.escape(name)}</td>"
            f"<td class='num'>{html.escape(value)}</td>"
            f"<td>{html.escape(src)}</td>"
            "</tr>"
            for name, value, src in [
                ("年等效循环次数", str((cycles_year or {}).get("cycles", "—")), "cycles.year.cycles"),
                ("首年放电能量（kWh）", str((((cycles_year or {}).get("profit", {}) or {}).get("main", {}) or {}).get("discharge_energy_kwh", "—")), "cycles.year.profit.main.discharge_energy_kwh"),
                ("首年净收益（元）", str((((cycles_year or {}).get("profit", {}) or {}).get("main", {}) or {}).get("profit", "—")), "cycles.year.profit.main.profit"),
                ("有效天数（如有）", str((cycles_year or {}).get("valid_days", "—")), "cycles.year.valid_days"),
            ]
        )
        + "</tbody></table>"
    )

    economics_metrics_html = (
        "<div class='grid-2'>"
        + "".join(
            "<div class='card'>"
            f"<div class='metric'><div class='label'>{html.escape(k)}</div><div class='value'>{html.escape(v)}</div></div>"
            "</div>"
            for k, v in [
                ("IRR", _fmt_percent01((econ_result or {}).get("irr"))),
                ("静态回收期", _fmt_years((econ_result or {}).get("static_payback_years"))),
                ("项目期末累计净现金流（元）", _fmt_money((econ_result or {}).get("final_cumulative_net_cashflow"))),
                ("静态 LCOE（元/kWh）", _fmt_num((econ_static or {}).get("static_lcoe"), 4)),
                ("度电收益（元/kWh）", _fmt_num((econ_static or {}).get("revenue_per_kwh"), 4)),
                ("LCOE 比值", _fmt_num((econ_static or {}).get("lcoe_ratio"), 3)),
            ]
        )
        + "</div>"
    )

    screening_html = "<div class='muted'>未提供静态筛选结果（static_metrics）。</div>"
    if isinstance(econ_static, dict) and econ_static:
        screening_html = (
            "<table class='tbl'>"
            "<thead><tr><th>字段</th><th class='num'>值</th></tr></thead>"
            "<tbody>"
            + "".join(
                "<tr>"
                f"<td>{html.escape(k)}</td>"
                f"<td class='num'>{html.escape(v)}</td>"
                "</tr>"
                for k, v in [
                    ("静态 LCOE（元/kWh）", _fmt_num(econ_static.get("static_lcoe"), 4)),
                    ("年均发电能量（kWh）", _fmt_money(econ_static.get("annual_energy_kwh"))),
                    ("年均收益（元）", _fmt_money(econ_static.get("annual_revenue_yuan"))),
                    ("度电收益（元/kWh）", _fmt_num(econ_static.get("revenue_per_kwh"), 4)),
                    ("LCOE 比值", _fmt_num(econ_static.get("lcoe_ratio"), 3)),
                    ("阈值", _fmt_num(econ_static.get("pass_threshold"), 3)),
                    ("筛选结论", html.escape(str(econ_static.get("screening_result") or "—"))),
                ]
            )
            + "</tbody></table>"
        )

    # 2.2 策略说明（模板化；AI 可润色）
    strategy_desc_html = (
        "<div class='card'>"
        "<div class='muted'>"
        "策略说明：本项目运行策略按月配置（并可被日期规则覆盖）。一般情况下，系统在低价时段（如谷段）安排充电，在高价时段（如峰/尖段）安排放电，其余时段待机；"
        "具体以“1-12 月 TOU/策略配置汇总”表为准。"
        "</div>"
        "</div>"
    )

    # 4.3 推荐容量与理由（模板化；引用系统数值；AI 可润色）
    irr_val = econ_result.get("irr")
    payback_val = econ_result.get("static_payback_years")
    irr_text = _fmt_percent01(irr_val)
    payback_text = _fmt_years(payback_val)
    year_cycles_text = html.escape(str((cycles_year or {}).get("cycles", "—")))
    year_profit_text = _fmt_money((((cycles_year or {}).get("profit", {}) or {}).get("main", {}) or {}).get("profit"))
    recommendation_html = (
        "<div class='card'>"
        "<div class='muted'>"
        f"建议结论（模板）：在当前配置与口径下，年等效循环次数={year_cycles_text}，首年净收益={year_profit_text} 元，IRR={irr_text}，静态回收期={payback_text}。"
        "建议结合“典型日分析”复核策略可执行性与数据代表性；若存在缺失/异常，请先补齐数据后再对外出具结论。"
        "</div>"
        "</div>"
    )

    cashflow_table_html = "<div class='muted'>未测算</div>"
    if isinstance(cashflows, list) and len(cashflows) > 0:
        rows = []
        for item in cashflows:
            if not isinstance(item, dict):
                continue
            rows.append(
                "<tr>"
                f"<td>{html.escape(str(item.get('year_index', '')))}</td>"
                f"<td class='num'>{_fmt_money(item.get('year_revenue'))}</td>"
                f"<td class='num'>{_fmt_money(item.get('annual_om_cost'))}</td>"
                f"<td class='num'>{_fmt_money(item.get('cell_replacement_cost'))}</td>"
                f"<td class='num'>{_fmt_money(item.get('net_cashflow'))}</td>"
                f"<td class='num'>{_fmt_money(item.get('cumulative_net_cashflow'))}</td>"
                "</tr>"
            )
        cashflow_table_html = (
            "<table class='tbl'>"
            "<thead><tr>"
            "<th>年度</th><th class='num'>收益（元）</th><th class='num'>运维（元）</th><th class='num'>更换（元）</th><th class='num'>净现金流（元）</th><th class='num'>累计净现金流（元）</th>"
            "</tr></thead>"
            "<tbody>"
            + "".join(rows)
            + "</tbody></table>"
        )

    # 2.3 储能系统关键参数（来自 cycles_payload.storage）
    cycles_payload = {}
    try:
        cycles_payload = (report.storage or {}).get("cycles_payload") or {}
    except Exception:
        cycles_payload = {}

    storage_payload = cycles_payload.get("storage") if isinstance(cycles_payload, dict) else None
    storage_params_table_html = "<div class='muted'>未提供 cycles_payload.storage（无法输出关键参数）。</div>"
    if isinstance(storage_payload, dict) and storage_payload:
        cap_kwh = storage_payload.get("capacity_kwh")
        c_rate = storage_payload.get("c_rate")
        power_kw = None
        try:
            if cap_kwh is not None and c_rate is not None:
                power_kw = float(cap_kwh) * float(c_rate)  # type: ignore[arg-type]
        except Exception:
            power_kw = None

        def _kv(v: object, digits: int = 2) -> str:
            if v is None:
                return "—"
            if isinstance(v, bool):
                return "是" if v else "否"
            try:
                n = float(v)  # type: ignore[arg-type]
                if n != n:
                    return "—"
                return f"{n:.{digits}f}"
            except Exception:
                return html.escape(str(v))

        storage_params_table_html = (
            "<table class='tbl'>"
            "<thead><tr><th>参数</th><th class='num'>值</th><th>说明</th></tr></thead>"
            "<tbody>"
            + "".join(
                "<tr>"
                f"<td>{html.escape(k)}</td>"
                f"<td class='num'>{html.escape(v)}</td>"
                f"<td>{html.escape(desc)}</td>"
                "</tr>"
                for k, v, desc in [
                    ("储能容量（kWh）", _kv(cap_kwh, 2), "cycles_payload.storage.capacity_kwh"),
                    ("倍率（C）", _kv(c_rate, 3), "cycles_payload.storage.c_rate"),
                    ("额定功率（kW）", _kv(power_kw, 2), "容量×倍率（估算）"),
                    ("单向效率 η", _kv(storage_payload.get("single_side_efficiency"), 3), "cycles_payload.storage.single_side_efficiency"),
                    ("放电深度 DOD", _kv(storage_payload.get("depth_of_discharge"), 3), "cycles_payload.storage.depth_of_discharge"),
                    ("SOC 下限", _kv(storage_payload.get("soc_min"), 3), "cycles_payload.storage.soc_min（可选）"),
                    ("SOC 上限", _kv(storage_payload.get("soc_max"), 3), "cycles_payload.storage.soc_max（可选）"),
                    ("初始 SOC", _kv(storage_payload.get("initial_soc"), 3), "cycles_payload.storage.initial_soc（可选）"),
                    ("预留充电功率（kW）", _kv(storage_payload.get("reserve_charge_kw"), 2), "cycles_payload.storage.reserve_charge_kw（可选）"),
                    ("预留放电功率（kW）", _kv(storage_payload.get("reserve_discharge_kw"), 2), "cycles_payload.storage.reserve_discharge_kw（可选）"),
                    ("计量口径", _kv(storage_payload.get("metering_mode"), 0), "monthly_demand_max / transformer_capacity"),
                    ("变压器容量（kVA）", _kv(storage_payload.get("transformer_capacity_kva"), 2), "cycles_payload.storage.transformer_capacity_kva（可选）"),
                    ("功率因数", _kv(storage_payload.get("transformer_power_factor"), 3), "cycles_payload.storage.transformer_power_factor（可选）"),
                    ("能量口径", _kv(storage_payload.get("energy_formula"), 0), "physics / sample（可选）"),
                ]
            )
            + "</tbody></table>"
        )

    tou_prices = None
    try:
        tou_prices = (report.tou or {}).get("prices")
    except Exception:
        tou_prices = None

    tou_price_table_html = "<div class='muted'>未配置</div>"
    if isinstance(tou_prices, list) and len(tou_prices) == 12:
        tiers = ["尖", "峰", "平", "谷", "深"]
        rows = []
        for i in range(12):
            pm = tou_prices[i] if isinstance(tou_prices[i], dict) else {}
            cells = "".join(f"<td class='num'>{html.escape(str(pm.get(t, '')))}</td>" for t in tiers)
            rows.append(f"<tr><td>{i+1}月</td>{cells}</tr>")
        tou_price_table_html = (
            "<table class='tbl'>"
            "<thead><tr><th>月份</th>"
            + "".join(f"<th class='num'>{t}（元/kWh）</th>" for t in tiers)
            + "</tr></thead>"
            "<tbody>" + "".join(rows) + "</tbody></table>"
        )

    def _fmt_hhmm(hour: int) -> str:
        if hour == 24:
            return "24:00"
        return f"{int(hour):02d}:00"

    def _fmt_hour_ranges(hours: list[int]) -> str:
        hs = sorted({h for h in hours if isinstance(h, int) and 0 <= h <= 23})
        if not hs:
            return "—"
        parts: list[str] = []
        start = hs[0]
        prev = hs[0]
        for h in hs[1:]:
            if h == prev + 1:
                prev = h
                continue
            parts.append(f"{_fmt_hhmm(start)}-{_fmt_hhmm(prev + 1)}")
            start = h
            prev = h
        parts.append(f"{_fmt_hhmm(start)}-{_fmt_hhmm(prev + 1)}")
        return "，".join(parts)

    # 2.x：1-12 月 TOU/运行策略时段汇总（基于 monthly_schedule）
    monthly_schedule = None
    date_rules = None
    try:
        monthly_schedule = (report.tou or {}).get("monthly_schedule") or (report.tou or {}).get("monthlySchedule")
        date_rules = (report.tou or {}).get("date_rules") or (report.tou or {}).get("dateRules") or []
    except Exception:
        monthly_schedule = None
        date_rules = []

    tou_monthly_summary_html = "<div class='muted'>未提供 monthlySchedule（无法生成 1-12 月时段汇总）。</div>"
    if isinstance(monthly_schedule, list) and len(monthly_schedule) == 12:
        tier_ids = ["尖", "峰", "平", "谷", "深"]
        op_ids = ["放", "充", "待机"]
        rows = []
        for mi in range(12):
            sched = monthly_schedule[mi] if isinstance(monthly_schedule[mi], list) else []
            if not isinstance(sched, list) or len(sched) != 24:
                rows.append(f"<tr><td>{mi+1}月</td><td class='muted'>—</td><td class='muted'>—</td></tr>")
                continue
            tier_parts = []
            for tid in tier_ids:
                hours = [h for h in range(24) if str((sched[h] or {}).get("tou") or "") == tid]
                if hours:
                    tier_parts.append(f"{tid}：{_fmt_hour_ranges(hours)}")
            op_parts = []
            for oid in op_ids:
                hours = [h for h in range(24) if str((sched[h] or {}).get("op") or "") == oid]
                if hours:
                    op_parts.append(f"{oid}：{_fmt_hour_ranges(hours)}")
            tier_html = "<br/>".join(html.escape(x) for x in tier_parts) if tier_parts else "—"
            op_html = "<br/>".join(html.escape(x) for x in op_parts) if op_parts else "—"
            rows.append(f"<tr><td>{mi+1}月</td><td>{tier_html}</td><td>{op_html}</td></tr>")
        tou_monthly_summary_html = (
            "<table class='tbl'>"
            "<thead><tr><th>月份</th><th>TOU 时段汇总</th><th>运行策略时段汇总</th></tr></thead>"
            "<tbody>" + "".join(rows) + "</tbody></table>"
        )

    date_rules_html = ""
    if isinstance(date_rules, list) and len(date_rules) > 0:
        items = []
        for r in date_rules:
            if not isinstance(r, dict):
                continue
            name = str(r.get("name") or "日期规则")
            start = str(r.get("startDate") or r.get("start_date") or "")
            end = str(r.get("endDate") or r.get("end_date") or "")
            if start and end:
                items.append(f"<li>{html.escape(name)}：{html.escape(start)} ~ {html.escape(end)}（覆盖优先于月度配置）</li>")
            else:
                items.append(f"<li>{html.escape(name)}（覆盖优先于月度配置）</li>")
        if items:
            date_rules_html = "<div class='card'><h3>日期规则（覆盖）</h3><ul class='missing'>" + "".join(items) + "</ul></div>"

    load_meta = {}
    quality_report = {}
    try:
        load_meta = report.load.get("meta") if isinstance(report.load, dict) else {}
        quality_report = report.load.get("quality_report") if isinstance(report.load, dict) else {}
    except Exception:
        load_meta = {}
        quality_report = {}

    run_meta = {}
    try:
        run_meta = (report.storage or {}).get("run_meta") or {}
    except Exception:
        run_meta = {}

    def _tbl_kv(rows: list[tuple[str, str]]) -> str:
        return (
            "<table class='tbl'>"
            "<thead><tr><th>字段</th><th>值</th></tr></thead>"
            "<tbody>"
            + "".join(
                "<tr>"
                f"<td>{html.escape(k)}</td>"
                f"<td>{v}</td>"
                "</tr>"
                for k, v in rows
            )
            + "</tbody></table>"
        )

    # 1.1 项目基本信息（表格）
    project_rows: list[tuple[str, str]] = [
        ("项目名称", html.escape(str(meta.project_name or ""))),
        ("业主方名称", owner_name or "—"),
        ("项目地点", project_location or "—"),
        ("评估周期", period),
        ("报告日期", html.escape((meta.generated_at or "")[:10] or "—")),
        ("编制单位/作者", author_org or "—"),
        ("版本号", html.escape(str(meta.report_version or "v3.0"))),
    ]
    if isinstance(run_meta, dict) and run_meta:
        project_rows.append(("运行快照名称", html.escape(str(run_meta.get("run_name") or "—"))))
        project_rows.append(("运行快照创建时间", html.escape(str(run_meta.get("run_created_at") or "—"))))
        project_rows.append(("运行快照ID", html.escape(str(run_meta.get("run_id") or "—"))))
    project_basic_table_html = _tbl_kv(project_rows)

    # 1.2 数据来源与周期（表格）
    ds_rows: list[tuple[str, str]] = [
        ("数据集名称", html.escape(str(load_meta.get("dataset_name") or "—"))),
        ("源文件名", html.escape(str(load_meta.get("source_filename") or "—"))),
        ("指纹", html.escape(str(load_meta.get("fingerprint") or "—"))),
        ("采样间隔（分钟）", html.escape(str(load_meta.get("source_interval_minutes") or "—"))),
        ("点数", html.escape(str(load_meta.get("total_records") or "—"))),
        ("数据起止", html.escape(f"{str(load_meta.get('start') or '—')} ~ {str(load_meta.get('end') or '—')}")),
    ]
    if isinstance(run_meta, dict) and run_meta.get("dataset_id"):
        ds_rows.append(("run.dataset_id", html.escape(str(run_meta.get("dataset_id")))))
    data_source_table_html = _tbl_kv(ds_rows)

    # 3.1 关键统计指标卡（平均/最大/最小/峰谷差）
    load_stats_html = (
        "<div class='grid-2'>"
        + "".join(
            "<div class='card'>"
            f"<div class='metric'><div class='label'>{html.escape(k)}</div><div class='value'>{html.escape(v)}</div></div>"
            "</div>"
            for k, v in [
                ("平均负荷（kW）", _fmt_num(load_meta.get("avg_load_kw"), 2)),
                ("最大负荷（kW）", _fmt_num(load_meta.get("max_load_kw"), 2)),
                ("最小负荷（kW）", _fmt_num(load_meta.get("min_load_kw"), 2)),
                ("峰谷差（kW）", _fmt_num(load_meta.get("peak_valley_diff_kw"), 2)),
            ]
        )
        + "</div>"
    )

    def _fmt_ratio(v: object) -> str:
        try:
            n = float(v)  # type: ignore[arg-type]
            if n != n:
                return "—"
            return f"{n * 100:.2f}%"
        except Exception:
            return "—"

    # 数据质量摘要：缺失天/缺失小时/异常占比 + 对结论影响提示
    missing_summary = {}
    anomalies = []
    try:
        missing_summary = (quality_report or {}).get("missing") or {}
        anomalies = (quality_report or {}).get("anomalies") or []
    except Exception:
        missing_summary = {}
        anomalies = []

    ms_sum = (missing_summary or {}).get("summary") or {}
    total_missing_days = ms_sum.get("total_missing_days")
    total_missing_hours = ms_sum.get("total_missing_hours")
    completeness_ratio = ms_sum.get("completeness_ratio")
    expected_days = ms_sum.get("expected_days")
    actual_days = ms_sum.get("actual_days")

    anomaly_rows = []
    anomaly_total_ratio = 0.0
    if isinstance(anomalies, list):
        for a in anomalies:
            if not isinstance(a, dict):
                continue
            kind = str(a.get("kind") or "")
            count = a.get("count")
            ratio = a.get("ratio")
            try:
                ratio_f = float(ratio)  # type: ignore[arg-type]
                if ratio_f == ratio_f:
                    anomaly_total_ratio += ratio_f
            except Exception:
                pass
            kind_cn = {"null": "空值", "zero": "零值", "negative": "负值"}.get(kind, kind or "未知")
            anomaly_rows.append(
                "<tr>"
                f"<td>{html.escape(kind_cn)}</td>"
                f"<td class='num'>{html.escape(str(count if count is not None else '—'))}</td>"
                f"<td class='num'>{_fmt_ratio(ratio)}</td>"
                "</tr>"
            )

    anomalies_table_html = "<div class='muted'>未提供异常统计</div>"
    if anomaly_rows:
        anomalies_table_html = (
            "<table class='tbl'>"
            "<thead><tr><th>异常类型</th><th class='num'>点数</th><th class='num'>占比</th></tr></thead>"
            "<tbody>" + "".join(anomaly_rows) + "</tbody></table>"
        )

    # 3.x：按月 ×（TOU×运行策略连续时段）统计的平均负荷
    seg_stat = {}
    try:
        seg_stat = (report.load or {}).get("tou_strategy_segment_avg_by_month") or {}
    except Exception:
        seg_stat = {}

    segment_avg_html = "<div class='muted'>未提供“分时段平均负荷”统计（请在前端组装 report_data 时生成）。</div>"
    try:
        months = seg_stat.get("months") if isinstance(seg_stat, dict) else None
        if isinstance(months, list) and len(months) > 0:
            rows = []
            for m in months:
                if not isinstance(m, dict):
                    continue
                mlabel = str(m.get("month_label") or f"{m.get('month_index','')}月")
                segs = m.get("segments") if isinstance(m.get("segments"), list) else []
                if not segs:
                    rows.append(f"<tr><td>{html.escape(mlabel)}</td><td class='muted'>—</td><td class='muted'>—</td><td class='muted'>—</td><td class='num'>—</td><td class='num'>—</td><td class='num'>—</td></tr>")
                    continue
                for s in segs:
                    if not isinstance(s, dict):
                        continue
                    tou = str(s.get("tou") or "—")
                    op = str(s.get("op") or "—")
                    sh = int(s.get("start_hour") or 0)
                    eh = int(s.get("end_hour") or 0)
                    hours = s.get("hours")
                    pts = s.get("sample_points")
                    avg = s.get("avg_load_kw")
                    tr = f"{_fmt_hhmm(sh)}-{_fmt_hhmm(eh)}"
                    rows.append(
                        "<tr>"
                        f"<td>{html.escape(mlabel)}</td>"
                        f"<td>{html.escape(tr)}</td>"
                        f"<td class='num'>{html.escape(str(tou))}</td>"
                        f"<td class='num'>{html.escape(str(op))}</td>"
                        f"<td class='num'>{html.escape(str(avg if avg is not None else '—'))}</td>"
                        f"<td class='num'>{html.escape(str(pts if pts is not None else '—'))}</td>"
                        f"<td class='num'>{html.escape(str(hours if hours is not None else '—'))}</td>"
                        "</tr>"
                    )
            segment_avg_html = (
                "<div class='muted'>口径：按月度配置，将负荷点位换算为 kW 后按“TOU×运行策略”的连续时段聚合得到平均负荷（统计不展开日期规则覆盖）。</div>"
                "<table class='tbl' style='margin-top:8px'>"
                "<thead><tr><th>月份</th><th>时段</th><th class='num'>TOU</th><th class='num'>策略</th><th class='num'>平均负荷（kW）</th><th class='num'>样本点数</th><th class='num'>时段小时数</th></tr></thead>"
                "<tbody>" + "".join(rows) + "</tbody></table>"
            )
    except Exception:
        segment_avg_html = "<div class='muted'>分时段平均负荷统计生成失败（数据结构不符合预期）。</div>"

    # 附录 B：数据质量明细（缺失分月、异常片段摘要）
    missing_hours_by_month = []
    missing_days_list = []
    try:
        missing_hours_by_month = (missing_summary or {}).get("missing_hours_by_month") or []
        missing_days_list = (missing_summary or {}).get("missing_days") or []
    except Exception:
        missing_hours_by_month = []
        missing_days_list = []

    missing_hours_by_month_html = "<div class='muted'>未提供缺失分月统计</div>"
    if isinstance(missing_hours_by_month, list) and missing_hours_by_month:
        rows = []
        for it in missing_hours_by_month:
            if not isinstance(it, dict):
                continue
            rows.append(
                "<tr>"
                f"<td>{html.escape(str(it.get('month') or ''))}</td>"
                f"<td class='num'>{html.escape(str(it.get('missing_days') if it.get('missing_days') is not None else '—'))}</td>"
                f"<td class='num'>{html.escape(str(it.get('missing_hours') if it.get('missing_hours') is not None else '—'))}</td>"
                "</tr>"
            )
        if rows:
            missing_hours_by_month_html = (
                "<table class='tbl'>"
                "<thead><tr><th>月份</th><th class='num'>缺失天数</th><th class='num'>缺失小时数</th></tr></thead>"
                "<tbody>" + "".join(rows) + "</tbody></table>"
            )

    missing_days_html = "<div class='muted'>未提供缺失日期列表</div>"
    if isinstance(missing_days_list, list) and missing_days_list:
        samples = [str(x) for x in missing_days_list if str(x)]
        head = samples[:24]
        tail_more = len(samples) - len(head)
        missing_days_html = (
            "<div class='card'>"
            "<div class='muted'>缺失自然日（最多展示 24 条）：</div>"
            "<ul class='missing'>"
            + "".join(f"<li>{html.escape(x)}</li>" for x in head)
            + (f"<li>……另有 {tail_more} 天未展示</li>" if tail_more > 0 else "")
            + "</ul></div>"
        )

    continuous_zero_spans = []
    try:
        continuous_zero_spans = (quality_report or {}).get("continuous_zero_spans") or []
    except Exception:
        continuous_zero_spans = []

    zero_spans_html = "<div class='muted'>未提供连续零值区间</div>"
    if isinstance(continuous_zero_spans, list) and continuous_zero_spans:
        rows = []
        for it in continuous_zero_spans[:30]:
            if not isinstance(it, dict):
                continue
            rows.append(
                "<tr>"
                f"<td>{html.escape(str(it.get('start') or ''))}</td>"
                f"<td>{html.escape(str(it.get('end') or ''))}</td>"
                f"<td class='num'>{html.escape(str(it.get('length_hours') if it.get('length_hours') is not None else '—'))}</td>"
                "</tr>"
            )
        if rows:
            zero_spans_html = (
                "<table class='tbl'>"
                "<thead><tr><th>开始</th><th>结束</th><th class='num'>长度（小时）</th></tr></thead>"
                "<tbody>" + "".join(rows) + "</tbody></table>"
            )

    appendix_quality_html = (
        "<div class='card'>"
        "<h3>缺失分月统计</h3>"
        + missing_hours_by_month_html
        + "</div>"
        + missing_days_html
        + "<div class='card' style='margin-top:10px'>"
        "<h3>异常统计</h3>"
        + anomalies_table_html
        + "</div>"
        + "<div class='card' style='margin-top:10px'>"
        "<h3>连续零值区间（摘要）</h3>"
        + zero_spans_html
        + "</div>"
    )

    # 附录 C：关键参数清单（用于可追溯）
    econ_input = {}
    try:
        econ_input = (report.storage or {}).get("economics", {}).get("input") or {}
    except Exception:
        econ_input = {}

    appendix_params_rows: list[tuple[str, str]] = [
        ("报告版本", html.escape(str(meta.report_version or "v3.0"))),
        ("生成时间", html.escape(str(meta.generated_at or ""))),
        ("项目名称", html.escape(str(meta.project_name or ""))),
        ("评估周期", period),
        ("项目总投资（万元）", _fmt_num(meta.total_investment_wanyuan, 2)),
        ("数据集名称", html.escape(str(load_meta.get("dataset_name") or "—"))),
        ("源文件名", html.escape(str(load_meta.get("source_filename") or "—"))),
        ("数据指纹", html.escape(str(load_meta.get("fingerprint") or "—"))),
        ("采样间隔（分钟）", html.escape(str(load_meta.get("source_interval_minutes") or "—"))),
        ("点数", html.escape(str(load_meta.get("total_records") or "—"))),
    ]
    if isinstance(run_meta, dict) and run_meta:
        appendix_params_rows.extend([
            ("运行快照名称", html.escape(str(run_meta.get("run_name") or "—"))),
            ("运行快照创建时间", html.escape(str(run_meta.get("run_created_at") or "—"))),
            ("运行快照ID", html.escape(str(run_meta.get("run_id") or "—"))),
            ("run.dataset_id", html.escape(str(run_meta.get("dataset_id") or "—"))),
        ])
    if isinstance(storage_payload, dict) and storage_payload:
        appendix_params_rows.extend([
            ("储能容量（kWh）", html.escape(str(storage_payload.get("capacity_kwh") or "—"))),
            ("倍率（C）", html.escape(str(storage_payload.get("c_rate") or "—"))),
            ("单向效率 η", html.escape(str(storage_payload.get("single_side_efficiency") or "—"))),
            ("放电深度 DOD", html.escape(str(storage_payload.get("depth_of_discharge") or "—"))),
            ("SOC 下限", html.escape(str(storage_payload.get("soc_min") or "—"))),
            ("SOC 上限", html.escape(str(storage_payload.get("soc_max") or "—"))),
            ("预留放电功率（kW）", html.escape(str(storage_payload.get("reserve_discharge_kw") or "—"))),
            ("计量口径", html.escape(str(storage_payload.get("metering_mode") or "—"))),
        ])
    if isinstance(econ_input, dict) and econ_input:
        appendix_params_rows.extend([
            ("项目年限（年）", html.escape(str(econ_input.get("project_years") or "—"))),
            ("装机容量（kWh）", html.escape(str(econ_input.get("installed_capacity_kwh") or "—"))),
            ("单 Wh 投资（元/Wh）", html.escape(str(econ_input.get("capex_per_wh") or "—"))),
            ("年运维成本（元/Wh）", html.escape(str(econ_input.get("annual_om_cost") or "—"))),
            ("首年收益（元）", html.escape(str(econ_input.get("first_year_revenue") or "—"))),
        ])

    appendix_params_html = _tbl_kv(appendix_params_rows)

    def _impact_level_text() -> str:
        # 口径：优先 completeness_ratio；若缺失则用 expected/actual 做兜底估计
        cr = None
        try:
            cr = float(completeness_ratio)  # type: ignore[arg-type]
            if cr != cr:
                cr = None
        except Exception:
            cr = None

        if cr is None:
            try:
                e = float(expected_days)  # type: ignore[arg-type]
                a = float(actual_days)  # type: ignore[arg-type]
                if e > 0 and a >= 0:
                    cr = a / e
            except Exception:
                cr = None

        ar = anomaly_total_ratio
        if cr is None and (total_missing_days is None and total_missing_hours is None) and not anomaly_rows:
            return "对结论影响：数据质量信息不足（建议补充质量诊断结果后再对外出具结论）。"

        if cr is not None and cr >= 0.98 and ar <= 0.01:
            return "对结论影响：低（数据较完整，结论可信度较高）。"
        if cr is not None and cr >= 0.95 and ar <= 0.03:
            return "对结论影响：中（存在一定缺失/异常，建议在关键章节标注口径并复核典型日）。"
        if cr is not None and cr >= 0.90 and ar <= 0.06:
            return "对结论影响：较高（缺失/异常可能影响收益与回收期判断，建议补数或扩大样本周期）。"
        return "对结论影响：高（数据质量风险显著，建议先修复缺失/异常后再输出对外结论）。"

    quality_kpi_rows = []
    if total_missing_days is not None:
        quality_kpi_rows.append(("缺失自然日数", html.escape(str(total_missing_days))))
    if total_missing_hours is not None:
        quality_kpi_rows.append(("缺失小时数", html.escape(str(total_missing_hours))))
    if completeness_ratio is not None:
        quality_kpi_rows.append(("完整度", _fmt_ratio(completeness_ratio)))
    elif expected_days is not None and actual_days is not None:
        quality_kpi_rows.append(("完整度（按天估计）", f"{html.escape(str(actual_days))}/{html.escape(str(expected_days))}"))
    quality_kpi_rows.append(("异常占比合计", _fmt_ratio(anomaly_total_ratio)))

    quality_kpi_html = (
        "<div class='grid-2'>"
        + "".join(
            "<div class='card'>"
            f"<div class='metric'><div class='label'>{k}</div><div class='value'>{v}</div></div>"
            "</div>"
            for k, v in quality_kpi_rows
        )
        + "</div>"
        if quality_kpi_rows
        else "<div class='muted'>未提供质量摘要</div>"
    )

    # 注意：模板优先保证“可读 + 可分页 + 可追溯”，图表接入可逐步增强。
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{project_name} - 项目经济性评估报告</title>
  <style>
    :root {{
      --fg: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
      --bg: #ffffff;
      --accent: #2563eb;
      --soft: #f8fafc;
    }}
    * {{ box-sizing: border-box; }}
    html, body {{
      padding: 0;
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font-family: "Microsoft YaHei", "Noto Sans SC", "PingFang SC", system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
      line-height: 1.55;
      font-size: 12px;
    }}
    @page {{
      size: A4;
      margin: 18mm 16mm 18mm 16mm;
    }}
    .page-break {{ page-break-after: always; }}
    .cover {{
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: calc(297mm - 36mm);
      padding-top: 12mm;
    }}
    .cover-top {{
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12mm;
    }}
    .logo {{
      width: 38mm;
      height: auto;
      object-fit: contain;
    }}
    .title {{
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.2px;
      margin: 0;
    }}
    .subtitle {{
      margin-top: 6mm;
      font-size: 14px;
      color: var(--muted);
    }}
    .cover-meta {{
      margin-top: 12mm;
      padding: 10mm;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--soft);
    }}
    .kv {{
      display: grid;
      grid-template-columns: 86px 1fr;
      gap: 6px 12px;
    }}
    .k {{ color: var(--muted); }}
    .v {{ color: var(--fg); font-weight: 600; }}
    h2 {{
      margin: 0 0 10px 0;
      font-size: 16px;
      border-left: 3px solid var(--accent);
      padding-left: 8px;
    }}
    h3 {{
      margin: 14px 0 8px 0;
      font-size: 13px;
    }}
    .section {{
      margin-bottom: 16px;
      page-break-inside: avoid;
    }}
    .grid-2 {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }}
    .card {{
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      background: #fff;
    }}
    .metric {{
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: baseline;
      padding: 6px 0;
      border-bottom: 1px dashed var(--border);
    }}
    .metric:last-child {{ border-bottom: 0; }}
    .metric .label {{ color: var(--muted); }}
    .metric .value {{ font-weight: 800; }}
    .ok {{ color: #16a34a; font-weight: 700; }}
    ul.missing {{ margin: 8px 0 0 18px; padding: 0; }}
    ul.missing li {{ margin: 2px 0; color: #b45309; }}
    .chart {{
      width: 100%;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #fff;
    }}
    .placeholder {{
      width: 100%;
      min-height: 120px;
      border: 1px dashed var(--border);
      border-radius: 10px;
      background: #fafafa;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      color: var(--muted);
      text-align: center;
      padding: 14px;
    }}
    .placeholder-title {{ font-weight: 800; color: #334155; }}
    .placeholder-sub {{ margin-top: 6px; font-size: 11px; }}
    .muted {{ color: var(--muted); }}
    table.tbl {{
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      background: #fff;
    }}
    table.tbl thead {{
      display: table-header-group;
      background: var(--soft);
    }}
    table.tbl th, table.tbl td {{
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      vertical-align: top;
      font-size: 11px;
    }}
    table.tbl th {{
      text-align: left;
      color: #334155;
      font-weight: 800;
    }}
    table.tbl td.num, table.tbl th.num {{
      text-align: right;
      white-space: nowrap;
    }}
    table.tbl tr {{
      break-inside: avoid;
      page-break-inside: avoid;
    }}
  </style>
</head>
<body>
  <div class="cover">
    <div>
      <div class="cover-top">
        <div>
          <h1 class="title">{owner_name + " " if owner_name else ""}储能项目经济性评估报告</h1>
          <div class="subtitle">{subtitle or "基于项目运行数据与分时电价配置的模拟分析"}</div>
          <div class="cover-meta">
            <div class="kv">
              <div class="k">项目名称</div><div class="v">{project_name}</div>
              <div class="k">项目地点</div><div class="v">{project_location or "-"}</div>
              <div class="k">评估周期</div><div class="v">{period}</div>
              <div class="k">报告日期</div><div class="v">{_safe_text(meta.generated_at[:10])}</div>
              <div class="k">编制单位/作者</div><div class="v">{author_org or "-"}</div>
              <div class="k">版本号</div><div class="v">{_safe_text(meta.report_version)}</div>
            </div>
          </div>
        </div>
        <div>{logo_img}</div>
      </div>
    </div>
<div class="muted">本报告由系统自动生成，数值均来源于系统测算结果或用户输入；若缺少测算项，将在正文中明确标注。PDF 导出将自动带页眉/页脚与页码。</div>
  </div>
  <div class="page-break"></div>

  <div class="section">
    <h2>导出完成度检查</h2>
    <div class="grid-2">
      <div class="card">
        <h3>必备项</h3>
        <div class="metric"><div class="label">负荷数据</div><div class="value">{'✅' if completeness.has_load else '❌'}</div></div>
        <div class="metric"><div class="label">TOU/策略配置</div><div class="value">{'✅' if completeness.has_tou else '❌'}</div></div>
        <div class="metric"><div class="label">cycles 测算</div><div class="value">{'✅' if completeness.has_cycles else '❌'}</div></div>
        <div class="metric"><div class="label">economics 测算</div><div class="value">{'✅' if completeness.has_economics else '❌'}</div></div>
      </div>
      <div class="card">
        <h3>缺失项清单</h3>
        {missing_html}
      </div>
    </div>
  </div>

  <div class="section">
    <h2>第 1 章 项目与数据概况</h2>
    <h3>1.1 项目基本信息</h3>
    {project_basic_table_html}
    <h3 style="margin-top:14px">1.2 数据来源与周期</h3>
    {data_source_table_html}
    <h3>1.3 数据质量摘要</h3>
    {quality_kpi_html}
    <div class="card" style="margin-top:10px">
      <div class="muted">{_impact_level_text()}</div>
    </div>
    <h3 style="margin-top:14px">异常值占比</h3>
    {anomalies_table_html}
  </div>
  <div class="page-break"></div>

  <div class="section">
    <h2>关键指标（摘要）</h2>
    <div class="grid-2">
      <div class="card">
        <h3>经济性指标</h3>
        <div class="metric"><div class="label">项目总投资（万元）</div><div class="value">{meta.total_investment_wanyuan:.2f}</div></div>
        <div class="metric"><div class="label">IRR</div><div class="value">{html.escape(str(report.storage.get('economics',{}).get('result',{}).get('irr','未测算')))}</div></div>
        <div class="metric"><div class="label">静态回收期（年）</div><div class="value">{html.escape(str(report.storage.get('economics',{}).get('result',{}).get('static_payback_years','未测算')))}</div></div>
        <div class="metric"><div class="label">项目期末累计净现金流（元）</div><div class="value">{html.escape(str(report.storage.get('economics',{}).get('result',{}).get('final_cumulative_net_cashflow','未测算')))}</div></div>
      </div>
      <div class="card">
        <h3>cycles 指标</h3>
        <div class="metric"><div class="label">年等效循环次数</div><div class="value">{html.escape(str(report.storage.get('cycles',{}).get('year',{}).get('cycles','未测算')))}</div></div>
        <div class="metric"><div class="label">首年放电能量（kWh）</div><div class="value">{html.escape(str(report.storage.get('cycles',{}).get('year',{}).get('profit',{}).get('main',{}).get('discharge_energy_kwh','未测算')))}</div></div>
        <div class="metric"><div class="label">首年净收益（元）</div><div class="value">{html.escape(str(report.storage.get('cycles',{}).get('year',{}).get('profit',{}).get('main',{}).get('profit','未测算')))}</div></div>
      </div>
    </div>
  </div>
  <div class="page-break"></div>

  <div class="section">
    <h2>第 2 章 TOU 与运行策略配置</h2>
    <h3>2.1 1-12 月 TOU/策略配置汇总</h3>
    <div class="muted">说明：本项目 TOU 与运行策略采用“按月配置 +（可选）日期规则覆盖”的方式。按月电价明细见附录 A；本节汇总 1-12 月的时段配置。</div>
    {tou_monthly_summary_html}
    {date_rules_html}
    <h3 style="margin-top:14px">2.2 运行策略说明</h3>
    {strategy_desc_html}
    <h3 style="margin-top:14px">2.3 储能系统关键参数</h3>
    {storage_params_table_html}
    <h3 style="margin-top:14px">2.4 示例：24h 分时电价（取评估周期起始日）</h3>
    {img_or_placeholder(charts.price_24h_png, "24h 分时电价图")}
    <h3>2.5 示例：24h 运行策略（取评估周期起始日）</h3>
    {img_or_placeholder(charts.strategy_24h_png, "24h 运行策略图")}
  </div>

  <div class="section">
    <h2>第 3 章 负荷特性分析</h2>
    <h3>3.1 关键统计指标</h3>
    {load_stats_html}
    <h3 style="margin-top:14px">3.2 负荷典型曲线</h3>
    {img_or_placeholder(charts.load_typical_png, "负荷典型曲线")}
    <h3 style="margin-top:14px">3.3 月度分布（均值/峰值）</h3>
    {img_or_placeholder(charts.load_monthly_distribution_png, "月度负荷分布")}
    <h3 style="margin-top:14px">3.4 负荷与电价叠加</h3>
    {img_or_placeholder(charts.load_price_overlay_png, "负荷-电价叠加")}
    <h3 style="margin-top:14px">3.5 分时段平均负荷（按 TOU×策略时段）</h3>
    {segment_avg_html}
  </div>
  <div class="page-break"></div>

  <div class="section">
    <h2>第 4 章 最优 cycles 与容量建议</h2>
    <h3>4.1 基准方案结果</h3>
    {cycles_baseline_table_html}
    <h3 style="margin-top:14px">4.2 容量对比趋势（如有）</h3>
    {img_or_placeholder(charts.capacity_compare_png, "容量对比趋势图")}
    <h3 style="margin-top:14px">4.3 推荐容量与理由</h3>
    {recommendation_html}
  </div>

  <div class="section">
    <h2>第 5 章 经济性测算与回收期</h2>
    <h3>5.1 指标卡</h3>
    {economics_metrics_html}
    <h3>5.2 现金流图</h3>
    {img_or_placeholder(charts.cashflow_png, "年度净现金流 + 累计现金流")}
    <h3>5.3 现金流明细表</h3>
    {cashflow_table_html}
    <h3 style="margin-top:14px">5.4 静态筛选结果（如有）</h3>
    {screening_html}
  </div>

  <div class="section">
    <h2>典型日分析（收益最高日/最大负荷日）</h2>
    {(
        f"<h3>收益最高日（同时为最大负荷日）：原始负荷 vs 储能后负荷（{html.escape(str(best_day))}）</h3>"
        + img_or_placeholder(charts.best_profit_day_overlay_png, "典型日叠加图")
      ) if same_typical_day else (
        f"<h3>收益最高日：原始负荷 vs 储能后负荷（{html.escape(str(best_day))}）</h3>"
        + img_or_placeholder(charts.best_profit_day_overlay_png, "收益最高日叠加图")
        + f"<h3>最大负荷日：原始负荷 vs 储能后负荷（{html.escape(str(max_day))}）</h3>"
        + img_or_placeholder(charts.max_load_day_overlay_png, "最大负荷日叠加图")
      )}
  </div>

  <div class="section">
    <h2>第 6 章 结论与风险提示</h2>
    <div class="card">
      <div class="muted">AI 文案润色状态：{ai_status}（约束：{html.escape(str(getattr(report.ai_polish, "notes", "仅润色，不改数值")))}）</div>
      <div class="muted" style="margin-top:4px">数值来源：cycles/economics 快照与用户输入；关键参数详见附录 C。</div>
      <h3>6.0 摘要</h3>
      <div>{summary_text or "摘要待补充。"}</div>
      <h3>6.1 综合结论</h3>
      <div>{conclusion_text or "结论待补充。"}</div>
      <h3>6.2 风险提示</h3>
      {risks_html}
      <h3>6.3 建议与下一步</h3>
      {suggestions_html}
    </div>
  </div>

  <div class="section">
    <h2>附录 A：TOU 明细（按月价格）</h2>
    {tou_price_table_html}
  </div>

  <div class="section">
    <h2>附录 B：数据质量明细</h2>
    {appendix_quality_html}
  </div>

  <div class="section">
    <h2>附录 C：关键参数清单（可追溯）</h2>
    {appendix_params_html}
  </div>
</body>
</html>
"""


async def render_pdf_from_html(
    html_text: str,
    header_title: str,
    generated_at: str,
) -> bytes:
    """
    使用 Playwright 的 Headless Chromium 将 HTML 渲染为 PDF。

    说明：
    - 需要安装依赖：pip install playwright
    - 首次运行需安装浏览器：python -m playwright install chromium
    """
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "PDF 渲染依赖缺失：未安装 playwright。请先执行：pip install playwright && python -m playwright install chromium"
        ) from exc

    header_safe = html.escape(header_title)
    footer_date = html.escape(generated_at[:10] if generated_at else datetime.now().strftime("%Y-%m-%d"))

    header_template = f"""
      <style>
        .hdr {{
          font-family: "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif;
          font-size: 9px;
          color: #64748b;
          width: 100%;
          padding: 0 16mm;
        }}
        .hdr .row {{
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
        }}
      </style>
      <div class="hdr">
        <div class="row">
          <div>{header_safe}</div>
          <div></div>
        </div>
      </div>
    """

    footer_template = f"""
      <style>
        .ftr {{
          font-family: "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif;
          font-size: 9px;
          color: #64748b;
          width: 100%;
          padding: 0 16mm;
        }}
        .ftr .row {{
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
        }}
      </style>
      <div class="ftr">
        <div class="row">
          <div>生成日期：{footer_date}</div>
          <div>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>
        </div>
      </div>
    """

    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch()
        except Exception as exc:  # pragma: no cover
            msg = str(exc)
            if "Executable doesn't exist" in msg or "playwright install" in msg:
                raise RuntimeError(
                    "Playwright 浏览器未安装：请在后端环境执行 `python -m playwright install chromium` 后重试。"
                ) from exc
            raise
        page = await browser.new_page()
        await page.set_content(html_text, wait_until="networkidle")
        pdf_bytes = await page.pdf(
            format="A4",
            print_background=True,
            margin={"top": "18mm", "right": "16mm", "bottom": "18mm", "left": "16mm"},
            display_header_footer=True,
            header_template=header_template,
            footer_template=footer_template,
        )
        await browser.close()
        return pdf_bytes


def suggest_pdf_filename(report: ReportDataV3) -> str:
    project = _safe_filename(report.meta.project_name, fallback="project")
    date = (report.meta.generated_at or "")[:10] or datetime.now().strftime("%Y-%m-%d")
    return f"{project}_项目经济性评估报告_{date}.pdf"


def suggest_pdf_filename_ascii(report: ReportDataV3) -> str:
    """
    Starlette 的 Response header 需要 latin-1 编码，因此 Content-Disposition 的 filename=
    必须提供纯 ASCII 兜底；中文文件名通过 filename*=UTF-8''... 提供。
    """
    project = _safe_filename(report.meta.project_name, fallback="project")
    date = (report.meta.generated_at or "")[:10] or datetime.now().strftime("%Y-%m-%d")
    raw = f"{project}_report_{date}.pdf"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("_")
    if not ascii_name:
        ascii_name = f"report_{date}.pdf"
    if not ascii_name.lower().endswith(".pdf"):
        ascii_name = f"{ascii_name}.pdf"
    return ascii_name
