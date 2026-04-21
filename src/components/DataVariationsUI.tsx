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
      const categoryName = categorizeDataPlan(plan.name, plan.variation_code);
      if (!groups[categoryName]) {
        groups[categoryName] = []; 
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

  if (availableTabs.length > 0 && !availableTabs.includes(selectedTab)) {
      setSelectedTab(availableTabs[0]); 
  }

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
                : "bg-slate-100 text-slate-500 hover:bg-slate-200"
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
             className="p-4 border border-slate-200 rounded-xl hover:border-emerald-500 hover:bg-emerald-50 cursor-pointer transition-all active:scale-[0.98]"
          >
            <p className="font-semibold text-slate-800 text-sm leading-snug">{plan.name}</p>
            <p className="text-emerald-600 font-black mt-1">₦{Number(plan.variation_amount).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
