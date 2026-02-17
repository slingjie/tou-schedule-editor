import React, { useState, useMemo } from 'react';
import { MONTHS, HOURS } from '../constants';
import type { Schedule, DateRule } from '../types';

interface JsonOutputProps {
  data: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
  };
}

export const JsonOutput: React.FC<JsonOutputProps> = ({ data }) => {
  const [copyButtonText, setCopyButtonText] = useState('Copy JSON');

  const transformedData = useMemo(() => {
    const transformedMonthlySchedule = data.monthlySchedule.map((monthSchedule, monthIndex) => ({
      month: MONTHS[monthIndex],
      schedule: monthSchedule.map((cell, hourIndex) => ({
        hour: HOURS[hourIndex],
        ...cell,
      })),
    }));

    const transformedDateRules = data.dateRules.map(rule => ({
      ...rule,
      schedule: rule.schedule.map((cell, hourIndex) => ({
        hour: HOURS[hourIndex],
        ...cell,
      })),
    }));

    return {
      monthlySchedule: transformedMonthlySchedule,
      dateRules: transformedDateRules,
    };
  }, [data]);

  const jsonString = useMemo(() => JSON.stringify(transformedData, null, 2), [transformedData]);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString).then(() => {
      setCopyButtonText('Copied!');
      setTimeout(() => setCopyButtonText('Copy JSON'), 2000);
    }).catch(err => {
      console.error('Failed to copy JSON: ', err);
      setCopyButtonText('Error!');
       setTimeout(() => setCopyButtonText('Copy JSON'), 2000);
    });
  };

  return (
    <div className="mt-8 w-full">
        <div className="bg-white rounded-xl shadow-lg p-4 sm:p-6">
            <div className="flex justify-between items-center mb-3">
                <h2 className="text-xl font-semibold text-slate-700">Live Configuration Output</h2>
                 <div className="flex items-center gap-2">
                    <button
                        onClick={handleCopy}
                        className="px-4 py-2 bg-slate-600 text-white rounded-md font-semibold text-sm hover:bg-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:opacity-50"
                        disabled={copyButtonText !== 'Copy JSON'}
                    >
                        {copyButtonText}
                    </button>
                 </div>
            </div>
            <pre className="bg-slate-800 text-white p-4 rounded-lg text-sm overflow-x-auto max-h-96">
                <code>
                    {jsonString}
                </code>
            </pre>
        </div>
    </div>
  );
};