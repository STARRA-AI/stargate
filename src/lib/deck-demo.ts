/** Cosmetic demo data for HUD panels — matches Desktop STARGATE design. */

export type Position = {
  market: string;
  side: "YES" | "NO";
  price: number;
  pnl: number;
};

export type TankVote = {
  name: string;
  vote: "LONG" | "SHORT" | "HOLD";
  conf: number;
};

export type SiteStat = {
  label: string;
  value: string | number;
  delta: string;
};

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

export type DeckDemo = {
  balance: number;
  pnlToday: number;
  exposure: number;
  positions: Position[];
  tank: TankVote[];
  siteStats: SiteStat[];
  proposals: Proposal[];
  ventures: Venture[];
};

export const INITIAL_DEMO: DeckDemo = {
  balance: 4825.91,
  pnlToday: 111.68,
  exposure: 12.4,
  positions: [
    { market: "FED CUT ≥25BPS · MAR", side: "YES", price: 62, pnl: 142.0 },
    { market: "CPI YoY > 3.2% · FEB", side: "NO", price: 41, pnl: -18.5 },
    { market: "BTC > $100K · JUL 31", side: "YES", price: 34, pnl: 61.2 },
    { market: "GPT-6 RELEASE · Q3", side: "NO", price: 55, pnl: 27.8 },
  ],
  tank: [
    { name: "CLAUDE", vote: "LONG", conf: 92 },
    { name: "GPT", vote: "LONG", conf: 87 },
    { name: "GEMINI", vote: "LONG", conf: 74 },
    { name: "GROK", vote: "LONG", conf: 81 },
  ],
  siteStats: [
    { label: "ACTIVE BOTS", value: 38, delta: "+3" },
    { label: "USERS 24H", value: 214, delta: "+11%" },
    { label: "TRADES 24H", value: 1042, delta: "+6%" },
    { label: "UPTIME", value: "99.97%", delta: "" },
  ],
  proposals: [
    {
      id: 1,
      tag: "[PROFIT]",
      text: "Raise Pro tier to $88/mo — churn model says <2% impact, +$1.8K MRR.",
      impact: "est. +$1,800 MRR",
    },
    {
      id: 2,
      tag: "[REPO]",
      text: "Kalshi scanner loops serially — parallelize for 4× scan rate. Diff ready.",
      impact: "PR ready for review",
    },
    {
      id: 3,
      tag: "[VENTURE]",
      text: "Spin up landing page for STARRA Signals — sell Think Tank picks as a $19/mo feed.",
      impact: "new revenue line",
    },
  ],
  ventures: [
    { name: "Dragon Tradar", status: "LIVE", color: "#6ee7a0" },
    { name: "STARRA Signals", status: "PROPOSED", color: "#ffd166" },
    { name: "Venture Slot 03", status: "SCOUTING", color: "#7a63a8" },
  ],
};

export const CHIPS = ["BUILD", "SCAN", "DEPLOY", "REPORT", "SITE"] as const;

export function fmtMoney(n: number) {
  return (
    (n < 0 ? "-$" : "$") +
    Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function fmtPnl(n: number) {
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
}

export function tankConsensus(tank: TankVote[]) {
  const longs = tank.filter((t) => t.vote === "LONG").length;
  const avg = Math.round(tank.reduce((s, t) => s + t.conf, 0) / tank.length);
  return `${longs}/${tank.length} LONG · ${avg}% AVG`;
}
