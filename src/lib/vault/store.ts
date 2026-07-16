import { promises as fs } from "fs";
import path from "path";

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
  return JSON.parse(await fs.readFile(DATA_PATH, "utf8")) as VaultStore;
}

export async function saveVault(store: VaultStore) {
  await ensure();
  await fs.writeFile(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
  return store;
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
  if (
    mime.startsWith("text/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".csv")
  ) {
    text = buffer.toString("utf8");
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
  } else {
    text = buffer.toString("utf8");
  }

  const id = `doc-${Date.now()}`;
  const filePath = path.join(UPLOAD_DIR, `${id}-${name.replace(/[^\w.-]/g, "_")}`);
  await fs.writeFile(filePath, buffer);

  const doc: VaultDoc = {
    id,
    name,
    mime,
    text: text.slice(0, 50000),
    facts: extractFacts(text),
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
  return [
    "VAULT FACTS",
    ...top.map(
      (d) =>
        `${d.name}: ${d.facts.slice(0, 5).join(" · ") || d.text.slice(0, 200)}`,
    ),
  ].join("\n");
}
