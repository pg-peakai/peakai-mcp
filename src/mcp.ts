import { TOOLS, TOOLS_BY_NAME } from "./tools";

// Server-level guidance surfaced to the connecting agent on `initialize`.
// This is the single highest-leverage place to shape how the model uses the
// toolset — keep it tight, imperative, and free of vendor names.
const SERVER_INSTRUCTIONS = [
  "PeakAI is a B2B lead-generation and contact-enrichment API.",
  "",
  "CORE WORKFLOW (find people → get their contacts):",
  "1. search_filters — fetch exact filter values (industries, seniority, functions, headcount). FREE.",
  "2. lead_search — find PEOPLE by those filters. FREE. Returns a saved search + a ~5-row sample.",
  "3. Open the returned view_url and confirm the results look right (beta: the human verifies before bulk trust).",
  "4. lead_enrich(lead_id, types) — reveal phone/email for a specific lead. CHARGED per type.",
  "",
  "RULES:",
  "- Searches are FREE but have a daily quota; enrichment is CHARGED. Enrich only the leads the user actually wants, and only the types needed — prefer work_email for B2B outreach.",
  "- lead_enrich takes a lead `id` from lead_search results, NEVER a URL. The find_* / bulk_lookup tools take a real linkedin.com profile URL instead.",
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
