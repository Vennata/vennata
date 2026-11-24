// The app's public base URL, used to build OAuth redirect URLs.
//   1. NEXT_PUBLIC_SITE_URL if set (localhost in .env.local; the custom domain later)
//   2. On Vercel: the production URL Vercel provides automatically
//   3. Fallback: local dev
export function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "http://localhost:3000";
}
