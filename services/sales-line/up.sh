#!/bin/zsh
# Bring the sales line up: one supervisor keeping the bridge and the tunnel
# alive. Idempotent — safe to re-run.
#
# Kills by PORT and by this script's own pidfile only. It must NEVER use a
# generic process-name match: `pkill -f next-server` once killed Classic's live
# deck, and there is a long-running cloudflared on :3000 that belongs to it.
set -u
cd "$(dirname "$0")"
mkdir -p logs runtime

./down.sh >/dev/null 2>&1
sleep 1

node supervise.mjs >> logs/sales-line.out 2>&1 &
echo $! > runtime/supervise.pid
disown 2>/dev/null

echo "starting… (the tunnel probes its hostname before trusting it; allow ~30-90s)"
# Wait for the origin to be REACHABLE, not merely recorded. The file is written
# the instant cloudflared prints a hostname, several seconds before that
# hostname actually serves — polling the file alone reports a false "NO".
for i in {1..120}; do
  sleep 1
  origin=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync("runtime/origin.json","utf8")).origin||"")}catch(e){}' 2>/dev/null)
  [[ -z "$origin" ]] && continue
  # Require an actual 200. Plain `curl -s` exits 0 on a 502 error page too, so
  # a DEAD tunnel hostname would read as reachable and break the loop instantly.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$origin/health" 2>/dev/null)
  [[ "$code" == "200" ]] && break
done

node status.mjs
