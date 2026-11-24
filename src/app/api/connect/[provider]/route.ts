// Step 1 of connecting a tool: send the user to the provider's consent screen.
// GET /api/connect/google
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConnector, redirectUriFor } from "@/lib/connectors";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/connect/[provider]">) {
  const { provider } = await ctx.params;
  const connector = getConnector(provider);
  if (!connector) return new NextResponse("Unknown provider", { status: 404 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/", request.url));

  // "state" is a random value we check when the user comes back. It proves
  // the callback belongs to a flow *we* started (prevents CSRF attacks).
  const state = randomBytes(16).toString("hex");

  // ?mode=install sends the user to install the app on an account/org
  // (GitHub), instead of just authorizing.
  const install = request.nextUrl.searchParams.get("mode") === "install";
  const url = install && connector.getInstallUrl
    ? connector.getInstallUrl(state)
    : connector.getAuthUrl(state, redirectUriFor(connector.provider));

  const response = NextResponse.redirect(url);
  response.cookies.set(`oauth_state_${provider}`, state, {
    httpOnly: true, // page JavaScript can't read it
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,    // 10 minutes to finish connecting
    path: "/api/connect",
  });
  return response;
}
