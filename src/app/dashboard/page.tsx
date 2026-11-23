import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../auth/actions";

export default function DashboardPage() {
  // Reading the session (cookies) happens at request time, so Next 16 wants
  // it inside <Suspense>. The fallback shows instantly while it loads.
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-6 py-16">
      <Suspense fallback={<p className="text-neutral-500">Loading…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function Dashboard() {
  const supabase = await createClient();

  // getUser() asks Supabase to verify the session, so it can't be faked
  // by editing cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // These queries run as the signed-in user, so RLS limits them to rows
  // this person is allowed to see.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, email, avatar_url")
    .eq("id", user.id)
    .single();

  const { data: memberships } = await supabase
    .from("memberships")
    .select("role, companies (name, is_personal)")
    .eq("user_id", user.id)
    // Each membership points to exactly one company. TypeScript can't know
    // that until we generate types from the database, so we tell it here.
    .overrideTypes<
      { role: string; companies: { name: string; is_personal: boolean } }[],
      { merge: false }
    >();

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        {profile?.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatar_url}
            alt=""
            className="h-14 w-14 rounded-full"
            referrerPolicy="no-referrer"
          />
        )}
        <div>
          <h1 className="text-2xl font-bold">
            Hi, {profile?.display_name ?? "there"}
          </h1>
          <p className="text-neutral-500">{profile?.email}</p>
        </div>
      </div>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-2 font-semibold">Your spaces</h2>
        <ul className="space-y-1">
          {memberships?.map((m, i) => (
            <li key={i} className="flex justify-between">
              <span>{m.companies?.name}</span>
              <span className="text-neutral-500">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <form action={signOut}>
        <button
          type="submit"
          className="text-sm text-neutral-500 underline hover:text-foreground"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
