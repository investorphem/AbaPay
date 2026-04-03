import 'server-only'; // SECURITY: Ensures these keys never leak to the frontend

// 1. DYNAMIC URL SWITCHER (Based on your .env.local)
export const BASE_URL = process.env.NEXT_PUBLIC_APP_MODE === 'live' 
  ? 'https://vtpass.com/api' 
  : 'https://sandbox.vtpass.com/api';

/**
 * 2. COMPLIANT ID GENERATOR
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
 * 3. DYNAMIC AUTH HEADERS
 * Rule: GET requests use Public Key, POST requests use Secret Key
 * FIXED: Added || '' so TypeScript guarantees these are strings, not undefined.
 */
export const getHeaders = (method = 'POST') => {
  const isGet = method.toUpperCase() === 'GET';
  
  return {
    'api-key': process.env.VTPASS_API_KEY || '',
    [isGet ? 'public-key' : 'secret-key']: (isGet 
      ? process.env.VTPASS_PUBLIC_KEY 
      : process.env.VTPASS_SECRET_KEY) || '',
    'Content-Type': 'application/json'
  };
};