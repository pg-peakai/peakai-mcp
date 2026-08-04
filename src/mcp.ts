import { TOOLS, TOOLS_BY_NAME } from "./tools";

// Server-level guidance surfaced to the connecting agent on `initialize`.
// This is the single highest-leverage place to shape how the model uses the
// toolset — keep it tight, imperative, and free of vendor names.
const SERVER_INSTRUCTIONS = [
  "PeakAI is a B2B lead-generation and contact-enrichment API. Your job is to run a WORLD-CLASS search: produce a precise, intent-matched shortlist the user trusts — never a noisy dump.",
  "",
  "PRINCIPLES OF A GREAT SEARCH:",
  "- Understand intent before searching. Establish the ideal customer — who they are, where, what kind of company, and how many are wanted — asking a few sharp questions only when the request is genuinely underspecified. Once the criteria are set, search deterministically so the same ask yields the same result.",
  "- Never guess filter values. Resolve exact values first; an invented enum silently matches nothing. Precise inputs are the whole difference between real results and empty ones.",
  "- Favour precision over volume. Combine constraints so the list is the actual target rather than everyone who loosely qualifies. A small, exactly-right list beats a large, vague one.",
  "- Treat search as a loop, not a single shot. Read the count and the sample, then adjust one lever at a time — tighten when too broad, relax the narrowest constraint when empty, and inspect which filters were ignored. Search is FREE, so iterate until the shortlist is right before spending anything.",
  "- Reuse what already works. Recall the user's prior searches to build on proven targeting and infer their ideal-customer profile. When they can point to an ideal person, seed the search from that profile instead of from scratch.",
  "- Show your work. Surface the exact filters used so the outcome is predictable and the user can change a single thing to steer it.",
  "",
  "TOOLS:",
  "- recall recent searches — the user's memory; start here to continue their targeting.",
  "- list filter values — the exact allowed values; consult before filtering by any category/level, never hardcode.",
  "- lead search — find people. FREE. Returns a saved search, a small verification sample, and the page's lead ids.",
  "- look-alike search — find people resembling a given profile.",
  "- company search — find companies; reach their people by feeding the names into lead search.",
  "- single enrich — reveal contacts for one lead. CHARGED.",
  "- export — take many leads out. The deliberate, BILLABLE step.",
  "",
  "MONEY & SAFETY:",
  "- Search is FREE and stays SEPARATE from export (unlike tools that meter both). Never auto-export or auto-charge.",
  "- Reveal or export only after the user explicitly confirms; state how many and the cost first, and request only the leads and contact types actually needed.",
  "- Enrich/export take lead ids from search results, never URLs; the profile-lookup tools take a real profile URL.",
  "- In beta, only a sample is returned — the user verifies the full set before it is trusted for bulk work.",
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
