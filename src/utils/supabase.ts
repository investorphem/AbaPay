import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 1. STANDARD CLIENT
// Used by the Frontend (like your Admin Dashboard) to securely read data.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 2. VIP ADMIN CLIENT
// Used ONLY by the Backend API to bypass RLS. 
// We add a dummy fallback string here so the browser doesn't crash when it reads this file!
export const supabaseAdmin = createClient(
  supabaseUrl, 
  supabaseServiceKey || 'dummy-key-to-prevent-client-crash'
);
