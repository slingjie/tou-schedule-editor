import React, { useEffect, useRef } from 'react';

type Point = { x: Date; y: number };

interface Props {
  data: Point[];
  height?: number | string;
  lineColor?: string;
  showArea?: boolean;
  // 是否启用断轴（用于突出显示缺失区间）
  useAxisBreak?: boolean;
  // 是否在断轴虚线上方显示人类可读的时间标签（默认关闭，避免噪声）
  showBreakLabels?: boolean;
  onReady?: (api: { resetZoom: () => void; getInstance: () => any }) => void;
}

// 动态加载 ECharts（通过 CDN），避免安装依赖
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

export const EChartTimeSeries: React.FC<Props> = ({ data, height = 384, lineColor = 'rgb(59,130,246)', showArea = false, useAxisBreak = true, showBreakLabels = false, onReady }) => {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    let echarts: any = null;
    loadECharts()
      .then((ec: any) => {
        echarts = ec;
        console.log(`[EChartTimeSeries] ECharts 版本: ${echarts.version}`);
        if (!ref.current) return;
        chartRef.current = echarts.init(ref.current);

        // 1) 数据预处理：排序 + 只保留合法点
        const points = data
          .filter(p => p && p.x instanceof Date && !Number.isNaN(p.x.getTime()) && Number.isFinite(p.y))
          .sort((a, b) => a.x.getTime() - b.x.getTime())
          .map(p => [p.x.getTime(), p.y]);

        // 2) 基于相邻时间差推断采样步长（分钟级），并据此生成断轴 breaks
        //    规则：当相邻两点间隔 > 1.5 * 推断步长，则认为中间存在缺失区间，将其折叠（gap: 0）
        const toMinute = (ms: number) => Math.max(1, Math.round(ms / 60000));
        const deltas = [] as number[];
        for (let i = 1; i < points.length; i++) {
          const d = (points[i][0] as number) - (points[i - 1][0] as number);
          if (d > 0) deltas.push(d);
        }
        const estimateStepMs = (() => {
          if (deltas.length === 0) return 60 * 60000; // 默认按 1 小时
          // 取"众数（分钟）"再还原为毫秒，避免少量异常点干扰
          const freq = new Map<number, number>();
          for (const d of deltas) {
            const m = toMinute(d);
            freq.set(m, (freq.get(m) || 0) + 1);
          }
          let bestM = 60, bestC = -1;
          for (const [m, c] of freq.entries()) {
            if (c > bestC) { bestC = c; bestM = m; }
          }
          const result = bestM * 60000;
          console.log(`[EChartTimeSeries] 数据点数: ${points.length}, 推断采样步长: ${bestM}分钟 (出现${bestC}次)`);
          return result;
        })();

        const breaks: Array<{ startValue: number; endValue: number; gap?: number }> = [];
        if (useAxisBreak && points.length > 1) {
          const threshold = estimateStepMs * 1.5;
          console.log(`[EChartTimeSeries] 启用断轴，阈值: ${(threshold / 60000).toFixed(1)}分钟`);
          for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1][0] as number;
            const curr = points[i][0] as number;
            const gap = curr - prev;
            if (gap > threshold) {
              // break 的区间应该是：从前一个点结束，到当前点开始
              // 为了让 ECharts 能正确渲染，设置 startValue 和 endValue
              const startValue = prev;  // 前一个数据点的时间
              const endValue = curr;    // 当前数据点的时间（之前的所有点都缺失了）
              breaks.push({ startValue, endValue, gap: 0 });
              const gapMinutes = (gap / 60000).toFixed(1);
              console.log(`[EChartTimeSeries] 检测到缺失: ${new Date(startValue).toLocaleString()} ~ ${new Date(endValue).toLocaleString()} (间隔${gapMinutes}分钟)`);
            }
          }
          console.log(`[EChartTimeSeries] 共检测到 ${breaks.length} 个缺失区间`);
          if (breaks.length > 0) {
            console.log(`[EChartTimeSeries] breaks 数组内容:`, JSON.stringify(breaks.slice(0, 2), null, 2));
          }
        }

        // 2.1) 构造带“断开点”的数据，确保曲线不会跨越缺失区间直接连线
        const seriesData: Array<[number, number | null]> = [];
        if (points.length > 0) {
          seriesData.push(points[0] as [number, number]);
          for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1][0] as number;
            const curr = points[i][0] as number;
            if (useAxisBreak && curr - prev > estimateStepMs * 1.5) {
              // 在缺口处插入一个空值点，强制折线在此断开
              seriesData.push([prev + 1, null]);
            }
            seriesData.push(points[i] as [number, number]);
          }
        }
        const nullBreakCount = seriesData.filter(p => p[1] === null).length;
        if (useAxisBreak) {
          console.log(`[EChartTimeSeries] 已插入断开点(空值)数量: ${nullBreakCount}`);
        }

        // 2.2) 计算标签摆放的 y 值（靠近顶部，保证可见）
        const yValues = points.map(p => p[1] as number).filter((v) => Number.isFinite(v));
        const yMax = yValues.length ? Math.max(...yValues) : 1;
        const labelY = yMax * 0.98;
        const labelData: Array<{ value: [number, number] }> = showBreakLabels && useAxisBreak
          ? breaks.flatMap(b => ([{ value: [b.startValue, labelY] }, { value: [b.endValue, labelY] }]))
          : [];

        // 3) 图表配置（启用断轴）
        const option = {
          backgroundColor: 'transparent',
          // 提示框与十字准星：统一到“分钟”精度，确保展示原始15分钟数据点
          tooltip: {
            trigger: 'axis',
            axisPointer: {
              type: 'cross',
              snap: true,
              label: {
                formatter: (p: any) => {
                  const v = p?.value ?? p?.axisValue;
                  try { return (echarts?.time?.format ? echarts.time.format(v, '{MM}-{dd} {HH}:{mm}') : new Date(v).toLocaleString()); }
                  catch { return new Date(v).toLocaleString(); }
                }
              }
            },
            formatter: (params: any) => {
              const list = Array.isArray(params) ? params : [params];
              const ts = list[0]?.axisValue ?? list[0]?.value?.[0];
              const timeStr = (() => {
                try { return (echarts?.time?.format ? echarts.time.format(ts, '{yyyy}-{MM}-{dd} {HH}:{mm}') : new Date(ts).toLocaleString()); }
                catch { return new Date(ts).toLocaleString(); }
              })();
              const lines = list.map((p: any) => {
                const val = Array.isArray(p?.value) ? p.value[1] : p?.value;
                const num = Number(val);
                const valStr = Number.isFinite(num) ? num.toFixed(3) : String(val ?? '');
                return `${p.marker}${p.seriesName}: ${valStr}`;
              });
              return `${timeStr}<br/>${lines.join('<br/>')}`;
            }
          },
          grid: { left: 40, right: 20, top: 20, bottom: 80 },
          // 时间轴（不使用 ECharts 内置 breaks，采用显式断开 + 标记方案）
          xAxis: {
            type: 'time',
            boundaryGap: false,
            // 最小间隔使用推断步长（如15分钟），避免坐标轴过度聚合
            minInterval: estimateStepMs,
            axisLabel: {
              hideOverlap: true,
              formatter: (value: number) => {
                try { return echarts?.time?.format ? echarts.time.format(value, '{MM}-{dd} {HH}:{mm}') : new Date(value).toLocaleString(); }
                catch { return new Date(value).toLocaleString(); }
              }
            }
          },
          yAxis: { type: 'value', boundaryGap: [0, '5%'] },
          dataZoom: [
            { type: 'inside', filterMode: 'none' },
            { type: 'slider', height: 22, bottom: 40, showDetail: false }
          ],
          series: [
            {
              // 单位按原始文件口径为功率kW
              name: '负荷 (kW)',
              type: 'line',
              showSymbol: false,
              smooth: false,
              connectNulls: false,
              // 若为细粒度(<=15min)数据，关闭下采样以保证悬浮提示精度
              sampling: estimateStepMs <= 15 * 60 * 1000 ? undefined as any : 'lttb',
              itemStyle: { color: lineColor },
              lineStyle: { width: 1.5 },
              areaStyle: showArea ? { opacity: 0.25 } : undefined,
              data: seriesData,
              // 缺失区间的可视化标记：阴影区域 + 两侧虚线
              markArea: useAxisBreak && breaks.length > 0 ? {
                silent: true,
                label: { show: false },
                emphasis: { disabled: true },
                itemStyle: { color: 'rgba(0,0,0,0.06)', borderColor: '#999', borderWidth: 1, borderType: 'dashed' },
                data: breaks.map(b => [{ xAxis: b.startValue }, { xAxis: b.endValue }])
              } : undefined,
              markLine: useAxisBreak && breaks.length > 0 ? {
                silent: true,
                label: { show: false },
                emphasis: { disabled: true },
                symbol: ['none', 'none'],
                lineStyle: { type: 'dashed', color: '#999', width: 1 },
                data: breaks.flatMap(b => ([{ xAxis: b.startValue }, { xAxis: b.endValue }]))
              } : undefined,
            },
            // 用散点承载“断轴时间标签”，以确保跨版本稳定显示
            ...(showBreakLabels && labelData.length > 0 ? [{
              name: '断轴时间标签',
              type: 'scatter' as const,
              data: labelData,
              symbolSize: 1,
              itemStyle: { color: 'transparent' },
              tooltip: { show: false },
              label: {
                show: true,
                position: 'top',
                distance: 4,
                color: '#666',
                backgroundColor: 'rgba(255,255,255,0.75)',
                padding: [2, 4],
                borderRadius: 3,
                formatter: (p: any) => {
                  const v = p?.value?.[0];
                  if (!v) return '';
                  try { return (echarts?.time?.format ? echarts.time.format(v, '{MM}-{dd} {HH}:{mm}') : new Date(v).toLocaleString()); }
                  catch { return new Date(v).toLocaleString(); }
                }
              },
              z: 5,
              zlevel: 2,
            }] : [])
          ]
        };
        // 调试：统计断开点与标记
        console.log(`[EChartTimeSeries] xAxis.breaks 长度(已停用内置): 0`);
        console.log(`[EChartTimeSeries] 标记区间数: ${breaks.length}, 断开点数: ${nullBreakCount}`);
        if (showBreakLabels) {
          console.log(`[EChartTimeSeries] 标签点数: ${labelData.length}`);
        }
        chartRef.current.setOption(option, true);
        
        // 延迟检查 ECharts 内部是否生成了 breaks
        setTimeout(() => {
          try {
            const currentOption = chartRef.current?.getOption?.();
            if (currentOption && currentOption.xAxis) {
              console.log(`[EChartTimeSeries] 渲染后 markArea 段数:`, (currentOption.series as any)[0]?.markArea?.data?.length ?? 0);
              console.log(`[EChartTimeSeries] 渲染后 markLine 段数:`, (currentOption.series as any)[0]?.markLine?.data?.length ?? 0);
            }
          } catch (e) {
            console.error('[EChartTimeSeries] 读取渲染后选项出错:', e);
          }
        }, 500);
        if (onReady) {
          const resetZoom = () => {
            try {
              chartRef.current.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 0, end: 100 });
              chartRef.current.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: 0, end: 100 });
            } catch {
              try {
                chartRef.current.setOption({ dataZoom: [{ start: 0, end: 100 }, { start: 0, end: 100 }] });
              } catch {}
            }
          };
          onReady({ resetZoom, getInstance: () => chartRef.current });
        }
        const onResize = () => chartRef.current && chartRef.current.resize();
        window.addEventListener('resize', onResize);
        (chartRef.current as any)._cleanup = () => window.removeEventListener('resize', onResize);
      })
      .catch((e) => {
        console.error('[EChartTimeSeries] 加载 ECharts 失败', e);
      });

    return () => {
      disposed = true;
      try {
        const c: any = chartRef.current;
        if (c && c._cleanup) c._cleanup();
        if (c && !c.isDisposed()) c.dispose();
      } catch {}
      chartRef.current = null;
    };
  }, [data?.length]);

  return <div ref={ref} style={{ width: '100%', height }} />;
};
