import 'server-only'; // SECURITY: Ensures these keys never leak to the frontend

/**
 * 1. COMPLIANT ID GENERATOR
 * Rule: 12 numeric chars + random suffix (Lagos GMT+1 Time)
 */
export const generateRequestId = () => {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Lagos"}));

  const dateStr = now.getFullYear() + 
    String(now.getMonth() + 1).padStart(2, '0') + 
    String(now.getDate()).padStart(2, '0') + 
    String(now.getHours()).padStart(2, '0') + 
    String(now.getMinutes()).padStart(2, '0');

  // Total 20 characters: 12 numeric + 8 alphanumeric
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  return `${dateStr}${randomSuffix}`;
};

/**
 * 2. DYNAMIC AUTH HEADERS (LIVE API KEYS)
 * Upgraded to VTpass Live B2B Auth using API, Public, and Secret keys.
 * Ensure VTPASS_API_KEY, VTPASS_PUBLIC_KEY, and VTPASS_SECRET_KEY are set securely in Vercel.
 */
export const getHeaders = () => {
  return {
    'api-key': process.env.VTPASS_API_KEY || '',
    'public-key': process.env.VTPASS_PUBLIC_KEY || '',
    'secret-key': process.env.VTPASS_SECRET_KEY || '',
    'Content-Type': 'application/json'
  };
};
