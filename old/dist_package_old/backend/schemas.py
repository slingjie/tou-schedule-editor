from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class MissingHoursByMonth(BaseModel):
    """每月缺失小时统计"""

    month: str = Field(description="月份，格式为 YYYY-MM")
    missing_days: int = Field(description="该月缺失的自然日数量")
    missing_hours: int = Field(description="该月缺失的数据小时数")


class MissingSummary(BaseModel):
    """缺失信息汇总"""

    missing_days: List[str] = Field(default_factory=list, description="缺失日期列表")
    missing_hours_by_month: List[MissingHoursByMonth] = Field(
        default_factory=list,
        description="按月统计的缺失小时信息",
    )
    summary: dict = Field(
        default_factory=dict,
        description="汇总信息，如 total_missing_days / total_missing_hours",
    )


class ValueAnomaly(BaseModel):
    """数值异常信息"""

    kind: Literal["null", "zero", "negative"]
    count: int
    ratio: float
    samples: List[str] = Field(default_factory=list, description="示例时间点（最多 10 条）")


class ContinuousZeroSpan(BaseModel):
    """连续零值区间"""

    start: str
    end: str
    length_hours: int


class QualityReport(BaseModel):
    """数据质量报告"""

    missing: MissingSummary
    anomalies: List[ValueAnomaly]
    continuous_zero_spans: List[ContinuousZeroSpan] = Field(default_factory=list)


class CleanedPoint(BaseModel):
    """清洗后的单点负荷"""

    timestamp: str
    load_kwh: float


class MetaInfo(BaseModel):
    """数据元信息"""

    source_interval_minutes: int
    total_records: int
    start: Optional[str]
    end: Optional[str]
    avg_load_kw: float = 0.0
    max_load_kw: float = 0.0
    min_load_kw: float = 0.0


class LoadAnalysisResponse(BaseModel):
    """负荷分析接口响应"""

    cleaned_points: List[CleanedPoint]
    report: QualityReport
    meta: MetaInfo


# =========================
# 储能收益与次数计算 - 核心模型
# =========================


class StorageProfit(BaseModel):
    """单一口径的储能收益结构"""

    revenue: float = Field(default=0.0, description="放电收入，单位：元")
    cost: float = Field(default=0.0, description="充电成本，单位：元")
    profit: float = Field(default=0.0, description="净收益，单位：元（revenue - cost）")
    discharge_energy_kwh: float = Field(default=0.0, description="放电电量，单位：kWh（电网侧）")
    charge_energy_kwh: float = Field(default=0.0, description="充电电量，单位：kWh（电网侧）")
    profit_per_kwh: float = Field(default=0.0, description="单位放电电量收益，单位：元/kWh")


class StorageProfitWithFormulas(BaseModel):
    """同时承载 physics / sample 双口径结果"""

    # 与 payload.storage.energy_formula 对应的主口径
    main: Optional[StorageProfit] = Field(default=None, description="主口径（当前 energy_formula）对应的收益")
    # 物理主口径 physics
    physics: Optional[StorageProfit] = Field(default=None, description="physics 口径收益（可选）")
    # 手算/示例口径 sample
    sample: Optional[StorageProfit] = Field(default=None, description="sample 口径收益（可选）")


class StorageCyclesDay(BaseModel):
    """按日统计的储能等效满充满放次数与收益"""

    date: str = Field(description="日期 YYYY-MM-DD")
    cycles: float = Field(default=0.0, description="当日等效满充满放次数")
    profit: Optional[StorageProfitWithFormulas] = Field(
        default=None,
        description="当日收益信息（可为空，表示未计算或无数据）",
    )
    # 新增：有效性标记
    is_valid: bool = Field(default=True, description="该天数据是否有效（有正负荷数据）")
    point_count: int = Field(default=96, description="该天有效数据点数量（满为96个15分钟点）")


class StorageCyclesMonth(BaseModel):
    """按月统计的储能等效满充满放次数与收益"""

    year_month: str = Field(description="月份 YYYY-MM")
    cycles: float = Field(default=0.0, description="该月等效满充满放次数汇总")
    profit: Optional[StorageProfitWithFormulas] = Field(
        default=None,
        description="该月收益汇总信息（可为空）",
    )
    # 新增：有效天数统计
    valid_days: int = Field(default=0, description="该月有效天数（有正负荷数据的天数）")


class StorageCyclesYear(BaseModel):
    """按年统计的储能等效满充满放次数与收益"""

    year: int = Field(description="年份，0 表示未知或占位")
    cycles: float = Field(default=0.0, description="全年等效满充满放次数汇总")
    profit: Optional[StorageProfitWithFormulas] = Field(
        default=None,
        description="全年收益汇总信息（可为空）",
    )
    # 新增：全年有效天数统计
    valid_days: int = Field(default=0, description="全年有效天数")


class TipDischargePoint(BaseModel):
    """尖段典型点（可用于前端小图/标注）"""

    time: str = Field(description="HH:mm 当天的时间字符串")
    load_kw: float = Field(description="该时刻负荷，单位 kW")


class TipDischargeSummary(BaseModel):
    """尖段放电占比分析结果"""

    avg_tip_load_kw: float = Field(default=0.0, description="尖段平均负荷，单位 kW")
    tip_hours: float = Field(default=0.0, description="尖段总时长，单位小时")
    discharge_count: float = Field(default=0.0, description="尖段放电等效次数（可为非整数）")
    capacity_kwh: float | None = Field(default=None, description="当前假设的储能容量，单位 kWh")
    energy_need_kwh: float | None = Field(default=None, description="尖段能量需求，单位 kWh")
    ratio: float | None = Field(default=None, description="尖段放电满足程度 0-1")
    tip_points: list[TipDischargePoint] | None = Field(default=None, description="尖段典型点列表")
    note: str | None = Field(default=None, description="说明或备注")
    day_stats: list[dict] | None = Field(
        default=None,
        description="按日统计 [{date, avg_load_kw, tip_hours, energy_need_kwh, discharge_count, ratio}]",
    )
    month_stats: list[dict] | None = Field(
        default=None,
        description="1-12 月的平均满足度 [{month, ratio}]",
    )


class StorageQC(BaseModel):
    """储能计算质量指标"""

    notes: List[str] = Field(default_factory=list, description="提示信息及说明")
    missing_prices: int = Field(default=0, description="价格缺失的 15 分钟点数量")
    missing_points: int = Field(default=0, description="负荷数据缺失的 15 分钟点数量")
    merged_segments: int = Field(default=0, description="被合并的小窗口段数量")
    # 限值信息（变压器容量 / 月最大需量）
    limit_mode: Optional[str] = Field(
        default=None,
        description="限值模式：monthly_demand_max 或 transformer_capacity",
    )
    transformer_limit_kw: Optional[float] = Field(
        default=None,
        description="变压器容量折算的有功功率上限，单位 kW",
    )
    monthly_demand_max: List[dict] = Field(
        default_factory=list,
        description="每月最大需量 [{year_month, max_kw}]",
    )


class StorageWindowMonthSummary(BaseModel):
    """Window_debug 汇总的按月 C1/C2 + charge/discharge 统计"""

    year_month: str = Field(description="月份 YYYY-MM")
    # C1 + charge：第一次充电窗口在该月贡献的等效满充次数
    first_charge_cycles: float = Field(default=0.0, description="C1+charge 当月等效充电次数之和")
    # C1 + discharge：第一次放电窗口
    first_discharge_cycles: float = Field(default=0.0, description="C1+discharge 当月等效放电次数之和")
    # C2 + charge：第二次充电窗口
    second_charge_cycles: float = Field(default=0.0, description="C2+charge 当月等效充电次数之和")
    # C2 + discharge：第二次放电窗口
    second_discharge_cycles: float = Field(default=0.0, description="C2+discharge 当月等效放电次数之和")


class StorageCyclesResponse(BaseModel):
    """储能等效满充满放次数 + 质量指标 + 按月窗口汇总"""

    year: StorageCyclesYear
    months: List[StorageCyclesMonth] = Field(default_factory=list)
    days: List[StorageCyclesDay] = Field(default_factory=list)
    qc: StorageQC = Field(default_factory=StorageQC)
    excel_path: Optional[str] = Field(
        default=None,
        description="后端导出 Excel 报表路径（相对路径，可选）",
    )
    # 可选：基于 window_debug 汇总得到的按月 C1/C2 窗口统计
    window_month_summary: Optional[List[StorageWindowMonthSummary]] = Field(
        default=None,
        description="[{year_month, first_charge_cycles, first_discharge_cycles, second_charge_cycles, second_discharge_cycles}]",
    )
    # 可选：尖段放电占比分析
    tip_discharge_summary: Optional[TipDischargeSummary] = Field(
        default=None,
        description="尖段放电占比分析结果",
    )


class StorageCurvesPoint(BaseModel):
    """15 分钟负荷曲线上的单点"""

    timestamp: str = Field(description="时间戳，ISO8601 字符串")
    load_kw: float = Field(description="负荷，单位 kW")


class StorageCurvesSummary(BaseModel):
    """指定日期的关键负荷与费用指标"""

    max_demand_original_kw: float = Field(default=0.0, description="原始负荷曲线下的最大需量 kW")
    max_demand_new_kw: float = Field(default=0.0, description="引入储能后的最大需量 kW")
    max_demand_reduction_kw: float = Field(default=0.0, description="最大需量降低值 kW")
    max_demand_reduction_ratio: float = Field(default=0.0, description="最大需量降低比例 0-1")
    energy_by_tier_original: dict[str, float] = Field(
        default_factory=dict,
        description="各 TOU 分段下原始负荷电量 kWh",
    )
    energy_by_tier_new: dict[str, float] = Field(
        default_factory=dict,
        description="各 TOU 分段下引入储能后的电量 kWh",
    )
    bill_by_tier_original: dict[str, float] = Field(
        default_factory=dict,
        description="各 TOU 分段下原始电费 元",
    )
    bill_by_tier_new: dict[str, float] = Field(
        default_factory=dict,
        description="各 TOU 分段下引入储能后的电费 元",
    )
    profit_day_main: Optional[StorageProfit] = Field(
        default=None,
        description="该日主口径（energy_formula）下的收益汇总信息",
    )


class StorageCurvesResponse(BaseModel):
    """/api/storage/cycles/curves 接口返回的数据结构"""

    date: str = Field(description="日期 YYYY-MM-DD")
    points_original: List[StorageCurvesPoint] = Field(description="原始负荷曲线 15 分钟点")
    points_with_storage: List[StorageCurvesPoint] = Field(description="引入储能后的等效负荷曲线 15 分钟点")
    summary: StorageCurvesSummary = Field(description="选定日期的关键指标与收益汇总")


# =========================
# 数据清洗相关模型
# =========================


class ZeroSpanDetail(BaseModel):
    """零值时段详情"""

    id: str = Field(description="时段唯一标识")
    start_time: str = Field(description="开始时间 ISO8601")
    end_time: str = Field(description="结束时间 ISO8601")
    duration_hours: float = Field(description="持续时长（小时）")
    point_count: int = Field(default=0, description="数据点数")
    prev_day_avg_load: Optional[float] = Field(default=None, description="前一天同时段平均负荷 kW")
    next_day_avg_load: Optional[float] = Field(default=None, description="后一天同时段平均负荷 kW")
    prev_month_same_day_avg: Optional[float] = Field(default=None, description="上月同日平均负荷 kW")
    next_month_same_day_avg: Optional[float] = Field(default=None, description="下月同日平均负荷 kW")
    weekday: str = Field(default="", description="星期几（中文）")
    is_holiday: bool = Field(default=False, description="是否节假日")
    user_decision: Optional[str] = Field(default=None, description="用户判断: normal | abnormal")


class NegativeSpanDetail(BaseModel):
    """负值时段详情"""

    id: str = Field(description="时段唯一标识")
    date: str = Field(description="日期 YYYY-MM-DD")
    start_hour: int = Field(description="开始小时")
    end_hour: int = Field(description="结束小时（半开区间）")
    min_value: float = Field(description="最小负值 kW")
    max_value: float = Field(description="最大负值 kW")
    point_count: int = Field(description="点数")
    treatment: str = Field(default="keep", description="处理方式: keep | abs | zero")


class NullSpanDetail(BaseModel):
    """空值时段详情"""

    id: str = Field(description="时段唯一标识")
    start_time: str = Field(description="开始时间 ISO8601")
    end_time: str = Field(description="结束时间 ISO8601")
    duration_hours: float = Field(description="持续时长（小时）")
    point_count: int = Field(description="点数")
    weekday: str = Field(default="", description="星期几（中文）")


class CleaningAnalysisResponse(BaseModel):
    """清洗分析响应"""

    null_point_count: int = Field(default=0, description="空值点数")
    null_hours: float = Field(default=0.0, description="空值对应小时数")
    null_spans: List[NullSpanDetail] = Field(default_factory=list, description="空值时段列表")
    zero_spans: List[ZeroSpanDetail] = Field(default_factory=list, description="零值时段列表")
    total_zero_hours: float = Field(default=0.0, description="零值总时长（小时）")
    negative_spans: List[NegativeSpanDetail] = Field(default_factory=list, description="负值时段列表")
    total_negative_points: int = Field(default=0, description="负值总点数")
    total_expected_points: int = Field(default=0, description="期望点数")
    total_actual_points: int = Field(default=0, description="实际有效点数")
    completeness_ratio: float = Field(default=0.0, description="数据完整度 0-1")


class CleaningConfigRequest(BaseModel):
    """清洗配置请求"""

    null_strategy: str = Field(default="interpolate", description="空值策略: interpolate | delete | keep")
    negative_strategy: str = Field(default="keep", description="负值策略: keep | abs | zero")
    zero_decisions: dict = Field(default_factory=dict, description="零值判断: {span_id: 'normal' | 'abnormal'}")


class CleaningResultResponse(BaseModel):
    """清洗结果响应"""

    null_points_interpolated: int = Field(default=0, description="插值的空值点数")
    zero_spans_kept: int = Field(default=0, description="保留的零值时段数")
    zero_spans_interpolated: int = Field(default=0, description="插值的零值时段数")
    negative_points_kept: int = Field(default=0, description="保留的负值点数")
    negative_points_modified: int = Field(default=0, description="修改的负值点数")
    interpolated_count: int = Field(default=0, description="总插值点数")
    cleaned_points: List[CleanedPoint] = Field(default_factory=list, description="清洗后的数据点")


class ComparisonMetrics(BaseModel):
    """对比指标"""

    actual_cycles: float = Field(default=0.0, description="实际循环总数")
    equivalent_cycles: float = Field(default=0.0, description="等效循环数")
    valid_days: int = Field(default=0, description="有效天数")
    profit: float = Field(default=0.0, description="年度收益")


class ComparisonResult(BaseModel):
    """清洗前后对比结果"""

    original: ComparisonMetrics = Field(description="原始数据指标")
    cleaned: ComparisonMetrics = Field(description="清洗后指标")
    diff_actual_cycles: float = Field(default=0.0, description="实际循环差异")
    diff_actual_cycles_percent: float = Field(default=0.0, description="实际循环差异百分比")
    diff_equivalent_cycles: float = Field(default=0.0, description="等效循环差异")
    diff_equivalent_cycles_percent: float = Field(default=0.0, description="等效循环差异百分比")
    diff_valid_days: int = Field(default=0, description="有效天数差异")
    diff_profit: float = Field(default=0.0, description="收益差异")
    diff_profit_percent: float = Field(default=0.0, description="收益差异百分比")
    recommendation: str = Field(default="cleaned", description="推荐使用: original | cleaned")
    completeness_ratio: float = Field(default=0.0, description="清洗后数据完整度")


class ProjectSummaryRequest(BaseModel):
    """生成项目评估报告的请求参数"""

    project_name: str = Field(description="项目名称")
    project_location: str = Field(default="", description="项目地点")
    period_start: str = Field(description="评估周期开始日期 YYYY-MM-DD")
    period_end: str = Field(description="评估周期结束日期 YYYY-MM-DD")
    load_profile: Optional[dict] = Field(default=None, description="负荷特征摘要（可选）")
    tou_config: Optional[dict] = Field(default=None, description="TOU 配置（可选）")
    storage_config: Optional[dict] = Field(default=None, description="储能配置（可选）")
    storage_results: Optional[dict] = Field(default=None, description="储能测算结果（可选）")
    quality_report: Optional[dict] = Field(default=None, description="数据质量报告（可选）")


class ProjectSummaryResponse(BaseModel):
    """生成项目评估报告的响应"""

    report_id: str = Field(description="报告唯一标识")
    project_name: str = Field(description="项目名称")
    period_start: str = Field(description="评估周期开始")
    period_end: str = Field(description="评估周期结束")
    generated_at: str = Field(description="生成时间 ISO8601")
    markdown: str = Field(description="完整报告 Markdown 文本")
    summary: dict = Field(
        default_factory=dict,
        description="关键摘要信息（首年收益、循环次数、利用小时等）",
    )


# =========================
# 储能经济性测算模型
# =========================


class StorageEconomicsInput(BaseModel):
    """储能经济性测算输入参数"""

    first_year_revenue: float = Field(
        description="首年收益 R₁（已扣电费、未扣运维），单位：元"
    )
    first_year_energy_kwh: Optional[float] = Field(
        default=None,
        gt=0,
        description="首年发电能量（来自 Storage Cycles），单位：kWh。若提供，将用于精确计算静态经济性指标（LCOE、度电收益）；否则将基于收益反算",
    )
    project_years: int = Field(
        default=15,
        ge=1,
        le=30,
        description="项目年限，范围 1–30 年",
    )
    annual_om_cost: float = Field(
        default=0.0,
        ge=0,
        description="年运维成本单位成本，单位：元/Wh。实际年运维成本 = annual_om_cost × 储能容量(kWh) ÷ 10（万元）",
    )
    first_year_decay_rate: float = Field(
        default=0.03,
        ge=0,
        le=1,
        description="首年衰减率，0–1 之间（如 0.03 表示 3%）",
    )
    subsequent_decay_rate: float = Field(
        default=0.015,
        ge=0,
        le=1,
        description="次年至末年衰减率，0–1 之间（如 0.015 表示 1.5%）",
    )
    capex_per_wh: float = Field(
        gt=0,
        description="单 Wh 投资，单位：元/Wh",
    )
    installed_capacity_kwh: float = Field(
        gt=0,
        description="储能装机容量，单位：kWh",
    )
    cell_replacement_cost: Optional[float] = Field(
        default=None,
        ge=0,
        description="更换电芯成本单位成本（可选），单位：元/Wh。实际成本 = cell_replacement_cost × 储能容量(kWh) ÷ 10（万元）",
    )
    cell_replacement_year: Optional[int] = Field(
        default=None,
        ge=1,
        description="电芯更换年份（可选），第 N 年",
    )
    second_phase_first_year_revenue: Optional[float] = Field(
        default=None,
        description="更换电芯后新的首年收益 R′₁（可选），默认与 R₁ 相同",
    )


class YearlyCashflowItem(BaseModel):
    """年度现金流单条记录"""

    year_index: int = Field(description="第几年度，1..N")
    year_revenue: float = Field(description="年度收益（已扣电费、按衰减计算）")
    annual_om_cost: float = Field(description="当年运维成本")
    cell_replacement_cost: float = Field(
        default=0.0,
        description="当年电芯更换成本（无则为 0）",
    )
    net_cashflow: float = Field(
        description="年度净现金流 = 年收益 - 运维 - 更换成本"
    )
    cumulative_net_cashflow: float = Field(description="累计净现金流")


class StaticEconomicsMetrics(BaseModel):
    """静态经济性评估指标（第一步：快速筛选）"""

    static_lcoe: float = Field(
        description="静态平均度电成本，单位：元/kWh（LCOE = CAPEX / (年均收益能量 × 项目年限)）"
    )
    annual_energy_kwh: float = Field(
        description="年均发电能量（扣衰减后），单位：kWh"
    )
    annual_revenue_yuan: float = Field(
        description="年均收益（扣衰减后），单位：元"
    )
    revenue_per_kwh: float = Field(
        description="度电平均收益，单位：元/kWh（年均收益 / 年均能量）"
    )
    lcoe_ratio: float = Field(
        description="经济可行性比值 = 度电收益 / LCOE（≥ 1.5 为绿灯，< 1.5 为红灯）"
    )
    pass_threshold: float = Field(
        default=1.5,
        description="快速筛选通过阈值（建议 1.5）",
    )
    screening_result: str = Field(
        description="筛选结论：'pass'（通过，值得深算）或 'fail'（未通过，明显不行）"
    )


class StorageEconomicsResult(BaseModel):
    """储能经济性测算结果"""

    capex_total: float = Field(description="总投资 CAPEX（元）")
    irr: Optional[float] = Field(
        default=None,
        description="内部收益率（0–1，如 0.12 表示 12%），无法收敛则为 null",
    )
    static_payback_years: Optional[float] = Field(
        default=None,
        description="静态回收期（年，可带小数），项目周期内无法回本则为 null",
    )
    final_cumulative_net_cashflow: float = Field(
        description="项目周期末累计净现金流（元）"
    )
    yearly_cashflows: List[YearlyCashflowItem] = Field(
        default_factory=list,
        description="年度现金流序列",
    )
    static_metrics: Optional[StaticEconomicsMetrics] = Field(
        default=None,
        description="静态经济性评估指标（第一步快速筛选，可选）",
    )


# ==================== 项目经济性评估报告（图文 PDF v3.0） ====================


class ReportMetaV3(BaseModel):
    report_version: Literal["v3.0"] = Field(default="v3.0", description="报告版本号")
    generated_at: str = Field(description="生成时间 ISO8601")
    project_name: str = Field(description="项目名称")
    owner_name: Optional[str] = Field(default=None, description="业主方名称（可选）")
    project_location: Optional[str] = Field(default=None, description="项目地点（可选）")
    period_start: str = Field(description="评估周期起始日 YYYY-MM-DD")
    period_end: str = Field(description="评估周期结束日 YYYY-MM-DD")
    author_org: Optional[str] = Field(default=None, description="编制单位/作者（可选）")
    subtitle: Optional[str] = Field(default=None, description="封面副标题（可选）")
    logo_data_url: Optional[str] = Field(default=None, description="Logo 图片 DataURL（可选）")
    total_investment_wanyuan: float = Field(description="项目总投资（万元）")


class ReportCompletenessV3(BaseModel):
    has_load: bool = Field(description="是否具备负荷数据")
    has_tou: bool = Field(description="是否具备 TOU 与策略配置")
    has_cycles: bool = Field(description="是否具备 cycles 测算结果")
    has_economics: bool = Field(description="是否具备 economics 测算结果")
    has_profit_curves_for_best_profit_day: bool = Field(description="是否具备收益最高日曲线")
    has_profit_curves_for_max_load_day: bool = Field(description="是否具备最大负荷日曲线")
    missing_items: List[str] = Field(default_factory=list, description="缺失项清单（用于导出提示/报告占位）")


class ReportChartsV3(BaseModel):
    price_24h_png: Optional[str] = Field(default=None, description="24h 分时电价图（PNG DataURL）")
    strategy_24h_png: Optional[str] = Field(default=None, description="24h 运行策略图（PNG DataURL）")
    load_typical_png: Optional[str] = Field(default=None, description="负荷典型曲线图（PNG DataURL）")
    load_monthly_distribution_png: Optional[str] = Field(default=None, description="月度分布图（PNG DataURL）")
    load_price_overlay_png: Optional[str] = Field(default=None, description="负荷-电价叠加图（PNG DataURL）")
    capacity_compare_png: Optional[str] = Field(default=None, description="容量对比趋势图（PNG DataURL）")
    cashflow_png: Optional[str] = Field(default=None, description="现金流图（PNG DataURL）")
    best_profit_day_overlay_png: Optional[str] = Field(default=None, description="收益最高日叠加图（PNG DataURL）")
    max_load_day_overlay_png: Optional[str] = Field(default=None, description="最大负荷日叠加图（PNG DataURL）")


class ReportAiPolishV3(BaseModel):
    enabled: bool = Field(default=False, description="是否启用 AI 文案润色")
    provider: Optional[str] = Field(default=None, description="模型供应商标识（可选）")
    notes: str = Field(default="仅润色，不改数值", description="约束说明")


class ReportNarrativeV3(BaseModel):
    summary: str = Field(default="本报告由系统自动生成。", description="摘要段落")
    conclusion: str = Field(default="结论待补充。", description="综合结论段落")
    risks: List[str] = Field(default_factory=list, description="风险提示条目")
    suggestions: List[str] = Field(default_factory=list, description="建议与下一步条目")


class ReportDataV3(BaseModel):
    meta: ReportMetaV3
    completeness: ReportCompletenessV3
    load: Dict[str, Any] = Field(default_factory=dict, description="负荷相关数据（透传/兼容）")
    tou: Dict[str, Any] = Field(default_factory=dict, description="TOU 与策略配置（透传/兼容）")
    storage: Dict[str, Any] = Field(default_factory=dict, description="储能测算数据（透传/兼容）")
    narrative: ReportNarrativeV3 = Field(default_factory=ReportNarrativeV3, description="报告文本段落（可选由 AI 润色）")
    charts: ReportChartsV3 = Field(default_factory=ReportChartsV3, description="图表图片（DataURL）")
    ai_polish: ReportAiPolishV3 = Field(default_factory=ReportAiPolishV3, description="AI 文案润色配置")


class ReportPdfRequest(BaseModel):
    report_data: ReportDataV3 = Field(description="报告数据（前端组装，后端模板渲染）")
