import React, { memo } from 'react';
import type { CellData } from '../types';
import { TIER_MAP, OPERATING_LOGIC_MAP } from '../constants';

interface MergedGridCellProps {
  cellData: CellData;
  startHour: number;
  endHour: number;
  span: number;
  isDimmed: boolean;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const MergedGridCellComponent: React.FC<MergedGridCellProps> = ({ cellData, startHour, endHour, span, isDimmed, onMouseDown, onMouseMove }) => {
  const tierInfo = TIER_MAP.get(cellData.tou);
  const opLogicInfo = OPERATING_LOGIC_MAP.get(cellData.op);

  if (!tierInfo || !opLogicInfo) {
    return <div className="h-14 border-b border-r border-slate-300 bg-gray-100 flex items-center justify-center" style={{ gridColumn: `span ${span}` }}>?</div>;
  }

  const opLogicSymbol = {
    '待机': '○',
    '充': '+',
    '放': '−',
  }[cellData.op];

  const timeRange = `${startHour}-${endHour + 1}`;

  return (
    <div
      style={{ gridColumn: `span ${span}` }}
      className={`h-14 flex flex-col items-center justify-center font-sans font-semibold text-base cursor-crosshair border-b border-r border-slate-300 transition-all duration-150 ${isDimmed ? 'opacity-30' : 'hover:shadow-lg hover:z-20'}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    >
      <div className={`w-full h-1/2 flex items-center justify-center ${tierInfo.color} ${tierInfo.textColor}`}>
        <span className="truncate px-1">{cellData.tou}</span>
        {span > 2 && <span className="text-xs opacity-80 ml-1 truncate">({timeRange})</span>}
      </div>
      <div className={`w-full h-1/2 flex items-center justify-center text-lg ${opLogicInfo.color} ${opLogicInfo.textColor}`}>
        {opLogicSymbol}
      </div>
    </div>
  );
};

export const MergedGridCell = memo(MergedGridCellComponent);