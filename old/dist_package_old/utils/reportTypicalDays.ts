import type { BackendStorageCyclesResponse } from '../types';
import type { StoredLoadPoint } from '../localProjectStore';

export const pickBestProfitDay = (cycles: BackendStorageCyclesResponse | null): string | null => {
  const days = cycles?.days;
  if (!Array.isArray(days) || days.length === 0) return null;

  let bestDate: string | null = null;
  let bestProfit = -Infinity;

  for (const d of days) {
    const date = typeof d?.date === 'string' ? d.date : '';
    const profit = Number((d as any)?.profit?.main?.profit ?? NaN);
    if (!date || !Number.isFinite(profit)) continue;
    if (profit > bestProfit) {
      bestProfit = profit;
      bestDate = date;
    } else if (profit === bestProfit && bestDate && date < bestDate) {
      // tie-break：选择最早日期，便于复现
      bestDate = date;
    } else if (profit === bestProfit && !bestDate) {
      bestDate = date;
    }
  }
  return bestDate;
};

export const pickMaxLoadDay = (
  points: StoredLoadPoint[],
  intervalMinutes?: number | null,
): string | null => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const interval = Number(intervalMinutes ?? NaN);
  const factor = Number.isFinite(interval) && interval > 0 ? (60 / interval) : 1; // load_kwh -> 近似 kW

  const dailyMax = new Map<string, number>();
  for (const p of points) {
    const ts = typeof p?.timestamp === 'string' ? p.timestamp : '';
    if (ts.length < 10) continue;
    const day = ts.slice(0, 10);
    const loadKwh = Number((p as any)?.load_kwh ?? NaN);
    if (!Number.isFinite(loadKwh)) continue;
    const loadKw = loadKwh * factor;
    const prev = dailyMax.get(day);
    if (prev == null || loadKw > prev) dailyMax.set(day, loadKw);
  }

  let bestDay: string | null = null;
  let bestMax = -Infinity;
  for (const [day, maxKw] of dailyMax.entries()) {
    if (maxKw > bestMax) {
      bestMax = maxKw;
      bestDay = day;
    } else if (maxKw === bestMax && bestDay && day < bestDay) {
      bestDay = day;
    } else if (maxKw === bestMax && !bestDay) {
      bestDay = day;
    }
  }

  return bestDay;
};

