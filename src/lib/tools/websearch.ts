/**
 * Zero-key web search via DuckDuckGo's HTML endpoint. The Instant-Answer API
 * returns little for real queries; the HTML results page has real titles +
 * snippets. A real Chrome User-Agent is required (bot-detection page otherwise).
 *
 * Results are UNTRUSTED web content — the caller MUST fence them before they
 * reach the model (see fenceUntrusted). The query only ever hits DuckDuckGo's
 * fixed host, so there is no SSRF surface.
 */

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type WebResult = { title: string; url: string; snippet: string };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function realUrl(href: string): string {
  // DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded target>
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export async function webSearch(
  query: string,
  limit = 5,
): Promise<{ ok: boolean; results: WebResult[]; error?: string }> {
  const q = query.trim();
  if (!q) return { ok: false, results: [], error: "empty query" };
  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        headers: { "User-Agent": CHROME_UA, "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) return { ok: false, results: [], error: `ddg ${res.status}` };
    const html = await res.text();

    const anchors = [
      ...html.matchAll(
        /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      ),
    ];
    const snippets = [
      ...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g),
    ].map((m) => stripTags(m[1]));

    const results: WebResult[] = [];
    for (let i = 0; i < anchors.length && results.length < limit; i++) {
      const title = stripTags(anchors[i][2]);
      if (!title) continue;
      results.push({
        title,
        url: realUrl(anchors[i][1]),
        snippet: snippets[results.length] ?? "",
      });
    }
    return {
      ok: results.length > 0,
      results,
      error: results.length ? undefined : "no results parsed",
    };
  } catch (e) {
    return {
      ok: false,
      results: [],
      error: e instanceof Error ? e.message : "search failed",
    };
  }
}

/** Compact context block for the model (fence it before use). */
export function formatWebResults(query: string, results: WebResult[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   ${r.snippet.slice(0, 160)}\n   ${r.url}`,
    )
    .join("\n");
  return `WEB SEARCH RESULTS for "${query}" (live, ${today}) — ground your answer in these and name the source; report what they say, do not fabricate:\n${lines}`;
}

/**
 * Weather via wttr.in (no key, JSON). DDG snippets don't carry a live temp, so
 * weather questions route here instead. Returns null location if no clear place
 * is named (we don't guess a location).
 */
export function weatherLocation(message: string): string | null {
  const m = message.trim();
  if (!/\bweather\b/i.test(m)) return null;
  const loc = m.match(
    /\bweather\b(?:\s+(?:like|today|right now))?\s+(?:in|for|at|near)\s+([A-Za-z][A-Za-z\s,.'-]*?)(?:\s+(?:today|right now|now|this week))?\s*[?.!]*$/i,
  );
  return loc ? loc[1].trim() : null;
}

export async function getWeather(
  location: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const loc = location.trim();
  if (!loc) return { ok: false, error: "no location" };
  try {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(loc)}?format=j1`,
      { headers: { "User-Agent": "curl/8" }, signal: AbortSignal.timeout(7000) },
    );
    if (!res.ok) return { ok: false, error: `wttr ${res.status}` };
    const d = (await res.json()) as {
      current_condition?: {
        temp_F?: string;
        temp_C?: string;
        FeelsLikeF?: string;
        humidity?: string;
        weatherDesc?: { value: string }[];
      }[];
      nearest_area?: {
        areaName?: { value: string }[];
        region?: { value: string }[];
      }[];
    };
    const c = d.current_condition?.[0];
    if (!c) return { ok: false, error: "no conditions" };
    const a = d.nearest_area?.[0];
    const place =
      [a?.areaName?.[0]?.value, a?.region?.[0]?.value]
        .filter(Boolean)
        .join(", ") || loc;
    const desc = c.weatherDesc?.[0]?.value ?? "";
    const text = `LIVE WEATHER for ${place}: ${c.temp_F}°F (${c.temp_C}°C), ${desc}, feels like ${c.FeelsLikeF}°F, humidity ${c.humidity}%. Report this to Classic.`;
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "weather failed",
    };
  }
}

/**
 * Decide whether a message needs a live web lookup and extract the query.
 * Conservative on purpose — only explicit search requests or clearly
 * current/time-sensitive questions trigger a fetch (no per-message cost).
 */
export function webSearchQuery(message: string): string | null {
  const m = message.trim();
  const explicit = m.match(
    /\b(?:search (?:the web )?for|look up|web search|google)\s+(.+)/i,
  );
  if (explicit) return explicit[1].replace(/[?.!]+$/, "").trim();

  const currentSignal = /\b(latest|current|today'?s|right now|as of (?:today|now)|this week)\b/i;
  const factSignal =
    /\b(price|news|weather|stock|score|rate|market|release|version|who won|headlines?)\b/i;
  if (currentSignal.test(m) && factSignal.test(m)) {
    return m.replace(/[?.!]+$/, "").trim();
  }
  if (/\bwhat'?s the (?:weather|price|news|latest)\b/i.test(m)) {
    return m.replace(/[?.!]+$/, "").trim();
  }
  return null;
}
