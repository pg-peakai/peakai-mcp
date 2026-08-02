export type ExtractorType =
  | "email"
  | "work_email"
  | "phone_no"
  | "enrich"
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
  // POST /mcp on the new backend — the lookup endpoint that accepts a regular
  // Nhost access token via the Authorization header. `params` carries the
  // type-specific input (profile_url, din, or value), sent in the JSON body
  // alongside the lookup `type`.
  const res = await fetch(`${apiBase}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type, ...params }),
  });

  if (!res.ok) {
    throw new Error(mapBackendError(res.status, await res.text()));
  }
  return (await res.json()) as ExtractorResult;
}

export async function getCredits(apiBase: string, jwt: string): Promise<unknown> {
  const res = await fetch(`${apiBase}/api/balance`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(mapBackendError(res.status, await res.text()));
  const data = (await res.json()) as Record<string, unknown>;
  // /api/balance returns { credits, account_type } — `credits` already
  // reflects organisation credits for org accounts, so no effective-credit
  // reconciliation is needed anymore.
  return {
    credits: data.credits,
    account_type: data.account_type,
  };
}

/**
 * POST a JSON body to a backend path with the user's JWT and return the parsed
 * JSON response. Shared by the /mcp/* search + enrich endpoints below. Backend
 * errors are mapped to clean messages via mapBackendError (never leaks the raw
 * body / underlying data vendor).
 */
async function postJson(
  apiBase: string,
  path: string,
  jwt: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(mapBackendError(res.status, await res.text()));
  return await res.json();
}

export interface LeadSearchFilters {
  search?: string;
  jobTitles?: string[];
  companies?: string[];
  locations?: string[];
  industries?: string[];
  companyHeadcount?: string[];
  maxPerCompany?: number;
}

export interface LeadSearchResult {
  search_id: string;
  total: number;
  count: number;
  view_url: string;
  leads: Array<Record<string, unknown>>;
}

export interface CompanySearchFilters {
  search?: string;
  industries?: string[];
  locations?: string[];
  headcount?: string[];
}

export interface CompanySearchResult {
  search_id: string;
  total: number;
  count: number;
  view_url: string;
  companies: Array<Record<string, unknown>>;
}

export interface LeadEnrichResult {
  lead_id: string;
  vanity_url?: string;
  phone_no: string[];
  email: string[];
  work_email: string[];
}

/** POST /mcp/lead-search — FREE lead search. Returns a persisted search + leads. */
export async function leadSearch(
  apiBase: string,
  jwt: string,
  filters: LeadSearchFilters,
  pages: number,
): Promise<LeadSearchResult> {
  return (await postJson(apiBase, "/mcp/lead-search", jwt, { filters, pages })) as LeadSearchResult;
}

/** POST /mcp/company-search — FREE company search. */
export async function companySearch(
  apiBase: string,
  jwt: string,
  filters: CompanySearchFilters,
  pages: number,
): Promise<CompanySearchResult> {
  return (await postJson(apiBase, "/mcp/company-search", jwt, { filters, pages })) as CompanySearchResult;
}

/**
 * POST /mcp/search-enrich — CHARGED per lookup (channel tagged 'mcp' server-side).
 * Resolves contact details for a lead by its `id` (from lead_search), NOT a URL.
 */
export async function leadEnrich(
  apiBase: string,
  jwt: string,
  lead_id: string,
  types: string[],
): Promise<LeadEnrichResult> {
  return (await postJson(apiBase, "/mcp/search-enrich", jwt, { lead_id, types })) as LeadEnrichResult;
}

export async function exchangePassword(
  apiBase: string,
  id: string,
  password: string,
): Promise<{ access_token: string; email?: string; token_expires_in?: string }> {
  const res = await fetch(`${apiBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, password }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()) as {
    access_token: string;
    email?: string;
    token_expires_in?: string;
  };
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
