#!/bin/zsh
# Stop the sales line. Only this service's own pids and port 8790.
set -u
cd "$(dirname "$0")"
for f in runtime/supervise.pid runtime/tunnel.pid runtime/bridge.pid; do
  [[ -f "$f" ]] || continue
  pid=$(cat "$f" 2>/dev/null)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  rm -f "$f"
done
sleep 1
lsof -ti tcp:8790 2>/dev/null | xargs -r kill 2>/dev/null
# cloudflared children of a killed supervisor: match the SALES port only, never
# a bare "cloudflared" — :3000 is the deck's tunnel.
pgrep -f 'cloudflared tunnel --no-autoupdate --url http://localhost:8790' 2>/dev/null | xargs -r kill 2>/dev/null
# Clear the recorded origin: a stale hostname that no longer serves is worse
# than none, because every readiness check would report it as the live one.
rm -f runtime/origin.json
echo "sales line stopped."
