import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { totalHours } from "@/lib/stats/meetings";
import { linesOfCode } from "@/lib/stats/code";
import { formatDecimal, formatInt } from "@/lib/format";
import { signOut } from "../auth/actions";
import { syncNow } from "../connections/actions";

const MESSAGES: Record<string, string> = {
  "connected=google": "Google Calendar connected and synced.",
  "connected=github": "GitHub connected and synced.",
  "installed=github": "Vennata app installed on GitHub. Click Sync now (or Connect GitHub) to pull in those repos.",
  "connected=slack": "Slack connected! Your activity counts from now on, in channels the Vennata bot is in.",
  "notice=slack_member": "Slack connected! Since you're not a Slack admin, Vennata hasn't joined any channels yet. Ask an admin to click Connect Slack, or type /invite @Vennata in channels you're in.",
  "error=cancelled": "Connection cancelled.",
  "error=state": "That connection link expired. Please try again.",
  "error=connect_failed": "Couldn't connect. Check the server logs for details.",
  "error=sync_failed": "Sync failed. Try reconnecting the tool.",
};

const RANGES = {
  "30d": { label: "30 days", days: 30 },
  "12m": { label: "12 months", days: 365 },
} as const;
type Range = keyof typeof RANGES;

const AVAILABLE_TOOLS = [
  { provider: "google", label: "Google Calendar" },
  { provider: "github", label: "GitHub" },
  { provider: "slack", label: "Slack" },
];

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
  const range: Range = params.range === "12m" ? "12m" : "30d";
  // A specific notice (e.g. "ask your Slack admin") wins over the generic one.
  const message = Object.entries(params)
    .sort(([a]) => (a === "notice" ? -1 : 1))
    .map(([k, v]) => MESSAGES[`${k}=${v}`])
    .find(Boolean);

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

  // Supabase returns at most 1,000 rows per request, so page through them.
  // (Later, stats move into the database so we only fetch totals.)
  const events: {
    kind: string; started_at: string; ended_at: string; attendee_count: number | null;
    quantity: number; lines_added: number | null; lines_removed: number | null;
  }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("activity_events")
      .select("kind, started_at, ended_at, attendee_count, quantity, lines_added, lines_removed")
      .gte("started_at", daysAgo(RANGES[range].days).toISOString())
      .order("id")
      .range(from, from + 999);
    events.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const meetings = events.filter((e) => e.kind === "meeting");
  // quantity: one day-level row can stand for several commits.
  const count = (...kinds: string[]) =>
    events.filter((e) => kinds.includes(e.kind)).reduce((n, e) => n + e.quantity, 0);
  const commits = count("commit");
  const prsMerged = count("pr_merged");
  const reviews = count("review_given");
  const slackMessages = count("message", "thread_reply");
  const threadsStarted = count("thread_start");
  const replies = count("thread_reply");
  const reactions = count("reaction");
  const lines = linesOfCode(events.filter((e) => e.kind === "commit"));
  // Same number as the green squares on GitHub (a merged PR isn't a new contribution).
  const githubTotal = count("commit", "pr_opened", "review_given", "contribution");

  const meetingHours = totalHours(
    meetings.map((m) => ({ start: new Date(m.started_at), end: new Date(m.ended_at) })),
  );
  const biggest = Math.max(0, ...meetings.map((m) => m.attendee_count ?? 0));
  const connected = new Set(connections?.map((c) => c.provider));

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

      {connected.size > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Your stats</h2>
            <div className="flex rounded-full border border-neutral-200 p-0.5 text-sm dark:border-neutral-800">
              {(Object.keys(RANGES) as Range[]).map((r) => (
                <Link
                  key={r}
                  href={`/dashboard?range=${r}`}
                  className={`rounded-full px-3 py-1 ${r === range ? "bg-foreground text-background" : "text-neutral-500"}`}
                >
                  {RANGES[r].label}
                </Link>
              ))}
            </div>
          </div>

          {connected.has("google") && (
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="meetings" value={meetings.length} />
              <Stat label="meeting hours" value={formatDecimal(meetingHours)} />
              <Stat label="biggest meeting" value={biggest} />
            </div>
          )}
          {connected.has("github") && (
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="GitHub contributions" value={formatInt(githubTotal)} />
              <Stat label="commits" value={formatInt(commits)} />
              <Stat label="PRs merged" value={formatInt(prsMerged)} />
              <Stat label="reviews given" value={formatInt(reviews)} />
              <Stat label="lines added" value={`+${formatInt(lines.added)}`} />
              <Stat label="lines removed" value={`−${formatInt(lines.removed)}`} />
            </div>
          )}
          {connected.has("slack") && (
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
              <Stat label="Slack messages" value={formatInt(slackMessages)} />
              <Stat label="threads started" value={formatInt(threadsStarted)} />
              <Stat label="replies given" value={formatInt(replies)} />
              <Stat label="reactions" value={formatInt(reactions)} />
            </div>
          )}
          <p className="text-xs text-neutral-500">
            Last {RANGES[range].label} · overlapping meetings counted once · lines only from repos with the Vennata app, huge generated commits skipped
          </p>
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
                    : c.provider === "slack"
                      ? "Live: counting as it happens"
                      : c.last_synced_at
                      ? `Synced ${new Date(c.last_synced_at).toLocaleString()}`
                      : "Not synced yet"}
                </p>
              </div>
              <form action={syncNow} className="flex items-center gap-3">
                {c.provider === "github" && (
                  // eslint-disable-next-line @next/next/no-html-link-for-pages
                  <a href="/api/connect/github?mode=install" className="text-xs text-neutral-500 underline hover:text-foreground">
                    Add repos or orgs
                  </a>
                )}
                {/* Slack pushes events live, so there's nothing to sync. */}
                {c.provider !== "slack" && (
                  <>
                    <input type="hidden" name="connectionId" value={c.id} />
                    <button type="submit" className="rounded-full border border-neutral-300 px-4 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
                      Sync now
                    </button>
                  </>
                )}
              </form>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          {AVAILABLE_TOOLS.filter((t) => !connected.has(t.provider)).map((t) => (
            // A plain <a>, not <Link>: Link would prefetch this route in the
            // background and kick off an OAuth flow nobody clicked.
            <a
              key={t.provider}
              href={`/api/connect/${t.provider}`}
              className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-80"
            >
              Connect {t.label}
            </a>
          ))}
        </div>
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
