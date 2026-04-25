export type ExtractorType =
  | "email"
  | "work_email"
  | "phone_no"
  | "profile_enrichment"
  | "reverse_lookup"
  | "din_phone"
  | "din_email";

export interface ExtractorResult {
  linkedin_url?: string;
  [key: string]: unknown;
}

export async function callExtractor(
  apiBase: string,
  jwt: string,
  type: ExtractorType,
  profileUrl: string,
): Promise<ExtractorResult> {
  // Use /webhook/extractor1 — the studio.thepeakai.com endpoint that accepts
  // a regular Nhost JWT. /webhook/extractor (no suffix) is the public API and
  // requires a separately-issued API key.
  const url = new URL(`${apiBase}/webhook/extractor1`);
  url.searchParams.set("access_token", jwt);
  url.searchParams.set("type", type);
  url.searchParams.set("profile_url", profileUrl);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PeakAI ${type} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as ExtractorResult;
}

export async function exchangePassword(
  apiBase: string,
  id: string,
  password: string,
): Promise<{ access_token: string }> {
  const res = await fetch(`${apiBase}/webhook/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, password }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()) as { access_token: string };
}
