import React, { useMemo, useState } from 'react';
import type { Schedule, DateRule, OperatingLogicId, TierId } from '../types';
import type { LoadDataPoint } from '../utils';
import { TIER_MAP, OPERATING_LOGIC_MAP } from '../constants';
import { exportEnergySummaryToExcel } from '../utils';

type MonthlySummaryTableProps = {
  data: LoadDataPoint[];
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
  };
};

// 中文工具：将日期对象格式化为 YYYY-MM-DD（本地时区）
const toDateKey = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 中文工具：按规则获取某天某小时的 TOU 与运行逻辑（优先命中日期规则，否则用月度规则）
const getEffectiveCell = (
  date: Date,
  hour: number,
  monthlySchedule: Schedule,
  dateRules: DateRule[],
) => {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const anchor = new Date(y, m, d, 0, 0, 0);

  const rule = dateRules.find((r) => {
    const start = new Date(r.startDate + 'T00:00:00');
    const end = new Date(r.endDate + 'T23:59:59');
    return anchor.getTime() >= start.getTime() && anchor.getTime() <= end.getTime();
  });

  if (rule) {
    const cell = rule.schedule[hour];
    return { tou: cell.tou as TierId, op: cell.op as OperatingLogicId };
  }

  const monthIndex = date.getMonth();
  const cell = monthlySchedule[monthIndex]?.[hour];
  return { tou: cell?.tou ?? ('平' as TierId), op: cell?.op ?? ('待机' as OperatingLogicId) };
};

// 中文工具：将数据按天-小时聚合为 Map<YYYY-MM-DD, { loads: number[24], tous: TierId[24], ops: OperatingLogicId[24] }>
const useDailyHourBuckets = (
  data: LoadDataPoint[],
  monthlySchedule: Schedule,
  dateRules: DateRule[],
) => {
  return useMemo(() => {
    // 先按天-小时汇总负荷
    const dayHourLoadMap = new Map<string, number[]>();
    const dayDateMap = new Map<string, Date>();
    for (const p of data) {
      if (!p || !(p.timestamp instanceof Date) || !Number.isFinite(p.load)) continue;
      const key = toDateKey(p.timestamp);
      const h = p.timestamp.getHours();
      if (!dayHourLoadMap.has(key)) {
        dayHourLoadMap.set(key, Array.from({ length: 24 }, () => 0));
        // 存一个当天零点的 Date 便于规则判定
        dayDateMap.set(key, new Date(p.timestamp.getFullYear(), p.timestamp.getMonth(), p.timestamp.getDate()));
      }
      const arr = dayHourLoadMap.get(key)!;
      arr[h] += p.load;
    }

    // 构造每天的 TOU 与运行逻辑档位
    const dayBuckets = new Map<string, { date: Date; loads: number[]; tous: TierId[]; ops: OperatingLogicId[] }>();
    for (const [key, loads] of dayHourLoadMap.entries()) {
      const date = dayDateMap.get(key)!;
      const tous: TierId[] = Array.from({ length: 24 }, (_, h) => getEffectiveCell(date, h, monthlySchedule, dateRules).tou);
      const ops: OperatingLogicId[] = Array.from({ length: 24 }, (_, h) => getEffectiveCell(date, h, monthlySchedule, dateRules).op);
      dayBuckets.set(key, { date, loads, tous, ops });
    }
    return dayBuckets;
  }, [data, monthlySchedule, dateRules]);
};

// 中文工具：
// 计算某一天的两组“充/放”与 TOU 汇总
// 规则：
// - 仅统计“充/放”，忽略“待机”
// - 将 0..23 小时序列中相同逻辑（充或放）的连续时段视为一个“连段”；如 23 点与 0 点逻辑相同，则首尾连段合并（仅用于连段划分，不跨日移动负荷）
// - 第 1、2 个“充/放”连段分别归入“第一组”“第二组”；第 3 个及之后同类连段合并到“第二组”
const summarizeDay = (
  loads: number[],
  ops: OperatingLogicId[],
  tous: TierId[],
) => {
  // TOU 汇总
  const touBuckets: Record<TierId, number> = { '尖': 0, '峰': 0, '平': 0, '谷': 0, '深': 0 };
  for (let h = 0; h < 24; h++) {
    touBuckets[tous[h]] += loads[h] || 0;
  }

  // 仅保留充/放序列
  const seq: (OperatingLogicId | null)[] = ops.map(op => (op === '充' || op === '放') ? op : null);

  // 构造连段（首尾同类合并）
  type Run = { kind: Exclude<OperatingLogicId, '待机'>; hours: number[] };
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let h = 0; h < 24; h++) {
    const k = seq[h];
    if (!k) { cur = null; continue; }
    if (!cur || cur.kind !== k) {
      cur = { kind: k, hours: [h] } as Run;
      runs.push(cur);
    } else {
      cur.hours.push(h);
    }
  }
  if (runs.length >= 2 && runs[0].kind === runs[runs.length - 1].kind) {
    // 23 与 0 同类，合并首尾（用于分组边界稳定；负荷仍各自在当日小时内累计）
    const first = runs[0];
    const last = runs.pop()!;
    first.hours = [...last.hours, ...first.hours];
  }

  // 两组“充/放”累计
  const group1 = { '充': 0, '放': 0 } as Record<'充' | '放', number>;
  const group2 = { '充': 0, '放': 0 } as Record<'充' | '放', number>;
  let seen: Record<'充' | '放', number> = { '充': 0, '放': 0 };

  const sumHours = (hs: number[]) => hs.reduce((s, h) => s + (loads[h] || 0), 0);

  for (const r of runs) {
    const k = r.kind as '充' | '放';
    const val = sumHours(r.hours);
    if (seen[k] === 0) {
      group1[k] += val; // 第一次出现计入第一组
      seen[k] = 1;
    } else {
      group2[k] += val; // 第二次及之后计入第二组
      seen[k] += 1;
    }
  }

  return { group1, group2, tou: touBuckets };
};

// 中文组件：月度汇总 + 月份点击展开当月每日统计
export const MonthlySummaryTable: React.FC<MonthlySummaryTableProps> = ({ data, scheduleData }) => {
  const { monthlySchedule, dateRules } = scheduleData;
  const dayBuckets = useDailyHourBuckets(data, monthlySchedule, dateRules);

  // 月度汇总（跨年合并：同一月份的数据累计到同一行）
  const monthlyAgg = useMemo(() => {
    const months = Array.from({ length: 12 }, () => ({
      g1c: 0, g1f: 0, g2c: 0, g2f: 0,
      tou: { '尖': 0, '峰': 0, '平': 0, '谷': 0, '深': 0 } as Record<TierId, number>,
    }));
    for (const { date, loads, tous, ops } of dayBuckets.values()) {
      const m = date.getMonth();
      const { group1, group2, tou } = summarizeDay(loads, ops, tous);
      months[m].g1c += group1['充'];
      months[m].g1f += group1['放'];
      months[m].g2c += group2['充'];
      months[m].g2f += group2['放'];
      months[m].tou['尖'] += tou['尖'];
      months[m].tou['峰'] += tou['峰'];
      months[m].tou['平'] += tou['平'];
      months[m].tou['谷'] += tou['谷'];
      months[m].tou['深'] += tou['深'];
    }
    return months;
  }, [dayBuckets]);

  // 月份 -> 当月每日明细（按自然日 YYYY-MM-DD，跨年会有多个相同“月”的不同年份日期）
  const dailyByMonth = useMemo(() => {
    const map = new Map<number, Array<{ key: string; ymd: string; g1c: number; g1f: number; g2c: number; g2f: number; tou: Record<TierId, number> }>>();
    for (let m = 0; m < 12; m++) map.set(m, []);
    for (const [key, { date, loads, tous, ops }] of dayBuckets.entries()) {
      const m = date.getMonth();
      const { group1, group2, tou } = summarizeDay(loads, ops, tous);
      map.get(m)!.push({
        key,
        ymd: key,
        g1c: group1['充'],
        g1f: group1['放'],
        g2c: group2['充'],
        g2f: group2['放'],
        tou,
      });
    }
    // 每个月内部按日期升序排序
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
    }
    return map;
  }, [dayBuckets]);

  // 折叠/展开：整段统计面板
  const [collapsed, setCollapsed] = useState(false);
  // 月份行展开：显示当月每日明细
  const [expandedMonths, setExpandedMonths] = useState<Set<number>>(new Set());
  const toggleMonth = (m: number) => {
    setExpandedMonths(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };

  return (
    <div className="p-6 bg-white rounded-xl shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold text-slate-800">月度统计表</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              // 中文：导出包含“月度统计”“每日统计”的 Excel
              exportEnergySummaryToExcel(
                'energy_summary',
                monthlyAgg,
                dailyByMonth,
              );
            }}
            className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
          >导出统计 Excel</button>
          <button
            onClick={() => setCollapsed(c => !c)}
            className="px-3 py-1.5 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            {collapsed ? '展开' : '折叠'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-auto">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-600">
                  <th className="px-2 py-2 text-left align-bottom border-b border-slate-200">月份</th>
                  <th className="px-2 py-2 text-center align-bottom border-b border-slate-200" colSpan={4}>储能逻辑区间总用量汇总</th>
                  <th className="px-2 py-2 text-center align-bottom border-b border-slate-200" colSpan={5}>TOU时段用电量汇总</th>
                </tr>
                <tr className="bg-slate-50 text-xs text-slate-600">
                  <th className="px-2 py-1 text-left border-b border-slate-200"> </th>
                  <th className="px-2 py-1 text-center border-b border-slate-200">
                    <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('充')?.color} ${OPERATING_LOGIC_MAP.get('充')?.textColor}`}>充</span>
                    <span className="ml-1">(1)</span>
                  </th>
                  <th className="px-2 py-1 text-center border-b border-slate-200">
                    <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('放')?.color} ${OPERATING_LOGIC_MAP.get('放')?.textColor}`}>放</span>
                    <span className="ml-1">(1)</span>
                  </th>
                  <th className="px-2 py-1 text-center border-b border-slate-200">
                    <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('充')?.color} ${OPERATING_LOGIC_MAP.get('充')?.textColor}`}>充</span>
                    <span className="ml-1">(2)</span>
                  </th>
                  <th className="px-2 py-1 text-center border-b border-slate-200">
                    <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('放')?.color} ${OPERATING_LOGIC_MAP.get('放')?.textColor}`}>放</span>
                    <span className="ml-1">(2)</span>
                  </th>
                  {(['尖','峰','平','谷','深'] as TierId[]).map(id => {
                    const t = TIER_MAP.get(id);
                    return (
                      <th key={id} className="px-2 py-1 text-center border-b border-slate-200">
                        <span className={`px-1 rounded ${t?.color ?? ''} ${t?.textColor ?? ''}`}>{id}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 12 }, (_, m) => (
                  <React.Fragment key={m}>
                    <tr
                      className="odd:bg-white even:bg-slate-50/40 cursor-pointer hover:bg-slate-100"
                      onClick={() => toggleMonth(m)}
                    >
                      <td className="px-2 py-2 text-sm text-slate-800 border-b border-slate-100">{m + 1}月</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].g1c.toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].g1f.toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].g2c.toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].g2f.toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].tou['尖'].toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].tou['峰'].toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].tou['平'].toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].tou['谷'].toFixed(1)}</td>
                      <td className="px-2 py-2 text-sm text-right border-b border-slate-100">{monthlyAgg[m].tou['深'].toFixed(1)}</td>
                    </tr>
                    {expandedMonths.has(m) && (
                      <tr>
                        <td className="px-0 py-0 border-b border-slate-100" colSpan={10}>
                          <div className="px-2 py-3">
                            <div className="text-xs text-slate-500 mb-2">{m + 1}月每日统计（点击月份行可收起）</div>
                            <div className="border border-slate-200 rounded-md overflow-auto">
                              <table className="min-w-full border-collapse">
                                <thead>
                                  <tr className="bg-slate-50 text-xs text-slate-600">
                                    <th className="px-2 py-2 text-left align-bottom border-b border-slate-200">日期</th>
                                    <th className="px-2 py-2 text-center align-bottom border-b border-slate-200" colSpan={4}>储能逻辑区间总用量汇总</th>
                                    <th className="px-2 py-2 text-center align-bottom border-b border-slate-200" colSpan={5}>TOU时段用电量汇总</th>
                                  </tr>
                                  <tr className="bg-slate-50 text-xs text-slate-600">
                                    <th className="px-2 py-1 text-left border-b border-slate-200"> </th>
                                    <th className="px-2 py-1 text-center border-b border-slate-200">
                                      <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('充')?.color} ${OPERATING_LOGIC_MAP.get('充')?.textColor}`}>充</span>
                                      <span className="ml-1">(1)</span>
                                    </th>
                                    <th className="px-2 py-1 text-center border-b border-slate-200">
                                      <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('放')?.color} ${OPERATING_LOGIC_MAP.get('放')?.textColor}`}>放</span>
                                      <span className="ml-1">(1)</span>
                                    </th>
                                    <th className="px-2 py-1 text-center border-b border-slate-200">
                                      <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('充')?.color} ${OPERATING_LOGIC_MAP.get('充')?.textColor}`}>充</span>
                                      <span className="ml-1">(2)</span>
                                    </th>
                                    <th className="px-2 py-1 text-center border-b border-slate-200">
                                      <span className={`px-1 rounded ${OPERATING_LOGIC_MAP.get('放')?.color} ${OPERATING_LOGIC_MAP.get('放')?.textColor}`}>放</span>
                                      <span className="ml-1">(2)</span>
                                    </th>
                                    {(['尖','峰','平','谷','深'] as TierId[]).map(id => {
                                      const t = TIER_MAP.get(id);
                                      return (
                                        <th key={id} className="px-2 py-1 text-center border-b border-slate-200">
                                          <span className={`px-1 rounded ${t?.color ?? ''} ${t?.textColor ?? ''}`}>{id}</span>
                                        </th>
                                      );
                                    })}
                                  </tr>
                                </thead>
                                <tbody>
                                  {(dailyByMonth.get(m) || []).map((d) => (
                                    <tr key={d.key} className="odd:bg-white even:bg-slate-50/40">
                                      <td className="px-2 py-1 text-xs text-slate-800 border-b border-slate-100">{d.ymd}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.g1c.toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.g1f.toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.g2c.toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.g2f.toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.tou['尖'].toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.tou['峰'].toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.tou['平'].toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.tou['谷'].toFixed(1)}</td>
                                      <td className="px-2 py-1 text-xs text-right border-b border-slate-100">{d.tou['深'].toFixed(1)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthlySummaryTable;
