import Chart from 'chart.js/auto';
import type { ReportChartsV3, ReportDataV3, TierId, OperatingLogicId } from '../types';
import type { StoredLoadPoint } from '../localProjectStore';

type PngDataUrl = string; // data:image/png;base64,...

const TIER_COLORS: Record<TierId, string> = {
  '深': 'rgba(16, 185, 129, 0.20)',  // green
  '谷': 'rgba(134, 239, 172, 0.30)',
  '平': 'rgba(148, 163, 184, 0.28)', // slate
  '峰': 'rgba(251, 146, 60, 0.26)',  // orange
  '尖': 'rgba(248, 113, 113, 0.26)', // red
};

const OP_COLORS: Record<OperatingLogicId, string> = {
  '待机': 'rgba(148, 163, 184, 0.60)',
  '充': 'rgba(59, 130, 246, 0.65)',
  '放': 'rgba(249, 115, 22, 0.65)',
};

const whiteBackgroundPlugin = {
  id: 'whiteBackground',
  beforeDraw: (chart: any) => {
    const ctx = chart.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, chart.width, chart.height);
    ctx.restore();
  },
};

const createCanvas = (widthPx: number, heightPx: number, scale: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPx * scale));
  canvas.height = Math.max(1, Math.round(heightPx * scale));
  canvas.style.width = `${widthPx}px`;
  canvas.style.height = `${heightPx}px`;
  return canvas;
};

const renderChartToPng = async (build: (canvas: HTMLCanvasElement) => Chart, opts?: { widthPx?: number; heightPx?: number; scale?: number }): Promise<PngDataUrl> => {
  const widthPx = opts?.widthPx ?? 1100;
  const heightPx = opts?.heightPx ?? 360;
  const scale = opts?.scale ?? 2;

  const canvas = createCanvas(widthPx, heightPx, scale);
  // 不挂载到 DOM 也可以渲染；某些浏览器下为稳妥可临时挂载到 body。
  canvas.style.position = 'fixed';
  canvas.style.left = '-99999px';
  canvas.style.top = '-99999px';
  document.body.appendChild(canvas);

  const chart = build(canvas);
  try {
    // Chart.js 在 animation=false 情况下可同步渲染，但仍留一帧给布局更稳妥
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const dataUrl = chart.toBase64Image('image/png', 1);
    return dataUrl;
  } finally {
    try { chart.destroy(); } catch { /* ignore */ }
    try { canvas.remove(); } catch { /* ignore */ }
  }
};

const parseYmdToInt = (ymd: string): number => {
  const s = (ymd || '').slice(0, 10).replace(/-/g, '');
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : NaN;
};

const pickScheduleForDate = (configSnapshot: any, ymd: string): Array<{ tou: TierId; op: OperatingLogicId }> | null => {
  const dateRules = Array.isArray(configSnapshot?.dateRules) ? configSnapshot.dateRules : [];
  const monthlySchedule = Array.isArray(configSnapshot?.monthlySchedule) ? configSnapshot.monthlySchedule : null;
  const target = parseYmdToInt(ymd);

  if (Number.isFinite(target)) {
    for (const r of dateRules) {
      const start = parseYmdToInt(String(r?.startDate ?? ''));
      const end = parseYmdToInt(String(r?.endDate ?? ''));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (target < start || target > end) continue;
      const sched = Array.isArray(r?.schedule) ? r.schedule : null;
      if (sched && sched.length === 24) return sched as any;
    }
  }

  if (monthlySchedule && monthlySchedule.length === 12) {
    const m = Number.parseInt((ymd || '').slice(5, 7), 10);
    const idx = Number.isFinite(m) ? (m - 1) : -1;
    const sched = idx >= 0 ? monthlySchedule[idx] : null;
    if (Array.isArray(sched) && sched.length === 24) return sched as any;
  }

  return null;
};

const buildPriceByHour = (configSnapshot: any, ymd: string): Array<number | null> | null => {
  const sched = pickScheduleForDate(configSnapshot, ymd);
  const prices = Array.isArray(configSnapshot?.prices) ? configSnapshot.prices : null;
  const m = Number.parseInt((ymd || '').slice(5, 7), 10);
  const monthIdx = Number.isFinite(m) ? (m - 1) : -1;
  const priceMap = prices && prices[monthIdx] ? prices[monthIdx] : null;
  if (!sched || !priceMap) return null;
  const out: Array<number | null> = [];
  for (let h = 0; h < 24; h++) {
    const tou = (sched[h] as any)?.tou as TierId | undefined;
    const p = tou ? priceMap[tou] : null;
    out.push(p == null ? null : Number(p));
  }
  return out;
};

const buildTouByHour = (configSnapshot: any, ymd: string): TierId[] | null => {
  const sched = pickScheduleForDate(configSnapshot, ymd);
  if (!sched) return null;
  return Array.from({ length: 24 }, (_, h) => ((sched[h] as any)?.tou ?? '平') as TierId);
};

const buildOpByHour = (configSnapshot: any, ymd: string): OperatingLogicId[] | null => {
  const sched = pickScheduleForDate(configSnapshot, ymd);
  if (!sched) return null;
  return Array.from({ length: 24 }, (_, h) => ((sched[h] as any)?.op ?? '待机') as OperatingLogicId);
};

const buildHourlyAverageLoadKw = (points: StoredLoadPoint[], intervalMinutes?: number | null): Array<number | null> => {
  const interval = Number(intervalMinutes ?? NaN);
  const factor = Number.isFinite(interval) && interval > 0 ? (60 / interval) : 1;
  const sums = Array.from({ length: 24 }, () => 0);
  const counts = Array.from({ length: 24 }, () => 0);

  for (const p of points) {
    const ts = typeof p?.timestamp === 'string' ? p.timestamp : '';
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const h = d.getHours();
    if (h < 0 || h > 23) continue;
    const v = Number((p as any)?.load_kwh ?? NaN);
    if (!Number.isFinite(v)) continue;
    sums[h] += v * factor;
    counts[h] += 1;
  }

  return sums.map((s, h) => (counts[h] > 0 ? s / counts[h] : null));
};

const roundNullable = (v: number | null, digits: number): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
};

export const buildReportChartsV3 = async (input: {
  reportData: ReportDataV3;
  points: StoredLoadPoint[];
  intervalMinutes?: number | null;
}): Promise<{ charts: Partial<ReportChartsV3>; warnings: string[] }> => {
  const report = input.reportData;
  const points = Array.isArray(input.points) ? input.points : [];
  const intervalMinutes = input.intervalMinutes ?? (report.load?.meta?.source_interval_minutes ?? null);

  const cfg = (report.tou as any) || {};
  const configSnapshot = {
    monthlySchedule: cfg?.monthly_schedule ?? cfg?.monthlySchedule ?? null,
    dateRules: cfg?.date_rules ?? cfg?.dateRules ?? [],
    prices: cfg?.prices ?? null,
  };

  const ymdForTou = String(report.meta.period_start || points[0]?.timestamp?.slice(0, 10) || '').slice(0, 10);

  const warnings: string[] = [];
  const out: Partial<ReportChartsV3> = {};

  // 1) 24h 分时电价图（阶梯折线）
  const touByHour = buildTouByHour(configSnapshot, ymdForTou);
  const priceByHour = buildPriceByHour(configSnapshot, ymdForTou);
  if (touByHour && priceByHour) {
    const labels = Array.from({ length: 24 }, (_, i) => String(i));
    out.price_24h_png = await renderChartToPng((canvas) => {
      const tierBgPlugin = {
        id: 'tierBackground',
        beforeDatasetsDraw: (chart: any) => {
          const area = chart.chartArea;
          const xScale = chart.scales.x;
          const ctx = chart.ctx;
          if (!area || !xScale) return;
          const centers = labels.map((_, i) => xScale.getPixelForTick(i));
          for (let i = 0; i < labels.length; i++) {
            const left = i === 0 ? area.left : (centers[i - 1] + centers[i]) / 2;
            const right = i === labels.length - 1 ? area.right : (centers[i] + centers[i + 1]) / 2;
            const tou = touByHour[i];
            ctx.save();
            ctx.fillStyle = TIER_COLORS[tou] || 'rgba(0,0,0,0.05)';
            ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
            ctx.restore();
          }
        },
      };

      return new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '电价（元/kWh）',
              data: priceByHour.map((v) => (v == null ? null : roundNullable(v, 4))),
              borderColor: '#1d4ed8',
              backgroundColor: 'rgba(29, 78, 216, 0.10)',
              stepped: true,
              pointRadius: 0,
              borderWidth: 2,
              spanGaps: false,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: `24h 分时电价（按 ${ymdForTou} 生效规则）` },
            tooltip: { enabled: true },
          },
          scales: {
            x: {
              title: { display: true, text: '小时' },
              ticks: { maxRotation: 0, autoSkip: false, callback: (v) => (Number(v) % 2 === 0 ? String(v) : '') },
              grid: { color: 'rgba(148, 163, 184, 0.25)' },
            },
            y: {
              title: { display: true, text: '元/kWh' },
              grid: { color: 'rgba(148, 163, 184, 0.25)' },
            },
          },
        },
        plugins: [whiteBackgroundPlugin, tierBgPlugin],
      });
    });
  } else {
    warnings.push('电价图生成失败：缺少 TOU schedule 或 prices（请检查配置快照是否包含 monthlySchedule/dateRules/prices）');
  }

  // 2) 24h 运行策略色块图（条形色带）
  const opByHour = buildOpByHour(configSnapshot, ymdForTou);
  if (opByHour) {
    const labels = Array.from({ length: 24 }, (_, i) => String(i));
    out.strategy_24h_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: '策略',
              data: labels.map(() => 1),
              backgroundColor: opByHour.map((op) => OP_COLORS[op] || 'rgba(0,0,0,0.08)'),
              borderWidth: 0,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: `24h 运行策略（按 ${ymdForTou} 生效规则）` },
            tooltip: {
              callbacks: {
                label: (ctx: any) => `策略：${opByHour[ctx.dataIndex]}`,
              },
            },
          },
          scales: {
            x: { title: { display: true, text: '小时' }, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false, callback: (v) => (Number(v) % 2 === 0 ? String(v) : '') } },
            y: { display: false, grid: { display: false } },
          },
        },
        plugins: [whiteBackgroundPlugin],
      });
    }, { heightPx: 220 });
  } else {
    warnings.push('运行策略图生成失败：缺少 monthlySchedule/dateRules');
  }

  // 3) 负荷典型曲线（按小时聚合平均）
  if (points.length > 0) {
    const hourlyAvg = buildHourlyAverageLoadKw(points, intervalMinutes);
    const labels = Array.from({ length: 24 }, (_, i) => String(i));
    out.load_typical_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '平均负荷（kW）',
              data: hourlyAvg.map((v) => (v == null ? null : roundNullable(v, 2))),
              borderColor: '#0f766e',
              backgroundColor: 'rgba(15, 118, 110, 0.10)',
              pointRadius: 0,
              borderWidth: 2,
              spanGaps: false,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: '负荷典型曲线（按小时均值）' },
          },
          scales: {
            x: { title: { display: true, text: '小时' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
            y: { title: { display: true, text: 'kW' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
          },
        },
        plugins: [whiteBackgroundPlugin],
      });
    });
  } else {
    warnings.push('负荷典型曲线生成失败：缺少负荷点位');
  }

  // 3.3) 月度分布（均值 + 峰值）
  if (points.length > 0) {
    const interval = Number(intervalMinutes ?? NaN);
    const factor = Number.isFinite(interval) && interval > 0 ? (60 / interval) : 1;
    const monthMap: Record<string, { sum: number; count: number; max: number }> = {};
    for (const p of points) {
      const ts = typeof p?.timestamp === 'string' ? p.timestamp : '';
      if (ts.length < 7) continue;
      const t = Date.parse(ts);
      if (!Number.isFinite(t)) continue;
      const month = ts.slice(0, 7);
      const v = Number((p as any)?.load_kwh ?? NaN);
      if (!Number.isFinite(v)) continue;
      const kw = v * factor;
      const cur = monthMap[month] || { sum: 0, count: 0, max: -Infinity };
      cur.sum += kw;
      cur.count += 1;
      if (kw > cur.max) cur.max = kw;
      monthMap[month] = cur;
    }
    const labels = Object.keys(monthMap).sort();
    if (labels.length >= 2) {
      const avg = labels.map((m) => {
        const it = monthMap[m];
        return it && it.count > 0 ? roundNullable(it.sum / it.count, 2) : null;
      });
      const max = labels.map((m) => {
        const it = monthMap[m];
        return it && Number.isFinite(it.max) ? roundNullable(it.max, 2) : null;
      });
      out.load_monthly_distribution_png = await renderChartToPng((canvas) => {
        return new Chart(canvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                type: 'bar',
                label: '月均负荷（kW）',
                data: avg,
                backgroundColor: 'rgba(37, 99, 235, 0.45)',
                borderWidth: 0,
                yAxisID: 'y',
              },
              {
                type: 'line',
                label: '月峰值负荷（kW）',
                data: max,
                borderColor: '#f97316',
                backgroundColor: 'rgba(249, 115, 22, 0.10)',
                pointRadius: 0,
                borderWidth: 2,
                yAxisID: 'y',
              },
            ],
          },
          options: {
            responsive: false,
            animation: false,
            plugins: {
              legend: { display: true, position: 'bottom' },
              title: { display: true, text: '月度负荷分布（均值/峰值）' },
            },
            scales: {
              x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
              y: { title: { display: true, text: 'kW' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
            },
          },
          plugins: [whiteBackgroundPlugin],
        });
      }, { heightPx: 420 });
    } else {
      warnings.push('月度分布图生成跳过：月份数量不足（<2）');
    }
  } else {
    warnings.push('月度分布图生成失败：缺少负荷点位');
  }

  // 4) 负荷-电价叠加（双轴）
  if (points.length > 0 && priceByHour) {
    const hourlyAvg = buildHourlyAverageLoadKw(points, intervalMinutes);
    const labels = Array.from({ length: 24 }, (_, i) => String(i));
    out.load_price_overlay_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '平均负荷（kW）',
              data: hourlyAvg.map((v) => (v == null ? null : roundNullable(v, 2))),
              borderColor: '#0f766e',
              pointRadius: 0,
              borderWidth: 2,
              yAxisID: 'yLoad',
              spanGaps: false,
            },
            {
              label: '电价（元/kWh）',
              data: priceByHour.map((v) => (v == null ? null : roundNullable(v, 4))),
              borderColor: '#1d4ed8',
              pointRadius: 0,
              borderWidth: 2,
              stepped: true,
              yAxisID: 'yPrice',
              spanGaps: false,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
            title: { display: true, text: '负荷-电价叠加（按小时均值）' },
          },
          scales: {
            x: { title: { display: true, text: '小时' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
            yLoad: { type: 'linear', position: 'left', title: { display: true, text: 'kW' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
            yPrice: { type: 'linear', position: 'right', title: { display: true, text: '元/kWh' }, grid: { drawOnChartArea: false } },
          },
        },
        plugins: [whiteBackgroundPlugin],
      });
    });
  } else if (points.length > 0) {
    warnings.push('负荷-电价叠加图生成失败：缺少价格曲线（schedule/prices 不完整）');
  }

  // 5) 现金流图（柱状 + 折线）
  const econ = (report.storage as any)?.economics?.result;
  const yearly = Array.isArray(econ?.yearly_cashflows) ? econ.yearly_cashflows : [];
  if (yearly.length > 0) {
    const labels = yearly.map((x: any) => `第${x.year_index}年`);
    const net = yearly.map((x: any) => Number(x.net_cashflow ?? NaN));
    const cum = yearly.map((x: any) => Number(x.cumulative_net_cashflow ?? NaN));
    const paybackYears = Number(econ?.static_payback_years ?? NaN);
    const paybackMarkerPlugin = Number.isFinite(paybackYears) ? {
      id: 'paybackMarker',
      afterDatasetsDraw: (chart: any) => {
        const xScale = chart.scales?.x;
        const yScale = chart.scales?.yCash;
        const area = chart.chartArea;
        if (!xScale || !yScale || !area) return;
        const x = xScale.getPixelForValue(paybackYears - 1);
        if (!Number.isFinite(x)) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(234, 88, 12, 0.85)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x, area.top);
        ctx.lineTo(x, area.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(234, 88, 12, 0.95)';
        ctx.font = '12px Microsoft YaHei, Arial, sans-serif';
        const label = `回收期≈${paybackYears.toFixed(2)}年`;
        ctx.fillText(label, Math.min(x + 6, area.right - 120), area.top + 14);
        ctx.restore();
      },
    } : null;
    out.cashflow_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'bar',
              label: '年度净现金流（元）',
              data: net.map((v) => (Number.isFinite(v) ? Math.round(v) : null)),
              backgroundColor: 'rgba(2, 132, 199, 0.55)',
              borderWidth: 0,
              yAxisID: 'yCash',
            },
            {
              type: 'line',
              label: '累计净现金流（元）',
              data: cum.map((v) => (Number.isFinite(v) ? Math.round(v) : null)),
              borderColor: '#dc2626',
              backgroundColor: 'rgba(220, 38, 38, 0.10)',
              pointRadius: 0,
              borderWidth: 2,
              yAxisID: 'yCash',
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
            title: { display: true, text: Number.isFinite(paybackYears) ? `年度净现金流与累计净现金流（回收期≈${paybackYears.toFixed(2)}年）` : '年度净现金流与累计净现金流' },
          },
          scales: {
            x: { grid: { display: false } },
            yCash: { title: { display: true, text: '元' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
          },
        },
        plugins: paybackMarkerPlugin ? [whiteBackgroundPlugin, paybackMarkerPlugin] : [whiteBackgroundPlugin],
      });
    }, { heightPx: 420 });
  } else {
    warnings.push('现金流图生成失败：缺少 economics.yearly_cashflows');
  }

  // 6) 典型日叠加（收益最高日 / 最大负荷日）
  const bestCurves = (report.storage as any)?.typical_days?.best_profit_day?.curves;
  if (bestCurves?.points_original?.length && bestCurves?.points_with_storage?.length) {
    const labels = bestCurves.points_original.map((pt: any) => String(pt.timestamp).slice(11, 16));
    out.best_profit_day_overlay_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '原始负荷（kW）',
              data: bestCurves.points_original.map((pt: any) => roundNullable(Number(pt.load_kw ?? NaN), 2)),
              borderColor: '#64748b',
              pointRadius: 0,
              borderWidth: 2,
            },
            {
              label: '储能后负荷（kW）',
              data: bestCurves.points_with_storage.map((pt: any) => roundNullable(Number(pt.load_kw ?? NaN), 2)),
              borderColor: '#16a34a',
              pointRadius: 0,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
            title: { display: true, text: `典型日（收益最高日 ${bestCurves.date}）负荷对比` },
          },
          scales: {
            x: { title: { display: true, text: '时间' }, ticks: { maxTicksLimit: 12 } },
            y: { title: { display: true, text: 'kW' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
          },
        },
        plugins: [whiteBackgroundPlugin],
      });
    });
  } else {
    warnings.push('收益最高日叠加图生成失败：缺少典型日曲线 points_original/points_with_storage');
  }

  const maxCurves = (report.storage as any)?.typical_days?.max_load_day?.curves;
  if (maxCurves?.points_original?.length && maxCurves?.points_with_storage?.length) {
    const labels = maxCurves.points_original.map((pt: any) => String(pt.timestamp).slice(11, 16));
    out.max_load_day_overlay_png = await renderChartToPng((canvas) => {
      return new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '原始负荷（kW）',
              data: maxCurves.points_original.map((pt: any) => roundNullable(Number(pt.load_kw ?? NaN), 2)),
              borderColor: '#64748b',
              pointRadius: 0,
              borderWidth: 2,
            },
            {
              label: '储能后负荷（kW）',
              data: maxCurves.points_with_storage.map((pt: any) => roundNullable(Number(pt.load_kw ?? NaN), 2)),
              borderColor: '#16a34a',
              pointRadius: 0,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
            title: { display: true, text: `典型日（最大负荷日 ${maxCurves.date}）负荷对比` },
          },
          scales: {
            x: { title: { display: true, text: '时间' }, ticks: { maxTicksLimit: 12 } },
            y: { title: { display: true, text: 'kW' }, grid: { color: 'rgba(148, 163, 184, 0.25)' } },
          },
        },
        plugins: [whiteBackgroundPlugin],
      });
    });
  } else {
    warnings.push('最大负荷日叠加图生成失败：缺少典型日曲线 points_original/points_with_storage');
  }

  return { charts: out, warnings };
};
