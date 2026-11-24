// GitHub connector (GitHub App, acting only with each user's own token).
//
// Two levels of detail, depending on where the Vennata app is installed:
//   * EXACT: repos where the app is installed (the user's own account, or an
//     org whose admin installed it). Every commit with its timestamp.
//   * DAY: everything else, from the contribution graph (the green squares).
//     Daily totals only, which still powers counts and busiest day.
// When an admin installs the app on an org, the same user token automatically
// sees those repos, so their activity upgrades from DAY to EXACT on next sync.
//
// Stored: commit SHAs, PR/review ids, timestamps, counts. Never repo names,
// commit messages, or code.
import "server-only";
import { createHash } from "node:crypto";
import type { ActivityEventInput, Connector, OAuthTokens } from "./types";

const API = "https://api.github.com";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Vennata",
  };
}

// ---------- OAuth ------------------------------------------------------------

interface GitHubTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      client_secret: process.env.GITHUB_CLIENT_SECRET!,
      ...body,
    }),
  });
  // GitHub returns errors with a 200 status, so check the body too.
  const t: GitHubTokenResponse = await res.json();
  if (!res.ok || !t.access_token) {
    throw new Error(`GitHub token error: ${t.error ?? res.status} ${t.error_description ?? ""}`);
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    scopes: [], // GitHub Apps use the app's permissions, not scopes
  };
}

// ---------- REST + GraphQL helpers --------------------------------------------

async function getJson<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Follows GitHub's "Link: <...>; rel="next"" header through every page.
// `key` is for endpoints that wrap the list, like { installations: [...] }.
async function getAllPages<T>(url: string, token: string, key?: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next, { headers: headers(token) });
    if (res.status === 409) break; // empty repository: no commits yet
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${next}: ${await res.text()}`);
    const body = await res.json();
    items.push(...(key ? body[key] : body));
    next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return items;
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(body.errors ?? res.status)}`);
  }
  return body.data;
}

// Runs async work over a list, at most `limit` at a time, so we don't fire
// hundreds of requests at once and hit GitHub's rate limits.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const index = i++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10); // "2026-11-03"

// ---------- What we fetch -------------------------------------------------------

// Repos the Vennata app can see for this user, across all installations.
async function installedRepos(token: string): Promise<string[]> {
  const installations = await getAllPages<{ id: number }>(
    `${API}/user/installations?per_page=100`, token, "installations",
  );
  const lists = await mapLimit(installations, 4, (inst) =>
    getAllPages<{ full_name: string }>(
      `${API}/user/installations/${inst.id}/repositories?per_page=100`, token, "repositories",
    ),
  );
  return [...new Set(lists.flat().map((r) => r.full_name.toLowerCase()))];
}

interface HistoryPage {
  repository: {
    defaultBranchRef: { target: { history: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: { oid: string; authoredDate: string; additions: number; deletions: number; parents: { totalCount: number } }[];
    } } } | null; // null for an empty repo
  } | null;
}

// Every commit the user authored on each repo's default branch, with line
// counts. GraphQL returns 100 commits per request, lines included; REST would
// need one extra request per commit just to get the line counts.
async function exactCommits(token: string, userId: string, repos: string[], since: Date) {
  const perRepo = await mapLimit(repos, 4, async (fullName) => {
    const [owner, name] = fullName.split("/");
    const nodes = [];
    let after: string | null = null;
    do {
      const data: HistoryPage = await graphql(token,
        `query($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $after: String) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef { target { ... on Commit {
              history(first: 100, after: $after, since: $since, author: { id: $author }) {
                pageInfo { hasNextPage endCursor }
                nodes { oid authoredDate additions deletions parents { totalCount } }
              }
            } } }
          }
        }`,
        { owner, name, author: userId, since: since.toISOString(), after },
      );
      const history = data.repository?.defaultBranchRef?.target.history;
      if (!history) break;
      nodes.push(...history.nodes);
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  });

  const seen = new Set<string>(); // the same commit can appear in a fork too
  const events: ActivityEventInput[] = [];
  for (const c of perRepo.flat()) {
    if (c.parents.totalCount > 1 || seen.has(c.oid)) continue; // skip merge commits
    seen.add(c.oid);
    events.push({
      kind: "commit",
      externalId: c.oid,
      startedAt: new Date(c.authoredDate),
      linesAdded: c.additions,
      linesRemoved: c.deletions,
    });
  }
  return events;
}

interface ContributionNode {
  occurredAt: string;
  pullRequest?: { id: string; merged: boolean; mergedAt: string | null };
  pullRequestReview?: { id: string };
}

// Pages through one contributionsCollection list (PRs or reviews).
async function contributionNodes(
  token: string, field: string, nodeFields: string, from: Date, to: Date,
): Promise<ContributionNode[]> {
  const nodes: ContributionNode[] = [];
  let after: string | null = null;
  do {
    const data: {
      viewer: { contributionsCollection: Record<string, {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: ContributionNode[];
      }> };
    } = await graphql(token,
      `query($from: DateTime!, $to: DateTime!, $after: String) {
        viewer { contributionsCollection(from: $from, to: $to) {
          ${field}(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { occurredAt ${nodeFields} }
          }
        } }
      }`,
      { from: from.toISOString(), to: to.toISOString(), after },
    );
    const page = data.viewer.contributionsCollection[field];
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

interface CalendarData {
  viewer: { contributionsCollection: {
    contributionCalendar: { weeks: { contributionDays: { date: string; contributionCount: number }[] }[] };
    commitContributionsByRepository: {
      repository: { nameWithOwner: string };
      contributions: { nodes: { occurredAt: string; commitCount: number }[] };
    }[];
  } };
}

async function calendar(token: string, from: Date, to: Date): Promise<CalendarData> {
  return graphql(token,
    `query($from: DateTime!, $to: DateTime!) {
      viewer { contributionsCollection(from: $from, to: $to) {
        contributionCalendar { weeks { contributionDays { date contributionCount } } }
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner }
          contributions(first: 100) { nodes { occurredAt commitCount } }
        }
      } }
    }`,
    { from: from.toISOString(), to: to.toISOString() },
  );
}

// ---------- The connector ---------------------------------------------------------

export const githubConnector: Connector = {
  provider: "github",

  getAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      redirect_uri: redirectUri,
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  getInstallUrl(state) {
    return `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${state}`;
  },

  exchangeCode: async (code, redirectUri) => {
    const tokens = await tokenRequest({ code, redirect_uri: redirectUri });
    const user = await getJson<{ id: number; email: string | null }>("/user", tokens.accessToken);
    // Primary verified email is what identity resolution matches on.
    const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
      "/user/emails", tokens.accessToken,
    ).catch(() => []);
    const primary = emails.find((e) => e.primary && e.verified)?.email ?? user.email;
    return { tokens, account: { id: String(user.id), email: primary?.toLowerCase() ?? null } };
  },

  refreshTokens: (refreshToken) =>
    tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async fetchActivity(token, since) {
    const to = new Date();
    // contributionsCollection only accepts ranges up to one year.
    const from = new Date(Math.max(since.getTime(), to.getTime() - ONE_YEAR_MS + 60_000));
    // GraphQL identifies users by "node id" (e.g. "MDQ6VXNlcjE="), not login.
    const { node_id: userId } = await getJson<{ node_id: string }>("/user", token);

    const [repos, prs, reviews, cal] = await Promise.all([
      installedRepos(token),
      contributionNodes(token, "pullRequestContributions", "pullRequest { id merged mergedAt }", from, to),
      contributionNodes(token, "pullRequestReviewContributions", "pullRequestReview { id }", from, to),
      calendar(token, from, to),
    ]);
    const installed = new Set(repos);

    // 1. EXACT: commits in repos where the app is installed.
    const events = await exactCommits(token, userId, repos, from);

    // 2. EXACT: PRs and reviews (GitHub gives timestamps for any repo we can see).
    for (const n of prs) {
      const pr = n.pullRequest!;
      events.push({ kind: "pr_opened", externalId: pr.id, startedAt: new Date(n.occurredAt) });
      if (pr.merged && pr.mergedAt && new Date(pr.mergedAt) >= from) {
        events.push({ kind: "pr_merged", externalId: pr.id, startedAt: new Date(pr.mergedAt) });
      }
    }
    for (const n of reviews) {
      events.push({ kind: "review_given", externalId: n.pullRequestReview!.id, startedAt: new Date(n.occurredAt) });
    }

    // 3. DAY: commit counts in visible repos where the app ISN'T installed
    //    (e.g. public open-source repos).
    const collection = cal.viewer.contributionsCollection;
    for (const repo of collection.commitContributionsByRepository) {
      const name = repo.repository.nameWithOwner.toLowerCase();
      if (installed.has(name)) continue; // already counted exactly in step 1
      for (const day of repo.contributions.nodes) {
        events.push({
          kind: "commit",
          precision: "day",
          quantity: day.commitCount,
          // Unique per repo per day, without storing the repo's name.
          externalId: `day:${dayKey(day.occurredAt)}:${hash(name)}`,
          startedAt: new Date(`${dayKey(day.occurredAt)}T00:00:00Z`),
        });
      }
    }

    // 4. DAY: whatever is left on the contribution graph, i.e. private work in
    //    repos we can't see. GitHub hides its type, so it's a "contribution".
    //    Graph total minus everything above = nothing counted twice.
    const counted = new Map<string, number>();
    for (const e of events) {
      const key = dayKey(e.startedAt);
      counted.set(key, (counted.get(key) ?? 0) + (e.quantity ?? 1));
    }
    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        const hidden = day.contributionCount - (counted.get(day.date) ?? 0);
        if (hidden <= 0) continue;
        events.push({
          kind: "contribution",
          precision: "day",
          quantity: hidden,
          externalId: `day:${day.date}`,
          startedAt: new Date(`${day.date}T00:00:00Z`),
        });
      }
    }

    return { events, from, to };
  },
};

// One-way fingerprint so a repo name never lands in our database. Salted with
// our encryption key so nobody can match it against a list of known repo names.
function hash(s: string): string {
  return createHash("sha256").update(`${process.env.TOKEN_ENCRYPTION_KEY}:${s}`).digest("hex").slice(0, 16);
}
