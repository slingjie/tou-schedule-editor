import { useMemo } from 'react';
import type { LoadDataPoint } from '../utils';

// 共享 Hook：将细粒度(如15分钟kW)或小时级数据聚合为 12×24 的“月度日平均小时负荷(kW)”
// 口径说明：先按“每天-每小时”对细粒度kW做均值，再跨日取均值，得到“小时平均功率(kW)”
export const useMonthlyHourlyAverages = (data: LoadDataPoint[]) => {
  return useMemo(() => {
    // dayHourAgg[month][hour] = Map<dayKey, { sum: number; count: number }>
    const dayHourAgg: Array<Array<Map<string, { sum: number; count: number }>>> =
      Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => new Map()));

    for (const p of data) {
      if (!p || !(p.timestamp instanceof Date) || !Number.isFinite(p.load)) continue;
      const m = p.timestamp.getMonth(); // 0-11
      const h = p.timestamp.getHours(); // 0-23
      const yyyy = p.timestamp.getFullYear();
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(p.timestamp.getDate()).padStart(2, '0');
      const dayKey = `${yyyy}-${mm}-${dd}`;
      const map = dayHourAgg[m][h];
      const cur = map.get(dayKey) || { sum: 0, count: 0 };
      cur.sum += p.load;
      cur.count += 1;
      map.set(dayKey, cur);
    }

    // 计算平均值 curves[month] = number[24]
    const curves: number[][] = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => 0));
    const hasData: boolean[] = Array.from({ length: 12 }, () => false);
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const map = dayHourAgg[m][h];
        const days = map.size;
        if (days > 0) {
          hasData[m] = true;
          let totalDailyAvg = 0;
          for (const { sum, count } of map.values()) {
            totalDailyAvg += count > 0 ? (sum / count) : 0;
          }
          curves[m][h] = totalDailyAvg / days;
        } else {
          curves[m][h] = 0;
        }
      }
    }
    return { curves, hasData };
  }, [data]);
};

export default useMonthlyHourlyAverages;

