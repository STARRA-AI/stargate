/**
 * Reading the deck's .env.local directly. This service is not a Next.js app and
 * must not pull the deck's runtime in just to read a handful of keys.
 *
 * Note the parser tolerates what the Twilio console actually gives you — values
 * with spaces and parentheses, e.g. `(615) 437-4490` — because a loader that
 * silently drops those is worse than one that hands them on to be validated.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = path.join(HERE, "..", "..", ".env.local");

export function loadEnvFile(p = ENV_FILE) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** File first, real environment wins — so a shell override always beats the file. */
export const ENV = { ...loadEnvFile(), ...process.env };
