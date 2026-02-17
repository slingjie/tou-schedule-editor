import React, { useMemo, useState } from 'react';
import type { Schedule, DateRule, OperatingLogicId, TierId } from '../types';
import type { LoadDataPoint } from '../utils';
import { TIER_MAP, OPERATING_LOGIC_MAP } from '../constants';

type EnergyMatrixTableProps = {
  data: LoadDataPoint[];
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
  };
  height?: number;
};

// 将日期对象格式化为 YYYY-MM-DD（按本地时区）
const toDateKey = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 计算某天、某小时对应的 TOU 与运行逻辑（优先命中日期规则，否则回落到月度规则）
const getEffectiveCell = (
  date: Date,
  hour: number,
  monthlySchedule: Schedule,
  dateRules: DateRule[]
) => {
  // 将 Date 归一到本地日期比较范围
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const anchor = new Date(y, m, d, 0, 0, 0);

  // 命中第一个覆盖该日期的规则（如存在多个规则，可根据业务改为优先级/最后定义覆盖等策略）
  const rule = dateRules.find((r) => {
    const start = new Date(r.startDate + 'T00:00:00');
    const end = new Date(r.endDate + 'T23:59:59');
    return anchor.getTime() >= start.getTime() && anchor.getTime() <= end.getTime();
  });

  if (rule) {
    const cell = rule.schedule[hour];
    return { tou: cell.tou as TierId, op: cell.op as OperatingLogicId };
  }

  // 使用月度默认规则
  const monthIndex = date.getMonth();
  const cell = monthlySchedule[monthIndex]?.[hour];
  return { tou: cell?.tou ?? ('平' as TierId), op: cell?.op ?? ('待机' as OperatingLogicId) };
};

// 生成某年指定月份的所有自然日（monthIndex: 0-11；为 -1 表示全年）
const getDays = (year: number, monthIndex: number) => {
  const days: Date[] = [];
  if (monthIndex === -1) {
    for (let m = 0; m < 12; m++) {
      const dt = new Date(year, m, 1);
      while (dt.getMonth() === m) {
        days.push(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()));
        dt.setDate(dt.getDate() + 1);
      }
    }
  } else {
    const dt = new Date(year, monthIndex, 1);
    while (dt.getMonth() === monthIndex) {
      days.push(new Date(year, monthIndex, dt.getDate()));
      dt.setDate(dt.getDate() + 1);
    }
  }
  return days;
};

export const EnergyMatrixTable: React.FC<EnergyMatrixTableProps> = ({ data, scheduleData, height = 640 }) => {
  // 年份列表（按数据年份聚合）
  const yearList = useMemo(() => {
    const set = new Set<number>();
    data.forEach((p) => set.add(p.timestamp.getFullYear()));
    return Array.from(set).sort((a, b) => a - b);
  }, [data]);

  const defaultYear = yearList[0] ?? new Date().getFullYear();
  const defaultMonth = data.length > 0 ? data[0].timestamp.getMonth() : new Date().getMonth();

  // 交互选择：年份、月份（-1 表示全年）
  const [year, setYear] = useState<number>(defaultYear);
  const [monthIndex, setMonthIndex] = useState<number>(defaultMonth);

  // 将小时用电量映射为 Map(key = YYYY-MM-DD-HH, value = kWh)
  const loadMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data) {
      const key = `${toDateKey(p.timestamp)}-${p.timestamp.getHours()}`;
      m.set(key, (m.get(key) ?? 0) + (Number.isFinite(p.load) ? p.load : 0));
    }
    return m;
  }, [data]);

  const days = useMemo(() => getDays(year, monthIndex), [year, monthIndex]);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  return (
    <div className="p-6 bg-white rounded-xl shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-slate-800">用电量矩阵（日×时）</h2>
      </div>

      {/* 顶部筛选控件 */}
      <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-600">年份</span>
          <select
            className="border border-slate-300 rounded-md px-2 py-1"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {yearList.length === 0 ? (
              <option value={defaultYear}>{defaultYear}</option>
            ) : (
              yearList.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))
            )}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-slate-600">月份</span>
          <select
            className="border border-slate-300 rounded-md px-2 py-1"
            value={monthIndex}
            onChange={(e) => setMonthIndex(Number(e.target.value))}
          >
            <option value={-1}>全年</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i}>{i + 1}</option>
            ))}
          </select>
        </label>

        <div className="text-xs text-slate-500">
          提示：全年展示包含 365×24 单元格，可能导致渲染较慢。建议按月查看。
        </div>
      </div>

      {/* 图例：TOU 与运行逻辑 */}
      <div className="flex flex-wrap gap-3 mb-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-slate-600">TOU：</span>
          {Array.from(TIER_MAP.values()).map((t) => (
            <span key={t.id} className={`px-2 py-0.5 rounded ${t.color} ${t.textColor}`}>{t.id}</span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-600">运行：</span>
          {Array.from(OPERATING_LOGIC_MAP.values()).map((o) => (
            <span key={o.id} className={`px-2 py-0.5 rounded ${o.color} ${o.textColor}`}>{o.id}</span>
          ))}
        </div>
      </div>

      {/* 主体表格 */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-auto" style={{ maxHeight: height }}>
          <table className="min-w-full border-collapse">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr>
                <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-medium text-slate-600 sticky left-0 bg-slate-50">日期</th>
                {hours.map((h) => (
                  <th key={h} className="border-b border-slate-200 px-2 py-2 text-xs font-medium text-slate-600 text-center min-w-[68px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => {
                const dateKey = toDateKey(day);
                const label = `${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`;
                return (
                  <tr key={dateKey} className="odd:bg-white even:bg-slate-50/50">
                    <td className="border-b border-slate-100 px-2 py-1 text-xs text-slate-700 sticky left-0 bg-inherit">{label}</td>
                    {hours.map((h) => {
                      const v = loadMap.get(`${dateKey}-${h}`);
                      const eff = getEffectiveCell(day, h, scheduleData.monthlySchedule, scheduleData.dateRules);
                      const t = TIER_MAP.get(eff.tou);
                      const o = OPERATING_LOGIC_MAP.get(eff.op);
                      return (
                        <td key={h} className="border-b border-slate-100 px-1 py-1 text-[11px] text-center align-middle">
                          <div className="flex flex-col items-center gap-0.5">
                            <div className="font-semibold text-slate-800">
                              {v !== undefined ? v.toFixed(1) : '—'}
                            </div>
                            <div className="flex items-center gap-1">
                              <span className={`px-1 rounded ${t?.color ?? ''} ${t?.textColor ?? ''}`}>{eff.tou}</span>
                              <span className={`px-1 rounded ${o?.color ?? ''} ${o?.textColor ?? ''}`}>{eff.op}</span>
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default EnergyMatrixTable;

