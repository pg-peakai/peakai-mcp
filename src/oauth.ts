// Minimal OAuth 2.1 + Dynamic Client Registration for MCP.
// Flow:
//   /oauth/register   — Claude registers itself as a client (RFC 7591)
//   /oauth/authorize  — redirects user to studio.thepeakai.com/mcp-connect
//   /mcp/callback     — studio POSTs Nhost JWT + refresh token here, we mint a code
//   /oauth/token      — Claude exchanges code for access_token; later, refresh_token → new access
// All session state lives in KV.

import { Hono } from "hono";

type Env = {
  Bindings: {
    PEAKAI_API_BASE: string;
    STUDIO_BASE: string;
    OAUTH_SIGNING_KEY: string;
    SESSIONS: KVNamespace;
  };
};

const TEN_MIN = 600;
const FOURTEEN_DAYS = 60 * 60 * 24 * 14;

function rand(n = 32): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const oauth = new Hono<Env>();

// CORS for browser-initiated OAuth requests (e.g. studio.thepeakai.com → /mcp/callback).
oauth.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
});

// ---- Discovery (Claude reads these to learn the OAuth endpoints) ----
oauth.get("/.well-known/oauth-authorization-server", (c) => {
  const base = new URL(c.req.url).origin;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

oauth.get("/.well-known/oauth-protected-resource", (c) => {
  const base = new URL(c.req.url).origin;
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

// ---- Dynamic Client Registration (RFC 7591) ----
oauth.post("/oauth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    redirect_uris?: string[];
    client_name?: string;
  };
  const client_id = `mcp_${rand(12)}`;
  const record = {
    client_id,
    redirect_uris: body.redirect_uris ?? [],
    client_name: body.client_name ?? "Unknown MCP Client",
    created_at: Date.now(),
  };
  await c.env.SESSIONS.put(`client:${client_id}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  return c.json({
    ...record,
    token_endpoint_auth_method: "none",
  });
});

// ---- /authorize — redirect to studio's consent page ----
oauth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const required = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"];
  for (const k of required) {
    if (!q[k]) return c.text(`missing ${k}`, 400);
  }
  if (q.code_challenge_method !== "S256") return c.text("unsupported code_challenge_method", 400);

  const clientRaw = await c.env.SESSIONS.get(`client:${q.client_id}`);
  if (!clientRaw) return c.text("unknown client_id", 400);
  const client = JSON.parse(clientRaw) as { redirect_uris: string[] };
  if (client.redirect_uris.length && !client.redirect_uris.includes(q.redirect_uri!)) {
    return c.text("redirect_uri not registered for this client", 400);
  }

  const txn = `txn_${rand(16)}`;
  await c.env.SESSIONS.put(
    `txn:${txn}`,
    JSON.stringify({
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      state: q.state,
      scope: q.scope ?? "",
    }),
    { expirationTtl: TEN_MIN },
  );

  const callback = `${new URL(c.req.url).origin}/mcp/callback`;
  const dest = new URL(`${c.env.STUDIO_BASE}/mcp-connect`);
  dest.searchParams.set("txn", txn);
  dest.searchParams.set("callback", callback);
  return c.redirect(dest.toString(), 302);
});

// ---- /mcp/callback — studio.thepeakai.com posts the JWT here after consent ----
// POST body: { txn, access_token, refresh_token, user }
oauth.post("/mcp/callback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    txn?: string;
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string; email?: string };
  } | null;
  if (!body?.txn || !body.access_token) return c.json({ error: "bad_request" }, 400);

  const txnRaw = await c.env.SESSIONS.get(`txn:${body.txn}`);
  if (!txnRaw) return c.json({ error: "txn_expired_or_unknown" }, 400);
  const txn = JSON.parse(txnRaw) as {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    state: string;
    scope: string;
  };
  await c.env.SESSIONS.delete(`txn:${body.txn}`);

  const code = `code_${rand(20)}`;
  await c.env.SESSIONS.put(
    `code:${code}`,
    JSON.stringify({
      ...txn,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? null,
      user: body.user ?? null,
    }),
    { expirationTtl: TEN_MIN },
  );

  const redirect = new URL(txn.redirect_uri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", txn.state);
  return c.json({ redirect_to: redirect.toString() });
});

// ---- /oauth/token — exchange code (or refresh) for an MCP access_token ----
oauth.post("/oauth/token", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  let params: Record<string, string> = {};
  if (ct.includes("application/json")) {
    params = (await c.req.json()) as Record<string, string>;
  } else {
    const form = await c.req.formData();
    form.forEach((v, k) => (params[k] = String(v)));
  }

  if (params.grant_type === "authorization_code") {
    const codeKey = `code:${params.code}`;
    const raw = await c.env.SESSIONS.get(codeKey);
    if (!raw) return c.json({ error: "invalid_grant" }, 400);
    await c.env.SESSIONS.delete(codeKey);
    const data = JSON.parse(raw) as {
      client_id: string;
      code_challenge: string;
      access_token: string;
      refresh_token: string | null;
      user: unknown;
    };
    if (data.client_id !== params.client_id) return c.json({ error: "invalid_client" }, 400);

    // Verify PKCE
    const verifier = params.code_verifier;
    if (!verifier) return c.json({ error: "missing_code_verifier" }, 400);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64url(new Uint8Array(hash));
    if (challenge !== data.code_challenge) return c.json({ error: "invalid_code_verifier" }, 400);

    const access = `mcp_${rand(24)}`;
    const refresh = `mref_${rand(24)}`;
    const session = {
      nhost_jwt: data.access_token,
      nhost_refresh: data.refresh_token,
      user: data.user,
      client_id: data.client_id,
    };
    await c.env.SESSIONS.put(`access:${access}`, JSON.stringify(session), { expirationTtl: FOURTEEN_DAYS });
    await c.env.SESSIONS.put(`refresh:${refresh}`, JSON.stringify(session), { expirationTtl: FOURTEEN_DAYS * 4 });
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: FOURTEEN_DAYS,
      refresh_token: refresh,
    });
  }

  if (params.grant_type === "refresh_token") {
    const raw = await c.env.SESSIONS.get(`refresh:${params.refresh_token}`);
    if (!raw) return c.json({ error: "invalid_grant" }, 400);
    const session = JSON.parse(raw);
    const access = `mcp_${rand(24)}`;
    await c.env.SESSIONS.put(`access:${access}`, JSON.stringify(session), { expirationTtl: FOURTEEN_DAYS });
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: FOURTEEN_DAYS,
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function resolveJwtFromBearer(
  env: Env["Bindings"],
  bearer: string,
): Promise<string | null> {
  if (!bearer) return null;
  // Only do a KV lookup if the bearer looks like one of our issued tokens.
  // KV keys have a 512-byte limit, and a raw Nhost JWT is much larger.
  if (!bearer.startsWith("mcp_")) return null;
  try {
    const raw = await env.SESSIONS.get(`access:${bearer}`);
    if (!raw) return null;
    const session = JSON.parse(raw) as { nhost_jwt: string };
    return session.nhost_jwt;
  } catch {
    return null;
  }
}
