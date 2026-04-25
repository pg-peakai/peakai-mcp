# peakai-mcp

Remote MCP server that exposes PeakAI's contact-intelligence API as tools for Claude.

**Status**: v0.1 scaffold. 7 tools wired to the public `/webhook/extractor` API. OAuth flow stubbed (step 4).

## Tools

| Tool | API type | Description |
|---|---|---|
| `find_personal_email` | `email` | Personal email for a LinkedIn profile (1 credit) |
| `find_work_email` | `work_email` | Work email |
| `find_phone` | `phone_no` | Phone number |
| `enrich_profile` | `profile_enrichment` | Full profile data |
| `reverse_lookup` | `reverse_lookup` | Reverse lookup |
| `find_din_phone` | `din_phone` | DIN-based phone (India directors) |
| `find_din_email` | `din_email` | DIN-based email (India directors) |

All tools take a single `profile_url` (LinkedIn URL).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste a real Nhost JWT into DEV_JWT
npm run dev
```

Server runs on `http://localhost:8787`.

### Test it from Claude Code

```bash
claude mcp add peakai --transport http http://localhost:8787/mcp
```

Then in Claude: "Find the work email for https://linkedin.com/in/johndoe"

### Test it with curl

```bash
# tools/list
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq

# tools/call
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_work_email","arguments":{"profile_url":"https://www.linkedin.com/in/satyanadella"}}}' | jq
```

## Deployment (Cloudflare Workers)

```bash
# one-time
wrangler login
wrangler kv:namespace create SESSIONS    # paste id into wrangler.toml
wrangler secret put OAUTH_SIGNING_KEY    # any 32+ char random string

# deploy
npm run deploy
```

Then add a custom domain (e.g. `mcp.thepeakai.com`) in the Cloudflare Workers dashboard.

## OAuth (coming in step 4)

Will redirect users to `studio.thepeakai.com/mcp-connect`, capture their Nhost JWT after normal login (LinkedIn / OTP), and issue an MCP access token. Same UX as the Chrome extension.

## Roadmap

- v0.1 (this) — 7 documented tools, dev-mode bearer auth
- v0.2 — OAuth bridge against Nhost via studio.thepeakai.com
- v0.3 — credits / team / transactions tools (after promoting internal endpoints to public docs)
- v1.0 — apply for Anthropic connector directory
