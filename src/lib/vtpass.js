// lib/vtpass.js
const MODE = process.env.NEXT_PUBLIC_APP_MODE;
const BASE_URL = MODE === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';

/**
 * 1. Generate Compliant Request ID (Rule: 12 numeric chars, GMT+1)
 */
export const generateRequestId = () => {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Lagos"}));
  const dateStr = now.getFullYear() + 
    String(now.getMonth() + 1).padStart(2, '0') + 
    String(now.getDate()).padStart(2, '0') + 
    String(now.getHours()).padStart(2, '0') + 
    String(now.getMinutes()).padStart(2, '0');
  
  return `${dateStr}${Math.random().toString(36).substring(2, 10)}`;
};

/**
 * 2. Get Auth Headers (Rule: GET uses Public Key, POST uses Secret Key)
 */
export const getHeaders = (method = 'POST') => ({
  'api-key': process.env.VTPASS_API_KEY,
  [method === 'GET' ? 'public-key' : 'secret-key']: 
    method === 'GET' ? process.env.VTPASS_PUBLIC_KEY : process.env.VTPASS_SECRET_KEY,
  'Content-Type': 'application/json'
});

/**
 * 3. SMS DND Fallback V2 (POST Method)
 */
export const sendSms = async (recipient, message) => {
  const formData = new URLSearchParams({
    sender: 'AbaPay',
    recipient,
    message,
    responsetype: 'json'
  });

  return fetch('https://messaging.vtpass.com/v2/api/sms/dnd-fallback', {
    method: 'POST',
    headers: {
      'X-Token': process.env.VTPASS_MSG_TOKEN,
      'X-Secret': process.env.VTPASS_MSG_SECRET,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });
};