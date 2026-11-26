// The contract every integration implements. Google, Slack, Microsoft, Zoom
// and GitHub each get one file that fills in these functions; everything else
// (saving tokens, refreshing, storing events) is shared code.

export type Provider = "google" | "slack" | "microsoft" | "zoom" | "github";

export type ActivityKind =
  | "meeting" | "message" | "thread_start" | "thread_reply" | "reaction"
  | "email_sent" | "doc_created" | "doc_edited"
  | "commit" | "pr_opened" | "pr_merged" | "review_given"
  | "contribution"; // GitHub daily total whose type is hidden

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
  // "day" = we only know the date (startedAt is midnight UTC), so stats like
  // peak hour and after-hours must skip it. Defaults to "exact".
  precision?: "exact" | "day";
  quantity?: number; // how many actions this row stands for (default 1)
  endedAt?: Date | null;
  attendeeCount?: number | null;
  participantEmails?: string[];
  linesAdded?: number;   // commits only
  linesRemoved?: number;
}

export interface WorkspaceInstall {
  workspaceId: string;
  botToken: string;
  scopes: string[];
  installerIsAdmin?: boolean;
}

export interface FetchResult {
  events: ActivityEventInput[];
  from: Date; // the time window covered; existing rows in it get replaced
  to: Date;
  merge?: boolean; // add missing rows only, never delete (see syncConnection)
  timezone?: string;
}

export interface Connector {
  provider: Provider;
  getAuthUrl(state: string, redirectUri: string): string;
  // For tools installed separately from connecting (GitHub Apps): where an
  // admin (or a user, on their own account) installs the app.
  getInstallUrl?(state: string, redirectUri: string): string;
  // `workspace` is set when connecting also installed an app on a whole
  // workspace (Slack): its bot token belongs to the company, not the person.
  exchangeCode(code: string, redirectUri: string): Promise<{
    tokens: OAuthTokens;
    account: ExternalAccount;
    workspace?: WorkspaceInstall;
  }>;
  // Optional setup once a workspace install is saved. Can return a notice key
  // for the dashboard (e.g. "slack_member": ask an admin to finish setup).
  afterInstall?(workspace: WorkspaceInstall): Promise<string | void>;
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  fetchActivity(accessToken: string, since: Date): Promise<FetchResult>;
}
