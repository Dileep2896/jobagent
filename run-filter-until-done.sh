#!/usr/bin/env bash
# Keep filter.js running until the board's backlog is empty.
#
# This box is on wifi and drops. filter.js is crash-safe by design — claims are
# swept, in-flight batches are resumed by id, and orphaned batches are adopted —
# so restarting it is always correct and never double-charges. What was missing
# was something to DO the restarting.
set -u
cd "$(dirname "$0")"
set -a; . ./.env; set +a

BOARD="${1:-greenhouse}"
MAX_RESTARTS="${MAX_RESTARTS:-40}"
LOG="logs-filter-${BOARD}.log"

for i in $(seq 1 "$MAX_RESTARTS"); do
  left=$(psql -d jobagent -tA -c \
    "SELECT count(*) FROM jobs j JOIN companies c ON c.id=j.company_id
      WHERE j.status='new' AND c.board='$BOARD';")
  if [ "$left" -eq 0 ]; then
    echo "$(date -Is) $BOARD backlog empty after $((i-1)) restart(s)" | tee -a "$LOG"
    exit 0
  fi
  echo "$(date -Is) pass $i — $left job(s) left on $BOARD" | tee -a "$LOG"
  node filter.js --batch --board "$BOARD" --spread >> "$LOG" 2>&1
  echo "$(date -Is) filter.js exited $?" >> "$LOG"
  sleep 10
done
echo "$(date -Is) hit MAX_RESTARTS=$MAX_RESTARTS on $BOARD" | tee -a "$LOG"
