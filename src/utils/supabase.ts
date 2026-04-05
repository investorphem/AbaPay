// src/utils/supabase.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// The VIP Key (Must be added to your .env.local and Vercel)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; 

// 1. STANDARD CLIENT
// Used by the Frontend (like your Admin Dashboard) to securely read data.
// This respects RLS rules.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 2. VIP ADMIN CLIENT
// Used ONLY by the Backend API to bypass RLS and forcefully save/update data.
// Never use this in a frontend React component!
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
