export const categorizeDataPlan = (name: string, code: string = ""): string => {
  const lowerName = name.toLowerCase();
  const lowerCode = code.toLowerCase();

  // 1. Voice & Airtime 
  if (lowerName.includes("voice") || lowerCode.includes("airtime")) return "Voice";

  // 2. Broadband / Router
  if (
      lowerName.includes("mifi") || lowerName.includes("router") || 
      lowerName.includes("jumbo") || lowerName.includes("mega") || 
      lowerName.includes("hynetflex") || lowerName.includes("broadband") ||
      lowerName.includes("60 days") || lowerName.includes("90 days") || 
      lowerName.includes("120 days") || lowerName.includes("180 days") ||
      lowerCode.includes("hynet")
  ) {
      return "Broadband";
  }

  // 3. SME & Corporate (Catches Glo's "Best Value" and SME packages)
  if (
      lowerName.includes("sme") || lowerName.includes("best value") || 
      lowerName.includes("corporate") || lowerCode.includes("sme") || lowerCode.includes("dg")
  ) {
      return "SME Data";
  }

  // 4. Annual
  if (lowerName.includes("annual") || lowerName.includes("yearly") || lowerName.includes("365")) return "Annual";

  // 5. Daily
  if (
      lowerName.includes("daily") || lowerName.includes("1 day") || lowerName.includes("1day") || 
      lowerName.includes("2 day") || lowerName.includes("2days") || lowerName.includes("3 day") || 
      lowerName.includes("3days") || lowerName.includes("night") || lowerName.includes("weekend")
  ) {
      return "Daily";
  }

  // 6. Weekly
  if (
      lowerName.includes("weekly") || lowerName.includes("7 day") || lowerName.includes("7days") ||
      lowerName.includes("10 day") || lowerName.includes("14 day")
  ) {
      return "Weekly";
  }

  // 7. Monthly
  if (lowerName.includes("monthly") || lowerName.includes("30 day") || lowerName.includes("30days")) return "Monthly";

  // 8. Social & Special
  if (
      lowerName.includes("social") || lowerName.includes("binge") || lowerName.includes("youtube") || 
      lowerName.includes("tv") || lowerName.includes("campus") || lowerName.includes("always on") ||
      lowerName.includes("special") || lowerName.includes("xtra")
  ) {
      return "Social / Special";
  }

  // 9. Fallback
  return "Other";
};
