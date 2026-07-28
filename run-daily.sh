#!/usr/bin/env bash
#
# One pipeline pass. Safe to run on a schedule and safe to run twice — every
# stage is idempotent and resumable, which is the whole reason the pipeline is
# built around a status column.
#
# It NEVER submits an application. submit.js is not called here and never will
# be: submission requires `node approve.js --job-id N` typed by a human,
# followed by `node submit.js --job-id N --confirm`.
#
# Usage:  ./run-daily.sh              full pass
#         ./run-daily.sh --no-filter  skip the paid stage
#         MAX_FILTER=50 ./run-daily.sh
set -uo pipefail

cd "$(dirname "$0")"

# --- config -----------------------------------------------------------------
MAX_FILTER="${MAX_FILTER:-100}"   # jobs scored per run; caps spend
MAX_GENERATE="${MAX_GENERATE:-10}" # resumes built per run
MAX_PREFILL="${MAX_PREFILL:-5}"    # forms opened per run (~1 min each)
LOG_DIR="${LOG_DIR:-$HOME/jobagent-logs}"
LOCK="/tmp/jobagent.lock"

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

say() { echo; echo "=== $* ==="; }

# --- one run at a time ------------------------------------------------------
# This box is on wifi and a stage can hang; overlapping runs would double-claim
# jobs. flock releases automatically if the holder dies.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) another run holds the lock — exiting"
  exit 0
fi

# --- environment ------------------------------------------------------------
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export PATH="$HOME/google-cloud-sdk/bin:$PATH"

echo "$(date -Is) pipeline run starting"
psql -d jobagent -tAc "SELECT '  '||status||': '||count(*) FROM jobs GROUP BY status ORDER BY status"

# --- 1. discover ------------------------------------------------------------
say "discover"
node discover.js || echo "discover failed — continuing (it retries next run)"

# --- 2. filter (the only stage that costs money) ----------------------------
if [ "${1:-}" = "--no-filter" ]; then
  say "filter — skipped (--no-filter)"
elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  say "filter — skipped (ANTHROPIC_API_KEY not set)"
else
  say "filter (max $MAX_FILTER jobs)"
  node filter.js --once --limit "$MAX_FILTER" || echo "filter failed — unscored jobs stay queued"
fi

# --- 3. build resumes for the best unbuilt shortlisted jobs -----------------
say "generate (max $MAX_GENERATE)"
psql -d jobagent -tAc "
  SELECT id FROM jobs
   WHERE status='shortlisted' AND resume_path IS NULL
   ORDER BY filter_score DESC NULLS LAST, id
   LIMIT $MAX_GENERATE" | while read -r id; do
  [ -n "$id" ] || continue
  node generate.js --job-id "$id" || echo "  generate failed for job $id"
done

# --- 4. upload to Drive -----------------------------------------------------
say "drive upload"
psql -d jobagent -tAc "
  SELECT id||'|'||resume_path FROM jobs
   WHERE resume_path IS NOT NULL AND resume_drive_url IS NULL" | while IFS='|' read -r id p; do
  [ -n "$id" ] || continue
  node drive-upload.js "$p" --job-id "$id" || echo "  upload failed for job $id"
done

# --- 5. prefill forms -> ready_for_review -----------------------------------
# Slow (a real browser per job), so capped. Stops at ready_for_review.
say "prefill (max $MAX_PREFILL)"
psql -d jobagent -tAc "
  SELECT id FROM jobs
   WHERE status='shortlisted' AND resume_path IS NOT NULL
   ORDER BY filter_score DESC NULLS LAST, id
   LIMIT $MAX_PREFILL" | while read -r id; do
  [ -n "$id" ] || continue
  node prefill.js --job-id "$id" || echo "  prefill failed for job $id"
done

# --- 6. log applied jobs to the tracker -------------------------------------
say "sheets"
node sheets-sync.js || echo "sheets sync failed — retries next run"

# --- 7. tell the human ------------------------------------------------------
say "notify"
node notify.js || echo "notify failed — nothing marked sent, retries next run"

echo
echo "$(date -Is) run complete"
psql -d jobagent -tAc "SELECT '  '||status||': '||count(*) FROM jobs GROUP BY status ORDER BY status"

# Keep a fortnight of logs; this box has limited disk and nobody reads month-old runs.
find "$LOG_DIR" -name 'run-*.log' -mtime +14 -delete 2>/dev/null || true
