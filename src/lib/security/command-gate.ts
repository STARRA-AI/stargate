/**
 * Destructive-command confirmation gate.
 * Deterministic regex — a safety gate must not be persuadable by the model.
 * Used when any shell/tool path accepts operator- or model-supplied commands.
 */

import { randomBytes } from "crypto";

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+|.*\*)/i,
  /\bsudo\b/i,
  /\bgit\s+push\b.*(--force|-f\b)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/i,
  /\bmkfs\./i,
  /\bdd\s+if=/i,
  /\bkill\s+(-9\s+)?1\b/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /(curl|wget)[^|;&]*\|\s*(ba)?sh/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bchown\s+-R\b/i,
  /^\s*>\s*\S/m,
  /\blaunchctl\s+(unload|remove|bootout)\b/i,
  /\bdefaults\s+delete\b/i,
  /\bdiskutil\s+(erase|partition|reformat)/i,
  /\bsecurity\s+(delete|dump)-keychain\b/i,
  /:\(\)\s*\{.*\};\s*:/,
];

type Pending = { cmd: string; issuedAt: number };
const PENDING = new Map<string, Pending>();
const TTL_SEC = 300;

export type CommandClass = "safe" | "destructive";

export function classifyCommand(cmd: string): CommandClass {
  if (DESTRUCTIVE.some((rx) => rx.test(cmd))) return "destructive";
  for (const segment of cmd.split(/[;&|]+/)) {
    const seg = segment.trim();
    if (seg && DESTRUCTIVE.some((rx) => rx.test(seg))) return "destructive";
  }
  return "safe";
}

export function requestConfirmation(cmd: string): string {
  const token = randomBytes(3).toString("hex");
  PENDING.set(token, { cmd, issuedAt: Date.now() });
  return token;
}

/** Return the command if token is valid and fresh, else null. */
export function confirm(token: string): string | null {
  const entry = PENDING.get(token);
  if (!entry) return null;
  PENDING.delete(token);
  if (Date.now() - entry.issuedAt > TTL_SEC * 1000) return null;
  return entry.cmd;
}

/** Clear pending map (tests). */
export function clearPendingConfirmations() {
  PENDING.clear();
}

/**
 * Gate a command before execution.
 * Returns { ok: true, cmd } to run, or { ok: false, message } held for confirm.
 */
export function gateCommand(cmd: string):
  | { ok: true; cmd: string }
  | { ok: false; message: string; token: string } {
  if (classifyCommand(cmd) === "safe") {
    return { ok: true, cmd };
  }
  const token = requestConfirmation(cmd);
  return {
    ok: false,
    token,
    message:
      `HELD FOR CONFIRMATION — this command is destructive:\n  ${cmd}\n` +
      `Operator must explicitly approve with: confirm ${token}`,
  };
}
