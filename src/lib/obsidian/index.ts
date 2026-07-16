export {
  resolveVaultRoot,
  resolveSafeNotePath,
  vaultExists,
  vaultRootRelative,
  DEFAULT_VAULT_REL,
} from "./paths";
export { scaffoldVault, VAULT_FOLDERS } from "./scaffold";
export {
  listNotes,
  readNote,
  searchNotes,
  resolveWikilink,
  writeNote,
  deleteNote,
  parseWikilinks,
  clearVaultPending,
} from "./notes";
export type { NoteMeta, NoteRead, SearchHit, WriteMode } from "./notes";
export { loadObsidianDoctrine, clearObsidianDoctrineCache } from "./doctrine";
export { getObsidianStatus, obsidianForPrompt } from "./status";
export type { ObsidianStatus } from "./status";
