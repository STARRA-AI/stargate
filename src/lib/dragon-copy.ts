/**
 * DRAGON COPY — the lane that puts a leaderboard copy-trade THROUGH Dragon
 * Tradar instead of around it.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `src/lib/copy-loop.ts:261` calls `kalshi.placeOrder` directly. That signs an
 * order with Classic's RSA key and sends it straight to Kalshi, which means the
 * copy loop bypasses his own bot entirely: Dragon Tradar's "Agent trading
 * enabled" toggle, its `maxOrderNotionalUsd`, its `AGENT_LIVE_TRADING_ENABLED`
 * flag and its daily loss floor all sit on the other side of a door the copy
 * loop never walks through. Classic asked for copy-trading to run THROUGH
 * Dragon Tradar. This module is that door.
 *
 * It does not edit `copy-loop.ts`. It exports the function that file will call.
 *
 * ── WHAT IS VERIFIED, AND WHAT IS NOT ────────────────────────────────────────
 * VERIFIED live 2026-10-04 by direct GET against https://dragontradar.com:
 *   GET /api/agent/v1/stats     -> 200 {"connected":true,"balanceCents":4240,"positions":[]}
 *   GET /api/agent/v1/bot/state -> 200 running=false category="sports" mode="paper"
 *                                     config{minBetCents:1000, autoFire:true, ...}
 *   GET /api/agent/v1/config    -> 200 (same config object)
 *
 * NOT VERIFIED: the WRITE lane. `GET /order`, `/bot/engage`, `/copy/scan` and
 * `/copy/state` all answer `404 "Cannot GET /api/..."`, and Express answers a
 * POST-only route with exactly that string — so the 404s are not evidence the
 * POST routes are missing, and they are not evidence they exist either. Nothing
 * here has ever successfully POSTed to his app. `submitCopyBatch` therefore
 * defaults to `live: false` and makes ZERO network calls in that mode.
 *
 * ── THE LOCKOUT, RESTATED BECAUSE IT COSTS HIM HIS BOT ───────────────────────
 * ONE request with a bad token flips his API to `429 temporarily_blocked` and
 * locks Classic out of his own trading bot. Every call below goes through
 * `dragon-tradar.ts`'s single `agentRequest` core, which makes exactly one
 * attempt and never retries. On top of that, `submitCopyBatch` STOPS THE WHOLE
 * BATCH on the first 429/401/403 rather than walking the rest of the list into
 * the same wall.
 *
 * ── THE SIZING PROBLEM, IN HIS ACTUAL NUMBERS ────────────────────────────────
 * Balance $42.40. Dragon Tradar's own `minBetCents` is 1000 ($10). So his
 * bankroll is FOUR minimum-size bets wide. A per-ORDER ceiling alone cannot
 * protect that: four individually-legal $10 orders in one scan is the whole
 * account. Hence `perScanCents` — a ceiling on the TOTAL notional one scan may
 * commit — which is the cap that actually matters at this balance.
 */
import {
  type CopyIntent,
  type CopyRejection,
  type Role,
  type Venue,
} from "./copy-contracts";
import {
  buildOrder,
  notionalCents,
  placeOrder,
  type BuiltOrder,
  type OrderRejection,
  type OrderRequest,
} from "./dragon-orders";
import {
  readBotState,
  type AgentDeps,
  type AgentOrder,
  type AgentResult,
} from "./dragon-tradar";
// ★ ONE SOURCE OF TRUTH for the two switches that used to disagree. The scan
//   layer's defaults are READ here instead of being re-stated, so a flip there
//   cannot leave this file quietly holding the opposite value. See
//   `allowMakerFills` and `minConfidence` below, and the agreement test in
//   tests/dragon-copy.test.ts.
import { DEFAULT_SIGNAL_CONFIG } from "./copy-signals";

/* ── CEILINGS ────────────────────────────────────────────────────────────────
 * Four numbers, each one a ceiling and never a target. Any of them can only
 * ever make an order smaller.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * $100 — the deck's own per-order ceiling default. Same number and same
 * fallback rule as `readOrderCeilingCents` in
 * `src/app/api/dragon/order/route.ts:33-41`. It is re-read here rather than
 * imported because that file is a Next route module (it exports `runtime` and
 * pulls in the feed); a lib must not import a route to learn a number.
 */
export const COPY_DECK_CEILING_DEFAULT_CENTS = 10_000;

/**
 * $20 — the copy lane's OWN ceiling, deliberately far tighter than the deck's.
 * A copy-trade is a bet on a stranger's judgment that was observed after the
 * fact; it does not get the same room as an order Classic asked for by name.
 */
export const COPY_LANE_DEFAULT_CENTS = 2_000;

/**
 * Half. The most of a measured balance one scan may put at risk.
 *
 * At the measured $42.40 this makes the scan budget $21.20, which the lane
 * ceiling then tightens to $20 — i.e. two $10 bets. The point is not the exact
 * fraction, it is that a single scan can never spend the account. Tighten it
 * per call through `caller.perScanCents`.
 */
export const COPY_SCAN_BANKROLL_FRACTION = 0.5;

/**
 * 4 — how many copy positions may be open at once by default.
 *
 * Derived, not guessed: the measured balance (4240c) divided by Dragon Tradar's
 * own measured `minBetCents` (1000c) is exactly 4, so 4 is the number of
 * minimum-size positions this bankroll can actually carry. It is a KNOB — when
 * the balance changes, this number is wrong and the caller should tighten it.
 */
export const COPY_MAX_OPEN_DEFAULT = 4;

/** The only mode this lane trades under unless a caller explicitly opts in. */
export const COPY_DEFAULT_ACCEPTED_MODES: readonly string[] = ["paper"];

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(n) || n <= 0 ? fallback : n;
}

/** `DRAGON_MAX_ORDER_NOTIONAL_CENTS`. Nonsense falls back to the default, never to "no limit". */
export function readDeckCeilingCents(
  env: Record<string, string | undefined> = process.env,
): number {
  return readPositiveIntEnv(env.DRAGON_MAX_ORDER_NOTIONAL_CENTS, COPY_DECK_CEILING_DEFAULT_CENTS);
}

/** `DRAGON_COPY_MAX_NOTIONAL_CENTS` — new, copy-lane only. Same fallback rule. */
export function readCopyLaneCeilingCents(
  env: Record<string, string | undefined> = process.env,
): number {
  return readPositiveIntEnv(env.DRAGON_COPY_MAX_NOTIONAL_CENTS, COPY_LANE_DEFAULT_CENTS);
}

/** Every limit that applies to one scan. */
export type CopyCaps = {
  /** Notional ceiling for ONE order, in cents. */
  perOrderCents: number;
  /** Notional ceiling for the WHOLE scan, in cents. The one that matters at $42.40. */
  perScanCents: number;
  /** How many copy positions may be open at once, counting the ones already open. */
  maxOpenCopies: number;
  /**
   * Whether a fill our trader made as the MAKER may be mirrored.
   *
   * ★ DEFAULT FALSE — and it is false because `copy-signals`' own switch is
   *   false. These two are the same decision and they used to disagree:
   *   `DEFAULT_SIGNAL_CONFIG.includeMakerFills` was FALSE while this resolved to
   *   `caller?.allowMakerFills !== false`, i.e. TRUE unless someone said
   *   otherwise. Worse, the runnable entry point (`runCopyLane`, and through it
   *   `scripts/starra-copy-scan.ts`) passes no caller at all, so the lane Classic
   *   actually runs took the permissive value. Two safety switches that disagree
   *   means one of them is a lie; this one was.
   *
   * The argument for allowing them, kept because it is half right: this lane never
   * sends a market order — `dragon-orders.BuiltOrder` always carries `priceCents`
   * — so what goes out is a LIMIT at the price the maker was filled at. What that
   * argument misses is WHERE a maker's edge lives: in having been FIRST in the
   * queue at that price, before the move. A limit posted after the fact has no
   * queue position and the book has already traded through it, so the mirror
   * either rests unfilled or fills exactly when it is wrong. Collecting a spread
   * and paying to chase one are not the same trade at the same number.
   *
   * It costs a lot of signal and that is deliberate: of the two visible top-100
   * Kalshi traders, 77/100 and 91/100 of their readable rows are maker fills
   * (measured 2026-10-04). Refusing them is most of the tape. A caller that wants
   * it anyway passes `allowMakerFills: true` EXPLICITLY — the same deliberate
   * opt-in as `includeMakerFills`, not a default.
   */
  allowMakerFills: boolean;
  /**
   * Lowest `CopyIntent.confidence` this lane will send, 0..1.
   *
   * ★ Defaults to `DEFAULT_SIGNAL_CONFIG.minConfidence` (0.25), so the scan layer
   *   and the routing layer enforce ONE number. This is the belt to that file's
   *   braces: an intent handed straight to `planCopyBatch` never passed through
   *   `kalshiFillsToIntents`, so without a floor here the scan layer's floor is
   *   skippable by construction.
   *
   * A caller may only RAISE it. Lowering a floor is loosening a safety cap, which
   * nothing in this file allows.
   */
  minConfidence: number;
  /**
   * His bot's own minimum bet, in cents, when it is known.
   *
   * 0 means "not supplied, do not gate on it" — this lane never invents a floor
   * it did not read. Supply it from his app's own `minBetCents`
   * (GET /api/agent/v1/config or /bot/state), never from a guess.
   * See the `below_bot_min_bet` rejection for why under-minimum orders are
   * refused locally instead of being tried.
   */
  minBetCents: number;
};

export type CapsInput = {
  /** What the caller asked for. Every field may only TIGHTEN. */
  caller?: Partial<CopyCaps>;
  env?: Record<string, string | undefined>;
  /** `balanceCents` from GET /stats. Omitted = unknown, which is NOT zero. */
  balanceCents?: number;
  /**
   * His bot's own `minBetCents`, as READ from GET /api/agent/v1/config or
   * /bot/state. Omit it when it has not been read — this lane never guesses a
   * minimum, and 0 means "do not gate on it".
   */
  botMinBetCents?: number;
};

/** A caller may tighten a notional ceiling. It may never loosen one. */
function tightenCents(ceiling: number, requested: unknown): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, ceiling)
    : ceiling;
}

/**
 * A caller may RAISE a confidence floor. It may never lower one — that is the
 * same one-way rule as the cents ceilings, pointed the other direction because a
 * bigger number is the tighter one here.
 */
function raiseConfidence(floor: number, requested: unknown): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > floor
    ? requested
    : floor;
}

/**
 * Same rule for a count, with one deliberate difference: 0 is ACCEPTED here.
 * A notional ceiling of 0 is "no usable ceiling" and `buildOrder` refuses it,
 * but 0 open copies is a caller saying "open nothing new", which is the
 * tightest legal instruction and must be honoured.
 */
function tightenCount(ceiling: number, requested: unknown): number {
  return typeof requested === "number" && Number.isInteger(requested) && requested >= 0
    ? Math.min(requested, ceiling)
    : ceiling;
}

/**
 * The tightest of: the deck ceiling, the copy-lane ceiling, the bankroll
 * fraction, and whatever the caller asked for.
 *
 * ONE-WAY BY CONSTRUCTION. Every combination is a `Math.min`, so there is no
 * input — env, caller, or balance — that can make any cap larger than the
 * ceilings above it. A caller passing `perOrderCents: 1_000_000` gets the
 * ceiling, not the request, and that is asserted in the tests.
 */
export function resolveCaps(input: CapsInput = {}): CopyCaps {
  const env = input.env ?? process.env;
  const deck = readDeckCeilingCents(env);
  const lane = readCopyLaneCeilingCents(env);

  // The copy lane can never beat the deck's own per-order ceiling.
  let perOrderCents = Math.min(lane, deck);
  let perScanCents = Math.min(lane, deck);

  // A measured balance tightens the SCAN budget, not the per-order one: the
  // thing to prevent is a scan spending the account, one legal order at a time.
  if (typeof input.balanceCents === "number" && Number.isFinite(input.balanceCents)) {
    const bankroll = Math.max(0, Math.floor(input.balanceCents * COPY_SCAN_BANKROLL_FRACTION));
    perScanCents = Math.min(perScanCents, bankroll);
  }

  perScanCents = tightenCents(perScanCents, input.caller?.perScanCents);
  perOrderCents = tightenCents(perOrderCents, input.caller?.perOrderCents);
  // One order can never be allowed to eat more than the whole scan may commit.
  perOrderCents = Math.min(perOrderCents, perScanCents);

  return {
    perOrderCents,
    perScanCents,
    maxOpenCopies: tightenCount(COPY_MAX_OPEN_DEFAULT, input.caller?.maxOpenCopies),
    // ★ EXPLICIT OPT-IN, and the default is READ from the scan layer rather than
    //   restated, so the two cannot drift to opposite values again. `undefined`
    //   — which is what every current caller passes — now means REFUSE.
    allowMakerFills: input.caller?.allowMakerFills ?? DEFAULT_SIGNAL_CONFIG.includeMakerFills,
    // A caller may only RAISE the floor; a lower number is ignored.
    minConfidence: raiseConfidence(DEFAULT_SIGNAL_CONFIG.minConfidence, input.caller?.minConfidence),
    // ★ Read from his app, never invented. 0 = unknown = do not gate.
    //   A caller may only RAISE it, like every other floor here.
    minBetCents: Math.max(
      0,
      Math.floor(input.botMinBetCents ?? 0),
      Math.floor(input.caller?.minBetCents ?? 0),
    ),
  };
}

/* ── REJECTIONS ──────────────────────────────────────────────────────────────
 * `copy-contracts.CopyRejection` is FROZEN and names the reasons a candidate is
 * dropped while SCANNING. It has no reason for "this order is bigger than the
 * cap", because capping is this file's job, not the scanner's.
 *
 * Reusing a scan reason for a cap breach would put a false label on a money
 * surface — `price_out_of_band` on an order that was refused for being too
 * large sends Classic to look at the price. So the vocabulary is EXTENDED here
 * rather than borrowed: `RouteRejection` is a strict superset of
 * `CopyRejection`, so a scan rejection is still assignable to a route
 * rejection and the two lists merge without a cast. Nothing in the frozen file
 * changed.
 *
 * Where a frozen reason fits EXACTLY it is reused: a price outside 1..99 really
 * is `price_out_of_band`, and a non-positive count really is `below_min_count`.
 * ──────────────────────────────────────────────────────────────────────────── */
export type RouteRejection =
  | CopyRejection
  /** The intent carries no Kalshi ticker, so there is nothing to send. */
  | "no_ticker"
  /** Structurally invalid: ticker, side or action. `detail` carries buildOrder's own reason. */
  | "malformed_order"
  /** Over the per-ORDER ceiling. Slice it; `detail` says what count fits. */
  | "exceeds_per_order_cap"
  /** Same brake on an EXIT, named apart so it is never read as a blocked entry. */
  | "exceeds_per_order_cap_exit"
  /** Individually legal, but it would push the scan past its total budget. */
  | "exceeds_scan_budget"
  /** Already at the open-copy limit. */
  | "max_open_copies"
  /** The resolved cap collapsed to zero or worse — refuse, never treat as unlimited. */
  | "no_usable_cap"
  /**
   * Under `caps.minConfidence`. Named EXACTLY here rather than borrowed:
   * copy-signals has to report its own floor as `trader_not_persistent` because
   * the frozen contract has no better word, but this file's vocabulary is a
   * superset it is allowed to extend, so the money surface gets the true label.
   */
  | "below_min_confidence"
  /**
   * Smaller than his BOT's own configured minimum bet.
   *
   * ★ WHY THIS IS REFUSED LOCALLY RATHER THAN DISCOVERED. His app reports
   *   `minBetCents` (1000c = $10.00, read live 2026-10-04 from
   *   GET /api/agent/v1/config). A real scan the same day produced exactly one
   *   sendable order worth 190c — $1.90, well under that floor. What his app does
   *   with an under-minimum order is UNVERIFIED and there are only two
   *   possibilities, both bad to learn by POSTing: it refuses, and the lane is
   *   quietly dead; or it SIZES THE ORDER UP to its minimum, which at 190c
   *   intended is a 5.3x position he never asked for. Refusing here costs a
   *   missed copy and settles nothing by experiment on a live account.
   */
  | "below_bot_min_bet";

export type RouteRejected = { reason: RouteRejection; detail: string };

/** Who and why, kept beside the order so the ops feed can explain a position. */
export type CopyProvenance = {
  clientOrderId: string;
  intentKey: string;
  venue: Venue;
  sourceTrader: string;
  role: Role;
  confidence: number;
  why: string;
  notionalCents: number;
};

/** The world as the plan saw it. Injected, so planning is deterministic. */
export type CopyPlanState = {
  /** Copy positions already open. From GET /stats `positions`, counted by the caller. */
  openCopies: number;
  /** The clock. Injected because `clientOrderId` is a hash of (intent, second). */
  nowMs: number;
  /** `intentKey`s acted on in an EARLIER scan. Persisted by the caller, not here. */
  alreadyActed?: readonly string[];
};

export type CopyPlan = {
  /** Exactly the bodies `POST /order` takes, in send order. */
  accepted: BuiltOrder[];
  /** Every drop, named. Never a silent truncation. */
  rejected: RouteRejected[];
  /** Sum of `count * priceCents` over `accepted`. */
  committedCents: number;
  /** Keyed by `clientOrderId` — no index-alignment to get wrong. */
  provenance: Record<string, CopyProvenance>;
  /** The caps that actually applied, so a log can show what was enforced. */
  caps: CopyCaps;
  /**
   * The clock the plan was built with. `submitCopyBatch` re-uses it so the
   * `clientOrderId` minted at PLAN time is the one that reaches his app — which
   * is the whole point of the idempotency key.
   */
  nowMs: number;
};

/**
 * The cross-scan identity of a copy signal: who, where, which market, which
 * direction. Deliberately NOT price or count — the same trader buying the same
 * side of the same market again is the same bet, slightly later, and firing on
 * it twice is how one signal becomes two positions.
 */
export function intentKey(intent: CopyIntent): string {
  return [
    intent.venue,
    intent.sourceTrader,
    intent.ticker ?? "-",
    intent.side,
    intent.action,
  ].join("|");
}

/**
 * Map a venue-neutral `CopyIntent` onto `dragon-orders`' `OrderRequest`.
 *
 * It does NOT re-validate side, action, count or price — `buildOrder` owns
 * every one of those checks and duplicating them here would mean two places to
 * keep in step. The only thing checked here is the one thing `buildOrder`
 * cannot see: a CopyIntent is allowed to carry `ticker: null` (a Polymarket
 * signal not yet matched to Kalshi), and Dragon Tradar executes on Kalshi only.
 *
 * `role` is NOT consulted. By the time an intent reaches this lane the
 * maker/taker flip has already been resolved by the scanner — see the note on
 * `copy-contracts.Role:23-32` — so `side` and `action` here describe what the
 * OBSERVED TRADER did, and they are passed through verbatim.
 */
export function intentToOrderRequest(
  intent: CopyIntent,
  caps: CopyCaps,
): { ok: true; request: OrderRequest } | { ok: false; reason: RouteRejection; detail: string } {
  if (typeof intent.ticker !== "string" || intent.ticker.trim() === "") {
    return {
      ok: false,
      reason: "no_ticker",
      detail: `${intent.venue} signal from ${intent.sourceTrader} has no Kalshi ticker — Dragon Tradar executes on Kalshi only, so copy-match must resolve one first`,
    };
  }
  // ★ HIS BOT'S OWN MINIMUM BET. Only gated when it was actually READ (0 = unknown).
  //   An ENTRY under his app's floor is refused here rather than POSTed to find
  //   out: either it is rejected and the lane is quietly dead, or his app sizes it
  //   UP to the minimum and he holds a position several times what was intended.
  //   A real scan on 2026-10-04 produced exactly one sendable order at 190c
  //   against a 1000c configured minimum, so this is the common case, not an edge.
  //   EXITS are exempt — refusing to close a position you already hold because the
  //   remainder is small would strand it.
  if (caps.minBetCents > 0 && intent.action === "buy") {
    const notional = intent.count * intent.priceCents;
    if (notional < caps.minBetCents) {
      const need = Math.ceil(caps.minBetCents / Math.max(1, intent.priceCents));
      return {
        ok: false,
        reason: "below_bot_min_bet",
        detail:
          `${intent.ticker} ${intent.action} ${intent.count}x ${intent.side} @${intent.priceCents}c is ${notional}c, ` +
          `under his bot's own ${caps.minBetCents}c minimum bet — ${need} contracts would clear it. ` +
          `NOT sent: an under-minimum order is either refused or silently sized UP, and which one is UNVERIFIED.`,
      };
    }
  }
  return {
    ok: true,
    request: {
      ticker: intent.ticker,
      side: intent.side,
      action: intent.action,
      count: intent.count,
      priceCents: intent.priceCents,
      maxNotionalCents: caps.perOrderCents,
    },
  };
}

/** Translate `buildOrder`'s refusal into this lane's vocabulary, keeping its own reason in `detail`. */
function fromBuildRejection(
  reason: OrderRejection,
  intent: CopyIntent,
  caps: CopyCaps,
): RouteRejected {
  const who = `${intent.ticker ?? "-"} ${intent.action} ${intent.count}x ${intent.side} @${intent.priceCents}c`;
  switch (reason) {
    case "exceeds_local_max_notional":
    case "exceeds_local_max_notional_exit": {
      const fits =
        Number.isInteger(intent.priceCents) && intent.priceCents > 0
          ? Math.floor(caps.perOrderCents / intent.priceCents)
          : 0;
      return {
        reason:
          reason === "exceeds_local_max_notional_exit"
            ? "exceeds_per_order_cap_exit"
            : "exceeds_per_order_cap",
        detail: `${who} is ${intent.count * intent.priceCents}c, over the ${caps.perOrderCents}c per-order cap — ${fits} contracts fit, so slice it (buildOrder: ${reason})`,
      };
    }
    case "bad_max_notional":
      return { reason: "no_usable_cap", detail: `${who} — resolved cap was ${caps.perOrderCents}c (buildOrder: ${reason})` };
    case "bad_price":
      // The frozen scan reason fits this exactly: Kalshi prices are 1..99.
      return { reason: "price_out_of_band", detail: `${who} — price must be a whole 1-99c (buildOrder: ${reason})` };
    case "bad_count":
      return { reason: "below_min_count", detail: `${who} — count must be a positive integer (buildOrder: ${reason})` };
    default:
      return { reason: "malformed_order", detail: `${who} (buildOrder: ${reason})` };
  }
}

/**
 * Turn intents into orders. PURE: no network, no clock, no filesystem, no
 * mutation of anything passed in. Same inputs twice gives deep-equal outputs,
 * which the tests assert, because this is the function a human has to be able
 * to re-run and reason about before any money moves.
 *
 * TWO LAYERS OF IDEMPOTENCY, both needed:
 *   - ON `intentKey` — the same directional bet from the same trader fires once,
 *     ever: across scans via `state.alreadyActed`, and within this scan via a
 *     second set, so the rule does not change meaning depending on which scan a
 *     repeat happens to land in.
 *   - ON `clientOrderId` — two intents from DIFFERENT traders that would produce the
 *     byte-identical order collapse to one. That happens for real: two
 *     different traders buying the same side of the same market at the same
 *     price is a STRONGER signal, not a reason to take the position twice. His
 *     app would answer the second one `duplicate: true` anyway; this refuses to
 *     send it at all.
 *
 * THE SCAN BUDGET DOES NOT `break`. An order that would overrun the budget is
 * rejected and the loop CONTINUES, because a cheaper candidate behind an
 * expensive one is still affordable and still legal. Every blocked one is named.
 */
export function planCopyBatch(
  intents: readonly CopyIntent[],
  caps: CopyCaps,
  state: CopyPlanState,
): CopyPlan {
  const accepted: BuiltOrder[] = [];
  const rejected: RouteRejected[] = [];
  const provenance: Record<string, CopyProvenance> = {};
  const acted = new Set<string>(state.alreadyActed ?? []);
  const seenKeys = new Set<string>();
  const seenOrders = new Set<string>();
  let committedCents = 0;
  let open = state.openCopies;

  for (const intent of intents) {
    const key = intentKey(intent);

    if (acted.has(key)) {
      rejected.push({ reason: "duplicate_intent", detail: `${key} was already acted on in an earlier scan` });
      continue;
    }
    if (seenKeys.has(key)) {
      rejected.push({ reason: "duplicate_intent", detail: `${key} appears more than once in this scan` });
      continue;
    }
    if (!caps.allowMakerFills && intent.role === "maker") {
      rejected.push({
        reason: "maker_fill_unmirrorable",
        detail: `${key} was a MAKER fill — they collected the spread and a chasing limit does not; allowMakerFills is ${caps.allowMakerFills} (DEFAULT REFUSE — pass allowMakerFills:true to copy it anyway)`,
      });
      continue;
    }
    // Before any sizing: a signal we do not believe is not made sendable by
    // being small. Printed-but-unenforced confidence was the whole defect.
    if (!(intent.confidence >= caps.minConfidence)) {
      rejected.push({
        reason: "below_min_confidence",
        detail: `${key} scored ${intent.confidence}, floor is ${caps.minConfidence}`,
      });
      continue;
    }
    if (open >= caps.maxOpenCopies) {
      rejected.push({ reason: "max_open_copies", detail: `${key} — ${open} copies open, cap is ${caps.maxOpenCopies}` });
      continue;
    }

    const mapped = intentToOrderRequest(intent, caps);
    if (!mapped.ok) {
      rejected.push({ reason: mapped.reason, detail: mapped.detail });
      continue;
    }

    const built = buildOrder(mapped.request, state.nowMs);
    if (!built.ok) {
      rejected.push(fromBuildRejection(built.reason, intent, caps));
      continue;
    }
    if (seenOrders.has(built.order.clientOrderId)) {
      rejected.push({
        reason: "duplicate_intent",
        detail: `${key} builds the byte-identical order as an earlier intent in this same scan (${built.order.clientOrderId})`,
      });
      continue;
    }

    const n = notionalCents(built.order);
    if (committedCents + n > caps.perScanCents) {
      rejected.push({
        reason: "exceeds_scan_budget",
        detail: `${key} needs ${n}c, scan has committed ${committedCents}c of ${caps.perScanCents}c`,
      });
      continue;
    }

    seenKeys.add(key);
    seenOrders.add(built.order.clientOrderId);
    accepted.push(built.order);
    provenance[built.order.clientOrderId] = {
      clientOrderId: built.order.clientOrderId,
      intentKey: key,
      venue: intent.venue,
      sourceTrader: intent.sourceTrader,
      role: intent.role,
      confidence: intent.confidence,
      why: intent.why,
      notionalCents: n,
    };
    committedCents += n;
    open += 1;
  }

  return { accepted, rejected, committedCents, provenance, caps, nowMs: state.nowMs };
}

/* ── THE MODE GUARD ──────────────────────────────────────────────────────────
 * Read his bot's mode. Never set it.
 * ──────────────────────────────────────────────────────────────────────────── */

export type GuardResult =
  | { ok: true; mode: string }
  | {
      ok: false;
      code: "mode_not_accepted" | "bot_state_unreadable";
      mode?: string;
      detail: string;
    };

/**
 * GET /bot/state, then check the mode against a list the caller declared.
 *
 * Default accepted list is `["paper"]` — measured mode on 2026-10-04 was
 * "paper", so the normal path is allowed and going live is an explicit opt-in
 * nobody can arrive at by accident.
 *
 * FAILS CLOSED. An unreadable `/bot/state` is a refusal, not a shrug: if this
 * lane cannot tell whether it is about to trade paper or real money, it does
 * not trade. One attempt, no retry — `readBotState` goes through
 * `dragon-tradar.agentRequest` and a bad token locks him out.
 *
 * It only READS. Nothing in this file can change his mode, and that is on
 * purpose: `autoFire` was measured TRUE on 2026-10-04, so a flip to live mode
 * would fire without a human in the way. Flagged, not touched.
 */
export async function assertCopyModeAllowed(
  deps: AgentDeps = {},
  acceptModes: readonly string[] = COPY_DEFAULT_ACCEPTED_MODES,
): Promise<GuardResult> {
  const r = await readBotState(deps);
  if (r.state !== "ok") {
    const extra = r.state === "error" ? ` status=${r.status}${r.code ? ` code=${r.code}` : ""}` : "";
    return {
      ok: false,
      code: "bot_state_unreadable",
      detail: `GET /bot/state came back ${r.state}${extra} — refusing to trade a mode I cannot read`,
    };
  }
  const mode = typeof r.stats.mode === "string" ? r.stats.mode : "";
  if (!acceptModes.includes(mode)) {
    return {
      ok: false,
      code: "mode_not_accepted",
      mode,
      detail: `bot mode is "${mode}"; this lane accepts [${acceptModes.join(", ")}] and was not opted in`,
    };
  }
  return { ok: true, mode };
}

/* ── SUBMIT ──────────────────────────────────────────────────────────────── */

export type UnsentReason =
  /** An earlier order in this batch came back 429/401/403 or no-token. */
  | "batch_halted"
  /** `live: true` with no passing mode clearance. Structurally impossible to bypass. */
  | "no_mode_clearance";

export type SubmitOutcome = {
  clientOrderId: string;
  notionalCents: number;
  /** Exactly the JSON body that was, or would have been, POSTed to /order. */
  body: BuiltOrder;
} & (
  | { disposition: "would_send" }
  | { disposition: "sent"; result: AgentResult<AgentOrder> }
  | { disposition: "unsent"; reason: UnsentReason }
);

export type SubmitReport = {
  live: boolean;
  outcomes: SubmitOutcome[];
  /** How many actually went out. 0 in dry run, always. */
  sentCount: number;
  /** The order that stopped the batch, if one did. */
  haltedOn: { clientOrderId: string; state: string; code?: string } | null;
  /** Notional of the orders that were actually sent (dry run: 0). */
  sentCents: number;
  /** Notional the plan committed, sent or not. */
  plannedCents: number;
};

export type SubmitOptions = {
  /** FALSE BY DEFAULT. Dry run makes zero network calls. */
  live?: boolean;
  deps?: AgentDeps;
  /**
   * The passing `GuardResult` from `assertCopyModeAllowed`. Required for
   * `live: true` — not as politeness, as structure: without it every order is
   * reported `unsent` and no fetch happens, so there is no code path that
   * reaches his order endpoint without having read his bot's mode first.
   */
  clearance?: GuardResult;
};

/** An order's POST body plus the ceiling it was built under. */
function requestFor(order: BuiltOrder, caps: CopyCaps): OrderRequest {
  return {
    ticker: order.ticker,
    side: order.side,
    action: order.action,
    count: order.count,
    priceCents: order.priceCents,
    maxNotionalCents: caps.perOrderCents,
  };
}

/**
 * A result that must stop the whole batch.
 *
 *   blocked  (429) the lockout. Walking the rest of the list deepens it.
 *   rejected (401/403) the token. Every remaining order gets the same answer.
 *   off      no token configured. Nothing will send; stop pretending.
 *
 * A plain `error` (500, or status 0 for a timeout) does NOT halt: it is about
 * that one order, and the orders behind it are different orders. The honest
 * residual risk is a status-0 timeout — the order may have landed and we cannot
 * know. The `clientOrderId` is what makes that non-catastrophic, and the server
 * store is the actual guarantee, not this.
 */
/**
 * Does this result mean STOP THE WHOLE PASS, not just skip this order?
 *
 * `blocked` (429 lockout), `rejected` (401/403 token) and `off` are global by
 * nature — the next order cannot fare better.
 *
 * ★ SO ARE THESE, and they used to fall through: a condition that is true of the
 *   ACCOUNT rather than of the order means every remaining order gets the same
 *   answer, and continuing just POSTs at an app that has already said no.
 *     423 daily_loss_floor_reached   — the floor is a day-level brake. Walking
 *         the rest of the batch is the exact thing a loss floor exists to stop.
 *     409 agent_trading_disabled / live_trading_disabled — he flipped the switch
 *         off, or the server env is not armed. Nothing in this pass will change it.
 *   422 is NOT here: `order_exceeds_max_notional` / `insufficient_balance` are
 *   facts about THIS order's size, and a smaller order behind it can legitimately
 *   still fill. 400 is not here either — a malformed body is per-order.
 *   Status map: docs/handoff/dragon-tradar-agent-router/README.md.
 */
function haltsBatch(r: AgentResult<AgentOrder>): boolean {
  if (r.state === "blocked" || r.state === "rejected" || r.state === "off") return true;
  if (r.state !== "error") return false;
  if (r.status === 423) return true;
  if (r.status === 409) return true;
  return false;
}

/**
 * Send the plan, or report exactly what it WOULD have sent.
 *
 * `live` defaults to false and dry run performs ZERO network calls — asserted
 * by call count in the tests, not by reading the code.
 *
 * Live sends SEQUENTIALLY, one attempt per order, and stops the batch on the
 * first ACCOUNT-LEVEL refusal — 429 lockout, 401/403 token, 423 daily loss floor,
 * 409 trading disabled (see haltsBatch). A 422 size refusal or a 400 does NOT
 * halt: those are facts about one order, and a smaller order behind it can still
 * legitimately fill. The orders behind a halt are reported `unsent`, which is
 * a different fact from "failed" and must stay a different word: unsent means
 * nothing was attempted and nothing can have landed.
 *
 * `plan.nowMs` is reused, so the `clientOrderId` his app receives is the one
 * minted at plan time. Re-submitting the same plan therefore carries the same
 * ids and cannot become a second set of positions.
 */
export async function submitCopyBatch(
  plan: CopyPlan,
  opts: SubmitOptions = {},
): Promise<SubmitReport> {
  const live = opts.live === true;
  const plannedCents = plan.committedCents;
  const outcomes: SubmitOutcome[] = [];

  if (!live) {
    for (const order of plan.accepted) {
      outcomes.push({
        clientOrderId: order.clientOrderId,
        notionalCents: notionalCents(order),
        body: order,
        disposition: "would_send",
      });
    }
    return { live: false, outcomes, sentCount: 0, haltedOn: null, sentCents: 0, plannedCents };
  }

  if (!opts.clearance || !opts.clearance.ok) {
    for (const order of plan.accepted) {
      outcomes.push({
        clientOrderId: order.clientOrderId,
        notionalCents: notionalCents(order),
        body: order,
        disposition: "unsent",
        reason: "no_mode_clearance",
      });
    }
    return { live: true, outcomes, sentCount: 0, haltedOn: null, sentCents: 0, plannedCents };
  }

  let halted: SubmitReport["haltedOn"] = null;
  let sentCount = 0;
  let sentCents = 0;

  for (const order of plan.accepted) {
    const n = notionalCents(order);
    if (halted) {
      outcomes.push({
        clientOrderId: order.clientOrderId,
        notionalCents: n,
        body: order,
        disposition: "unsent",
        reason: "batch_halted",
      });
      continue;
    }
    const result = await placeOrder(requestFor(order, plan.caps), opts.deps ?? {}, plan.nowMs);
    sentCount += 1;
    if (result.state === "ok") sentCents += n;
    outcomes.push({
      clientOrderId: order.clientOrderId,
      notionalCents: n,
      body: order,
      disposition: "sent",
      result,
    });
    if (haltsBatch(result)) {
      halted = {
        clientOrderId: order.clientOrderId,
        state: result.state,
        ...("code" in result && result.code ? { code: result.code } : {}),
      };
    }
  }

  return { live: true, outcomes, sentCount, haltedOn: halted, sentCents, plannedCents };
}

/* ── THE WHOLE LANE ──────────────────────────────────────────────────────── */

export type CopyLaneArgs = {
  intents: readonly CopyIntent[];
  state: CopyPlanState;
  caller?: Partial<CopyCaps>;
  env?: Record<string, string | undefined>;
  /** `balanceCents` from GET /stats, read by the CALLER so dry run stays offline. */
  balanceCents?: number;
  deps?: AgentDeps;
  /** False by default. */
  live?: boolean;
  acceptModes?: readonly string[];
  /**
   * His bot's own `minBetCents`, READ from GET /api/agent/v1/config or /bot/state
   * by the caller. Omit when it has not been read — this lane never guesses a
   * minimum. When supplied, an ENTRY whose notional falls under it is refused
   * (`below_bot_min_bet`) rather than POSTed to discover whether his app rejects
   * it or silently sizes it up.
   */
  botMinBetCents?: number;
};

export type CopyLaneRun = {
  caps: CopyCaps;
  plan: CopyPlan;
  /** null in dry run — the guard is not consulted because nothing is sent. */
  clearance: GuardResult | null;
  submission: SubmitReport;
};

/**
 * The function `copy-loop.ts` calls instead of `kalshi.placeOrder`.
 *
 * DRY RUN IS TOTALLY OFFLINE. With `live` unset or false this makes ZERO
 * network calls — no /bot/state, no /order, nothing. That is deliberate: a dry
 * run should be something Classic can run a hundred times without touching an
 * API that locks him out after one bad token. The mode guard is consulted only
 * on the live path, where it is also structurally required by
 * `submitCopyBatch`.
 *
 * `balanceCents` is passed IN rather than fetched here, for the same reason.
 */
export async function runCopyLane(args: CopyLaneArgs): Promise<CopyLaneRun> {
  const caps = resolveCaps({
    caller: args.caller,
    env: args.env,
    balanceCents: args.balanceCents,
    // Passed IN, like balanceCents, so a dry run touches no API. Read it from his
    // app's own config/bot-state; omitted means "unknown", which does NOT gate.
    botMinBetCents: args.botMinBetCents,
  });
  const plan = planCopyBatch(args.intents, caps, args.state);

  if (args.live !== true) {
    const submission = await submitCopyBatch(plan, { live: false });
    return { caps, plan, clearance: null, submission };
  }

  const clearance = await assertCopyModeAllowed(
    args.deps ?? {},
    args.acceptModes ?? COPY_DEFAULT_ACCEPTED_MODES,
  );
  const submission = await submitCopyBatch(plan, {
    live: true,
    deps: args.deps,
    clearance,
  });
  return { caps, plan, clearance, submission };
}

/** One line per outcome, for the ops feed. Plain, countable, no decoration. */
export function copyFeedLines(run: CopyLaneRun): string[] {
  const lines: string[] = [];
  lines.push(
    `COPY plan: ${run.plan.accepted.length} accepted (${run.plan.committedCents}c of ${run.caps.perScanCents}c), ${run.plan.rejected.length} rejected, mode=${run.clearance ? run.clearance.ok ? run.clearance.mode : "REFUSED" : "dry"}`,
  );
  for (const o of run.submission.outcomes) {
    const p = run.plan.provenance[o.clientOrderId];
    const who = p ? `${p.venue}:${p.sourceTrader}` : "unknown";
    const what = `${o.body.action} ${o.body.count}x ${o.body.ticker} ${o.body.side} @${o.body.priceCents}c`;
    if (o.disposition === "would_send") lines.push(`COPY would send ${what} (${who}) — dry run`);
    else if (o.disposition === "unsent") lines.push(`COPY UNSENT ${what} (${who}) — ${o.reason}`);
    else lines.push(`COPY sent ${what} (${who}) — ${o.result.state}`);
  }
  for (const r of run.plan.rejected) lines.push(`COPY dropped — ${r.reason}: ${r.detail}`);
  return lines;
}
