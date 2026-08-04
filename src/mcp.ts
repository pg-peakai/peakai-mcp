import { TOOLS, TOOLS_BY_NAME } from "./tools";

// Server-level guidance surfaced to the connecting agent on `initialize`.
// This is the single highest-leverage place to shape how the model uses the
// toolset — keep it tight, imperative, and free of vendor names.
const SERVER_INSTRUCTIONS = [
  "PeakAI is a B2B lead-generation and contact-enrichment API.",
  "",
  "START OF SESSION: call recent_searches to recall the user's past searches and targeting — build on them instead of starting cold.",
  "",
  "CORE WORKFLOW (find people → get their contacts):",
  "1. search_filters — fetch exact filter values (industries, seniority, functions, headcount). FREE.",
  "2. lead_search — find PEOPLE by those filters. FREE. Returns a saved search + a ~5-row sample + the page's lead_ids.",
  "   • Given a LinkedIn URL and asked for 'similar people' → lookalike_search(profile_url): it enriches that profile and auto-runs a look-alike search you then refine.",
  "3. Open the returned view_url and confirm the results look right (beta: the human verifies before bulk trust).",
  "4. Get contacts:",
  "   - ONE lead, quick spot-check → lead_enrich(lead_id, types).",
  "   - MANY leads → export_leads(search_id, lead_ids, [types]). This is the deliberate, BILLABLE export step.",
  "",
  "CLARIFY BEFORE SEARCHING (this keeps results predictable — do it, don't guess):",
  "- If the request is vague, ask up to 3 short questions FIRST, then search: (1) WHO — role/title + seniority; (2) WHERE — location(s); (3) WHAT KIND — industry + company size/stage. Also confirm HOW MANY they want (most users want 10–50 people).",
  "- If the user already gave these, do NOT re-ask — search directly and deterministically with what they said.",
  "- Company size/stage words map to headcount bands: 'startup'/'early-stage' = 1-10, 11-50, 51-200; 'SMB'/'mid-market' = 201-500, 501-1000; 'enterprise'/'large' = 1001-5000, 5001-10000, 10001+.",
  "- After the first page, offer to tighten a filter or page for more — don't pull extra pages unasked.",
  "",
  "RULES:",
  "- Search and export are SEPARATE on purpose (unlike tools that meter both together): search is FREE (daily quota); export is where credits are spent. Never auto-export.",
  "- Only call export_leads AFTER the user explicitly confirms — state the row count and cost first (0.5 credit/row min 2, plus per-contact enrichment for newly-revealed rows).",
  "- Exporting a large set (up to ~1000): reveal fresh contacts in batches of ~100 (export_leads with types), then do one final export_leads with types omitted to pull everything together fast. Omitting types exports only already-revealed contacts.",
  "- lead_enrich / export_leads take lead `id`s from lead_search, NEVER URLs. The find_* / bulk_lookup tools take a real linkedin.com profile URL instead.",
  "- For id/enum filters (industries, seniority, functions, headcount) call search_filters first and pass an exact id or label — guessed values match nothing.",
  "- If a search returns total 0, broaden the filters (drop industry/headcount, fewer job titles, wider location) and retry — it's free. Check `ignored_filters` in the response for filters that didn't apply.",
  "- Pagination is per-page (25 leads / 50 companies per page). To go deeper, call again with the SAME search_id and the next page number.",
  "- company_search finds COMPANIES; to reach people at them, run lead_search with companies:[...].",
].join("\n");

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function ok(id: any, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}
function err(id: any, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

export async function handleMcp(
  req: JsonRpcReq,
  ctx: { jwt: string; apiBase: string },
): Promise<unknown> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "peakai-mcp", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS,
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnlyHint },
        })),
      });

    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return err(id, -32601, `Unknown tool: ${name}`);
      try {
        const data = await tool.run(args, ctx);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } catch (e: any) {
        return ok(id, {
          content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
          isError: true,
        });
      }
    }

    case "ping":
      return ok(id, {});

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
