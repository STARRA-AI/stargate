#!/usr/bin/env python3
"""
STARGATE JSON  ->  one SQLite file NocoDB can open as a spreadsheet.

WHY SQLITE AND NOT THE NOCODB API. NocoDB can attach an external SQLite source
and auto-discovers every table in it. Pushing rows through its REST API instead
would mean creating bases, tables and typed columns by hand, per table, and
re-doing it whenever a JSON shape changes. This is one file and one command.

WHAT IT COVERS
  business : funding leads, spend, vault docs, tier1 goals/projects/tasks/
             decisions, deck proposals/ventures
  engine   : ledger positions + orders, ledger summary, audit trail
  memory   : her working set, archival, facts, summaries

ponytail: ONE-WAY (JSON -> SQLite). Edits in NocoDB do NOT flow back, because
the deck writes these JSON files live and two writers would corrupt them.
Re-run this to refresh. Add a pull direction only if he actually starts editing
in NocoDB and wants it authoritative.
"""

import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENGINE = Path.home() / "STARGATE" / "engine"
# NOT data/stargate.db -- that is the DECK'S LIVE DATABASE (src/lib/db.ts:31,
# WAL mode, holds the errors + flip_entries tables). Exporting into it would put
# a read-only mirror inside her operational store, where a future migration or a
# DROP could take out real data. Separate file, separate lifecycle.
OUT = REPO / "data" / "nocodb-export.db"


def read_json(path):
    """Missing or unreadable is normal (a fresh clone has no vault) -> skip."""
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def read_jsonl(path):
    try:
        return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    except Exception:
        return None


def flatten(v):
    """SQLite takes scalars; anything nested becomes readable JSON in the cell."""
    if v is None or isinstance(v, (str, int, float)):
        return v
    if isinstance(v, bool):
        return int(v)
    return json.dumps(v, ensure_ascii=False)


def write_table(con, name, rows):
    """Create <name> from a list of dicts. Union of keys = columns."""
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        return 0
    cols = []
    for r in rows:  # preserve first-seen order, union across rows
        for k in r:
            if k not in cols:
                cols.append(k)
    quoted = ", ".join(f'"{c}"' for c in cols)
    con.execute(f'DROP TABLE IF EXISTS "{name}"')
    con.execute(f'CREATE TABLE "{name}" ({quoted})')
    con.executemany(
        f'INSERT INTO "{name}" ({quoted}) VALUES ({", ".join("?" for _ in cols)})',
        [[flatten(r.get(c)) for c in cols] for r in rows],
    )
    return len(rows)


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(OUT)
    counts = {}

    def put(name, rows):
        if rows:
            counts[name] = write_table(con, name, rows)

    # ── business ────────────────────────────────────────────────────────────
    funding = read_json(REPO / "data" / "funding.json") or {}
    put("funding_leads", funding.get("leads"))

    spend = read_json(REPO / "data" / "spend.json")
    if isinstance(spend, dict):
        put("spend", [spend])

    vault = read_json(REPO / "data" / "vault.json") or {}
    put("vault_docs", vault.get("docs"))

    t1 = read_json(REPO / "data" / "tier1.json") or {}
    for key in ("goals", "projects", "tasks", "decisions"):
        put(f"tier1_{key}", t1.get(key))

    deck = read_json(REPO / "data" / "deck.json") or {}
    put("deck_proposals", deck.get("proposals"))
    put("deck_ventures", deck.get("ventures"))

    # ── engine ──────────────────────────────────────────────────────────────
    ledger = read_json(ENGINE / "data" / "ledger.json") or {}
    put("engine_positions", ledger.get("positions"))
    put("engine_orders", ledger.get("orders"))
    summary = {k: ledger.get(k) for k in ("equity", "cash", "updated", "reconciled") if k in ledger}
    if summary:
        put("engine_ledger", [summary])
    put("engine_audit", read_jsonl(ENGINE / "data" / "audit.jsonl"))

    # ── her memory ──────────────────────────────────────────────────────────
    mem = read_json(REPO / "data" / "memory.json") or {}
    put("memory_working", mem.get("working"))
    put("memory_archival", mem.get("archival"))
    put("memory_facts", mem.get("facts"))
    # summaries are bare strings, not objects -> give them an index to sort by
    summaries = mem.get("summaries") or []
    put("memory_summaries", [{"n": i, "text": s} for i, s in enumerate(summaries)])

    con.commit()
    con.close()

    for k in sorted(counts):
        print(f"  {k:<20} {counts[k]:>6} rows")
    print(f"\n  -> {OUT}  ({OUT.stat().st_size // 1024} KB)")
    return counts


def selfcheck():
    """The one check: round-trip a nested value and a missing key."""
    import tempfile, os
    fd, p = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    con = sqlite3.connect(p)
    n = write_table(con, "t", [{"a": 1, "b": {"x": 2}}, {"a": 3, "c": "z"}])
    assert n == 2, n
    got = con.execute('SELECT "a","b","c" FROM "t" ORDER BY "a"').fetchall()
    assert got[0] == (1, '{"x": 2}', None), got[0]
    assert got[1] == (3, None, "z"), got[1]
    assert write_table(con, "empty", []) == 0
    con.close()
    os.unlink(p)
    print("  selfcheck OK")


if __name__ == "__main__":
    if "--selfcheck" in sys.argv:
        selfcheck()
    else:
        main()
