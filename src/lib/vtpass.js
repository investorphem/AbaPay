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
 * 2. DYNAMIC AUTH HEADERS (UPGRADED TO BASIC AUTH)
 * VTpass Bank Transfers, JAMB, and WAEC require Basic Auth (Email/Password)
 * rather than the legacy Public/Secret keys.
 */
export const getHeaders = () => {
  const username = process.env.VTPASS_EMAIL || '';
  const password = process.env.VTPASS_PASSWORD || '';

  // Create the Base64 encoded Basic Auth token
  const authToken = Buffer.from(`${username}:${password}`).toString('base64');

  return {
    'Authorization': `Basic ${authToken}`,
    'Content-Type': 'application/json'
  };
};