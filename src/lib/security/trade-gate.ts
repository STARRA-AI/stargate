/**
 * Trade-action confirmation gate for STARGATE ↔ OpenAlice bridge.
 * STARRA never relays venue-mutating broker writes without explicit operator confirm.
 * Even after confirm, execution completes in OpenAlice — not autonomously from STARGATE.
 */

import { randomBytes } from "crypto";

const EXECUTE_PATTERNS: RegExp[] = [
  /\b(buy|sell|short|cover)\b/i,
  /\bplace[_\s-]?order\b/i,
  /\bsubmit[_\s-]?order\b/i,
  /\bcancel[_\s-]?order\b/i,
  /\bpush[_\s-]?commit\b/i,
  /\bstage[_\s-]?(order|trade|commit)\b/i,
  /\bexecute[_\s-]?(order|trade|commit)\b/i,
  /\btrading[_\s-]?as[_\s-]?git[_\s-]?push\b/i,
  /\bmarket[_\s-]?order\b/i,
  /\blimit[_\s-]?order\b/i,
];

type Pending = { action: string; issuedAt: number };
const PENDING = new Map<string, Pending>();
const TTL_SEC = 300;

export type TradeActionClass = "read" | "execute";

export function classifyTradeAction(action: string): TradeActionClass {
  const normalized = action.trim();
  if (!normalized) return "read";
  if (EXECUTE_PATTERNS.some((rx) => rx.test(normalized))) return "execute";
  return "read";
}

export function requestTradeConfirmation(action: string): string {
  const token = randomBytes(3).toString("hex");
  PENDING.set(token, { action, issuedAt: Date.now() });
  return token;
}

export function confirmTrade(token: string): string | null {
  const entry = PENDING.get(token);
  if (!entry) return null;
  PENDING.delete(token);
  if (Date.now() - entry.issuedAt > TTL_SEC * 1000) return null;
  return entry.action;
}

export function clearPendingTradeConfirmations() {
  PENDING.clear();
}

export function gateTradeAction(action: string):
  | { ok: true; action: string }
  | { ok: false; message: string; token: string } {
  if (classifyTradeAction(action) === "read") {
    return { ok: true, action };
  }
  const token = requestTradeConfirmation(action);
  return {
    ok: false,
    token,
    message:
      `HELD FOR CONFIRMATION — trade action blocked until operator approves:\n  ${action}\n` +
      `Approve with confirm token: ${token}\n` +
      `STARGATE logs intent only — complete execution in OpenAlice Trading-as-Git.`,
  };
}
