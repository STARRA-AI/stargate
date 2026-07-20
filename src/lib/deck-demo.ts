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

