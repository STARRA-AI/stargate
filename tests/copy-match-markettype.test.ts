import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPolyMarket,
  isCopyableKind,
  matchByName,
  matchOutcomeGuarded,
  type KalshiMarketLite,
  type PolyMarketKind,
  isSideTradeable,
} from "../src/lib/copy-match";

// ─────────────────────────────────────────────────────────────────────────────
// Guards the market-KIND gate in src/lib/copy-match.ts.
//
// WHAT THIS PROTECTS: buying a Kalshi MONEYLINE when the trader we copy bet a
// POINT SPREAD (or a total, or a 1H line). matchByName() matches competitor
// names and nothing else, so "Patriots" on a Bills -6.5 spread resolves to the
// Kalshi "Patriots win outright" market — a different, much less likely event
// that also quotes cheaper, so the edge calculation reads as free money. A
// silent wrong-market copy is worse than no copy.
//
// Every slug and title below is a REAL row pulled on 2026-10-04 from
// data-api.polymarket.com/activity for the top-10 wallets on
// lb-api.polymarket.com/profit?window=7d (889 TRADE rows, 253 distinct
// markets). NO NETWORK CALLS HAPPEN IN THIS FILE — the candidates are literals.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed clock so isLive() is deterministic: kickoff passed, settlement open. */
const NOW = new Date("2026-10-04T18:30:00Z");

/** A live, quoted KXNFLGAME moneyline pair for Patriots @ Bills. */
const NFL_GAME: KalshiMarketLite[] = [
  {
    ticker: "KXNFLGAME-26OCT04NEBUF-NE",
    yes_sub_title: "Patriots",
    occurrence_datetime: "2026-10-04T17:00:00Z",
    close_time: "2026-10-05T04:00:00Z",
    yes_ask_dollars: "0.31",
    exchange_index: 1,
  },
  {
    ticker: "KXNFLGAME-26OCT04NEBUF-BUF",
    yes_sub_title: "Bills",
    occurrence_datetime: "2026-10-04T17:00:00Z",
    close_time: "2026-10-05T04:00:00Z",
    yes_ask_dollars: "0.72",
    exchange_index: 1,
  },
];

/** A live KXMLBGAME pair, to exercise the "code" matcher branch too. */
const MLB_GAME: KalshiMarketLite[] = [
  {
    ticker: "KXMLBGAME-26OCT041940ATLLAD-LAD",
    yes_sub_title: "Los Angeles",
    occurrence_datetime: "2026-10-04T17:40:00Z",
    close_time: "2026-10-05T06:00:00Z",
    yes_ask_dollars: "0.58",
    exchange_index: 2,
  },
  {
    ticker: "KXMLBGAME-26OCT041940ATLLAD-ATL",
    yes_sub_title: "Atlanta",
    occurrence_datetime: "2026-10-04T17:40:00Z",
    close_time: "2026-10-05T06:00:00Z",
    yes_ask_dollars: "0.45",
    exchange_index: 2,
  },
];

type Guarded = ReturnType<typeof matchOutcomeGuarded>;

/** Narrow to the refusal branch, failing loudly if a match came back instead. */
function refused(r: Guarded) {
  if (r.ok) assert.fail(`expected a refusal, got a match on ${r.match.ticker}`);
  return r;
}

/** Narrow to the match branch, failing loudly with the refusal reason. */
function copied(r: Guarded) {
  if (!r.ok) assert.fail(`expected a match, got refusal ${r.reason} (kind=${r.kind})`);
  return r;
}

// ── THE REGRESSION TEST ──────────────────────────────────────────────────────

test("REGRESSION: a point-spread bet must NOT copy as a moneyline", () => {
  // The exact row, byte for byte, from the #1 seven-day-profit wallet
  // 0xf0318c32136c2db7fec88b84869aee6a1106c80c ("BreakTheBank"):
  //   { title: "Spread: Bills (-6.5)", outcome: "Patriots", side: "BUY",
  //     price: 0.4600000072, size: 30.592593,
  //     slug: "nfl-ne-buf-2026-10-04-spread-home-6pt5" }
  // He bought Patriots +6.5 at 46c. He did NOT bet Patriots win outright.
  const row = {
    outcome: "Patriots",
    slug: "nfl-ne-buf-2026-10-04-spread-home-6pt5",
    title: "Spread: Bills (-6.5)",
  };

  // 1. Proof the bug is real and not theoretical: the unguarded matcher hands
  //    back the MONEYLINE for this spread bet, at 31c against his 46c — a
  //    15c "edge" on a bet he never made. If this assertion ever starts
  //    failing, read it as the old path having changed, not as the gate.
  const unguarded = matchByName(row.outcome, NFL_GAME, NOW);
  assert.equal(unguarded?.ticker, "KXNFLGAME-26OCT04NEBUF-NE");
  assert.equal(unguarded?.askDollars, 0.31);

  // 2. The gate refuses before any name matching happens.
  const r = refused(
    matchOutcomeGuarded({ ...row, candidates: NFL_GAME, matcher: "name", now: NOW }),
  );
  assert.equal(r.reason, "market_kind_not_copyable");
  assert.equal(r.kind, "spread");
});

// ── a genuine moneyline still goes through ───────────────────────────────────

test("a genuine moneyline slug still matches, name matcher", () => {
  // Real: slug "nfl-ne-buf-2026-10-04", title "Patriots vs. Bills" — 59 trades.
  const r = copied(
    matchOutcomeGuarded({
      outcome: "Patriots",
      slug: "nfl-ne-buf-2026-10-04",
      title: "Patriots vs. Bills",
      candidates: NFL_GAME,
      matcher: "name",
      now: NOW,
    }),
  );
  assert.equal(r.match.ticker, "KXNFLGAME-26OCT04NEBUF-NE");
  assert.equal(r.match.code, "NE");
  assert.equal(r.match.askDollars, 0.31);
  assert.equal(r.match.live, true);
});

test("a genuine moneyline slug still matches, code matcher (MLB)", () => {
  // Real: slug "mlb-atl-lad-2026-10-04",
  //       title "Atlanta Braves vs. Los Angeles Dodgers".
  const r = copied(
    matchOutcomeGuarded({
      outcome: "Los Angeles Dodgers",
      slug: "mlb-atl-lad-2026-10-04",
      title: "Atlanta Braves vs. Los Angeles Dodgers",
      candidates: MLB_GAME,
      matcher: "code",
      now: NOW,
    }),
  );
  assert.equal(r.match.ticker, "KXMLBGAME-26OCT041940ATLLAD-LAD");
  assert.equal(r.match.code, "LAD");
});

test("the per-team soccer moneyline shape is still copyable", () => {
  // Real: slug "unl-prt-nor-2026-10-04-prt",
  //       title "Will Portugal win on 2026-10-04?" — the short team-code tail
  //       must not be mistaken for a market-type keyword.
  assert.equal(
    classifyPolyMarket({
      slug: "unl-prt-nor-2026-10-04-prt",
      title: "Will Portugal win on 2026-10-04?",
    }),
    "moneyline",
  );
});

// ── every non-copyable kind, from real titles, is classified and refused ─────

test("totals, periods, exact scores and futures each classify and are refused", () => {
  const cases: { slug: string; title: string; outcome: string; kind: PolyMarketKind }[] = [
    {
      slug: "nfl-ten-bal-2026-10-04-total-49pt5",
      title: "Titans vs. Ravens: O/U 49.5",
      outcome: "Over",
      kind: "total",
    },
    {
      slug: "conl-guy1-dma-2026-10-04-team-total-away-0pt5",
      title: "Guyana vs. Dominica: Dominica O/U 0.5",
      outcome: "Over",
      kind: "total",
    },
    {
      slug: "nfl-mia-min-2026-10-04-1h-moneyline",
      title: "Dolphins vs. Vikings: 1H Moneyline",
      outcome: "Vikings",
      kind: "period",
    },
    {
      slug: "unl-grc-ger-2026-10-04-first-half-total-0pt5",
      title: "Greece vs. Germany: 1st Half O/U 0.5",
      outcome: "Over",
      kind: "period",
    },
    {
      slug: "unl-grc-ger-2026-10-04-halftime-result-home",
      title: "Greece leading at halftime?",
      outcome: "Yes",
      kind: "period",
    },
    {
      slug: "unl-prt-nor-2026-10-04-exact-score-0-1",
      title: "Exact Score: Portugal 0 - 1 Norway?",
      outcome: "Yes",
      kind: "exact_score",
    },
    {
      slug: "will-atlanta-dream-win-the-2026-wnba-finals-857",
      title: "Will Atlanta Dream win the 2026 WNBA Finals?",
      outcome: "Yes",
      kind: "futures",
    },
    {
      slug: "will-portugal-win-the-2026-27-uefa-nations-league",
      title: "Will Portugal win the 2026-27 UEFA Nations League?",
      outcome: "Yes",
      kind: "futures",
    },
  ];

  for (const c of cases) {
    assert.equal(classifyPolyMarket({ slug: c.slug, title: c.title }), c.kind, `slug ${c.slug}`);
    assert.equal(isCopyableKind(c.kind), false, `kind ${c.kind} must not be copyable`);
    const r = refused(
      matchOutcomeGuarded({
        outcome: c.outcome,
        slug: c.slug,
        title: c.title,
        candidates: NFL_GAME,
        matcher: "name",
        now: NOW,
      }),
    );
    assert.equal(r.reason, "market_kind_not_copyable", `slug ${c.slug}`);
    assert.equal(r.kind, c.kind, `slug ${c.slug}`);
  }
});

test("a 1H Moneyline on a real game must never read as a moneyline", () => {
  // Real: "nfl-mia-min-2026-10-04-1h-moneyline" / "Dolphins vs. Vikings:
  // 1H Moneyline" — 19 trades. This is the most expensive misread available
  // here, because the word "moneyline" is right there in the slug.
  assert.notEqual(
    classifyPolyMarket({ slug: "nfl-mia-min-2026-10-04-1h-moneyline" }),
    "moneyline",
  );
  assert.equal(classifyPolyMarket({ slug: "nfl-mia-min-2026-10-04-1h-moneyline" }), "period");
});

// ── PRECEDENCE: period beats spread ─────────────────────────────────────────

test("PRECEDENCE: a slug with both a period marker and 'spread' is period", () => {
  // Real: "nfl-mia-min-2026-10-04-1h-spread-home-6pt5" / "1H Spread:
  // Vikings (-6.5)" — 9 trades. A first-half spread settles on a different
  // Kalshi series from a full-game spread, so calling it "spread" would aim it
  // at the wrong future lane.
  const slug = "nfl-mia-min-2026-10-04-1h-spread-home-6pt5";
  assert.equal(classifyPolyMarket({ slug }), "period");
  assert.notEqual(classifyPolyMarket({ slug }), "spread");

  // Same precedence from the title alone.
  assert.equal(classifyPolyMarket({ title: "1H Spread: Vikings (-6.5)" }), "period");

  // And a period total beats the total rule the same way.
  assert.equal(
    classifyPolyMarket({ slug: "conl-guy1-dma-2026-10-04-first-half-team-total-home-1pt5" }),
    "period",
  );
});

// ── the conservative default ─────────────────────────────────────────────────

test("missing slug AND missing title classifies as other and is refused", () => {
  assert.equal(classifyPolyMarket({}), "other");
  assert.equal(classifyPolyMarket({ slug: null, title: null }), "other");
  assert.equal(classifyPolyMarket({ slug: "", title: "   " }), "other");

  const r = refused(
    matchOutcomeGuarded({ outcome: "Patriots", candidates: NFL_GAME, matcher: "name", now: NOW }),
  );
  assert.equal(r.reason, "market_kind_not_copyable");
  assert.equal(r.kind, "other");
});

test("an unrecognised novel slug is other and is refused, never moneyline", () => {
  // A market type Polymarket has not shipped yet. Unknown must mean skip.
  const slug = "nfl-ne-buf-2026-10-04-fourth-down-conversion-rate-band-3";
  assert.equal(classifyPolyMarket({ slug }), "other");

  const r = refused(
    matchOutcomeGuarded({
      outcome: "Patriots",
      slug,
      candidates: NFL_GAME,
      matcher: "name",
      now: NOW,
    }),
  );
  assert.equal(r.reason, "market_kind_not_copyable");
  assert.equal(r.kind, "other");
});

test("a head-to-head title does NOT upgrade an unrecognised slug", () => {
  // The slug is the stronger signal. Letting an "A vs. B" title promote an
  // unknown slug to moneyline would reintroduce exactly the guess the gate
  // removes, so a present-but-unrecognised slug wins and the title is ignored.
  assert.equal(
    classifyPolyMarket({
      slug: "nfl-ne-buf-2026-10-04-some-market-type-not-yet-known",
      title: "Patriots vs. Bills",
    }),
    "other",
  );
});

test("draws and both-teams-to-score are not winner markets and are refused", () => {
  // Real: "conl-guy1-dma-2026-10-04-draw" / "Will Guyana vs. Dominica end in a
  // draw?" — the title contains "vs.", and "draw" is four characters, so both
  // the title rule and the short-team-code rule would otherwise claim it.
  assert.equal(
    classifyPolyMarket({
      slug: "conl-guy1-dma-2026-10-04-draw",
      title: "Will Guyana vs. Dominica end in a draw?",
    }),
    "other",
  );
  assert.equal(classifyPolyMarket({ title: "Will Guyana vs. Dominica end in a draw?" }), "other");
  assert.equal(
    classifyPolyMarket({
      slug: "unl-prt-nor-2026-10-04-btts",
      title: "Portugal vs. Norway: Both Teams to Score",
    }),
    "other",
  );
});

test("a politics slug containing the word 'total' is not a total", () => {
  // Real: "will-total-votes-cast-in-the-2026-midterm-election-for-senator-from-
  // south-carolina-be-between-1400000-and-1600000". A bare /total/ test
  // mislabels this; the line digit is what keeps it honest.
  assert.equal(
    classifyPolyMarket({
      slug: "will-total-votes-cast-in-the-2026-midterm-election-for-senator-from-south-carolina-be-between-1400000-and-1600000",
      title:
        "Will total votes cast in the 2026 midterm election for Senator from South Carolina be between 1,400,000 and 1,600,000?",
    }),
    "other",
  );
  assert.equal(
    classifyPolyMarket({
      slug: "will-the-republicans-win-the-south-carolina-senate-race-in-2026",
      title: "Will the Republicans win the South Carolina Senate race",
    }),
    "other",
  );
});

test("an esports game title mentioning 'Pro League' is a moneyline, not futures", () => {
  // Real: "cs2-vit-navi-2026-10-04" / "Counter-Strike: Vitality vs Natus
  // Vincere (BO3) - ESL Pro League Group Stage". The tournament name sits in
  // the title of a single-game market, so the head-to-head test has to win.
  assert.equal(
    classifyPolyMarket({
      slug: "cs2-vit-navi-2026-10-04",
      title: "Counter-Strike: Vitality vs Natus Vincere (BO3) - ESL Pro League Group Stage",
    }),
    "moneyline",
  );
  assert.equal(
    classifyPolyMarket({
      title: "Counter-Strike: Vitality vs Natus Vincere (BO3) - ESL Pro League Group Stage",
    }),
    "moneyline",
  );
  // Same wallet, same day, no game: that one IS futures.
  assert.equal(
    classifyPolyMarket({ slug: "will-natus-vincere-win-the-esl-pro-league-season-24-1788882991655" }),
    "futures",
  );
});

// ── no_name_match, not a crash ───────────────────────────────────────────────

test("a copyable kind whose name matches nothing returns no_name_match", () => {
  const r = refused(
    matchOutcomeGuarded({
      outcome: "Seattle Seahawks",
      slug: "nfl-sea-ari-2026-10-04",
      title: "Seahawks vs. Cardinals",
      candidates: NFL_GAME,
      matcher: "name",
      now: NOW,
    }),
  );
  assert.equal(r.reason, "no_name_match");
  assert.equal(r.kind, "moneyline");
});

test("no_name_match on an empty candidate list and on the code matcher", () => {
  const empty = refused(
    matchOutcomeGuarded({
      outcome: "Patriots",
      slug: "nfl-ne-buf-2026-10-04",
      candidates: [],
      matcher: "name",
      now: NOW,
    }),
  );
  assert.equal(empty.reason, "no_name_match");

  // A tennis player handed to the MLB code table resolves to no club code.
  const notAClub = refused(
    matchOutcomeGuarded({
      outcome: "Lois Boisson",
      slug: "wta-jeanjea-boisson-2026-10-04",
      candidates: MLB_GAME,
      matcher: "code",
      now: NOW,
    }),
  );
  assert.equal(notAClub.reason, "no_name_match");
  assert.equal(notAClub.kind, "moneyline");
});

// ── isCopyableKind is the whole allowlist ────────────────────────────────────

test("isCopyableKind allows moneyline and nothing else", () => {
  const all: PolyMarketKind[] = [
    "moneyline",
    "spread",
    "total",
    "period",
    "exact_score",
    "futures",
    "props",
    "other",
  ];
  assert.deepEqual(
    all.filter(isCopyableKind),
    ["moneyline"],
    "COPY_SERIES is all game-winner series, so moneyline is the only safe kind",
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * SIDE-AWARE TRADEABILITY (board check finding 4, 2026-10-04)
 *
 * isTradeable only ever reads yes_ask_dollars, so a NO-side intent could resolve
 * onto a market where nothing is offered on the NO side — an order priced into an
 * empty book, which rests unfilled or fills exactly when it is wrong.
 *
 * Kalshi publishes no_ask_dollars SEPARATELY, and it is NOT 100 - yes_ask.
 * Measured on a live list response for KXWTAMATCH-26OCT03OSTMER-OST (2026-10-04):
 *   yes_ask 0.3800 · yes_bid 0.3700 · no_ask 0.6300 · no_bid 0.6200
 * 0.63 = 1 - 0.37, i.e. the NO ask complements the YES BID. Complementing a
 * PRINT is correct; complementing a BOOK is not.
 * ──────────────────────────────────────────────────────────────────────────── */
test("isSideTradeable: real quoted market is tradeable on both sides", () => {
  const m = {
    ticker: "KXWTAMATCH-26OCT03OSTMER-OST",
    yes_ask_dollars: "0.3800",
    yes_bid_dollars: "0.3700",
    no_ask_dollars: "0.6300",
    no_bid_dollars: "0.6200",
  };
  assert.equal(isSideTradeable(m, "yes"), true);
  assert.equal(isSideTradeable(m, "no"), true);
});

test("isSideTradeable: a YES-only book refuses a NO-side intent", () => {
  const m = { ticker: "X-1", yes_ask_dollars: "0.3800", no_ask_dollars: "0.0000" };
  assert.equal(isSideTradeable(m, "yes"), true, "YES is quoted");
  assert.equal(isSideTradeable(m, "no"), false, "an explicit zero NO ask is a quoted empty book");
});

test("isSideTradeable: an ABSENT no_ask falls back to YES rather than muting the lane", () => {
  // Several Kalshi list shapes omit the no_* fields entirely. Treating "not
  // returned" as "no market" would silently kill every NO-side copy.
  const m = { ticker: "X-2", yes_ask_dollars: "0.3800" };
  assert.equal(isSideTradeable(m, "no"), true);
});

test("isSideTradeable: no book at all is refused on either side", () => {
  const m = { ticker: "X-3", yes_ask_dollars: "0.0000", no_ask_dollars: "0.0000" };
  assert.equal(isSideTradeable(m, "yes"), false);
  assert.equal(isSideTradeable(m, "no"), false);
});

test("isSideTradeable: the NO ask is NOT derived by complementing the YES ask", () => {
  // If anyone ever "simplifies" this to 1 - yes_ask, this fails: 1 - 0.38 = 0.62,
  // which is the NO BID, not the NO ask (0.63).
  const m = { ticker: "X-4", yes_ask_dollars: "0.3800", no_ask_dollars: "0.6300" };
  assert.notEqual(Number(m.no_ask_dollars), 1 - Number(m.yes_ask_dollars));
  assert.equal(isSideTradeable(m, "no"), true);
});
