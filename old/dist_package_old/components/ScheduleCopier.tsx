import React, { useState, useCallback } from 'react';
import { MONTHS } from '../constants';

interface ScheduleCopierProps {
  onCopy: (sourceMonthIndex: number, targetMonthIndices: number[]) => void;
}

export const ScheduleCopier: React.FC<ScheduleCopierProps> = ({ onCopy }) => {
  const [sourceMonthIndex, setSourceMonthIndex] = useState<number>(0);
  const [targetMonthIndices, setTargetMonthIndices] = useState<Set<number>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [copyButtonText, setCopyButtonText] = useState('Copy Schedule');

  const handleToggleTarget = useCallback((monthIndex: number) => {
    setTargetMonthIndices(prev => {
      const newSet = new Set(prev);
      if (newSet.has(monthIndex)) {
        newSet.delete(monthIndex);
      } else {
        newSet.add(monthIndex);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allMonths = new Set(MONTHS.map((_, i) => i));
    setTargetMonthIndices(allMonths);
  }, []);

  const handleDeselectAll = useCallback(() => {
    setTargetMonthIndices(new Set());
  }, []);

  const handleCopy = useCallback(() => {
    const targets = Array.from(targetMonthIndices);
    if (targets.length === 0) return;

    onCopy(sourceMonthIndex, targets);
    
    setFeedback('Schedule copied successfully!');
    setCopyButtonText('Copied!');
    setTimeout(() => {
        setFeedback('');
        setCopyButtonText('Copy Schedule');
    }, 2500);

  }, [sourceMonthIndex, targetMonthIndices, onCopy]);

  const canCopy = targetMonthIndices.size > 0 && copyButtonText === 'Copy Schedule';

  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-700 mb-3">Copy Monthly Schedule</h3>
        <div className="flex flex-col md:flex-row md:items-start gap-4">
            {/* Source Selection */}
            <div className="flex-1">
                <label htmlFor="source-month" className="block text-sm font-medium text-slate-700">Copy from:</label>
                <select
                    id="source-month"
                    value={sourceMonthIndex}
                    onChange={(e) => setSourceMonthIndex(Number(e.target.value))}
                    className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                    {MONTHS.map((month, index) => (
                        <option key={month} value={index}>{month}</option>
                    ))}
                </select>
            </div>

            {/* Target Selection */}
            <div className="flex-[2_2_0%]">
                 <div className="flex justify-between items-center mb-1">
                    <label className="block text-sm font-medium text-slate-700">Paste to:</label>
                    <div className="flex gap-2">
                        <button onClick={handleSelectAll} className="text-xs font-semibold text-blue-600 hover:underline">Select All</button>
                        <button onClick={handleDeselectAll} className="text-xs font-semibold text-blue-600 hover:underline">Deselect All</button>
                    </div>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 p-2 border border-slate-200 rounded-md bg-white">
                    {MONTHS.map((month, index) => (
                        <label key={month} className="flex items-center gap-2 p-1 rounded-md hover:bg-slate-100 transition-colors cursor-pointer">
                            <input
                                type="checkbox"
                                checked={targetMonthIndices.has(index)}
                                onChange={() => handleToggleTarget(index)}
                                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="text-sm text-slate-800">{month}</span>
                        </label>
                    ))}
                </div>
            </div>
        </div>
        
        <div className="mt-4 flex items-center justify-end gap-4">
            {feedback && <p className="text-sm text-green-600 font-medium">{feedback}</p>}
            <button
                onClick={handleCopy}
                disabled={!canCopy}
                className="px-4 py-2 bg-blue-500 text-white rounded-md font-semibold text-sm hover:bg-blue-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {copyButtonText}
            </button>
        </div>
    </div>
  );
};
