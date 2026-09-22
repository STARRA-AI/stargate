/**
 * Client-side gate for files dropped on the operator console.
 *
 * The console drop box posts to the EXISTING `/api/vault/upload` route — there
 * is no second ingest path — so everything dropped lands in the same vault the
 * chat turn already reads (`getVault()` in src/app/api/chat/route.ts, surfaced
 * by `vaultForPrompt`). This module is the part with no DOM in it, so it can be
 * tested directly.
 *
 * ★ WHY A DENY-LIST AND NOT AN ACCEPT-LIST. `ingestTextFile`
 * (src/lib/vault/store.ts:69-89) reads text/* + .md/.txt/.csv as utf8, .pdf
 * through pdf-parse, and — this is the part that matters — puts EVERYTHING ELSE
 * through `buffer.toString("utf8")`. That is correct and useful for his code and
 * config files (.ts, .json, .yml, .log have no text/* mime but are plain text),
 * and actively wrong for a zip. So the gate names what is known-binary and lets
 * the rest through, which is what the route already does anyway.
 *
 * ★ .docx AND .xlsx ARE ACCEPTED NOW (2026-09-22). They were refused here
 * because `ingestTextFile` had no branch for either and fell through to utf8,
 * storing zip bytes as her "facts" while the Vault page advertised both. Both
 * are extracted properly now — src/lib/vault/office.ts, verified against real
 * files — so they are no longer in BINARY_EXT. `.doc`/`.xls` (pre-2007 OLE) and
 * `.pptx` (a zip with a different schema) still are, because nothing reads them.
 */

/** Mirrors MAX_UPLOAD_BYTES in src/app/api/vault/upload/route.ts. Checked here
 *  too so an oversized drop reads as a sentence instead of an HTTP 413. */
export const MAX_DROP_BYTES = 20 * 1024 * 1024;

/**
 * Extensions `ingestTextFile` cannot turn into text. Office formats are in here
 * because they are zip containers, not because they are unwelcome — see header.
 */
export const BINARY_EXT = [
  // office formats with NO extraction branch. .docx/.xlsx are deliberately
  // absent — office.ts reads both. .doc/.xls are OLE compound files, .pptx is a
  // zip on a schema nothing here parses, and the Apple formats are bundles.
  "pptx", "doc", "xls", "ppt", "pages", "numbers", "key",
  // images
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp", "tiff", "ico", "psd",
  // audio / video
  "mp3", "wav", "aiff", "m4a", "flac", "ogg", "opus",
  "mp4", "mov", "webm", "mkv", "avi", "m4v",
  // archives and binaries
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "dmg", "pkg", "app", "exe", "dll", "so", "dylib", "bin", "wasm",
  // model / font blobs
  "safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "ttf", "otf", "woff", "woff2",
] as const;

/** Lowercased final extension, or "" when the name has none. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

export type DropVerdict = { ok: true } | { ok: false; why: string };

/**
 * Decide whether to send this file at all. Refusals are SENTENCES, because they
 * are rendered straight into the console next to the filename.
 */
export function checkDroppedFile(file: { name: string; size: number }): DropVerdict {
  if (file.size === 0) return { ok: false, why: "empty file — nothing to read." };
  if (file.size > MAX_DROP_BYTES) {
    return {
      ok: false,
      why: `${fmtBytes(file.size)} is over the ${fmtBytes(MAX_DROP_BYTES)} cap. Split it or send the part that matters.`,
    };
  }
  const ext = extOf(file.name);
  if ((BINARY_EXT as readonly string[]).includes(ext)) {
    return {
      ok: false,
      why: `.${ext} isn't text, so she'd store the raw bytes. Export it as PDF, DOCX, XLSX, TXT, MD or CSV.`,
    };
  }
  return { ok: true };
}

/** "18.4 KB" / "2.1 MB" — short enough to sit on one console row. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the console says after a successful ingest. The fact count is the thing
 * worth reading back: it is what she will actually be able to quote, and zero
 * facts is a real outcome he should see rather than a silent success.
 */
export function ingestedLabel(doc: { facts?: unknown[]; text?: string }): string {
  const facts = doc.facts?.length ?? 0;
  const chars = doc.text?.length ?? 0;
  if (facts === 0 && chars === 0) {
    return "stored, but nothing readable came out of it.";
  }
  if (facts === 0) {
    return `${chars.toLocaleString("en-US")} chars in — no discrete facts, but she can read it.`;
  }
  return `${facts} fact${facts === 1 ? "" : "s"} · ${chars.toLocaleString("en-US")} chars. She can read it now.`;
}

/** Maps the vault route's failure shapes onto something sayable. */
export function uploadFailure(status: number, body: unknown): string {
  const err =
    typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "";
  if (status === 413) return "the deck refused it as too large.";
  if (status === 400) return err ? `${err}.` : "the deck couldn't parse the upload.";
  if (status === 401 || status === 403) return "the deck logged you out — reload and sign back in.";
  return err ? `${err} (HTTP ${status}).` : `the deck answered HTTP ${status}.`;
}
