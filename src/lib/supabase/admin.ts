// Supabase client with the SECRET key. It bypasses Row Level Security, so:
//   * only use it in server code that has already checked who the user is
//   * "server-only" makes the build fail if it's ever imported into browser code
import "server-only";
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
