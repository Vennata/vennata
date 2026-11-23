"use server";
// Server Actions: functions that run on the server but can be called straight
// from a <form>. No API route or fetch() needed.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signInWithGoogle() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Where Google sends the user back after they approve.
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });

  if (error) redirect("/?error=signin");
  // data.url is Google's consent screen; send the browser there.
  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
