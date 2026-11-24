import "server-only";
import { githubConnector } from "./github";
import { googleConnector } from "./google";
import type { Connector, Provider } from "./types";

// Register each new integration here.
const connectors: Partial<Record<Provider, Connector>> = {
  google: googleConnector,
  github: githubConnector,
};

export function getConnector(provider: string): Connector | null {
  return connectors[provider as Provider] ?? null;
}

// Must exactly match a redirect URI registered with the provider.
export function redirectUriFor(provider: Provider): string {
  return `${process.env.NEXT_PUBLIC_SITE_URL}/api/connect/${provider}/callback`;
}
