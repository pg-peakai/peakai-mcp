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
  if (status === 429 || b.includes("daily") || b.includes("too many")) {
    return "Daily free search limit reached. Try again tomorrow, or narrow your filters and reuse the same search_id to page further.";
  }
  if (status === 400) {
    // Never echo the raw body (can leak the data vendor). Point at the fix.
    return "Invalid search request — check your filter values with search_filters (use exact ids/labels).";
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
  pastJobTitles?: string[];
  companies?: string[];
  pastCompanies?: string[];
  locations?: string[];
  companyHeadquarterLocations?: string[];
  industries?: string[];
  companyHeadcount?: string[];
  seniorityLevelIds?: string[];
  functionIds?: string[];
  recentlyChangedJobs?: boolean;
  excludeCurrentCompanies?: string[];
  excludeCurrentJobTitles?: string[];
  excludeLocations?: string[];
  maxPerCompany?: number;
}

export interface LeadSearchResult {
  search_id: string;
  total: number;
  count: number;
  view_url: string;
  leads: Array<Record<string, unknown>>;
  result_cap?: number;
  ignored_filters?: unknown;
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
  result_cap?: number;
  ignored_filters?: unknown;
}

export interface LeadEnrichResult {
  lead_id: string;
  vanity_url?: string;
  phone_no: string[];
  email: string[];
  work_email: string[];
}

/**
 * POST /mcp/lead-search — FREE lead search. Returns a persisted search + one
 * page of leads (25 per page). Pass `searchId` from a prior call to append the
 * next page under the same search instead of starting a new one.
 */
export async function leadSearch(
  apiBase: string,
  jwt: string,
  filters: LeadSearchFilters,
  page: number,
  searchId?: string,
): Promise<LeadSearchResult> {
  const body: Record<string, unknown> = { filters, page };
  if (searchId) body.search_id = searchId;
  return (await postJson(apiBase, "/mcp/lead-search", jwt, body)) as LeadSearchResult;
}

/** POST /mcp/company-search — FREE company search. One page = 50 companies. */
export async function companySearch(
  apiBase: string,
  jwt: string,
  filters: CompanySearchFilters,
  page: number,
  searchId?: string,
): Promise<CompanySearchResult> {
  const body: Record<string, unknown> = { filters, page };
  if (searchId) body.search_id = searchId;
  return (await postJson(apiBase, "/mcp/company-search", jwt, body)) as CompanySearchResult;
}

/**
 * GET /mcp/filter-options — public reference data (no auth): valid ids/labels
 * for the enum-style filters (industries, seniority, functions, headcount, …).
 * Fetch this to build precise searches; guessed enum values match nothing.
 */
export async function getFilterOptions(apiBase: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}/mcp/filter-options`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(mapBackendError(res.status, await res.text()));
  return (await res.json()) as Record<string, unknown>;
}

export interface SearchSummary {
  search_id: string;
  search_name: string | null;
  kind: "lead" | "company";
  total_rows: number;
  enriched_rows: number;
  exported_rows: number;
  created_at: string;
  updated_at?: string | null;
}

/**
 * GET /mcp/searches — the user's own recent searches (one row each, with
 * found/enriched/exported counts). This is the "memory" the agent can recall to
 * continue prior work and reuse a person's targeting across sessions.
 */
export async function getSearches(
  apiBase: string,
  jwt: string,
  limit: number,
): Promise<{ searches: SearchSummary[]; total: number }> {
  const res = await fetch(`${apiBase}/mcp/searches?limit=${limit}`, {
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(mapBackendError(res.status, await res.text()));
  return (await res.json()) as { searches: SearchSummary[]; total: number };
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

export interface ExportLeadsResult {
  enriched_count: number;
  credits_charged: number;
  credits_remaining: number | null;
  charged_rows: number;
  leads: Array<Record<string, unknown>>;
}

/**
 * POST /mcp/lead-export — the deliberate EXPORT step: take MANY searched leads
 * out in ONE call. Two modes, set by `types`:
 *  - types omitted → pure export of already-revealed contacts (fast; the heavy
 *    enrichment already happened). Good for taking ~1000 out at once.
 *  - types provided → reveal-and-export: unrevealed rows are enriched
 *    concurrently (8 at a time) and billed as one batch; already-revealed rows
 *    are free. Slower per row, so keep these batches smaller.
 * Export is charged (0.5 credit/row, min 2) on rows not previously exported;
 * re-downloading an already-exported row is free.
 */
export async function exportLeads(
  apiBase: string,
  jwt: string,
  searchId: string,
  leadIds: string[],
  types?: string[],
): Promise<ExportLeadsResult> {
  const body: Record<string, unknown> = { search_id: searchId, lead_ids: leadIds };
  if (types && types.length > 0) body.enrich_types = types;
  return (await postJson(apiBase, "/mcp/lead-export", jwt, body)) as ExportLeadsResult;
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
