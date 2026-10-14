#!/bin/bash
# Restart the Foreman once its worker has no session child (only gh/git/ssh blips) for two
# checks running, then prove it came back: exit 0 only on a "Daemon starting" line from the
# new start. systemd reports "active" while the doppler wrapper is still launching, so the
# unit state alone is not proof. (2026-10-14: a restart read as done while dist/ refused to
# start for 30 minutes and the unit crash-looped 44 times; nothing ran in that window.)
set -u
UNIT=slashbin-foreman.service
MP=$(systemctl --user show -p MainPID --value "$UNIT")
W=$(pgrep -P "$MP" | head -1)
quiet=0
for _ in $(seq 1 180); do
  busy=0
  [ -n "$W" ] && busy=$(ps -o comm= --ppid "$W" | grep -vcE '^(gh|git|ssh)$')
  if [ "$busy" -eq 0 ]; then quiet=$((quiet+1)); else quiet=0; fi
  if [ $quiet -ge 2 ]; then
    since=$(date "+%Y-%m-%d %H:%M:%S")
    env -i HOME="$HOME" PATH="$PATH" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
      systemctl --user restart "$UNIT" || { echo "restart failed"; exit 1; }
    for _ in $(seq 1 60); do
      log=$(journalctl --user -u "$UNIT" --since "$since" --no-pager)
      if grep -q "Daemon starting" <<<"$log"; then echo "restarted and running $(date -u +%H:%M:%SZ)"; exit 0; fi
      if grep -qE "Refusing to start|Failed with result" <<<"$log"; then
        echo "FOREMAN DID NOT START:"; grep -E "Refusing to start|ERROR|Failed with result" <<<"$log" | tail -5; exit 1
      fi
      sleep 3
    done
    echo "no 'Daemon starting' within 3 min of the restart"; exit 1
  fi
  sleep 20
done
echo "still busy after 60 min"; exit 1
