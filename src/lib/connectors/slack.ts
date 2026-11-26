// Slack connector. One "Connect Slack" click does two things in a single
// Slack approval screen:
//   * installs the Vennata app on the workspace (if it isn't already): we get
//     a bot token and Slack starts sending us events (handleSlackEvent below).
//     If the person is a Slack admin, the bot also joins every public channel;
//     a regular member can't add a bot everywhere on the company's behalf.
//   * links the person who approved: Slack tells us their user id, so their
//     activity is counted. Only linked people are ever counted (opt-in).
// Teammates click the same button later; the app is already there, so for
// them it just links their account.
//
// Slack doesn't let non-Marketplace apps read message history at a useful
// rate, so counting starts at install and there's nothing to backfill.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { siteUrl } from "@/lib/site";
import type { ActivityEventInput, Connector } from "./types";

// Bot permissions. history scopes are needed to RECEIVE message events in
// channels the bot is in; we still never read or store the text.
const BOT_SCOPES = [
  "channels:history", "groups:history", // message events (public / private channels)
  "channels:read", "groups:read",       // see channels + "bot joined" events
  "channels:join",                      // admin installs: join public channels
  "chat:write",                         // post the intro message when joining
  "reactions:read",                     // reaction events
  "users:read", "users:read.email",     // map Slack users to emails (#1 collaborator)
];

const USER_SCOPES = ["search:read"];

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackApi<T extends SlackResponse>(
  method: string, params: Record<string, string>, token?: string,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: new URLSearchParams(params),
  });
  // Slack returns errors as 200 + { ok: false }, so always check ok.
  const body: T = await res.json();
  if (!body.ok) throw new Error(`Slack ${method} error: ${body.error}`);
  return body;
}

const oauthParams = (code: string, redirectUri: string) => ({
  client_id: process.env.SLACK_CLIENT_ID!,
  client_secret: process.env.SLACK_CLIENT_SECRET!,
  code,
  redirect_uri: redirectUri,
});

export const slackConnector: Connector = {
  provider: "slack",

  getAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      scope: BOT_SCOPES.join(","),
      // Personal permission: lets us find this person's OWN past messages so
      // their first poster isn't empty (Slack starts sending events at install).
      user_scope: USER_SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },

  async exchangeCode(code, redirectUri) {
    const r = await slackApi<SlackResponse & {
      access_token: string; scope: string; team: { id: string };
      authed_user: { id: string; access_token?: string; scope?: string };
    }>("oauth.v2.access", oauthParams(code, redirectUri));

    // Who approved: their email (for matching across tools) and whether
    // they're a Slack admin (decides if the bot joins every channel).
    const me = await slackApi<SlackResponse & {
      user: { is_admin?: boolean; is_owner?: boolean; profile?: { email?: string } };
    }>("users.info", { user: r.authed_user.id }, r.access_token).catch(() => null);

    return {
      // Slack user ids are only unique within a workspace, so include the team.
      account: {
        id: `${r.team.id}:${r.authed_user.id}`,
        email: me?.user.profile?.email?.toLowerCase() ?? null,
      },
      // The person's own token (used only to search their past messages).
      tokens: {
        accessToken: r.authed_user.access_token ?? r.access_token,
        refreshToken: null,
        expiresAt: null,
        scopes: r.authed_user.scope?.split(",") ?? [],
      },
      workspace: {
        workspaceId: r.team.id,
        botToken: r.access_token,
        scopes: r.scope.split(","),
        installerIsAdmin: Boolean(me?.user.is_admin || me?.user.is_owner),
      },
    };
  },

  // Runs after the bot token is saved (the "bot joined" events that follow
  // need it to post the intro message).
  async afterInstall(workspace) {
    if (workspace.installerIsAdmin) {
      await joinPublicChannels(workspace.botToken);
      return;
    }
    // A regular member connected. If no admin has set the bot up yet, tell
    // them how, instead of silently counting nothing.
    const list = await slackApi<SlackResponse & { channels: { is_member: boolean }[] }>(
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" },
      workspace.botToken,
    ).catch(() => null);
    if (!list?.channels.some((c) => c.is_member)) return "slack_member";
  },

  async refreshTokens() {
    throw new Error("Slack bot tokens don't expire");
  },

  // Backfill: live events only start at install, so on connect we search for
  // this person's OWN past messages (search is the one Slack history API
  // that isn't heavily rate-limited for apps like ours). Kept only if they
  // were in a channel the bot is in, so history matches what live counting
  // covers; DMs are always skipped. Reactions and "threads started" can't be
  // found this way, so those still start at install.
  async fetchActivity(userToken, since) {
    const to = new Date();
    const me = await slackApi<SlackResponse & { user_id: string; team_id: string }>(
      "auth.test", {}, userToken,
    );
    const token = await botToken(me.team_id);
    const botChannels = token ? await memberChannelIds(token) : new Set<string>();

    const events: ActivityEventInput[] = [];
    const after = new Date(since.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (let page = 1, pages = 1; page <= pages && page <= MAX_SEARCH_PAGES; page++) {
      const r = await searchPage(userToken, `from:<@${me.user_id}> after:${after}`, page);
      pages = r.messages.paging.pages;
      for (const m of r.messages.matches) {
        if (m.channel.is_im || m.channel.is_mpim || !botChannels.has(m.channel.id)) continue;
        const startedAt = slackTime(m.ts);
        if (startedAt < since) continue;
        // A reply's permalink carries its parent's thread_ts.
        const threadTs = m.permalink ? new URL(m.permalink).searchParams.get("thread_ts") : null;
        events.push({
          kind: threadTs && threadTs !== m.ts ? "thread_reply" : "message",
          externalId: `${m.channel.id}:${m.ts}`, // same id as live events: no double counting
          startedAt,
        });
      }
    }
    return { events, from: since, to, merge: true };
  },
};

// 100 results per page; 50 pages = 5,000 messages, plenty for a first poster.
const MAX_SEARCH_PAGES = 50;

interface SearchMatch {
  ts: string;
  permalink?: string;
  channel: { id: string; is_im?: boolean; is_mpim?: boolean };
  // `text` is in the response too. We never touch it.
}

async function searchPage(userToken: string, query: string, page: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slackApi<SlackResponse & {
        messages: { matches: SearchMatch[]; paging: { pages: number } };
      }>("search.messages", { query, count: "100", page: String(page), sort: "timestamp" }, userToken);
    } catch (e) {
      // Slack says "ratelimited" when we're going too fast: wait and retry.
      if (attempt < 3 && e instanceof Error && e.message.includes("ratelimited")) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function memberChannelIds(botToken: string): Promise<Set<string>> {
  const list = await slackApi<SlackResponse & { channels: { id: string; is_member: boolean }[] }>(
    "conversations.list",
    { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000" },
    botToken,
  );
  return new Set(list.channels.filter((c) => c.is_member).map((c) => c.id));
}

// The bot only receives events from channels it's in. When an admin connects,
// joining every public channel means nobody has to /invite it one by one.
// (Private channels still need an invite, which is the right call for privacy.)
async function joinPublicChannels(botToken: string) {
  const list = await slackApi<SlackResponse & { channels: { id: string; is_member: boolean }[] }>(
    "conversations.list",
    { types: "public_channel", exclude_archived: "true", limit: "200" },
    botToken,
  );
  for (const channel of list.channels.filter((c) => !c.is_member)) {
    await slackApi("conversations.join", { channel: channel.id }, botToken).catch(() => {});
  }
}

// ---------- Live events --------------------------------------------------------

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
  event_ts?: string;
  item?: { channel?: string; ts?: string };
  item_user?: string;
  reaction?: string;
  // `text` exists on message events. We never touch it.
}

// Message subtypes that are a person actually posting. Everything else
// (edits, deletes, joins, bot posts) is ignored.
const COUNTED_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

const slackTime = (ts: string) => new Date(parseFloat(ts) * 1000);

export async function handleSlackEvent(teamId: string, event: SlackEvent, botUserId?: string) {
  // The bot itself joined a channel (auto-join or someone's /invite): say hi.
  if (event.type === "member_joined_channel" && event.user && event.user === botUserId && event.channel) {
    await postIntro(teamId, event.channel);
    return;
  }

  if (event.bot_id || event.channel_type === "im") return;

  if (event.type === "message" && COUNTED_SUBTYPES.has(event.subtype) && event.user && event.ts) {
    const isReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
    const others = isReply && event.parent_user_id && event.parent_user_id !== event.user
      ? [event.parent_user_id] : [];

    await record(teamId, event.user, {
      kind: isReply ? "thread_reply" : "message",
      externalId: `${event.channel}:${event.ts}`,
      startedAt: slackTime(event.ts),
      participantEmails: await emailsFor(teamId, others),
    });

    // The first reply turns the parent message into a thread. Credit its
    // author with starting one (the unique constraint ignores repeats).
    if (isReply && event.parent_user_id) {
      await record(teamId, event.parent_user_id, {
        kind: "thread_start",
        externalId: `${event.channel}:${event.thread_ts}`,
        startedAt: slackTime(event.thread_ts!),
      });
    }
  }

  if (event.type === "reaction_added" && event.user && event.item?.ts) {
    const others = event.item_user && event.item_user !== event.user ? [event.item_user] : [];
    await record(teamId, event.user, {
      kind: "reaction",
      externalId: `${event.item.channel}:${event.item.ts}:${event.reaction}`,
      startedAt: slackTime(event.event_ts ?? event.item.ts),
      participantEmails: await emailsFor(teamId, others),
    });
  }
}

// Posted once in every channel the bot joins, so nobody wonders what this
// bot is or whether it's reading their messages.
async function postIntro(teamId: string, channel: string) {
  const token = await botToken(teamId);
  if (!token) return;
  const site = siteUrl();
  const text = [
    "👋 Hey everyone! I'm *Vennata*. I turn your work into fun recap posters you can look back on and share (meetings, messages, code and more).",
    "",
    "*Here's exactly what I do in this channel:*",
    "• I only count activity for people who *choose to join* by clicking *Connect Slack*. If you don't, I ignore you completely.",
    "• I count *how much*, never *what*: how many messages, replies and reactions. I never save or share what you write.",
    "• Your posters stay *private* unless you decide to share them.",
    "",
    `Want your own recap? Grab it at <${site}|${site.replace(/^https?:\/\//, "")}> 🎉`,
    "Not interested? No need to do anything. You're never counted unless you opt in.",
  ].join("\n");
  await slackApi("chat.postMessage", { channel, text, unfurl_links: "false" }, token);
}

// Saves an event ONLY if this Slack user linked their Vennata account.
// Everyone else's activity is dropped right here (opt-in only).
async function record(teamId: string, slackUserId: string, e: ActivityEventInput) {
  const db = createAdminClient();
  const { data: connection } = await db
    .from("connections")
    .select("id, user_id, company_id")
    .eq("provider", "slack")
    .eq("external_account_id", `${teamId}:${slackUserId}`)
    .eq("status", "active")
    .maybeSingle();
  if (!connection) return;

  const { error } = await db.from("activity_events").upsert(
    {
      user_id: connection.user_id,
      company_id: connection.company_id,
      connection_id: connection.id,
      provider: "slack",
      kind: e.kind,
      external_id: e.externalId,
      started_at: e.startedAt.toISOString(),
      participant_emails: e.participantEmails ?? [],
    },
    // Slack retries events if we're slow, so duplicates are expected: ignore them.
    { onConflict: "connection_id,kind,external_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Saving Slack event failed: ${error.message}`);
}

// Slack user ids -> emails, for the "#1 collaborator" stat. Cached in memory
// while this server instance is warm, so we don't call Slack on every event.
const emailCache = new Map<string, string | null>();

async function emailsFor(teamId: string, slackUserIds: string[]): Promise<string[]> {
  const emails: string[] = [];
  for (const id of slackUserIds) {
    const key = `${teamId}:${id}`;
    if (!emailCache.has(key)) {
      const token = await botToken(teamId);
      const r = token
        ? await slackApi<SlackResponse & { user: { profile?: { email?: string } } }>(
            "users.info", { user: id }, token,
          ).catch(() => null)
        : null;
      emailCache.set(key, r?.user.profile?.email?.toLowerCase() ?? null);
    }
    const email = emailCache.get(key);
    if (email) emails.push(email);
  }
  return emails;
}

async function botToken(teamId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("workspace_installs")
    .select("bot_token_encrypted")
    .eq("provider", "slack")
    .eq("external_workspace_id", teamId)
    .maybeSingle();
  return data ? decrypt(data.bot_token_encrypted) : null;
}
