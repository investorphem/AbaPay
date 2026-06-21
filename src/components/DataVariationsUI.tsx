import React, { useState, useMemo } from 'react';
import { categorizeDataPlan } from '@/lib/dataCategories';

interface DataVariationsUIProps {
  variations: any[];
  onSelectPlan: (plan: any) => void;
}

export default function DataVariationsUI({ variations, onSelectPlan }: DataVariationsUIProps) {
  const [selectedTab, setSelectedTab] = useState("Daily");

  const groupedVariations = useMemo(() => {
    const groups: Record<string, any[]> = {};

    // 1. Group them into tabs
    variations.forEach((plan) => {
      }
      groups[categoryName].push(plan);
    });

    // ⚡ 2. SORT EACH TAB FROM LOWEST TO HIGHEST PRICE ⚡
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => parseFloat(a.variation_amount || "0") - parseFloat(b.variation_amount || "0"));
    });

    return groups;
  }, [variations]);

  const availableTabs = Object.keys(groupedVariations);

  return (
    <div className="w-full">
      <div className="flex overflow-x-auto space-x-2 pb-2 scrollbar-hide">
        {availableTabs.map((tabName) => (
          <button
            key={tabName}
            type="button"
            onClick={() => setSelectedTab(tabName)}
            className={`px-4 py-2 text-sm font-bold rounded-full whitespace-nowrap transition-all ${
              selectedTab === tabName 
                ? "bg-emerald-600 text-white shadow-md" 
                : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
            }`}
          >
            {tabName}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3 max-h-[400px] overflow-y-auto pr-2">
        {groupedVariations[selectedTab]?.map((plan) => (
          <div 
             key={plan.variation_code} 
             onClick={() => onSelectPlan(plan)}
             className="p-4 border border-slate-200 dark:border-slate-800/80 rounded-xl hover:border-emerald-500 dark:hover:border-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-all active:scale-[0.98]"
          >
            {/* ⚡ THE FIX: Added dark:text-slate-200 right here ⚡ */}
            <p className="font-semibold text-slate-800 dark:text-slate-200 text-sm leading-snug">{plan.name}</p>
            <p className="text-emerald-600 dark:text-emerald-400 font-black mt-1">₦{Number(plan.variation_amount).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
