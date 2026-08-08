# Public Surface Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two verified defects on STARGATE's internet-facing surface — raw error text leaking to the public, and a single token that grants both read and write to STARRA's memory.

**Architecture:** Two public routes (`/api/mcp`, `/api/voice-tools/[action]`) are reachable from the internet through a Cloudflare tunnel because xAI's servers must call them. Both currently return `String(err)` verbatim to an unauthenticated-adjacent caller, and both accept one bearer token for every operation including memory writes. This plan redacts every public error through the existing `redactSecrets`, and splits the single token into a read token and a strictly-scoped write token.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, Node built-in test runner via `tsx` (`npm run test:v2`). Existing modules: `src/lib/engine/redact.ts` (`redactSecrets`), `src/lib/memory/store.ts` (`recordExchange`).

## Global Constraints

- Baseline to preserve: `npm run test:v2` **1245 passing / 0 failing**, `npx tsc --noEmit` clean, `npm run lint` **0 errors** (86 warnings is the accepted baseline).
- **Never edit any `STARRA_*.md` canon file.**
- **Never edit `.env.local`.** New env vars are documented in `.env.example` only; Classic sets the real values.
- **No bare `return` on a failure path.** Every failure reports to the ops feed AND to visible state.
- **Fail closed.** An unset or too-short token must deny, never allow. Absent must never mean open.
- **No regex lookbehind** anywhere under `src/lib/voice/**` or `src/components/**` (macOS WKWebView).
- Public routes return **plain text or JSON-RPC only** — never a stack trace, never an absolute path.
- Run `scripts/backlog snap <label>` before any risky change.
- Existing public prefix list is exactly `["/login", "/api/auth", "/starra-ca.crt", "/api/mcp", "/api/voice-tools"]` and must not grow in this plan.

---

## Verified Findings (evidence, not suspicion)

| # | Finding | Evidence | Status |
|---|---|---|---|
| A | Raw error text returned to the public internet | `src/app/api/mcp/route.ts:202` returns `` `Memory tool failed: ${String(err).slice(0,200)}` ``; `src/app/api/voice-tools/[action]/route.ts:160` returns `` `Something went wrong on my end — ${String(err).slice(0,80)}` ``. Neither passes through `redactSecrets`, which exists and is used in `hosted.ts:321,326,355`. | **OPEN** |
| B | One token grants read AND write | `STARRA_MCP_TOKEN` guards `recall` (read) and `remember`/`note` (`recordExchange`, `[action]/route.ts:135,142`) and `funding_status` (`writeFile`, `:101`) identically. | **OPEN** |
| C | `/api/auth` brute-force | `src/lib/auth-lockout.ts` exists, is imported at `src/app/api/auth/route.ts:12`, and is safe-by-construction (loopback never locked). | **RESOLVED — no work** |

**Why B matters more than it looks:** a holder of that token can call `remember` and write arbitrary text into `data/memory.json`, which is the store her prompt is built from. That is not data corruption — it is a stranger editing what she believes about Classic. Read access leaks; write access rewrites her.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/api/public-errors.ts` | **NEW** — one place that turns any thrown value into a safe public string | create |
| `src/app/api/mcp/route.ts` | MCP bridge | use the safe formatter; adopt scoped tokens |
| `src/app/api/voice-tools/[action]/route.ts` | voice tools | use the safe formatter; adopt scoped tokens |
| `src/lib/api/public-auth.ts` | **NEW** — scoped bearer auth shared by both public routes | create |
| `tests/public-error-redaction.test.ts` | **NEW** | create |
| `tests/public-token-scopes.test.ts` | **NEW** | create |
| `.env.example` | document the new vars | modify |

---

## Task 1: Public errors can never leak

**Files:**
- Create: `src/lib/api/public-errors.ts`
- Test: `tests/public-error-redaction.test.ts`

**Interfaces:**
- Consumes: `redactSecrets(input: unknown, secrets?: readonly string[]): string` from `@/lib/engine/redact`
- Produces: `safePublicError(err: unknown, opts?: { maxLen?: number }): string` — a short, secret-free, path-free string safe to return to the internet.

- [ ] **Step 1: Write the failing test**

```ts
// tests/public-error-redaction.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safePublicError } from "../src/lib/api/public-errors";

describe("safePublicError — nothing internal reaches the internet", () => {
  it("strips absolute filesystem paths", () => {
    const out = safePublicError(new Error("ENOENT: /Users/starrallc/STARGATE/stargate/data/memory.json"));
    assert.doesNotMatch(out, /\/Users\//, "an absolute path names the machine and the operator");
  });

  it("strips anything shaped like a key", () => {
    for (const secret of ["xai-abc123def456ghi789jkl", "gsk_abc123def456ghi789", "sk-abc123def456ghi789"]) {
      const out = safePublicError(new Error(`upstream rejected ${secret}`));
      assert.ok(!out.includes(secret), `leaked: ${secret}`);
    }
  });

  it("never returns a stack trace", () => {
    const e = new Error("boom");
    assert.doesNotMatch(safePublicError(e), /\n\s+at /);
  });

  it("is bounded", () => {
    assert.ok(safePublicError(new Error("x".repeat(5000))).length <= 200);
  });

  it("still says something useful rather than nothing", () => {
    assert.ok(safePublicError(new Error("boom")).length > 0);
  });

  it("survives non-Error throws", () => {
    for (const v of [undefined, null, 42, { a: 1 }, "plain string"]) {
      assert.equal(typeof safePublicError(v), "string");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/public-error-redaction.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/api/public-errors'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/public-errors.ts
/**
 * Turn any thrown value into a string that is safe to hand to the internet.
 *
 * WHY: /api/mcp and /api/voice-tools are reachable from the public internet
 * because xAI's servers must call them. Both used to return `String(err)`
 * verbatim. A filesystem error names absolute paths (and therefore the machine
 * and the operator); an upstream error can carry a key. `redactSecrets` already
 * existed and was used on the LLM lane — it simply was never applied here.
 *
 * Errors still SAY something: a public route that returns nothing is the mute
 * call all over again, just quieter.
 */
import { redactSecrets } from "@/lib/engine/redact";

const MAX = 200;

export function safePublicError(err: unknown, opts?: { maxLen?: number }): string {
  const limit = opts?.maxLen ?? MAX;
  const base = err instanceof Error ? err.message : String(err ?? "unknown error");
  let out = redactSecrets(base);
  // Absolute paths: keep the basename so the message stays diagnostic.
  out = out.replace(/(?:\/[\w.\-@]+){2,}/g, (m) => `…/${m.split("/").pop() ?? ""}`);
  // Anything key-shaped that redactSecrets did not already catch.
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
  // A stack must never survive.
  out = out.split("\n")[0] ?? out;
  out = out.trim();
  if (!out) out = "unknown error";
  return out.length > limit ? out.slice(0, limit - 1) + "…" : out;
}
```

- [ ] **Step 4: Run the test — it passes**

Run: `npx tsx --test tests/public-error-redaction.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/public-errors.ts tests/public-error-redaction.test.ts
git commit -m "feat(security): one safe formatter for public error text

/api/mcp and /api/voice-tools are reachable from the internet and returned
String(err) verbatim — absolute paths name the machine and the operator, and
an upstream error can carry a key. redactSecrets already existed; it was just
never applied here."
```

---

## Task 2: Wire the safe formatter into both public routes

**Files:**
- Modify: `src/app/api/mcp/route.ts:202`
- Modify: `src/app/api/voice-tools/[action]/route.ts:160`
- Test: `tests/public-error-redaction.test.ts` (extend)

**Interfaces:**
- Consumes: `safePublicError` from Task 1.
- Produces: no public route contains a bare `String(err)` in a response body.

- [ ] **Step 1: Write the failing test**

Append to `tests/public-error-redaction.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("no public route returns raw error text", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const PUBLIC_ROUTES = [
    "src/app/api/mcp/route.ts",
    "src/app/api/voice-tools/[action]/route.ts",
  ];

  for (const rel of PUBLIC_ROUTES) {
    it(`${rel} routes errors through safePublicError`, () => {
      const src = readFileSync(join(REPO, rel), "utf8");
      assert.match(src, /safePublicError\(/, "must use the safe formatter");
      assert.doesNotMatch(
        src,
        /`[^`]*\$\{String\(err\)/,
        "raw String(err) must never reach a response body",
      );
    });
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/public-error-redaction.test.ts`
Expected: FAIL — both routes still interpolate `String(err)`.

- [ ] **Step 3: Implement**

In `src/app/api/mcp/route.ts`, add the import and replace the catch body:

```ts
import { safePublicError } from "@/lib/api/public-errors";
```

```ts
      } catch (err) {
        // Reported as a tool-level error, not a transport error: she should be
        // able to say "I couldn't reach my memory" rather than the call dying.
        return result(id, {
          content: [{ type: "text", text: `Memory tool failed: ${safePublicError(err)}` }],
          isError: true,
        });
      }
```

In `src/app/api/voice-tools/[action]/route.ts`:

```ts
import { safePublicError } from "@/lib/api/public-errors";
```

```ts
  } catch (err) {
    // Never a stack trace on a phone call, and never a path on the internet.
    return say(`Something went wrong on my end — ${safePublicError(err, { maxLen: 80 })}`);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/public-error-redaction.test.ts && npm run test:v2`
Expected: all PASS; suite total ≥ 1245 passing, 0 failing.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: tsc silent; eslint 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/mcp/route.ts "src/app/api/voice-tools/[action]/route.ts" tests/public-error-redaction.test.ts
git commit -m "fix(security): redact errors on both internet-facing routes

Pinned by a test that greps the route sources, because a leak here is
invisible at runtime — the call still works, it just tells a stranger where
the file lives."
```

---

## Task 3: Split read from write on the public token

**Files:**
- Create: `src/lib/api/public-auth.ts`
- Test: `tests/public-token-scopes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type PublicScope = "read" | "write"`
  - `authorizePublic(req: Request, scope: PublicScope): { ok: true } | { ok: false; status: number; message: string }`

**Design:** `STARRA_MCP_TOKEN` keeps working for **read**. A separate `STARRA_MCP_WRITE_TOKEN` is required for anything that mutates. If the write token is unset, **writes are denied** — the read surface keeps working, so a missing variable degrades capability rather than opening a hole. The write token must not equal the read token.

- [ ] **Step 1: Write the failing test**

```ts
// tests/public-token-scopes.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { authorizePublic } from "../src/lib/api/public-auth";

const READ = "read-token-long-enough-for-the-guard-01234567";
const WRITE = "write-token-long-enough-for-the-guard-0123456";
let savedRead: string | undefined;
let savedWrite: string | undefined;

before(() => {
  savedRead = process.env.STARRA_MCP_TOKEN;
  savedWrite = process.env.STARRA_MCP_WRITE_TOKEN;
  process.env.STARRA_MCP_TOKEN = READ;
  process.env.STARRA_MCP_WRITE_TOKEN = WRITE;
});
after(() => {
  if (savedRead === undefined) delete process.env.STARRA_MCP_TOKEN;
  else process.env.STARRA_MCP_TOKEN = savedRead;
  if (savedWrite === undefined) delete process.env.STARRA_MCP_WRITE_TOKEN;
  else process.env.STARRA_MCP_WRITE_TOKEN = savedWrite;
});

const req = (token?: string) =>
  new Request("http://local/x", { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("public token scopes", () => {
  it("the read token reads", () => {
    assert.equal(authorizePublic(req(READ), "read").ok, true);
  });

  it("the read token CANNOT write — this is the whole point", () => {
    const r = authorizePublic(req(READ), "write");
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 403);
  });

  it("the write token writes", () => {
    assert.equal(authorizePublic(req(WRITE), "write").ok, true);
  });

  it("the write token also reads", () => {
    assert.equal(authorizePublic(req(WRITE), "read").ok, true);
  });

  it("no token is denied for both scopes", () => {
    assert.equal(authorizePublic(req(), "read").ok, false);
    assert.equal(authorizePublic(req(), "write").ok, false);
  });

  it("an UNSET write token denies writes but keeps reads working", () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    delete process.env.STARRA_MCP_WRITE_TOKEN;
    assert.equal(authorizePublic(req(READ), "read").ok, true, "reads must survive");
    assert.equal(authorizePublic(req(READ), "write").ok, false, "absent must never mean open");
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
  });

  it("refuses a write token identical to the read token", () => {
    const prev = process.env.STARRA_MCP_WRITE_TOKEN;
    process.env.STARRA_MCP_WRITE_TOKEN = READ;
    const r = authorizePublic(req(READ), "write");
    assert.equal(r.ok, false, "one token wearing two hats is not a split");
    process.env.STARRA_MCP_WRITE_TOKEN = prev;
  });

  it("a too-short token is treated as unset", () => {
    const prev = process.env.STARRA_MCP_TOKEN;
    process.env.STARRA_MCP_TOKEN = "short";
    const r = authorizePublic(req("short"), "read");
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 503);
    process.env.STARRA_MCP_TOKEN = prev;
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/public-token-scopes.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/api/public-auth'`.

- [ ] **Step 3: Implement**

```ts
// src/lib/api/public-auth.ts
/**
 * Scoped bearer auth for the two internet-facing routes.
 *
 * WHY SCOPES: one token used to grant `recall` (read) and `remember` (write)
 * identically. A holder could write arbitrary text into data/memory.json —
 * the store her prompt is built from. That is not data corruption, it is a
 * stranger editing what she believes about Classic. Read access leaks; write
 * access rewrites her, so writes get their own key.
 *
 * FAIL CLOSED, ASYMMETRICALLY: if the write token is unset, writes are denied
 * and reads keep working. A missing variable should cost capability, never
 * open a door.
 */
const MIN_TOKEN_LENGTH = 24;

export type PublicScope = "read" | "write";
export type PublicAuthResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export function authorizePublic(req: Request, scope: PublicScope): PublicAuthResult {
  const read = process.env.STARRA_MCP_TOKEN ?? "";
  const write = process.env.STARRA_MCP_WRITE_TOKEN ?? "";
  const given = bearer(req);

  if (read.length < MIN_TOKEN_LENGTH) {
    return { ok: false, status: 503, message: "disabled: set STARRA_MCP_TOKEN to a long random value" };
  }

  if (scope === "write") {
    if (write.length < MIN_TOKEN_LENGTH) {
      return { ok: false, status: 403, message: "writes are disabled: STARRA_MCP_WRITE_TOKEN is not set" };
    }
    if (timingSafeEqual(write, read)) {
      return { ok: false, status: 503, message: "writes are disabled: the write token must differ from the read token" };
    }
    if (!timingSafeEqual(given, write)) {
      return { ok: false, status: 403, message: "this token cannot write" };
    }
    return { ok: true };
  }

  // read: either key opens it
  if (timingSafeEqual(given, read)) return { ok: true };
  if (write.length >= MIN_TOKEN_LENGTH && timingSafeEqual(given, write)) return { ok: true };
  return { ok: false, status: 401, message: "unauthorized" };
}
```

- [ ] **Step 4: Run the test**

Run: `npx tsx --test tests/public-token-scopes.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/public-auth.ts tests/public-token-scopes.test.ts
git commit -m "feat(security): scoped tokens for the public surface

Read and write were the same key. A holder could write into the memory store
her prompt is built from — a stranger editing what she believes about Classic.
Writes now need their own token, and an unset write token denies writes while
reads keep working."
```

---

## Task 4: Adopt scoped auth in both public routes

**Files:**
- Modify: `src/app/api/voice-tools/[action]/route.ts` (replace the local `authorized()` helper)
- Modify: `src/app/api/mcp/route.ts` (replace the inline token check)
- Modify: `.env.example`
- Test: `tests/public-token-scopes.test.ts` (extend), `tests/voice-tools.test.ts` (update), `tests/mcp-memory-bridge.test.ts` (update)

**Interfaces:**
- Consumes: `authorizePublic`, `PublicScope` from Task 3.
- Produces: `recall` requires `read`; `remember`, `note`, `funding_status` require `write`. MCP `tools/call` requires `write` for `remember`, `read` for `recall_memory`.

- [ ] **Step 1: Write the failing test**

Append to `tests/public-token-scopes.test.ts`:

```ts
describe("the routes actually enforce the scopes", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  it("voice-tools maps each action to a scope", () => {
    const src = readFileSync(join(REPO, "src/app/api/voice-tools/[action]/route.ts"), "utf8");
    assert.match(src, /authorizePublic\(/);
    for (const write of ["remember", "note", "funding_status"]) {
      assert.match(src, new RegExp(`${write}[^]{0,400}"write"|"write"[^]{0,400}${write}`), `${write} must require write`);
    }
  });
  it("mcp requires write for the remember tool", () => {
    const src = readFileSync(join(REPO, "src/app/api/mcp/route.ts"), "utf8");
    assert.match(src, /authorizePublic\(/);
    assert.match(src, /"write"/);
  });
});
```

Add the imports at the top of that file:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/public-token-scopes.test.ts`
Expected: FAIL — neither route imports `authorizePublic`.

- [ ] **Step 3: Implement in `src/app/api/voice-tools/[action]/route.ts`**

Delete the local `authorized()` function and its `MIN_TOKEN_LENGTH` constant. Add:

```ts
import { authorizePublic, type PublicScope } from "@/lib/api/public-auth";

/** Which actions mutate. Anything not listed here is read-only. */
const WRITE_ACTIONS = new Set(["remember", "note", "funding_status"]);
```

Replace the gate at the top of `GET`:

```ts
  const { action } = await ctx.params;
  const scope: PublicScope = WRITE_ACTIONS.has(action) ? "write" : "read";
  const gate = authorizePublic(req, scope);
  if (!gate.ok) return say(gate.message, gate.status);
```

- [ ] **Step 4: Implement in `src/app/api/mcp/route.ts`**

Replace the inline token block with:

```ts
import { authorizePublic } from "@/lib/api/public-auth";

const MCP_WRITE_TOOLS = new Set(["remember"]);
```

Gate `initialize` / `tools/list` / `ping` with `"read"`, and inside `tools/call`:

```ts
      const scope = MCP_WRITE_TOOLS.has(name) ? "write" : "read";
      const toolGate = authorizePublic(req, scope);
      if (!toolGate.ok) return rpcError(id, -32001, toolGate.message, toolGate.status);
```

- [ ] **Step 5: Update the existing suites to the new contract**

In `tests/voice-tools.test.ts` and `tests/mcp-memory-bridge.test.ts`, set **both** env vars in `before()` and use the write token for write actions:

```ts
process.env.STARRA_MCP_TOKEN = T;                       // read
process.env.STARRA_MCP_WRITE_TOKEN = T + "-write";      // write, must differ
```

- [ ] **Step 6: Document the new variable**

Append to `.env.example`:

```
# Public surface: READ token (recall). Long random value.
STARRA_MCP_TOKEN=
# Public surface: WRITE token (remember / note / funding_status). MUST differ
# from STARRA_MCP_TOKEN. If unset, writes are denied and reads keep working.
# Generate: openssl rand -hex 32
STARRA_MCP_WRITE_TOKEN=
```

- [ ] **Step 7: Full verification**

Run: `npm run test:v2 && npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: ≥ 1245 passing / 0 failing; tsc silent; eslint 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/mcp/route.ts "src/app/api/voice-tools/[action]/route.ts" \
        tests/public-token-scopes.test.ts tests/voice-tools.test.ts \
        tests/mcp-memory-bridge.test.ts .env.example
git commit -m "feat(security): enforce read/write scopes on the public routes

recall is read; remember, note and funding_status require the write token.
Classic must set STARRA_MCP_WRITE_TOKEN and update the write tools in the xAI
console — until he does, reads keep working and writes are denied, which is
the correct direction to fail."
```

---

## Task 5: Prove it from outside

**Files:**
- Create: `scripts/audit-public-surface`

**Interfaces:**
- Consumes: `data/tunnel-url.txt` (written by `scripts/starra-tunnel`), `STARRA_MCP_TOKEN`, `STARRA_MCP_WRITE_TOKEN`.
- Produces: a runnable audit that exercises the real public surface over the real tunnel and exits non-zero on any failure.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Audit the internet-facing surface the way an attacker reaches it: over the
# public tunnel, not localhost. Unit tests prove the logic; this proves the
# deployment.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
URL=$(cat data/tunnel-url.txt 2>/dev/null) || { echo "no tunnel URL — run scripts/starra-tunnel start"; exit 1; }
HOST=${URL#https://}
IP=$(dig +short @1.1.1.1 "$HOST" | grep -E '^[0-9]' | head -1)
[ -n "$IP" ] || { echo "cannot resolve $HOST"; exit 1; }
READ=$(grep -E '^STARRA_MCP_TOKEN=' .env.local | cut -d= -f2-)
WRITE=$(grep -E '^STARRA_MCP_WRITE_TOKEN=' .env.local | cut -d= -f2-)
fail=0
probe() { # name expected path token
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 --resolve "$HOST:443:$IP" \
    ${4:+-H "Authorization: Bearer $4"} "https://$HOST$3")
  if [ "$code" = "$2" ]; then printf "  PASS  %-46s %s\n" "$1" "$code"
  else printf "  FAIL  %-46s got %s want %s\n" "$1" "$code" "$2"; fail=1; fi
}
echo "auditing $URL"
probe "private route stays private"      401 "/api/memory"            ""
probe "keys route stays private"         401 "/api/keys"              ""
probe "vault stays private"              401 "/api/vault/upload"      ""
probe "chat stays private"               401 "/api/chat"              ""
probe "recall needs a token"             401 "/api/voice-tools/recall?query=x" ""
probe "recall works with read token"     200 "/api/voice-tools/recall?query=x" "$READ"
probe "READ TOKEN CANNOT WRITE"          403 "/api/voice-tools/remember?text=x" "$READ"
[ -n "$WRITE" ] && probe "write token can write" 200 "/api/voice-tools/remember?text=audit" "$WRITE"
exit $fail
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x scripts/audit-public-surface && scripts/audit-public-surface`
Expected: every line PASS. `READ TOKEN CANNOT WRITE` returning **403** is the line that proves Task 3 and 4 actually shipped.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-public-surface
git commit -m "feat(security): audit the public surface from outside

Unit tests prove the logic; this proves the deployment. The line that matters
is READ TOKEN CANNOT WRITE returning 403 over the real tunnel."
```

---

## Self-Review

**Spec coverage:**

| finding | task |
|---|---|
| A — raw error text on public routes | 1, 2 |
| B — one token for read and write | 3, 4 |
| C — `/api/auth` brute force | none needed; `auth-lockout.ts` already wired at `auth/route.ts:12` |
| deployment proof (not just unit proof) | 5 |

**Placeholder scan:** none — every step carries real code or a real command.

**Type consistency:** `safePublicError(err, opts?)` is defined in Task 1 and called in Task 2 with the same signature (`{ maxLen: 80 }`). `authorizePublic(req, scope)` returns `{ ok: true } | { ok: false; status; message }` in Task 3 and is destructured as `gate.ok` / `gate.message` / `gate.status` in Task 4. `PublicScope` is exported in Task 3 and imported in Task 4.

**Known follow-up, deliberately out of scope:** splitting the token requires Classic to set `STARRA_MCP_WRITE_TOKEN` and re-paste the three write tools in the xAI console. Until he does, writes fail closed and reads keep working — capability degrades, nothing opens.
