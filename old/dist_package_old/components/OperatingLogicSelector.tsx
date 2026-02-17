import React from 'react';
import type { OperatingLogicId } from '../types';
import { OPERATING_LOGIC_DEFINITIONS } from '../constants';

interface OperatingLogicSelectorProps {
  selectedOpLogic: OperatingLogicId;
  onOpLogicSelect: (opLogicId: OperatingLogicId) => void;
}

export const OperatingLogicSelector: React.FC<OperatingLogicSelectorProps> = ({ selectedOpLogic, onOpLogicSelect }) => {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
      <h2 className="text-lg font-semibold text-slate-700 mb-3 sm:mb-0">Select a Storage Logic to Apply:</h2>
      <div className="flex flex-wrap gap-2">
        {OPERATING_LOGIC_DEFINITIONS.map((op) => (
          <button
            key={op.id}
            onClick={() => onOpLogicSelect(op.id)}
            className={`px-4 py-2 rounded-md font-bold text-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
              op.color
            } ${op.textColor} ${
              selectedOpLogic === op.id
                ? 'ring-2 ring-blue-500 shadow-md'
                : 'hover:opacity-80'
            }`}
          >
            {op.id} ({op.name})
          </button>
        ))}
      </div>
    </div>
  );
};
