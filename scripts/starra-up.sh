#!/usr/bin/env bash
# Back-compat wrapper — prefer `starra` / `npm run starra`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/starra" open
