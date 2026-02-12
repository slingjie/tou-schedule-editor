/**
 * 储能经济性测算页面
 * 
 * 功能：
 * - 输入首年收益、项目年限、运维成本、衰减率、投资成本等参数
 * - 计算并展示 IRR、静态回收期、年度现金流序列
 * - 提供年度现金流表格和图表可视化
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { StorageEconomicsInput, StorageEconomicsResult, YearlyCashflowItem, StaticEconomicsMetrics } from '../types';
import { computeStorageEconomics, exportEconomicsCashflowReport, BASE_URL } from '../storageApi';

// 动态加载 ECharts（CDN），避免本地依赖
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

// ==================== 默认参数配置 ====================
const DEFAULT_PROJECT_YEARS = 15;
const DEFAULT_FIRST_YEAR_DECAY_RATE = 0.03; // 首年衰减率 3%
const DEFAULT_SUBSEQUENT_DECAY_RATE = 0.02; // 后续年份衰减率 2%
const DEFAULT_CAPEX_PER_WH = 1.0; // 元/Wh
const DEFAULT_OM_COST_RATIO = 0.015; // 运维成本占 CAPEX 的比例

// IRR 判定阈值
const IRR_THRESHOLDS = {
  acceptable: 0.08,  // 8%
  good: 0.10,        // 10%
  excellent: 0.12,   // 12%
};

// ==================== 内置柱状折线混合图表组件 ====================
interface ChartSeries {
  name: string;
  data: number[];
  color: string;
  lineStyle?: 'solid' | 'dashed';
}

interface CashflowChartProps {
  xAxisData: string[];
  series: ChartSeries[];
  yAxisName?: string;
  height?: number;
  markLineY?: number;
  markLineName?: string;
}

const CashflowChart: React.FC<CashflowChartProps> = ({
  xAxisData,
  series,
  yAxisName = '',
  height = 250,
  markLineY,
  markLineName,
}) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    loadECharts().then((echarts: any) => {
      if (disposed || !chartRef.current) return;
      if (!instanceRef.current) {
        instanceRef.current = echarts.init(chartRef.current);
      }
      const chart = instanceRef.current;

      const option = {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params: any) => {
            const list = Array.isArray(params) ? params : [params];
            const xLabel = list[0]?.axisValue ?? '';
            const lines = list.map((p: any) => {
              const val = p.value;
              const num = Number(val);
              // 格式化为万元
              const valStr = Number.isFinite(num) 
                ? (Math.abs(num) >= 10000 ? `${(num / 10000).toFixed(2)} 万元` : `${num.toFixed(2)} 元`)
                : String(val ?? '');
              return `${p.marker}${p.seriesName}: ${valStr}`;
            });
            return `${xLabel}<br/>${lines.join('<br/>')}`;
          },
        },
        legend: {
          data: series.map(s => s.name),
          bottom: 0,
          textStyle: { fontSize: 11 },
        },
        grid: { left: 50, right: 20, top: 20, bottom: 40 },
        xAxis: {
          type: 'category',
          data: xAxisData,
          axisLabel: { fontSize: 10 },
        },
        yAxis: {
          type: 'value',
          name: yAxisName,
          nameTextStyle: { fontSize: 10 },
          axisLabel: {
            fontSize: 10,
            formatter: (v: number) => {
              if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(0)}万`;
              return v.toFixed(0);
            },
          },
        },
        series: series.map((s, idx) => ({
          name: s.name,
          type: 'line',
          data: s.data,
          smooth: false,
          showSymbol: true,
          symbolSize: 5,
          itemStyle: { color: s.color },
          lineStyle: {
            width: 2,
            type: s.lineStyle === 'dashed' ? 'dashed' : 'solid',
          },
          markLine: markLineY !== undefined && idx === 0 ? {
            silent: true,
            symbol: ['none', 'none'],
            lineStyle: { type: 'dashed', color: '#999' },
            data: [{ yAxis: markLineY, name: markLineName || '' }],
            label: { show: false },
          } : undefined,
        })),
      };

      chart.setOption(option, true);
    });

    const handleResize = () => {
      if (instanceRef.current) instanceRef.current.resize();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      // 注意：不在这里销毁 chart，以避免组件重渲染时闪烁
    };
  }, [xAxisData, series, yAxisName, height, markLineY, markLineName]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
};

// ==================== 工具函数 ====================
const formatCurrency = (value: number): string => {
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(2)} 万元`;
  }
  return `${value.toFixed(2)} 元`;
};

const formatPercent = (value: number | null): string => {
  if (value === null) return 'N/A';
  return `${(value * 100).toFixed(2)}%`;
};

const formatYears = (value: number | null): string => {
  if (value === null) return '超出项目周期';
  return `${value.toFixed(2)} 年`;
};

// 评估 IRR 等级
const evaluateIRR = (irr: number | null): { level: string; color: string; description: string } => {
  if (irr === null) {
    return { level: '无法计算', color: 'text-gray-500', description: '项目在评估期内无法获得正收益' };
  }
  if (irr >= IRR_THRESHOLDS.excellent) {
    return { level: '优秀', color: 'text-green-600', description: '经济性优秀，建议投资' };
  }
  if (irr >= IRR_THRESHOLDS.good) {
    return { level: '较好', color: 'text-blue-600', description: '经济性较好，值得考虑' };
  }
  if (irr >= IRR_THRESHOLDS.acceptable) {
    return { level: '可接受', color: 'text-yellow-600', description: '经济性基本可接受' };
  }
  return { level: '较差', color: 'text-red-600', description: '经济性较差，需谨慎评估' };
};

// 评估静态回收期
const evaluatePayback = (payback: number | null, projectYears: number): { level: string; color: string } => {
  if (payback === null) {
    return { level: '超出项目周期', color: 'text-red-600' };
  }
  const threshold = projectYears / 2;
  if (payback <= threshold) {
    return { level: '合理', color: 'text-green-600' };
  }
  if (payback <= projectYears * 0.7) {
    return { level: '偏长', color: 'text-yellow-600' };
  }
  return { level: '过长', color: 'text-red-600' };
};

// ==================== 组件 Props ====================
interface StorageEconomicsPageProps {
  // 从 StorageProfitPage 或 StorageCyclesPage 传入的首年收益（可选）
  externalFirstYearRevenue?: number | null;
  // 从储能配置传入的容量（可选）
  externalCapacityKwh?: number | null;
  // 从 Storage Cycles 传入的首年发电能量，单位：kWh（可选）
  externalFirstYearEnergyKwh?: number | null;
  onLatestEconomicsChange?: (snapshot: {
    input: StorageEconomicsInput;
    result: StorageEconomicsResult;
    userSharePercent: number;
  }) => void;
  restoredEconomicsRun?: { input: StorageEconomicsInput; result: StorageEconomicsResult; userSharePercent: number } | null;
  restoredVersion?: number;
}

// ==================== 主组件 ====================
export const StorageEconomicsPage: React.FC<StorageEconomicsPageProps> = ({
  externalFirstYearRevenue,
  externalCapacityKwh,
  externalFirstYearEnergyKwh,
  onLatestEconomicsChange,
  restoredEconomicsRun,
  restoredVersion,
}) => {
  // ==================== 表单状态 ====================
  const [firstYearRevenue, setFirstYearRevenue] = useState<string>(
    externalFirstYearRevenue ? String(externalFirstYearRevenue) : ''
  );
  const [firstYearEnergyKwh, setFirstYearEnergyKwh] = useState<string>(
    externalFirstYearEnergyKwh ? String(externalFirstYearEnergyKwh) : ''
  );
  // 用户收益分成比例（%），0 表示项目方拿 100%，30 表示项目方拿 70%
  const [userSharePercent, setUserSharePercent] = useState<string>('');
  const [projectYears, setProjectYears] = useState<string>(String(DEFAULT_PROJECT_YEARS));
  const [annualOmCost, setAnnualOmCost] = useState<string>('0.2');// 年运维成本单位成本（元/Wh）
  const [firstYearDecayRate, setFirstYearDecayRate] = useState<string>(String(DEFAULT_FIRST_YEAR_DECAY_RATE * 100));
  const [subsequentDecayRate, setSubsequentDecayRate] = useState<string>(String(DEFAULT_SUBSEQUENT_DECAY_RATE * 100));
  const [capexPerWh, setCapexPerWh] = useState<string>(String(DEFAULT_CAPEX_PER_WH));
  const [installedCapacityKwh, setInstalledCapacityKwh] = useState<string>(
    externalCapacityKwh ? String(externalCapacityKwh) : ''
  );
  const [cellReplacementCost, setCellReplacementCost] = useState<string>('0.3');// 更换电芯成本单位成本（元/Wh）
  const [cellReplacementYear, setCellReplacementYear] = useState<string>('9');// 更换电芯时间（第 N 年）

  // ==================== 计算状态 ====================
  const [isCalculating, setIsCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StorageEconomicsResult | null>(null);
  // 按年度保存放电量（kWh），用于“年度现金流明细”展示
  const [yearlyDischargeEnergyKwh, setYearlyDischargeEnergyKwh] = useState<number[] | null>(null);

  // ==================== 同步外部传入的值 ====================
  useEffect(() => {
    if (externalFirstYearRevenue !== undefined && externalFirstYearRevenue !== null) {
      setFirstYearRevenue(String(externalFirstYearRevenue));
    }
  }, [externalFirstYearRevenue]);

  useEffect(() => {
    if (externalCapacityKwh !== undefined && externalCapacityKwh !== null) {
      setInstalledCapacityKwh(String(externalCapacityKwh));
    }
  }, [externalCapacityKwh]);

  useEffect(() => {
    if (externalFirstYearEnergyKwh !== undefined && externalFirstYearEnergyKwh !== null) {
      setFirstYearEnergyKwh(String(externalFirstYearEnergyKwh));
    }
  }, [externalFirstYearEnergyKwh]);

  useEffect(() => {
    if (!restoredVersion) return;
    if (!restoredEconomicsRun?.input || !restoredEconomicsRun?.result) return;
    setError(null);

    const input = restoredEconomicsRun.input;
    const share = Number(restoredEconomicsRun.userSharePercent ?? 0);
    setUserSharePercent(String(Number.isFinite(share) ? share : 0));

    // 将 projectFirstYearRevenue 还原回“未分成前”的首年净收益展示值
    const projectRev = Number(input.first_year_revenue ?? 0);
    const denom = 1 - (Number.isFinite(share) ? share : 0) / 100;
    const totalRev = denom > 0 ? (projectRev / denom) : projectRev;
    setFirstYearRevenue(String(totalRev));

    if (input.first_year_energy_kwh != null) setFirstYearEnergyKwh(String(input.first_year_energy_kwh));
    setProjectYears(String(input.project_years ?? DEFAULT_PROJECT_YEARS));
    setAnnualOmCost(String(input.annual_om_cost ?? 0));
    setFirstYearDecayRate(String((Number(input.first_year_decay_rate ?? DEFAULT_FIRST_YEAR_DECAY_RATE) * 100).toFixed(2)));
    setSubsequentDecayRate(String((Number(input.subsequent_decay_rate ?? DEFAULT_SUBSEQUENT_DECAY_RATE) * 100).toFixed(2)));
    setCapexPerWh(String(input.capex_per_wh ?? DEFAULT_CAPEX_PER_WH));
    setInstalledCapacityKwh(String(input.installed_capacity_kwh ?? ''));
    if (input.cell_replacement_cost != null) setCellReplacementCost(String(input.cell_replacement_cost));
    if (input.cell_replacement_year != null) setCellReplacementYear(String(input.cell_replacement_year));

    setResult(restoredEconomicsRun.result);

    // 复用页面现有逻辑，重建 yearlyDischargeEnergyKwh（用于表格显示）
    const parsedFirstYearEnergyKwh = input.first_year_energy_kwh ?? null;
    const parsedProjectYears = Number(input.project_years ?? 0);
    const parsedFirstYearDecayRate = Number(input.first_year_decay_rate ?? 0);
    const parsedSubsequentDecayRate = Number(input.subsequent_decay_rate ?? 0);
    const parsedCellReplacementYear = input.cell_replacement_year ?? null;
    if (parsedFirstYearEnergyKwh != null && parsedFirstYearEnergyKwh > 0 && parsedProjectYears > 0) {
      const energySeries: number[] = [];
      let currentBaseEnergy = parsedFirstYearEnergyKwh;
      let phaseStartYear = 1;
      for (let yearIndex = 1; yearIndex <= parsedProjectYears; yearIndex += 1) {
        if (parsedCellReplacementYear && yearIndex === parsedCellReplacementYear) {
          currentBaseEnergy = parsedFirstYearEnergyKwh;
          phaseStartYear = yearIndex;
        }
        const yearsInPhase = yearIndex - phaseStartYear;
        const energyThisYear =
          currentBaseEnergy *
          (1 - parsedFirstYearDecayRate) *
          Math.pow(1 - parsedSubsequentDecayRate, yearsInPhase);
        energySeries.push(energyThisYear);
      }
      setYearlyDischargeEnergyKwh(energySeries);
    } else {
      setYearlyDischargeEnergyKwh(null);
    }
  }, [restoredVersion, restoredEconomicsRun]);

  // ==================== 表单验证 ====================
  const isFormValid = useMemo(() => {
    const revenue = parseFloat(firstYearRevenue);
    const years = parseInt(projectYears, 10);
    const capex = parseFloat(capexPerWh);
    const capacity = parseFloat(installedCapacityKwh);
    const share = userSharePercent === '' ? 0 : parseFloat(userSharePercent);
    
    return (
      !isNaN(revenue) && revenue > 0 &&
      !isNaN(years) && years >= 1 && years <= 30 &&
      !isNaN(capex) && capex > 0 &&
      !isNaN(capacity) && capacity > 0 &&
      !isNaN(share) && share >= 0 && share <= 100
    );
  }, [firstYearRevenue, projectYears, capexPerWh, installedCapacityKwh, userSharePercent]);

  // ==================== 提交计算 ====================
  const handleCalculate = useCallback(async () => {
    if (!isFormValid) return;

    setIsCalculating(true);
    setError(null);

    try {
      const parsedFirstYearRevenue = parseFloat(firstYearRevenue);
      const parsedUserSharePercent = userSharePercent === '' ? 0 : parseFloat(userSharePercent);
      const normalizedShare = Number.isFinite(parsedUserSharePercent) ? Math.min(Math.max(parsedUserSharePercent, 0), 100) : 0;

      if (normalizedShare > 100 || normalizedShare < 0) {
        setError('用户分成比例需在 0–100 之间');
        return;
      }

      const parsedFirstYearEnergyKwh = firstYearEnergyKwh ? parseFloat(firstYearEnergyKwh) : null;
      const parsedProjectYears = parseInt(projectYears, 10);
      const parsedAnnualOmCost = annualOmCost ? parseFloat(annualOmCost) : 0;
      const parsedFirstYearDecayRate = parseFloat(firstYearDecayRate) / 100;
      const parsedSubsequentDecayRate = parseFloat(subsequentDecayRate) / 100;
      const parsedCapexPerWh = parseFloat(capexPerWh);
      const parsedInstalledCapacityKwh = parseFloat(installedCapacityKwh);
      const parsedCellReplacementCost = cellReplacementCost ? parseFloat(cellReplacementCost) : null;
      const parsedCellReplacementYear = cellReplacementYear ? parseInt(cellReplacementYear, 10) : null;

      // 将 Storage Cycles 的“首年总净收益”按分成比例折算为“项目方首年净收益”
      const projectFirstYearRevenue = parsedFirstYearRevenue * (1 - normalizedShare / 100);

      const input: StorageEconomicsInput = {
        first_year_revenue: projectFirstYearRevenue,
        first_year_energy_kwh: parsedFirstYearEnergyKwh,
        project_years: parsedProjectYears,
        annual_om_cost: parsedAnnualOmCost,
        first_year_decay_rate: parsedFirstYearDecayRate,
        subsequent_decay_rate: parsedSubsequentDecayRate,
        capex_per_wh: parsedCapexPerWh,
        installed_capacity_kwh: parsedInstalledCapacityKwh,
        cell_replacement_cost: parsedCellReplacementCost,
        cell_replacement_year: parsedCellReplacementYear,
      };

      const response = await computeStorageEconomics(input);
      setResult(response);
      onLatestEconomicsChange?.({ input, result: response, userSharePercent: normalizedShare });

      // 计算运营期内各年的放电量（kWh），用于“年度现金流明细”展示
      // 规则与后端收益衰减模型保持一致：
      // - 按阶段计算（初始阶段 + 换电芯后阶段）
      // - 每个阶段：第 1 年无衰减，第 2 年按首年衰减率，第 3 年及以后按后续衰减率
      if (parsedFirstYearEnergyKwh != null && parsedFirstYearEnergyKwh > 0 && parsedProjectYears > 0) {
        const energySeries: number[] = [];
        let currentBaseEnergy = parsedFirstYearEnergyKwh;
        let phaseStartYear = 1;

        for (let yearIndex = 1; yearIndex <= parsedProjectYears; yearIndex += 1) {
          // 换电芯年份视为新阶段首年：放电量重置为首年水平
          if (parsedCellReplacementYear && yearIndex === parsedCellReplacementYear) {
            currentBaseEnergy = parsedFirstYearEnergyKwh;
            phaseStartYear = yearIndex;
          }

          const yearsInPhase = yearIndex - phaseStartYear; // 0 表示阶段首年
          const energyThisYear =
            currentBaseEnergy *
            (1 - parsedFirstYearDecayRate) *
            Math.pow(1 - parsedSubsequentDecayRate, yearsInPhase);

          energySeries.push(energyThisYear);
        }

        setYearlyDischargeEnergyKwh(energySeries);
      } else {
        setYearlyDischargeEnergyKwh(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '计算失败，请稍后重试');
    } finally {
      setIsCalculating(false);
    }
  }, [
    isFormValid,
    firstYearRevenue,
    userSharePercent,
    firstYearEnergyKwh,
    projectYears,
    annualOmCost,
    firstYearDecayRate,
    subsequentDecayRate,
    capexPerWh,
    installedCapacityKwh,
    cellReplacementCost,
    cellReplacementYear,
    onLatestEconomicsChange,
  ]);

  // ==================== 导出报表 ====================
  const [isExporting, setIsExporting] = useState(false);

  const handleExportReport = useCallback(async () => {
    if (!isFormValid) return;

    setIsExporting(true);
    setError(null);

    try {
      const parsedFirstYearRevenue = parseFloat(firstYearRevenue);
      const parsedUserSharePercent = userSharePercent === '' ? 0 : parseFloat(userSharePercent);
      const normalizedShare = Number.isFinite(parsedUserSharePercent) ? Math.min(Math.max(parsedUserSharePercent, 0), 100) : 0;
      const parsedFirstYearEnergyKwh = firstYearEnergyKwh ? parseFloat(firstYearEnergyKwh) : null;
      const parsedProjectYears = parseInt(projectYears, 10);
      const parsedAnnualOmCost = annualOmCost ? parseFloat(annualOmCost) : 0;
      const parsedFirstYearDecayRate = parseFloat(firstYearDecayRate) / 100;
      const parsedSubsequentDecayRate = parseFloat(subsequentDecayRate) / 100;
      const parsedCapexPerWh = parseFloat(capexPerWh);
      const parsedInstalledCapacityKwh = parseFloat(installedCapacityKwh);
      const parsedCellReplacementCost = cellReplacementCost ? parseFloat(cellReplacementCost) : null;
      const parsedCellReplacementYear = cellReplacementYear ? parseInt(cellReplacementYear, 10) : null;

      // 将 Storage Cycles 的"首年总净收益"按分成比例折算为"项目方首年净收益"
      const projectFirstYearRevenue = parsedFirstYearRevenue * (1 - normalizedShare / 100);

      const input: StorageEconomicsInput = {
        first_year_revenue: projectFirstYearRevenue,
        project_years: parsedProjectYears,
        annual_om_cost: parsedAnnualOmCost,
        first_year_decay_rate: parsedFirstYearDecayRate,
        subsequent_decay_rate: parsedSubsequentDecayRate,
        capex_per_wh: parsedCapexPerWh,
        installed_capacity_kwh: parsedInstalledCapacityKwh,
      };
      
      // 可选参数：只在有值时添加
      if (parsedFirstYearEnergyKwh !== null && parsedFirstYearEnergyKwh > 0) {
        input.first_year_energy_kwh = parsedFirstYearEnergyKwh;
      }
      if (parsedCellReplacementCost !== null && parsedCellReplacementCost > 0) {
        input.cell_replacement_cost = parsedCellReplacementCost;
      }
      if (parsedCellReplacementYear !== null && parsedCellReplacementYear > 0) {
        input.cell_replacement_year = parsedCellReplacementYear;
      }

      const response = await exportEconomicsCashflowReport(input, normalizedShare);

      if (response.file_content_base64) {
        const bin = atob(response.file_content_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) {
          bytes[i] = bin.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: response.mime_type || 'text/csv;charset=utf-8' });
        const fileName = response.file_name || response.excel_path || 'economics_cashflow.csv';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        console.log(`[StorageEconomicsPage] 报表导出成功(base64): ${fileName}`);
      } else if (response.excel_path) {
        // 向后兼容：后端返回 outputs 相对路径
        const downloadUrl = `${BASE_URL}/outputs/${response.excel_path}`;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = response.excel_path;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log(`[StorageEconomicsPage] 报表导出成功(path): ${downloadUrl}`);
      } else {
        throw new Error(response.message || '后端未返回可下载报表内容');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '报表导出失败，请稍后重试');
    } finally {
      setIsExporting(false);
    }
  }, [
    isFormValid,
    firstYearRevenue,
    userSharePercent,
    firstYearEnergyKwh,
    projectYears,
    annualOmCost,
    firstYearDecayRate,
    subsequentDecayRate,
    capexPerWh,
    installedCapacityKwh,
    cellReplacementCost,
    cellReplacementYear,
  ]);

  // ==================== 图表数据 ====================
  const chartData = useMemo(() => {
    if (!result) return null;

    const years = result.yearly_cashflows.map(cf => `第${cf.year_index}年`);
    // 项目方年度收益（已按分成比例折算后的口径）
    const projectRevenues = result.yearly_cashflows.map(cf => cf.year_revenue);
    const netCashflows = result.yearly_cashflows.map(cf => cf.net_cashflow);
    const cumulativeCashflows = result.yearly_cashflows.map(cf => cf.cumulative_net_cashflow);

    // 额外派生：原年度总收益 & 用户方年度收益（仅用于图表展示）
    let totalRevenues: number[] | null = null;
    let userRevenues: number[] | null = null;

    const parsedFirstYearRevenue = parseFloat(firstYearRevenue);
    const parsedProjectYears = parseInt(projectYears, 10);
    const parsedFirstYearDecayRate = parseFloat(firstYearDecayRate) / 100;
    const parsedSubsequentDecayRate = parseFloat(subsequentDecayRate) / 100;
    const parsedCellReplacementYear = cellReplacementYear ? parseInt(cellReplacementYear, 10) : null;
    const parsedUserSharePercent = userSharePercent === '' ? 0 : parseFloat(userSharePercent);
    const shareRatio = Number.isFinite(parsedUserSharePercent)
      ? Math.min(Math.max(parsedUserSharePercent, 0), 100) / 100
      : 0;

    if (
      Number.isFinite(parsedFirstYearRevenue) &&
      parsedFirstYearRevenue > 0 &&
      Number.isFinite(parsedProjectYears) &&
      parsedProjectYears > 0
    ) {
      totalRevenues = [];
      let currentBaseRevenue = parsedFirstYearRevenue;
      let phaseStartYear = 1;

      for (let yearIndex = 1; yearIndex <= parsedProjectYears; yearIndex += 1) {
        // 换电芯年份视为新阶段首年：收益基准重置为首年总净收益
        if (parsedCellReplacementYear && yearIndex === parsedCellReplacementYear) {
          currentBaseRevenue = parsedFirstYearRevenue;
          phaseStartYear = yearIndex;
        }

        const yearsInPhase = yearIndex - phaseStartYear; // 0 表示阶段首年
        const yearRevenueTotal =
          currentBaseRevenue *
          (1 - parsedFirstYearDecayRate) *
          Math.pow(1 - parsedSubsequentDecayRate, yearsInPhase);

        totalRevenues.push(yearRevenueTotal);
      }

      userRevenues = totalRevenues.map(v => v * shareRatio);
    }

    return {
      years,
      projectRevenues,
      totalRevenues,
      userRevenues,
      netCashflows,
      cumulativeCashflows,
    };
  }, [
    result,
    firstYearRevenue,
    projectYears,
    firstYearDecayRate,
    subsequentDecayRate,
    cellReplacementYear,
    userSharePercent,
  ]);

  // 基于首年放电量在前端派生一份静态经济性指标，避免后端未正确使用能量数据时仍显示 1.0 元/kWh
  const derivedStaticMetrics: StaticEconomicsMetrics | null = useMemo(() => {
    if (!result || !result.static_metrics) return null;

    const m = result.static_metrics;

    const parsedFirstYearEnergyKwh = firstYearEnergyKwh ? parseFloat(firstYearEnergyKwh) : null;
    const parsedProjectYears = parseInt(projectYears, 10);
    const parsedFirstYearDecayRate = parseFloat(firstYearDecayRate) / 100;
    const parsedSubsequentDecayRate = parseFloat(subsequentDecayRate) / 100;

    if (
      parsedFirstYearEnergyKwh == null ||
      !Number.isFinite(parsedFirstYearEnergyKwh) ||
      parsedFirstYearEnergyKwh <= 0 ||
      !Number.isFinite(parsedProjectYears) ||
      parsedProjectYears <= 0
    ) {
      return m;
    }

    let totalEnergy = 0;
    let energyCurrent = parsedFirstYearEnergyKwh * (1 - parsedFirstYearDecayRate); // 首年即包含首年衰减
    for (let yearIndex = 1; yearIndex <= parsedProjectYears; yearIndex += 1) {
      totalEnergy += energyCurrent;
      energyCurrent *= (1 - parsedSubsequentDecayRate);
    }
    const annualEnergyLocal = totalEnergy / parsedProjectYears;
    if (!Number.isFinite(annualEnergyLocal) || annualEnergyLocal <= 0) return m;

    const annualRevenueLocal = m.annual_revenue_yuan;
    const revenuePerKwhLocal = annualRevenueLocal / annualEnergyLocal;
    const staticLcoeLocal = result.capex_total / (annualEnergyLocal * parsedProjectYears);
    const lcoeRatioLocal = staticLcoeLocal > 0 ? revenuePerKwhLocal / staticLcoeLocal : 0;
    const threshold = m.pass_threshold ?? 1.5;
    const screeningResultLocal = lcoeRatioLocal >= threshold ? 'pass' : 'fail';

    return {
      ...m,
      static_lcoe: parseFloat(staticLcoeLocal.toFixed(4)),
      annual_energy_kwh: parseFloat(annualEnergyLocal.toFixed(2)),
      annual_revenue_yuan: parseFloat(annualRevenueLocal.toFixed(2)),
      revenue_per_kwh: parseFloat(revenuePerKwhLocal.toFixed(4)),
      lcoe_ratio: parseFloat(lcoeRatioLocal.toFixed(4)),
      pass_threshold: threshold,
      screening_result: screeningResultLocal,
    };
  }, [result, firstYearEnergyKwh, projectYears, firstYearDecayRate, subsequentDecayRate]);

  // ==================== 渲染 ====================
  return (
    <div className="space-y-6">
      {/* 页面标题和说明 */}
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">储能经济性测算</h2>
        <p className="text-slate-600 text-sm">
          基于首年收益、项目年限、运维成本、衰减率等参数，计算储能项目的 IRR（内部收益率）和静态回收期，
          并生成年度现金流序列，帮助评估项目经济性。
        </p>
      </div>

      {/* 输入表单 */}
      <div id="section-economics-form" className="bg-white rounded-xl shadow-lg p-6 scroll-mt-24">
        <h3 className="text-lg font-semibold text-slate-800 mb-4">参数配置</h3>
        
        {/* 数据来源提示 */}
        {(externalFirstYearRevenue != null || externalCapacityKwh != null || externalFirstYearEnergyKwh != null) ? (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm text-green-800">
              <span className="font-semibold">✓ 已自动填入 Storage Cycles 测算数据：</span>
              {externalFirstYearRevenue != null && ` 首年收益（全年等效净收益，按月外推） ${externalFirstYearRevenue.toLocaleString()} 元`}
              {externalFirstYearRevenue != null && externalCapacityKwh != null && '，'}
              {externalCapacityKwh != null && ` 储能容量 ${externalCapacityKwh} kWh`}
              {(externalFirstYearRevenue != null || externalCapacityKwh != null) && externalFirstYearEnergyKwh != null && '，'}
              {externalFirstYearEnergyKwh != null && ` 首年放电量 ${externalFirstYearEnergyKwh.toLocaleString()} kWh`}
            </p>
          </div>
        ) : (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-800">
              💡 <span className="font-semibold">提示：</span>
              前往 <span className="font-medium">Storage Cycles</span> 页面完成测算后，首年收益、储能容量与首年放电量将自动填入此处。
            </p>
          </div>
        )}
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* 首年收益 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              首年收益（元）<span className="text-red-500">*</span>
              {externalFirstYearRevenue != null && (
                <span className="ml-2 text-xs text-green-600 font-normal">✓ 来自 Storage Cycles</span>
              )}
            </label>
            <input
              type="number"
              value={firstYearRevenue}
              onChange={(e) => setFirstYearRevenue(e.target.value)}
              placeholder="输入首年收益"
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                externalFirstYearRevenue != null ? 'border-green-400 bg-green-50' : 'border-slate-300'
              }`}
            />
            <p className="text-xs text-slate-500 mt-1">
              {externalFirstYearRevenue != null 
                ? '已自动填入 Storage Cycles 的全年等效净收益（按月外推，已扣充电费、未扣运维）'
                : '已扣除充电电费、未扣运维成本'}
            </p>
          </div>

          {/* 储能容量 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              储能容量（kWh）<span className="text-red-500">*</span>
              {externalCapacityKwh != null && (
                <span className="ml-2 text-xs text-green-600 font-normal">✓ 来自 Storage Cycles</span>
              )}
            </label>
            <input
              type="number"
              value={installedCapacityKwh}
              onChange={(e) => setInstalledCapacityKwh(e.target.value)}
              placeholder="输入储能容量"
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                externalCapacityKwh != null ? 'border-green-400 bg-green-50' : 'border-slate-300'
              }`}
            />
            {externalCapacityKwh != null && (
              <p className="text-xs text-green-600 mt-1">已自动填入 Storage Cycles 配置的容量</p>
            )}
          </div>

          {/* 首年放电量 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              首年放电量（kWh）
              {externalFirstYearEnergyKwh != null && (
                <span className="ml-2 text-xs text-green-600 font-normal">✓ 来自 Storage Cycles</span>
              )}
            </label>
            <input
              type="number"
              value={firstYearEnergyKwh}
              onChange={(e) => setFirstYearEnergyKwh(e.target.value)}
              placeholder="可选，推荐从 Storage Cycles 自动填入"
              className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                externalFirstYearEnergyKwh != null ? 'border-green-400 bg-green-50' : 'border-slate-300'
              }`}
            />
            <p className="text-xs text-slate-500 mt-1">
              若留空，将使用简化估算，度电平均收益可能显示为 1.0 元/kWh。
            </p>
          </div>

          {/* 用户收益分成比例 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              用户收益分成比例（%）
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={userSharePercent}
              onChange={(e) => setUserSharePercent(e.target.value)}
              placeholder="例如 30 表示用户拿 30%"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">
              项目方首年净收益 = 首年总净收益 × (1 - 分成比例)。
              {userSharePercent !== '' && parseFloat(userSharePercent) === 100 && (
                <span className="block text-red-600 mt-1">
                  分成比例为 100% 时，项目方无收益，IRR 不具意义。
                </span>
              )}
            </p>
          </div>

          {/* 单 Wh 投资 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              单 Wh 投资（元/Wh）<span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              value={capexPerWh}
              onChange={(e) => setCapexPerWh(e.target.value)}
              placeholder="如 0.8"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">建议范围 0.6–1.2 元/Wh</p>
          </div>

          {/* 项目年限 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              项目年限（年）<span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min="1"
              max="30"
              value={projectYears}
              onChange={(e) => setProjectYears(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">建议 10–20 年</p>
          </div>

          {/* 首年衰减率 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              首年衰减率（%）
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="20"
              value={firstYearDecayRate}
              onChange={(e) => setFirstYearDecayRate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">建议 2%–5%，第1年到第2年的衰减</p>
          </div>

          {/* 后续年份衰减率 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              后续衰减率（%）
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="10"
              value={subsequentDecayRate}
              onChange={(e) => setSubsequentDecayRate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-500 mt-1">建议 1%–2%，第2年起每年衰减</p>
          </div>

          {/* 年运维成本 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              年运维成本单位成本（元/Wh）
            </label>
            <input
              type="number"
              step="0.01"
              value={annualOmCost}
              onChange={(e) => setAnnualOmCost(e.target.value)}
              placeholder="例如 0.2 元/Wh"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {installedCapacityKwh && parseFloat(installedCapacityKwh) > 0 && parseFloat(annualOmCost || '0') > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                实际年运维成本：{((parseFloat(annualOmCost) * parseFloat(installedCapacityKwh)) / 10).toFixed(2)}万元
              </p>
            )}
          </div>

          {/* 更换电芯时间 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              更换电芯时间（第 N 年）
            </label>
            <input
              type="number"
              min="1"
              value={cellReplacementYear}
              onChange={(e) => setCellReplacementYear(e.target.value)}
              placeholder="可选，如第 10 年"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* 更换电芯成本 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              更换电芯成本单位成本（元/Wh）
            </label>
            <input
              type="number"
              step="0.01"
              value={cellReplacementCost}
              onChange={(e) => setCellReplacementCost(e.target.value)}
              placeholder="例如 1.5 元/Wh（可选）"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {installedCapacityKwh && parseFloat(installedCapacityKwh) > 0 && parseFloat(cellReplacementCost || '0') > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                实际更换成本：{((parseFloat(cellReplacementCost) * parseFloat(installedCapacityKwh)) / 10).toFixed(2)}万元
              </p>
            )}
            <p className="text-xs text-slate-500 mt-1">更换当年计入一次性成本</p>
          </div>
        </div>

        {/* 计算按钮 */}
        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={handleCalculate}
            disabled={!isFormValid || isCalculating}
            className={`px-6 py-2 rounded-md font-semibold text-white transition-colors ${
              isFormValid && !isCalculating
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-slate-400 cursor-not-allowed'
            }`}
          >
            {isCalculating ? '计算中...' : '开始测算'}
          </button>
          <button
            onClick={handleExportReport}
            disabled={!isFormValid || isExporting}
            className={`px-6 py-2 rounded-md font-semibold text-white transition-colors ${
              isFormValid && !isExporting
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-slate-400 cursor-not-allowed'
            }`}
          >
            {isExporting ? '导出中...' : '导出经济性报表'}
          </button>
          {error && <span className="text-red-600 text-sm">{error}</span>}
        </div>
      </div>

      {/* 计算结果 */}
      {result && (
        <>
          {/* 第一步：静态快速筛选卡片 */}
          {derivedStaticMetrics && (
            <div id="section-economics-screening" className="scroll-mt-24">
              <div className={`rounded-xl shadow-lg p-6 ${
                derivedStaticMetrics.screening_result === 'pass' 
                  ? 'bg-gradient-to-r from-green-50 to-emerald-50 border-2 border-green-300' 
                  : 'bg-gradient-to-r from-red-50 to-rose-50 border-2 border-red-300'
              }`}>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="text-lg font-bold mb-3">
                      {derivedStaticMetrics.screening_result === 'pass' 
                        ? '✓ 第一步：快速筛选通过' 
                        : '✗ 第一步：快速筛选未通过'}
                    </h3>
                    <p className={`text-sm mb-4 ${
                      derivedStaticMetrics.screening_result === 'pass'
                        ? 'text-green-700'
                        : 'text-red-700'
                    }`}>
                      {derivedStaticMetrics.screening_result === 'pass'
                        ? '项目经济性指标达到初步可行标准，值得进行详细的 IRR 和现金流分析。'
                        : '项目经济性指标未达到初步可行标准，建议重新评估装机容量、价格或成本等参数。'}
                    </p>
                    {/* 口径说明 Toplist */}
                    <ul className="text-xs text-slate-600 mb-3 list-disc list-inside space-y-1">
                      <li>首年总净收益来源：Storage Cycles 首年收益（页面顶部“首年收益”输入框）。</li>
                      <li>用户收益分成比例：由“用户收益分成比例（%）”配置，用户拿分成，其余为项目方收益。</li>
                      <li>本卡片中的“年均收益”和“度电平均收益”均为项目方分成后的净收益口径，已按 (1 - 分成比例) 折算。</li>
                    </ul>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white bg-opacity-60 rounded-lg p-3">
                        <div className="text-xs text-slate-600 mb-1">静态 LCOE</div>
                        <div className="text-lg font-semibold text-slate-800">
                          {derivedStaticMetrics.static_lcoe.toFixed(4)} 元/kWh
                        </div>
                      </div>
                      <div className="bg-white bg-opacity-60 rounded-lg p-3">
                        <div className="text-xs text-slate-600 mb-1">度电平均收益</div>
                        <div className="text-lg font-semibold text-slate-800">
                          {derivedStaticMetrics.revenue_per_kwh.toFixed(4)} 元/kWh
                        </div>
                      </div>
                      <div className="bg-white bg-opacity-60 rounded-lg p-3">
                        <div className="text-xs text-slate-600 mb-1">年均收益</div>
                        <div className="text-lg font-semibold text-slate-800">
                          {(derivedStaticMetrics.annual_revenue_yuan / 10000).toFixed(2)} 万元
                        </div>
                      </div>
                      <div className={`rounded-lg p-3 ${
                        derivedStaticMetrics.screening_result === 'pass'
                          ? 'bg-green-200 bg-opacity-70'
                          : 'bg-red-200 bg-opacity-70'
                      }`}>
                        <div className="text-xs font-semibold mb-1">经济可行性</div>
                        <div className={`text-lg font-bold ${
                          result.static_metrics.screening_result === 'pass'
                            ? 'text-green-700'
                            : 'text-red-700'
                        }`}>
                          {result.static_metrics.lcoe_ratio.toFixed(2)} 倍
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500 mt-3">
                      快速筛选逻辑：若度电收益 / LCOE ≥ {result.static_metrics.pass_threshold} 则通过，下阶段进行详细 IRR 评估。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 第二步：详细经济性评估指标卡片 */}
          <div id="section-economics-kpi" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 scroll-mt-24">
            {/* 总投资 CAPEX */}
            <div className="bg-white rounded-xl shadow-lg p-4">
              <div className="text-sm text-slate-500 mb-1">总投资 CAPEX</div>
              <div className="text-2xl font-bold text-slate-800">
                {formatCurrency(result.capex_total)}
              </div>
            </div>

            {/* IRR */}
            <div className="bg-white rounded-xl shadow-lg p-4">
              <div className="text-sm text-slate-500 mb-1">项目 IRR</div>
              <div className={`text-2xl font-bold ${evaluateIRR(result.irr).color}`}>
                {formatPercent(result.irr)}
              </div>
              <div className={`text-xs mt-1 ${evaluateIRR(result.irr).color}`}>
                {evaluateIRR(result.irr).level}：{evaluateIRR(result.irr).description}
              </div>
            </div>

            {/* 静态回收期 */}
            <div className="bg-white rounded-xl shadow-lg p-4">
              <div className="text-sm text-slate-500 mb-1">静态回收期</div>
              <div className={`text-2xl font-bold ${evaluatePayback(result.static_payback_years, parseInt(projectYears, 10)).color}`}>
                {formatYears(result.static_payback_years)}
              </div>
              <div className={`text-xs mt-1 ${evaluatePayback(result.static_payback_years, parseInt(projectYears, 10)).color}`}>
                {evaluatePayback(result.static_payback_years, parseInt(projectYears, 10)).level}
                {result.static_payback_years && result.static_payback_years <= parseInt(projectYears, 10) / 2 && '（小于项目年限一半）'}
              </div>
            </div>

            {/* 期末累计净现金流 */}
            <div className="bg-white rounded-xl shadow-lg p-4">
              <div className="text-sm text-slate-500 mb-1">期末累计净现金流</div>
              <div className={`text-2xl font-bold ${result.final_cumulative_net_cashflow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(result.final_cumulative_net_cashflow)}
              </div>
            </div>
          </div>

          {/* 年度现金流图表 */}
          {chartData && (
            <div id="section-economics-chart" className="bg-white rounded-xl shadow-lg p-6 scroll-mt-24">
              <h3 className="text-lg font-semibold text-slate-800 mb-4">年度现金流趋势</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 年度收益与净现金流 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-600 mb-2">年度收益 vs 净现金流</h4>
                  <CashflowChart
                    xAxisData={chartData.years}
                    series={[
                      // 原年度总收益（未分成口径）
                      chartData.totalRevenues
                        ? { name: '原年度总收益', data: chartData.totalRevenues, color: '#6B7280' }
                        : { name: '项目方年度收益', data: chartData.projectRevenues, color: '#3B82F6' },
                      // 项目方年度收益（分成后）
                      chartData.totalRevenues
                        ? { name: '项目方年度收益', data: chartData.projectRevenues, color: '#3B82F6' }
                        : undefined,
                      // 用户方年度收益
                      chartData.userRevenues
                        ? { name: '用户方年度收益', data: chartData.userRevenues, color: '#F59E0B', lineStyle: 'dashed' }
                        : undefined,
                      { name: '年度净现金流', data: chartData.netCashflows, color: '#10B981' },
                    ].filter(Boolean) as ChartSeries[]}
                    yAxisName="金额（元）"
                    height={250}
                  />
                </div>

                {/* 累计净现金流 */}
                <div>
                  <h4 className="text-sm font-medium text-slate-600 mb-2">累计净现金流</h4>
                  <CashflowChart
                    xAxisData={chartData.years}
                    series={[
                      { name: '累计净现金流', data: chartData.cumulativeCashflows, color: '#8B5CF6' },
                      { 
                        name: '投资回本线', 
                        data: chartData.years.map(() => result.capex_total), 
                        color: '#EF4444',
                        lineStyle: 'dashed',
                      },
                    ]}
                    yAxisName="金额（元）"
                    height={250}
                    markLineY={0}
                    markLineName="零线"
                  />
                </div>
              </div>
            </div>
          )}

          {/* 年度现金流明细表 */}
          <div id="section-economics-table" className="bg-white rounded-xl shadow-lg p-6 scroll-mt-24">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">年度现金流明细</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">年份</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">原年度总收益</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">用户方年度收益</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">项目方年度收益</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">储能放电量（kWh）</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">运维成本</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">电芯更换</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">净现金流</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">累计净现金流</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-200">
                  {result.yearly_cashflows.map((cf) => {
                    const isPaybackYear = result.static_payback_years !== null &&
                      cf.year_index === Math.ceil(result.static_payback_years);
                    const yearEnergy = yearlyDischargeEnergyKwh?.[cf.year_index - 1];
                    const totalRevenue = chartData?.totalRevenues?.[cf.year_index - 1] ?? null;
                    const userRevenue = chartData?.userRevenues?.[cf.year_index - 1] ?? null;
                    return (
                      <tr key={cf.year_index} className={isPaybackYear ? 'bg-green-50' : ''}>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-slate-900">
                          第 {cf.year_index} 年
                          {isPaybackYear && <span className="ml-2 text-xs text-green-600">← 回本</span>}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {totalRevenue != null ? formatCurrency(totalRevenue) : '-'}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {userRevenue != null ? formatCurrency(userRevenue) : '-'}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {formatCurrency(cf.year_revenue)}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {yearEnergy != null ? `${yearEnergy.toFixed(2)} kWh` : '-'}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {formatCurrency(cf.annual_om_cost)}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-slate-600">
                          {cf.cell_replacement_cost > 0 ? formatCurrency(cf.cell_replacement_cost) : '-'}
                        </td>
                        <td className={`px-4 py-2 whitespace-nowrap text-sm text-right font-medium ${cf.net_cashflow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {formatCurrency(cf.net_cashflow)}
                        </td>
                        <td className={`px-4 py-2 whitespace-nowrap text-sm text-right font-medium ${cf.cumulative_net_cashflow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {formatCurrency(cf.cumulative_net_cashflow)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 投资建议 */}
          <div id="section-economics-conclusion" className="bg-white rounded-xl shadow-lg p-6 scroll-mt-24">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">投资评估结论</h3>
            <div className={`p-4 rounded-lg ${
              result.irr !== null && result.irr >= IRR_THRESHOLDS.acceptable
                ? 'bg-green-50 border border-green-200'
                : 'bg-yellow-50 border border-yellow-200'
            }`}>
              {result.irr !== null && result.irr >= IRR_THRESHOLDS.acceptable ? (
                <div className="text-green-800">
                  <p className="font-semibold mb-2">✅ 经济性评估：{evaluateIRR(result.irr).level}</p>
                  <ul className="text-sm space-y-1 list-disc list-inside">
                    <li>项目 IRR 为 {formatPercent(result.irr)}，{result.irr >= IRR_THRESHOLDS.good ? '高于' : '达到'}目标收益率 8%</li>
                    {result.static_payback_years && result.static_payback_years <= parseInt(projectYears, 10) / 2 && (
                      <li>静态回收期 {formatYears(result.static_payback_years)}，小于项目年限一半，回本风险可控</li>
                    )}
                    <li>项目期末累计净现金流 {formatCurrency(result.final_cumulative_net_cashflow)}</li>
                  </ul>
                </div>
              ) : (
                <div className="text-yellow-800">
                  <p className="font-semibold mb-2">⚠️ 经济性评估：{evaluateIRR(result.irr).level}</p>
                  <ul className="text-sm space-y-1 list-disc list-inside">
                    <li>项目 IRR 为 {formatPercent(result.irr)}，低于目标收益率 8%，需谨慎评估</li>
                    <li>建议重新评估电价策略、运维成本或投资成本等假设条件</li>
                    {result.static_payback_years === null && (
                      <li>项目在评估期内无法回本，投资风险较高</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-4">
              注：本测算结果基于简化模型，未考虑税收、折旧、融资等因素。正式投决建议基于完整财务模型进行复核。
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default StorageEconomicsPage;
