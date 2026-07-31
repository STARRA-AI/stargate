# STARGATE platform posture

Classic's checklist (2026-07-31): "Database with RLS on, Version Control (Git),
an API so that you can make changes, caching, scaling, air tracking, and
security." Item-by-item, what exists, what was built, and what is deliberately
not done — no cosplay.

## Database (with RLS)
**Built.** SQLite via `node:sqlite` (native in Node 24 — zero deps, $0, no
daemon) at `data/stargate.db`, WAL mode, chmod 0600, gitignored. Access policy
(`src/lib/db.ts`): single-tenant RLS **semantics** — every row carries
`operator='classic'`, every query helper scopes to it, and the only paths to
the DB are auth-gated server routes. Migrated so far: **error tracking**
(native) and **Flip Radar** (first store migration, transactional upserts,
one-time import of its JSON state, same API — route/panel untouched). The
remaining JSON stores (memory, funding, tier1, engine) migrate on the same
pattern when touched next. TRUE policy-engine RLS = Postgres/Supabase (free
tier, needs Classic's account) — available later, not needed for one tenant.

## Version control (Git)
**Exists.** Full repo, GitHub remote (`ppt615-spec/stargate`), everything
pushed same-day. CI files parked at `ci/workflows/` (one-step activation —
push credential lacks the workflow scope).

## API (so changes can be made)
**Exists.** 20+ auth-gated routes including write paths: `api/context` (PUT),
`api/memory` (POST), `api/flipradar` (POST scan / PATCH status), `api/funding`
(PATCH), `api/engine/*` (cosmetics/keys), `api/errors` (readout). Everything
the deck shows is drivable through the API.

## Caching
**Exists + built.** In-process: canon/personality caches (brain), model-slug
resolution caches (hosted), memoized viseme assets. Built tonight: HTTP cache
headers for `/avatar/*` (1h, must-revalidate) and `/brand/*` (24h) —
deliberately **not** immutable because media files are replaced in place under
fixed names (the viseme bank rebuild would have served stale mouths for a
year).

## Scaling
**Right-sized, honestly.** STARGATE is a single-operator local deck: launchd →
watchdog → dev server keepalive (`scripts/macos/`), ECO mode halves polling
and freezes decorative motion, hidden tabs stop polling AND the canvas sky.
There is no multi-user load to scale for; pretending otherwise would burn
runway. If the deck ever serves beyond the house: `next build` + a real
process manager is the first step, Postgres the second.

## Air (error) tracking
**Built** ("air tracking" read as error tracking). `src/lib/errlog.ts`: every
captured failure lands in the `errors` table (scope, message, stack, capped at
500 rows) and narrates one `ERR` feed line. `src/instrumentation.ts` registers
the process-wide net (unhandled rejections/exceptions — observe, never exit).
Readout at `api/errors` (gated). Born from the poisoned-build night where the
deck broke silently.

## Security
**Exists + hardened tonight.**
- Login wall: session cookie (dies on close) + 12h HMAC tokens (v2 — old
  cookies rejected), lockout on failures, loopback exempt.
- **Fail-closed middleware** on the nodejs runtime — the 2026-07-31 fix: after
  a cache rebuild the edge sandbox lost `process.env`, and the old "no
  password configured → open" clause silently un-gated the whole deck. Now:
  non-local requests get 503 when auth is unavailable; the middleware shares
  the routes' runtime so the env cannot diverge again.
- Hardening headers on authed responses: nosniff, SAMEORIGIN,
  no-referrer, `camera=()` (the eye cam stays dead), `microphone=(self)`.
- Accepted risks, stated: no CSP yet (Next dev inline scripts + WKWebView
  brick risk — revisit at `next build` time); `data/keys.json` is plaintext at
  rest behind file perms + gitignore (single-user machine; the freellm router
  slot is AES-encrypted in ITS store).

Everything above is pinned by `tests/platform.test.ts`.
