/**
 * Note ops for the Obsidian-style vault.
 * Overwrite / delete are gated — no autonomous destructive rewrites.
 */

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { resolveSafeNotePath, resolveVaultRoot } from "./paths";

export type NoteMeta = {
  rel: string;
  title: string;
  bytes: number;
  mtime: string;
};

export type NoteRead = NoteMeta & {
  content: string;
};

export type SearchHit = {
  rel: string;
  title: string;
  line: number;
  snippet: string;
};

type PendingWrite = {
  mode: "overwrite" | "delete";
  rel: string;
  content?: string;
  issuedAt: number;
};

const PENDING = new Map<string, PendingWrite>();
const TTL_MS = 300_000;
const MAX_READ_CHARS = 40_000;
const MAX_LIST = 200;

function titleFromRel(rel: string): string {
  const base = path.basename(rel, path.extname(rel));
  return base.replace(/[-_]/g, " ");
}

function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1]?.trim();
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

export function parseWikilinks(text: string): string[] {
  return extractWikilinks(text);
}

async function walkMarkdown(
  dir: string,
  vaultRoot: string,
  acc: NoteMeta[],
): Promise<void> {
  if (acc.length >= MAX_LIST) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (acc.length >= MAX_LIST) break;
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkMarkdown(abs, vaultRoot, acc);
      continue;
    }
    if (!ent.name.endsWith(".md") && !ent.name.endsWith(".canvas")) continue;
    const st = await fs.stat(abs);
    const rel = path.relative(vaultRoot, abs).replace(/\\/g, "/");
    acc.push({
      rel,
      title: titleFromRel(rel),
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
}

export async function listNotes(
  vaultRoot?: string,
  prefix?: string,
): Promise<NoteMeta[]> {
  const root = vaultRoot ?? resolveVaultRoot();
  const start = prefix
    ? path.join(root, prefix.replace(/^\/+/, "").replace(/\.\./g, ""))
    : root;
  // Ensure start stays under root
  const relStart = path.relative(root, path.resolve(start));
  if (relStart.startsWith("..") || path.isAbsolute(relStart)) {
    return [];
  }
  const acc: NoteMeta[] = [];
  await walkMarkdown(path.resolve(start), root, acc);
  acc.sort((a, b) => a.rel.localeCompare(b.rel));
  return acc;
}

export async function readNote(
  relativePath: string,
  vaultRoot?: string,
): Promise<{ ok: true; note: NoteRead } | { ok: false; error: string }> {
  const root = vaultRoot ?? resolveVaultRoot();
  const safe = resolveSafeNotePath(root, relativePath);
  if (!safe.ok) return safe;
  try {
    const raw = await fs.readFile(safe.abs, "utf8");
    const st = await fs.stat(safe.abs);
    return {
      ok: true,
      note: {
        rel: safe.rel,
        title: titleFromRel(safe.rel),
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        content: raw.slice(0, MAX_READ_CHARS),
      },
    };
  } catch {
    return { ok: false, error: `note not found: ${safe.rel}` };
  }
}

export async function searchNotes(
  query: string,
  vaultRoot?: string,
  limit = 20,
): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const root = vaultRoot ?? resolveVaultRoot();
  const notes = await listNotes(root);
  const hits: SearchHit[] = [];

  for (const meta of notes) {
    if (hits.length >= limit) break;
    const read = await readNote(meta.rel, root);
    if (!read.ok) continue;
    const lines = read.note.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) break;
      const line = lines[i] ?? "";
      if (line.toLowerCase().includes(q) || meta.rel.toLowerCase().includes(q)) {
        hits.push({
          rel: meta.rel,
          title: meta.title,
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
        break;
      }
    }
  }
  return hits;
}

/**
 * Resolve [[wikilink]] targets to vault-relative paths (best-effort basename match).
 */
export async function resolveWikilink(
  link: string,
  vaultRoot?: string,
): Promise<{ ok: true; rel: string } | { ok: false; error: string; candidates: string[] }> {
  const name = link.trim().replace(/\.md$/i, "");
  if (!name) {
    return { ok: false, error: "empty wikilink", candidates: [] };
  }
  const root = vaultRoot ?? resolveVaultRoot();
  const notes = await listNotes(root);
  const lower = name.toLowerCase();
  const exact = notes.filter(
    (n) =>
      path.basename(n.rel, path.extname(n.rel)).toLowerCase() === lower ||
      n.rel.toLowerCase() === `${lower}.md`,
  );
  if (exact.length === 1) {
    return { ok: true, rel: exact[0]!.rel };
  }
  const fuzzy = notes.filter(
    (n) =>
      n.rel.toLowerCase().includes(lower) ||
      n.title.toLowerCase().includes(lower),
  );
  if (fuzzy.length === 1) {
    return { ok: true, rel: fuzzy[0]!.rel };
  }
  return {
    ok: false,
    error: exact.length > 1 ? "ambiguous wikilink" : "wikilink not found",
    candidates: (exact.length > 1 ? exact : fuzzy).slice(0, 8).map((n) => n.rel),
  };
}

export type WriteMode = "create" | "append" | "overwrite";

export async function writeNote(opts: {
  relativePath: string;
  content: string;
  mode: WriteMode;
  vaultRoot?: string;
  /** Required for overwrite when confirmToken not supplied — returns hold. */
  confirmToken?: string;
}): Promise<
  | { ok: true; rel: string; mode: WriteMode; bytes: number }
  | { ok: false; error: string; token?: string; held?: true }
> {
  const root = opts.vaultRoot ?? resolveVaultRoot();
  const safe = resolveSafeNotePath(root, opts.relativePath);
  if (!safe.ok) return safe;

  let content = opts.content;
  if (typeof content !== "string") {
    return { ok: false, error: "content required" };
  }
  // Soft cap — operator vault, not dump
  if (content.length > 200_000) {
    return { ok: false, error: "content exceeds 200k char cap" };
  }

  if (opts.mode === "overwrite") {
    if (opts.confirmToken) {
      const pending = PENDING.get(opts.confirmToken);
      PENDING.delete(opts.confirmToken);
      if (
        !pending ||
        pending.mode !== "overwrite" ||
        pending.rel !== safe.rel ||
        Date.now() - pending.issuedAt > TTL_MS
      ) {
        return { ok: false, error: "confirm token invalid or expired" };
      }
      content = pending.content ?? content;
    } else {
      let exists = false;
      try {
        await fs.access(safe.abs);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        const token = randomBytes(3).toString("hex");
        PENDING.set(token, {
          mode: "overwrite",
          rel: safe.rel,
          content,
          issuedAt: Date.now(),
        });
        return {
          ok: false,
          held: true,
          token,
          error:
            `HELD FOR CONFIRMATION — overwrite ${safe.rel}. ` +
            `Operator must confirm with token ${token}.`,
        };
      }
      // New file via overwrite → treat as create
    }
  }

  await fs.mkdir(path.dirname(safe.abs), { recursive: true });

  if (opts.mode === "append") {
    let prior = "";
    try {
      prior = await fs.readFile(safe.abs, "utf8");
    } catch {
      prior = "";
    }
    const sep = prior && !prior.endsWith("\n") ? "\n" : "";
    const next = `${prior}${sep}${content}`;
    await fs.writeFile(safe.abs, next, "utf8");
    return { ok: true, rel: safe.rel, mode: "append", bytes: Buffer.byteLength(next) };
  }

  if (opts.mode === "create") {
    try {
      await fs.access(safe.abs);
      return {
        ok: false,
        error: `note already exists: ${safe.rel} — use append or confirm overwrite`,
      };
    } catch {
      /* create */
    }
  }

  await fs.writeFile(safe.abs, content, "utf8");
  return {
    ok: true,
    rel: safe.rel,
    mode: opts.mode === "overwrite" ? "overwrite" : "create",
    bytes: Buffer.byteLength(content),
  };
}

export async function deleteNote(opts: {
  relativePath: string;
  vaultRoot?: string;
  confirmToken?: string;
}): Promise<
  | { ok: true; rel: string }
  | { ok: false; error: string; token?: string; held?: true }
> {
  const root = opts.vaultRoot ?? resolveVaultRoot();
  const safe = resolveSafeNotePath(root, opts.relativePath);
  if (!safe.ok) return safe;

  if (!opts.confirmToken) {
    const token = randomBytes(3).toString("hex");
    PENDING.set(token, {
      mode: "delete",
      rel: safe.rel,
      issuedAt: Date.now(),
    });
    return {
      ok: false,
      held: true,
      token,
      error:
        `HELD FOR CONFIRMATION — delete ${safe.rel}. ` +
        `Operator must confirm with token ${token}.`,
    };
  }

  const pending = PENDING.get(opts.confirmToken);
  PENDING.delete(opts.confirmToken);
  if (
    !pending ||
    pending.mode !== "delete" ||
    pending.rel !== safe.rel ||
    Date.now() - pending.issuedAt > TTL_MS
  ) {
    return { ok: false, error: "confirm token invalid or expired" };
  }

  try {
    await fs.unlink(safe.abs);
    return { ok: true, rel: safe.rel };
  } catch {
    return { ok: false, error: `delete failed: ${safe.rel}` };
  }
}

/** Test helper */
export function clearVaultPending() {
  PENDING.clear();
}
