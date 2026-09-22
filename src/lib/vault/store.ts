import { promises as fs } from "fs";
import path from "path";
import { redact } from "@/lib/security/redact";
import { fenceUntrusted } from "@/lib/security/fencing";
import { docxToText, officeKind, xlsxToText } from "@/lib/vault/office";

export type VaultDoc = {
  id: string;
  name: string;
  mime: string;
  text: string;
  facts: string[];
  at: string;
};

type VaultStore = { docs: VaultDoc[] };

const DATA_PATH = path.join(process.cwd(), "data", "vault.json");
const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

async function ensure() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(DATA_PATH);
  } catch {
    await fs.writeFile(DATA_PATH, JSON.stringify({ docs: [] }, null, 2), "utf8");
  }
}

export async function getVault(): Promise<VaultStore> {
  await ensure();
  // Harden against a corrupt data/vault.json: this runs in the chat route's
  // top-level Promise.all (outside its try/catch), and vault.docs is fed
  // straight into vaultForPrompt(docs.length…), so a bad parse or a missing
  // docs array would 500 the brain. Always return { docs: [] } on failure.
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_PATH, "utf8")) as Partial<VaultStore>;
    return { docs: Array.isArray(parsed.docs) ? parsed.docs : [] };
  } catch {
    return { docs: [] };
  }
}

export async function saveVault(store: VaultStore) {
  await ensure();
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
}

/**
 * Decode as utf8, but refuse to store the result if it is plainly not text.
 * Returning an honest sentence beats storing mojibake she will read back as
 * fact — the failure mode that let .docx look like it worked for two months.
 */
function decodeOrRefuse(buffer: Buffer, name: string): string {
  const decoded = buffer.toString("utf8");
  if (!looksBinary(decoded)) return decoded;
  return `[Stored: ${name}. It is not text, so nothing was extracted — send PDF, TXT, MD, CSV, DOCX or XLSX.]`;
}

/**
 * Is this utf8 decode actually text? Decoding binary yields U+FFFD replacement
 * characters and NULs in quantity; real text, including heavily accented or CJK
 * text, yields effectively none. The threshold is deliberately loose — one
 * stray replacement char in a long file is a bad byte, not a binary.
 */
export function looksBinary(decoded: string): boolean {
  if (decoded.length === 0) return false;
  const sample = decoded.slice(0, 8192);
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0)!;
    // U+FFFD, NUL, and C0 controls that no text file uses (tab/LF/CR excluded).
    if (c === 0xfffd || c === 0x00 || (c < 0x09) || (c > 0x0d && c < 0x20)) bad++;
  }
  return bad / [...sample].length > 0.05;
}

function extractFacts(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 20 && l.length < 240);
  const facts = lines.slice(0, 12);
  if (facts.length === 0 && text.trim()) {
    facts.push(text.trim().slice(0, 200));
  }
  return facts;
}

export async function ingestTextFile(
  name: string,
  mime: string,
  buffer: Buffer,
): Promise<VaultDoc> {
  await ensure();
  let text = "";
  const lower = name.toLowerCase();
  const office = officeKind(name);
  if (
    mime.startsWith("text/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".csv")
  ) {
    // Guarded even here. MEASURED 2026-09-22: a PNG renamed to notes.txt takes
    // this branch (the name AND the mime both say text) and stored 12,032 chars
    // of mojibake as her facts. The name is a claim, not a fact.
    text = decodeOrRefuse(buffer, name);
  } else if (lower.endsWith(".pdf")) {
    try {
      const mod = await import("pdf-parse");
      const pdfParse =
        (mod as { default?: (b: Buffer) => Promise<{ text: string }> }).default ??
        (mod as unknown as (b: Buffer) => Promise<{ text: string }>);
      const parsed = await pdfParse(buffer);
      text = parsed.text || "";
    } catch {
      text = `[PDF stored: ${name}. Text extraction unavailable — re-upload as TXT/MD if needed.]`;
    }
  } else if (office !== null) {
    // .docx / .xlsx are ZIP containers. They used to fall through to the utf8
    // `else` below, which stored compressed bytes as her facts while the Vault
    // page's accept list advertised both — 200 OK with garbage inside it.
    try {
      text = office === "docx" ? await docxToText(buffer) : await xlsxToText(buffer);
      if (!text.trim()) {
        text = `[${office.toUpperCase()} stored: ${name}. It parsed but held no readable text — if it is mostly images, export it as PDF.]`;
      }
    } catch {
      text = `[${office.toUpperCase()} stored: ${name}. The archive could not be read — re-save it from the app, or export as PDF/TXT.]`;
    }
  } else {
    // Unknown extension. utf8 is RIGHT for his code and config (.ts, .json,
    // .yml, .log carry no text/* mime but are plain text) and WRONG for a
    // binary, so the result is checked rather than trusted.
    text = decodeOrRefuse(buffer, name);
  }

  // ★ Date.now() ALONE COLLIDES. Two uploads in the same millisecond produced
  // the same id AND the same raw filename, so one silently overwrote the other's
  // file while both rows stayed in the store. The suffix makes the pair unique.
  const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(UPLOAD_DIR, `${id}-${name.replace(/[^\w.-]/g, "_")}`);
  await fs.writeFile(filePath, buffer);

  const doc: VaultDoc = {
    id,
    name,
    mime,
    text: redact(text.slice(0, 50000)),
    facts: extractFacts(text).map((f) => redact(f)),
    at: new Date().toISOString(),
  };

  const store = await getVault();
  store.docs.unshift(doc);
  await saveVault(store);
  return doc;
}

export function vaultForPrompt(docs: VaultDoc[], query: string): string {
  if (docs.length === 0) return "VAULT: empty";
  const q = query.toLowerCase();
  const ranked = [...docs].sort((a, b) => {
    const as = a.text.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) ? 1 : 0;
    const bs = b.text.toLowerCase().includes(q) || b.name.toLowerCase().includes(q) ? 1 : 0;
    return bs - as;
  });
  const top = ranked.slice(0, 3);
  const body = [
    "VAULT FACTS",
    ...top.map(
      (d) =>
        `${d.name}: ${d.facts.slice(0, 5).join(" · ") || d.text.slice(0, 200)}`,
    ),
  ].join("\n");
  return fenceUntrusted(body, "vault");
}
