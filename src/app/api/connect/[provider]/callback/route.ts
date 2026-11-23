// Step 2: the provider sends the user back here with ?code=...&state=...
// We verify state, trade the code for tokens, save them encrypted, and run
// the first sync so the dashboard has data right away.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConnector, redirectUriFor } from "@/lib/connectors";
import { saveConnection, syncConnection } from "@/lib/connections";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/connect/[provider]/callback">,
) {
  const { provider } = await ctx.params;
  const { searchParams } = request.nextUrl;
  const cookieName = `oauth_state_${provider}`;
  const savedState = request.cookies.get(cookieName)?.value;

  const finish = (query: string) => {
    const response = NextResponse.redirect(new URL(`/dashboard?${query}`, request.url));
    response.cookies.set(cookieName, "", { maxAge: 0, path: "/api/connect" });
    return response;
  };

  const connector = getConnector(provider);
  if (!connector) return finish("error=unknown_provider");
  // The user clicked "Cancel" on the consent screen.
  if (searchParams.get("error")) return finish("error=cancelled");

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state || state !== savedState) return finish("error=state");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/", request.url));

  try {
    const result = await connector.exchangeCode(code, redirectUriFor(connector.provider));
    const connectionId = await saveConnection(user.id, connector.provider, result);
    await syncConnection(connectionId, user.id);
  } catch (e) {
    console.error(`[connect:${provider}]`, e);
    return finish("error=connect_failed");
  }

  return finish(`connected=${provider}`);
}
