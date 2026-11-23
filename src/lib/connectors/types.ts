// The contract every integration implements. Google, Slack, Microsoft, Zoom
// and GitHub each get one file that fills in these functions; everything else
// (saving tokens, refreshing, storing events) is shared code.

export type Provider = "google" | "slack" | "microsoft" | "zoom" | "github";

export type ActivityKind =
  | "meeting" | "message" | "thread_start" | "thread_reply" | "reaction"
  | "email_sent" | "doc_created" | "doc_edited"
  | "commit" | "pr_opened" | "pr_merged" | "review_given";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface ExternalAccount {
  id: string;           // the user's id inside the tool
  email: string | null; // used for identity resolution across tools
}

// Metadata only. There is intentionally no field for titles or content.
export interface ActivityEventInput {
  kind: ActivityKind;
  externalId: string;
  startedAt: Date;
  endedAt?: Date | null;
  attendeeCount?: number | null;
  participantEmails?: string[];
}

export interface FetchResult {
  events: ActivityEventInput[];
  from: Date; // the time window covered; existing rows in it get replaced
  to: Date;
  timezone?: string;
}

export interface Connector {
  provider: Provider;
  getAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ tokens: OAuthTokens; account: ExternalAccount }>;
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  fetchActivity(accessToken: string, since: Date): Promise<FetchResult>;
}
