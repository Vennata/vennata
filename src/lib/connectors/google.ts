// Google Calendar connector. Plain fetch() against Google's REST APIs: no SDK,
// so you can see exactly what goes over the wire.
import "server-only";
import type { ActivityEventInput, Connector, OAuthTokens } from "./types";

// Minimum scopes: identify the account + read calendar events.
// calendar.events.readonly is a "sensitive" scope, which is why Google
// verification is needed before launch (test users work until then).
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

// Ask Google to send ONLY these fields. Titles, descriptions, locations and
// attachments never even leave Google's servers.
const EVENT_FIELDS =
  "nextPageToken,timeZone,items(id,status,eventType,start,end,attendees(email,self,resource,responseStatus))";

// Calendar entries that aren't real meetings.
const SKIP_EVENT_TYPES = new Set(["workingLocation", "outOfOffice", "focusTime", "birthday"]);

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

function toTokens(t: GoogleTokenResponse, fallbackRefresh: string | null = null): OAuthTokens {
  return {
    accessToken: t.access_token,
    // Google only sends a refresh token the first time; keep the old one on refresh.
    refreshToken: t.refresh_token ?? fallbackRefresh,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
    scopes: t.scope.split(" "),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  return res.json();
}

export const googleConnector: Connector = {
  provider: "google",

  getAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline", // gives us a refresh token for background syncs
      prompt: "consent",      // makes Google re-issue the refresh token on reconnect
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchangeCode(code, redirectUri) {
    const t = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });

    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (!res.ok) throw new Error(`Google userinfo error ${res.status}`);
    const info: { sub: string; email?: string } = await res.json();

    return { tokens: toTokens(t), account: { id: info.sub, email: info.email?.toLowerCase() ?? null } };
  },

  async refreshTokens(refreshToken) {
    const t = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
    return toTokens(t, refreshToken);
  },

  async fetchActivity(accessToken, since) {
    const to = new Date();
    const events: ActivityEventInput[] = [];
    let timezone: string | undefined;
    let pageToken: string | undefined;

    // Google returns results in pages; keep requesting until there's no next page.
    do {
      const params = new URLSearchParams({
        timeMin: since.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true", // expand recurring meetings into individual occurrences
        maxResults: "2500",
        fields: EVENT_FIELDS,
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Google Calendar error ${res.status}: ${await res.text()}`);
      const page = await res.json();
      timezone ??= page.timeZone;

      for (const item of page.items ?? []) {
        const event = toMeeting(item);
        if (event) events.push(event);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return { events, from: since, to, timezone };
  },
};

interface GoogleEvent {
  id: string;
  status?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

// Decide whether a calendar entry counts as a meeting, and keep only metadata.
function toMeeting(e: GoogleEvent): ActivityEventInput | null {
  if (e.status === "cancelled") return null;
  if (e.eventType && SKIP_EVENT_TYPES.has(e.eventType)) return null;
  // All-day entries (holidays, OOO) have a date but no time.
  if (!e.start?.dateTime || !e.end?.dateTime) return null;

  const people = (e.attendees ?? []).filter((a) => !a.resource); // drop meeting rooms
  const me = people.find((a) => a.self);
  if (me?.responseStatus === "declined") return null;

  const others = people.filter((a) => !a.self && a.email);
  // A block with nobody else on it is a personal reminder, not a meeting.
  if (others.length === 0) return null;

  return {
    kind: "meeting",
    externalId: e.id,
    startedAt: new Date(e.start.dateTime),
    endedAt: new Date(e.end.dateTime),
    attendeeCount: people.length,
    participantEmails: others.map((a) => a.email!.toLowerCase()),
  };
}
