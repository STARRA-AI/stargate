# Obsidian memory in STARGATE

STARRA's long-term memory follows Obsidian ecosystem patterns — adapted for the
guardian covenant (local, exportable, gated). Three layers:

| Layer | What | Where |
| --- | --- | --- |
| **1. Long-term memory** | Plain local markdown vault | `data/vault/` (gitignored) or `STARGATE_VAULT_PATH` |
| **2. The Assistant** | STARRA + Obsidian grammar + Tools API | Doctrine clip in prompt + `/api/tools/obsidian` |
| **3. Backup and Sync** | Private Git remote (Obsidian Git Plugin or `vault:sync`) | Outside the STARGATE app repo |

Traces to Book 2 Tier 3 memory (working / summary / archival) as the *durable*
companion to JSON conversation tiers, and to STARRA_GUARDIAN: keep memory local
and exportable; never wire the house into anything it cannot leave.

---

## Runtime doctrine

Use this grammar when reading or writing vault notes:

- Prefer `[[wikilinks]]` (optional `[[Note#heading|alias]]`). Resolve via Tools → Memory / Vault or `action=resolve`.
- Notes are Markdown (`.md`). JSON Canvas uses `.canvas` under `Canvas/`.
- Preserve YAML frontmatter when present; do not strip tags blindly.
- PARA folders: `0-Inbox`, `1-Projects`, `2-Areas`, `3-Resources`, `4-Archives`, plus `Daily/` and `Canvas/`.
- CODE loop: Capture → Organize → Distill → Express. Capture lands in Inbox; organize into PARA.
- Create and append are normal Tools writes. **Overwrite and delete require operator confirmation tokens** — no autonomous destructive rewrites.
- Never commit private vault notes into the STARGATE application repository.
- Backup Layer 3: sync the vault folder to a *private* GitHub repo via Obsidian Git Plugin or `npm run vault:sync`.

Agentic second-brain workflows (self-rewriting corpora, unsupervised research loops)
are **future hooks only** — they must pass guardian gates before any effectful run.

---

## Adopted vs deferred

### Adopted now

1. **kepano/obsidian-skills grammar** — wikilinks, canvas awareness, vault-relative paths — adapted into this doctrine and Tools ops. Optional shallow clone: `npm run tools:bootstrap-obsidian-skills` → `vendor/obsidian-skills` (gitignored). Not a Claude Code runtime dependency.
2. **PARA + CODE scaffold** — `npm run vault:init` creates the folder tree under `data/vault/`.
3. **Memory / Vault Tools API** — status, list, read, search, wikilink resolve, create/append, gated overwrite/delete.
4. **Prompt wiring** — doctrine in stable canon; compact vault status in volatile extras when the vault exists.
5. **Backup docs + `vault:sync` guidance** — private remote only.

### Deferred (hooks)

| Source | Hook | Why deferred |
| --- | --- | --- |
| jamesmcroft / PARA-CODE agents | Full automated organize/distill agents | Needs operator-approved batch gates |
| eugeniughelbur agentic second brain | Self-rewriting + scheduled research | Sacred gates — no unsupervised vault mutation |
| Community COG graphs | Rich cognitive ontology UI | Inspiration only until Tier 3 archival embeddings mature |
| Letta-style tiered memory | Embedding archival search | Book 2 expansion item — separate from markdown vault |

---

## Operator steps

### 1. Create the vault (Layer 1)

```bash
npm run vault:init
# → data/vault/ with PARA folders + Inbox seed
```

Override path if desired:

```bash
export STARGATE_VAULT_PATH="$HOME/.stargate/vault"
npm run vault:init
```

### 2. Optional — open in Obsidian

1. Obsidian → Open folder as vault → select `data/vault` (or your `STARGATE_VAULT_PATH`).
2. Work normally with `[[wikilinks]]`. STARRA sees the same files via Tools.

### 3. Use from STARGATE (Layer 2)

1. Open **Tools → Memory / Vault**.
2. **Init vault** if empty; **List notes** / **Search**; create or append notes.
3. Overwrite/delete: first call returns `428` + confirm token; confirm explicitly.
4. Chat volatile context includes vault presence (path + note count) when online.

### 4. Backup and sync (Layer 3)

**Recommended: Obsidian Git Plugin**

1. Create a **private** GitHub repo (e.g. `starra-vault-private`).
2. In Obsidian: Community plugins → Obsidian Git.
3. Init git in the vault folder (or run `npm run vault:sync -- --init`).
4. Set remote to the private repo. Enable auto-commit / auto-pull on a schedule you trust.
5. Never add this remote to the STARGATE monorepo.

**CLI guidance script**

```bash
npm run vault:sync -- --init
# follow printed steps to add private remote + push
npm run vault:sync
# status / commit guidance (does not push to stargate origin)
```

The script operates only on the vault directory. It will refuse to treat the
STARGATE app root as the vault.

---

## API quick reference

```
GET  /api/tools/obsidian?action=status
GET  /api/tools/obsidian?action=list&prefix=1-Projects
GET  /api/tools/obsidian?action=read&path=0-Inbox/Inbox.md
GET  /api/tools/obsidian?action=search&q=credit
GET  /api/tools/obsidian?action=resolve&link=Inbox

POST /api/tools/obsidian
  { "action": "init" }
  { "action": "write", "path": "0-Inbox/Capture.md", "content": "...", "mode": "create"|"append"|"overwrite" }
  { "action": "write", "path": "...", "mode": "overwrite", "confirmToken": "abc123", "content": "..." }
  { "action": "delete", "path": "...", "confirmToken": "abc123" }
```

Overwrite/delete without token → HTTP 428 + `token` (held for confirmation).

---

## Relationship to existing memory surfaces

| Surface | Role |
| --- | --- |
| `data/memory.json` tiers | Short/medium conversation memory (working / summary / archival) |
| `data/vault.json` uploads | Ingested docs / fact extraction (Vault page) |
| `data/vault/` Obsidian tree | **Long-term operator knowledge** — human-editable markdown |

All three stay local and gitignored under `/data/`.
