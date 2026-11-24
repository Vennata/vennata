"use server";
// Server Actions: functions that run on the server but can be called straight
// from a <form>. No API route or fetch() needed.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/site";

export async function signInWithGoogle() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Where Google sends the user back after they approve.
      redirectTo: `${siteUrl()}/auth/callback`,
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
