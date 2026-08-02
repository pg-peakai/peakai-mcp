import {
  callExtractor,
  getCredits,
  leadSearch,
  companySearch,
  leadEnrich,
  type ExtractorType,
  type LeadSearchFilters,
  type CompanySearchFilters,
} from "./peakai";

export interface ToolDef {
  name: string;
  /** Human-readable display title (Anthropic Connectors Directory requirement). */
  title: string;
  description: string;
  /** True if the tool only reads data and never modifies state. */
  readOnlyHint: boolean;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  run: (args: Record<string, unknown>, ctx: { jwt: string; apiBase: string }) => Promise<unknown>;
}

const LINKEDIN_RE = /^https?:\/\/([\w-]+\.)*linkedin\.com\//i;

function makeProfileTool(
  name: string,
  title: string,
  description: string,
  type: ExtractorType,
): ToolDef {
  return {
    name,
    title,
    description,
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        profile_url: {
          type: "string",
          description: "Full LinkedIn profile URL, e.g. https://www.linkedin.com/in/johndoe",
        },
      },
      required: ["profile_url"],
    },
    async run(args, { jwt, apiBase }) {
      const profile_url = String(args.profile_url ?? "").trim();
      if (!LINKEDIN_RE.test(profile_url)) throw new Error("profile_url must be a linkedin.com URL");
      return await callExtractor(apiBase, jwt, type, { profile_url });
    },
  };
}

function makeDirectorTool(
  name: string,
  title: string,
  description: string,
  type: ExtractorType,
): ToolDef {
  return {
    name,
    title,
    description,
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        din: {
          type: "string",
          description: "Director Identification Number (DIN) of an Indian company director",
        },
      },
      required: ["din"],
    },
    async run(args, { jwt, apiBase }) {
      const din = String(args.din ?? "").trim();
      if (!din) throw new Error("din is required");
      return await callExtractor(apiBase, jwt, type, { din });
    },
  };
}

// Lookup types supported in bulk. Each maps to the field its result carries.
const BULK_TYPES: Record<string, { field: string; label: string }> = {
  phone_no: { field: "phone_no", label: "phone number" },
  email: { field: "email", label: "personal email" },
  work_email: { field: "work_email", label: "work email" },
};

const BULK_MAX = 250;

// Beta: search tools return only a small sample to the agent — the human opens
// view_url to confirm before we trust bulk output.
const SAMPLE_ROWS = 5;

function interpretResult(type: string, result: Record<string, unknown>) {
  const raw = result[BULK_TYPES[type]!.field];
  const notFound =
    raw == null ||
    raw === "" ||
    (typeof raw === "string" && raw.trim().toLowerCase() === "not found") ||
    (Array.isArray(raw) && raw.length === 0);
  return {
    notFound,
    value: notFound ? undefined : raw,
    from_cache: result.from_cache,
    credits_charged: result.credits_charged,
    credits_remaining: result.credits_remaining,
  };
}

export const TOOLS: ToolDef[] = [
  makeProfileTool(
    "find_phone",
    "Find phone number",
    "Find a person's personal phone number(s) from their LinkedIn profile.",
    "phone_no",
  ),
  makeProfileTool(
    "find_personal_email",
    "Find personal email",
    "Find a person's personal email address from their LinkedIn profile.",
    "email",
  ),
  makeProfileTool(
    "find_work_email",
    "Find work email",
    "Find a person's work (corporate) email address from their LinkedIn profile.",
    "work_email",
  ),
  makeProfileTool(
    "enrich_profile",
    "Enrich LinkedIn profile",
    "Fetch the full LinkedIn profile (name, headline, experience, education, etc.).",
    "enrich",
  ),
  makeDirectorTool(
    "find_director_phone",
    "Find director phone (India)",
    "Find a phone number for an Indian company director by DIN (Director Identification Number).",
    "din_phone",
  ),
  makeDirectorTool(
    "find_director_email",
    "Find director email (India)",
    "Find an email for an Indian company director by DIN (Director Identification Number).",
    "din_email",
  ),
  {
    name: "reverse_lookup",
    title: "Reverse lookup (email/phone → profile)",
    description:
      "Resolve a person's profile from an email address or phone number. A bare 10-digit number is treated as an Indian mobile (+91 added); pass a full country code otherwise.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: "An email address or phone number to reverse-look up",
        },
      },
      required: ["value"],
    },
    async run(args, { jwt, apiBase }) {
      let value = String(args.value ?? "").trim();
      if (!value) throw new Error("value is required");
      // A bare 10-digit number is treated as an Indian mobile.
      if (/^\d{10}$/.test(value)) value = `+91${value}`;
      return await callExtractor(apiBase, jwt, "reverse_lookup", { value });
    },
  },
  {
    name: "bulk_lookup",
    title: "Bulk lookup (phone / email for many profiles)",
    description:
      "Find a phone number or email for many LinkedIn profiles in ONE call. Processed sequentially server-side and returned as a compact summary, so it's far cheaper than calling a single-lookup tool per profile. Use this whenever you have a list of profiles (e.g. from a spreadsheet). Max 250 profiles per call — split larger lists into batches of 100–250.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["phone_no", "email", "work_email"],
          description: "What to find for each profile: phone_no, email (personal), or work_email.",
        },
        profile_urls: {
          type: "array",
          items: { type: "string" },
          description: "LinkedIn profile URLs (1–250). Duplicates are removed automatically.",
        },
      },
      required: ["type", "profile_urls"],
    },
    async run(args, { jwt, apiBase }) {
      const type = String(args.type ?? "");
      if (!(type in BULK_TYPES)) throw new Error("type must be one of: phone_no, email, work_email");
      const input = Array.isArray(args.profile_urls) ? args.profile_urls : [];
      if (input.length === 0) throw new Error("profile_urls must be a non-empty array");

      // Dedupe (preserve order) so we never charge twice for the same profile.
      const seen = new Set<string>();
      const urls: string[] = [];
      for (const u of input) {
        const url = String(u ?? "").trim();
        if (url && !seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
      if (urls.length > BULK_MAX) {
        throw new Error(
          `Too many profiles (${urls.length}). Max ${BULK_MAX} per call — split into batches of 100–250.`,
        );
      }

      const results: Array<Record<string, unknown>> = [];
      let found = 0;
      let not_found = 0;
      let errors = 0;
      let credits_charged_total = 0;
      let credits_remaining: unknown;
      let aborted: string | undefined;

      // Sequential on purpose — gentle on the backend and keeps credit
      // accounting predictable. Per-row failures are recorded and we continue;
      // running out of credits stops the whole batch.
      for (const profile_url of urls) {
        if (!LINKEDIN_RE.test(profile_url)) {
          results.push({ profile_url, status: "error", message: "Not a linkedin.com URL" });
          errors++;
          continue;
        }
        try {
          const r = (await callExtractor(apiBase, jwt, type as ExtractorType, { profile_url })) as Record<
            string,
            unknown
          >;
          const got = interpretResult(type, r);
          if (typeof got.credits_charged === "number") credits_charged_total += got.credits_charged;
          if (got.credits_remaining !== undefined) credits_remaining = got.credits_remaining;
          if (got.notFound) {
            not_found++;
            results.push({ profile_url, status: "not_found" });
          } else {
            found++;
            results.push({ profile_url, status: "found", value: got.value, from_cache: got.from_cache });
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes("Not enough credits")) {
            aborted = "out_of_credits";
            break;
          }
          errors++;
          results.push({ profile_url, status: "error", message });
        }
      }

      return {
        type,
        requested: input.length,
        duplicates_removed: input.length - urls.length,
        processed: results.length,
        found,
        not_found,
        errors,
        credits_charged_total,
        credits_remaining,
        ...(aborted ? { aborted } : {}),
        results,
      };
    },
  },
  {
    name: "lead_search",
    title: "Lead search (find people by filters)",
    description:
      "Search PeakAI's lead database for PEOPLE by filters (job titles, companies, locations, industries, company headcount). FREE — no credits charged. " +
      "Returns a saved search plus a SHORT sample (~5 rows) — not the full list. " +
      "WORKFLOW: (1) call lead_search, (2) open the returned view_url and confirm the results look right, " +
      "(3) take a lead's `id` from the results and call lead_enrich(lead_id, types) to get contact details. " +
      "Note: a lead's linkedin_url is id-form — do NOT feed it into bulk_lookup; lead_enrich resolves it from the id.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          description: "Lead filters. All optional; combine to narrow results.",
          properties: {
            search: { type: "string", description: "Free-text keyword search." },
            jobTitles: { type: "array", items: { type: "string" }, description: "Job titles to match, e.g. [\"Head of Sales\", \"CMO\"]." },
            companies: { type: "array", items: { type: "string" }, description: "Company names to match." },
            locations: { type: "array", items: { type: "string" }, description: "Locations, e.g. [\"Bangalore\", \"United States\"]." },
            industries: { type: "array", items: { type: "string" }, description: "Industries to match." },
            companyHeadcount: { type: "array", items: { type: "string" }, description: "Company size bands, e.g. [\"11-50\", \"51-200\"]." },
            maxPerCompany: { type: "number", description: "Cap leads returned per company." },
          },
        },
        pages: { type: "number", description: "Number of result pages to fetch (default 1)." },
      },
      required: ["filters"],
    },
    async run(args, { jwt, apiBase }) {
      const filters = (args.filters ?? {}) as LeadSearchFilters;
      const pages = typeof args.pages === "number" ? args.pages : 1;
      const r = await leadSearch(apiBase, jwt, filters, pages);
      const sample = (r.leads ?? []).slice(0, SAMPLE_ROWS);
      return {
        message: `Found ${r.count} of ${r.total}. Verify: ${r.view_url}`,
        search_id: r.search_id,
        count: r.count,
        total: r.total,
        view_url: r.view_url,
        sample,
        note:
          "Beta: only a sample is shown — open view_url to confirm before trusting the results. " +
          "To get contact details, take a lead `id` above and call lead_enrich(lead_id, types).",
      };
    },
  },
  {
    name: "company_search",
    title: "Company search (find companies by filters)",
    description:
      "Search PeakAI's database for COMPANIES by filters (industries, locations, headcount). FREE — no credits charged. " +
      "Returns a saved search plus a SHORT sample (~5 rows) — not the full list. " +
      "Open the returned view_url to review the full set before relying on it.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          description: "Company filters. All optional; combine to narrow results.",
          properties: {
            search: { type: "string", description: "Free-text keyword search." },
            industries: { type: "array", items: { type: "string" }, description: "Industries to match." },
            locations: { type: "array", items: { type: "string" }, description: "Locations to match." },
            headcount: { type: "array", items: { type: "string" }, description: "Company size bands, e.g. [\"11-50\", \"51-200\"]." },
          },
        },
        pages: { type: "number", description: "Number of result pages to fetch (default 1)." },
      },
      required: ["filters"],
    },
    async run(args, { jwt, apiBase }) {
      const filters = (args.filters ?? {}) as CompanySearchFilters;
      const pages = typeof args.pages === "number" ? args.pages : 1;
      const r = await companySearch(apiBase, jwt, filters, pages);
      const sample = (r.companies ?? []).slice(0, SAMPLE_ROWS);
      return {
        message: `Found ${r.count} of ${r.total}. Verify: ${r.view_url}`,
        search_id: r.search_id,
        count: r.count,
        total: r.total,
        view_url: r.view_url,
        sample,
        note: "Beta: only a sample is shown — open view_url to confirm before trusting the results.",
      };
    },
  },
  {
    name: "lead_enrich",
    title: "Enrich a lead (phone / email)",
    description:
      "Get contact details (phone, personal email, work email) for a lead found via lead_search. CHARGED per lookup type. " +
      "Pass the lead's `id` from lead_search results — NOT a URL. Returns arrays per type; an empty array means none were found.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        lead_id: {
          type: "string",
          description: "The lead `id` from lead_search results (not a linkedin_url).",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["phone_no", "email", "work_email"] },
          description: "Which contacts to fetch: phone_no, email (personal), work_email. Each is charged.",
        },
      },
      required: ["lead_id", "types"],
    },
    async run(args, { jwt, apiBase }) {
      const lead_id = String(args.lead_id ?? "").trim();
      if (!lead_id) throw new Error("lead_id is required (the `id` from lead_search, not a URL)");
      if (LINKEDIN_RE.test(lead_id)) {
        throw new Error("Pass the lead `id` from lead_search results, not a linkedin_url — lead_enrich resolves the id.");
      }
      const input = Array.isArray(args.types) ? args.types : [];
      const seen = new Set<string>();
      const types: string[] = [];
      for (const t of input) {
        const type = String(t ?? "").trim();
        if (type && type in BULK_TYPES && !seen.has(type)) {
          seen.add(type);
          types.push(type);
        }
      }
      if (types.length === 0) {
        throw new Error("types must be a non-empty array of: phone_no, email, work_email");
      }
      return await leadEnrich(apiBase, jwt, lead_id, types);
    },
  },
  {
    name: "get_balance",
    title: "Get credit balance",
    description:
      "Check the remaining PeakAI credit balance for the authenticated account. Free — no credits charged.",
    readOnlyHint: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(_args, { jwt, apiBase }) {
      return await getCredits(apiBase, jwt);
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
