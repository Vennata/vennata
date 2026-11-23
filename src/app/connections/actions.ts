"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { syncConnection } from "@/lib/connections";

export async function syncNow(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  try {
    await syncConnection(String(formData.get("connectionId")), user.id);
  } catch (e) {
    console.error("[sync]", e);
    redirect("/dashboard?error=sync_failed");
  }
  // Tell Next the dashboard's data changed so it re-renders with new numbers.
  revalidatePath("/dashboard");
}
