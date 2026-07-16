/**
 * Obsidian vault path resolution + jail.
 * Layer 1 (long-term memory): plain local markdown under a gitignored vault root.
 * Never resolve paths outside the vault — sovereignty + path safety.
 */

import path from "path";
import { promises as fs } from "fs";

const ROOT = process.cwd();

/** Default vault lives under gitignored data/ — never the app repo. */
export const DEFAULT_VAULT_REL = path.join("data", "vault");

export function resolveVaultRoot(override?: string): string {
  const fromEnv =
    override?.trim() ||
    process.env.STARGATE_VAULT_PATH?.trim() ||
    "";
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(ROOT, DEFAULT_VAULT_REL);
}

/**
 * Resolve a note path relative to the vault. Rejects traversal and absolute escapes.
 * Returns absolute path only when it stays under vaultRoot.
 */
export function resolveSafeNotePath(
  vaultRoot: string,
  relativePath: string,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const raw = relativePath.trim().replace(/\\/g, "/");
  if (!raw) {
    return { ok: false, error: "path required" };
  }
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, error: "absolute paths rejected — use vault-relative paths" };
  }
  if (raw.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: "path traversal rejected" };
  }

  let withExt = raw;
  if (!withExt.endsWith(".md") && !withExt.endsWith(".canvas")) {
    withExt = `${withExt}.md`;
  }

  const abs = path.resolve(vaultRoot, withExt);
  const rootResolved = path.resolve(vaultRoot);
  const relToRoot = path.relative(rootResolved, abs);
  if (
    relToRoot.startsWith("..") ||
    path.isAbsolute(relToRoot) ||
    relToRoot === ""
  ) {
    return { ok: false, error: "path escapes vault root" };
  }

  return { ok: true, abs, rel: relToRoot.replace(/\\/g, "/") };
}

export async function vaultExists(vaultRoot?: string): Promise<boolean> {
  const root = vaultRoot ?? resolveVaultRoot();
  try {
    const st = await fs.stat(root);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function vaultRootRelative(vaultRoot: string): string {
  const rel = path.relative(ROOT, vaultRoot);
  if (!rel || rel.startsWith("..")) return vaultRoot;
  return rel.replace(/\\/g, "/") || DEFAULT_VAULT_REL;
}
