---
name: multica-ops
description: Operate STARGATE's Multica integration from the coding agent side. Check integration health (vendor clone, CLI, PAT link), bootstrap the vendor clone, and drive the Multica tool surface (status, list workspaces/issues/agents, create issue, quick-create) through the local API route or directly via tsx. Use when working with Multica, vendor/multica, src/lib/tools/multica.ts, the /api/tools/multica route, multica_token, or docs/MULTICA_DOCTRINE.md.
---

# Multica Ops (STARGATE)

Multica (multica.ai) is STARGATE's external agent board: issues assigned to AI
agent teammates. This skill is for the **coding agent** — not STARRA
runtime. STARRA's prompt-side counterpart is `docs/MULTICA_DOCTRINE.md`; keep
the two in sync when the tool surface changes (see "Doctrine sync").

## Integration map

| Piece | Path |
|-------|------|
| Client library (all tool functions) | `src/lib/tools/multica.ts` |
| API route exposing the tools | `src/app/api/tools/multica/route.ts` |
| Key vault (`multica_token`, `multica_base_url`) | `src/lib/keys.ts` → `data/keys.json` (gitignored) |
| Vendor clone (doctrine + API reference) | `vendor/multica/` (gitignored) |
| Bootstrap script for the vendor clone | `scripts/bootstrap-multica.sh` |
| STARRA prompt doctrine | `docs/MULTICA_DOCTRINE.md` |

Base URL defaults to `https://api.multica.ai`; self-host override lives in the
`multica_base_url` key slot (env fallback `MULTICA_SERVER_URL` or
`MULTICA_BASE_URL`).

## Diagnostic workflow

Copy and track when troubleshooting:

```
- [ ] Vendor clone present (vendor/multica/README.md)
- [ ] PAT linked (multica_token in data/keys.json or MULTICA_TOKEN env)
- [ ] Dev server up if using /api/tools/multica
- [ ] Network calls return {ok: true} or actionable {ok: false, error}
```

## Health check

Dev server running (preferred):

```bash
curl -s http://localhost:3000/api/tools/multica
# {"vendorPresent":true,"cliPresent":false,"tokenLinked":false,"baseUrl":"https://api.multica.ai","guide":"..."}
```

Dev server down — check the same three facts directly:

```bash
test -f vendor/multica/README.md && echo "vendor: present" || echo "vendor: missing"
command -v multica >/dev/null && echo "cli: present" || echo "cli: absent"
node -e 'const s=require("fs").existsSync("data/keys.json")?JSON.parse(require("fs").readFileSync("data/keys.json","utf8")):{};console.log("token:",s.multica_token?"linked":"not linked")'
```

The token check prints only linked/not-linked — never the value.

## Bootstrap or refresh the vendor clone

```bash
bash scripts/bootstrap-multica.sh
# or: npm run tools:bootstrap-multica
```

Shallow-clones `https://github.com/multica-ai/multica.git` into
`vendor/multica` if absent, otherwise reports it present. The vendor tree is
gitignored; never commit it.

## Tool surface

### Via the local API route (dev server running)

```bash
curl -s "http://localhost:3000/api/tools/multica"                          # status (default)
curl -s "http://localhost:3000/api/tools/multica?action=workspaces"
curl -s "http://localhost:3000/api/tools/multica?action=issues&workspaceId=<id>"   # workspaceId optional
curl -s "http://localhost:3000/api/tools/multica?action=agents&workspaceId=<id>"   # workspaceId optional

# Create an issue stub
curl -s -X POST http://localhost:3000/api/tools/multica \
  -H 'Content-Type: application/json' \
  -d '{"title":"Issue title","description":"optional","workspaceId":"optional","agentId":"optional"}'

# Quick-create: issue + enqueue agent run in one shot
curl -s -X POST http://localhost:3000/api/tools/multica \
  -H 'Content-Type: application/json' \
  -d '{"mode":"quick","prompt":"Do the thing","workspaceId":"optional","agentId":"optional"}'
```

### Direct invocation (dev server down)

Run from the repo root (the client resolves `data/keys.json` and
`vendor/multica` via `process.cwd()`, and tsx picks up the `@/*` path alias
from `tsconfig.json` automatically — do not pass `--tsconfig`, it hangs):

```bash
npx tsx -e \
  'import("./src/lib/tools/multica.ts").then(async m => console.log(JSON.stringify(await m.getMulticaStatus(), null, 2)))'
```

Exported functions in `src/lib/tools/multica.ts`: `getMulticaStatus()`,
`listWorkspaces()`, `listIssues(workspaceId?)`, `listAgents(workspaceId?)`,
`createIssueStub({title, description?, workspaceId?, assigneeAgentId?})`,
`quickCreateIssue({prompt, workspaceId?, agentId?})`. All network functions
return `{ok: true, data}` or `{ok: false, error, status?}` — they do not throw.
When `workspaceId` is omitted, the first workspace on the token is used.

## Token handling

- The PAT (typically `mul_…`) is linked in the app UI under **Settings → LINK
  APIS** and persisted to `data/keys.json` as `multica_token`. Env fallback:
  `MULTICA_TOKEN`.
- Never print, log, echo, or commit the token. `data/keys.json` is gitignored;
  keep it that way. When displaying key material use `mask()` from
  `src/lib/keys.ts`.

## Graceful degradation

If the token is not linked, every network call returns
`{ok: false, error: "multica_token not linked"}` and the API route surfaces
the error with a 4xx/502 status. Report "token not linked" and point at
Settings → LINK APIS — do not treat it as a failure, retry, or attempt to
source a token from anywhere else. Likewise, a missing vendor clone only means
doctrine/reference files are absent; the network tools still work.

## Doctrine sync

`docs/MULTICA_DOCTRINE.md` is injected into STARRA's runtime system prompt. If
a change alters the tool surface (actions, endpoints, key slots, lifecycle
semantics), update the doctrine's "STARRA operator rules" section to match.
Doctrine copy follows repo rules: operator voice, no emojis.
