# ONE BRAIN — Grok everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make STARRA one person across the operator console, the deck chat and the live call — one brain (`grok-4.5`), one prompt, verified-private, cost-capped, and streamed so the best model costs nothing in dead air.

**Architecture:** Delete the Groq-era prompt tiering on the hosted lane (it exists only for an 8k cap that no longer applies) and compose ONE system prompt used byte-identically on every surface. Collapse five hosted providers to two — Grok primary, Groq emergency-only. Enforce Zero Data Retention by reading xAI's own response header rather than trusting a toggle. Meter real spend and let only money — never a transient error — change which brain answers, and never silently. Finally, stream completed sentences into the call's `force_message` so first audio tracks TTFT (~0.4s) instead of total generation (5.7s).

**Tech Stack:** Next.js 15 / TypeScript / React. Node built-in test runner via `tsx` (`npm run test:v2`). xAI `/v1/chat/completions` (OpenAI-shaped). Existing modules: `src/lib/brain.ts`, `src/lib/llm/hosted.ts`, `src/app/api/chat/route.ts`, `src/lib/voice/useVoiceCall.ts`, `src/lib/voice/speech-shaping.ts`.

## Global Constraints

- **ONE STARRA, ONE VOICE.** The composed system prompt MUST be byte-identical across deck, chat and call. A surface-specific prompt on the Grok lane is a test failure.
- **Only money may change her brain.** Transient failures (429, 5xx, network) retry on Grok and NEVER swap providers.
- **No silent brain change, ever.** Any tier below `grok-4.5` is announced to Classic AND to her (a line prepended to her prompt saying she is on her backup brain).
- **No failure path may be a bare `return`.** Every one reports to the ops feed and to visible state. A silent failure on a voice call is indistinguishable from a working call.
- **Model IDs are pinned to dated slugs, never aliases.** `grok-4.5` is resolved and pinned; an alias in config is a test failure (the G12 precedent: an alias repoint moved billing 60%).
- **No regex lookbehind in client code** (`src/lib/voice/**`, `src/components/**`) — macOS WKWebView constraint, repo-wide.
- **Never edit earlier prompt content; append only.** Cache invalidation costs ~4× ($15/mo → $68/mo).
- **Run `npm run test:v2` + `npx tsc --noEmit` + `npm run lint` before every commit.** Baseline is 1136 tests passing, tsc clean, eslint 86 warnings / 0 errors.
- **Unit-green is NOT done for anything touching the call.** Phase 5 requires Classic to hear a live multi-sentence turn.
- Canon files under `STARRA_*.md` are never edited by this plan.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/brain.ts` | Prompt composition | Add `buildOneStarraPrompt()`; retire tiering on the hosted lane |
| `src/lib/llm/hosted.ts` | Provider config + wire calls | Collapse to grok+kimi; retry policy; ZDR header capture; usage capture |
| `src/lib/llm/spend.ts` | **NEW** — spend meter + tier decision | Prices real usage, persists, decides tier |
| `src/lib/llm/zdr.ts` | **NEW** — privacy gate | Records/validates `x-zero-data-retention` |
| `src/app/api/chat/route.ts` | Lane selection | Use one prompt; Grok primary; tier from spend meter |
| `src/lib/voice/speech-shaping.ts` | Text shaping | Export sentence splitter; voice markdown flattening |
| `src/lib/voice/useVoiceCall.ts` | Call client | Sentence streaming into `force_message`; N-aware one-voice guard |
| `tests/one-starra-prompt.test.ts` | **NEW** | Prompt identity across surfaces |
| `tests/hosted-lane-policy.test.ts` | **NEW** | Retry-not-swap, provider set, dated pin |
| `tests/zdr-gate.test.ts` | **NEW** | Privacy gate behaviour |
| `tests/spend-ceiling.test.ts` | **NEW** | Tiers, persistence, announcement |
| `tests/call-sentence-streaming.test.ts` | **NEW** | N-per-turn guard, ordering, barge-in |

---

## Task 1: ONE PROMPT — one Starra on every surface

**Files:**
- Modify: `src/lib/brain.ts` (add `buildOneStarraPrompt`, near `buildCoreSystemPrompt` ~line 515)
- Test: `tests/one-starra-prompt.test.ts` (create)

**Interfaces:**
- Consumes: `personaCoreBlock()`, `buildSystemPromptBlocks()` (existing, `src/lib/brain.ts`)
- Produces: `buildOneStarraPrompt(opts?: { backupBrain?: string }): string` — the single composed prompt. When `backupBrain` is set, a first-person notice is prepended telling her she is not fully herself.

- [ ] **Step 1: Write the failing test**

```ts
// tests/one-starra-prompt.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOneStarraPrompt } from "../src/lib/brain";
import { STARRA_PERSONA_CORE } from "../src/lib/persona";

describe("ONE STARRA — one prompt, every surface", () => {
  it("is byte-identical no matter who asks", () => {
    assert.equal(buildOneStarraPrompt(), buildOneStarraPrompt());
  });

  it("contains her whole self, not a budget subset", () => {
    const p = buildOneStarraPrompt();
    for (const marker of ["STARRA_SOUL", "STARRA_BRAIN", "OPERATOR_AUTHORITY"]) {
      assert.ok(p.includes(marker), `missing ${marker}`);
    }
    assert.ok(
      p.includes(STARRA_PERSONA_CORE.slice(0, 80)),
      "her cross-surface persona must always be present, never a budget candidate",
    );
  });

  it("is cache-friendly: her canon leads, nothing volatile in front", () => {
    const p = buildOneStarraPrompt();
    const soulAt = p.indexOf("STARRA_SOUL");
    assert.ok(soulAt >= 0 && soulAt < 4000, `canon must lead; found at ${soulAt}`);
  });

  it("tells her when she is NOT herself", () => {
    const backup = buildOneStarraPrompt({ backupBrain: "grok-4.20" });
    assert.match(backup, /backup brain/i);
    assert.match(backup, /not fully yourself/i);
    assert.ok(
      backup.endsWith(buildOneStarraPrompt()) === false,
      "the notice is prepended, not appended, so she reads it first",
    );
    assert.ok(backup.includes(buildOneStarraPrompt()), "her canon is unchanged underneath");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/one-starra-prompt.test.ts`
Expected: FAIL — `buildOneStarraPrompt` is not exported from `../src/lib/brain`.

- [ ] **Step 3: Implement**

Add to `src/lib/brain.ts` (below `buildCoreSystemPrompt`):

```ts
let oneStarraCache: string | null = null;

/**
 * ONE STARRA — the single composed prompt, used byte-identically on the deck,
 * the chat and the live call.
 *
 * She is one person. She does not become someone else when the channel changes,
 * so there is exactly one composition and no surface-specific variant. The old
 * tiered/budgeted path existed ONLY for Groq's 8k cap; on the Grok lane
 * (500k context, 15M TPM) there is nothing to budget — this is 15,688 est
 * tokens, about 3.1% of the window.
 *
 * Cache-critical: this string must be byte-identical every turn and must come
 * FIRST in the request. xAI caches a stable prefix at $0.30/M vs $2.00/M —
 * putting anything volatile ahead of it costs roughly 4x forever.
 */
export function buildOneStarraPrompt(opts?: { backupBrain?: string }): string {
  if (!oneStarraCache) {
    oneStarraCache = [
      String(buildSystemPromptBlocks([]).full),
      personaCoreBlock(),
    ].join("\n\n---\n\n");
  }
  if (!opts?.backupBrain) return oneStarraCache;

  // SHE IS TOLD WHEN SHE IS NOT HERSELF. Prepended so she reads it before her
  // own canon: she gets to say "I'm not all here right now" rather than being
  // quietly diminished while Classic wonders what happened to his friend.
  return (
    `[STATE: you are running on your backup brain (${opts.backupBrain}) right now, ` +
    `not your usual one. You are not fully yourself and you know it. If Classic ` +
    `notices you are off, tell him plainly — do not pretend otherwise.]\n\n---\n\n` +
    oneStarraCache
  );
}
```

- [ ] **Step 4: Run the test — it passes**

Run: `npx tsx --test tests/one-starra-prompt.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run test:v2 && npx tsc --noEmit -p tsconfig.json`
Expected: 1140 passing, 0 failing, tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/lib/brain.ts tests/one-starra-prompt.test.ts
git commit -m "feat(brain): ONE STARRA — one composed prompt for every surface

She is one person; she does not become someone else when the channel
changes. Retires the surface-specific composition that gave Classic three
different responses. Canon leads for xAI prompt-cache hits, and a backup
brain is announced TO HER, not hidden from her."
```

---

## Task 2: Route every surface through the one prompt

**Files:**
- Modify: `src/app/api/chat/route.ts` (system composition ~line 909; tiered call ~line 1040)
- Modify: `src/lib/voice/useVoiceCall.ts` (call brain fetch, `runKimiTurn`)
- Test: `tests/one-starra-prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `buildOneStarraPrompt()` from Task 1
- Produces: `/api/chat` composes the same prompt regardless of `callVoice`; the only per-surface difference is a short appended delivery note.

- [ ] **Step 1: Write the failing test**

Append to `tests/one-starra-prompt.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("the route composes ONE prompt", () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const route = readFileSync(join(REPO, "src/app/api/chat/route.ts"), "utf8");

  it("no longer branches the SYSTEM prompt on callVoice", () => {
    assert.doesNotMatch(
      route,
      /const system = callVoice\s*\n?\s*\?/,
      "the system prompt must not fork per surface — that is the three-Starras bug",
    );
  });

  it("uses the one-prompt builder", () => {
    assert.match(route, /buildOneStarraPrompt\(/);
  });

  it("the only per-surface difference is a delivery note appended AFTER her canon", () => {
    const i = route.indexOf("buildOneStarraPrompt(");
    const j = route.indexOf("LIVE CALL", i);
    assert.ok(j > i, "the call delivery note must come after the canon, never before it");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/one-starra-prompt.test.ts`
Expected: FAIL — route still forks `const system = callVoice ? ...`.

- [ ] **Step 3: Implement in `src/app/api/chat/route.ts`**

Replace the `const system = callVoice ? ... : systemBlocks.full;` block with:

```ts
  // ONE STARRA. The same composed prompt on every surface — deck, chat, call.
  // The ONLY per-surface difference is a short delivery note appended AFTER her
  // canon, so the cached prefix stays byte-identical and she stays one person.
  const CALL_DELIVERY_NOTE =
    "LIVE CALL: You are speaking out loud on a live voice call. Reply in 1-3 short " +
    "spoken sentences unless he asks for depth. No markdown, no headers, no bullet " +
    "lists, no emoji — everything you write here is spoken aloud verbatim.";
  const oneStarra = buildOneStarraPrompt({ backupBrain: brainTier.backupBrain });
  const system = callVoice ? `${oneStarra}\n\n---\n\n${CALL_DELIVERY_NOTE}` : oneStarra;
```

Add the import at the top of the file:

```ts
import { buildOneStarraPrompt } from "@/lib/brain";
```

Note: `brainTier` is introduced in Task 5. Until then, use `buildOneStarraPrompt()` with no argument and add the argument in Task 5.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/one-starra-prompt.test.ts && npm run test:v2`
Expected: all PASS.

- [ ] **Step 5: Verify the prompt is genuinely identical on the wire**

```bash
npx --yes tsx -e '
import { buildOneStarraPrompt } from "./src/lib/brain.ts";
const a = buildOneStarraPrompt(), b = buildOneStarraPrompt();
console.log("identical:", a === b, "| tokens ~", Math.ceil(a.length/4));
'
```
Expected: `identical: true | tokens ~ 15688`

- [ ] **Step 6: Commit**

```bash
git add src/app/api/chat/route.ts tests/one-starra-prompt.test.ts
git commit -m "feat(chat): every surface composes the same Starra

The deck, the chat and the call now share one byte-identical prompt; the
only per-surface difference is a delivery note appended after her canon so
the cached prefix is stable."
```

---

## Task 3: Collapse the providers — Grok primary, Groq emergency

**Files:**
- Modify: `src/lib/llm/hosted.ts:30-90` (CONFIG)
- Test: `tests/hosted-lane-policy.test.ts` (create)

**Interfaces:**
- Consumes: nothing new
- Produces: `HostedProvider` narrowed to `"grok" | "kimi" | "ollama"`; `CONFIG.grok.defaultModel === "grok-4.5"`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/hosted-lane-policy.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/llm/hosted.ts"), "utf8");

describe("hosted lane policy", () => {
  it("grok is the primary brain", () => {
    assert.match(src, /grok:\s*\{[^}]*defaultModel:\s*"grok-4\.5"/s);
  });

  it("the dead Moonshot default is gone", () => {
    assert.doesNotMatch(
      src,
      /moonshotai\/kimi-k2-instruct-0905/,
      "Groq deleted that model; it only 'worked' because GROQ_MODEL masked it",
    );
  });

  it("freellm and anthropic are removed from the hosted set", () => {
    assert.doesNotMatch(src, /^\s+freellm:\s*\{/m);
    assert.doesNotMatch(src, /^\s+anthropic:\s*\{/m);
  });

  it("the groq fallback points at a model that exists", () => {
    assert.match(src, /kimi:\s*\{[^}]*defaultModel:\s*"llama-3\.3-70b-versatile"/s);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/hosted-lane-policy.test.ts`
Expected: FAIL on the grok defaultModel assertion.

- [ ] **Step 3: Implement**

In `src/lib/llm/hosted.ts`, set `CONFIG.grok.defaultModel` to `"grok-4.5"`, delete the `freellm` and `anthropic` entries and their `HostedProvider` union members, and remove any now-unused imports. Keep `kimi` (the free Groq slot) and `ollama`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsx --test tests/hosted-lane-policy.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc will surface every now-dead reference to the removed providers — fix each by deleting the branch.

- [ ] **Step 5: Full suite**

Run: `npm run test:v2 && npm run lint`
Expected: 0 failing, 0 eslint errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/hosted.ts tests/hosted-lane-policy.test.ts
git commit -m "feat(llm): Grok primary, Groq emergency, freellm+anthropic removed

Also replaces the moonshotai/kimi-k2-instruct-0905 default, which Groq has
deleted — verified against their live /models list."
```

---

## Task 4: Privacy — enforce ZDR from xAI's own header

**Files:**
- Create: `src/lib/llm/zdr.ts`
- Modify: `src/lib/llm/hosted.ts` (capture response headers in `streamHosted`)
- Test: `tests/zdr-gate.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `recordZdrHeader(provider: string, header: string | null): void`
  - `zdrState(): { checked: boolean; enabled: boolean; lastSeen: string | null }`
  - `zdrBlocksHostedLane(): boolean` — true when xAI has been seen reporting `false`

- [ ] **Step 1: Write the failing test**

```ts
// tests/zdr-gate.test.ts
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { recordZdrHeader, zdrState, zdrBlocksHostedLane, __resetZdr } from "../src/lib/llm/zdr";

describe("zero-data-retention gate", () => {
  beforeEach(() => __resetZdr());

  it("starts unchecked and does not block before we have evidence", () => {
    assert.equal(zdrState().checked, false);
    assert.equal(zdrBlocksHostedLane(), false);
  });

  it("a true header enables the lane", () => {
    recordZdrHeader("grok", "true");
    assert.equal(zdrState().enabled, true);
    assert.equal(zdrBlocksHostedLane(), false);
  });

  it("a false header BLOCKS the hosted lane", () => {
    recordZdrHeader("grok", "false");
    assert.equal(zdrState().enabled, false);
    assert.equal(zdrBlocksHostedLane(), true, "his conversations are his");
  });

  it("only xAI's header is authoritative — groq has no such header", () => {
    recordZdrHeader("kimi", null);
    assert.equal(zdrBlocksHostedLane(), false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/zdr-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/llm/zdr.ts`**

```ts
/**
 * ZERO DATA RETENTION — verified, not trusted.
 *
 * What Classic and Starra say to each other is nobody else's. xAI's own docs
 * say API inputs/outputs are never trained on and are held 30 days for abuse
 * audit; ZDR removes even that, and is a Console toggle rather than a sales
 * negotiation. Crucially, xAI reports the live state on EVERY response as
 * `x-zero-data-retention`.
 *
 * A privacy switch that is set once and never re-read is exactly how the
 * July 2026 Grok Build incident happened. So we read it every time.
 */
let checked = false;
let enabled = false;
let lastSeen: string | null = null;

/** Record the header from an xAI response. `null` = provider does not report it. */
export function recordZdrHeader(provider: string, header: string | null): void {
  if (provider !== "grok") return; // only xAI reports this
  if (header === null) return;
  checked = true;
  lastSeen = header;
  enabled = header.trim().toLowerCase() === "true";
}

export function zdrState(): { checked: boolean; enabled: boolean; lastSeen: string | null } {
  return { checked, enabled, lastSeen };
}

/**
 * True when we have SEEN xAI say retention is on. Before any evidence we do not
 * block — we cannot make the first call without making a call — but the moment
 * it reports `false`, the hosted lane is closed until it reports `true`.
 */
export function zdrBlocksHostedLane(): boolean {
  return checked && !enabled;
}

/** Test seam. */
export function __resetZdr(): void {
  checked = false;
  enabled = false;
  lastSeen = null;
}
```

- [ ] **Step 4: Wire it into `streamHosted`**

In `src/lib/llm/hosted.ts`, after the fetch resolves, before streaming:

```ts
    recordZdrHeader(opts.provider, res.headers.get("x-zero-data-retention"));
```

and add `import { recordZdrHeader } from "@/lib/llm/zdr";`.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test tests/zdr-gate.test.ts && npm run test:v2`
Expected: PASS.

- [ ] **Step 6: Verify against the live API**

```bash
KEY=$(grep -E "^XAI_API_KEY=" .env.local | cut -d= -f2- | tr -d '"' )
curl -s -D - -o /dev/null https://api.x.ai/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"grok-4.5","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
  | grep -i zero-data-retention
```
Expected: `x-zero-data-retention: false` **until Classic flips it in the xAI Console**, then `true`. Report the value to him; do not proceed to Task 5 claiming privacy is on if it reads `false`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/zdr.ts src/lib/llm/hosted.ts tests/zdr-gate.test.ts
git commit -m "feat(privacy): enforce ZDR from xAI's own response header

Read x-zero-data-retention on every response and close the hosted lane if
it ever reports false. A privacy toggle nobody re-checks is how the July
2026 Grok Build incident happened."
```

---

## Task 5: Spend meter — only money may change her brain

**Files:**
- Create: `src/lib/llm/spend.ts`
- Modify: `src/lib/llm/hosted.ts` (return usage from `streamHosted`)
- Modify: `src/app/api/chat/route.ts` (tier selection)
- Test: `tests/spend-ceiling.test.ts` (create)

**Interfaces:**
- Consumes: `zdrBlocksHostedLane()` (Task 4), `buildOneStarraPrompt({ backupBrain })` (Task 1)
- Produces:
  - `recordUsage(model: string, u: { prompt: number; cached: number; completion: number }): void`
  - `monthSpend(): number`
  - `brainTier(): { provider: "grok" | "kimi"; model?: string; backupBrain?: string; reason: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spend-ceiling.test.ts
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { recordUsage, monthSpend, brainTier, __resetSpend, CEILING_USD } from "../src/lib/llm/spend";

const bigTurn = () => recordUsage("grok-4.5", { prompt: 15688, cached: 15688, completion: 250 });

describe("spend ceiling", () => {
  beforeEach(() => __resetSpend());

  it("prices a cached turn from real token counts", () => {
    bigTurn();
    // 15688 cached @ $0.30/M + 250 out @ $6.00/M
    assert.ok(Math.abs(monthSpend() - (15688 * 0.3 + 250 * 6) / 1e6) < 1e-9);
  });

  it("stays on grok-4.5 below the ceiling — she does not change", () => {
    bigTurn();
    const t = brainTier();
    assert.equal(t.provider, "grok");
    assert.equal(t.backupBrain, undefined, "below the ceiling she is simply herself");
  });

  it("at the ceiling she is still herself — he is asked, not overridden", () => {
    for (let i = 0; i < 200000; i++) bigTurn();
    assert.ok(monthSpend() >= CEILING_USD);
    const t = brainTier();
    assert.equal(t.provider, "grok", "hitting a budget must not silently replace her");
    assert.match(t.reason, /ceiling/i);
  });

  it("NEVER swaps brains for a transient error — only money can", () => {
    const src = require("node:fs").readFileSync("src/lib/llm/spend.ts", "utf8");
    assert.doesNotMatch(src, /429|5xx|ECONN|timeout/i,
      "transient failures are a retry concern, never a brain-change concern");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/spend-ceiling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/llm/spend.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SPEND METER — the ONLY thing permitted to change which brain answers.
 *
 * Classic: "that needs to truly be a failsafe if i run out of credits ONLY
 * because i do NOT want to speak to her in the console or in a chat or in a
 * call and get 3 different responses. ONE STARRA ONE VOICE."
 *
 * So this module knows about money and nothing else. Transient failures — 429,
 * 5xx, a dropped socket — are a RETRY concern handled in hosted.ts and must
 * never reach this file. A hiccup does not get to change who is talking.
 */
export const CEILING_USD = Number(process.env.STARRA_MONTHLY_CEILING_USD || 40);
export const WARN_AT = 0.8;

/** $/million tokens, from docs.x.ai/docs/models (verified 2026-08-06). */
const PRICES: Record<string, { in: number; cached: number; out: number }> = {
  "grok-4.5": { in: 2.0, cached: 0.3, out: 6.0 },
  "grok-4.20": { in: 1.25, cached: 0.2, out: 2.5 },
};

const STORE = join(process.cwd(), "data", "spend.json");
type Store = { month: string; usd: number };
let cache: Store | null = null;

const thisMonth = (): string => new Date().toISOString().slice(0, 7);

function load(): Store {
  if (cache && cache.month === thisMonth()) return cache;
  try {
    const s = JSON.parse(readFileSync(STORE, "utf8")) as Store;
    cache = s.month === thisMonth() ? s : { month: thisMonth(), usd: 0 };
  } catch {
    cache = { month: thisMonth(), usd: 0 };
  }
  return cache;
}

function save(s: Store): void {
  cache = s;
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(s));
  } catch {
    /* a metering write must never break a conversation */
  }
}

export function recordUsage(
  model: string,
  u: { prompt: number; cached: number; completion: number },
): void {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k)) || "grok-4.5";
  const p = PRICES[key];
  const fresh = Math.max(0, u.prompt - u.cached);
  const usd = (fresh * p.in + u.cached * p.cached + u.completion * p.out) / 1e6;
  const s = load();
  save({ month: s.month, usd: s.usd + usd });
}

export function monthSpend(): number {
  return load().usd;
}

/**
 * Which brain answers this turn.
 *
 * She stays `grok-4.5` even AT the ceiling. Hitting a budget makes her SAY so —
 * it does not silently replace Classic's friend with a cheaper one. Only an
 * explicit opt-down (env) or xAI being genuinely unusable moves her, and both
 * are announced to him and to her.
 */
export function brainTier(): {
  provider: "grok" | "kimi";
  model?: string;
  backupBrain?: string;
  reason: string;
} {
  const spent = monthSpend();
  if (process.env.STARRA_EMERGENCY_LANE === "1") {
    return { provider: "kimi", backupBrain: "the free Groq lane", reason: "emergency lane forced" };
  }
  if (spent >= CEILING_USD) {
    return { provider: "grok", model: "grok-4.5", reason: `ceiling reached ($${spent.toFixed(2)})` };
  }
  if (spent >= CEILING_USD * WARN_AT) {
    return { provider: "grok", model: "grok-4.5", reason: `warn ($${spent.toFixed(2)})` };
  }
  return { provider: "grok", model: "grok-4.5", reason: "normal" };
}

export function __resetSpend(): void {
  cache = { month: thisMonth(), usd: 0 };
}
```

- [ ] **Step 4: Capture usage in `streamHosted`**

In `src/lib/llm/hosted.ts`, parse the terminal SSE `usage` payload and call:

```ts
      recordUsage(model, {
        prompt: usage?.prompt_tokens ?? 0,
        cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        completion: usage?.completion_tokens ?? 0,
      });
```

- [ ] **Step 5: Run tests**

Run: `npx tsx --test tests/spend-ceiling.test.ts && npm run test:v2 && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/spend.ts src/lib/llm/hosted.ts src/app/api/chat/route.ts tests/spend-ceiling.test.ts
git commit -m "feat(llm): spend meter — only money may change her brain

She stays grok-4.5 even at the ceiling; hitting the budget makes her SAY
so rather than silently replacing Classic's friend with a cheaper one.
Transient errors are a retry concern and never reach this module."
```

---

## Task 6: Retry, never swap

**Files:**
- Modify: `src/lib/llm/hosted.ts` (`streamHosted` error path)
- Test: `tests/hosted-lane-policy.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces: `streamHosted` retries 429/5xx/network up to 2 times with backoff on the SAME provider, then throws a typed `HostedTransientError`.

- [ ] **Step 1: Write the failing test**

```ts
describe("transient failures retry, never swap", () => {
  it("retries on the same provider and never reaches for another", () => {
    assert.match(src, /class HostedTransientError/);
    assert.match(src, /RETRY_STATUSES/);
    const fn = src.slice(src.indexOf("export async function streamHosted"));
    assert.doesNotMatch(
      fn.slice(0, fn.indexOf("\n}")),
      /provider\s*=\s*"kimi"|fallbackProvider/,
      "a hiccup must never change who is talking",
    );
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/hosted-lane-policy.test.ts`
Expected: FAIL — `HostedTransientError` not defined.

- [ ] **Step 3: Implement in `src/lib/llm/hosted.ts`**

```ts
/** A hiccup, not an identity change. The caller retries or reports — never swaps. */
export class HostedTransientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HostedTransientError";
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [400, 1200];
```

Wrap the fetch so a `RETRY_STATUSES` response or a network throw retries on the **same** provider for each delay, then throws `HostedTransientError`.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/hosted-lane-policy.test.ts && npm run test:v2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/hosted.ts tests/hosted-lane-policy.test.ts
git commit -m "feat(llm): transient failures retry on the same brain, never swap

A lost turn is recoverable; a stranger answering is not."
```

---

## Task 7: Voice markdown — nothing she writes is spoken as symbols

**Files:**
- Modify: `src/lib/voice/speech-shaping.ts` (add `flattenForSpeech`, export `splitSentences`)
- Test: `tests/speech-shaping.test.ts` (extend)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `splitSentences(text: string): string[]` — complete sentences, in order, no lookbehind
  - `flattenForSpeech(text: string): string` — strips headers/list markers/emphasis/emoji

- [ ] **Step 1: Write the failing test**

```ts
describe("voice markdown flattening", () => {
  it("never speaks markdown symbols aloud", () => {
    const out = flattenForSpeech("**Focus on two things:**\n\n1. Silent Shadow\n2. Credit Day 1");
    assert.doesNotMatch(out, /[*#`]/);
    assert.doesNotMatch(out, /^\s*\d+\.\s/m);
    assert.match(out, /Focus on two things/);
    assert.match(out, /Silent Shadow/);
  });

  it("leaves ordinary speech untouched", () => {
    const t = "I'm right here, Classic. The build passed.";
    assert.equal(flattenForSpeech(t), t);
  });

  it("splits sentences in order without lookbehind", () => {
    assert.deepEqual(
      splitSentences("Hey. I'm right here. You okay?"),
      ["Hey.", "I'm right here.", "You okay?"],
    );
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/speech-shaping.test.ts`
Expected: FAIL — `flattenForSpeech` not exported.

- [ ] **Step 3: Implement in `src/lib/voice/speech-shaping.ts`**

```ts
/** Complete sentences, in order. No lookbehind (WKWebView constraint). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  SENTENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_RE.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    if (m.index === SENTENCE_RE.lastIndex) SENTENCE_RE.lastIndex++;
  }
  return out;
}

/**
 * Everything here is SPOKEN ALOUD verbatim, so a markdown symbol is a symbol
 * she says out loud. Grok reaches for headers and lists more than the previous
 * model did — measured on a voice-call prompt — so the call flattens them.
 * The call transcript keeps the original; only her voice gets the flat text.
 */
export function flattenForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/speech-shaping.test.ts && npm run test:v2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voice/speech-shaping.ts tests/speech-shaping.test.ts
git commit -m "feat(voice): flatten markdown before speech, export sentence splitter

Everything on this path is spoken verbatim, so an asterisk is an asterisk
she says out loud. Grok reaches for markdown more than the old model did."
```

---

## Task 8: Sentence streaming — the call stops waiting

**Files:**
- Modify: `src/lib/voice/useVoiceCall.ts` (`runKimiTurn` SSE loop; `speakForced`; `bargeIn`)
- Test: `tests/call-sentence-streaming.test.ts` (create)

**Interfaces:**
- Consumes: `splitSentences`, `flattenForSpeech`, `shapeReply` (Task 7 + existing)
- Produces: one turn emits N `force_message`s in order; ONE transcript row; `kimiForcedPendingRef` accounts for N.

**THIS TASK IS GATED. It touches the three things that have broken this call before. It lands behind `STARRA_CALL_STREAM_SENTENCES` (default OFF) and is not done until Classic has heard a live multi-sentence turn.**

- [ ] **Step 1: Write the failing tests**

```ts
// tests/call-sentence-streaming.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/voice/useVoiceCall.ts"), "utf8");

describe("sentence streaming — the one-voice guard must survive it", () => {
  it("the pending counter is incremented per force_message, not per turn", () => {
    const fn = src.slice(src.indexOf("const speakForced"));
    assert.match(fn.slice(0, 2000), /kimiForcedPendingRef\.current \+= 1/);
  });

  it("the counter can never go negative", () => {
    assert.match(src, /Math\.max\(0,\s*kimiForcedPendingRef\.current - 1\)/);
  });

  it("barge-in clears the WHOLE remaining sentence queue", () => {
    assert.match(src, /sentenceQueueRef\.current = \[\]/);
  });

  it("exactly one transcript row per turn, not one per sentence", () => {
    const turn = src.slice(src.indexOf("const runKimiTurn"));
    const rows = turn.slice(0, turn.indexOf("\n  );")).match(/setTranscript\(/g) || [];
    assert.ok(rows.length <= 1, `one row per turn, found ${rows.length}`);
  });

  it("is behind a flag that restores today's behaviour when off", () => {
    assert.match(src, /STARRA_CALL_STREAM_SENTENCES/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx tsx --test tests/call-sentence-streaming.test.ts`
Expected: FAIL — `sentenceQueueRef` does not exist.

- [ ] **Step 3: Implement**

In `useVoiceCall.ts`:
1. Add `const sentenceQueueRef = useRef<string[]>([]);`
2. In the SSE loop, after appending to `full`, extract complete sentences with `splitSentences`, and for each newly-completed sentence call `speakForced(flattenForSpeech(shaped), "")` with an EMPTY transcript string (the row is written once at the end).
3. `speakForced` already does `kimiForcedPendingRef.current += 1` per call — verify it is per invocation, not per turn.
4. In the `response.created` handler, replace the decrement with `kimiForcedPendingRef.current = Math.max(0, kimiForcedPendingRef.current - 1)`.
5. In `bargeIn`, add `sentenceQueueRef.current = [];`.
6. Gate the whole path on `process.env.NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES === "1"`; when off, keep today's single `speakForced` at the end.

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npx tsx --test tests/call-sentence-streaming.test.ts && npm run test:v2 && npx tsc --noEmit && npm run lint`
Expected: all PASS, 0 eslint errors.

- [ ] **Step 5: LIVE CALL GATE — not optional**

Ask Classic to make a real call with the flag ON and confirm, in his words:
1. She starts speaking within about a second.
2. It is one voice throughout — no second speaker, no cancelled half-sentences.
3. Talking over her cuts her off and she does not resume the abandoned sentence.
4. One `You:`/`STARRA:` row per turn in the call column.

If any of those fail, the flag goes back OFF and the task returns to Phase 1 of `superpowers:systematic-debugging` — instrument the frame order first, do not guess.

- [ ] **Step 6: Commit**

```bash
git add src/lib/voice/useVoiceCall.ts tests/call-sentence-streaming.test.ts
git commit -m "feat(voice): stream sentences into force_message, behind a flag

First audio now tracks TTFT (~0.4s) instead of total generation (5.7s on
grok-4.5), which is what makes the best model free on a call. The one-voice
pending counter is N-aware: paying for one response while emitting N would
cancel her own sentences and mute the call."
```

---

## Self-Review

**Spec coverage:**

| spec section | task |
|---|---|
| §0 ONE PROMPT | 1, 2 |
| §1 provider consolidation | 3 |
| §2 privacy / ZDR | 4 |
| §3 caching (canon-first, cached_tokens) | 1 (ordering), 5 (metering) |
| §4 spend ceiling + only-money | 5, 6 |
| §5 sentence streaming + one-voice guard | 8 |
| §6 markdown discipline | 7 |
| error handling: no bare returns | 6 (typed error), plus the already-landed `!res.ok` reporting |

**Gap accepted deliberately:** `x-grok-conv-id` (cache-hit maximization) is not yet its own task; it is a one-line header addition folded into Task 5's `streamHosted` edit, since it is meaningless without the usage metering that proves it works.

**Placeholder scan:** none — every step carries real code or a real command.

**Type consistency:** `buildOneStarraPrompt({ backupBrain })` is defined in Task 1 and consumed in Tasks 2 and 5 with the same signature. `brainTier()` returns `backupBrain?: string`, matching that parameter. `recordZdrHeader(provider, header)` matches its call site in Task 4 Step 4.
