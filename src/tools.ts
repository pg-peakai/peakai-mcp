import {
  callExtractor,
  getCredits,
  getFilterOptions,
  leadSearch,
  companySearch,
  leadEnrich,
  exportLeads,
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

// Export caps. Pure export (packaging already-revealed rows) is fast, so we
// allow big batches. Reveal-and-export runs the slow enrichment waterfall, so a
// call that also reveals is capped much lower to stay inside the connector
// timeout — reveal in batches, then export the whole set in one go.
const EXPORT_MAX = 1000;
const EXPORT_REVEAL_MAX = 100;

// Beta: search tools return only a small sample to the agent — the human opens
// view_url to confirm before we trust bulk output.
const SAMPLE_ROWS = 5;

// Exact company-size bands the backend accepts (from /mcp/filter-options).
// Bake them into the schema so the agent never guesses an invalid band.
const HEADCOUNT_BANDS = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
];

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
    name: "search_filters",
    title: "List valid search filter values",
    description:
      "Return the exact allowed values for the enum-style search filters used by lead_search and company_search: industries (id+label), seniority_levels, functions, years_of_experience, years_at_current_company, company_headcount, profile_languages. FREE. " +
      "Call this FIRST whenever you plan to filter by industry, seniority, function, or headcount — passing a guessed value matches nothing. Pass the id or label back in the corresponding filter (e.g. seniorityLevelIds, functionIds, industries).",
    readOnlyHint: true,
    inputSchema: { type: "object", properties: {}, required: [] },
    async run(_args, { apiBase }) {
      return await getFilterOptions(apiBase);
    },
  },
  {
    name: "lead_search",
    title: "Lead search (find people by filters)",
    description:
      "Find PEOPLE in PeakAI's lead database by filters (job titles, seniority, function, companies, locations, industries, company headcount). FREE — no credits charged, but a daily search quota applies. " +
      "Returns one page of 25 leads as a saved search, plus a SHORT ~5-row sample (not the full page). " +
      "WORKFLOW: (1) if using industry/seniority/function/headcount filters, call search_filters first for exact values; (2) call lead_search; (3) open the returned view_url and confirm the results look right; (4) take a lead's `id` and call lead_enrich(lead_id, types) for contact details. " +
      "PAGINATION: 25 leads per page. For more, call again with the SAME search_id and page+1. " +
      "IF total IS 0: broaden the filters (drop industry/headcount, fewer titles, wider location) and retry — it's free. Check `ignored_filters` for filters that didn't apply. " +
      "NEVER feed a lead's linkedin_url into bulk_lookup — it's id-form; lead_enrich resolves it from the `id`.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          description: "Lead filters. All optional; combine to narrow results. For industries/seniorityLevelIds/functionIds use exact ids or labels from search_filters.",
          properties: {
            search: { type: "string", description: "Free-text keyword search across the profile." },
            jobTitles: { type: "array", items: { type: "string" }, description: "Current job titles to match, e.g. [\"Head of Sales\", \"CMO\"]." },
            pastJobTitles: { type: "array", items: { type: "string" }, description: "Titles the person held previously." },
            companies: { type: "array", items: { type: "string" }, description: "Current employer names to match." },
            pastCompanies: { type: "array", items: { type: "string" }, description: "Former employer names." },
            locations: { type: "array", items: { type: "string" }, description: "Person locations, e.g. [\"Bangalore\", \"United States\"]." },
            companyHeadquarterLocations: { type: "array", items: { type: "string" }, description: "Filter by where the person's company is headquartered." },
            industries: { type: "array", items: { type: "string" }, description: "Industry ids or labels (see search_filters → industries)." },
            seniorityLevelIds: { type: "array", items: { type: "string" }, description: "Seniority ids or labels (see search_filters → seniority_levels), e.g. \"CXO\", \"Director\"." },
            functionIds: { type: "array", items: { type: "string" }, description: "Job-function ids or labels (see search_filters → functions), e.g. \"Engineering\", \"Sales\"." },
            companyHeadcount: { type: "array", items: { type: "string", enum: HEADCOUNT_BANDS }, description: "Company size bands. Allowed: " + HEADCOUNT_BANDS.join(", ") + "." },
            recentlyChangedJobs: { type: "boolean", description: "Only people who recently changed jobs (a strong outreach signal)." },
            excludeCurrentCompanies: { type: "array", items: { type: "string" }, description: "Exclude people currently at these companies (e.g. your own customers)." },
            excludeCurrentJobTitles: { type: "array", items: { type: "string" }, description: "Exclude these current titles." },
            excludeLocations: { type: "array", items: { type: "string" }, description: "Exclude these locations." },
            maxPerCompany: { type: "number", description: "Cap leads returned per company (spreads results across more companies)." },
          },
        },
        page: { type: "number", description: "1-based page number (25 leads per page). Default 1. To page deeper, keep search_id and increment this." },
        search_id: { type: "string", description: "Reuse a search_id from a prior call to append the next page under the same search instead of starting over." },
      },
      required: ["filters"],
    },
    async run(args, { jwt, apiBase }) {
      const filters = (args.filters ?? {}) as LeadSearchFilters;
      const page = typeof args.page === "number" && args.page > 0 ? args.page : 1;
      const search_id = typeof args.search_id === "string" ? args.search_id : undefined;
      const r = await leadSearch(apiBase, jwt, filters, page, search_id);
      const sample = (r.leads ?? []).slice(0, SAMPLE_ROWS);
      return {
        message: `Found ${r.count} of ${r.total} (page ${page}, 25/page). Verify: ${r.view_url}`,
        search_id: r.search_id,
        page,
        count: r.count,
        total: r.total,
        view_url: r.view_url,
        ...(r.result_cap !== undefined ? { result_cap: r.result_cap } : {}),
        ...(r.ignored_filters ? { ignored_filters: r.ignored_filters } : {}),
        // Compact id list for this page so you can bulk_enrich without dumping
        // full rows into context. UUIDs only — the data stays behind view_url.
        lead_ids: (r.leads ?? []).map((l) => l.id).filter(Boolean),
        sample,
        note:
          "Beta: only a ~5-row sample is shown — open view_url to confirm before trusting the full set. " +
          "Spot-check one lead with lead_enrich(lead_id, types). " +
          "To take MANY out, confirm with the user first, then call export_leads(search_id, lead_ids, [types]) — search stays free; export is the billable step. " +
          (r.total > r.count ? "More results exist — reuse this search_id with page+1." : ""),
      };
    },
  },
  {
    name: "company_search",
    title: "Company search (find companies by filters)",
    description:
      "Find COMPANIES in PeakAI's database by filters (industries, locations, headcount). FREE — no credits charged, daily search quota applies. " +
      "Returns one page of 50 companies as a saved search, plus a SHORT ~5-row sample. " +
      "To reach the PEOPLE at these companies, take their names and run lead_search with companies:[...] (+ jobTitles/seniority). " +
      "PAGINATION: 50 companies per page — for more, call again with the SAME search_id and page+1. " +
      "IF total IS 0: broaden the filters and retry (it's free); check `ignored_filters` for filters that didn't apply.",
    readOnlyHint: true,
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          description: "Company filters. All optional; combine to narrow results. Use exact industry ids/labels from search_filters.",
          properties: {
            search: { type: "string", description: "Free-text keyword search across company data." },
            industries: { type: "array", items: { type: "string" }, description: "Industry ids or labels (see search_filters → industries)." },
            locations: { type: "array", items: { type: "string" }, description: "Company locations to match." },
            headcount: { type: "array", items: { type: "string", enum: HEADCOUNT_BANDS }, description: "Company size bands. Allowed: " + HEADCOUNT_BANDS.join(", ") + "." },
          },
        },
        page: { type: "number", description: "1-based page number (50 companies per page). Default 1." },
        search_id: { type: "string", description: "Reuse a search_id from a prior call to append the next page under the same search." },
      },
      required: ["filters"],
    },
    async run(args, { jwt, apiBase }) {
      const filters = (args.filters ?? {}) as CompanySearchFilters;
      const page = typeof args.page === "number" && args.page > 0 ? args.page : 1;
      const search_id = typeof args.search_id === "string" ? args.search_id : undefined;
      const r = await companySearch(apiBase, jwt, filters, page, search_id);
      const sample = (r.companies ?? []).slice(0, SAMPLE_ROWS);
      return {
        message: `Found ${r.count} of ${r.total} (page ${page}, 50/page). Verify: ${r.view_url}`,
        search_id: r.search_id,
        page,
        count: r.count,
        total: r.total,
        view_url: r.view_url,
        ...(r.result_cap !== undefined ? { result_cap: r.result_cap } : {}),
        ...(r.ignored_filters ? { ignored_filters: r.ignored_filters } : {}),
        sample,
        note:
          "Beta: only a ~5-row sample is shown — open view_url to confirm before trusting the full set. " +
          (r.total > r.count ? "More results exist — reuse this search_id with page+1." : ""),
      };
    },
  },
  {
    name: "lead_enrich",
    title: "Enrich a lead (phone / email)",
    description:
      "Get contact details (phone, personal email, work email) for a lead found via lead_search. CHARGED per lookup type — each entry in `types` is a separate charge. " +
      "Only request the types the user actually needs (prefer work_email for B2B outreach), and only for the specific leads they want — do NOT bulk-enrich a whole search. " +
      "Pass the lead's `id` from lead_search results — NOT a URL. Returns arrays per type; an empty array means none were found (still counts as a lookup).",
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
    name: "export_leads",
    title: "Export searched leads (deliberate, billable)",
    description:
      "Take MANY searched leads OUT in one call. This is the EXPORT step — deliberate and BILLABLE — kept separate from the free search on purpose (unlike tools that meter search and export together). " +
      "ONLY call this after the user has explicitly confirmed they want to export, and tell them the count and cost first: export is 0.5 credit/row (min 2) on rows not exported before; re-exporting an already-exported row is free. " +
      "TWO MODES via `types`: " +
      "(a) omit `types` → fast pure export of contacts already revealed — use this to take up to " + String(EXPORT_MAX) + " out at once. " +
      "(b) include `types` → also reveal those contacts for any unrevealed rows (each type charged per lead); keep these calls to " + String(EXPORT_REVEAL_MAX) + " leads or fewer since revealing is slower. " +
      "To export a large set with fresh contacts: reveal in batches of ~" + String(EXPORT_REVEAL_MAX) + " (types set), then do one final export with types omitted to pull everything together. " +
      "Returns COUNTS + a 3-row sample only; the full contacts live behind the search's view_url.",
    readOnlyHint: false,
    inputSchema: {
      type: "object",
      properties: {
        search_id: { type: "string", description: "The search_id from lead_search." },
        lead_ids: {
          type: "array",
          items: { type: "string" },
          description: "Lead `id`s from lead_search to export (1–" + String(EXPORT_MAX) + "). NOT URLs. Duplicates are removed.",
        },
        types: {
          type: "array",
          items: { type: "string", enum: ["phone_no", "email", "work_email"] },
          description: "OPTIONAL. Contacts to reveal for unrevealed rows before exporting. Omit to export only already-revealed contacts (fast, large batches). Each type is charged per newly-revealed lead.",
        },
      },
      required: ["search_id", "lead_ids"],
    },
    async run(args, { jwt, apiBase }) {
      const search_id = String(args.search_id ?? "").trim();
      if (!search_id) throw new Error("search_id is required (from lead_search)");

      const rawIds = Array.isArray(args.lead_ids) ? args.lead_ids : [];
      const seenId = new Set<string>();
      const lead_ids: string[] = [];
      for (const v of rawIds) {
        const id = String(v ?? "").trim();
        if (!id) continue;
        if (LINKEDIN_RE.test(id)) {
          throw new Error("lead_ids must be lead `id`s from lead_search, not URLs.");
        }
        if (!seenId.has(id)) {
          seenId.add(id);
          lead_ids.push(id);
        }
      }
      if (lead_ids.length === 0) throw new Error("lead_ids must be a non-empty array of lead ids");

      const rawTypes = Array.isArray(args.types) ? args.types : [];
      const seenType = new Set<string>();
      const types: string[] = [];
      for (const t of rawTypes) {
        const type = String(t ?? "").trim();
        if (type && type in BULK_TYPES && !seenType.has(type)) {
          seenType.add(type);
          types.push(type);
        }
      }
      const revealing = types.length > 0;

      // Reveal-and-export is slow per row → tighter cap; pure export is fast.
      const cap = revealing ? EXPORT_REVEAL_MAX : EXPORT_MAX;
      if (lead_ids.length > cap) {
        throw new Error(
          revealing
            ? `Too many leads to reveal in one call (${lead_ids.length}). Max ${cap} when types are set — reveal in batches of ~${cap}, then export the full set with types omitted.`
            : `Too many leads (${lead_ids.length}). Max ${cap} per export call.`,
        );
      }

      const r = await exportLeads(apiBase, jwt, search_id, lead_ids, revealing ? types : undefined);

      // Compress: counts + a tiny sample, never the full row set.
      const leads = r.leads ?? [];
      const hasVal = (v: unknown) =>
        Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== "";
      const countTypes = revealing ? types : ["phone_no", "email", "work_email"];
      const found: Record<string, number> = {};
      for (const t of countTypes) found[t] = leads.filter((l) => hasVal(l[t])).length;
      const sample = leads.slice(0, 3).map((l) => ({
        name: l.name,
        company: l.company,
        phone_no: l.phone_no,
        email: l.email,
        work_email: l.work_email,
      }));

      return {
        message:
          `Exported ${leads.length}/${lead_ids.length} leads` +
          (revealing ? ` (revealed ${r.enriched_count})` : "") +
          `. Charged ${r.credits_charged} credits (${r.charged_rows} billed rows)` +
          (r.credits_remaining != null ? `, ${r.credits_remaining} remaining.` : "."),
        mode: revealing ? "reveal_and_export" : "export_only",
        requested: lead_ids.length,
        exported: leads.length,
        enriched_count: r.enriched_count,
        charged_rows: r.charged_rows,
        credits_charged: r.credits_charged,
        credits_remaining: r.credits_remaining,
        found,
        sample,
        note:
          "Only counts + a 3-row sample are returned to keep this cheap on tokens. " +
          "All exported contacts are saved on the search — open its view_url to download the full set.",
      };
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
