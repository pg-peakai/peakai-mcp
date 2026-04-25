import { Hono } from "hono";
import { handleMcp } from "./mcp";
import { oauth, resolveJwtFromBearer } from "./oauth";

type Env = {
  Bindings: {
    PEAKAI_API_BASE: string;
    STUDIO_BASE: string;
    OAUTH_SIGNING_KEY: string;
    SESSIONS: KVNamespace;
    DEV_JWT?: string;
  };
};

const app = new Hono<Env>();

app.get("/", (c) => c.text("peakai-mcp ok"));
app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", oauth);

// CORS for MCP — claude.ai calls this from the browser.
app.options("/mcp", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Max-Age": "86400",
    },
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
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const body = await c.req.json();
  const result = await handleMcp(body, { jwt, apiBase: c.env.PEAKAI_API_BASE });

  if (result === null) {
    return new Response(null, {
      status: 202,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

export default app;
