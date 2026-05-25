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

/**
 * Map a backend error (HTTP status + body) to a clean, user-facing message.
 * Never leaks the raw backend body — that can expose the underlying data vendor.
 */
export function mapBackendError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 || b.includes("expired") || b.includes("invalid token") || b.includes("unauthor")) {
    return "Invalid or expired access token";
  }
  if (status === 402 || b.includes("not enough credit") || b.includes("recharge") || b.includes("insufficient")) {
    return "Not enough credits. Please recharge.";
  }
  if (status === 403 || b.includes("not enabled") || b.includes("api access")) {
    return "API access is not enabled for your account. Email studio@thepeakai.com to enable it.";
  }
  return `PeakAI request failed (${status})`;
}

export async function callExtractor(
  apiBase: string,
  jwt: string,
  type: ExtractorType,
  params: Record<string, string>,
): Promise<ExtractorResult> {
  // Use /webhook/extractor1 — the endpoint that accepts a regular access token.
  // /webhook/extractor (no suffix) is the public API and requires a
  // separately-issued API key.
  // `params` carries the type-specific input (profile_url, din, or value),
  // matching the PeakAI REST API contract exactly.
  const url = new URL(`${apiBase}/webhook/extractor1`);
  url.searchParams.set("access_token", jwt);
  url.searchParams.set("type", type);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(mapBackendError(res.status, await res.text()));
  }
  return (await res.json()) as ExtractorResult;
}

export async function getCredits(apiBase: string, jwt: string): Promise<unknown> {
  const url = new URL(`${apiBase}/webhook/get_credits`);
  url.searchParams.set("access_token", jwt);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(mapBackendError(res.status, await res.text()));
  const data = (await res.json()) as Record<string, unknown>;
  // Return only the credit-relevant subset, not the full user blob.
  return {
    type: data.type,
    credits: data.credits,
    organisation_credits: data.organisation_credits,
    organisation_name: data.organisation_name,
    effective_credits:
      data.type === "organisation" &&
      data.organisation_id &&
      data.organisation_id !== "null" &&
      typeof data.organisation_credits === "number" &&
      (data.organisation_credits as number) > 0
        ? data.organisation_credits
        : data.credits,
  };
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

/**
 * Refresh an Nhost session using the stored refresh token.
 * Hits POST {nhostAuthBase}/v1/token?refreshToken=<token>.
 * Returns the new accessToken and (rotated) refreshToken.
 */
export async function refreshNhost(
  nhostAuthBase: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresIn: number } | null> {
  const url = `${nhostAuthBase}/v1/token?refreshToken=${encodeURIComponent(refreshToken)}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresIn?: number;
  };
  if (!data.accessToken || !data.refreshToken) return null;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessTokenExpiresIn: data.accessTokenExpiresIn ?? 900,
  };
}

/**
 * Decode JWT exp claim without verification.
 * Returns Unix-seconds, or null if unparseable.
 */
export function jwtExp(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/").padEnd(parts[1]!.length + ((4 - (parts[1]!.length % 4)) % 4), "=");
    const json = atob(padded);
    const claims = JSON.parse(json) as { exp?: number };
    return claims.exp ?? null;
  } catch {
    return null;
  }
}
