import { createClient } from '@supabase/supabase-js';

// .env.local に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定すること。
// (05_API仕様書.md 1章 参照)
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 5 } },
  },
);

export const BASE_URL = window.location.origin;
