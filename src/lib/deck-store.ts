import { promises as fs } from "fs";
import path from "path";
import { pushFeed } from "@/lib/feed";

/**
 * Persistent deck state — proposals and ventures live in data/deck.json
 * so decisions survive restarts. Approving a proposal logs it to the
 * ops feed and archives it with a timestamp.
 */

export type Proposal = {
  id: number;
  tag: string;
  text: string;
  impact: string;
};

export type Venture = {
  name: string;
  status: string;
  color: string;
};

type DeckState = {
  proposals: Proposal[];
  archive: (Proposal & { decidedAt: string; decision: string })[];
  ventures: Venture[];
  nextId: number;
};

const DECK_PATH = path.join(process.cwd(), "data", "deck.json");

const SEED: DeckState = {
  proposals: [
    {
      id: 1,
      tag: "[PROFIT]",
      text: "Link Kalshi API keys — Dragon Tradar goes fully live with real balance and positions.",
      impact: "real portfolio on deck",
    },
    {
      id: 2,
      tag: "[REPO]",
      text: "Link one cloud model key (Claude/GPT/Gemini/Grok) — Think Tank gets a second opinion beyond the local brain.",
      impact: "stronger consensus",
    },
    {
      id: 3,
      tag: "[VENTURE]",
      text: "Point Site Telemetry at a dragontradar.com stats endpoint — bots/users/trades go live.",
      impact: "real site numbers",
    },
  ],
  archive: [],
  ventures: [
    { name: "Dragon Tradar", status: "LIVE", color: "#6ee7a0" },
    { name: "STARRA Signals", status: "PROPOSED", color: "#ffd166" },
    { name: "Venture Slot 03", status: "SCOUTING", color: "#7a63a8" },
  ],
  nextId: 4,
};

async function load(): Promise<DeckState> {
  try {
    const raw = await fs.readFile(DECK_PATH, "utf8");
    return JSON.parse(raw) as DeckState;
  } catch {
    await save(SEED);
    return structuredClone(SEED);
  }
}

async function save(state: DeckState) {
  await fs.mkdir(path.dirname(DECK_PATH), { recursive: true });
  await fs.writeFile(DECK_PATH, JSON.stringify(state, null, 2), "utf8");
}

export async function getDeck() {
  return load();
}

export async function decideProposal(
  id: number,
  decision: "approve" | "later",
): Promise<DeckState> {
  const state = await load();
  const pr = state.proposals.find((p) => p.id === id);
  if (pr) {
    state.proposals = state.proposals.filter((p) => p.id !== id);
    state.archive.unshift({
      ...pr,
      decidedAt: new Date().toISOString(),
      decision,
    });
    state.archive = state.archive.slice(0, 50);
    await save(state);
    pushFeed(
      "EXEC",
      decision === "approve"
        ? `Approved ${pr.tag} ${pr.text.split("—")[0].trim()}`
        : `Deferred ${pr.tag} proposal`,
    );
  }
  return state;
}
