import { callExtractor, getCredits, type ExtractorType } from "./peakai";

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
    "profile_enrichment",
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
