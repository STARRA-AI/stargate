import { getKey } from "@/lib/keys";
import { ollamaAvailable, ollamaConfig, ollamaHasModel } from "@/lib/llm/ollama";
import { pushFeed } from "@/lib/feed";
import type { WatchMarket } from "@/lib/kalshi";

/**
 * Think Tank — each linked model votes LONG / SHORT / HOLD on the
 * highest-volume watched market. Local Ollama always participates when up;
 * cloud models join once their keys are linked in Settings.
 */

export type TankVote = {
  name: string;
  vote: "LONG" | "SHORT" | "HOLD" | "LINK" | "…";
  conf: number;
};

type TankState = {
  at: number;
  topic: string;
  votes: TankVote[];
  refreshing: boolean;
};

const g = globalThis as unknown as { __tankState?: TankState };
const TTL_MS = 10 * 60_000;

const VOTE_PROMPT = (topic: string) =>
  `Prediction market: ${topic}. ` +
  `Should a trader go LONG (buy YES), SHORT (buy NO), or HOLD? ` +
  `Reply with ONLY strict JSON like {"vote":"LONG","conf":72} where conf is 0-100. No other text.`;

function parseVote(raw: string): { vote: TankVote["vote"]; conf: number } {
  const match = raw.match(/\{[^}]*\}/);
  if (match) {
    try {
      const j = JSON.parse(match[0]) as { vote?: string; conf?: number };
      const v = (j.vote || "").toUpperCase();
      if (v === "LONG" || v === "SHORT" || v === "HOLD") {
        return {
          vote: v,
          conf: Math.min(99, Math.max(1, Math.round(j.conf ?? 50))),
        };
      }
    } catch {
      /* fall through */
    }
  }
  const up = raw.toUpperCase();
  if (up.includes("LONG")) return { vote: "LONG", conf: 60 };
  if (up.includes("SHORT")) return { vote: "SHORT", conf: 60 };
  return { vote: "HOLD", conf: 50 };
}

async function askOllama(topic: string): Promise<TankVote | null> {
  const up = await ollamaAvailable();
  if (!up || !(await ollamaHasModel())) return null;
  const { base, model } = ollamaConfig();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: VOTE_PROMPT(topic) }],
      stream: false,
      options: { num_predict: 60, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { message?: { content?: string } };
  const parsed = parseVote(data.message?.content ?? "");
  return { name: "LOCAL", ...parsed };
}

async function askAnthropic(topic: string): Promise<TankVote | null> {
  const key = await getKey("anthropic");
  if (!key) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 60,
      messages: [{ role: "user", content: VOTE_PROMPT(topic) }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: { text?: string }[] };
  const parsed = parseVote(data.content?.[0]?.text ?? "");
  return { name: "CLAUDE", ...parsed };
}

async function askOpenAiCompatible(
  name: string,
  url: string,
  key: string,
  model: string,
  topic: string,
): Promise<TankVote | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 60,
      messages: [{ role: "user", content: VOTE_PROMPT(topic) }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const parsed = parseVote(data.choices?.[0]?.message?.content ?? "");
  return { name, ...parsed };
}

async function askGemini(topic: string): Promise<TankVote | null> {
  const key = await getKey("gemini");
  if (!key) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: VOTE_PROMPT(topic) }] }],
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parsed = parseVote(
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
  );
  return { name: "GEMINI", ...parsed };
}

async function refreshVotes(topic: string) {
  const state = g.__tankState;
  if (!state || state.refreshing) return;
  state.refreshing = true;

  try {
    const [openaiKey, xaiKey] = await Promise.all([
      getKey("openai"),
      getKey("xai"),
    ]);

    const tasks: Promise<TankVote | null>[] = [
      askOllama(topic),
      askAnthropic(topic),
      askGemini(topic),
      openaiKey
        ? askOpenAiCompatible(
            "GPT",
            "https://api.openai.com/v1/chat/completions",
            openaiKey,
            "gpt-4o-mini",
            topic,
          )
        : Promise.resolve(null),
      xaiKey
        ? askOpenAiCompatible(
            "GROK",
            "https://api.x.ai/v1/chat/completions",
            xaiKey,
            "grok-3-mini",
            topic,
          )
        : Promise.resolve(null),
    ];

    const settled = await Promise.allSettled(tasks);
    const votes = settled
      .filter(
        (r): r is PromiseFulfilledResult<TankVote> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value);

    const unlinked: TankVote[] = [];
    const linkedNames = new Set(votes.map((v) => v.name));
    for (const [name, keyed] of [
      ["CLAUDE", await getKey("anthropic")],
      ["GPT", openaiKey],
      ["GEMINI", await getKey("gemini")],
      ["GROK", xaiKey],
    ] as const) {
      if (!keyed && !linkedNames.has(name)) {
        unlinked.push({ name, vote: "LINK", conf: 0 });
      }
    }

    g.__tankState = {
      at: Date.now(),
      topic,
      votes: [...votes, ...unlinked],
      refreshing: false,
    };
    if (votes.length) {
      pushFeed("THNK", `Think Tank voted on: ${topic.slice(0, 60)}`);
    }
  } catch {
    state.refreshing = false;
  }
}

export function getTank(topMarket: WatchMarket | null): {
  topic: string;
  votes: TankVote[];
  freshAt: number;
} {
  const topic = topMarket
    ? `${topMarket.title} — ${topMarket.subtitle} (YES at ${topMarket.lastCents}¢)`
    : "Bitcoin above $100K by year end";

  if (!g.__tankState) {
    g.__tankState = { at: 0, topic, votes: [], refreshing: false };
  }

  const state = g.__tankState;
  const stale = Date.now() - state.at > TTL_MS || state.topic !== topic;
  if (stale && !state.refreshing) {
    state.topic = topic;
    void refreshVotes(topic);
  }

  return { topic, votes: state.votes, freshAt: state.at };
}
