# MCP bridge — her hands (Playwright + Composio)

Both STARRA and Classic's Claude Code sessions reach the same two MCP servers,
independently and CONCURRENTLY — each consumer holds its own connections, so
she and a coding session can both drive tools at the same time, including
while she is on a call (her bridge is a gated deck API that neither knows nor
cares whether the voice overlay is open).

## Her side (the deck)
- Bridge: `src/lib/mcp/client.ts` → gated route `api/tools/mcp`
  (GET = servers + tools, POST {server, tool, args} = call).
- Chat fast-paths (also usable in the call console): `mcp tools` ·
  `browse <url>` (navigate + snapshot — the walk-through-together primitive) ·
  `mcp <server> <tool> {json}` for exact calls.
- Playwright runs local + headless via `npx @playwright/mcp@latest` (free,
  spawned lazily, respawned on death). Verified live: 24 tools, real
  navigation smoke-tested against the deck itself.

## Claude Code side
- `playwright` added at user scope (all sessions): `npx -y @playwright/mcp@latest`
  — verified Connected.
- `composio` in the repo's `.mcp.json` (project scope, env-expanded — no
  secrets in git). First `claude` run in the repo asks one-time approval.

## Composio — the one human step (free tier)
1. Create a Composio account, make an MCP server with the toolkits you want
   (their dashboard), and copy the server URL + API key.
2. Put them in `.env.local`:
   `COMPOSIO_MCP_URL=https://backend.composio.dev/v3/mcp/<id>?user_id=<you>`
   `COMPOSIO_API_KEY=<key>`
3. That's it — her bridge lights the `composio` server on the next request,
   and Claude Code picks it up via `.mcp.json`.

## Honest limits
- On a VOICE call, her realtime session speaks; tool executions run through
  the deck (call console fast-paths or Classic's ask) — she narrates results.
  Wiring native realtime tool-calling to xAI is a separate, unverified step.
- Composio stays dark (clearly labeled, never faked) until the keys exist.
