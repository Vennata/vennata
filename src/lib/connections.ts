// Shared logic for every connector: save a connection, keep its token fresh,
// and sync its activity into activity_events. Uses the admin client, so every
// function takes the already-verified userId and checks ownership itself.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import { getConnector } from "@/lib/connectors";
import type { ExternalAccount, OAuthTokens, Provider, WorkspaceInstall } from "@/lib/connectors/types";

const BACKFILL_DAYS = 365;

export class ConnectionError extends Error {}

export async function saveConnection(
  userId: string,
  provider: Provider,
  { tokens, account }: { tokens: OAuthTokens; account: ExternalAccount },
): Promise<string> {
  const db = createAdminClient();

  // For now, activity belongs to the user's personal space. When company
  // spaces arrive, posters (not raw events) are what get shared there.
  const { data: membership } = await db
    .from("memberships")
    .select("company_id, companies!inner(is_personal)")
    .eq("user_id", userId)
    .eq("companies.is_personal", true)
    .single();
  if (!membership) throw new ConnectionError("No personal space found");

  // One tool account can only belong to one Vennata user.
  const { data: existing } = await db
    .from("connections")
    .select("id, user_id")
    .eq("provider", provider)
    .eq("external_account_id", account.id)
    .maybeSingle();
  if (existing && existing.user_id !== userId) {
    throw new ConnectionError("This account is already connected to another Vennata user");
  }

  const { data: connection, error } = await db
    .from("connections")
    .upsert(
      {
        user_id: userId,
        company_id: membership.company_id,
        provider,
        external_account_id: account.id,
        external_email: account.email,
        scopes: tokens.scopes,
        status: "active",
      },
      { onConflict: "provider,external_account_id" },
    )
    .select("id")
    .single();
  if (error || !connection) throw new ConnectionError(`Saving connection failed: ${error?.message}`);

  await storeTokens(connection.id, tokens);
  return connection.id;
}

export async function saveWorkspaceInstall(
  userId: string,
  provider: Provider,
  workspace: WorkspaceInstall,
) {
  const db = createAdminClient();
  const { data: membership } = await db
    .from("memberships")
    .select("company_id, companies!inner(is_personal)")
    .eq("user_id", userId)
    .eq("companies.is_personal", true)
    .single();
  if (!membership) throw new ConnectionError("No personal space found");

  // Reinstalling (e.g. to add permissions) replaces the old bot token.
  const { error } = await db.from("workspace_installs").upsert(
    {
      provider,
      external_workspace_id: workspace.workspaceId,
      company_id: membership.company_id,
      installed_by: userId,
      bot_token_encrypted: encrypt(workspace.botToken),
      scopes: workspace.scopes,
    },
    { onConflict: "provider,external_workspace_id" },
  );
  if (error) throw new ConnectionError(`Saving workspace install failed: ${error.message}`);
}

async function storeTokens(connectionId: string, tokens: OAuthTokens) {
  const { error } = await createAdminClient()
    .from("connection_secrets")
    .upsert({
      connection_id: connectionId,
      access_token_encrypted: encrypt(tokens.accessToken),
      // Don't wipe a saved refresh token if this response didn't include one.
      ...(tokens.refreshToken && { refresh_token_encrypted: encrypt(tokens.refreshToken) }),
      expires_at: tokens.expiresAt?.toISOString() ?? null,
    });
  if (error) throw new ConnectionError(`Saving tokens failed: ${error.message}`);
}

// Returns a working access token, refreshing it first if it's about to expire.
async function getAccessToken(connectionId: string, provider: Provider): Promise<string> {
  const db = createAdminClient();
  const { data: secret } = await db
    .from("connection_secrets")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at")
    .eq("connection_id", connectionId)
    .single();
  if (!secret) throw new ConnectionError("Missing tokens; reconnect this tool");

  const expiresSoon = secret.expires_at && new Date(secret.expires_at).getTime() < Date.now() + 60_000;
  if (!expiresSoon) return decrypt(secret.access_token_encrypted);

  if (!secret.refresh_token_encrypted) throw new ConnectionError("Token expired; reconnect this tool");
  try {
    const tokens = await getConnector(provider)!.refreshTokens(decrypt(secret.refresh_token_encrypted));
    await storeTokens(connectionId, tokens);
    return tokens.accessToken;
  } catch (e) {
    // Usually means the user revoked access in their Google account settings.
    await db.from("connections").update({ status: "expired" }).eq("id", connectionId);
    throw e;
  }
}

export async function syncConnection(connectionId: string, userId: string): Promise<number> {
  const db = createAdminClient();
  const { data: connection } = await db
    .from("connections")
    .select("id, user_id, company_id, provider")
    .eq("id", connectionId)
    .eq("user_id", userId) // ownership check: you can only sync your own connections
    .single();
  if (!connection) throw new ConnectionError("Connection not found");

  const provider = connection.provider as Provider;
  const accessToken = await getAccessToken(connection.id, provider);
  const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const result = await getConnector(provider)!.fetchActivity(accessToken, since);

  // Replace everything in the synced window. That way meetings that were
  // cancelled or moved since the last sync don't linger as stale rows.
  const { error: deleteError } = await db
    .from("activity_events")
    .delete()
    .eq("connection_id", connection.id)
    .gte("started_at", result.from.toISOString());
  if (deleteError) throw new ConnectionError(`Clearing old events failed: ${deleteError.message}`);

  const rows = result.events.map((e) => ({
    user_id: connection.user_id,
    company_id: connection.company_id,
    connection_id: connection.id,
    provider,
    kind: e.kind,
    external_id: e.externalId,
    started_at: e.startedAt.toISOString(),
    ended_at: e.endedAt?.toISOString() ?? null,
    attendee_count: e.attendeeCount ?? null,
    participant_emails: e.participantEmails ?? [],
    precision: e.precision ?? "exact",
    quantity: e.quantity ?? 1,
    lines_added: e.linesAdded ?? null,
    lines_removed: e.linesRemoved ?? null,
  }));

  // Insert in chunks so one huge request doesn't time out.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("activity_events").insert(rows.slice(i, i + 500));
    if (error) throw new ConnectionError(`Saving events failed: ${error.message}`);
  }

  await db
    .from("connections")
    .update({ last_synced_at: new Date().toISOString(), status: "active" })
    .eq("id", connection.id);

  // Use the calendar's timezone for "peak hour" and "after hours" stats,
  // unless the user has already set one.
  if (result.timezone) {
    await db.from("profiles").update({ timezone: result.timezone })
      .eq("id", userId).eq("timezone", "UTC");
  }

  return rows.length;
}
