import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { totalHours } from "@/lib/stats/meetings";
import { formatDecimal } from "@/lib/format";
import { signOut } from "../auth/actions";
import { syncNow } from "../connections/actions";

const MESSAGES: Record<string, string> = {
  "connected=google": "Google Calendar connected and synced.",
  "error=cancelled": "Connection cancelled.",
  "error=state": "That connection link expired. Please try again.",
  "error=connect_failed": "Couldn't connect. Check the server logs for details.",
  "error=sync_failed": "Sync failed. Try reconnecting the tool.",
};

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  // Reading the session (cookies) happens at request time, so Next 16 wants
  // it inside <Suspense>. The fallback shows instantly while it loads.
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-6 py-16">
      <Suspense fallback={<p className="text-neutral-500">Loading…</p>}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/dashboard">["searchParams"] }) {
  const supabase = await createClient();

  // getUser() asks Supabase to verify the session, so it can't be faked
  // by editing cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const params = await searchParams;
  const messageKey = Object.entries(params).map(([k, v]) => `${k}=${v}`)[0];
  const message = messageKey ? MESSAGES[messageKey] : undefined;

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

  const { data: connections } = await supabase
    .from("connections")
    .select("id, provider, external_email, status, last_synced_at");

  const { data: meetings } = await supabase
    .from("activity_events")
    .select("started_at, ended_at, attendee_count")
    .eq("kind", "meeting")
    .gte("started_at", daysAgo(30).toISOString());

  const meetingHours = totalHours(
    (meetings ?? []).map((m) => ({ start: new Date(m.started_at), end: new Date(m.ended_at) })),
  );
  const biggest = Math.max(0, ...(meetings ?? []).map((m) => m.attendee_count ?? 0));
  const hasGoogle = connections?.some((c) => c.provider === "google");

  return (
    <div className="space-y-8">
      {message && (
        <p className="rounded-lg bg-neutral-100 px-4 py-3 text-sm dark:bg-neutral-900">{message}</p>
      )}

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

      {meetings && meetings.length > 0 && (
        <section className="grid grid-cols-3 gap-3 text-center">
          <Stat label="meetings" value={meetings.length} />
          <Stat label="meeting hours" value={formatDecimal(meetingHours)} />
          <Stat label="biggest meeting" value={biggest} />
          <p className="col-span-3 text-xs text-neutral-500">Last 30 days, overlaps counted once</p>
        </section>
      )}

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-3 font-semibold">Connected tools</h2>
        <ul className="space-y-3">
          {connections?.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4">
              <div>
                <p className="capitalize">{c.provider} <span className="text-neutral-500">· {c.external_email}</span></p>
                <p className="text-xs text-neutral-500">
                  {c.status !== "active"
                    ? `Needs reconnecting (${c.status})`
                    : c.last_synced_at
                      ? `Synced ${new Date(c.last_synced_at).toLocaleString()}`
                      : "Not synced yet"}
                </p>
              </div>
              <form action={syncNow}>
                <input type="hidden" name="connectionId" value={c.id} />
                <button type="submit" className="rounded-full border border-neutral-300 px-4 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
                  Sync now
                </button>
              </form>
            </li>
          ))}
        </ul>
        {!hasGoogle && (
          // A plain <a>, not <Link>: Link would prefetch this route in the
          // background and kick off an OAuth flow nobody clicked.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a
            href="/api/connect/google"
            className="mt-2 inline-block rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-80"
          >
            Connect Google Calendar
          </a>
        )}
      </section>

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

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-xs text-neutral-500">{label}</p>
    </div>
  );
}
