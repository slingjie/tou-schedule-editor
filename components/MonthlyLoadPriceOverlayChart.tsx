import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LoadDataPoint } from '../utils';
import type { Schedule, DateRule, MonthlyTouPrices, PriceMap, TierId, OperatingLogicId } from '../types';
import { useMonthlyHourlyAverages } from '../hooks/useMonthlyHourlyAverages';

// 动态按需加载 ECharts（CDN），与其他图表组件保持一致
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

// TOU 区间背景色（与 PriceStepChart 保持一致）
const TOU_BG: Record<string, string> = {
  '深': 'rgba(16, 185, 129, 0.10)',
  '谷': 'rgba(134, 239, 172, 0.22)',
  '平': 'rgba(148, 163, 184, 0.20)',
  '峰': 'rgba(251, 146, 60, 0.18)',
  '尖': 'rgba(248, 113, 113, 0.18)',
};

interface Props {
  data: LoadDataPoint[]; // 清洗后的小时级负荷序列
  monthlySchedule: Schedule; // 月×24 的默认 TOU 规则
  dateRules: DateRule[]; // 用户自定义日期规则（用于“按日期规则”模式）
  prices: MonthlyTouPrices; // 每月 TOU→价格
  height?: number | string;
}

// 构造 24 小时价格步进序列（按“月默认规则”或“日期规则”）
const buildPriceSeries = (
  mode: 'month' | 'rule',
  idx: number,
  schedule: Schedule,
  rules: DateRule[],
  priceMapMonth: PriceMap
) => {
  const res: Array<{ hour: number; price: number | null; tou: TierId }> = [];
  if (mode === 'month') {
    for (let h = 0; h < 24; h++) {
      const tou = schedule[idx][h].tou as TierId;
      const price = priceMapMonth[tou] ?? null;
      res.push({ hour: h, price, tou });
    }
  } else {
    const rule = rules[idx];
    if (!rule) return res;
    for (let h = 0; h < 24; h++) {
      const tou = rule.schedule[h].tou as TierId;
      const price = priceMapMonth[tou] ?? null;
      res.push({ hour: h, price, tou });
    }
  }
  return res;
};

// 构造 TOU 连续区间以用于 markArea 背景
const buildTouAreas = (hoursTou: TierId[]) => {
  const areas: any[] = [];
  let i = 0;
  while (i < hoursTou.length) {
    const tou = hoursTou[i];
    let j = i + 1;
    while (j < hoursTou.length && hoursTou[j] === tou) j++;
    areas.push([
      { xAxis: String(i), itemStyle: { color: TOU_BG[tou] || 'rgba(0,0,0,0.06)' }, name: tou },
      { xAxis: String(Math.min(j, 24)) },
    ]);
    i = j;
  }
  return areas;
};

// 构造“储能逻辑（充/放/待机）”连续区间，用于以 markArea 的 label 文字标注
const buildOpAreas = (hoursOp: OperatingLogicId[]) => {
  const areas: any[] = [];
  let i = 0;
  while (i < hoursOp.length) {
    const op = hoursOp[i];
    let j = i + 1;
    while (j < hoursOp.length && hoursOp[j] === op) j++;
    // 仅对“充/放”显示标签；“待机”不输出标注
    if (op !== '待机') {
      const span = j - i; // 连续小时数
      const textLabel = op; // 保持原文：充 / 放
      areas.push([
        {
          xAxis: String(i),
          // 使用透明背景，仅展示文字标注
          itemStyle: { color: 'rgba(0,0,0,0)' },
          name: op,
          label: { formatter: textLabel },
        },
        { xAxis: String(Math.min(j, 24)) },
      ]);
    }
    i = j;
  }
  return areas;
};

export const MonthlyLoadPriceOverlayChart: React.FC<Props> = ({ data, monthlySchedule, dateRules, prices, height = 384 }) => {
  // 计算 12×24 的“月度日平均负荷(kW)”
  const { curves, hasData } = useMonthlyHourlyAverages(data);

  // 交互：模式 + 月/规则索引 + 背景开关
  const [viewMode, setViewMode] = useState<'month' | 'rule'>('month');
  const defaultMonth = useMemo(() => Math.max(0, hasData.findIndex(Boolean)), [hasData]);
  const [viewIndex, setViewIndex] = useState<number>(defaultMonth);
  const [showTouBg, setShowTouBg] = useState<boolean>(true); // 默认开启 TOU 背景
  const [showPriceLine, setShowPriceLine] = useState<boolean>(false); // 电价线默认关闭
  const [showOpLabels, setShowOpLabels] = useState<boolean>(true); // 默认显示储能逻辑文字

  // 同步默认月（当 hasData 变化时）
  useEffect(() => {
    if (viewMode === 'month') {
      const d = Math.max(0, hasData.findIndex(Boolean));
      setViewIndex((prev) => (hasData[prev] ? prev : d));
    }
  }, [hasData.join(','), viewMode]);

  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  // 生成 x 轴刻度：使用 0..24 确保最后区间 markArea 正确覆盖（与 PriceStepChart 一致）
  const hours = useMemo(() => Array.from({ length: 25 }, (_, i) => String(i)), []);

  // 根据当前选择生成序列与背景区间
  const pricePoints = useMemo(() => {
    const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
    const priceMap = prices[monthIdx];
    return buildPriceSeries(viewMode, viewIndex, monthlySchedule, dateRules, priceMap);
  }, [viewMode, viewIndex, monthlySchedule, dateRules, prices]);

  const loadPoints = useMemo(() => {
    const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
    const src = curves[monthIdx] || Array.from({ length: 24 }, () => 0);
    // 为匹配 0..24 类目轴，末尾复制最后一个值
    const arr = src.map(v => (Number.isFinite(v) ? Number(v.toFixed(3)) : 0));
    return arr.length > 0 ? [...arr, arr[arr.length - 1]] : [];
  }, [curves, viewIndex]);

  const touAreas = useMemo(() => {
    if (!showTouBg) return [] as any[];
    if (viewMode === 'month') {
      const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
      const hoursTou = monthlySchedule[monthIdx].map(c => c.tou as TierId);
      return buildTouAreas(hoursTou);
    } else {
      const rule = dateRules[viewIndex];
      if (!rule) return [] as any[];
      const hoursTou = rule.schedule.map(c => c.tou as TierId);
      return buildTouAreas(hoursTou);
    }
  }, [showTouBg, viewMode, viewIndex, monthlySchedule, dateRules]);

  // 为储能逻辑生成分段（仅用于显示文字，不改变背景）
  const opAreas = useMemo(() => {
    if (!showOpLabels) return [] as any[];
    if (viewMode === 'month') {
      const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
      const hoursOp = monthlySchedule[monthIdx].map(c => c.op as OperatingLogicId);
      return buildOpAreas(hoursOp);
    } else {
      const rule = dateRules[viewIndex];
      if (!rule) return [] as any[];
      const hoursOp = rule.schedule.map(c => c.op as OperatingLogicId);
      return buildOpAreas(hoursOp);
    }
  }, [showOpLabels, viewMode, viewIndex, monthlySchedule, dateRules]);

  // 初始化与更新图表
  useEffect(() => {
    let echarts: any = null;
    loadECharts().then((ec) => {
      echarts = ec;
      if (!ref.current) return;
      chartRef.current = echarts.init(ref.current);

      const option = {
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            label: {
              formatter: (p: any) => {
                const h = Number(p?.value ?? p?.axisValue ?? 0);
                const hh = String(Math.max(0, Math.min(23, Math.floor(h)))).padStart(2, '0');
                return `${hh}:00`;
              }
            }
          },
          formatter: (params: any[]) => {
            const idx = params?.[0]?.dataIndex ?? 0;
            const h0 = Math.min(idx, 23);
            const hh = String(h0).padStart(2, '0');
            const hourLabel = `${hh}:00`;
            const load = loadPoints[h0] ?? null;
            const price = pricePoints[h0]?.price ?? null;
            const tou = pricePoints[h0]?.tou ?? null;
            const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
            const op = (viewMode === 'month'
              ? monthlySchedule[monthIdx]?.[h0]?.op
              : dateRules[viewIndex]?.schedule?.[h0]?.op) as OperatingLogicId | undefined;
            const loadStr = load == null || Number.isNaN(load) ? '—' : Number(load).toFixed(3) + ' kW';
            const priceStr = price == null || Number.isNaN(Number(price)) ? '—' : Number(price).toFixed(4) + ' 元/kWh';
            const touStr = tou ?? '—';
            const opStr = op ?? '—';
            return `时段：${hourLabel}<br/>TOU：${touStr}<br/>储能：${opStr}<br/>负荷：${loadStr}<br/>电价：${priceStr}`;
          },
        },
        legend: { type: 'plain', top: 0 },
        grid: { left: 48, right: 56, top: 28, bottom: 40 },
        xAxis: {
          type: 'category' as const,
          boundaryGap: false,
          name: '时',
          data: hours,
        },
        yAxis: (
          showPriceLine
            ? [
                { type: 'value' as const, name: '负荷 (kW)', axisLabel: { formatter: (v: number) => `${v}` }, boundaryGap: [0, '5%'] },
                { type: 'value' as const, name: '电价 (元/kWh)', position: 'right' as const, axisLabel: { formatter: (v: number) => `${(v as any)?.toFixed ? (v as any).toFixed(2) : v}` }, boundaryGap: [0, '10%'] },
              ]
            : [
                { type: 'value' as const, name: '负荷 (kW)', axisLabel: { formatter: (v: number) => `${v}` }, boundaryGap: [0, '5%'] },
              ]
        ),
        series: (() => {
          const base = showPriceLine
            ? [
                { name: '月日平均负荷', type: 'line', yAxisIndex: 0, showSymbol: false, smooth: false, sampling: 'lttb', lineStyle: { width: 1.8, color: '#ef4444' }, emphasis: { focus: 'series', lineStyle: { width: 2.2 } }, data: loadPoints },
                { name: '电价', type: 'line', yAxisIndex: 1, step: 'end', showSymbol: false, lineStyle: { width: 2, color: '#2563eb' }, data: pricePoints.length > 0 ? [...pricePoints.map(p => (p.price == null ? null : Number(p.price.toFixed(4)))), pricePoints[pricePoints.length - 1]?.price ?? null] : [], connectNulls: false, markArea: (touAreas && touAreas.length > 0 && showTouBg) ? { silent: true, label: { show: false }, data: touAreas } : undefined },
              ]
            : [
                { name: '月日平均负荷', type: 'line', yAxisIndex: 0, showSymbol: false, smooth: false, sampling: 'lttb', lineStyle: { width: 1.8, color: '#ef4444' }, emphasis: { focus: 'series', lineStyle: { width: 2.2 } }, data: loadPoints, markArea: (touAreas && touAreas.length > 0 && showTouBg) ? { silent: true, label: { show: false }, data: touAreas } : undefined },
              ];
          // 追加“储能逻辑”标注层（仅显示文字，无背景）
          if (opAreas && opAreas.length > 0) {
            base.push({
              name: '储能逻辑',
              type: 'line',
              yAxisIndex: 0,
              showSymbol: false,
              // 该系列不渲染折线，仅承载 markArea
              data: [],
              z: 10,
              markArea: {
                silent: true,
                zlevel: 1,
                label: { show: true, color: '#334155', fontSize: 11, position: 'insideTop', align: 'center' },
                data: opAreas,
              },
            } as any);
          }
          return base;
        })(),
      } as any;

      chartRef.current.setOption(option, true);
      const onResize = () => chartRef.current && chartRef.current.resize();
      window.addEventListener('resize', onResize);
      (chartRef.current as any)._cleanup = () => window.removeEventListener('resize', onResize);
    }).catch((e) => {
      console.error('[MonthlyLoadPriceOverlayChart] 加载 ECharts 失败', e);
    });

    return () => {
      try {
        const c: any = chartRef.current;
        if (c && c._cleanup) c._cleanup();
        if (c && !c.isDisposed()) c.dispose();
      } catch {}
      chartRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变化时刷新图表
  useEffect(() => {
    const c: any = chartRef.current;
    if (!c) return;
    const option = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          label: {
            formatter: (p: any) => {
              const h = Number(p?.value ?? p?.axisValue ?? 0);
              const hh = String(Math.max(0, Math.min(23, Math.floor(h)))).padStart(2, '0');
              return `${hh}:00`;
            }
          }
        },
        formatter: (params: any[]) => {
          const idx = params?.[0]?.dataIndex ?? 0;
          const h0 = Math.min(idx, 23);
          const hh = String(h0).padStart(2, '0');
          const hourLabel = `${hh}:00`;
          const load = loadPoints[h0] ?? null;
          const price = pricePoints[h0]?.price ?? null;
          const tou = pricePoints[h0]?.tou ?? null;
          const monthIdx = Math.min(Math.max(viewIndex, 0), 11);
          const op = (viewMode === 'month'
            ? monthlySchedule[monthIdx]?.[h0]?.op
            : dateRules[viewIndex]?.schedule?.[h0]?.op) as OperatingLogicId | undefined;
          const loadStr = load == null || Number.isNaN(load) ? '—' : Number(load).toFixed(3) + ' kW';
          const priceStr = price == null || Number.isNaN(Number(price)) ? '—' : Number(price).toFixed(4) + ' 元/kWh';
          const touStr = tou ?? '—';
          const opStr = op ?? '—';
          return `时段：${hourLabel}<br/>TOU：${touStr}<br/>储能：${opStr}<br/>负荷：${loadStr}<br/>电价：${priceStr}`;
        },
      },
      legend: { type: 'plain', top: 0 },
      grid: { left: 48, right: 56, top: 28, bottom: 40 },
      xAxis: { type: 'category', boundaryGap: false, name: '时', data: hours },
      yAxis: (
        showPriceLine
          ? [
              { type: 'value', name: '负荷 (kW)', boundaryGap: [0, '5%'] },
              { type: 'value', name: '电价 (元/kWh)', position: 'right', boundaryGap: [0, '10%'], axisLabel: { formatter: (v: number) => `${(v as any)?.toFixed ? (v as any).toFixed(2) : v}` } },
            ]
          : [
              { type: 'value', name: '负荷 (kW)', boundaryGap: [0, '5%'] },
            ]
      ),
      series: (() => {
        const base = showPriceLine
          ? [
              { name: '月日平均负荷', type: 'line', yAxisIndex: 0, showSymbol: false, smooth: false, sampling: 'lttb', lineStyle: { width: 1.8, color: '#ef4444' }, data: loadPoints },
              { name: '电价', type: 'line', yAxisIndex: 1, step: 'end', showSymbol: false, lineStyle: { width: 2, color: '#2563eb' }, data: pricePoints.length > 0 ? [...pricePoints.map(p => (p.price == null ? null : Number(p.price.toFixed(4)))), pricePoints[pricePoints.length - 1]?.price ?? null] : [], connectNulls: false, markArea: (touAreas && touAreas.length > 0 && showTouBg) ? { silent: true, label: { show: false }, data: touAreas } : undefined },
            ]
          : [
              { name: '月日平均负荷', type: 'line', yAxisIndex: 0, showSymbol: false, smooth: false, sampling: 'lttb', lineStyle: { width: 1.8, color: '#ef4444' }, data: loadPoints, markArea: (touAreas && touAreas.length > 0 && showTouBg) ? { silent: true, label: { show: false }, data: touAreas } : undefined },
            ];
        if (opAreas && opAreas.length > 0) {
          base.push({
            name: '储能逻辑',
            type: 'line',
            yAxisIndex: 0,
            showSymbol: false,
            data: [],
            z: 10,
            markArea: {
              silent: true,
              zlevel: 1,
              label: { show: true, color: '#334155', fontSize: 11, position: 'insideTop', align: 'center' },
              data: opAreas,
            },
          } as any);
        }
        return base;
      })(),
    } as any;
    try {
      // 不再主动 clear，直接以 notMerge=true 覆盖完整配置，确保类型等元数据齐全
      c.setOption(option, true);
    } catch (e) {
      console.error('[MonthlyLoadPriceOverlayChart] 更新图表失败', e);
    }
  }, [hours, loadPoints, pricePoints, touAreas, opAreas, showPriceLine, showTouBg]);

  // 控件：展示模式 + 月份/规则 + TOU 背景开关
  return (
    <div className="flex flex-col gap-3">
      {/* 顶部控制区：改为两行布局，第一行显示“展示模式 + 月份/规则选择”，第二行显示开关与 TOU 标签 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-slate-700 flex items-center gap-2">
            <span>展示模式</span>
            <select
              className="border border-slate-300 rounded px-2 py-1 text-sm"
              value={viewMode}
              onChange={(e) => { setViewMode(e.target.value as any); setViewIndex(0); }}
            >
              <option value="month">按月（默认规则）</option>
              <option value="rule">按日期规则</option>
            </select>
          </label>

          {viewMode === 'month' ? (
            <div className="text-sm text-slate-700 flex items-center gap-3">
              <span className="font-medium">月份</span>
              {/* 中文注释：将月份下拉改为 1-12 标签按钮网格，单选模式，便于快速切换 */}
              <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-12 gap-2">
                {Array.from({ length: 12 }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => hasData[i] && setViewIndex(i)}
                    disabled={!hasData[i]}
                    className={
                      'px-2 py-1 rounded-md border text-sm ' +
                      (viewIndex === i
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50') +
                      (!hasData[i] ? ' opacity-50 cursor-not-allowed' : '')
                    }
                    title={hasData[i] ? '' : '无该月数据'}
                  >
                    {i + 1}月
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <label className="text-sm text-slate-700 flex items-center gap-2">
              <span>规则</span>
              <select
                className="border border-slate-300 rounded px-2 py-1 text-sm"
                value={viewIndex}
                onChange={(e) => setViewIndex(Number(e.target.value))}
              >
                {dateRules.length === 0 ? (
                  <option value={0}>无规则</option>
                ) : (
                  dateRules.map((r, i) => (
                    <option key={r.id} value={i}>{r.name}</option>
                  ))
                )}
              </select>
            </label>
          )}
        </div>

        {/* 第二行：开关与 TOU 标签，避免与月份选择同一行过于拥挤 */}
        <div className="flex items-center gap-4 flex-wrap">
          <label className="inline-flex items-center gap-2 select-none cursor-pointer text-sm text-slate-700">
            <input
              type="checkbox"
              className="accent-slate-600"
              checked={showOpLabels}
              onChange={(e) => setShowOpLabels(e.target.checked)}
            />
            <span>显示储能逻辑</span>
          </label>
          <label className="inline-flex items-center gap-2 select-none cursor-pointer text-sm text-slate-700">
            <input
              type="checkbox"
              className="accent-slate-600"
              checked={showPriceLine}
              onChange={(e) => setShowPriceLine(e.target.checked)}
            />
            <span>显示电价线</span>
          </label>
          <label className="inline-flex items-center gap-2 select-none cursor-pointer text-sm text-slate-700">
            <input
              type="checkbox"
              className="accent-slate-600"
              checked={showTouBg}
              onChange={(e) => setShowTouBg(e.target.checked)}
            />
            <span>显示 TOU 背景</span>
          </label>
          {/* TOU 颜色标签（与“TOU Price”页风格一致），放到第二行右侧 */}
          <div className="hidden md:flex items-center gap-3 px-2 py-1 bg-white/90 border border-slate-200 rounded-lg shadow-sm">
            {(['深','谷','平','峰','尖'] as TierId[]).map(t => (
              <span key={t} className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                <span style={{ width: 12, height: 12, borderRadius: 2, background: TOU_BG[t], border: '1px solid rgba(0,0,0,0.15)' }} />
                <span>{t}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div ref={ref} style={{ width: '100%', height }} />
      <p className="text-xs text-slate-500">说明：横轴为 0–23 点（坐标含 24 用于区间闭合）；左轴单位 kW 表示月度“日平均小时负荷”；右轴单位 元/kWh 表示当月电价。电价支持“按月默认规则/按日期规则”模式切换，TOU 背景可开关。</p>
    </div>
  );
};

export default MonthlyLoadPriceOverlayChart;
