import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { OperatingLogicId, Schedule, TierId } from '../types';
import {
  MONTHS,
  OPERATING_LOGIC_DEFINITIONS,
  OPERATING_LOGIC_MAP,
  TIER_DEFINITIONS,
  TIER_MAP,
} from '../constants';

type EditMode = 'tou' | 'op';

export type ScheduleEditorPageProps = {
  schedule: Schedule;
  onScheduleChange: (next: Schedule) => void;

  editMode: EditMode;
  setEditMode: (mode: EditMode) => void;

  selectedTier: TierId;
  setSelectedTier: (tier: TierId) => void;

  selectedOpLogic: OperatingLogicId;
  setSelectedOpLogic: (op: OperatingLogicId) => void;
};

type GroupRow = {
  id: string;
  label: string;
  monthIndices: number[];
  isMerged: boolean;
  scheduleRow: Schedule[number];
};

const HOUR_INDEXES: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

const opSymbol = (op: OperatingLogicId) => {
  return (
    {
      待机: '○',
      充: '+',
      放: '−',
    } as const
  )[op];
};

export const ScheduleEditorPage: React.FC<ScheduleEditorPageProps> = ({
  schedule,
  onScheduleChange,
  editMode,
  setEditMode,
  selectedTier,
  setSelectedTier,
  selectedOpLogic,
  setSelectedOpLogic,
}) => {
  const [isCompactMode, setIsCompactMode] = useState(true);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // 智能策略生成器：TOU -> 储能动作 映射规则
  const [showSmartPanel, setShowSmartPanel] = useState(false);
  const [strategyRules, setStrategyRules] = useState<Record<TierId, OperatingLogicId>>({
    '深': '充',
    '谷': '充',
    '平': '待机',
    '峰': '放',
    '尖': '放',
  });

  useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  // 切换到 TOU 模式时，自动收起智能面板（与文档一致：该面板仅在 Storage 模式出现）
  useEffect(() => {
    if (editMode !== 'op' && showSmartPanel) setShowSmartPanel(false);
  }, [editMode, showSmartPanel]);

  const groupedRows = useMemo<GroupRow[]>(() => {
    const rows: GroupRow[] = [];

    const toFingerprint = (monthIndex: number) => {
      const row = schedule?.[monthIndex] || [];
      return row.map((c) => `${c.tou}|${c.op}`).join(',');
    };

    if (!isCompactMode) {
      return MONTHS.map((m, i) => ({
        id: `single-${i}`,
        label: m,
        monthIndices: [i],
        isMerged: false,
        scheduleRow: schedule[i],
      }));
    }

    const processed = new Set<number>();
    for (let i = 0; i < MONTHS.length; i++) {
      if (processed.has(i)) continue;

      const fp = toFingerprint(i);
      const same: number[] = [i];
      for (let j = i + 1; j < MONTHS.length; j++) {
        if (processed.has(j)) continue;
        if (toFingerprint(j) === fp) {
          same.push(j);
          processed.add(j);
        }
      }

      rows.push({
        id: `group-${i}`,
        label: same.map((idx) => MONTHS[idx]).join(', '),
        monthIndices: same,
        isMerged: same.length > 1,
        scheduleRow: schedule[i],
      });
      processed.add(i);
    }

    return rows;
  }, [isCompactMode, schedule]);

  const updateCells = useCallback(
    (monthIndices: number[], hourIndex: number) => {
      const monthSet = new Set(monthIndices);

      // 先判断是否真的有变化，避免每次 mouseenter 都触发全量 setState
      let hasAnyChange = false;
      for (const m of monthIndices) {
        const cell = schedule?.[m]?.[hourIndex];
        if (!cell) continue;
        if (editMode === 'tou') {
          if (cell.tou !== selectedTier) {
            hasAnyChange = true;
            break;
          }
        } else {
          if (cell.op !== selectedOpLogic) {
            hasAnyChange = true;
            break;
          }
        }
      }
      if (!hasAnyChange) return;

      const next = schedule.map((row, mIdx) => {
        if (!monthSet.has(mIdx)) return row;

        return row.map((cell, hIdx) => {
          if (hIdx !== hourIndex) return cell;
          return editMode === 'tou'
            ? { ...cell, tou: selectedTier }
            : { ...cell, op: selectedOpLogic };
        });
      });

      onScheduleChange(next);
    },
    [editMode, onScheduleChange, schedule, selectedOpLogic, selectedTier],
  );

  const handleMouseDown = useCallback(
    (monthIndices: number[], hourIndex: number) => {
      setIsDragging(true);
      updateCells(monthIndices, hourIndex);
    },
    [updateCells],
  );

  const handleMouseEnterCell = useCallback(
    (monthIndices: number[], hourIndex: number) => {
      setHoveredCol(hourIndex);
      if (isDragging) {
        updateCells(monthIndices, hourIndex);
      }
    },
    [isDragging, updateCells],
  );

  const applySmartStrategy = useCallback(() => {
    const next = schedule.map((row) =>
      row.map((cell) => {
        const mapped = strategyRules[cell.tou as TierId];
        const op = mapped ?? '待机';
        if (cell.op === op) return cell;
        return { ...cell, op };
      }),
    );
    onScheduleChange(next);
    setShowSmartPanel(false);
    window.alert('策略已成功应用！(All months updated based on TOU)');
  }, [onScheduleChange, schedule, strategyRules]);

  return (
    <div className="space-y-4 select-none">
      {/* 顶部工具栏 */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
        {/* 第一行：模式切换 + 折叠开关 */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b border-slate-100 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex bg-slate-100 p-1 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setEditMode('tou')}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all ${
                  editMode === 'tou'
                    ? 'bg-white shadow text-blue-700'
                    : 'text-slate-600 hover:text-slate-800'
                }`}
              >
                TOU Schedule
              </button>
              <button
                type="button"
                onClick={() => setEditMode('op')}
                className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all ${
                  editMode === 'op'
                    ? 'bg-white shadow text-orange-700'
                    : 'text-slate-600 hover:text-slate-800'
                }`}
              >
                Storage Logic
              </button>
            </div>

            <div className="text-sm text-slate-500 bg-slate-50 px-3 py-1 rounded border border-slate-200">
              <button
                type="button"
                className="hover:text-blue-700 transition-colors"
                onClick={() => setIsCompactMode((v) => !v)}
              >
                {isCompactMode ? '智能折叠模式' : '完整视图模式'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editMode === 'op' && (
              <button
                type="button"
                onClick={() => setShowSmartPanel((v) => !v)}
                className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all border ${
                  showSmartPanel
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {showSmartPanel ? '关闭智能策略' : '⚡ 智能策略生成'}
              </button>
            )}

            <div className="text-xs text-slate-500">拖拽可刷格；悬停高亮列与表头</div>
          </div>
        </div>

        {/* 智能策略生成器面板（仅 Storage Logic 模式） */}
        {showSmartPanel && editMode === 'op' && (
          <div className="bg-blue-50/50 rounded-lg p-4 border border-blue-100">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
              <div className="text-sm font-bold text-slate-700">
                策略映射规则配置（TOU → Storage Action）
              </div>
              <button
                type="button"
                onClick={applySmartStrategy}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm font-bold transition-colors shadow-sm"
              >
                一键应用到全年
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {TIER_DEFINITIONS.map((tier) => (
                <div key={tier.id} className="bg-white p-2 rounded border border-slate-200 shadow-sm flex flex-col gap-2">
                  <div className={`text-xs font-bold px-2 py-1 rounded ${tier.color} ${tier.textColor} text-center`}>
                    当电价为：{tier.id} ({tier.name})
                  </div>
                  <div className="text-center text-slate-300 text-xs">↓</div>
                  <select
                    className="text-xs border border-slate-200 rounded p-2 bg-slate-50 focus:border-blue-500 outline-none"
                    value={strategyRules[tier.id]}
                    onChange={(e) =>
                      setStrategyRules((prev) => ({
                        ...prev,
                        [tier.id]: e.target.value as OperatingLogicId,
                      }))
                    }
                  >
                    {OPERATING_LOGIC_DEFINITIONS.map((op) => (
                      <option key={op.id} value={op.id}>
                        设为：{op.id} ({op.name})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="mt-2 text-[10px] text-slate-500">
              * 此操作将覆盖当前全年储能配置，但之后仍可用画笔手动微调。
            </div>
          </div>
        )}

        {/* 第二行：动态画笔选择器 */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <span className="text-sm font-semibold text-slate-600 min-w-fit">
            {editMode === 'tou' ? '选择电价类型：' : '选择充放动作：'}
          </span>

          <div className="flex flex-wrap gap-2">
            {editMode === 'tou' ? (
              TIER_DEFINITIONS.map((tier) => (
                <button
                  key={tier.id}
                  onClick={() => setSelectedTier(tier.id)}
                  className={`px-4 py-2 rounded-md font-bold text-sm transition-all duration-150 border ${
                    tier.color
                  } ${tier.textColor} ${
                    selectedTier === tier.id
                      ? 'ring-2 ring-blue-500 ring-offset-2 border-black/10'
                      : 'hover:opacity-80 border-transparent'
                  }`}
                >
                  {tier.id} ({tier.name})
                </button>
              ))
            ) : (
              OPERATING_LOGIC_DEFINITIONS.map((op) => (
                <button
                  key={op.id}
                  type="button"
                  onClick={() => setSelectedOpLogic(op.id)}
                  className={`px-4 py-2 rounded-md font-bold text-sm transition-all duration-150 border ${
                    op.color
                  } ${op.textColor} ${
                    selectedOpLogic === op.id
                      ? 'border-blue-500 ring-2 ring-blue-500 ring-offset-2'
                      : 'border-transparent hover:opacity-80'
                  }`}
                >
                  {opSymbol(op.id)} {op.id} ({op.name})
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 主表格区域 */}
      <div
        className="bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden"
        onMouseLeave={() => setHoveredCol(null)}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[980px]">
            <thead>
              <tr className="bg-slate-50">
                <th className="p-3 border-b border-r border-slate-200 text-left w-48 sticky left-0 bg-slate-50 z-20">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {isCompactMode ? 'Month Groups' : 'Month'}
                  </span>
                </th>
                {HOUR_INDEXES.map((h) => (
                  <th
                    key={h}
                    className={`border-b border-slate-200 text-xs font-semibold transition-all duration-150 relative ${
                      hoveredCol === h
                        ? 'bg-blue-600 text-white scale-110 z-10 shadow-md'
                        : 'bg-slate-50 text-slate-600'
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center py-2">
                      <span>{h}</span>
                      {hoveredCol === h && (
                        <div className="absolute -bottom-1 w-2 h-2 bg-blue-600 rotate-45 transform" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {groupedRows.map((group) => (
                <tr key={group.id} className="hover:bg-slate-50/40 transition-colors">
                  {/* 行标题 */}
                  <td className="border-r border-b border-slate-100 bg-white p-2 sticky left-0 z-10">
                    <div className="flex flex-col items-start justify-center min-h-[3rem]">
                      <span
                        className={`text-sm font-semibold whitespace-normal break-words leading-snug ${
                          group.isMerged ? 'text-blue-700' : 'text-slate-700'
                        }`}
                      >
                        {group.label}
                      </span>
                      {group.isMerged && (
                        <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 rounded-full mt-0.5 border border-blue-100">
                          {group.monthIndices.length} months
                        </span>
                      )}
                    </div>
                  </td>

                  {/* 24小时格子 */}
                  {HOUR_INDEXES.map((hourIndex) => {
                    const cell = group.scheduleRow?.[hourIndex];
                    if (!cell) {
                      return (
                        <td
                          key={hourIndex}
                          className="border-b border-slate-100 bg-slate-100 h-12"
                        />
                      );
                    }

                    const tierInfo = TIER_MAP.get(cell.tou);
                    const opInfo = OPERATING_LOGIC_MAP.get(cell.op);

                    const tierBg = tierInfo?.color || 'bg-slate-200';
                    const isHovered = hoveredCol === hourIndex;

                    return (
                      <td
                        key={hourIndex}
                        onMouseDown={() => handleMouseDown(group.monthIndices, hourIndex)}
                        onMouseEnter={() => handleMouseEnterCell(group.monthIndices, hourIndex)}
                        className={`relative border-b border-slate-100 text-center cursor-crosshair ${tierBg}`}
                      >
                        {/* 整列高亮遮罩层 */}
                        {isHovered && (
                          <div className="absolute inset-0 bg-blue-900/10 border-x-2 border-blue-500/50 pointer-events-none z-10" />
                        )}

                        {/* 内容 */}
                        <div className="h-12 flex items-center justify-center text-xs font-semibold relative z-20">
                          {editMode === 'tou' ? (
                            <span className="text-slate-700/60">{cell.tou}</span>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center relative">
                              {/* 背景淡化遮罩：保持 TOU 底色可见 */}
                              <div className="absolute inset-0 bg-white/60" />
                              <div className={`relative flex flex-col items-center ${opInfo?.textColor || 'text-slate-700'}`}>
                                <span className="text-base leading-none">{opSymbol(cell.op)}</span>
                                {cell.op !== '待机' && (
                                  <span className="text-[9px] font-bold leading-none mt-0.5">
                                    {cell.op}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-slate-500 px-3 py-2 bg-slate-50 border border-slate-200 rounded">
        <strong>操作提示：</strong>{' '}
        {editMode === 'tou'
          ? '当前正在配置「电价时段」。拖拽可快速刷整段；悬停可高亮列与表头。'
          : '当前正在配置「储能策略」。底色仍显示电价以供参考，请选择合适的充电/放电时机。'}
      </div>
    </div>
  );
};
