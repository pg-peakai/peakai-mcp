import { Hono } from "hono";
import { handleMcp } from "./mcp";
import { oauth, resolveJwtFromBearer } from "./oauth";

type Env = {
  Bindings: {
    PEAKAI_API_BASE: string;
    STUDIO_BASE: string;
    NHOST_AUTH_BASE: string;
    OAUTH_SIGNING_KEY: string;
    SESSIONS: KVNamespace;
    DEV_JWT?: string;
  };
};

const app = new Hono<Env>();

app.get("/", (c) => c.text("peakai-mcp ok"));
app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", oauth);

const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://claude.com",
  "https://studio.thepeakai.com",
]);

function pickOrigin(req: Request): string | null {
  const o = req.headers.get("origin");
  if (!o) return null;
  if (ALLOWED_ORIGINS.has(o)) return o;
  try {
    const u = new URL(o);
    if (u.hostname.endsWith(".anthropic.com") || u.hostname.endsWith(".claude.ai")) return o;
  } catch {
    // ignore
  }
  return null;
}

app.get("/mcp", (c) => {
  return c.json(
    {
      name: "peakai-mcp",
      version: "0.1.0",
      transport: "Streamable HTTP",
      protocol: "MCP / JSON-RPC 2.0",
      hint: "This endpoint expects POST requests with a JSON-RPC body. Add this URL as a custom connector in Claude (claude.ai → Settings → Connectors → Add custom connector).",
      install_url: "https://mcp.linkedinenrich.com/mcp",
      docs: "https://github.com/pg-peakai/peakai-mcp",
    },
    200,
  );
});

app.options("/mcp", (c) => {
  const origin = pickOrigin(c.req.raw);
  return new Response(null, {
    status: 204,
    headers: origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Vary": "Origin",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
          "Access-Control-Max-Age": "86400",
        }
      : {},
  });
});

app.post("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";

  // Resolve bearer to underlying Nhost JWT.
  // 1) If it's an MCP access token issued by us, look it up in KV.
  // 2) Otherwise (dev / direct paste), treat the bearer itself as the JWT.
  // 3) Otherwise fall back to DEV_JWT (local dev only).
  let jwt = "";
  if (bearer) {
    jwt = (await resolveJwtFromBearer(c.env, bearer)) ?? bearer;
  } else if (c.env.DEV_JWT) {
    jwt = c.env.DEV_JWT;
  }

  if (!jwt) {
    return new Response(JSON.stringify({ error: "missing bearer token" }), {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="peakai-mcp", resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource"`,
        "content-type": "application/json",
        "Access-Control-Allow-Origin": pickOrigin(c.req.raw) ?? "",
      },
    });
  }

  const body = await c.req.json();
  const result = await handleMcp(body, { jwt, apiBase: c.env.PEAKAI_API_BASE });

  const corsOrigin = pickOrigin(c.req.raw);
  if (result === null) {
    return new Response(null, {
      status: 202,
      headers: corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin, Vary: "Origin" } : {},
    });
  }
  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": pickOrigin(c.req.raw) ?? "",
    },
  });
});

export default app;
