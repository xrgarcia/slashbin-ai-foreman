#!/bin/bash
# Restart the Foreman through its own drain, then prove it came back.
#
# SIGTERM is the restart task, and new work cannot override it: requestShutdown()
# (src/orchestrator.ts) stops every lane from starting a session, drainInFlight()
# waits up to 60 min for the runs and lane passes already in flight, and only then
# does the process exit. KillMode=mixed + TimeoutStopSec=3900 keep systemd from
# cutting that drain short.
#
# This replaced restart-when-idle.sh, which waited for two idle checks in a row and
# never got them on a busy fleet: 2026-10-15 it gave up "still busy after 60 min"
# with the board fix (7290ca3) built and unloaded, while 23 repos kept starting work.
#
# Exit 0 only on a "Daemon starting" line from the new start. systemd reports
# "active" while the doppler wrapper is still launching, so the unit state alone is
# not proof (2026-10-14: a restart read as done while dist/ refused to start for 30
# minutes and the unit crash-looped 44 times).
set -u
UNIT=slashbin-foreman.service
# Refuse before the drain if the build cannot load its own dependencies. 2026-10-31 a
# worktree setup left node_modules a symlink to itself; dist/config.js could not find
# zod, and the restart already draining would have come back crash-looping.
cd "$(dirname "$0")/.."
if [ -L node_modules ] || ! node -e 'import("./dist/config.js")' >/dev/null 2>&1; then
  echo "refused: dist/ cannot load its dependencies (node_modules is a symlink or broken); run npm ci && npm run build"; exit 1
fi
since=$(date "+%Y-%m-%d %H:%M:%S")
env -i HOME="$HOME" PATH="$PATH" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  systemctl --user --no-block restart "$UNIT" || { echo "restart failed"; exit 1; }
echo "restart requested $(date -u +%H:%M:%SZ); the Foreman is draining and starts no new work"
said=""
# 70 min: the 60 min drain, systemd's 65 min stop timeout, and the start.
for _ in $(seq 1 1400); do
  log=$(journalctl --user -u "$UNIT" --since "$since" --no-pager -o cat)
  w=$(grep -m1 -oE "Waiting for [0-9]+ run\(s\) and [0-9]+ lane pass\(es\)" <<<"$log")
  if [ -n "$w" ] && [ -z "$said" ]; then echo "draining: $w"; said=1; fi
  if grep -q "Daemon starting" <<<"$log"; then
    grep -q "Drain window elapsed" <<<"$log" && echo "WARNING: the drain window elapsed and in-flight work was aborted"
    echo "restarted and running $(date -u +%H:%M:%SZ)"; exit 0
  fi
  if grep -qE "Refusing to start|Failed with result" <<<"$log"; then
    echo "FOREMAN DID NOT START:"; grep -E "Refusing to start|ERROR|Failed with result" <<<"$log" | tail -5; exit 1
  fi
  sleep 3
done
echo "no 'Daemon starting' within 70 min of the restart request"; exit 1
