import type { ReportDataV3 } from '../types';
import type { LocalRunWithArtifacts, LocalDatasetWithPoints, StoredLoadPoint } from '../localProjectStore';
import { pickBestProfitDay, pickMaxLoadDay } from './reportTypicalDays';

type TierId = '尖' | '峰' | '平' | '谷' | '深';
type OperatingLogicId = '待机' | '充' | '放';

type SegmentAvgItem = {
  month_index: number; // 1..12
  tou: TierId;
  op: OperatingLogicId;
  start_hour: number; // 0..23
  end_hour: number; // 1..24
  hours: number;
  sample_points: number;
  avg_load_kw: number | null;
};

type MonthlySegmentAvg = {
  month_index: number; // 1..12
  month_label: string; // 1月..12月
  segments: SegmentAvgItem[];
};

const normalizeTierId = (v: any): TierId => {
  const s = String(v ?? '').trim();
  if (s === '尖' || s === '峰' || s === '平' || s === '谷' || s === '深') return s;
  return '平';
};

const normalizeOpId = (v: any): OperatingLogicId => {
  const s = String(v ?? '').trim();
  if (s === '待机' || s === '充' || s === '放') return s;
  return '待机';
};

const getMonthSchedule24 = (cfg: any, monthIndex0: number): Array<{ tou: TierId; op: OperatingLogicId }> | null => {
  const monthly = Array.isArray(cfg?.monthlySchedule) ? cfg.monthlySchedule : (Array.isArray(cfg?.monthly_schedule) ? cfg.monthly_schedule : null);
  if (!monthly || monthly.length !== 12) return null;
  const sched = monthly[monthIndex0];
  if (!Array.isArray(sched) || sched.length !== 24) return null;
  return sched.map((c: any) => ({ tou: normalizeTierId(c?.tou), op: normalizeOpId(c?.op) }));
};

const buildSegmentsForMonth = (sched24: Array<{ tou: TierId; op: OperatingLogicId }>): Array<{ tou: TierId; op: OperatingLogicId; start: number; end: number }> => {
  const segments: Array<{ tou: TierId; op: OperatingLogicId; start: number; end: number }> = [];
  if (!Array.isArray(sched24) || sched24.length !== 24) return segments;
  let start = 0;
  let cur = sched24[0];
  for (let h = 1; h <= 24; h++) {
    const next = h < 24 ? sched24[h] : null;
    if (h === 24 || !next || next.tou !== cur.tou || next.op !== cur.op) {
      segments.push({ tou: cur.tou, op: cur.op, start, end: h });
      start = h;
      if (next) cur = next;
    }
  }
  return segments;
};

const computeMonthlySegmentAverageLoads = (input: {
  points: StoredLoadPoint[];
  intervalMinutes: number | null;
  cfg: any;
}): { months: MonthlySegmentAvg[]; warnings: string[] } => {
  const interval = Number(input.intervalMinutes ?? NaN);
  const factor = Number.isFinite(interval) && interval > 0 ? (60 / interval) : 1;
  const warnings: string[] = [];

  const months: MonthlySegmentAvg[] = [];

  // 预先为每个月构建 segment 与 hour->segmentIndex 映射
  const monthSegs: Array<{
    segments: Array<{ tou: TierId; op: OperatingLogicId; start: number; end: number }>;
    segIndexByHour: number[];
  } | null> = Array.from({ length: 12 }, (_, m) => {
    const sched24 = getMonthSchedule24(input.cfg, m);
    if (!sched24) return null;
    const segments = buildSegmentsForMonth(sched24);
    const segIndexByHour = Array.from({ length: 24 }, () => -1);
    segments.forEach((seg, idx) => {
      for (let h = seg.start; h < seg.end; h++) segIndexByHour[h] = idx;
    });
    return { segments, segIndexByHour };
  });

  const sums: number[][] = Array.from({ length: 12 }, (_, m) => {
    const segCount = monthSegs[m]?.segments.length ?? 0;
    return Array.from({ length: segCount }, () => 0);
  });
  const counts: number[][] = Array.from({ length: 12 }, (_, m) => {
    const segCount = monthSegs[m]?.segments.length ?? 0;
    return Array.from({ length: segCount }, () => 0);
  });

  for (const p of input.points) {
    const ts = typeof p?.timestamp === 'string' ? p.timestamp : '';
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const m = d.getMonth(); // 0..11
    const h = d.getHours();
    if (m < 0 || m > 11 || h < 0 || h > 23) continue;
    const ms = monthSegs[m];
    if (!ms) continue;
    const segIdx = ms.segIndexByHour[h];
    if (segIdx < 0) continue;
    const v = Number((p as any)?.load_kwh ?? NaN);
    if (!Number.isFinite(v)) continue;
    sums[m][segIdx] += v * factor;
    counts[m][segIdx] += 1;
  }

  for (let m = 0; m < 12; m++) {
    const ms = monthSegs[m];
    if (!ms) {
      warnings.push(`月度分时段平均负荷未生成：缺少 ${m + 1} 月 monthlySchedule 配置`);
      months.push({ month_index: m + 1, month_label: `${m + 1}月`, segments: [] });
      continue;
    }
    const items: SegmentAvgItem[] = ms.segments.map((seg, idx) => {
      const c = counts[m][idx] ?? 0;
      const avg = c > 0 ? (sums[m][idx] / c) : null;
      return {
        month_index: m + 1,
        tou: seg.tou,
        op: seg.op,
        start_hour: seg.start,
        end_hour: seg.end,
        hours: Math.max(0, seg.end - seg.start),
        sample_points: c,
        avg_load_kw: avg == null ? null : Math.round(avg * 100) / 100,
      };
    });
    months.push({ month_index: m + 1, month_label: `${m + 1}月`, segments: items });
  }

  return { months, warnings };
};

export const buildReportDataV3 = (input: {
  projectName: string;
  run: LocalRunWithArtifacts;
  dataset: LocalDatasetWithPoints | null;
  ownerName: string;
  projectLocation: string;
  authorOrg: string;
  subtitle: string;
  logoDataUrl: string | null;
  totalInvestmentWanyuan: number;
}): ReportDataV3 => {
  const generatedAt = new Date().toISOString();

  const points: StoredLoadPoint[] =
    input.dataset?.points?.length
      ? input.dataset.points
      : (Array.isArray(input.run.embedded_points) ? input.run.embedded_points : []);

  const intervalMinutes =
    input.dataset?.interval_minutes ??
    input.dataset?.meta_json?.source_interval_minutes ??
    null;

  const interval = Number(intervalMinutes ?? NaN);
  const factor = Number.isFinite(interval) && interval > 0 ? (60 / interval) : 1;
  const loadKwList = points
    .map((p) => Number((p as any)?.load_kwh ?? NaN))
    .filter((v) => Number.isFinite(v))
    .map((kwh) => kwh * factor);
  const avgLoadKw = loadKwList.length > 0 ? (loadKwList.reduce((a, b) => a + b, 0) / loadKwList.length) : null;
  const maxLoadKw = loadKwList.length > 0 ? Math.max(...loadKwList) : null;
  const minLoadKw = loadKwList.length > 0 ? Math.min(...loadKwList) : null;
  const peakValleyDiffKw = (maxLoadKw != null && minLoadKw != null) ? (maxLoadKw - minLoadKw) : null;

  const startDay =
    input.dataset?.start_time?.slice(0, 10) ??
    points[0]?.timestamp?.slice(0, 10) ??
    '';
  const endDay =
    input.dataset?.end_time?.slice(0, 10) ??
    points[points.length - 1]?.timestamp?.slice(0, 10) ??
    '';

  const hasLoad = points.length > 0;
  const cfg = input.run.config_snapshot as any;
  const hasTou = Boolean(cfg && (Array.isArray(cfg.monthlySchedule) || Array.isArray(cfg.prices) || Array.isArray(cfg.dateRules)));
  const cyclesSnapshot = input.run.cycles_snapshot as any;
  const cyclesResp = cyclesSnapshot?.response ?? null;
  const cyclesPayload = cyclesSnapshot?.payload ?? null;
  const hasCycles = Boolean(cyclesResp);

  const economicsSnapshot = input.run.economics_snapshot as any;
  const hasEconomics = Boolean(economicsSnapshot?.result);

  const bestProfitDay = pickBestProfitDay(cyclesResp);
  const maxLoadDay = pickMaxLoadDay(points, intervalMinutes);

  const { months: segmentAvgMonths, warnings: segmentAvgWarnings } = computeMonthlySegmentAverageLoads({
    points,
    intervalMinutes,
    cfg,
  });

  const missing: string[] = [];
  if (!hasLoad) missing.push('缺少负荷数据：请先导入/选择数据集或提供点位兜底');
  if (!hasTou) missing.push('缺少 TOU/策略配置：请先保存配置快照');
  if (!hasCycles) missing.push('缺少 cycles 测算结果：请先完成 cycles 测算并保存快照');
  if (!hasEconomics) missing.push('缺少 economics 测算结果：可导出但经济性章节将占位');
  if (!bestProfitDay) missing.push('缺少收益最高日：cycles 日度收益数据不足');
  if (!maxLoadDay) missing.push('缺少最大负荷日：负荷点位数据不足');
  if (bestProfitDay) missing.push('缺少收益最高日曲线：导出前可尝试拉取曲线');
  if (maxLoadDay) missing.push('缺少最大负荷日曲线：导出前可尝试拉取曲线');
  for (const w of segmentAvgWarnings) missing.push(`负荷分时段统计提示：${w}`);

  const econResult = economicsSnapshot?.result ?? null;
  const irrPct = Number.isFinite(Number(econResult?.irr)) ? `${(Number(econResult.irr) * 100).toFixed(2)}%` : '未测算';
  const paybackYears = (econResult?.static_payback_years == null || !Number.isFinite(Number(econResult.static_payback_years)))
    ? '未测算'
    : `${Number(econResult.static_payback_years).toFixed(2)} 年`;
  const finalCash = Number.isFinite(Number(econResult?.final_cumulative_net_cashflow))
    ? `${Math.round(Number(econResult.final_cumulative_net_cashflow)).toLocaleString()} 元`
    : '未测算';

  const yearCycles = Number.isFinite(Number(cyclesResp?.year?.cycles)) ? `${Number(cyclesResp.year.cycles).toFixed(2)}` : '未测算';
  const firstYearEnergy = Number.isFinite(Number(cyclesResp?.year?.profit?.main?.discharge_energy_kwh))
    ? `${Math.round(Number(cyclesResp.year.profit.main.discharge_energy_kwh)).toLocaleString()} kWh`
    : '未测算';
  const firstYearProfit = Number.isFinite(Number(cyclesResp?.year?.profit?.main?.profit))
    ? `${Math.round(Number(cyclesResp.year.profit.main.profit)).toLocaleString()} 元`
    : '未测算';

  return {
    meta: {
      report_version: 'v3.0',
      generated_at: generatedAt,
      project_name: input.projectName,
      owner_name: input.ownerName.trim() || null,
      project_location: input.projectLocation.trim() || null,
      period_start: startDay,
      period_end: endDay,
      author_org: input.authorOrg.trim() || null,
      subtitle: input.subtitle.trim() || null,
      logo_data_url: input.logoDataUrl || null,
      total_investment_wanyuan: input.totalInvestmentWanyuan,
    },
    completeness: {
      has_load: hasLoad,
      has_tou: hasTou,
      has_cycles: hasCycles,
      has_economics: hasEconomics,
      has_profit_curves_for_best_profit_day: false,
      has_profit_curves_for_max_load_day: false,
      missing_items: missing,
    },
    load: {
      meta: {
        source_interval_minutes: intervalMinutes,
        total_records: points.length || input.dataset?.points_count || 0,
        start: input.dataset?.start_time ?? (points[0]?.timestamp ?? null),
        end: input.dataset?.end_time ?? (points[points.length - 1]?.timestamp ?? null),
        dataset_name: input.dataset?.name ?? null,
        source_filename: input.dataset?.source_filename ?? null,
        fingerprint: input.dataset?.fingerprint ?? null,
        avg_load_kw: avgLoadKw ?? (input.dataset?.meta_json?.avg_load_kw ?? null),
        max_load_kw: maxLoadKw ?? (input.dataset?.meta_json?.max_load_kw ?? null),
        min_load_kw: minLoadKw ?? (input.dataset?.meta_json?.min_load_kw ?? null),
        peak_valley_diff_kw: peakValleyDiffKw,
      },
      quality_report: input.dataset?.quality_report_json ?? input.run.quality_snapshot?.report ?? null,
      tou_strategy_segment_avg_by_month: {
        note: '按月（1-12月）配置，将负荷点位换算为 kW 后按“TOU档位×运行策略”连续时段聚合得到的平均负荷；若存在日期规则覆盖，未在本统计中展开。',
        interval_minutes: intervalMinutes,
        months: segmentAvgMonths,
      },
    },
    tou: {
      prices: cfg?.prices ?? null,
      monthly_schedule: cfg?.monthlySchedule ?? null,
      date_rules: cfg?.dateRules ?? [],
    },
    storage: {
      cycles: cyclesResp,
      cycles_payload: cyclesPayload,
      run_meta: {
        run_id: input.run.id,
        run_name: input.run.name,
        run_created_at: input.run.created_at,
        dataset_id: input.run.dataset_id ?? null,
      },
      economics: {
        input: economicsSnapshot?.input ?? null,
        result: economicsSnapshot?.result ?? null,
        user_share_percent: Number(economicsSnapshot?.user_share_percent ?? 0),
      },
      typical_days: {
        best_profit_day: { date: bestProfitDay, curves: null },
        max_load_day: { date: maxLoadDay, curves: null },
      },
    },
    narrative: {
      summary: `本报告基于项目负荷数据、分时电价（TOU）与储能运行策略配置，汇总 cycles 与经济性测算结果，形成可交付的图文 PDF。当前测算口径下：IRR=${irrPct}，静态回收期=${paybackYears}，项目期末累计净现金流=${finalCash}。`,
      conclusion: `在既定投资假设（总投资 ${input.totalInvestmentWanyuan.toFixed(2)} 万元）下，储能系统首年净收益=${firstYearProfit}，首年放电能量=${firstYearEnergy}，年等效循环次数=${yearCycles}。建议结合典型日（收益最高日/最大负荷日）对运行策略与数据代表性进行复核后，推进方案比选与商务测算对齐。`,
      risks: [
        '电价政策与峰谷价差变化会直接影响套利空间，导致收益波动。',
        '负荷数据代表性不足（周期偏短、缺失/异常）可能导致测算结果偏差。',
        '设备衰减、运维与更换策略将影响全生命周期收益与回收期。',
      ],
      suggestions: [
        '补齐缺失测算项与关键参数口径（单位/计量方式），并保存报告快照以便追溯复盘。',
        '针对典型日与关键月份，复核策略是否符合现场可执行性（功率约束、SOC 边界、预留功率）。',
        '如需对外投标/汇报，建议补充更多周期数据与情景假设说明，避免单一周期结论外推风险。',
      ],
    },
    charts: {
      price_24h_png: null,
      strategy_24h_png: null,
      load_typical_png: null,
      load_monthly_distribution_png: null,
      load_price_overlay_png: null,
      capacity_compare_png: null,
      cashflow_png: null,
      best_profit_day_overlay_png: null,
      max_load_day_overlay_png: null,
    },
    ai_polish: {
      enabled: false,
      provider: null,
      notes: '仅润色，不改数值',
    },
  };
};
