import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { Schedule, TierId, DateRule, OperatingLogicId } from '../types';
import { MONTHS, HOURS } from '../constants';
import { MergedGridCell } from './MergedGridCell';

interface TouGridProps {
  schedule: Schedule;
  dateRules: DateRule[];
  onScheduleChange: (newSchedule: Schedule) => void;
  selectedTier: TierId;
  selectedOpLogic: OperatingLogicId;
  editMode: 'tou' | 'op';
}

export const TouGrid: React.FC<TouGridProps> = ({ schedule, dateRules, onScheduleChange, selectedTier, selectedOpLogic, editMode }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [dimmedMonths, setDimmedMonths] = useState<Set<number>>(new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const timeHeaderRef = useRef<HTMLDivElement>(null);
  const [gridMetrics, setGridMetrics] = useState<{ labelWidth: number; colWidth: number }>({
    labelWidth: 0,
    colWidth: 48,
  });

  const affectedMonths = useMemo(() => {
    const affected = new Map<number, string[]>();
    dateRules.forEach(rule => {
      const start = new Date(rule.startDate);
      const end = new Date(rule.endDate);
      const startMonth = start.getUTCMonth();
      const endMonth = end.getUTCMonth();
      const startYear = start.getUTCFullYear();
      const endYear = end.getUTCFullYear();

      for (let y = startYear; y <= endYear; y++) {
        const monthStart = (y === startYear) ? startMonth : 0;
        const monthEnd = (y === endYear) ? endMonth : 11;
        for (let m = monthStart; m <= monthEnd; m++) {
          if (!affected.has(m)) {
            affected.set(m, []);
          }
          if (!affected.get(m)!.includes(rule.name)) {
            affected.get(m)!.push(rule.name);
          }
        }
      }
    });
    return affected;
  }, [dateRules]);

  const handleToggleMonth = useCallback((monthIndex: number) => {
    setDimmedMonths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(monthIndex)) {
        newSet.delete(monthIndex);
      } else {
        newSet.add(monthIndex);
      }
      return newSet;
    });
  }, []);

  const recomputeMetrics = useCallback(() => {
    const grid = gridRef.current;
    const timeHeader = timeHeaderRef.current;
    if (!grid || !timeHeader) return;

    const gridRect = grid.getBoundingClientRect();
    const labelWidth = timeHeader.getBoundingClientRect().width;
    const usableWidth = Math.max(0, gridRect.width - labelWidth);
    const colWidth = usableWidth > 0 ? usableWidth / HOURS.length : 48;
    setGridMetrics({ labelWidth, colWidth });
  }, []);

  useEffect(() => {
    recomputeMetrics();
    window.addEventListener('resize', recomputeMetrics);
    return () => window.removeEventListener('resize', recomputeMetrics);
  }, [recomputeMetrics]);

  useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  const getHourFromMouseEvent = (e: React.MouseEvent<HTMLDivElement>, startHour: number, endHour: number): number => {
    const span = endHour - startHour + 1;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hourWidth = rect.width / span;
    const clickedHourIndexInSpan = Math.floor(x / hourWidth);
    const clampedIndex = Math.max(0, Math.min(clickedHourIndexInSpan, span - 1));
    return startHour + clampedIndex;
  };

  const paintAt = useCallback((monthIndex: number, hourIndex: number) => {
    const cur = schedule?.[monthIndex]?.[hourIndex];
    if (!cur) return;

    if (editMode === 'tou') {
      if (cur.tou === selectedTier) return;
    } else {
      if (cur.op === selectedOpLogic) return;
    }

    const next = schedule.map((row, rIdx) => {
      if (rIdx !== monthIndex) return row;
      return row.map((cell, cIdx) => {
        if (cIdx !== hourIndex) return cell;
        return editMode === 'tou' ? { ...cell, tou: selectedTier } : { ...cell, op: selectedOpLogic };
      });
    });
    onScheduleChange(next);
  }, [editMode, onScheduleChange, schedule, selectedOpLogic, selectedTier]);

  const handleCellMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, monthIndex: number, startHour: number, endHour: number) => {
    recomputeMetrics();
    setIsDragging(true);
    const hour = getHourFromMouseEvent(e, startHour, endHour);
    setHoveredCol(hour);
    paintAt(monthIndex, hour);
  }, [paintAt, recomputeMetrics]);

  const handleCellMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>, monthIndex: number, startHour: number, endHour: number) => {
    const hour = getHourFromMouseEvent(e, startHour, endHour);
    setHoveredCol(hour);
    if (isDragging) {
      paintAt(monthIndex, hour);
    }
  }, [isDragging, paintAt]);


  return (
    <div 
      ref={gridRef}
      className="relative grid select-none border-t border-l border-slate-300" 
      style={{ gridTemplateColumns: `auto repeat(${HOURS.length}, minmax(48px, 1fr))` }}
      onMouseLeave={() => setHoveredCol(null)}
    >
      {hoveredCol != null && gridMetrics.colWidth > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{
            left: gridMetrics.labelWidth + hoveredCol * gridMetrics.colWidth,
            width: gridMetrics.colWidth,
          }}
        >
          <div className="absolute inset-0 bg-blue-900/10" />
          <div className="absolute inset-y-0 left-0 w-[2px] bg-blue-500/40" />
          <div className="absolute inset-y-0 right-0 w-[2px] bg-blue-500/40" />
        </div>
      )}

      {/* Header Row */}
      <div ref={timeHeaderRef} className="sticky top-0 z-20 bg-slate-100 font-semibold text-slate-600 text-sm p-2 border-b border-r border-slate-300 flex items-center justify-center h-14">Time</div>
      {HOURS.map((hour) => (
        <div
          key={hour}
          onMouseEnter={() => setHoveredCol(hour)}
          className={`sticky top-0 z-20 text-center font-semibold text-sm p-2 border-b border-r border-slate-300 flex items-center justify-center h-14 transition-all duration-150 relative ${
            hoveredCol === hour
              ? 'bg-blue-600 text-white scale-110 shadow-md'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {hour}-{hour + 1}
        </div>
      ))}
      
      {/* Grid Body */}
      {schedule.map((monthSchedule, monthIndex) => {
        const affectingRules = affectedMonths.get(monthIndex);
        const tooltipText = affectingRules ? `Affected by: ${affectingRules.join(', ')}` : '';
        const monthLabelBg = monthIndex % 2 === 0 ? 'bg-slate-100' : 'bg-white';
        const isDimmed = dimmedMonths.has(monthIndex);
        
        const monthCells = [];
        let h = 0;
        while (h < HOURS.length) {
            const startHour = h;
            const currentCellData = monthSchedule[h];
            let span = 1;
            while (h + span < HOURS.length && 
                    monthSchedule[h + span].tou === currentCellData.tou &&
                    monthSchedule[h + span].op === currentCellData.op) {
                span++;
            }
            const endHour = h + span - 1;

            monthCells.push(
                <MergedGridCell
                    key={`${monthIndex}-${startHour}`}
                    cellData={currentCellData}
                    startHour={startHour}
                    endHour={endHour}
                    span={span}
                    isDimmed={isDimmed}
                onMouseDown={(e) => handleCellMouseDown(e, monthIndex, startHour, endHour)}
                onMouseMove={(e) => handleCellMouseMove(e, monthIndex, startHour, endHour)}
                />
            );
            
            h += span;
        }

        return (
          <React.Fragment key={MONTHS[monthIndex]}>
            <div 
              className={`sticky left-0 ${monthLabelBg} font-semibold text-slate-600 text-sm p-2 border-b border-r border-slate-300 flex items-center justify-center cursor-pointer hover:bg-slate-200 transition-colors`}
              title={tooltipText || 'Click to dim/un-dim month'}
              onClick={() => handleToggleMonth(monthIndex)}
            >
              <span className="flex items-center gap-2">
                {MONTHS[monthIndex]}
                {affectingRules && <span className="text-blue-500 font-bold">*</span>}
              </span>
            </div>
            {monthCells}
          </React.Fragment>
        )
      })}
    </div>
  );
};