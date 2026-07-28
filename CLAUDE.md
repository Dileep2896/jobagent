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
- schema.sql applied (companies, jobs)
- discover.js works, seeded with 2 test companies
- Nothing downstream built yet

## Next
Build out the watchlist, then stage 2.
