# PeakAI MCP Server

Connect PeakAI to any MCP client — **Claude Desktop, Claude Code, Cursor, Windsurf, etc.** — and your AI assistant can find phone numbers, emails, enrich LinkedIn profiles, look up directors by DIN, and reverse-lookup a person from an email or phone, all on your PeakAI account.

> **Status:** spec / reference. The tool inputs and outputs mirror the PeakAI REST API exactly (see `peakai-api-docs.md`). The server should be built to match this document.

---

## 1. Overview

The PeakAI MCP server exposes your contact-finding API as **MCP tools**. An AI agent calls a tool (e.g. `find_phone`), the server runs the same provider waterfall as the REST API, charges credits, and returns the result. Billing, dedup, and data are identical to the API — MCP is just another way in (transactions are tagged `channel: "mcp"`).

- **Transport:** Streamable HTTP
- **Endpoint:** `https://build.thepeakai.com/mcp`
- **Auth:** Bearer access token (from `POST /token`)
- **Billing:** per successful tool call, against your PeakAI credit balance

---

## 2. Authentication

You authenticate with a **PeakAI access token** — the same one the REST API uses.

1. Get a token (valid 15 days):
   ```bash
   curl -X POST "https://build.thepeakai.com/token" \
     -H "Content-Type: application/json" \
     -d '{"email":"you@example.com","password":"yourpassword"}'
   ```
   → `{ "access_token": "eyJ...", "email": "...", "token_expires_in": "1296000" }`
2. Pass it to the MCP server as a Bearer header (see client configs below).

Your account must have **API/MCP access enabled** — email **studio@thepeakai.com** to enable it.

> Tokens expire after 15 days; refresh by calling `/token` again and updating your client config. (OAuth 2.1 device flow is a planned future option so clients can refresh automatically.)

---

## 3. Connecting your client

### Claude Desktop
Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "peakai": {
      "type": "http",
      "url": "https://build.thepeakai.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_ACCESS_TOKEN" }
    }
  }
}
```

Restart Claude Desktop. You'll see the PeakAI tools appear.

### Claude Code

```bash
claude mcp add --transport http peakai https://build.thepeakai.com/mcp \
  --header "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### Cursor
Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "peakai": {
      "url": "https://build.thepeakai.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_ACCESS_TOKEN" }
    }
  }
}
```

### Any other MCP client
Point it at `https://build.thepeakai.com/mcp` (Streamable HTTP) with header `Authorization: Bearer YOUR_ACCESS_TOKEN`.

---

## 4. Tools

All profile tools take a `profile_url` (a `linkedin.com` profile). A lookup that finds nothing returns a "not found" result and **costs no credits**.

### `find_phone`
Find a person's **personal phone number(s)** from their LinkedIn profile.

```json
{ "name": "find_phone", "input": { "profile_url": "https://linkedin.com/in/kunalbahl" } }
```

**Returns:** `{ "phone_no": ["919958006818"], "from_cache": true, "credits_charged": 9, "credits_remaining": 26115 }`
Not found: `{ "phone_no": "Not Found" }`

### `find_personal_email`
Find a person's **personal email**.

```json
{ "name": "find_personal_email", "input": { "profile_url": "<linkedin_url>" } }
```

**Returns:** `{ "email": ["personal@example.com"], "credits_charged": 1, "credits_remaining": 5000 }`

### `find_work_email`
Find a person's **work email**.

```json
{ "name": "find_work_email", "input": { "profile_url": "<linkedin_url>" } }
```

**Returns:** `{ "work_email": ["kb@acevector.com"], "credits_charged": 1, "credits_remaining": 4999 }`

### `enrich_profile`
Fetch the **full LinkedIn profile** (name, headline, experience, education, etc.).

```json
{ "name": "enrich_profile", "input": { "profile_url": "<linkedin_url>" } }
```

**Returns:** `{ "enrichment_data": { "basic_info": {...}, "experience": [...], "education": [...] }, "credits_charged": 1 }`

### `find_director_phone`
Find a phone number for an Indian company director by **DIN** (Director Identification Number).

```json
{ "name": "find_director_phone", "input": { "din": "02890599" } }
```

**Returns:** `{ "din": "02890599", "phone_no": "9314444993", "credits_charged": 5 }`

### `find_director_email`
Find an email for a director by **DIN**.

```json
{ "name": "find_director_email", "input": { "din": "02890599" } }
```

**Returns:** `{ "din": "02890599", "email": "...", "credits_charged": 1 }`

### `bulk_lookup`
Find a phone number or email for **many LinkedIn profiles in one call**. Processed **sequentially** server-side and returned as a compact summary — far cheaper (in tokens and round-trips) than calling a single-lookup tool once per profile. Use this whenever you have a list (e.g. from a spreadsheet).

- `type`: `phone_no` | `email` | `work_email`
- `profile_urls`: array of LinkedIn URLs, **max 250 per call**. Split larger lists into batches of **100–250**. Duplicates are removed automatically.

```json
{ "name": "bulk_lookup", "input": { "type": "phone_no", "profile_urls": ["https://linkedin.com/in/a", "https://linkedin.com/in/b"] } }
```

**Returns** a summary plus one compact row per profile (no full payloads re-enter the model):
```json
{
  "type": "phone_no",
  "requested": 120,
  "duplicates_removed": 20,
  "processed": 100,
  "found": 82,
  "not_found": 16,
  "errors": 2,
  "credits_charged_total": 738,
  "credits_remaining": 25377,
  "results": [
    { "profile_url": "...", "status": "found", "value": ["919958006818"], "from_cache": true },
    { "profile_url": "...", "status": "not_found" },
    { "profile_url": "...", "status": "error", "message": "Not a linkedin.com URL" }
  ]
}
```

Each profile is billed exactly like a single lookup — only successful rows charge; "not found" is free. If the account runs out of credits mid-batch, processing stops and the response includes `"aborted": "out_of_credits"` with everything completed so far.

### `reverse_lookup`
Resolve a **person's profile from an email or phone number**.

```json
{ "name": "reverse_lookup", "input": { "value": "rajat@astuto.ai" } }
```

A bare 10-digit number is treated as an Indian mobile (`+91` added); pass a full country code otherwise.
**Returns:** `{ "status": "found", "profile": { "fullName": "...", "linkedinUrl": "...", "currentCompany": "...", ... }, "credits_charged": 3 }`
Not found: `{ "status": "not_found" }`

### `get_balance`
Check your remaining credits. **Free** (no charge).

```json
{ "name": "get_balance", "input": {} }
```

**Returns:** `{ "credits": 26115, "account_type": "user" }`

---

## 5. Credits

- Charged **only on a successful lookup**. "Not found" is free.
- Each tool's result includes `credits_charged` and `credits_remaining`.
- MCP usage is billed like the API channel (every success charges; no extension-style dedup).
- Out of credits → the tool returns an error: `"Not enough credits. Please recharge."`

## 6. Errors

Tool calls return a structured error (MCP `isError`) with a message, e.g.:
| Situation | Message |
|---|---|
| Invalid/expired token | `Invalid or expired access token` |
| Out of credits | `Not enough credits. Please recharge.` |
| API/MCP access not enabled | `API access is not enabled for your account…` |
| Bad input | `profile_url must be a linkedin.com URL` / `din is required` |

## 7. Notes

- A lookup can take **~1–60 seconds** (cache hit vs full provider waterfall). MCP clients should allow long-running tool calls (don't set an aggressive timeout).
- Phone numbers returned are **personal** numbers; company switchboards are filtered out.
- The data vendor behind each result is **never** exposed.

---

---

# Appendix — Build spec (for the engineer)

This is how to implement the server so it matches the docs above.

## Transport & framework
- Use **`@modelcontextprotocol/sdk`** (TypeScript) with the **Streamable HTTP** server transport.
- Mount it in the existing backend at `POST/GET /mcp` (Express), OR run the separate `peakai-mcp` repo that proxies to the backend. Reusing the backend is simplest — the flows are right there.

## Auth
- Read `Authorization: Bearer <token>` from the request, run it through the **existing `authenticate` / JWT verification** (same RS256/JWKS path as `middleware/auth.ts`) to get `userId`. Reject with an MCP auth error if missing/invalid.
- (Phase 2: implement MCP OAuth 2.1 so clients refresh automatically.)

## Tool → engine mapping (reuse existing code)
Each tool: resolve billing → init transaction (`channel: "mcp"`) → run the existing flow → format. Billing should follow the account category (like `/api`: always charge), tagged `channel: "mcp"`.

| Tool | Calls |
|---|---|
| `find_phone` | `runPhoneFlow` |
| `find_personal_email` | `runEmailFlow` |
| `find_work_email` | `runWorkEmailFlow` |
| `enrich_profile` | `runEnrichFlow` |
| `find_director_phone` | `runDinPhoneFlow` |
| `find_director_email` | `runDinEmailFlow` |
| `reverse_lookup` | `runReverseLookupFlow` |
| `get_balance` | `getBalance` (no transaction, no charge) |

So a tool handler is essentially the body of `lookupHandler` from `routes/extractor.ts`, with `mode = "api"` (billing) and `channel = "mcp"` (tag). Factor the shared logic out of `extractor.ts` into a `runLookup(userId, type, input, mode, channel)` service that both the REST route and the MCP tools call — avoids duplicating the billing/transaction/flow orchestration.

## Tool input schemas (JSON Schema, for MCP `tools/list`)
- profile tools: `{ "type": "object", "properties": { "profile_url": { "type": "string" } }, "required": ["profile_url"] }`
- DIN tools: `{ "type": "object", "properties": { "din": { "type": "string" } }, "required": ["din"] }`
- reverse_lookup: `{ "type": "object", "properties": { "value": { "type": "string" } }, "required": ["value"] }`
- get_balance: `{ "type": "object", "properties": {} }`

## Long calls
The SignalHire waterfall can take ~45s. Streamable HTTP holds the connection; ensure the load-balancer idle timeout covers it (this is the same 60s-wall issue noted for the REST API — see session notes).

## Channel
`mcp` is already in the `TxnChannel` type (`src/types.ts`), so transactions tagged `channel: "mcp"` will bucket correctly in `/stats`.
