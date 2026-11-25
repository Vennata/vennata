import "server-only";
import { githubConnector } from "./github";
import { googleConnector } from "./google";
import { slackConnector } from "./slack";
import type { Connector, Provider } from "./types";
import { siteUrl } from "@/lib/site";

// Register each new integration here.
const connectors: Partial<Record<Provider, Connector>> = {
  google: googleConnector,
  github: githubConnector,
  slack: slackConnector,
};

export function getConnector(provider: string): Connector | null {
  return connectors[provider as Provider] ?? null;
}

// Must exactly match a redirect URI registered with the provider.
export function redirectUriFor(provider: Provider): string {
  return `${siteUrl()}/api/connect/${provider}/callback`;
}
