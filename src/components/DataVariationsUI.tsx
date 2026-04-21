// src/components/DataVariationsUI.tsx
import React, { useState, useMemo } from 'react';
import { categorizeDataPlan } from '@/lib/dataCategories';

// ⚡ Added TypeScript interface so Vercel is happy
interface DataVariationsUIProps {
  variations: any[];
  onSelectPlan: (plan: any) => void; // ⚡ This tells the parent component what the user clicked
}

export default function DataVariationsUI({ variations, onSelectPlan }: DataVariationsUIProps) {
  const [selectedTab, setSelectedTab] = useState("Daily");

  const groupedVariations = useMemo(() => {
    const groups: Record<string, any[]> = {};
    variations.forEach((plan) => {
      const categoryName = categorizeDataPlan(plan.name, plan.variation_code);
      if (!groups[categoryName]) {
        groups[categoryName] = []; 
      }
      groups[categoryName].push(plan);
    });
    return groups;
  }, [variations]);

  const availableTabs = Object.keys(groupedVariations);

  if (availableTabs.length > 0 && !availableTabs.includes(selectedTab)) {
      setSelectedTab(availableTabs[0]); 
  }

  return (
    <div className="w-full">
      {/* --- DYNAMIC TABS UI --- */}
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

      {/* --- LIST THE PLANS FOR THE SELECTED TAB --- */}
      <div className="mt-4 space-y-3 max-h-[400px] overflow-y-auto pr-2">
        {groupedVariations[selectedTab]?.map((plan) => (
          <div 
             key={plan.variation_code} 
             onClick={() => onSelectPlan(plan)} // ⚡ This is the magic click handler!
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
