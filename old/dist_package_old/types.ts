export type TierId = '尖' | '峰' | '平' | '谷' | '深';

export type OperatingLogicId = '待机' | '充' | '放';

export interface CellData {
  tou: TierId;
  op: OperatingLogicId;
}

export type Schedule = CellData[][];

export interface TierInfo {
  id: TierId;
  name: string;
  color: string;
  textColor: string;
}

export interface OperatingLogicInfo {
  id: OperatingLogicId;
  name: string;
  color: string;
  textColor: string;
}

export interface CellPosition {
  monthIndex: number;
  hourIndex: number;
}

export interface DateRule {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  schedule: CellData[]; // 24-hour schedule
}

export interface Configuration {
  id: string;
  name: string;
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
    // 每月 TOU 电价（下标 0-11 对应 1-12 月），每项为一个 TOU->价格(元/kWh) 映射
    prices: MonthlyTouPrices;
  };
}

export interface BackendCleanedLoadPoint {
  timestamp: string;
  load_kwh: number;
}

export interface BackendMissingHoursByMonth {
  month: string;  // YYYY-MM 格式
  missing_days: number;
  missing_hours: number;
}

export interface BackendPartialMissingDay {
  date: string;  // YYYY-MM-DD 格式
  present_hours: number;
  missing_hours: number;
}

export interface BackendMissingSummary {
  missing_days: string[];
  missing_hours_by_month: BackendMissingHoursByMonth[];
  partial_missing_days?: BackendPartialMissingDay[];
  summary: {
    total_missing_days: number;
    total_missing_hours: number;
    total_partial_missing_days?: number;
    expected_days?: number;
    actual_days?: number;
    completeness_ratio?: number;
  };
}

export type AnomalyKind = 'null' | 'zero' | 'negative';

export interface BackendValueAnomaly {
  kind: AnomalyKind;
  count: number;
  ratio: number;
  samples: string[];
}

export interface BackendDailyAnomaly {
  date: string;  // YYYY-MM-DD 格式
  zero_count: number;
  negative_count: number;
  null_count: number;
}

export interface BackendContinuousZeroSpan {
  start: string;
  end: string;
  length_hours: number;
}

export interface BackendQualityReport {
  missing: BackendMissingSummary;
  anomalies: BackendValueAnomaly[];
  daily_anomalies?: BackendDailyAnomaly[];
  continuous_zero_spans: BackendContinuousZeroSpan[];
}

export interface BackendAnalysisMeta {
  source_interval_minutes: number;
  total_records: number;
  start: string | null;
  end: string | null;
}

export interface BackendLoadAnalysisResponse {
  cleaned_points: BackendCleanedLoadPoint[];
  report: BackendQualityReport;
  meta: BackendAnalysisMeta;
}

// ---------------- 电价相关 ----------------
// 每个 TOU 段对应一个价格（单位：元/kWh），支持为空 null 表示未配置
export type PriceMap = Record<TierId, number | null>;

// 12 个月的电价配置（下标 0-11 对应 1-12 月）
export type MonthlyTouPrices = PriceMap[];

// ---------------- 储能次数 / 收益相关后端响应 ----------------
export interface BackendStorageProfit {
  revenue: number;
  cost: number;
  profit: number;
  discharge_energy_kwh: number;
  charge_energy_kwh: number;
  profit_per_kwh: number;
}

export interface BackendStorageProfitWithFormulas {
  main?: BackendStorageProfit | null;
  physics?: BackendStorageProfit | null;
  sample?: BackendStorageProfit | null;
}

export interface BackendStorageCyclesDay {
  date: string;    // YYYY-MM-DD
  cycles: number;
  profit?: BackendStorageProfitWithFormulas | null;
  // 新增：有效性标记
  is_valid?: boolean;   // 该天数据是否有效（有正负荷数据）
  point_count?: number; // 该天有效数据点数量（满为96个15分钟点）
}

export interface BackendStorageCyclesMonth {
  year_month: string; // YYYY-MM
  cycles: number;
  profit?: BackendStorageProfitWithFormulas | null;
  // 新增：有效天数统计
  valid_days?: number; // 该月有效天数
}

export interface BackendStorageCyclesYear {
  year: number;  // 0 表示服务端未确定年份
  cycles: number;
  profit?: BackendStorageProfitWithFormulas | null;
  // 新增：全年有效天数统计
  valid_days?: number; // 全年有效天数
}

export interface BackendStorageCurvesPoint {
  timestamp: string;
  load_kw: number;
}

export interface BackendStorageCurvesSummary {
  max_demand_original_kw: number;
  max_demand_new_kw: number;
  max_demand_reduction_kw: number;
  max_demand_reduction_ratio: number;
  energy_by_tier_original: Record<TierId, number>;
  energy_by_tier_new: Record<TierId, number>;
  bill_by_tier_original: Record<TierId, number>;
  bill_by_tier_new: Record<TierId, number>;
  profit_day_main?: BackendStorageProfit | null;
}

export interface BackendStorageCurvesResponse {
  date: string;
  points_original: BackendStorageCurvesPoint[];
  points_with_storage: BackendStorageCurvesPoint[];
  summary: BackendStorageCurvesSummary;
}

// 尖段放电占比汇总
export interface BackendTipDischargeSummary {
  avg_tip_load_kw: number;            // 尖段平均负荷 kW
  tip_hours: number;                  // 尖段总时长 小时
  discharge_count: number;            // 当前时长内放电次数
  capacity_kwh?: number;              // 当前假设容量 kWh（后端未返回时前端可用配置值兜底）
  energy_need_kwh?: number;           // 尖段能量需求 kWh（未给出时可用 avg * hours 估算）
  ratio?: number;                     // 直接给出的满足率 0-1，可选
  tip_points?: Array<{ time: string; load_kw: number }>; // 尖段代表性点位（供前端小图）
  note?: string;                      // 说明 / 备注
  day_stats?: Array<{ date: string; avg_load_kw: number; tip_hours: number; energy_need_kwh: number; discharge_count: number; ratio: number }>;
  month_stats?: Array<{ month: number; ratio: number }>;
}

export interface BackendStorageQC {
  notes: string[];
  missing_prices: number;
  missing_points: number;
  merged_segments: number;
  limit_mode?: 'monthly_demand_max' | 'transformer_capacity' | null;
  transformer_limit_kw?: number | null;
  monthly_demand_max: { year_month: string; max_kw: number }[];
}

// Window_debug 按月汇总（C1/C2 + charge/discharge 分段）
export interface BackendStorageWindowMonthSummary {
  year_month: string;                // YYYY-MM
  first_charge_cycles: number;       // C1 + charge 等效充电次数之和
  first_discharge_cycles: number;    // C1 + discharge 等效放电次数之和
  second_charge_cycles: number;      // C2 + charge 等效充电次数之和
  second_discharge_cycles: number;   // C2 + discharge 等效放电次数之和
}

export interface BackendStorageCyclesResponse {
  year: BackendStorageCyclesYear;
  months: BackendStorageCyclesMonth[];
  days: BackendStorageCyclesDay[];
  qc: BackendStorageQC;
  excel_path: string | null;
  // 可选：基于 Window_debug 聚合后的按月分解
  window_month_summary?: BackendStorageWindowMonthSummary[];
  // 可选：尖段放电占比分析（前端展示卡片）
  tip_discharge_summary?: BackendTipDischargeSummary;
}

// ===================== 数据清洗相关类型 =====================
// 零值时段详情
export interface ZeroSpanDetail {
  id: string;                      // 唯一标识符 zero_1, zero_2...
  start_time: string;              // ISO 时间字符串
  end_time: string;
  duration_hours: number;          // 持续时长（小时）
  point_count: number;             // 零值点数量
  weekday: string;                 // 星期几（中文）
  month: number;                   // 月份
  // 相邻天同时段负荷（帮助用户判断是否正常）
  prev_day_avg_load: number | null;  // 前一天同时段平均负荷
  next_day_avg_load: number | null;  // 后一天同时段平均负荷
  prev_month_same_day_load: number | null;  // 上月同日平均负荷
  next_month_same_day_load: number | null;  // 下月同日平均负荷
}

// 负值时段详情
export interface NegativeSpanDetail {
  id: string;                      // 唯一标识符 negative_1...
  start_time: string;
  end_time: string;
  duration_hours: number;
  point_count: number;
  min_value: number;               // 最小负值
  avg_value: number;               // 平均值
  weekday: string;
  month: number;
}

// 空值时段详情
export interface NullSpanDetail {
  id: string;
  start_time: string;
  end_time: string;
  duration_hours: number;
  point_count: number;
  weekday: string;
}

// 清洗分析响应
export interface CleaningAnalysisResponse {
  null_point_count: number;        // 空值点数量
  null_hours: number;              // 空值对应小时数
  null_spans: NullSpanDetail[];    // 空值时段列表
  zero_spans: ZeroSpanDetail[];    // 连续零值时段列表
  total_zero_hours: number;        // 零值总时长（小时）
  negative_spans: NegativeSpanDetail[];  // 负值时段列表
  total_negative_points: number;   // 负值总点数
  total_expected_points: number;   // 期望点数
  total_actual_points: number;     // 实际有效点数
  completeness_ratio: number;      // 数据完整度（0-1）
}

// 用户对零值时段的判断
export type ZeroDecision = 'normal' | 'abnormal';  // 正常停机 / 异常缺失

// 用户对负值的处理策略
export type NegativeStrategy = 'keep' | 'abs' | 'zero';  // 保留 / 取绝对值 / 置零
export type NullStrategy = 'interpolate' | 'keep' | 'delete';  // 插值 / 保留 / 删除

// 清洗配置请求
export interface CleaningConfigRequest {
  null_strategy: NullStrategy;      // 空值处理策略
  negative_strategy: NegativeStrategy;
  zero_decisions: Record<string, ZeroDecision>;  // 每个零值时段的决策
  remember_negative?: boolean;     // 是否记住负值处理偏好
}

// 清洗结果响应
export interface CleaningResultResponse {
  cleaned_points: BackendCleanedLoadPoint[];  // 清洗后的数据点
  null_points_interpolated: number;   // 空值插值数量
  zero_spans_kept: number;            // 零值保留时段数
  zero_spans_interpolated: number;    // 零值插值时段数
  negative_points_kept: number;       // 负值保留数量
  negative_points_modified: number;   // 修改的负值点数（取绝对值或置零）
  interpolated_count: number;         // 总插值点数
}

// ==================== 清洗前后对比相关类型 ====================

// 对比指标
export interface ComparisonMetrics {
  actual_cycles: number;       // 实际循环总数
  equivalent_cycles: number;   // 等效循环数
  valid_days: number;          // 有效天数
  profit: number;              // 年度收益
}

// 清洗前后对比结果
export interface ComparisonResult {
  original: ComparisonMetrics;   // 原始数据指标
  cleaned: ComparisonMetrics;    // 清洗后指标
  diff_actual_cycles: number;           // 实际循环差异
  diff_actual_cycles_percent: number;   // 实际循环差异百分比
  diff_equivalent_cycles: number;       // 等效循环差异
  diff_equivalent_cycles_percent: number; // 等效循环差异百分比
  diff_valid_days: number;              // 有效天数差异
  diff_profit: number;                  // 收益差异
  diff_profit_percent: number;          // 收益差异百分比
  recommendation: 'original' | 'cleaned'; // 推荐使用
  completeness_ratio: number;           // 清洗后数据完整度
  cleaning_actions: {
    null_points_interpolated: number;
    zero_spans_kept: number;
    zero_spans_interpolated: number;
    negative_points_modified: number;
  };
}

// ==================== 放电策略类型 ====================

export type DischargeStrategy = 'sequential' | 'price-priority';

// ==================== 储能经济性测算相关类型 ====================

// 经济性测算输入参数
export interface StorageEconomicsInput {
  first_year_revenue: number;         // 首年收益（已扣电费、未扣运维），单位：元
  first_year_energy_kwh?: number | null;  // 首年发电能量（来自 Storage Cycles），单位：kWh。用于精确计算静态 LCOE 和度电收益
  project_years: number;              // 项目年限，默认 15 年
  annual_om_cost: number;             // 年运维成本单位成本，单位：元/Wh。实际成本 = annual_om_cost × 容量(kWh) ÷ 10（万元）
  first_year_decay_rate: number;      // 首年衰减率（0–1），如 0.03 表示 3%
  subsequent_decay_rate: number;      // 次年至末年衰减率（0–1），如 0.015 表示 1.5%
  capex_per_wh: number;               // 单 Wh 投资，单位：元/Wh
  installed_capacity_kwh: number;     // 储能装机容量，单位：kWh
  cell_replacement_cost?: number | null;    // 电芯更换成本单位成本（可选），单位：元/Wh。实际成本 = cell_replacement_cost × 容量(kWh) ÷ 10（万元）
  cell_replacement_year?: number | null;    // 电芯更换年份（可选），第 N 年
  second_phase_first_year_revenue?: number | null; // 更换后新的首年收益（可选）
}

// 年度现金流单条记录
export interface YearlyCashflowItem {
  year_index: number;                 // 第几年度，1..N
  year_revenue: number;               // 年度收益（已扣电费、按衰减计算）
  annual_om_cost: number;             // 当年运维成本
  cell_replacement_cost: number;      // 当年电芯更换成本（无则为 0）
  net_cashflow: number;               // 年度净现金流
  cumulative_net_cashflow: number;    // 累计净现金流
}

// 静态经济性评估指标（第一步：快速筛选）
export interface StaticEconomicsMetrics {
  static_lcoe: number;                // 静态平均度电成本，单位：元/kWh
  annual_energy_kwh: number;          // 年均发电能量，单位：kWh
  annual_revenue_yuan: number;        // 年均收益，单位：元
  revenue_per_kwh: number;            // 度电平均收益，单位：元/kWh
  lcoe_ratio: number;                 // 经济可行性比值（≥1.5 为绿灯）
  pass_threshold?: number;            // 快速筛选通过阈值，默认 1.5
  screening_result: string;           // 筛选结论：'pass' 或 'fail'
}

// 经济性测算结果
export interface StorageEconomicsResult {
  capex_total: number;                        // 总投资 CAPEX（元）
  irr: number | null;                         // 内部收益率（0–1），无法收敛则为 null
  static_payback_years: number | null;        // 静态回收期（年），项目周期内无法回本则为 null
  final_cumulative_net_cashflow: number;      // 项目期末累计净现金流
  yearly_cashflows: YearlyCashflowItem[];     // 年度现金流序列
  static_metrics?: StaticEconomicsMetrics | null; // 静态经济性评估指标（第一步筛选）
}

// ==================== 项目经济性评估报告（图文 PDF v3.0） ====================

export type ReportChartPng = string | null; // data:image/png;base64,...

export interface ReportMetaV3 {
  report_version: 'v3.0';
  generated_at: string; // ISO8601
  project_name: string;
  owner_name: string | null;
  project_location: string | null;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  author_org: string | null;
  subtitle: string | null;
  logo_data_url: string | null; // data:image/png;base64,...
  total_investment_wanyuan: number;
}

export interface ReportCompletenessV3 {
  has_load: boolean;
  has_tou: boolean;
  has_cycles: boolean;
  has_economics: boolean;
  has_profit_curves_for_best_profit_day: boolean;
  has_profit_curves_for_max_load_day: boolean;
  missing_items: string[];
}

export interface ReportChartsV3 {
  price_24h_png: ReportChartPng;
  strategy_24h_png: ReportChartPng;
  load_typical_png: ReportChartPng;
  load_monthly_distribution_png: ReportChartPng;
  load_price_overlay_png: ReportChartPng;
  capacity_compare_png: ReportChartPng;
  cashflow_png: ReportChartPng;
  best_profit_day_overlay_png: ReportChartPng;
  max_load_day_overlay_png: ReportChartPng;
}

export interface ReportAiPolishV3 {
  enabled: boolean;
  provider: string | null;
  notes: string;
}

export interface ReportNarrativeV3 {
  summary: string;
  conclusion: string;
  risks: string[];
  suggestions: string[];
}

export interface ReportDataV3 {
  meta: ReportMetaV3;
  completeness: ReportCompletenessV3;
  load: any;
  tou: any;
  storage: any;
  narrative: ReportNarrativeV3;
  charts: ReportChartsV3;
  ai_polish: ReportAiPolishV3;
}
