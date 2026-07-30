#!/usr/bin/env bash
# LEGACY WRAPPER — canonical launcher is scripts/starra. This file exists only
# for back-compat and just forwards to `starra open` (prefer `starra` /
# `npm run starra` directly). It prints no URLs of its own — all link text
# (local + phone) comes from scripts/starra, so there is nothing to align here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/starra" open
