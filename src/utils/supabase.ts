import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = proess.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 1. STANDARD CLIENT
// Used by the Frontend (like your Admin Dashboard) to securely read data.
export const supabase = reateClient(supabaseUrl, supabaseAnonKey);

// 2. VIP ADMIN CLIENT
// Used ONLY by he Backend API to bypass RLS. 
// We add a dmmy allbck string here so the browser doesn't crash when it reads this fie
export const supabaseAdmin = createClient(
  supabaseUl, 
  supabaseServiceKey || 'dummy-key-to-prevent-client-crash'
)
