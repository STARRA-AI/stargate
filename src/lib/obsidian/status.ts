/**
 * Vault status + volatile prompt extras (Layer 1 presence signal).
 */

import { promises as fs } from "fs";
import path from "path";
import {
  resolveVaultRoot,
  vaultExists,
  vaultRootRelative,
} from "./paths";
import { listNotes } from "./notes";
import { VAULT_FOLDERS } from "./scaffold";

export type ObsidianStatus = {
  present: boolean;
  vaultRoot: string;
  vaultRootRel: string;
  noteCount: number;
  folders: { name: string; present: boolean }[];
  skillsVendorPresent: boolean;
  skillsVendorPath: string;
  guide: string;
  layers: {
    longTermMemory: string;
    assistant: string;
    backupSync: string;
  };
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getObsidianStatus(): Promise<ObsidianStatus> {
  const root = resolveVaultRoot();
  const present = await vaultExists(root);
  let noteCount = 0;
  const folders: { name: string; present: boolean }[] = [];

  if (present) {
    const notes = await listNotes(root);
    noteCount = notes.length;
    for (const name of VAULT_FOLDERS) {
      folders.push({
        name,
        present: await exists(path.join(root, name)),
      });
    }
  } else {
    for (const name of VAULT_FOLDERS) {
      folders.push({ name, present: false });
    }
  }

  const skillsPath = path.join(process.cwd(), "vendor", "obsidian-skills");
  const skillsVendorPresent = await exists(path.join(skillsPath, "README.md"));

  return {
    present,
    vaultRoot: root,
    vaultRootRel: vaultRootRelative(root),
    noteCount,
    folders,
    skillsVendorPresent,
    skillsVendorPath: "vendor/obsidian-skills",
    guide: present
      ? "Vault online. List / search / read notes. Create and append freely; overwrite and delete need confirm tokens. Sync via Obsidian Git Plugin or npm run vault:sync to a private repo."
      : "No vault yet. Run: npm run vault:init — then open data/vault in Obsidian (optional). Backup to a private GitHub repo only.",
    layers: {
      longTermMemory:
        "Local markdown vault (data/vault or STARGATE_VAULT_PATH) — gitignored, exportable.",
      assistant:
        "STARRA uses Obsidian grammar ([[wikilinks]], PARA/CODE, gated note ops). kepano skills optional vendor reference.",
      backupSync:
        "Obsidian Git Plugin or vault:sync → private GitHub repo. Never into the STARGATE app repo.",
    },
  };
}

/**
 * Compact volatile block for system prompt — only when vault exists.
 * Keep small; do not dump note bodies.
 */
export async function obsidianForPrompt(): Promise<string> {
  const status = await getObsidianStatus();
  if (!status.present) {
    return "";
  }
  const folderLed = status.folders
    .filter((f) => f.present)
    .map((f) => f.name)
    .join(", ");
  return [
    "OBSIDIAN VAULT (long-term memory — local)",
    `Path: ${status.vaultRootRel}`,
    `Notes: ${status.noteCount}`,
    `Folders: ${folderLed || "none"}`,
    "Grammar: prefer [[wikilinks]]; overwrite/delete require operator confirm.",
    "Backup: private Git remote via Obsidian Git / vault:sync — not the app repo.",
  ].join("\n");
}
