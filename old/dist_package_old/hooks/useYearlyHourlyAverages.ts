import { useMemo } from 'react';
import type { LoadDataPoint } from '../utils';

// 中文注释：
// 共享 Hook：将细粒度(如15分钟kW)或小时级数据聚合为 24 点的“年度日平均小时负荷(kW)”
// 口径说明：先按“每天-每小时”对细粒度kW做均值，再跨全年所有天取均值，得到“小时平均功率(kW)”
export const useYearlyHourlyAverages = (data: LoadDataPoint[]) => {
  return useMemo(() => {
    // dayHourAgg[hour] = Map<dayKey, { sum: number; count: number }>
    const dayHourAgg: Array<Map<string, { sum: number; count: number }>> =
      Array.from({ length: 24 }, () => new Map());

    for (const p of data) {
      if (!p || !(p.timestamp instanceof Date) || !Number.isFinite(p.load)) continue;
      const h = p.timestamp.getHours(); // 0-23
      const yyyy = p.timestamp.getFullYear();
      const mm = String(p.timestamp.getMonth() + 1).padStart(2, '0');
      const dd = String(p.timestamp.getDate()).padStart(2, '0');
      const dayKey = `${yyyy}-${mm}-${dd}`;
      const map = dayHourAgg[h];
      const cur = map.get(dayKey) || { sum: 0, count: 0 };
      cur.sum += p.load;
      cur.count += 1;
      map.set(dayKey, cur);
    }

    // 计算平均值 curve[hour]
    const curve: number[] = Array.from({ length: 24 }, () => 0);
    let anyData = false;
    for (let h = 0; h < 24; h++) {
      const map = dayHourAgg[h];
      const days = map.size;
      if (days > 0) {
        anyData = true;
        let totalDailyAvg = 0;
        for (const { sum, count } of map.values()) {
          totalDailyAvg += count > 0 ? (sum / count) : 0;
        }
        curve[h] = totalDailyAvg / days;
      } else {
        curve[h] = 0;
      }
    }

    return { curve, hasData: anyData };
  }, [data]);
};

export default useYearlyHourlyAverages;

