// src/lib/dataCategories.ts

export const categorizeDataPlan = (name: string, code: string = ""): string => {
  const lowerName = name.toLowerCase();
  const lowerCode = code.toLowerCase();

  // 1. Voice & Airtime (Primarily for Smile)
  if (lowerName.includes("voice") || lowerCode.includes("airtime")) return "Voice";

  // 2. Broadband / Router / Mega / Jumbo (Catch these first so they don't get mixed into Monthly)
  if (
      lowerName.includes("mifi") || 
      lowerName.includes("router") || 
      lowerName.includes("jumbo") || 
      lowerName.includes("mega") || 
      lowerName.includes("hynetflex") ||
      lowerName.includes("broadband") ||
      lowerName.includes("60 days") || lowerName.includes("90 days") || 
      lowerName.includes("120 days") || lowerName.includes("180 days") ||
      lowerCode.includes("hynet")
  ) {
      return "Broadband";
  }

  // 3. Annual / Yearly
  if (lowerName.includes("annual") || lowerName.includes("yearly") || lowerName.includes("365")) return "Annual";

  // 4. Daily / Short-term (Catches "Daily", "1 Day", "2 Days", "Night", "Weekend")
  if (
      lowerName.includes("daily") || 
      lowerName.includes("1 day") || lowerName.includes("1day") || 
      lowerName.includes("2 day") || lowerName.includes("2days") || 
      lowerName.includes("3 day") || lowerName.includes("3days") || 
      lowerName.includes("night") || 
      lowerName.includes("weekend")
  ) {
      return "Daily";
  }

  // 5. Weekly (Catches "Weekly", "7 Days", "14 Days")
  if (
      lowerName.includes("weekly") || 
      lowerName.includes("7 day") || lowerName.includes("7days") ||
      lowerName.includes("10 day") || lowerName.includes("14 day")
  ) {
      return "Weekly";
  }

  // 6. Monthly (Catches "Monthly", "30 Days")
  if (lowerName.includes("monthly") || lowerName.includes("30 day") || lowerName.includes("30days")) return "Monthly";

  // 7. Social & Special (Catches "Social", "Binge", "Glo TV", "Campus", "Always On")
  if (
      lowerName.includes("social") || 
      lowerName.includes("binge") || 
      lowerName.includes("youtube") || 
      lowerName.includes("tv") || 
      lowerName.includes("campus") || 
      lowerName.includes("always on") ||
      lowerName.includes("special") ||
      lowerName.includes("xtra")
  ) {
      return "Social / Special";
  }

  // 8. Fallback
  return "Other";
};
