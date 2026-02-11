import React, { useState, useEffect, useCallback } from 'react';
import type { DateRule, TierId, CellData, OperatingLogicId } from '../types';
import { HOURS, TIER_MAP, TIER_DEFINITIONS, OPERATING_LOGIC_MAP, OPERATING_LOGIC_DEFINITIONS } from '../constants';

interface DateRuleModalProps {
  isOpen: boolean;
  rule: DateRule | null;
  onClose: () => void;
  onSave: (rule: DateRule) => void;
}

const RuleScheduleEditor: React.FC<{
  schedule: CellData[];
  onChange: (newSchedule: CellData[]) => void;
  selectedTier: TierId;
  selectedOpLogic: OperatingLogicId;
  editMode: 'tou' | 'op';
}> = ({ schedule, onChange, selectedTier, selectedOpLogic, editMode }) => {
    const [isSelecting, setIsSelecting] = useState(false);
    const [startIdx, setStartIdx] = useState(-1);

    const handleMouseUp = useCallback(() => {
        setIsSelecting(false);
        setStartIdx(-1);
    }, []);
    
    const handleMouseLeave = useCallback(() => {
        if (isSelecting) {
            setIsSelecting(false);
            setStartIdx(-1);
        }
    }, [isSelecting]);

    const handleMouseDown = useCallback((index: number) => {
        setIsSelecting(true);
        setStartIdx(index);
        const newSchedule = schedule.map(cell => ({ ...cell }));
        if (editMode === 'tou') {
            newSchedule[index].tou = selectedTier;
        } else {
            newSchedule[index].op = selectedOpLogic;
        }
        onChange(newSchedule);
    }, [selectedTier, selectedOpLogic, editMode, schedule, onChange]);

    const handleMouseEnter = useCallback((index: number) => {
        if (isSelecting && startIdx !== -1) {
            const newSchedule = schedule.map(cell => ({ ...cell }));
            const min = Math.min(startIdx, index);
            const max = Math.max(startIdx, index);
            for (let i = min; i <= max; i++) {
                if (editMode === 'tou') {
                    newSchedule[i].tou = selectedTier;
                } else {
                    newSchedule[i].op = selectedOpLogic;
                }
            }
            onChange(newSchedule);
        }
    }, [isSelecting, startIdx, selectedTier, selectedOpLogic, editMode, schedule, onChange]);

    return (
        <div className="flex border-t border-l border-slate-300 select-none" onMouseUp={handleMouseUp} onMouseLeave={handleMouseLeave}>
            {schedule.map((cellData, index) => {
                const tierInfo = TIER_MAP.get(cellData.tou)!;
                const opLogicInfo = OPERATING_LOGIC_MAP.get(cellData.op)!;
                 const opLogicSymbol = {
                    '待机': '○',
                    '充': '+',
                    '放': '−',
                }[cellData.op];

                return (
                    <div
                        key={index}
                        className="flex-1 h-14 flex flex-col items-center justify-center font-sans font-semibold text-base cursor-pointer border-b border-r border-slate-300 transition-all duration-150 hover:scale-105 hover:shadow-md hover:z-20"
                        onMouseDown={() => handleMouseDown(index)}
                        onMouseEnter={() => handleMouseEnter(index)}
                    >
                         <div className={`w-full h-1/2 flex items-center justify-center ${tierInfo.color} ${tierInfo.textColor}`}>
                            {cellData.tou}
                        </div>
                        <div className={`w-full h-1/2 flex items-center justify-center text-lg ${opLogicInfo.color} ${opLogicInfo.textColor}`}>
                            {opLogicSymbol}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export const DateRuleModal: React.FC<DateRuleModalProps> = ({ isOpen, rule, onClose, onSave }) => {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [schedule, setSchedule] = useState<CellData[]>(() => Array(24).fill({ tou: '平', op: '待机' }));
  const [modalSelectedTier, setModalSelectedTier] = useState<TierId>('谷');
  const [modalSelectedOpLogic, setModalSelectedOpLogic] = useState<OperatingLogicId>('待机');
  const [modalEditMode, setModalEditMode] = useState<'tou' | 'op'>('tou');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
        if (rule) {
            setName(rule.name);
            setStartDate(rule.startDate);
            setEndDate(rule.endDate);
            setSchedule(rule.schedule);
        } else {
            // Reset for new rule
            const today = new Date().toISOString().split('T')[0];
            setName('');
            setStartDate(today);
            setEndDate(today);
            setSchedule(Array(24).fill({ tou: '平', op: '待机' }));
        }
        setModalSelectedTier('谷');
        setModalSelectedOpLogic('待机');
        setModalEditMode('tou');
        setError('');
    }
  }, [isOpen, rule]);

  const handleSave = () => {
    if (!name || !startDate || !endDate) {
        setError('All fields are required.');
        return;
    }
    if (new Date(startDate) > new Date(endDate)) {
        setError('End date cannot be before start date.');
        return;
    }
    
    onSave({
      id: rule?.id || `rule_${Date.now()}`,
      name,
      startDate,
      endDate,
      schedule
    });
  };
  
  if (!isOpen) return null;

  const baseClasses = "px-3 py-1.5 rounded-md font-semibold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 w-full";
  const activeClasses = "bg-blue-600 text-white shadow-sm focus:ring-blue-500";
  const inactiveClasses = "bg-slate-200 text-slate-700 hover:bg-slate-300 focus:ring-slate-400";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-4xl max-h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-slate-800 mb-4">{rule ? 'Edit' : 'Add'} Special Date Range</h2>
        
        {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">{error}</div>}
        
        <div className="space-y-4">
            <div>
                <label htmlFor="rule-name" className="block text-sm font-medium text-slate-700">Rule Name</label>
                <input type="text" id="rule-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="e.g., Summer Holiday"/>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <label htmlFor="start-date" className="block text-sm font-medium text-slate-700">Start Date</label>
                    <input type="date" id="start-date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm"/>
                </div>
                 <div>
                    <label htmlFor="end-date" className="block text-sm font-medium text-slate-700">End Date</label>
                    <input type="date" id="end-date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-md text-sm shadow-sm"/>
                </div>
            </div>
            
            <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Hourly Schedule</label>
                <div className="grid grid-cols-2 gap-2 mb-3 max-w-md">
                    <button onClick={() => setModalEditMode('tou')} className={`${baseClasses} ${modalEditMode === 'tou' ? activeClasses : inactiveClasses}`}>Edit TOU</button>
                    <button onClick={() => setModalEditMode('op')} className={`${baseClasses} ${modalEditMode === 'op' ? activeClasses : inactiveClasses}`}>Edit Storage Logic</button>
                </div>

                {modalEditMode === 'tou' && (
                  <div className="flex flex-wrap gap-2 mb-3 p-3 bg-slate-50 rounded-lg">
                      {TIER_DEFINITIONS.map((tier) => (
                        <button key={tier.id} onClick={() => setModalSelectedTier(tier.id)} className={`px-3 py-1 rounded-md font-bold text-xs transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-1 ${tier.color} ${tier.textColor} ${modalSelectedTier === tier.id ? 'ring-2 ring-blue-500 shadow-sm' : 'hover:opacity-80'}`}>
                          {tier.id} ({tier.name})
                        </button>
                      ))}
                  </div>
                )}
                 {modalEditMode === 'op' && (
                  <div className="flex flex-wrap gap-2 mb-3 p-3 bg-slate-50 rounded-lg">
                      {OPERATING_LOGIC_DEFINITIONS.map((op) => (
                        <button key={op.id} onClick={() => setModalSelectedOpLogic(op.id)} className={`px-3 py-1 rounded-md font-bold text-xs transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-1 ${op.color} ${op.textColor} ${modalSelectedOpLogic === op.id ? 'ring-2 ring-blue-500 shadow-sm' : 'hover:opacity-80'}`}>
                          {op.id} ({op.name})
                        </button>
                      ))}
                  </div>
                )}

                 <div className="flex text-center text-sm text-slate-600 pb-1">
                    {HOURS.map(h => <div key={h} className="flex-1 px-1">{h}</div>)}
                 </div>
                 <RuleScheduleEditor schedule={schedule} onChange={setSchedule} selectedTier={modalSelectedTier} selectedOpLogic={modalSelectedOpLogic} editMode={modalEditMode} />
            </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 bg-slate-200 text-slate-800 rounded-md font-semibold text-sm hover:bg-slate-300 transition-colors">Cancel</button>
          <button onClick={handleSave} className="px-4 py-2 bg-blue-500 text-white rounded-md font-semibold text-sm hover:bg-blue-600 transition-colors">Save Rule</button>
        </div>
      </div>
    </div>
  );
};