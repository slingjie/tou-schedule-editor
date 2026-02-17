import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Schedule,
  DateRule,
  MonthlyTouPrices,
  BackendStorageCyclesResponse,
  BackendStorageCurvesResponse,
  BackendStorageProfitWithFormulas,
  DischargeStrategy,
} from '../types';
import type { LoadDataPoint } from '../utils';
import { fetchStorageCurves, computeStorageCycles, type StorageParamsPayload } from '../storageApi';
import { EChartTimeSeries } from './EChartTimeSeries';
import { TIER_DEFINITIONS, DISCHARGE_STRATEGY_INFO } from '../constants';

// 复用 ECharts 按需加载逻辑（与 EChartTimeSeries 保持一致）
const loadECharts = (): Promise<any> => {
  return new Promise((resolve, reject) => {
    const w = window as any;
    if (w.echarts) return resolve(w.echarts);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';
    script.async = true;
    script.onload = () => resolve(w.echarts);
    script.onerror = (e) => reject(e);
    document.head.appendChild(script);
  });
};

interface StorageProfitPageProps {
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
    prices: MonthlyTouPrices;
  };
                color: '#000',
  externalCleanedData?: LoadDataPoint[] | null;
  // 预留：可由 StorageCycles 页将最近一次结果透传进来，用于展示年度汇总
  storageCyclesResult?: BackendStorageCyclesResponse | null;
  // 预留：可由 StorageCycles 页透传最近一次请求的 payload，使收益与曲线与其保持一致
  storageCyclesPayload?: StorageParamsPayload | null;
  // 若从 StorageCycles 页触发跳转，可指定日期并通知消费完毕
  selectedDateFromCycles?: string | null;
  onSelectedDateConsumed?: () => void;
  onLatestProfitChange?: (snapshot: {
    payload: StorageParamsPayload | null;
    cyclesResult: BackendStorageCyclesResponse | null;
    curvesData: BackendStorageCurvesResponse | null;
    selectedDate: string | null;
  }) => void;
  restoredProfitRun?: {
    payload: StorageParamsPayload | null;
    cyclesResult: BackendStorageCyclesResponse | null;
    curvesData: BackendStorageCurvesResponse | null;
    selectedDate: string | null;
  } | null;
  restoredVersion?: number;
}

const buildDefaultStoragePayload = (
  scheduleData: StorageProfitPageProps['scheduleData'],
  externalCleanedData?: LoadDataPoint[] | null,
): StorageParamsPayload | null => {
  if (!externalCleanedData || !externalCleanedData.length) {
    return null;
  }

  const sorted = externalCleanedData
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const points = sorted.map((p) => ({
    // 后端 parse_points_series 使用 pandas.to_datetime 解析，ISO8601 字符串可以正确解析
    timestamp: p.timestamp.toISOString(),
    load_kwh: Number(p.load),
  }));

  const storageDefaults: StorageParamsPayload['storage'] = {
    capacity_kwh: 5000,
    c_rate: 0.5,
    single_side_efficiency: 0.92,
    depth_of_discharge: 0.9,
    soc_min: 0.05,
    soc_max: 0.95,
    initial_soc: undefined,
    reserve_charge_kw: 0,
    reserve_discharge_kw: 0,
    metering_mode: 'monthly_demand_max',
    transformer_capacity_kva: 10000,
    transformer_power_factor: 0.9,
    calc_style: 'window_avg',
    energy_formula: 'physics',
    soc_carry_over: false,
    merge_threshold_minutes: 30,
  };

  return {
    storage: storageDefaults,
    strategySource: {
      monthlySchedule: scheduleData.monthlySchedule,
      dateRules: scheduleData.dateRules,
    },
    monthlyTouPrices: scheduleData.prices,
    points,
  };
};

export const StorageProfitPage: React.FC<StorageProfitPageProps> = ({
  scheduleData,
  externalCleanedData,
  storageCyclesResult,
  storageCyclesPayload,
  selectedDateFromCycles,
  onSelectedDateConsumed,
  onLatestProfitChange,
  restoredProfitRun,
  restoredVersion,
}) => {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [curvesData, setCurvesData] = useState<BackendStorageCurvesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 若一开始已有 StorageCycles 页传入的结果，优先复用结果；重新加载时再回落为本页请求
  const [cyclesResult, setCyclesResult] = useState<BackendStorageCyclesResponse | null>(storageCyclesResult ?? null);

  // 如果未透传 StorageCycles 结果，则在本页自动拉取一次 cycles + profit 结果
  useEffect(() => {
    let cancelled = false;

    // 如果已经传入结果，直接使用
    if (storageCyclesResult) {
      setCyclesResult(storageCyclesResult);
      return () => { cancelled = true; };
    }

    const payload = buildDefaultStoragePayload(scheduleData, externalCleanedData);
    if (!payload) {
      setCyclesResult(null);
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const resp = await computeStorageCycles(null, payload);
        if (!cancelled) {
          setCyclesResult(resp);
        }
      } catch (e) {
        // 若无法计算 cycles，本页只展示曲线对比入口，提示用户重新上传或配置
        if (!cancelled) {
          setCyclesResult(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scheduleData, externalCleanedData, storageCyclesResult]);

  // 可选：从 cycles 结果中获取可选日期；否则回退到 externalCleanedData 的日期集合
  const availableDates = useMemo(() => {
    if (cyclesResult?.days?.length) {
      return cyclesResult.days
        .map((d) => d.date)
        .filter(Boolean)
        .sort();
    }
    if (externalCleanedData && externalCleanedData.length) {
      const dateSet = new Set<string>();
      externalCleanedData.forEach((p) => {
        dateSet.add(p.timestamp.toISOString().slice(0, 10));
      });
      return Array.from(dateSet).sort();
    }
    return [];
  }, [cyclesResult, externalCleanedData]);

  // 初始选中第一天
  useEffect(() => {
    if (!selectedDate && availableDates.length > 0) {
      setSelectedDate(availableDates[0]);
    }
  }, [availableDates, selectedDate]);

  // 支持外部跳转指定日期
  useEffect(() => {
    if (selectedDateFromCycles) {
      setSelectedDate(selectedDateFromCycles);
      onSelectedDateConsumed?.();
    }
  }, [selectedDateFromCycles, onSelectedDateConsumed]);

  useEffect(() => {
    if (!restoredVersion) return;
    if (!restoredProfitRun) return;
    setError(null);
    if (restoredProfitRun.cyclesResult) setCyclesResult(restoredProfitRun.cyclesResult);
    setCurvesData(restoredProfitRun.curvesData ?? null);
    if (restoredProfitRun.selectedDate) setSelectedDate(restoredProfitRun.selectedDate);
  }, [restoredVersion, restoredProfitRun]);

  const handleFetchCurves = useCallback(async () => {
    if (!selectedDate) return;
    const payload =
      storageCyclesPayload ?? buildDefaultStoragePayload(scheduleData, externalCleanedData);
    if (!payload) {
      setError('当前没有可用的负荷数据，请先在 Load Analysis 页上传并清洗负荷。');
      return;
    }

    // 添加日志调试
    console.log('[StorageProfitPage] handleFetchCurves payload.storage:', payload.storage);
    console.log('[StorageProfitPage] storageCyclesPayload:', storageCyclesPayload);

    setLoading(true);
    setError(null);
    try {
      const res = await fetchStorageCurves(payload, selectedDate);
      setCurvesData(res);
    } catch (e: any) {
      setCurvesData(null);
      setError(e?.message || '获取储能收益与负荷对比数据失败，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, [externalCleanedData, scheduleData, selectedDate, storageCyclesPayload]);

  useEffect(() => {
    if (!onLatestProfitChange) return;
    const payload = storageCyclesPayload ?? buildDefaultStoragePayload(scheduleData, externalCleanedData);
    onLatestProfitChange({
      payload: payload ?? null,
      cyclesResult,
      curvesData,
      selectedDate,
    });
  }, [onLatestProfitChange, storageCyclesPayload, scheduleData, externalCleanedData, cyclesResult, curvesData, selectedDate]);

  const selectedDayProfitMain: BackendStorageProfitWithFormulas['main'] | null = useMemo(() => {
    if (!cyclesResult || !selectedDate) return null;
    const day = cyclesResult.days.find((d) => d.date === selectedDate);
    return (day?.profit?.main) ?? null;
  }, [cyclesResult, selectedDate]);

  const chartOriginalData = useMemo(() => {
    if (!curvesData) return [];
    return curvesData.points_original.map((pt) => ({
      x: new Date(pt.timestamp),
      y: pt.load_kw,
    }));
  }, [curvesData]);

  const chartWithStorageData = useMemo(() => {
    if (!curvesData) return [];
    return curvesData.points_with_storage.map((pt) => ({
      x: new Date(pt.timestamp),
      y: pt.load_kw,
    }));
  }, [curvesData]);

  const yearProfitMain = cyclesResult?.year?.profit?.main ?? null;

  const monthProfitMain: BackendStorageProfitWithFormulas['main'] | null = useMemo(() => {
    if (!cyclesResult || !selectedDate) return null;
    const ym = selectedDate.slice(0, 7);
    const m = cyclesResult.months.find((it) => it.year_month === ym);
    return (m?.profit?.main) ?? null;
  }, [cyclesResult, selectedDate]);

  // 分时电价维度的电量与电费拆解
  const touRows = useMemo(() => {
    if (!curvesData) return [];
    const summary = curvesData.summary;
    return TIER_DEFINITIONS.map((tier) => {
      const id = tier.id;
      const eOrig = summary.energy_by_tier_original[id] ?? 0;
      const eNew = summary.energy_by_tier_new[id] ?? 0;
      const bOrig = summary.bill_by_tier_original[id] ?? 0;
      const bNew = summary.bill_by_tier_new[id] ?? 0;
      const delta = bOrig - bNew;
      const hasData =
        Math.abs(eOrig) > 1e-6 ||
        Math.abs(eNew) > 1e-6 ||
        Math.abs(bOrig) > 1e-6 ||
        Math.abs(bNew) > 1e-6;
      if (!hasData) return null;
      return {
        id,
        name: tier.name,
        energyOriginal: eOrig,
        energyNew: eNew,
        billOriginal: bOrig,
        billNew: bNew,
        billSaved: delta,
      };
    }).filter((row): row is {
      id: string;
      name: string;
      energyOriginal: number;
      energyNew: number;
      billOriginal: number;
      billNew: number;
      billSaved: number;
    } => row !== null);
  }, [curvesData]);

  // 按月与全年汇总充放电量与收益（主口径）
  const monthlySummaryRows = useMemo(() => {
    if (!cyclesResult) return [];

    const rows: {
      key: string;
      label: string;
      revenue: number;
      cost: number;
      discharge: number;
      charge: number;
      profit: number;
      profitEquiv: number | null;
      profitPerKwh: number | null;
    }[] = [];

    const months = cyclesResult.months ?? [];
    const sorted = [...months].sort((a, b) => {
      const ymA = a.year_month || '';
      const ymB = b.year_month || '';
      const mA = Number.parseInt(
        ymA.length >= 7 ? ymA.slice(5, 7) : '0',
        10,
      );
      const mB = Number.parseInt(
        ymB.length >= 7 ? ymB.slice(5, 7) : '0',
        10,
      );
      return mA - mB;
    });

    sorted.forEach((m, index) => {
      const main = m.profit?.main;
      if (!main) return;
      const ym = m.year_month || '';
      // 优先从 year_month 中截取月份，否则退回到索引 + 1
      const monthPart = ym.length >= 7 ? ym.slice(5, 7) : '';
      const monthNumber = Number.parseInt(monthPart || String(index + 1), 10);
      const label = Number.isFinite(monthNumber)
        ? `${monthNumber}月`
        : ym || `${index + 1}月`;

      const validDays = Number((m as any)?.valid_days ?? 0);
      const yStr = ym.length >= 4 ? ym.slice(0, 4) : '';
      const monthStr = ym.length >= 7 ? ym.slice(5, 7) : '';
      const yearNum = Number.parseInt(yStr || '0', 10);
      const monthNum = Number.parseInt(monthStr || '0', 10);
      const daysInMonth =
        yearNum > 0 && monthNum >= 1 && monthNum <= 12
          ? new Date(yearNum, monthNum, 0).getDate()
          : null;
      const profitVal = main.profit ?? 0;
      const profitEquiv =
        validDays > 0 && daysInMonth != null
          ? (profitVal / validDays) * daysInMonth
          : null;
      rows.push({
        key: ym || String(index + 1),
        label,
        revenue: main.revenue ?? 0,
        cost: main.cost ?? 0,
        discharge: main.discharge_energy_kwh ?? 0,
        charge: main.charge_energy_kwh ?? 0,
        profit: profitVal,
        profitEquiv,
        profitPerKwh:
          main.profit_per_kwh != null ? main.profit_per_kwh : null,
      });
    });

    const yearMain = cyclesResult.year?.profit?.main;
    if (yearMain) {
      const yearLabel = '全年';
      const monthEquivSum = rows
        .filter((r) => r.key !== 'year')
        .reduce((sum, r) => sum + (r.profitEquiv ?? 0), 0);
      const yearHasAnyEquiv = rows.some((r) => r.key !== 'year' && r.profitEquiv != null);
      rows.push({
        key: 'year',
        label: yearLabel,
        revenue: yearMain.revenue ?? 0,
        cost: yearMain.cost ?? 0,
        discharge: yearMain.discharge_energy_kwh ?? 0,
        charge: yearMain.charge_energy_kwh ?? 0,
        profit: yearMain.profit ?? 0,
        profitEquiv: yearHasAnyEquiv ? monthEquivSum : null,
        profitPerKwh:
          yearMain.profit_per_kwh != null ? yearMain.profit_per_kwh : null,
      });
    }

    return rows;
  }, [cyclesResult]);

  const yearProfitEquivYuan: number | null = useMemo(() => {
    const row = monthlySummaryRows.find((r) => r.key === 'year');
    return row?.profitEquiv ?? null;
  }, [monthlySummaryRows]);

  const monthlyChartRows = useMemo(
    () => monthlySummaryRows.filter((row) => row.key !== 'year'),
    [monthlySummaryRows],
  );

  // 在同一张图中展示两条曲线，并支持开关控制显示/隐藏
  const combinedChartRef = useRef<HTMLDivElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(true);
  const [showWithStorage, setShowWithStorage] = useState(true);

  // 月度净收益条形图容器
  const monthlyChartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!curvesData || !combinedChartRef.current) return;

    let disposed = false;
    let chart: any = null;

    loadECharts()
      .then((echarts: any) => {
        if (disposed || !combinedChartRef.current) return;

        chart = echarts.init(combinedChartRef.current);

        const baseSeries: any[] = [];
        if (showOriginal) {
          baseSeries.push({
            name: '原始负荷曲线',
            type: 'line',
            data: chartOriginalData.map(p => [p.x.getTime(), p.y]),
            smooth: true,
            showSymbol: false,
            lineStyle: { color: 'rgb(148,163,184)', width: 1.8 },
            areaStyle: { opacity: 0.08, color: 'rgba(148,163,184,0.35)' },
          });
        }
        if (showWithStorage) {
          baseSeries.push({
            name: '引入储能后的负荷曲线',
            type: 'line',
            data: chartWithStorageData.map(p => [p.x.getTime(), p.y]),
            smooth: true,
            showSymbol: false,
            lineStyle: { color: 'rgb(59,130,246)', width: 1.8 },
            areaStyle: { opacity: 0.10, color: 'rgba(59,130,246,0.35)' },
          });
        }

        const option = {
          tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'line' },
            valueFormatter: (val: any) => (val == null || Number.isNaN(Number(val)) ? '-' : `${Number(val).toFixed(2)} kW`),
          },
          legend: {
            top: 0,
          },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: {
            type: 'time',
            axisLabel: {
              formatter: (value: number) => {
                const d = new Date(value);
                const h = `${d.getHours()}`.padStart(2, '0');
                const m = `${d.getMinutes()}`.padStart(2, '0');
                return `${h}:${m}`;
              },
            },
            axisLine: { lineStyle: { color: '#cbd5f5' } },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value',
            name: 'kW',
            axisLine: { lineStyle: { color: '#cbd5f5' } },
            splitLine: { show: true, lineStyle: { color: '#e5e7eb', type: 'dashed' } },
          },
          series: baseSeries,
        };

        chart.setOption(option, true);
        const onResize = () => {
          try {
            chart && chart.resize();
          } catch {
            // ignore
          }
        };
        window.addEventListener('resize', onResize);
        (chart as any)._cleanup = onResize;
      })
      .catch((e) => {
        console.error('[StorageProfitPage] 加载 ECharts 失败', e);
      });

    return () => {
      disposed = true;
      try {
        const c: any = chart;
        const handler = c?._cleanup;
        if (handler) {
          window.removeEventListener('resize', handler);
        }
        if (c && !c.isDisposed()) c.dispose();
      } catch {
        // ignore
      }
    };
  }, [curvesData, chartOriginalData, chartWithStorageData, showOriginal, showWithStorage]);

  // 月度 revenue / cost / profit 正负条形图
  useEffect(() => {
    if (!monthlyChartRef.current || monthlyChartRows.length === 0) return;

    let disposed = false;
    let chart: any = null;

    loadECharts()
      .then((echarts: any) => {
        if (disposed || !monthlyChartRef.current) return;

        chart = echarts.init(monthlyChartRef.current);

        // 为了让纵坐标从 1 月到 12 月自上而下排列，这里对数组做一次反转
        const categories = monthlyChartRows.map((row) => row.label).reverse();
        const profits = monthlyChartRows.map((row) => row.profit).reverse();
        const revenues = monthlyChartRows.map((row) => row.revenue).reverse();
        const costs = monthlyChartRows.map((row) => -Math.abs(row.cost)).reverse();

        // 依据真实数据自动设置横轴范围，避免成本条形图因固定范围被裁切
        const minNegative = Math.min(0, ...costs, ...profits);
        const maxPositive = Math.max(0, ...revenues, ...profits);
        const span = Math.max(maxPositive - minNegative, 1);
        const pad = span * 0.08;
        const xMin = minNegative - pad;
        const xMax = maxPositive + pad;

        const option = {
          tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            valueFormatter: (val: any) =>
              val == null || Number.isNaN(Number(val))
                ? '-'
                : `${Number(val).toFixed(2)} 元`,
          },
          legend: {
            top: 0,
            data: ['净收益', '收入', '成本'],
          },
          // 调整网格留白，让图表横向更舒展
          grid: { left: 60, right: 40, top: 60, bottom: 60 },
          xAxis: {
            name: '← 成本 (cost)   收入 (revenue)、净收益 (profit) →',
            nameLocation: 'middle',
            nameGap: 28,
            min: xMin,
            max: xMax,
            axisLabel: {
              formatter: (value: number) => `${value} 元`,
            },
            splitLine: {
              show: true,
              lineStyle: { type: 'dashed', color: '#e5e7eb' },
            },
          },
          yAxis: {
            type: 'category',
            axisTick: { show: false },
            data: categories,
            // 调大类目间距，避免条形图上下靠得太紧
            axisLabel: {
              margin: 10,
            },
          },
          series: [
            {
              name: '净收益',
              type: 'bar',
              barWidth: 15,
              barCategoryGap: '80%',
              barGap: '0%',
              label: {
                show: true,
                position: (params: any) => (Number(params?.value || 0) >= 0 ? 'insideRight' : 'insideLeft'),
                formatter: (params: any) =>
                  params.value == null || Number.isNaN(Number(params.value))
                    ? ''
                    : `${Number(params.value).toFixed(0)} 元`,
              },
              emphasis: { focus: 'series' },
              itemStyle: {
                color: (params: any) => (Number(params?.value || 0) >= 0 ? '#22c55e' : '#ef4444'),
              },
              data: profits,
            },
            {
              name: '收入',
              type: 'bar',
              stack: 'Total',
              barWidth: 5,
              barCategoryGap: '80%',
              label: {
                show: true,
                position: 'insideRight',
                color: '#000000',
                formatter: (params: any) =>
                  params.value == null || Number.isNaN(Number(params.value))
                    ? ''
                    : `${Number(params.value).toFixed(0)} 元`,
              },
              emphasis: { focus: 'series' },
              itemStyle: {
                color: '#3b82f6',
              },
              data: revenues,
            },
            {
              name: '成本',
              type: 'bar',
              stack: 'Total',
              barWidth: 5,
              barGap: '0%',
              label: {
                show: true,
                position: 'left',
                formatter: (params: any) =>
                  params.value == null || Number.isNaN(Number(params.value))
                    ? ''
                    : `${Math.abs(Number(params.value)).toFixed(0)} 元`,
              },
              emphasis: { focus: 'series' },
              itemStyle: {
                color: '#ef4444',
              },
              data: costs,
            },
          ],
        };

        chart.setOption(option, true);

        const onResize = () => {
          try {
            chart && chart.resize();
          } catch {
            // ignore
          }
        };
        window.addEventListener('resize', onResize);
        (chart as any)._cleanup = onResize;
      })
      .catch((e: any) => {
        console.error('[StorageProfitPage] 加载月度条形图失败', e);
      });

    return () => {
      disposed = true;
      try {
        const c: any = chart;
        const handler = c?._cleanup;
        if (handler) {
          window.removeEventListener('resize', handler);
        }
        if (c && !c.isDisposed()) c.dispose();
      } catch {
        // ignore
      }
    };
  }, [monthlyChartRows]);

    return (
    <div className="space-y-6">
      <div id="section-profit-intro" className="scroll-mt-24 p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-3">
        <h2 className="text-lg font-semibold text-slate-800">储能收益与负荷对比</h2>
        <p className="text-sm text-slate-600">
          本页基于与储能次数计算相同的 TOU 配置与负荷数据，按日查看"引入储能前后"的负荷曲线与收益指标。
          当前实现使用一组默认的储能参数进行演示，如需与实际项目严格对齐，可在后续迭代中将参数从 StorageCycles 页透传进来。
        </p>
      </div>

      {storageCyclesPayload?.storage && (
        <div id="section-config-snapshot" className="scroll-mt-24 p-4 bg-slate-50 rounded-xl shadow-sm border border-slate-200">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">计算配置快照</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-700">
            <div>
              <span className="text-slate-500">电池容量：</span>
              <span className="font-medium">{storageCyclesPayload.storage.capacity_kwh} kWh</span>
            </div>
            <div>
              <span className="text-slate-500">C倍率：</span>
              <span className="font-medium">{storageCyclesPayload.storage.c_rate}</span>
            </div>
            <div>
              <span className="text-slate-500">充放电效率：</span>
              <span className="font-medium">{((storageCyclesPayload.storage.single_side_efficiency ?? 0) * 100).toFixed(0)}%</span>
            </div>
            <div>
              <span className="text-slate-500">DoD：</span>
              <span className="font-medium">{((storageCyclesPayload.storage.depth_of_discharge ?? 0) * 100).toFixed(0)}%</span>
            </div>
            {storageCyclesPayload.storage.discharge_strategy && (
              <div className="col-span-2 md:col-span-4 pt-2 border-t border-slate-200">
                <span className="text-slate-500">放电策略：</span>
                <span className="font-medium ml-1">
                  {DISCHARGE_STRATEGY_INFO[storageCyclesPayload.storage.discharge_strategy as keyof typeof DISCHARGE_STRATEGY_INFO]?.icon || ''}
                  {' '}
                  {DISCHARGE_STRATEGY_INFO[storageCyclesPayload.storage.discharge_strategy as keyof typeof DISCHARGE_STRATEGY_INFO]?.name || storageCyclesPayload.storage.discharge_strategy}
                </span>
                <span className="text-slate-500 ml-2 text-[11px]">
                  ({DISCHARGE_STRATEGY_INFO[storageCyclesPayload.storage.discharge_strategy as keyof typeof DISCHARGE_STRATEGY_INFO]?.description || ''})
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {(selectedDayProfitMain || monthProfitMain || yearProfitMain) && (
        <div
          id="section-profit-summary"
          className="scroll-mt-24 grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-sm"
        >
          {selectedDayProfitMain && selectedDate && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
              <div className="text-xs text-emerald-700">当日净利润（{selectedDate}）</div>
              <div className="mt-1 text-lg font-semibold text-emerald-800">
                {selectedDayProfitMain.profit.toFixed(2)} 元
              </div>
              <div className="mt-1 text-xs text-emerald-700">
                日度电收益：{selectedDayProfitMain.profit_per_kwh.toFixed(3)} 元/kWh
              </div>
            </div>
          )}
          {monthProfitMain && selectedDate && (
            <div className="p-3 rounded-lg bg-sky-50 border border-sky-100">
              <div className="text-xs text-sky-700">
                当前月份：{selectedDate.slice(0, 7)}
              </div>
              <div className="mt-1 text-lg font-semibold text-sky-800">
                {monthProfitMain.profit.toFixed(2)} 元
              </div>
              <div className="mt-1 text-xs text-sky-700">
                日度电收益：{monthProfitMain.profit_per_kwh.toFixed(3)} 元/kWh
              </div>
            </div>
          )}
          {yearProfitMain && (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
              <div className="text-xs text-slate-700">
                全年净利润（{cyclesResult?.year?.year || ''} 年）
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">
                {yearProfitMain.profit.toFixed(2)} 元
              </div>
              <div className="mt-1 text-xs text-slate-700">
                全年等效净收益（按月外推）：{yearProfitEquivYuan != null ? yearProfitEquivYuan.toFixed(2) : '--'} 元
              </div>
              <div className="mt-1 text-xs text-slate-700">
                日度电收益：{yearProfitMain.profit_per_kwh.toFixed(3)} 元/kWh
              </div>
            </div>
          )}
        </div>
      )}

      {cyclesResult && monthlySummaryRows.length > 0 && (
        <div
          id="section-profit-monthly-summary"
          className="scroll-mt-24 p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-2 text-sm"
        >
          <h3 className="text-sm font-semibold text-slate-800">月度与年度充放电量与收益汇总</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-left text-slate-700">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-2 py-1">月份</th>
                  <th className="px-2 py-1 text-right">放电电量 (kWh)</th>
                  <th className="px-2 py-1 text-right">充电电量 (kWh)</th>
                  <th className="px-2 py-1 text-right">净收益 (元)</th>
                  <th className="px-2 py-1 text-right">等效净收益 (元)</th>
                  <th className="px-2 py-1 text-right">日度电收益 (元/kWh)</th>
                </tr>
              </thead>
              <tbody>
                {monthlySummaryRows.map((row) => (
                  <tr key={row.key} className="border-b border-slate-100 last:border-0">
                    <td className="px-2 py-1">{row.label}</td>
                    <td className="px-2 py-1 text-right">{row.discharge.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{row.charge.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{row.profit.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right">
                      {row.profitEquiv != null ? row.profitEquiv.toFixed(2) : '--'}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {row.profitPerKwh != null ? row.profitPerKwh.toFixed(3) : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs text-slate-500">
              月度净收益正负条形图（绿色为盈利月份，红色为亏损月份）
            </div>
            <div ref={monthlyChartRef} style={{ width: '100%', height: 460 }} />
          </div>

          {monthlyChartRows.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <div className="mb-2 text-xs text-slate-500">
                图表数据明细（用于核对收入/成本/净收益）
              </div>
              <table className="min-w-full text-xs text-left text-slate-700">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-2 py-1">月份</th>
                    <th className="px-2 py-1 text-right">收入 (元)</th>
                    <th className="px-2 py-1 text-right">成本 (元)</th>
                    <th className="px-2 py-1 text-right">净收益 (元)</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyChartRows.map((row) => (
                    <tr key={`chart-${row.key}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-2 py-1">{row.label}</td>
                      <td className="px-2 py-1 text-right text-blue-700">{row.revenue.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right text-red-700">{row.cost.toFixed(2)}</td>
                      <td
                        className={`px-2 py-1 text-right font-medium ${
                          row.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {row.profit.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div id="section-profit-selector" className="scroll-mt-24 p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-700">选择日期：</span>
            <select
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
              value={selectedDate ?? ''}
              onChange={(e) => setSelectedDate(e.target.value || null)}
            >
              {!selectedDate && <option value="">请选择日期</option>}
              {availableDates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm disabled:opacity-50"
              disabled={!selectedDate || loading}
              onClick={handleFetchCurves}
            >
              {loading ? '加载中...' : '获取该日曲线'}
            </button>
          </div>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>

      {curvesData && (
          <div id="section-profit-curves" className="scroll-mt-24 p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-3">
            {/* 小标题与 Toplist 说明 */}
            <div className="mb-2">
              <h3 className="text-base font-semibold text-slate-800">日负荷时序图</h3>
              <div className="text-xs text-slate-500 mb-1">原始负荷与储能后负荷曲线对比，支持切换显示。Toplist：可通过下方分档汇总表查看各分时段电量与电费节省情况。</div>
            </div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">负荷曲线对比（同一张图）</h3>
              <div className="flex items-center gap-3 text-xs text-slate-700">
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={showOriginal}
                    onChange={e => setShowOriginal(e.target.checked)}
                  />
                  <span>原始负荷曲线</span>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={showWithStorage}
                    onChange={e => setShowWithStorage(e.target.checked)}
                  />
                  <span>引入储能后的负荷曲线</span>
                </label>
              </div>
            </div>
            <div ref={combinedChartRef} style={{ width: '100%', height: 260 }} />
          </div>
      )}

      {curvesData && (
        <div id="section-profit-metrics" className="scroll-mt-24 p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-slate-800">当日关键指标</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-slate-500">最大需量（原始）</div>
              <div className="mt-1 font-semibold text-slate-800">
                {Number.isFinite(curvesData.summary.max_demand_original_kw)
                  ? curvesData.summary.max_demand_original_kw.toFixed(1)
                  : '--'} kW
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">最大需量（储能后）</div>
              <div className="mt-1 font-semibold text-slate-800">
                {Number.isFinite(curvesData.summary.max_demand_new_kw)
                  ? curvesData.summary.max_demand_new_kw.toFixed(1)
                  : '--'} kW
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">最大需量降低</div>
              <div className="mt-1 font-semibold text-emerald-700">
                {Number.isFinite(curvesData.summary.max_demand_reduction_kw)
                  ? curvesData.summary.max_demand_reduction_kw.toFixed(1)
                  : '--'} kW{' '}
                (
                  {Number.isFinite(curvesData.summary.max_demand_reduction_ratio)
                    ? (curvesData.summary.max_demand_reduction_ratio * 100).toFixed(1)
                    : '--'}
                  %
                )
              </div>
            </div>
            {curvesData.summary.profit_day_main && (
              <div>
                <div className="text-xs text-slate-500">当日净收益（主口径）</div>
                <div className="mt-1 font-semibold text-emerald-700">
                  {curvesData.summary.profit_day_main.profit.toFixed(2)} 元
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {curvesData && touRows.length > 0 && (
          <div id="section-profit-tou" className="p-4 bg-white rounded-xl shadow-sm border border-slate-200 space-y-2 text-sm">
            {/* Toplist 说明补充 */}
            <div className="mb-2 text-xs text-slate-500">分时电价分档汇总表，展示各分时段原始与储能后电量、电费及节省金额。</div>
            <h3 className="text-sm font-semibold text-slate-800">分时电价分档汇总</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-left text-slate-700">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-2 py-1">分时档位</th>
                  <th className="px-2 py-1 text-right">原始电量 (kWh)</th>
                  <th className="px-2 py-1 text-right">储能后电量 (kWh)</th>
                  <th className="px-2 py-1 text-right">原始电费 (元)</th>
                  <th className="px-2 py-1 text-right">储能后电费 (元)</th>
                  <th className="px-2 py-1 text-right">节省电费 (元)</th>
                </tr>
              </thead>
              <tbody>
                {touRows.map(row => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-2 py-1">{row.name}</td>
                    <td className="px-2 py-1 text-right">{row.energyOriginal.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{row.energyNew.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right">{row.billOriginal.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right">{row.billNew.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right text-emerald-700">
                      {row.billSaved.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
};
