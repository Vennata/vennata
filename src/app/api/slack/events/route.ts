// Slack pushes events here (POST) in real time: messages, reactions, etc.
//
// Security: this URL is public, so anyone could POST fake events. Every real
// Slack request is signed with our signing secret (HMAC-SHA256); we recompute
// the signature and reject anything that doesn't match or is older than 5 min
// (stops someone replaying an old captured request).
//
// Speed: Slack gives up (and retries) after 3 seconds, so we reply 200 right
// away and do the database work in after(), once the response is sent.
import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { handleSlackEvent } from "@/lib/connectors/slack";

function isFromSlack(rawBody: string, timestamp: string | null, signature: string | null): boolean {
  if (!timestamp || !signature || !process.env.SLACK_SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const expected = "v0=" + createHmac("sha256", process.env.SLACK_SIGNING_SECRET!)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  // timingSafeEqual takes the same time whether the first or last character
  // differs, so attackers can't guess the signature one character at a time.
  return expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function POST(request: NextRequest) {
  // Read the raw text: the signature is computed over the exact bytes Slack sent.
  const rawBody = await request.text();
  if (!isFromSlack(
    rawBody,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
  )) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // One-time handshake when the events URL is saved in Slack's settings.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    after(async () => {
      try {
        // authorizations[0] is our bot in this workspace; used to spot when
        // the bot itself joins a channel.
        await handleSlackEvent(payload.team_id, payload.event, payload.authorizations?.[0]?.user_id);
      } catch (e) {
        // Log the error only, never the payload: it contains message text.
        console.error("[slack:event]", e instanceof Error ? e.message : e);
      }
    });
  }

  return new NextResponse(null, { status: 200 });
}
