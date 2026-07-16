/**
 * PARA + CODE folder scaffold for the local Obsidian vault.
 * Methodology inspiration (jamesmcroft / second-brain community) — adapted for STARRA.
 */

import { promises as fs } from "fs";
import path from "path";
import { resolveVaultRoot, vaultExists } from "./paths";

/** PARA folders + CODE capture inbox. */
export const VAULT_FOLDERS = [
  "0-Inbox",
  "1-Projects",
  "2-Areas",
  "3-Resources",
  "4-Archives",
  "Daily",
  "Canvas",
] as const;

const README = `# STARRA vault

Local long-term memory for this house. Plain markdown. Exportable. Yours.

## Layout (PARA + CODE)

| Folder | Role |
| --- | --- |
| \`0-Inbox\` | Capture (CODE: Capture) — unsorted notes |
| \`1-Projects\` | Active outcomes with end dates |
| \`2-Areas\` | Ongoing responsibilities (credit, Plus Ultra, family ops) |
| \`3-Resources\` | Reference material |
| \`4-Archives\` | Completed / cold |
| \`Daily\` | Day notes |
| \`Canvas\` | JSON Canvas (\`.canvas\`) |

## Grammar

Use \`[[wikilinks]]\` between notes. Prefer short titles. STARRA reads and writes
through gated Tools — she does not rewrite the vault unsupervised.

## Backup

Sync this folder to a *private* GitHub repo via Obsidian Git Plugin or
\`npm run vault:sync\`. Never commit vault notes into the STARGATE app repo.

See docs/OBSIDIAN_MEMORY.md.
`;

const INBOX_SEED = `---
tags: [inbox]
---

# Inbox

Capture here. STARRA and Charles process into Projects / Areas / Resources.

Use [[wikilinks]] when linking related notes.
`;

export type ScaffoldResult = {
  ok: boolean;
  vaultRoot: string;
  created: string[];
  alreadyPresent: boolean;
  error?: string;
};

export async function scaffoldVault(
  vaultRoot?: string,
): Promise<ScaffoldResult> {
  const root = vaultRoot ?? resolveVaultRoot();
  const created: string[] = [];

  try {
    const existed = await vaultExists(root);
    await fs.mkdir(root, { recursive: true });

    for (const folder of VAULT_FOLDERS) {
      const dir = path.join(root, folder);
      try {
        await fs.access(dir);
      } catch {
        await fs.mkdir(dir, { recursive: true });
        created.push(folder);
      }
    }

    const readmePath = path.join(root, "README.md");
    try {
      await fs.access(readmePath);
    } catch {
      await fs.writeFile(readmePath, README, "utf8");
      created.push("README.md");
    }

    const inboxNote = path.join(root, "0-Inbox", "Inbox.md");
    try {
      await fs.access(inboxNote);
    } catch {
      await fs.writeFile(inboxNote, INBOX_SEED, "utf8");
      created.push("0-Inbox/Inbox.md");
    }

    return {
      ok: true,
      vaultRoot: root,
      created,
      alreadyPresent: existed && created.length === 0,
    };
  } catch (err) {
    return {
      ok: false,
      vaultRoot: root,
      created,
      alreadyPresent: false,
      error: err instanceof Error ? err.message : "scaffold failed",
    };
  }
}
