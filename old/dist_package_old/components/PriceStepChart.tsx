import React, { useEffect, useRef } from 'react';
import { HOURS } from '../constants';

// 简单阶梯折线图：用于展示 24 小时电价，支持按 TOU 段落着色背景与折线上标注价格
// data: 每小时的数据点；包含小时、价格与TOU档位
export type PricePoint = { hour: number; price: number | null; tou: '深' | '谷' | '平' | '峰' | '尖' };

interface Props {
  data: PricePoint[]; // 长度应为 24
  height?: number | string;
}

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

// TOU 背景色（淡色，用于 markArea）
const TOU_BG: Record<string, string> = {
  '深': 'rgba(16, 185, 129, 0.10)',  // green-500 10%
  '谷': 'rgba(134, 239, 172, 0.22)', // green-300 22%
  '平': 'rgba(148, 163, 184, 0.20)', // slate-400 20%
  '峰': 'rgba(251, 146, 60, 0.18)',  // orange-400 18%
  '尖': 'rgba(248, 113, 113, 0.18)', // red-400 18%
};


export const PriceStepChart: React.FC<Props> = ({ data, height = 360 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const dataRef = useRef<PricePoint[]>(data as any);

  // 持有最新数据引用，供异步初始化时使用
  useEffect(() => { dataRef.current = data as any; }, [data]);

  useEffect(() => {
    let disposed = false;
    let echarts: any = null;
    loadECharts().then((ec) => {
      echarts = ec;
      if (!ref.current) return;
      chartRef.current = echarts.init(ref.current);

      // 使用 0..24 共 25 个刻度，确保最后一个区间(23-24)的 markArea 能正确渲染
      const hours = Array.from({ length: 25 }, (_, i) => String(i));
      const latest = dataRef.current || [];
      const baseSeries = latest.map(d => (d.price == null ? null : Number((d.price as number).toFixed(4))));
      const seriesData = baseSeries.length > 0 ? [...baseSeries, baseSeries[baseSeries.length - 1]] : [];

      // 计算连续同 TOU 的区间用于 markArea
      const areas: Array<any> = [];
      let i = 0;
      while (i < latest.length) {
        const tou = latest[i].tou;
        let j = i + 1;
        while (j < latest.length && latest[j].tou === tou) j++;
        // markArea 以分类轴刻度值表示：从 i 到 j（不包含 j），右边界使用下一个刻度
        areas.push([
          { xAxis: String(i), itemStyle: { color: TOU_BG[tou] || 'rgba(0,0,0,0.06)' }, name: tou },
          { xAxis: String(Math.min(j, 24)) },
        ]);
        i = j;
      }

      const option = {
        tooltip: {
          trigger: 'axis',
          formatter: (params: any[]) => {
            const p = params?.[0];
            const idx = p?.dataIndex ?? 0;
            const refIdx = Math.min(idx, Math.max(0, data.length - 1));
            const pt = data[refIdx];
            const priceVal = p?.value ?? pt?.price ?? null;
            const priceStr = priceVal == null || Number.isNaN(Number(priceVal)) ? '—' : Number(priceVal).toFixed(4) + ' 元/kWh';
            const hourRange = HOURS[Math.min(refIdx, HOURS.length - 1)] || `${refIdx}-${refIdx + 1}`;
            return `时段：${hourRange}<br/>TOU：${pt?.tou ?? '—'}<br/>电价：${priceStr}`;
          },
        },
        grid: { left: 40, right: 24, top: 24, bottom: 36 },
        xAxis: {
          type: 'category',
          data: hours,
          boundaryGap: false,
          name: '小时',
        },
        yAxis: {
          type: 'value',
          name: '元/kWh',
          min: (val: any) => Math.min(0, val.min),
          axisLabel: { formatter: (v: number) => v.toFixed(2) },
        },
        series: [
          {
            name: '电价',
            type: 'line',
            step: 'end',
            data: seriesData,
            connectNulls: false,
            showSymbol: false,
            lineStyle: { width: 2, color: '#2563eb' },
            label: {
              show: true,
              position: 'top',
              formatter: (p: any) => {
                const v = p?.value;
                return (v == null || Number.isNaN(v)) ? '' : Number(v).toFixed(4);
              },
              color: '#334155',
              fontSize: 10,
            },
            markArea: {
              silent: true,
              label: { show: false },
              data: areas,
            },
          },
        ],
      };

      chartRef.current.setOption(option, true);
      const onResize = () => chartRef.current && chartRef.current.resize();
      window.addEventListener('resize', onResize);
      (chartRef.current as any)._cleanup = () => window.removeEventListener('resize', onResize);
    }).catch((e) => {
      console.error('[PriceStepChart] 加载 ECharts 失败', e);
    });

    return () => {
      try {
        const c: any = chartRef.current;
        if (c && c._cleanup) c._cleanup();
        if (c && !c.isDisposed()) c.dispose();
      } catch {}
      chartRef.current = null;
    };
  }, []);

  // 数据更新时刷新图表（不重建实例）
  useEffect(() => {
    const c: any = chartRef.current;
    if (!c) return;

    // 重新计算 series 与 markArea
    // 同上，x 轴使用 0..24；序列在末端补一个点以对齐坐标
    const hours = Array.from({ length: 25 }, (_, i) => String(i));
    const baseSeries = data.map(d => (d.price == null ? null : Number(d.price.toFixed(4))));
    const seriesData = baseSeries.length > 0 ? [...baseSeries, baseSeries[baseSeries.length - 1]] : [];

    const areas: Array<any> = [];
    let i = 0;
    while (i < data.length) {
      const tou = data[i].tou;
      let j = i + 1;
      while (j < data.length && data[j].tou === tou) j++;
      areas.push([
        { xAxis: String(i), itemStyle: { color: TOU_BG[tou] || 'rgba(0,0,0,0.06)' }, name: tou },
        { xAxis: String(Math.min(j, 24)) },
      ]);
      i = j;
    }

    const option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any[]) => {
          const p = params?.[0];
          const idx = p?.dataIndex ?? 0;
          const refIdx = Math.min(idx, Math.max(0, data.length - 1));
          const pt = data[refIdx];
          const priceVal = p?.value ?? pt?.price ?? null;
          const priceStr = priceVal == null || Number.isNaN(Number(priceVal)) ? '—' : Number(priceVal).toFixed(4) + ' 元/kWh';
          const hourRange = HOURS[Math.min(refIdx, HOURS.length - 1)] || `${refIdx}-${refIdx + 1}`;
          return `时段：${hourRange}<br/>TOU：${pt?.tou ?? '—'}<br/>电价：${priceStr}`;
        },
      },
      grid: { left: 40, right: 24, top: 24, bottom: 36 },
      xAxis: { type: 'category', data: hours, boundaryGap: false, name: '小时' },
      yAxis: { type: 'value', name: '元/kWh', min: (val: any) => Math.min(0, val.min), axisLabel: { formatter: (v: number) => v.toFixed(2) } },
      series: [{
        name: '电价',
        type: 'line',
        step: 'end',
        data: seriesData,
        connectNulls: false,
        showSymbol: false,
        lineStyle: { width: 2, color: '#2563eb' },
        label: {
          show: true,
          position: 'top',
          formatter: (p: any) => {
            const v = p?.value;
            return (v == null || Number.isNaN(v)) ? '' : Number(v).toFixed(4);
          },
          color: '#334155',
          fontSize: 10,
        },
        markArea: {
          silent: true,
          label: { show: false },
          data: areas,
        },
      }],
    } as any;

    try {
      // 强制完整刷新以避免部分状态未合并
      c.clear();
      c.setOption(option, true);
    } catch (e) {
      console.error('[PriceStepChart] 更新图表失败', e);
    }
  }, [data]);

  return <div ref={ref} style={{ width: '100%', height }} />;
};

export default PriceStepChart;
