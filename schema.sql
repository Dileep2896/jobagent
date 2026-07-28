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
--   filter_failed  filter errored repeatedly          (terminal, needs a look)
--   ready_for_review  application prepared, awaiting the human's approval
--                     (CLAUDE.md: submission requires explicit approval)
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

  -- 'applied', not 'submitted': applied_at and applied_method below already
  -- name the event, and submit.js writes all three together.
  status         text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'filtering', 'shortlisted',
                                   'filtered_out', 'filter_failed',
                                   'generating', 'ready_for_review', 'applied',
                                   'interview', 'rejected', 'stale')),
  filter_reason  text,
  filter_attempts integer NOT NULL DEFAULT 0,
  -- Set while a job is part of an in-flight Message Batch. A batch can take
  -- hours, which is far longer than the stale-claim window, so the reclaim sweep
  -- must leave these alone or it would abandon work already paid for.
  filter_batch_id text,
  -- generate.js's own attempt counter, mirroring filter_attempts. A resume that
  -- cannot be built (a gate that never passes for this JD) must stop retrying
  -- forever, and it must not consume the filter's budget to do so.
  resume_attempts integer NOT NULL DEFAULT 0,
  resume_error   text,

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

-- generate.js claims with: WHERE status='shortlisted' AND resume_attempts < N.
CREATE INDEX IF NOT EXISTS jobs_generate_queue_idx
  ON jobs (id) WHERE status = 'shortlisted';

CREATE INDEX IF NOT EXISTS jobs_generating_idx
  ON jobs (updated_at) WHERE status = 'generating';

-- Review queue / reporting.
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

-- ---------------------------------------------------------------------------
-- Filter scoring (filter.js), adapted from the career-ops A-F rubric.
-- filter_score is the 1.0-5.0 global, computed deterministically in code from
-- the per-dimension scores the model returns -- the model never produces the
-- global itself. filter_scores keeps the per-dimension breakdown so a verdict
-- can be audited without re-running the model.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS filter_score  numeric(2,1);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS filter_scores jsonb;

-- Review queue is ordered best-first.
CREATE INDEX IF NOT EXISTS jobs_score_idx
  ON jobs (filter_score DESC) WHERE status = 'shortlisted';

-- ---------------------------------------------------------------------------
-- Generated resume artefacts and application tracking.
--
-- resume_drive_url is what the human clicks when the agent cannot complete a
-- submission and they need to apply by hand, so it is carried through to the
-- review digest. applied_at is set only after a human approves and the submit
-- stage succeeds -- never by the pipeline on its own.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_path          text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_drive_url     text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_drive_file_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_built_at      timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS applied_at           timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS applied_method       text
  CHECK (applied_method IS NULL OR applied_method IN ('agent', 'manual'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resume_error    text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS filter_batch_id text;

-- Resuming an in-flight batch after a crash: find every job still attached to it.
CREATE INDEX IF NOT EXISTS jobs_filter_batch_idx
  ON jobs (filter_batch_id) WHERE filter_batch_id IS NOT NULL;

-- The status vocabulary grew with stage 3. ADD COLUMN IF NOT EXISTS cannot widen
-- an existing CHECK, so the constraint is dropped and rebuilt; it must match the
-- CREATE TABLE above exactly. Rebuilding validates every existing row, which is
-- the point -- a status this file no longer knows about should fail loudly here
-- rather than silently at 3am in cron.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('new', 'filtering', 'shortlisted',
                    'filtered_out', 'filter_failed',
                    'generating', 'ready_for_review', 'applied',
                    'interview', 'rejected', 'stale'));

-- Rows still needing a push to the tracking spreadsheet.
-- Outcome tracking. outcome_evidence keeps the quoted line the classification
-- was based on, so a wrong call can be audited rather than guessed at.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS outcome_at       timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS outcome_source   text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS outcome_evidence text;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sheet_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS jobs_sheet_pending_idx
  ON jobs (id) WHERE sheet_synced_at IS NULL;

-- ---------------------------------------------------------------------------
-- Notifications (notify.js).
--
-- One row per (job, scenario), written ONLY after the webhook carrying that
-- job returns success. A failed or interrupted digest therefore re-sends next
-- run rather than silently dropping jobs, and a job can be announced once per
-- scenario without the scenarios interfering with each other.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notified_at timestamptz;  -- legacy

CREATE TABLE IF NOT EXISTS notifications (
  job_id   bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scenario text   NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, scenario)
);

CREATE INDEX IF NOT EXISTS notifications_scenario_idx ON notifications (scenario, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Submission approvals.
--
-- CLAUDE.md: submission requires explicit human approval. An approval is per
-- job, never blanket, and expires -- a stale approval against a form whose
-- questions have since changed is exactly how a wrong answer gets sent.
-- consumed_at makes it single-use, so a retry cannot re-submit.
-- The resume_path recorded here is compared at submit time: if the resume was
-- rebuilt after approval, the approval no longer refers to what would be sent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  job_id       bigint PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  approved_by  text NOT NULL,
  resume_path  text,
  note         text,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumed_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Why a job could not be submitted automatically.
--
-- Written by submit.js --auto when the pre-flight audit refuses, and surfaced in
-- the tracking sheet so the human sees the exact blocking question rather than a
-- bare "not applied". Cleared on a successful submission.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS submit_blocker    text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS submit_checked_at timestamptz;
