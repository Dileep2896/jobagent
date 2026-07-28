#!/usr/bin/env node
'use strict';

/**
 * Stage 2: cheap fit filter.
 *
 * Claims jobs with status='new' in batches of 20, sends each JD to Haiku 4.5,
 * and writes back status='shortlisted' | 'filtered_out' plus filter_reason.
 *
 * Crash safety: a batch is claimed by flipping status to 'filtering' inside a
 * single UPDATE...FOR UPDATE SKIP LOCKED, and each verdict is committed on its
 * own row as soon as it arrives. A crash therefore loses at most the in-flight
 * API calls, never a written verdict. Rows left stranded in 'filtering' are
 * swept back to 'new' at startup once they exceed STALE_CLAIM_MINUTES, so
 * re-running after a crash is always safe and never double-charges for a job
 * that already has a verdict. Two copies of this script can run concurrently.
 *
 * Usage:  node filter.js [--once] [--limit N]
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Schema binding. These are the only names this script assumes about the
// database. If schema.sql uses different ones, change them here.
// ---------------------------------------------------------------------------
const SCHEMA = {
  jobsTable: 'jobs',
  companiesTable: 'companies',
  id: 'id',
  companyId: 'company_id',
  title: 'title',
  description: 'description', // the JD text
  location: 'location',
  status: 'status',
  filterReason: 'filter_reason',
  filterAttempts: 'filter_attempts',
  updatedAt: 'updated_at',
  companyName: 'name',
};

const STATUS = {
  NEW: 'new',
  CLAIMED: 'filtering',
  SHORTLISTED: 'shortlisted',
  FILTERED_OUT: 'filtered_out',
  FAILED: 'filter_failed',
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODEL = 'claude-haiku-4-5';
const BATCH_SIZE = 20;
const CONCURRENCY = 4; // 4-core box on wifi; keep in-flight calls modest
const MAX_ATTEMPTS = 4; // per job, across runs, before giving up
const MAX_RETRIES = 5; // per API call, within one attempt
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const REQUEST_TIMEOUT_MS = 90000;
const STALE_CLAIM_MINUTES = 30;
const MAX_JD_CHARS = 24000; // ~6k tokens; guards against pathological JDs
const IDLE_SLEEP_MS = 60000; // when no work is queued, in continuous mode

// ---------------------------------------------------------------------------
// Fit criteria. This is the only place the filter learns what "fit" means.
// Keep it short and concrete — it is sent on every call.
// TODO: replace with the real profile once master-facts.json exists.
// ---------------------------------------------------------------------------
const CANDIDATE_PROFILE = `
Roles wanted: backend / full-stack / platform software engineer.
Seniority: mid to senior individual contributor. Not a manager, not an intern,
  not a new grad role.
Core stack: Node.js, TypeScript, Python, Postgres, AWS.
Location: remote (US), or hybrid/onsite within commuting distance of Boston, MA.
Hard blockers: requires an active security clearance; requires relocation
  outside the US; unpaid; commission-only; primarily sales, support, QA
  manual-testing, or recruiting work.
`.trim();

const SYSTEM_PROMPT = `You screen job descriptions for a single software engineer.
You decide only whether this job is worth spending effort on a tailored
application. You are a cheap first-pass filter: be decisive, not generous.

Candidate profile:
${CANDIDATE_PROFILE}

Rules:
- Set fit=false if the job trips any hard blocker in the profile.
- Set fit=false if the seniority or role type clearly does not match.
- Set fit=true only if the role is a plausible match on role type, seniority,
  and location. Perfect stack overlap is not required.
- If the job description is empty, truncated, or says nothing about the actual
  role, set fit=false and say so in the reason.
- reason must be one sentence, at most 200 characters, stating the single
  strongest factor behind the verdict. Do not restate the job title.
- Judge only what the job description says. Do not speculate about the company
  or infer requirements that are not written down.`;

// Structured outputs guarantee this shape; the parse below is belt-and-braces.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    fit: { type: 'boolean' },
    reason: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['fit', 'reason', 'confidence'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
// `host` must be the socket directory, not a hostname: node-postgres otherwise
// dials TCP to localhost and fails scram auth, since this cluster is peer-auth
// with no password. PGDATABASE lets you point at a scratch copy for testing.
const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

// maxRetries: 0 — the retry loop below is the single authority on backoff, so
// the SDK's own retries don't stack on top of it.
const anthropic = new Anthropic({
  maxRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Exponential backoff with full jitter, capped. */
function backoffMs(attempt) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Transient = worth retrying the same request unchanged.
 * 429, 5xx and connection drops (this box is on wifi) are transient.
 * 400/401/403/404 are our bug or our config, and will fail identically forever.
 */
const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'];

function isTransient(err) {
  if (!err) return false;

  // Classified by HTTP status where we have one. Deliberately not using
  // `instanceof` against the SDK's error classes: a duplicate copy of the SDK
  // on disk gives a second set of class identities, and a bare `instanceof`
  // against an undefined export throws — which would misfile a wifi drop as a
  // permanent failure and burn the job.
  const status = typeof err.status === 'number' ? err.status : null;
  if (status !== null) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  // No status: the request never got a response. Note the SDK leaves `.name`
  // as the string "Error" on all of its error classes, so the class name has
  // to come off the constructor. APIConnectionError and
  // APIConnectionTimeoutError both share this prefix.
  const className = err.constructor && err.constructor.name;
  if (typeof className === 'string' && className.startsWith('APIConnection')) return true;

  // Node socket errors that escaped the SDK's own wrapping.
  return TRANSIENT_CODES.includes(err.code);
}

/** Honour Retry-After when the API sends one, else fall back to backoff. */
function retryDelayMs(err, attempt) {
  const header = err?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_BACKOFF_MS, seconds * 1000);
  }
  return backoffMs(attempt);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Sweep claims stranded by a crashed or killed run back into the queue.
 * Only touches rows older than STALE_CLAIM_MINUTES, so a concurrently running
 * copy of this script never has its live batch stolen.
 */
async function reclaimStaleClaims() {
  const { rowCount } = await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.status} = $2
        AND ${SCHEMA.updatedAt} < now() - ($3 || ' minutes')::interval`,
    [STATUS.NEW, STATUS.CLAIMED, String(STALE_CLAIM_MINUTES)]
  );
  if (rowCount > 0) log(`reclaimed ${rowCount} stale claim(s) from a previous run`);
  return rowCount;
}

/**
 * Atomically take up to `limit` queued jobs. SKIP LOCKED means a second copy
 * of this script picks up a disjoint set instead of blocking.
 */
async function claimBatch(limit) {
  const { rows } = await pool.query(
    `WITH claimed AS (
       SELECT ${SCHEMA.id}
         FROM ${SCHEMA.jobsTable}
        WHERE ${SCHEMA.status} = $1
          AND ${SCHEMA.filterAttempts} < $2
        ORDER BY ${SCHEMA.id}
          FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE ${SCHEMA.jobsTable} j
        SET ${SCHEMA.status} = $4,
            ${SCHEMA.updatedAt} = now()
       FROM claimed
      WHERE j.${SCHEMA.id} = claimed.${SCHEMA.id}
     RETURNING j.${SCHEMA.id}`,
    [STATUS.NEW, MAX_ATTEMPTS, limit, STATUS.CLAIMED]
  );

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r[SCHEMA.id]);
  const { rows: jobs } = await pool.query(
    `SELECT j.${SCHEMA.id}          AS id,
            j.${SCHEMA.title}       AS title,
            j.${SCHEMA.description} AS description,
            j.${SCHEMA.location}    AS location,
            j.${SCHEMA.filterAttempts} AS attempts,
            c.${SCHEMA.companyName} AS company
       FROM ${SCHEMA.jobsTable} j
       JOIN ${SCHEMA.companiesTable} c ON c.${SCHEMA.id} = j.${SCHEMA.companyId}
      WHERE j.${SCHEMA.id} = ANY($1)`,
    [ids]
  );
  return jobs;
}

/** Commit one verdict. Single-row, single statement — the unit of resumability. */
async function recordVerdict(jobId, status, reason) {
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.filterReason} = $2,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.id} = $3`,
    [status, reason.slice(0, 500), jobId]
  );
}

/** Put a job back in the queue and count the failed attempt against it. */
async function releaseJob(jobId, reason) {
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.filterAttempts} = ${SCHEMA.filterAttempts} + 1,
            ${SCHEMA.filterReason} = $2,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.id} = $3`,
    [STATUS.NEW, reason ? reason.slice(0, 500) : null, jobId]
  );
}

/** Give up on a job permanently so it stops consuming batch slots. */
async function failJob(jobId, reason) {
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.filterAttempts} = ${SCHEMA.filterAttempts} + 1,
            ${SCHEMA.filterReason} = $2,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.id} = $3`,
    [STATUS.FAILED, reason.slice(0, 500), jobId]
  );
}

/** Hand back everything still unprocessed when we're interrupted mid-batch. */
async function releaseClaims(jobIds) {
  if (jobIds.length === 0) return;
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.id} = ANY($2)
        AND ${SCHEMA.status} = $3`,
    [STATUS.NEW, jobIds, STATUS.CLAIMED]
  );
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

function buildUserContent(job) {
  const jd = job.description || '';
  const truncated = jd.length > MAX_JD_CHARS;
  if (truncated) {
    log(`job ${job.id}: JD truncated ${jd.length} -> ${MAX_JD_CHARS} chars`);
  }
  return [
    `Company: ${job.company}`,
    `Title: ${job.title || '(none given)'}`,
    `Location: ${job.location || '(none given)'}`,
    '',
    'Job description:',
    truncated ? `${jd.slice(0, MAX_JD_CHARS)}\n\n[description truncated]` : jd || '(empty)',
  ].join('\n');
}

/**
 * One classification, with its own retry/backoff budget.
 * Throws a tagged error: .transient distinguishes "try this job again later"
 * from "this job will never succeed".
 */
async function classify(job) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) {
      const err = new Error('shutting down');
      err.transient = true;
      throw err;
    }

    try {
      // Structured outputs constrain the response to RESPONSE_SCHEMA, so the
      // model cannot wrap the JSON in prose or emit a partial object.
      // No cache_control: Haiku 4.5 needs a 4096-token cacheable prefix and
      // this system prompt is nowhere near that, so a breakpoint would be a
      // silent no-op.
      const message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
        messages: [{ role: 'user', content: buildUserContent(job) }],
      });

      if (message.stop_reason === 'refusal') {
        const err = new Error('model refused to classify this JD');
        err.transient = false;
        throw err;
      }
      if (message.stop_reason === 'max_tokens') {
        // Truncated JSON is unparseable; a retry rarely helps, so treat it as
        // permanent rather than burning the whole retry budget on it.
        const err = new Error('response hit max_tokens before completing');
        err.transient = false;
        throw err;
      }

      const block = message.content.find((b) => b.type === 'text');
      if (!block) {
        const err = new Error('no text block in response');
        err.transient = false;
        throw err;
      }

      let parsed;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        const err = new Error(`unparseable JSON: ${block.text.slice(0, 120)}`);
        err.transient = false;
        throw err;
      }

      if (typeof parsed.fit !== 'boolean' || typeof parsed.reason !== 'string') {
        const err = new Error(`response failed validation: ${block.text.slice(0, 120)}`);
        err.transient = false;
        throw err;
      }

      return parsed;
    } catch (err) {
      // Errors we raised ourselves already carry a verdict on retryability.
      if (typeof err.transient === 'boolean') {
        if (!err.transient) throw err;
        lastErr = err;
      } else if (isTransient(err)) {
        lastErr = err;
      } else {
        err.transient = false;
        throw err;
      }

      if (attempt === MAX_RETRIES) break;
      const delay = retryDelayMs(err, attempt);
      log(`job ${job.id}: ${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }

  const err = new Error(`gave up after ${MAX_RETRIES} retries: ${lastErr?.message}`);
  err.transient = true;
  throw err;
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

async function processJob(job) {
  try {
    const verdict = await classify(job);
    const status = verdict.fit ? STATUS.SHORTLISTED : STATUS.FILTERED_OUT;
    await recordVerdict(job.id, status, verdict.reason);
    log(`job ${job.id} -> ${status} (${verdict.confidence}): ${verdict.reason}`);
    return status;
  } catch (err) {
    if (err.transient) {
      // Attempt count is incremented here, so a job that keeps failing on wifi
      // drops eventually stops being retried instead of looping forever.
      const nextAttempt = job.attempts + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await failJob(job.id, `filter failed after ${nextAttempt} attempts: ${err.message}`);
        log(`job ${job.id} -> ${STATUS.FAILED} (attempts exhausted): ${err.message}`);
        return STATUS.FAILED;
      }
      await releaseJob(job.id, `transient failure: ${err.message}`);
      log(`job ${job.id} requeued (attempt ${nextAttempt}/${MAX_ATTEMPTS}): ${err.message}`);
      return STATUS.NEW;
    }

    await failJob(job.id, `filter failed: ${err.message}`);
    log(`job ${job.id} -> ${STATUS.FAILED}: ${err.message}`);
    return STATUS.FAILED;
  }
}

/** Fixed-size worker pool over one claimed batch. */
async function processBatch(jobs) {
  const queue = [...jobs];
  const inFlight = new Set();
  const counts = {};

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      if (shuttingDown) return;
      const job = queue.shift();
      inFlight.add(job.id);
      try {
        const status = await processJob(job);
        counts[status] = (counts[status] || 0) + 1;
      } finally {
        inFlight.delete(job.id);
      }
    }
  });

  await Promise.all(workers);

  // Anything still queued when we bailed out stays claimed — hand it back.
  if (queue.length > 0) {
    await releaseClaims(queue.map((j) => j.id));
    log(`released ${queue.length} unprocessed claim(s)`);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

  if (!Number.isFinite(limit) && limitFlag >= 0) {
    throw new Error('--limit requires a number');
  }

  await reclaimStaleClaims();

  let processed = 0;
  const totals = {};

  while (!shuttingDown) {
    const remaining = limit - processed;
    if (remaining <= 0) break;

    const jobs = await claimBatch(Math.min(BATCH_SIZE, remaining));
    if (jobs.length === 0) {
      if (once) {
        log('no jobs with status=new; done');
        break;
      }
      log(`no jobs with status=new; sleeping ${IDLE_SLEEP_MS / 1000}s`);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    log(`claimed batch of ${jobs.length}`);
    const counts = await processBatch(jobs);
    for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v;
    processed += jobs.length;

    if (once) break;
  }

  log('run summary:', JSON.stringify(totals));
}

function onSignal(sig) {
  if (shuttingDown) process.exit(130);
  shuttingDown = true;
  log(`${sig} received; finishing in-flight jobs then releasing claims`);
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

main()
  .catch((err) => {
    log('fatal:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
