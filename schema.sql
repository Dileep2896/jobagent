-- Job application pipeline schema.
-- Apply with:  psql -d jobagent -f schema.sql
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- companies: the watchlist discover.js polls.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  -- Which public board API to poll, and the company's slug on it.
  -- greenhouse -> boards-api.greenhouse.io/v1/boards/<token>/jobs
  -- lever      -> api.lever.co/v0/postings/<token>
  -- ashby      -> api.ashbyhq.com/posting-api/job-board/<token>
  board       text NOT NULL CHECK (board IN ('greenhouse', 'lever', 'ashby')),
  board_token text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  last_polled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board, board_token)
);

-- ---------------------------------------------------------------------------
-- jobs: one row per posting, deduped on (company_id, external_id).
--
-- `status` is the resumability spine of the whole pipeline: every stage claims
-- rows in one status and commits them into the next, one row at a time, so an
-- interrupted run never loses more than the work that was in flight.
--
--   new           discovered, not yet filtered        (discover.js writes this)
--   filtering     claimed by a filter.js worker       (transient)
--   shortlisted   passed the fit filter               (stage 3 input)
--   filtered_out  rejected by the fit filter          (terminal)
--   filter_failed filter errored repeatedly           (terminal, needs a look)
--
-- Stage 3 will need to extend this CHECK constraint with its own states.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id             bigserial PRIMARY KEY,
  company_id     integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id    text NOT NULL,

  title          text,
  location       text,
  url            text,
  description    text,               -- plain-text JD, as fed to the filter

  status         text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'filtering', 'shortlisted',
                                   'filtered_out', 'filter_failed')),
  filter_reason  text,
  filter_attempts integer NOT NULL DEFAULT 0,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, external_id)
);

-- filter.js claims with: WHERE status='new' AND filter_attempts < N ORDER BY id.
-- Partial index keeps the queue scan proportional to the backlog, not the table.
CREATE INDEX IF NOT EXISTS jobs_queue_idx
  ON jobs (id) WHERE status = 'new';

-- Startup sweep for claims stranded by a crashed worker.
CREATE INDEX IF NOT EXISTS jobs_claimed_idx
  ON jobs (updated_at) WHERE status = 'filtering';

-- Review queue / reporting.
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

-- ---------------------------------------------------------------------------
-- Notifications (notify.js). `notified_at` is stamped only after a webhook
-- delivery succeeds, so a failed or interrupted digest re-sends next run
-- rather than silently dropping jobs.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notified_at timestamptz;

CREATE INDEX IF NOT EXISTS jobs_unnotified_idx
  ON jobs (id) WHERE notified_at IS NULL;
