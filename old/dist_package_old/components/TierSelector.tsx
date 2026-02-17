
import React from 'react';
import type { TierId } from '../types';
import { TIER_DEFINITIONS } from '../constants';

interface TierSelectorProps {
  selectedTier: TierId;
  onTierSelect: (tierId: TierId) => void;
}

export const TierSelector: React.FC<TierSelectorProps> = ({ selectedTier, onTierSelect }) => {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
      <h2 className="text-lg font-semibold text-slate-700 mb-3 sm:mb-0">Select a Tier to Apply:</h2>
      <div className="flex flex-wrap gap-2">
        {TIER_DEFINITIONS.map((tier) => (
          <button
            key={tier.id}
            onClick={() => onTierSelect(tier.id)}
            className={`px-4 py-2 rounded-md font-bold text-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
              tier.color
            } ${tier.textColor} ${
              selectedTier === tier.id
                ? 'ring-2 ring-blue-500 shadow-md'
                : 'hover:opacity-80'
            }`}
          >
            {tier.id} ({tier.name})
          </button>
        ))}
      </div>
    </div>
  );
};
