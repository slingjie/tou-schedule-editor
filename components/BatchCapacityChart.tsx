import React, { useEffect, useRef } from 'react';

interface BatchDataPoint {
  capacityKwh: number;
  yearEqCycles: number;
  firstYearProfit: number;
  status: 'pending' | 'computing' | 'done' | 'error';
}

interface Props {
  data: BatchDataPoint[];
  targetCycles?: number;
  selectedCapacity?: number;
  onSelectCapacity?: (capacityKwh: number) => void;
  height?: number;
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

export const BatchCapacityChart: React.FC<Props> = ({
  data,
  targetCycles,
  selectedCapacity,
  onSelectCapacity,
  height = 280,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    loadECharts().then((echarts: any) => {
      if (disposed || !ref.current) return;
      
      if (!chartRef.current) {
        chartRef.current = echarts.init(ref.current);
      }
      
      // 过滤已完成的数据点
      const doneData = data.filter(d => d.status === 'done');
      if (doneData.length === 0) {
        chartRef.current.clear();
        return;
      }

      const capacities = doneData.map(d => d.capacityKwh);
      const cycles = doneData.map(d => d.yearEqCycles);
      const profits = doneData.map(d => d.firstYearProfit / 10000); // 转换为万元

      // 找到最接近目标的点
      let closestIdx = -1;
      if (targetCycles && targetCycles > 0) {
        let minDiff = Infinity;
        doneData.forEach((d, i) => {
          const diff = Math.abs(d.yearEqCycles - targetCycles);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = i;
          }
        });
      }

      // 找到选中的点
      const selectedIdx = selectedCapacity 
        ? doneData.findIndex(d => d.capacityKwh === selectedCapacity)
        : -1;

      const option = {
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          formatter: (params: any) => {
            if (!params || params.length === 0) return '';
            const capacity = params[0].axisValue;
            let html = `<div style="font-weight:600;margin-bottom:4px">容量 ${capacity.toLocaleString()} kWh</div>`;
            params.forEach((p: any) => {
              const value = p.seriesName === '循环数' 
                ? `${p.value.toFixed(2)} 次/年`
                : `${p.value.toFixed(2)} 万元`;
              html += `<div>${p.marker} ${p.seriesName}: ${value}</div>`;
            });
            return html;
          },
        },
        legend: {
          data: ['循环数', '首年收益'],
          top: 0,
          textStyle: { fontSize: 11 },
        },
        grid: {
          top: 35,
          left: 50,
          right: 50,
          bottom: 35,
        },
        xAxis: {
          type: 'category',
          data: capacities,
          name: '容量 (kWh)',
          nameLocation: 'middle',
          nameGap: 22,
          nameTextStyle: { fontSize: 11, color: '#666' },
          axisLabel: { fontSize: 10 },
        },
        yAxis: [
          {
            type: 'value',
            name: '循环数',
            position: 'left',
            nameTextStyle: { fontSize: 11, color: '#10b981' },
            axisLabel: { fontSize: 10, color: '#10b981' },
            axisLine: { show: true, lineStyle: { color: '#10b981' } },
            splitLine: { lineStyle: { type: 'dashed', color: '#e5e7eb' } },
          },
          {
            type: 'value',
            name: '收益 (万元)',
            position: 'right',
            nameTextStyle: { fontSize: 11, color: '#3b82f6' },
            axisLabel: { fontSize: 10, color: '#3b82f6' },
            axisLine: { show: true, lineStyle: { color: '#3b82f6' } },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: '循环数',
            type: 'line',
            data: cycles,
            yAxisIndex: 0,
            symbol: 'circle',
            symbolSize: (value: number, params: any) => {
              // 选中点或最接近目标点放大
              if (params.dataIndex === selectedIdx) return 12;
              if (params.dataIndex === closestIdx) return 10;
              return 6;
            },
            itemStyle: {
              color: (params: any) => {
                if (params.dataIndex === selectedIdx) return '#059669';
                if (params.dataIndex === closestIdx) return '#f59e0b';
                return '#10b981';
              },
            },
            lineStyle: { color: '#10b981', width: 2 },
            emphasis: { scale: 1.5 },
            markLine: targetCycles && targetCycles > 0 ? {
              silent: true,
              symbol: 'none',
              lineStyle: { type: 'dashed', color: '#f59e0b', width: 2 },
              label: {
                show: true,
                position: 'insideEndTop',
                formatter: `目标 ${targetCycles}`,
                fontSize: 10,
                color: '#f59e0b',
              },
              data: [{ yAxis: targetCycles }],
            } : undefined,
          },
          {
            name: '首年收益',
            type: 'line',
            data: profits,
            yAxisIndex: 1,
            symbol: 'circle',
            symbolSize: (value: number, params: any) => {
              if (params.dataIndex === selectedIdx) return 12;
              if (params.dataIndex === closestIdx) return 10;
              return 6;
            },
            itemStyle: {
              color: (params: any) => {
                if (params.dataIndex === selectedIdx) return '#1d4ed8';
                if (params.dataIndex === closestIdx) return '#f59e0b';
                return '#3b82f6';
              },
            },
            lineStyle: { color: '#3b82f6', width: 2 },
            emphasis: { scale: 1.5 },
          },
        ],
      };

      chartRef.current.setOption(option, true);

      // 点击事件
      chartRef.current.off('click');
      chartRef.current.on('click', (params: any) => {
        if (params.componentType === 'series' && onSelectCapacity) {
          const idx = params.dataIndex;
          if (idx >= 0 && idx < doneData.length) {
            onSelectCapacity(doneData[idx].capacityKwh);
          }
        }
      });
    });

    return () => {
      disposed = true;
    };
  }, [data, targetCycles, selectedCapacity, onSelectCapacity]);

  // resize 监听
  useEffect(() => {
    const handleResize = () => {
      chartRef.current?.resize();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div
      ref={ref}
      style={{ width: '100%', height }}
    />
  );
};

export default BatchCapacityChart;
