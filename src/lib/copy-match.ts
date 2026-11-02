/**
 * Match a Polymarket trade to the equivalent LIVE Kalshi market.
 *
 * Polymarket is the signal, Kalshi is the venue. Polymarket names teams in full
 * ("Chicago White Sox"); Kalshi names them by city with a disambiguating suffix
 * ("Chicago WS") and encodes a short code in the ticker (`...-CWS`). Nothing
 * lines up by string equality, so this maps deliberately.
 *
 * Verified against all 30 MLB clubs — see scripts/starra-live-signals.ts --selftest.
 */

/**
 * Distinctive nickname -> Kalshi code, for the clubs a city name cannot resolve.
 * Checked BEFORE the city fallback, because "Chicago" alone is ambiguous.
 */
const MLB_NICKNAME: Record<string, string> = {
  "white sox": "CWS",
  cubs: "CHC",
  yankees: "NYY",
  mets: "NYM",
  angels: "LAA",
  dodgers: "LAD",
  athletics: "ATH",
  "a's": "ATH",
};

/** City (as Polymarket writes it) -> Kalshi code, for the unambiguous 22. */
const MLB_CITY: Record<string, string> = {
  arizona: "AZ",
  "arizona diamondbacks": "AZ",
  atlanta: "ATL",
  baltimore: "BAL",
  boston: "BOS",
  cincinnati: "CIN",
  cleveland: "CLE",
  colorado: "COL",
  detroit: "DET",
  houston: "HOU",
  "kansas city": "KC",
  miami: "MIA",
  milwaukee: "MIL",
  minnesota: "MIN",
  philadelphia: "PHI",
  pittsburgh: "PIT",
  "san diego": "SD",
  "san francisco": "SF",
  seattle: "SEA",
  "st. louis": "STL",
  "st louis": "STL",
  "tampa bay": "TB",
  texas: "TEX",
  toronto: "TOR",
  washington: "WSH",
};

/**
 * "Chicago White Sox" -> "CWS". Returns null when the name is not an MLB club,
 * which is the correct answer for a tennis player or a CS:GO roster — the
 * caller must not fall back to a guess.
 */
export function mlbTeamCode(name: string): string | null {
  const n = name.toLowerCase().trim();
  for (const [nick, code] of Object.entries(MLB_NICKNAME)) {
    if (n.includes(nick)) return code;
  }
  if (MLB_CITY[n]) return MLB_CITY[n];
  // Longest city prefix wins, so "kansas city royals" beats a stray "kansas".
  const hit = Object.keys(MLB_CITY)
    .filter((city) => n.startsWith(city))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? MLB_CITY[hit] : null;
}

export type KalshiMarketLite = {
  ticker: string;
  yes_sub_title?: string;
  occurrence_datetime?: string;
  close_time?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  /**
   * The NO side's own quote. Kalshi publishes it SEPARATELY and it is NOT
   * 100 - yes_ask: buying NO at n is selling YES at 100-n, so the NO ask
   * complements the YES BID, not the YES ask. Verified in a live list response
   * for KXWTAMATCH-26OCT03OSTMER-OST (2026-10-04): yes_ask 0.3800 / yes_bid
   * 0.3700 / no_ask 0.6300 / no_bid 0.6200 — note 0.63 = 1 - 0.37, the BID.
   * Never derive one side from the other; read the field.
   */
  no_ask_dollars?: string;
  no_bid_dollars?: string;
  exchange_index?: number;
  volume_24h_fp?: string;
};

/**
 * A market is LIVE when the event has started but settlement has not closed.
 *
 * ★ Do NOT use close_time as the game clock — Kalshi sets it to the settlement
 *   window, so a Thursday game shows a Sunday close. occurrence_datetime is the
 *   actual start.
 */
export function isLive(m: KalshiMarketLite, now = new Date()): boolean {
  if (!m.occurrence_datetime) return false;
  const start = new Date(m.occurrence_datetime).getTime();
  const close = m.close_time ? new Date(m.close_time).getTime() : Infinity;
  const t = now.getTime();
  return start <= t && t < close;
}

/** Tradeable = someone is actually offering. A bid into an empty book rests forever. */
export function isTradeable(m: KalshiMarketLite): boolean {
  return parseFloat(m.yes_ask_dollars ?? "0") > 0;
}

/**
 * Is the side we actually intend to BUY quoted?
 *
 * ★ `isTradeable` only ever looks at `yes_ask_dollars`, so a NO-side intent used
 *   to pass on a market where nothing is offered on the NO side at all — an order
 *   priced into an empty book, which either rests unfilled or fills exactly when
 *   it is wrong. Kalshi publishes `no_ask_dollars` separately; this reads the side
 *   it is going to send and never derives one side from the other (see
 *   KalshiMarketLite.no_ask_dollars for why complementing the ask is wrong).
 *
 * When the NO quote is simply ABSENT from the payload, this falls back to the YES
 * ask rather than refusing: several Kalshi list shapes omit the no_* fields
 * entirely, and treating "field not returned" as "no market" would mute the whole
 * lane. An explicit zero IS a refusal — that is a quoted empty book, not a gap.
 */
export function isSideTradeable(m: KalshiMarketLite, side: "yes" | "no"): boolean {
  if (side === "yes") return isTradeable(m);
  if (m.no_ask_dollars === undefined) return isTradeable(m);
  return parseFloat(m.no_ask_dollars) > 0;
}

/**
 * The team code a Kalshi ticker ends in: KXMLBGAME-26SEP041940MINCWS-CWS -> CWS.
 * The suffix is the authoritative identifier; the display title is not.
 */
export function tickerTeamCode(ticker: string): string {
  const i = ticker.lastIndexOf("-");
  return i < 0 ? ticker : ticker.slice(i + 1);
}

export type Match = {
  ticker: string;
  team: string;
  code: string;
  askDollars: number;
  shard: number;
  live: boolean;
};

/**
 * Find the Kalshi market representing "this team wins" among the candidates.
 * Matches on the ticker's team suffix, which is exact — never on the display
 * title, which differs between the two venues by design.
 */
export function matchMlbOutcome(
  outcome: string,
  candidates: KalshiMarketLite[],
  now = new Date(),
): Match | null {
  const code = mlbTeamCode(outcome);
  if (!code) return null;
  const hit = candidates.find((m) => tickerTeamCode(m.ticker) === code);
  if (!hit) return null;
  return {
    ticker: hit.ticker,
    team: hit.yes_sub_title ?? outcome,
    code,
    askDollars: parseFloat(hit.yes_ask_dollars ?? "0"),
    shard: Number(hit.exchange_index ?? 0),
    live: isLive(hit, now),
  };
}

// ── general name matching (tennis, esports, soccer) ────────────────────────
// MLB needed a code table because Kalshi writes cities ("San Diego") where
// Polymarket writes clubs ("San Diego Padres"). Every OTHER sport puts the full
// human-readable name in yes_sub_title — "Tommy Paul", "The Otter Side",
// "Taylor Townsend" — so those match on the name directly and need no table.

/** Lowercase, strip accents, drop club cruft and punctuation, collapse spaces. */
export function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|club|esports|gaming|team)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does a Polymarket outcome name the same competitor as this Kalshi market?
 *
 * Exact normalised equality first. Then a surname/keyword rule: every
 * significant token of the SHORTER name must appear in the longer one, so
 * "Medvedev" matches "Daniil Medvedev" but "Taylor Fritz" never matches
 * "Taylor Townsend" — the shared first name is not enough on its own.
 */
export function sameCompetitor(polyOutcome: string, kalshiSubTitle: string): boolean {
  const a = normaliseName(polyOutcome);
  const b = normaliseName(kalshiSubTitle);
  if (!a || !b) return false;
  if (a === b) return true;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const tokens = short.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  const longTokens = new Set(long.split(" "));
  return tokens.every((t) => longTokens.has(t));
}

/**
 * Match an outcome to a live market by NAME, for any sport that publishes real
 * names. Skips draw lines ("Tie") — a copied moneyline is never a draw bet.
 *
 * ★ THIS FUNCTION IS NAME-ONLY AND MARKET-TYPE BLIND. It cannot tell a moneyline
 *   bet from a point-spread bet on the same team, and it returns the moneyline
 *   either way — the confirmed wrong-market copy bug documented in the
 *   "market-KIND gate" section at the bottom of this file. Call
 *   matchOutcomeGuarded() instead. Kept unchanged so existing callers do not
 *   break.
 */
export function matchByName(
  outcome: string,
  candidates: KalshiMarketLite[],
  now = new Date(),
): Match | null {
  const hit = candidates.find(
    (m) =>
      (m.yes_sub_title ?? "").toLowerCase() !== "tie" &&
      sameCompetitor(outcome, m.yes_sub_title ?? ""),
  );
  if (!hit) return null;
  return {
    ticker: hit.ticker,
    team: hit.yes_sub_title ?? outcome,
    code: tickerTeamCode(hit.ticker),
    askDollars: parseFloat(hit.yes_ask_dollars ?? "0"),
    shard: Number(hit.exchange_index ?? 0),
    live: isLive(hit, now),
  };
}

/** Series scanned for a copyable signal, with the shard each one settles on. */
export const COPY_SERIES = [
  { series: "KXMLBGAME", sport: "mlb", matcher: "code" as const },
  { series: "KXATPMATCH", sport: "tennis-atp", matcher: "name" as const },
  { series: "KXWTAMATCH", sport: "tennis-wta", matcher: "name" as const },
  { series: "KXLOLGAME", sport: "lol", matcher: "name" as const },
  { series: "KXCS2GAMES", sport: "cs2", matcher: "name" as const },
  { series: "KXCS2MAPWINNER", sport: "cs2-map", matcher: "name" as const },
  { series: "KXEPLGAME", sport: "soccer-epl", matcher: "name" as const },
  { series: "KXUCLGAME", sport: "soccer-ucl", matcher: "name" as const },
  { series: "KXNFLGAME", sport: "nfl", matcher: "name" as const },
];

/**
 * One entry point: use the code table for MLB, names for everything else.
 *
 * ★ NO MARKET-TYPE GATE. This matches a competitor name against a game-winner
 *   series without ever asking whether the Polymarket trade was a moneyline, a
 *   spread, a total or a 1H line — so a spread bet copies as a moneyline, which
 *   is the confirmed money-losing bug documented in the "market-KIND gate"
 *   section at the bottom of this file. Prefer matchOutcomeGuarded(). Kept
 *   unchanged so existing callers do not break.
 */
export function matchOutcome(
  outcome: string,
  candidates: KalshiMarketLite[],
  matcher: "code" | "name",
  now = new Date(),
): Match | null {
  return matcher === "code"
    ? matchMlbOutcome(outcome, candidates, now)
    : matchByName(outcome, candidates, now);
}

// ── market-KIND gate ─────────────────────────────────────────────────────────
//
// ★★★ THE BUG THIS SECTION EXISTS TO STOP — confirmed by live API call
//     2026-10-04, not a hypothesis.
//
// matchByName() above matches on COMPETITOR NAME ONLY. It never asks what KIND
// of market the Polymarket trade was. The #1 seven-day-profit wallet
// (0xf0318c32136c2db7fec88b84869aee6a1106c80c, "BreakTheBank") held this fill,
// read verbatim off data-api.polymarket.com/activity:
//
//   { title: "Spread: Bills (-6.5)", outcome: "Patriots", side: "BUY",
//     price: 0.4600000072, size: 30.592593,
//     slug: "nfl-ne-buf-2026-10-04-spread-home-6pt5" }
//
// That is Patriots +6.5 at 46c. Feed outcome "Patriots" into matchByName against
// KXNFLGAME candidates and it returns the Kalshi MONEYLINE for the Patriots —
// "Patriots win outright", a different and far less likely event. Worse, the
// moneyline quotes CHEAPER than 46c, so copy-loop.ts's `sig.price - m.askDollars`
// reads as a fat edge while the copy is strictly the worse bet. A silent
// wrong-market copy is more dangerous than no copy at all.
//
// So: classify the Polymarket market FIRST, and refuse anything that is not a
// full-game winner.
//
// GROUNDING — every pattern below comes from slugs pulled live on 2026-10-04
// from the top-10 lb-api.polymarket.com/profit?window=7d wallets: 889 TRADE
// rows, 253 distinct (slug, title) pairs. Representative real slugs:
//
//   moneyline    nfl-ne-buf-2026-10-04                 "Patriots vs. Bills"
//                mlb-cws-hou-2026-09-30                "Chicago White Sox vs. Houston Astros"
//                wnba-nyl-atl-2026-10-04               "New York Liberty vs. Atlanta Dream"
//                cs2-vit-navi-2026-10-04               "Counter-Strike: Vitality vs Natus Vincere (BO3) - ESL Pro League Group Stage"
//                lol-tl2-ly-2026-10-04                 "LoL: Team Liquid vs LYON (BO5) - LCS Playoffs"
//                atp-noguchi-muller-2026-10-05         "Shanghai Rolex Masters, Qualification: Rio Noguchi vs Alexandre Muller"
//                unl-prt-nor-2026-10-04-prt            "Will Portugal win on 2026-10-04?"
//                col1-cab-cjf-2026-10-04-cjf           "Will CDP Junior FC win on 2026-10-04?"
//   spread       nfl-ne-buf-2026-10-04-spread-home-6pt5   "Spread: Bills (-6.5)"
//                nfl-ari-nyg-2026-10-04-spread-away-2pt5  "Spread: Cardinals (-2.5)"
//                wnba-gsv-dal-2026-09-30-spread-away-4pt5 "Spread: Golden State Valkyries (-4.5)"
//   total        nfl-ten-bal-2026-10-04-total-49pt5       "Titans vs. Ravens: O/U 49.5"
//                conl-guy1-dma-2026-10-04-team-total-away-0pt5 "Guyana vs. Dominica: Dominica O/U 0.5"
//   period       nfl-mia-min-2026-10-04-1h-moneyline      "Dolphins vs. Vikings: 1H Moneyline"
//                nfl-mia-min-2026-10-04-1h-spread-home-6pt5 "1H Spread: Vikings (-6.5)"
//                unl-grc-ger-2026-10-04-first-half-total-0pt5 "Greece vs. Germany: 1st Half O/U 0.5"
//                unl-grc-ger-2026-10-04-halftime-result-home  "Greece leading at halftime?"
//   exact_score  unl-prt-nor-2026-10-04-exact-score-0-1   "Exact Score: Portugal 0 - 1 Norway?"
//   futures      will-atlanta-dream-win-the-2026-wnba-finals-857
//                will-portugal-win-the-2026-27-uefa-nations-league
//                will-bnk-fearx-win-the-demacia-cup-global-invitational-2026
//   other        conl-guy1-dma-2026-10-04-draw            "Will Guyana vs. Dominica end in a draw?"
//                unl-prt-nor-2026-10-04-btts              "Portugal vs. Norway: Both Teams to Score"
//                will-the-republicans-win-the-south-carolina-senate-race-in-2026
//                brazil-first-round-vote-share-flavio-bolsonaro-39-42
//
// NOT OBSERVED in that sample, and marked as such at each site: player props,
// hockey-period and tennis-set markets, MLB first-5-innings, handicap/run-line
// spellings. Those patterns are inference, not measurement — they are included
// only because every one of them lands on a REFUSAL, so a wrong guess there
// costs a missed copy, never a wrong copy.

/**
 * What kind of market a Polymarket trade was placed into.
 *
 * - "moneyline"   full-game winner. The ONLY kind COPY_SERIES can price.
 * - "spread"      point spread / handicap.
 * - "total"       game or team over-under.
 * - "period"      scoped to part of a game: 1H, 2H, a quarter, a set, a halftime
 *                 result. A different event from the full game, with a different
 *                 Kalshi series.
 * - "exact_score" correct-score market.
 * - "futures"     a season / tournament outcome rather than one game.
 * - "props"       player or participant prop.
 * - "other"       unrecognised, or a game-scoped market that is not a winner
 *                 market (draw, both-teams-to-score, …), or not a sports market
 *                 at all (politics, awards, IPOs — all present in the live
 *                 sample).
 *
 * ★ "other" MUST NEVER be treated as "moneyline". Unrecognised means unknown,
 *   and the only safe thing to do with an unknown market is skip it.
 */
export type PolyMarketKind =
  | "moneyline"
  | "spread"
  | "total"
  | "period"
  | "exact_score"
  | "futures"
  | "props"
  | "other";

/**
 * Lowercase, de-accent, and reduce every run of non-alphanumerics to a single
 * dash — so a slug keeps its shape and a title is forced into the SAME token
 * vocabulary. "Spread: Bills (-6.5)" -> "spread-bills-6-5";
 * "Greece vs. Germany: 1st Half O/U 0.5" -> "greece-vs-germany-1st-half-o-u-0-5".
 * One vocabulary means one set of patterns serves both inputs.
 */
function dashify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Scoped to PART of a game. Checked FIRST — see classifyPolyMarket's precedence note. */
const PERIOD_PATTERNS: RegExp[] = [
  /(^|-)[12]h(-|$)/, //                         nfl-mia-min-2026-10-04-1h-moneyline
  /(^|-)(first|second|1st|2nd)-half(-|$)/, //   unl-grc-ger-2026-10-04-first-half-total-0pt5
  /(^|-)half-?time(-|$)/, //                    unl-grc-ger-2026-10-04-halftime-result-home
  /(^|-)[1-4]q(-|$)/,
  /(^|-)q[1-4](-|$)/,
  /(^|-)(first|second|third|fourth|1st|2nd|3rd|4th)-quarter(-|$)/,
  // NOT OBSERVED 2026-10-04 — hockey periods, tennis sets, MLB first five.
  /(^|-)(first|second|third|1st|2nd|3rd)-period(-|$)/,
  /(^|-)period-[1-3](-|$)/,
  /(^|-)(first|second|third|1st|2nd|3rd)-set(-|$)/,
  /(^|-)set-[1-5](-|$)/,
  /(^|-)f5(-|$)/,
  /(^|-)first-(5|five)-innings(-|$)/,
];

const EXACT_SCORE_PATTERNS: RegExp[] = [
  /(^|-)exact-score(-|$)/, //    unl-prt-nor-2026-10-04-exact-score-0-1
  /(^|-)correct-score(-|$)/, //  NOT OBSERVED — the other common spelling.
];

const SPREAD_PATTERNS: RegExp[] = [
  /(^|-)spread(-|$)/, //              nfl-ne-buf-2026-10-04-spread-home-6pt5
  /(^|-)handicap(-|$)/, //            NOT OBSERVED.
  /(^|-)(run|puck)-line(-|$)/, //     NOT OBSERVED.
  // "ats" is deliberately NOT here: it is three characters and could collide
  // with a real team code in the <league>-<away>-<home> slug prefix.
];

const TOTAL_PATTERNS: RegExp[] = [
  // The digit is load-bearing. Polymarket totals always carry the line:
  // "-total-49pt5", "-team-total-away-0pt5". Without the digit this also fires
  // on "will-total-votes-cast-in-the-2026-midterm-election-..." — a real slug in
  // the live sample that is a politics market, not an over-under.
  /(^|-)(team-)?total-(home-|away-)?\d/,
  /(^|-)o-u(-|$)/, //          dashified "O/U 49.5" from the title path
  /(^|-)over-under(-|$)/,
  /(^|-)(over|under)-\d/,
];

const PROPS_PATTERNS: RegExp[] = [
  // NOT OBSERVED in the 2026-10-04 sample — zero player props among 889 trades.
  // "props" is spelled without an optional "s": /props?/ would also match the
  // "-pro-" in "will-falcons-win-the-esl-pro-league-season-24", which is futures.
  /(^|-)player-/,
  /(^|-)props(-|$)/,
  /(^|-)anytime-(touchdown|scorer|goalscorer)(-|$)/,
  /(^|-)(passing|rushing|receiving)-yards(-|$)/,
  /(^|-)first-(touchdown|goalscorer|basket)(-|$)/,
  /(^|-)strikeouts(-|$)/,
];

/**
 * Game-scoped markets that are NOT a winner market. These share the moneyline
 * slug shape, so they must be excluded BEFORE the moneyline test: "draw" and
 * "btts" are four characters and would otherwise read as a team code.
 *
 * They land on "other" rather than a kind of their own because a three-way draw
 * and a both-teams-to-score line have no Kalshi game-winner equivalent at all —
 * "other" is the honest bucket, and it refuses either way.
 */
const NON_WINNER_PATTERNS: RegExp[] = [
  /(^|-)draw(-|$)/, //                   conl-guy1-dma-2026-10-04-draw
  /(^|-)tie(-|$)/,
  /(^|-)btts(-|$)/, //                   unl-prt-nor-2026-10-04-btts
  /(^|-)both-teams-to-score(-|$)/, //    dashified title of the same market
  /(^|-)double-chance(-|$)/, //          NOT OBSERVED.
];

/**
 * The full-game slug shape: exactly <league>-<away>-<home>-<YYYY-MM-DD>, with an
 * optional short team-code tail for the per-team soccer lines.
 *
 * Three tokens before the date is deliberately tight. A loose "ends in a date"
 * rule would also swallow politics slugs that happen to end in one; requiring
 * the head-to-head prefix means every observed moneyline matches
 * (nfl-ne-buf-…, mlb-cws-hou-…, atp-noguchi-muller-…, unl-prt-nor-…-prt,
 * cfb-sfl-utsa-…, val-fut1-t1-…, es2-gir-rm-…) and nothing else does.
 */
const MONEYLINE_SLUG = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}(?:-[a-z0-9]{1,6})?$/;

/** Head-to-head title: "Patriots vs. Bills" -> "patriots-vs-bills". */
const MONEYLINE_TITLE_VS = /(^|-)vs(-|$)/;

/** Per-team soccer title: "Will Portugal win on 2026-10-04?". */
const MONEYLINE_TITLE_WIN_ON = /-win-on-\d{4}-\d{2}-\d{2}$/;

/**
 * Season / tournament tokens. Reached only AFTER the moneyline test, which is
 * why "league" and "season" are safe here: a game slug carries a date and is
 * already classified, while "will-portugal-win-the-2026-27-uefa-nations-league"
 * and "will-falcons-win-the-esl-pro-league-season-24-…" do not.
 */
const FUTURES_PATTERNS: RegExp[] = [
  /(^|-)finals?(-|$)/, //          will-atlanta-dream-win-the-2026-wnba-finals-857
  /(^|-)champion(s|ship|ships)?(-|$)/,
  /(^|-)cup(-|$)/, //              will-bnk-fearx-win-the-demacia-cup-global-invitational-2026
  /(^|-)tournament(-|$)/,
  /(^|-)playoffs?(-|$)/,
  /(^|-)league(-|$)/, //           will-portugal-win-the-2026-27-uefa-nations-league
  /(^|-)season(-|$)/, //           will-natus-vincere-win-the-esl-pro-league-season-24-…
  /(^|-)invitational(-|$)/,
  /(^|-)world-series(-|$)/,
  /(^|-)super-bowl(-|$)/,
  /(^|-)masters(-|$)/,
  /(^|-)trophy(-|$)/,
];

const anyMatch = (text: string, patterns: RegExp[]): boolean => patterns.some((re) => re.test(text));

/**
 * What kind of Polymarket market is this? Derived from the slug, which encodes
 * the market type explicitly; the title is the fallback for callers that do not
 * carry a slug.
 *
 * ★ PRECEDENCE — most specific wins, and PERIOD WINS OVER EVERYTHING.
 *   "nfl-mia-min-2026-10-04-1h-spread-home-6pt5" contains BOTH a period marker
 *   and "spread", and it is "period", not "spread". The reason is not stylistic:
 *   a first-half spread settles on a different Kalshi series from a full-game
 *   spread (KXWNBA1QWINNER-style period series were observed live today), so
 *   calling it "spread" would send it to the wrong future lane. The same logic
 *   makes "nfl-mia-min-2026-10-04-1h-moneyline" a "period" and NOT a
 *   "moneyline" — which is the single most expensive misread available here,
 *   because 1H Moneyline would otherwise sail straight through the gate.
 *   Order: period > exact_score > spread > total > props > non-winner >
 *   moneyline > futures > other.
 *
 * ★ A PRESENT-BUT-UNRECOGNISED SLUG RETURNS "other" AND THE TITLE IS NOT
 *   CONSULTED. The title is the weaker signal; letting it upgrade an unknown
 *   slug to "moneyline" on the strength of an "A vs. B" string would reintroduce
 *   exactly the guess this gate exists to remove. The title is read only when
 *   there is no slug at all.
 *
 * Conservative by design: returning "other" and skipping the trade is correct.
 * Guessing "moneyline" is what loses money.
 */
export function classifyPolyMarket(input: { slug?: string | null; title?: string | null }): PolyMarketKind {
  const slug = dashify(input.slug ?? "");
  const title = dashify(input.title ?? "");
  const text = slug || title;
  if (!text) return "other";

  if (anyMatch(text, PERIOD_PATTERNS)) return "period";
  if (anyMatch(text, EXACT_SCORE_PATTERNS)) return "exact_score";
  if (anyMatch(text, SPREAD_PATTERNS)) return "spread";
  if (anyMatch(text, TOTAL_PATTERNS)) return "total";
  if (anyMatch(text, PROPS_PATTERNS)) return "props";
  if (anyMatch(text, NON_WINNER_PATTERNS)) return "other";

  // The moneyline test differs by source: a slug must have the head-to-head
  // shape; a title is matched on its phrasing.
  if (slug) {
    if (MONEYLINE_SLUG.test(slug)) return "moneyline";
  } else if (MONEYLINE_TITLE_VS.test(title) || MONEYLINE_TITLE_WIN_ON.test(title)) {
    return "moneyline";
  }

  if (anyMatch(text, FUTURES_PATTERNS)) return "futures";
  return "other";
}

/**
 * Is this kind safe to copy onto the COPY_SERIES list?
 *
 * ONLY "moneyline". Every series in COPY_SERIES is a game-winner / moneyline
 * series (KXMLBGAME, KXNFLGAME, KXEPLGAME, KXATPMATCH, …), so a moneyline is
 * the only Polymarket bet those tickers actually represent.
 *
 * The other kinds are FUTURE LANES, not impossibilities — Kalshi really does
 * list spread, total and period series (KXNFLSPREAD-style, KXNHL2PTOTAL and
 * KXWNBA1QWINNER were all observed live on 2026-10-04). Each needs its own
 * matcher that pairs the Polymarket LINE with the Kalshi line, not just the
 * competitor name, and until one exists the honest answer is to skip.
 */
export function isCopyableKind(kind: PolyMarketKind): boolean {
  return kind === "moneyline";
}

/**
 * The entry point callers should use: classify the Polymarket market FIRST,
 * refuse anything that is not a full-game winner, and only then run the name /
 * code match.
 *
 * Refusing before any name matching is the whole point. matchByName is perfectly
 * happy to hand back a moneyline for a spread bet, so the gate cannot sit after
 * it or read its result — it has to stop the call from happening.
 */
export function matchOutcomeGuarded(args: {
  outcome: string;
  slug?: string | null;
  title?: string | null;
  candidates: KalshiMarketLite[];
  matcher: "code" | "name";
  now?: Date;
}):
  | { ok: true; match: Match }
  | { ok: false; reason: "market_kind_not_copyable" | "no_name_match"; kind: PolyMarketKind } {
  const kind = classifyPolyMarket({ slug: args.slug, title: args.title });
  if (!isCopyableKind(kind)) return { ok: false, reason: "market_kind_not_copyable", kind };

  const match = matchOutcome(args.outcome, args.candidates, args.matcher, args.now ?? new Date());
  if (!match) return { ok: false, reason: "no_name_match", kind };
  return { ok: true, match };
}
