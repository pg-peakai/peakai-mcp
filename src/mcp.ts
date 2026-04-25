import { TOOLS, TOOLS_BY_NAME } from "./tools";

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
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as { profile_url: string };
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
