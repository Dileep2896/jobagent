# Job application pipeline

Runs 24/7 on a headless Ubuntu 24.04 server (2015 iMac, 4-core, wifi only).
Node 22, Postgres 16 (db: jobagent, user: dileep, peer auth, no password).
Playwright with Chromium installed. Anthropic API for all model calls.

## Pipeline stages
1. discover.js  - poll Greenhouse/Lever/Ashby public board APIs from the
                  `companies` watchlist, upsert into `jobs`, dedupe on
                  (company_id, external_id)
2. filter       - cheap Haiku 4.5 pass per JD: fit yes/no + reason.
                  Kills most volume before expensive calls.
3. generate     - build a tailored resume from master-facts.json
4. critique     - score against the JD, revise, hard cap 2 revisions
5. review queue - human approves, then Playwright prefills the form

## Hard rules
- Never invent resume content. Every bullet must map to an id in
  master-facts.json. A generated bullet with no source id is a bug.
- Never auto-submit an application. Stage 5 stops at "ready_for_review".
  Screening questions (work authorization, sponsorship, salary) are
  answered by the human, never the model.
- Critique loop needs deterministic gates alongside the LLM score:
  JD keyword coverage, page count, fact-id validation. LLM-score-only
  loops converge on keyword stuffing.
- Everything idempotent and resumable. This box is on wifi and will drop.
  Work in small units, status column per job, failures retry with backoff.
- Use the Batch API for the nightly run, nothing here is time-sensitive.
  Prompt-cache master-facts.json, it is in every generate call.
- Respect robots.txt and ToS. Public board APIs only, no LinkedIn scraping.

## Current state
- Git repo initialised. Everything below is committed — an earlier copy of
  schema.sql and discover.js was lost because nothing was tracked.
- schema.sql applied to the `jobagent` db (companies, jobs). Re-runnable.
- discover.js works: greenhouse/lever/ashby adapters, retry+backoff, upsert
  deduped on (company_id, external_id). The upsert never touches `status`,
  so re-running cannot undo a filter verdict.
- Watchlist seeded with 3 companies, one per board type (Stripe/greenhouse,
  Match Group/lever, Ramp/ashby). 733 jobs discovered, all status='new'.
- filter.js built (stage 2). Verified end-to-end against a scratch database
  with a stubbed SDK: batching, concurrency, retry/backoff, crash recovery,
  graceful shutdown. NOT yet run against the real API — this box has no
  Anthropic credentials configured (no ANTHROPIC_API_KEY, no `ant` CLI).

## Next
1. Replace CANDIDATE_PROFILE in filter.js — it is a placeholder and every
   verdict depends on it.
2. Configure Anthropic credentials on this box.
3. `node filter.js --once --limit 5` to sanity-check verdicts and per-job cost
   before running the full 733-job backlog.
4. Expand the watchlist beyond the 3 seed companies.
5. Stage 3 (generate). Note: stage 3 will need to extend the `status` CHECK
   constraint in schema.sql with its own states.
