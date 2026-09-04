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

/** One entry point: use the code table for MLB, names for everything else. */
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
