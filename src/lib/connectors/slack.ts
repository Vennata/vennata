// Slack connector. Two separate flows:
//   * INSTALL (getInstallUrl): someone adds the Vennata app to a workspace.
//     We get a bot token, the bot joins public channels, and Slack starts
//     sending us events (see handleSlackEvent below).
//   * LINK (getAuthUrl): "Sign in with Slack". Tells us which Slack user is
//     which Vennata user. Only linked users' activity is ever counted.
//
// Slack doesn't let non-Marketplace apps read message history at a useful
// rate, so counting starts at install and there's nothing to backfill.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import type { ActivityEventInput, Connector } from "./types";

// Bot permissions. history scopes are needed to RECEIVE message events in
// channels the bot is in; we still never read or store the text.
const BOT_SCOPES = [
  "channels:history", "groups:history", // message events (public / private channels)
  "channels:read", "channels:join",     // find and join public channels
  "reactions:read",                     // reaction events
  "users:read", "users:read.email",     // map Slack users to emails (#1 collaborator)
];

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
      response_type: "code",
      scope: "openid email profile",
      client_id: process.env.SLACK_CLIENT_ID!,
      redirect_uri: redirectUri,
      state,
    });
    return `https://slack.com/openid/connect/authorize?${params}`;
  },

  getInstallUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      scope: BOT_SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },

  async exchangeInstall(code, redirectUri) {
    const r = await slackApi<SlackResponse & {
      access_token: string; scope: string; team: { id: string };
    }>("oauth.v2.access", oauthParams(code, redirectUri));
    await joinPublicChannels(r.access_token);
    return { workspaceId: r.team.id, botToken: r.access_token, scopes: r.scope.split(",") };
  },

  async exchangeCode(code, redirectUri) {
    const t = await slackApi<SlackResponse & { access_token: string }>(
      "openid.connect.token", oauthParams(code, redirectUri),
    );
    const info = await slackApi<SlackResponse & {
      sub: string; email?: string; "https://slack.com/team_id": string;
    }>("openid.connect.userInfo", {}, t.access_token);

    return {
      // Slack user ids are only unique within a workspace, so include the team.
      account: { id: `${info["https://slack.com/team_id"]}:${info.sub}`, email: info.email?.toLowerCase() ?? null },
      tokens: { accessToken: t.access_token, refreshToken: null, expiresAt: null, scopes: ["openid", "email", "profile"] },
    };
  },

  async refreshTokens() {
    throw new Error("Slack sign-in tokens don't expire");
  },

  // Events are pushed to /api/slack/events in real time, so "Sync now" has
  // nothing to fetch. An empty window means nothing gets deleted either.
  async fetchActivity() {
    const now = new Date();
    return { events: [], from: now, to: now };
  },
};

// The bot only receives events from channels it's in. Joining every public
// channel on install means nobody has to /invite it one by one. (Private
// channels still need an invite, which is the right call for privacy.)
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

export async function handleSlackEvent(teamId: string, event: SlackEvent) {
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
