import React, { useEffect, useRef, useState } from 'react';
import type { LoadDataPoint } from '../utils';
import { useYearlyHourlyAverages } from '../hooks/useYearlyHourlyAverages';

// 中文注释：
// 动态按需加载 ECharts（通过 CDN），与其他图表组件保持一致，避免额外依赖
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

type Props = {
  // 小时级清洗后的负荷数据（kWh/h ~ kW）
  data: LoadDataPoint[];
  height?: number | string;
};

export const YearlyAverageStackedChart: React.FC<Props> = ({ data, height = 360 }) => {
  const { curve } = useYearlyHourlyAverages(data);
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const [showEndLabel, setShowEndLabel] = useState<boolean>(true);

  useEffect(() => {
    if (!ref.current) return;

    loadECharts()
      .then((echarts) => {
        if (!ref.current) return;
        // 复用实例或初始化
        if (!chartRef.current) {
          chartRef.current = echarts.init(ref.current);
        }

        const hours = Array.from({ length: 24 }, (_, i) => `${i}`);
        const endLabelEnabled = !!showEndLabel;

        const series = [
          {
            type: 'line',
            name: '全年',
            smooth: true,
            symbol: 'none',
            sampling: 'lttb',
            lineStyle: { width: 2.2 },
            areaStyle: { opacity: 0.15 }, // 面积填充以体现“堆叠/面积”视觉
            stack: '年度', // 虽为单序列，设置 stack 不影响显示，便于后续扩展
            endLabel: endLabelEnabled
              ? {
                  show: true,
                  formatter: (p: any) => `全年 ${p.value?.[1]?.toFixed?.(2) ?? ''} kW`,
                  distance: 6,
                }
              : undefined,
            emphasis: { focus: 'series', lineStyle: { width: 2.6 } },
            data: curve.map((v, h) => [hours[h], Number.isFinite(v) ? Number(v.toFixed(3)) : 0]),
          },
        ];

        const option = {
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
              const list = Array.isArray(params) ? params : [params];
              const idx = list?.[0]?.dataIndex ?? 0;
              const h = Math.max(0, Math.min(23, Number(idx)));
              const hh = String(h).padStart(2, '0');
              const lines = list.map((p: any) => {
                const val = Array.isArray(p?.value) ? p.value[1] : p?.value;
                const num = Number(val);
                const valStr = Number.isFinite(num) ? `${num.toFixed(3)} kW` : String(val ?? '');
                return `${p.marker}${p.seriesName}: ${valStr}`;
              });
              return `${hh}:00<br/>${lines.join('<br/>')}`;
            },
          },
          legend: { top: 0 },
          grid: { left: 50, right: 24, top: 40, bottom: 40 },
          xAxis: {
            type: 'category',
            name: '时',
            boundaryGap: false,
            data: hours,
          },
          yAxis: {
            type: 'value',
            name: '负荷 (kW)',
            nameGap: 12,
          },
          series,
        } as any;

        chartRef.current.setOption(option, true);

        const onResize = () => chartRef.current && chartRef.current.resize();
        window.addEventListener('resize', onResize);
        (chartRef.current as any)._cleanup = () => window.removeEventListener('resize', onResize);
      })
      .catch((e) => {
        console.error('[YearlyAverageStackedChart] 加载 ECharts 失败', e);
      });

    return () => {
      try {
        const c: any = chartRef.current;
        if (c && c._cleanup) c._cleanup();
        if (c && !c.isDisposed()) c.dispose();
      } catch {}
      chartRef.current = null;
    };
  }, [curve.join(','), showEndLabel]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm text-slate-700">
        <label className="inline-flex items-center gap-2 select-none cursor-pointer">
          <input
            type="checkbox"
            className="accent-slate-600"
            checked={showEndLabel}
            onChange={(e) => setShowEndLabel(e.target.checked)}
          />
          <span>显示末端标签</span>
        </label>
      </div>
      <div ref={ref} style={{ width: '100%', height }} />
      <p className="text-xs text-slate-500">说明：横轴为 0–23 点；纵轴单位为 kW（小时平均功率）。本图展示全年日平均小时负荷曲线，便于与月度图对比全年用能峰谷特征。</p>
    </div>
  );
};

export default YearlyAverageStackedChart;
