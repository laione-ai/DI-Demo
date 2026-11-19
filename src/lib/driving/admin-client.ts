// ============================================================
// Driving School — Service-role Supabase client.
//
// Used by background cron jobs, webhook handlers, and background services
// that bypass RLS.
// ============================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function drivingAdmin(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _client;
}
