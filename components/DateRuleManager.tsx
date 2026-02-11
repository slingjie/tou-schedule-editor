import React from 'react';
import type { DateRule } from '../types';

interface DateRuleManagerProps {
  rules: DateRule[];
  onAdd: () => void;
  onEdit: (rule: DateRule) => void;
  onDelete: (ruleId: string) => void;
}

export const DateRuleManager: React.FC<DateRuleManagerProps> = ({ rules, onAdd, onEdit, onDelete }) => {
  return (
    <div className="mt-6 p-4 bg-slate-50 rounded-lg border border-slate-200">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-xl font-semibold text-slate-700">Special Date Ranges</h2>
        <button
          onClick={onAdd}
          className="px-4 py-2 bg-blue-500 text-white rounded-md font-semibold text-sm hover:bg-blue-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Add Special Date Range
        </button>
      </div>
      <p className="text-sm text-slate-600 mb-4 bg-slate-100 p-2 rounded-md border border-slate-200">
        <strong>Note:</strong> These rules will <strong>override</strong> the base monthly schedule on the specified dates. The asterisk (*) on a month indicates an override is active.
      </p>
      <div className="space-y-3">
        {rules.length === 0 ? (
          <p className="text-slate-500 text-center py-4">No special date ranges defined.</p>
        ) : (
          rules.map(rule => (
            <div key={rule.id} className="flex items-center justify-between p-3 bg-white rounded-md border border-slate-200 shadow-sm">
              <div>
                <p className="font-semibold text-slate-800">{rule.name}</p>
                <p className="text-sm text-slate-600">{rule.startDate} to {rule.endDate}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onEdit(rule)}
                  className="px-3 py-1 text-sm font-medium text-blue-600 bg-blue-100 rounded-md hover:bg-blue-200 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => onDelete(rule.id)}
                  className="px-3 py-1 text-sm font-medium text-red-600 bg-red-100 rounded-md hover:bg-red-200 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};