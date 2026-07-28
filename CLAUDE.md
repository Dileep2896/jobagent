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
6. submit       - only after approval; reuses screening_answers verbatim and
                  pauses on any question not already answered by the human
7. upload       - resume PDF to Google Drive, so anything the agent cannot
                  submit can be applied to manually

## Architecture decisions (2026-07-28)
- Agents are Node pipeline stages, like discover.js/filter.js: one status per
  job, resumable, cron-scheduled. Not Claude Code subagents (they don't run
  unattended) and not Managed Agents (too big a shift from local Postgres).
- Filter stays on Haiku 4.5. Local Hermes was considered and rejected: this
  box is a 4-core Skylake i5 with no usable GPU compute, so an 8B model runs
  ~2-3 min/job — roughly 35 hours for the current 733-job backlog, versus
  ~$1-2 and minutes via the API. Revisit only if privacy forces it.
- Discord is CONNECTED and verified live (webhook "Job Agent", guild
  1531529259573837834). The URL lives in .env (mode 600, gitignored) — load
  with: set -a; . ./.env; set +a
- notify.js routes four scenarios, one webhook per channel, each falling back
  to JOBAGENT_WEBHOOK_URL when unset: JOBAGENT_WEBHOOK_DISCOVERIES,
  _SHORTLIST, _REVIEW, _ERRORS. A Discord webhook is bound to one channel and
  CANNOT create channels — that needs a bot token with Manage Channels, so the
  channels themselves are created by hand.
- Per-scenario idempotency lives in the `notifications` table (job_id,
  scenario), written only after the carrying webhook succeeds.
- Notifications and Drive uploads use credentials stored on this box, NOT the
  claude.ai MCP connectors. Those connectors are scoped to an interactive chat
  session and are unavailable to cron. Slack needs an incoming webhook URL;
  Drive needs a service-account JSON key (drive.file scope only).
- Drive destination folder "Job Applications":
  1IGsxWbde4zPW-FTdVPocresJzIFxO3rZ  (owner dkus2896@gmail.com)
- Filter scoring uses the career-ops A-F rubric (MIT, attributed in filter.js):
  cv_match .45, north_star .30, culture .15, comp .10; shortlist at >= 3.5.
  Comp returns 0 for "insufficient data" when a posting states no salary, and
  is then dropped with the remaining weights renormalised — never estimated.
  The model returns per-dimension scores only; the global is arithmetic done
  in code, per the deterministic-gates rule.
- Resume PDFs are built from .tex. ATS constraints are non-negotiable and
  mechanically checkable: single column, no tables for layout, no headers or
  footers holding contact info, standard section headers, contact details in
  the document body. The gate is a round trip — compile, run pdftotext, and
  assert the sections, contact info and every cited fact-id survive.

## Hard rules
- NEVER make an Anthropic API call without asking first. The API key is the
  user's own billing. No filter.js runs, no test calls, no "just one job to
  check" — ask, get a yes, then run. Stubs are fine and are how every stage
  has been verified so far. (Set by the user, 2026-07-28.)
- Never invent resume content. Every bullet must map to an id in
  master-facts.json. A generated bullet with no source id is a bug.
- Never submit without explicit human approval. The pipeline may prepare and
  prefill everything, but it stops at "ready_for_review" and notifies. Only
  after the human approves does Playwright submit. (Agreed 2026-07-28,
  replacing the previous never-submit-at-all rule; the approval gate itself
  is not negotiable.)
- Screening questions (work authorization, sponsorship, salary) are legal
  attestations to an employer. They are answered by the human once, in
  master-facts.json `screening_answers`, and reused verbatim. The model never
  invents, alters, or infers them. Any question not pre-answered pauses that
  application for human input rather than being guessed.
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

- notify.js posts a digest to Discord or Slack (format auto-detected from the
  webhook hostname; set JOBAGENT_WEBHOOK_URL). Reports discovered/shortlisted
  counts and lists jobs awaiting review. `notified_at` is stamped only after
  delivery succeeds, so a dead webhook re-sends rather than dropping jobs.
  Verified against a stubbed fetch: both formats, 429 retry, chunking at the
  2000-char Discord cap, and failure leaving nothing marked notified.
  NOT yet pointed at a real webhook — needs a URL from the user.

- master-facts.json BUILT from MASTER_RESUME.md in Drive (Job Applications/
  Master Resume). 24 verified facts, 6 roles, 10 projects, 2 patents, 2
  publications. Validates clean. Gitignored — personal history + attestations.
  Work auth transcribed: F-1 OPT (STEM), will need H-1B sponsorship later.
  Still blank and must be answered by the human before submit is enabled:
  willing_to_relocate, desired_salary, notice_period, years_of_experience.
- Notifications will use Discord (Slack needs a workspace). notify.js renders
  rich embeds on Discord so job titles are tappable; limits asserted against
  Discord's 10-embed / 6000-char / 2000-char content caps.
- Reference: github.com/santifer/career-ops (MIT, 62k stars) — same problem
  space, but runs interactively via an AI CLI rather than headless from cron.
  Worth mining for its five-dimension scoring rubric and ATS resume template
  when building generate; not worth adopting wholesale, since our constraint
  is unattended operation on a box that drops wifi.

## Next
1. Set CANDIDATE_PROFILE in filter.js from master-facts.json — it is still the
   placeholder, and every one of the 733 verdicts depends on it.
2. Configure Anthropic credentials on this box.
3. `node filter.js --once --limit 5` to sanity-check verdicts and per-job cost
   before running the full 733-job backlog.
4. Expand the watchlist beyond the 3 seed companies.
5. Stage 3 (generate). Note: stage 3 will need to extend the `status` CHECK
   constraint in schema.sql with its own states.
