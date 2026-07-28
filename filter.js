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
 * Cost control, in the order it applies:
 *   1. A deterministic title pre-filter settles roughly half the backlog with no
 *      API call at all. See preFilter().
 *   2. --batch sends what remains through the Message Batches API at half price.
 *      CLAUDE.md's default for the nightly run: nothing here is time-sensitive.
 *   3. No prompt caching: the system prompt is ~860 tokens and Haiku needs a
 *      4096-token cacheable prefix, so a breakpoint would be a silent no-op.
 *
 * Usage:  node filter.js [--once] [--limit N] [--batch] [--no-wait]
 *         node filter.js --prefilter-dry-run     (report only, writes nothing)
 *         node filter.js --prefilter-only        (free pass, 0 API calls)
 *
 * --no-wait is for cron: submit the batch and exit, let the next run harvest it.
 */

const fs = require('fs');
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
// Candidate profile, derived from master-facts.json. Nothing here is authored
// in this file — if the facts change, the filter changes with them.
// ---------------------------------------------------------------------------
const FACTS_PATH = process.env.MASTER_FACTS || 'master-facts.json';

function loadProfile() {
  if (!fs.existsSync(FACTS_PATH)) {
    throw new Error(`${FACTS_PATH} not found — run: node validate-facts.js`);
  }
  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  const t = facts.targets || {};
  if (!Array.isArray(t.archetypes) || t.archetypes.length === 0) {
    throw new Error(`${FACTS_PATH} has no targets.archetypes — the North Star dimension needs them`);
  }

  // Skills are summarised rather than dumped: the filter judges fit, and the
  // full fact list would balloon the per-job token cost for no gain.
  const skillGroups = Object.entries(facts.skills || {})
    .filter(([k]) => !k.startsWith('_') && k !== 'spoken_languages')
    .map(([k, v]) => `${k.replace(/_/g, '/')}: ${(v || []).join(', ')}`);

  const recent = (facts.roles || []).slice(0, 3).map((r) => `${r.title} at ${r.company} (${r.start}–${r.end})`);

  return [
    `Target roles: ${t.archetypes.join(', ')}`,
    `Seniority: ${t.seniority || 'not specified'}`,
    `Locations: ${(t.locations || []).join('; ') || 'not specified'}`,
    '',
    `Recent experience: ${recent.join(' | ')}`,
    '',
    'Skills:',
    ...skillGroups.map((s) => `  ${s}`),
    '',
    'Hard blockers (any one of these means the role is not viable):',
    ...(t.hard_blockers || []).map((b) => `  - ${b}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic pre-filter — the cheapest possible verdict.
//
// 47% of the seeded backlog is Commercial Counsel, Corporate Paralegal, Credit
// Risk Analyst, Account Executive and the like. Paying a model to read those is
// paying it to agree with a hard_blocker the candidate already wrote down
// ("Primarily sales, recruiting, manual QA, or IT support rather than software
// engineering"). This enforces that in code, before any call.
//
// Scoped to the TITLE only, deliberately. Description text is far too easy to
// misread — a posting saying "you will partner with our sales team" is not a
// sales role — and a false negative here is silent and permanent. The title is
// the one field where a company states what the job IS.
//
// Every exclusion needs an escape hatch, because "Backend Engineer, Billing/Tax"
// and "Software Engineer, Stripe Tax" both trip a blocker word while being
// exactly the roles wanted. A title matching any engineering signal is never
// pre-filtered, no matter what else it contains.
// ---------------------------------------------------------------------------
const DEFAULT_TITLE_EXCLUSIONS = [
  'account executive', 'sales', 'seller', 'quota', 'business development',
  'partner development', 'customer success', 'account manager',
  'recruit', 'recruiter', 'recruiting', 'talent', 'sourcer', 'people operations',
  'human resources', 'hr business partner',
  'marketing', 'brand', 'communications', 'public relations', 'content strategist',
  'copywriter', 'creative director', 'social media',
  'counsel', 'attorney', 'legal', 'paralegal', 'compliance', 'sanctions',
  'anti money laundering', 'regulatory',
  'accountant', 'accounting', 'controller', 'tax', 'treasury', 'payroll',
  'audit', 'bookkeep', 'financial analyst', 'credit risk', 'underwriter',
  'accounts receivable', 'accounts payable',
  'procurement', 'contracting', 'facilities', 'workplace', 'executive assistant',
  'office manager', 'receptionist',
  // Added after the first paid run classified five of these at 1.0/5 — correct
  // verdicts, but ~10k tokens to reach a conclusion the title already gave away.
  'administrative',
  'product manager', 'product management', 'program manager', 'project manager',
  'chief of staff', 'strategy manager',
  'designer', 'design manager', 'illustrator', 'ux researcher',
  'fraud investigator', 'operations associate', 'operations specialist',
  'operations analyst', 'quality assurance analyst', 'support specialist',
  'technical account manager', 'implementation consultant', 'solutions consultant',
];

const DEFAULT_ENGINEERING_SIGNALS = [
  'engineer', 'engineering', 'developer', 'programmer', 'architect',
  'sre', 'site reliability', 'devops', 'infrastructure', 'platform engineer',
  'machine learning', 'data engineer', 'research scientist', 'applied scientist',
  'software', 'backend', 'back-end', 'frontend', 'front-end', 'full stack',
  'full-stack', 'mobile', 'android', 'ios', 'security engineer',
];

/** Word-boundary regex over a term list, with every term escaped. */
function termRegex(terms) {
  const escaped = terms
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return null;
  return new RegExp(`(?:^|[^a-z0-9])(${escaped.join('|')})(?:[^a-z0-9]|$)`, 'i');
}

function loadTitleRules() {
  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  const t = facts.targets || {};
  return {
    // Overridable from master-facts.json: a different candidate wants a
    // different set, and the defaults above are this candidate's.
    exclude: termRegex(t.title_exclusions || DEFAULT_TITLE_EXCLUSIONS),
    rescue: termRegex(t.title_engineering_signals || DEFAULT_ENGINEERING_SIGNALS),
  };
}

const TITLE_RULES = loadTitleRules();

/**
 * Returns a reason string when the title alone disqualifies the job, else null.
 * Null means "the model still has to look at this one".
 */
function preFilter(job) {
  const title = String(job.title || '').trim();
  if (!title) return null; // no title is not evidence of anything
  if (!TITLE_RULES.exclude) return null;
  const hit = title.match(TITLE_RULES.exclude);
  if (!hit) return null;
  if (TITLE_RULES.rescue && TITLE_RULES.rescue.test(title)) return null;
  return `pre-filter: title names "${hit[1].toLowerCase()}" with no engineering signal — not a software engineering role`;
}

/**
 * Scoring rubric adapted from career-ops (github.com/santifer/career-ops, MIT).
 *
 * Two deliberate departures from the original, both because this is a cheap
 * first-pass filter rather than a deep evaluation:
 *  - Dimensions that need company research or market salary data are not
 *    scored here; the model sees only the JD.
 *  - The model returns per-dimension scores ONLY. The global is computed in
 *    code below. CLAUDE.md warns that LLM-score-only loops drift, and a
 *    weighted average is arithmetic — there is no reason to let a model do it.
 */
const RUBRIC = `Score each dimension 1-5, judging ONLY what the job description states.

cv_match     — how well the candidate's experience and skills map to the
               requirements. 5 = meets nearly all; 1 = fundamentally different
               discipline.
north_star   — how well the role matches the target archetypes and seniority.
               5 = squarely one of them; 1 = unrelated role type or wrong level.
culture      — team, values, remote policy and stability signals in the posting.
               3 if the posting says nothing either way. Do not infer from the
               company's reputation.
comp         — 1-5 versus market ONLY if the posting states a salary or range.
               If no compensation is stated, return 0 for "insufficient data".
               Never estimate or invent a number.
red_flags    — short factual strings, quoting or closely paraphrasing the
               posting. Include a flag for each hard blocker the posting trips.
               Empty array if none.`;

const SYSTEM_PROMPT = `You screen job descriptions for one software engineer, as a
cheap first-pass filter. Be decisive and evidence-bound, not generous.

Candidate profile:
${loadProfile()}

${RUBRIC}

Rules:
- Judge only what the job description says. Do not speculate about the company,
  and do not infer requirements that are not written down.
- If the description is empty, truncated, or never describes the actual role,
  score cv_match and north_star 1 and say so in the reason.
- reason: one sentence, at most 200 characters, giving the single strongest
  factor behind the scores. Do not restate the job title.`;

// Structured outputs constrain the shape; the validation below is belt-and-braces.
const SCORE_1_5 = { type: 'integer', enum: [1, 2, 3, 4, 5] };
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    cv_match: SCORE_1_5,
    north_star: SCORE_1_5,
    culture: SCORE_1_5,
    comp: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] }, // 0 = insufficient data
    red_flags: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['cv_match', 'north_star', 'culture', 'comp', 'red_flags', 'reason', 'confidence'],
  additionalProperties: false,
};

// career-ops thresholds: 4.5+ apply now, 4.0-4.4 worth applying,
// 3.5-3.9 only with a specific reason, below 3.5 recommend against.
const SHORTLIST_THRESHOLD = 3.5;
const WEIGHTS = { cv_match: 0.45, north_star: 0.3, culture: 0.15, comp: 0.1 };
const RED_FLAG_PENALTY = 0.5;
const MAX_RED_FLAG_PENALTY = 1.5;

/**
 * Deterministic global score. Comp is dropped and the remaining weights
 * renormalised when the posting states no salary, so a missing range neither
 * helps nor hurts — the alternative would be scoring a job on data we refused
 * to invent.
 */
function computeGlobal(v) {
  const dims = Object.entries(WEIGHTS).filter(([k]) => !(k === 'comp' && v.comp === 0));
  const totalWeight = dims.reduce((n, [, w]) => n + w, 0);
  const weighted = dims.reduce((n, [k, w]) => n + v[k] * w, 0) / totalWeight;

  const penalty = Math.min(v.red_flags.length * RED_FLAG_PENALTY, MAX_RED_FLAG_PENALTY);
  const score = Math.max(1, Math.min(5, weighted - penalty));
  return Math.round(score * 10) / 10;
}

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
    // filter_batch_id IS NULL matters: a batch legitimately runs for hours, far
    // past STALE_CLAIM_MINUTES. Without this the sweep would hand those jobs back
    // to the queue and the next run would pay to classify them a second time.
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.status} = $2
        AND filter_batch_id IS NULL
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
async function recordVerdict(jobId, status, reason, score, breakdown) {
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable}
        SET ${SCHEMA.status} = $1,
            ${SCHEMA.filterReason} = $2,
            filter_score = $3,
            filter_scores = $4,
            ${SCHEMA.updatedAt} = now()
      WHERE ${SCHEMA.id} = $5`,
    [status, reason.slice(0, 500), score, breakdown ? JSON.stringify(breakdown) : null, jobId]
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
 * Turn one Message into a validated verdict, or throw a tagged error.
 *
 * Shared by the per-job path and the batch path so a response cannot be trusted
 * in one and validated in the other. Every failure here is permanent: a model
 * that returned unparseable JSON for this JD will do it again, so retrying only
 * spends the budget twice.
 */
function parseVerdict(message) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.transient = false;
    return err;
  };

  if (message.stop_reason === 'refusal') throw fail('model refused to classify this JD');
  // Truncated JSON is unparseable; a retry rarely helps.
  if (message.stop_reason === 'max_tokens') throw fail('response hit max_tokens before completing');

  const block = (message.content || []).find((b) => b.type === 'text');
  if (!block) throw fail('no text block in response');

  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw fail(`unparseable JSON: ${block.text.slice(0, 120)}`);
  }

  const bad =
    !Array.isArray(parsed.red_flags) ||
    typeof parsed.reason !== 'string' ||
    ['cv_match', 'north_star', 'culture'].some((k) => !Number.isInteger(parsed[k]) || parsed[k] < 1 || parsed[k] > 5) ||
    !Number.isInteger(parsed.comp) || parsed.comp < 0 || parsed.comp > 5;
  if (bad) throw fail(`response failed validation: ${block.text.slice(0, 120)}`);

  return parsed;
}

// ---------------------------------------------------------------------------
// Token accounting.
//
// The point of a --limit 5 trial is to learn the per-job cost before committing
// to 734 of them, and that is unanswerable without reading usage off the
// response. Counted here rather than estimated from JD length: JDs vary by an
// order of magnitude and the system prompt is a fixed ~860 tokens on top.
// ---------------------------------------------------------------------------
const usage = { calls: 0, input: 0, output: 0 };

function recordUsage(u, jobId) {
  if (!u) return;
  usage.calls += 1;
  usage.input += u.input_tokens || 0;
  usage.output += u.output_tokens || 0;
  // Detail for the first few only: informative on a trial run, silent on a
  // full backlog run where 734 of these would bury the verdicts.
  if (usage.calls <= 5) {
    log(`job ${jobId}: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out tokens`);
  }
}

function logUsageSummary() {
  if (!usage.calls) {
    log('token usage: no API calls made');
    return;
  }
  log(`token usage: ${usage.calls} call(s), ${usage.input} input + ${usage.output} output tokens ` +
      `(avg ${Math.round(usage.input / usage.calls)} in / ${Math.round(usage.output / usage.calls)} out per job)`);
}

/** The request body, identical whether sent one at a time or in a batch. */
function buildRequestParams(job) {
  return {
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: buildUserContent(job) }],
  };
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
      const message = await anthropic.messages.create(buildRequestParams(job));
      recordUsage(message.usage, job.id);

      return parseVerdict(message);
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

/** Score, classify and commit one verdict. Shared by the per-job and batch paths. */
async function commitVerdict(job, verdict) {
  const score = computeGlobal(verdict);
  const status = score >= SHORTLIST_THRESHOLD ? STATUS.SHORTLISTED : STATUS.FILTERED_OUT;

  const breakdown = {
    cv_match: verdict.cv_match,
    north_star: verdict.north_star,
    culture: verdict.culture,
    comp: verdict.comp === 0 ? null : verdict.comp,
    red_flags: verdict.red_flags,
    confidence: verdict.confidence,
    global: score,
  };

  // career-ops surfaces this rather than letting a strong CV match bury it.
  if (score >= 4.5 && verdict.culture <= 2) {
    log(`job ${job.id}: high technical fit but weak culture signals — verify before applying`);
  }

  await recordVerdict(job.id, status, verdict.reason, score, breakdown);
  log(
    `job ${job.id} -> ${status} ${score.toFixed(1)}/5 ` +
      `(cv ${verdict.cv_match} · ns ${verdict.north_star} · cul ${verdict.culture}` +
      `${verdict.comp === 0 ? ' · comp n/a' : ` · comp ${verdict.comp}`}` +
      `${verdict.red_flags.length ? ` · ${verdict.red_flags.length} flag(s)` : ''}): ${verdict.reason}`
  );
  return status;
}

/** Requeue or fail one job. Shared, so both paths spend the same retry budget. */
async function handleJobError(job, err) {
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

async function processJob(job) {
  try {
    // Cheapest verdict first: no call, no tokens, no retry budget spent.
    const skip = preFilter(job);
    if (skip) {
      await recordVerdict(job.id, STATUS.FILTERED_OUT, skip, null, { prefilter: true });
      log(`job ${job.id} -> ${STATUS.FILTERED_OUT} (no API call): ${job.title}`);
      return STATUS.FILTERED_OUT;
    }
    return await commitVerdict(job, await classify(job));
  } catch (err) {
    return handleJobError(job, err);
  }
}

// ---------------------------------------------------------------------------
// Message Batches — half price, and CLAUDE.md's stated default for the nightly
// run ("nothing here is time-sensitive").
//
// The tradeoff is latency: a batch may take up to 24h, which is far longer than
// STALE_CLAIM_MINUTES. So a job in flight carries filter_batch_id, the reclaim
// sweep skips those rows, and a restart resumes the batch instead of paying for
// it twice. Losing the id is losing the work, so it is written BEFORE polling.
// ---------------------------------------------------------------------------
const BATCH_POLL_MS = 30000;
const BATCH_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

async function attachBatch(batchId, ids) {
  await pool.query(
    `UPDATE ${SCHEMA.jobsTable} SET filter_batch_id = $1, ${SCHEMA.updatedAt} = now() WHERE ${SCHEMA.id} = ANY($2)`,
    [batchId, ids]
  );
}

async function jobsInBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT j.${SCHEMA.id} AS id, j.${SCHEMA.title} AS title, j.${SCHEMA.filterAttempts} AS attempts
       FROM ${SCHEMA.jobsTable} j WHERE j.filter_batch_id = $1`,
    [batchId]
  );
  return rows;
}

/** Wait for a batch to finish. Returns false if we shut down first. */
async function awaitBatch(batchId) {
  const deadline = Date.now() + BATCH_MAX_WAIT_MS;
  for (;;) {
    if (shuttingDown) return false;
    const batch = await anthropic.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') return true;
    if (Date.now() > deadline) throw new Error(`batch ${batchId} still ${batch.processing_status} after 24h`);
    const c = batch.request_counts || {};
    log(`batch ${batchId}: ${batch.processing_status} (${c.succeeded || 0} ok, ${c.errored || 0} errored, ` +
        `${c.processing || 0} processing) — polling again in ${BATCH_POLL_MS / 1000}s`);
    await sleep(BATCH_POLL_MS);
  }
}

/**
 * Read a finished batch and commit one verdict per job.
 *
 * Results arrive out of order and keyed by custom_id, so they are matched back
 * by job id rather than by position. A job the batch never mentions is released
 * rather than left claimed — silently stranding it is how a backlog rots.
 */
async function harvestBatch(batchId, counts) {
  const jobs = await jobsInBatch(batchId);
  if (!jobs.length) return;
  const byId = new Map(jobs.map((j) => [String(j.id), j]));
  const seen = new Set();

  const results = await anthropic.messages.batches.results(batchId);
  for await (const entry of results) {
    const jobId = String(entry.custom_id || '').replace(/^job-/, '');
    const job = byId.get(jobId);
    if (!job) {
      log(`batch ${batchId}: result for unknown custom_id ${entry.custom_id} — ignored`);
      continue;
    }
    seen.add(jobId);

    const r = entry.result;
    try {
      if (r.type !== 'succeeded') {
        // errored / canceled / expired. Transient: the job goes back on the
        // queue and a later run can try it again.
        const err = new Error(`batch result ${r.type}: ${r.error?.error?.message || r.error?.type || 'no detail'}`);
        err.transient = true;
        throw err;
      }
      recordUsage(r.message.usage, job.id);
      const status = await commitVerdict(job, parseVerdict(r.message));
      counts[status] = (counts[status] || 0) + 1;
    } catch (err) {
      const status = await handleJobError(job, err);
      counts[status] = (counts[status] || 0) + 1;
    }
    await pool.query(
      `UPDATE ${SCHEMA.jobsTable} SET filter_batch_id = NULL WHERE ${SCHEMA.id} = $1`,
      [job.id]
    );
  }

  const missing = jobs.filter((j) => !seen.has(String(j.id)));
  if (missing.length) {
    log(`batch ${batchId}: ${missing.length} job(s) had no result — requeued`);
    for (const j of missing) {
      await pool.query(
        `UPDATE ${SCHEMA.jobsTable} SET filter_batch_id = NULL WHERE ${SCHEMA.id} = $1`,
        [j.id]
      );
      await releaseJob(j.id, 'batch returned no result for this job');
      counts[STATUS.NEW] = (counts[STATUS.NEW] || 0) + 1;
    }
  }
}

/** Resume batches left in flight by a previous run, before claiming anything new. */
async function resumeBatches() {
  const { rows } = await pool.query(
    `SELECT DISTINCT filter_batch_id AS id FROM ${SCHEMA.jobsTable}
      WHERE filter_batch_id IS NOT NULL AND ${SCHEMA.status} = $1`,
    [STATUS.CLAIMED]
  );
  if (!rows.length) return {};
  const counts = {};
  for (const { id } of rows) {
    log(`resuming in-flight batch ${id} from a previous run`);
    try {
      if (await awaitBatch(id)) await harvestBatch(id, counts);
    } catch (err) {
      log(`batch ${id} could not be resumed (${err.message}) — releasing its jobs`);
      const jobs = await jobsInBatch(id);
      await pool.query(
        `UPDATE ${SCHEMA.jobsTable} SET filter_batch_id = NULL WHERE filter_batch_id = $1`,
        [id]
      );
      for (const j of jobs) await releaseJob(j.id, `batch ${id} unrecoverable: ${err.message}`);
    }
  }
  return counts;
}

/**
 * Submit one claimed batch and commit every verdict.
 *
 * With noWait, it submits and returns instead of polling. A batch can take
 * hours; blocking on it inside a twice-daily cron would stall generate, prefill
 * and notify behind the slowest thing in the pipeline. Instead the jobs stay
 * claimed with their filter_batch_id and the NEXT run harvests them through
 * resumeBatches() before submitting anything new. Verdicts land ~12h later,
 * which matters to nothing here.
 */
async function processBatchViaAPI(jobs, noWait) {
  const counts = {};

  // Pre-filtered jobs never reach the API, so they are settled here and excluded
  // from the request — paying batch rates for a verdict already known is still
  // paying.
  const remaining = [];
  for (const job of jobs) {
    const skip = preFilter(job);
    if (skip) {
      await recordVerdict(job.id, STATUS.FILTERED_OUT, skip, null, { prefilter: true });
      log(`job ${job.id} -> ${STATUS.FILTERED_OUT} (no API call): ${job.title}`);
      counts[STATUS.FILTERED_OUT] = (counts[STATUS.FILTERED_OUT] || 0) + 1;
    } else {
      remaining.push(job);
    }
  }
  if (!remaining.length) return counts;

  const batch = await anthropic.messages.batches.create({
    requests: remaining.map((job) => ({ custom_id: `job-${job.id}`, params: buildRequestParams(job) })),
  });
  // Written before the first poll: a crash between create and this UPDATE is the
  // one window where a batch could be paid for and orphaned.
  await attachBatch(batch.id, remaining.map((j) => j.id));
  log(`batch ${batch.id} submitted with ${remaining.length} job(s)`);

  if (noWait) {
    log(`not waiting — the next run will harvest batch ${batch.id}`);
    return counts;
  }
  if (await awaitBatch(batch.id)) await harvestBatch(batch.id, counts);
  return counts;
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

/**
 * Deterministic pass over the whole queue, with no API call of any kind.
 *
 * Worth having as its own mode: it clears roughly half the backlog for free, and
 * it can be run and audited before anyone authorises spending money. Only rows it
 * actually disqualifies are written, so it is safe to re-run and safe to run
 * while a paid pass is going.
 */
async function runPreFilterOnly(limit, dryRun) {
  const { rows } = await pool.query(
    `SELECT ${SCHEMA.id} AS id, ${SCHEMA.title} AS title
       FROM ${SCHEMA.jobsTable}
      WHERE ${SCHEMA.status} = $1
      ORDER BY ${SCHEMA.id}
      ${Number.isFinite(limit) ? 'LIMIT ' + Number(limit) : ''}`,
    [STATUS.NEW]
  );

  let killed = 0;
  for (const job of rows) {
    const skip = preFilter(job);
    if (!skip) continue;
    killed += 1;
    if (dryRun) {
      log(`would filter out job ${job.id}: ${job.title}`);
    } else {
      await recordVerdict(job.id, STATUS.FILTERED_OUT, skip, null, { prefilter: true });
    }
  }

  log(`pre-filter${dryRun ? ' (dry run)' : ''}: ${killed} of ${rows.length} disqualified by title, ` +
      `${rows.length - killed} still need the model — 0 API calls made`);
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const useBatch = args.includes('--batch');
  const noWait = args.includes('--no-wait');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

  if (!Number.isFinite(limit) && limitFlag >= 0) {
    throw new Error('--limit requires a number');
  }

  if (args.includes('--prefilter-only') || args.includes('--prefilter-dry-run')) {
    await runPreFilterOnly(limit, args.includes('--prefilter-dry-run'));
    return;
  }

  await reclaimStaleClaims();

  const totals = {};
  const add = (counts) => {
    for (const [k, v] of Object.entries(counts || {})) totals[k] = (totals[k] || 0) + v;
  };

  // Finish what a previous run started before spending on anything new.
  if (useBatch) add(await resumeBatches());

  let processed = 0;

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

    log(`claimed batch of ${jobs.length}${useBatch ? ' (batch API)' : ''}`);
    add(useBatch ? await processBatchViaAPI(jobs, noWait) : await processBatch(jobs));
    processed += jobs.length;

    if (once) break;
  }

  log('run summary:', JSON.stringify(totals));
  logUsageSummary();
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
