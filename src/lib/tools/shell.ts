/**
 * Real shell executor for STARRA's run_shell tool + the `run:` chat path.
 *
 * Safety model (verified against src/lib/security/command-gate.ts):
 *  - Every command passes gateCommand() first: destructive patterns (rm -rf,
 *    sudo, dd, mkfs, shutdown, curl|sh, chmod 777, …) are HELD and require an
 *    explicit `confirm <token>` from the operator. Safe commands run directly.
 *  - Output is redact()ed so secrets/keys never stream back.
 *  - 30s timeout + 1MB output cap so a runaway command can't wedge the deck.
 *  - Network exposure is gated by the CALLER (the chat route only runs this for
 *    requests that arrived over localhost) — this module trusts its caller.
 *
 * Honest limitation: commands needing an interactive password (anything under
 * `sudo`, e.g. `mkcert -install`) fail here — a spawned process has no TTY, so
 * sudo returns "a terminal is required to read the password". Those must be run
 * by the operator in a real terminal.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { gateCommand } from "@/lib/security/command-gate";
import { redact } from "@/lib/security/redact";

const execAsync = promisify(exec);

/** Execute WITHOUT the gate (caller has already gated/confirmed). Internal. */
async function execRaw(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      shell: "/bin/bash",
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return redact(`$ ${cmd}\n\n${out || "(no output)"}`);
  } catch (e) {
    const err = e as {
      message?: string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: number;
    };
    const body = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const reason = err.killed
      ? "timed out after 30s"
      : `exited with error${err.code != null ? ` (code ${err.code})` : ""}`;
    return redact(
      `$ ${cmd}\n\nCommand ${reason}.\n${body || err.message || ""}`.trim(),
    );
  }
}

/** Gate then run a command. Destructive → returns the HELD/confirm message. */
export async function runShellCommand(cmd: string): Promise<string> {
  const trimmed = cmd.trim();
  if (!trimmed) return "Copy. Empty command.";
  const gated = gateCommand(trimmed);
  if (!gated.ok) return gated.message; // held; operator must `confirm <token>`
  return execRaw(gated.cmd);
}

/** Redeem a confirmation token and run the (previously destructive) command. */
export async function confirmAndRun(token: string): Promise<string> {
  const { confirm } = await import("@/lib/security/command-gate");
  const cmd = confirm(token);
  if (!cmd) return "Confirmation token invalid or expired.";
  return execRaw(cmd);
}
