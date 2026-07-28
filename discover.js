#!/usr/bin/env node
'use strict';

/**
 * Stage 1: discovery.
 *
 * Polls the public job-board APIs for every active company in the `companies`
 * watchlist, normalises each posting, and upserts it into `jobs` deduped on
 * (company_id, external_id).
 *
 * Only public board APIs are used — no scraping, no authenticated endpoints,
 * no LinkedIn. Requests are sequential with a delay between companies.
 *
 * Idempotency: the upsert refreshes content fields but NEVER touches `status`.
 * Re-running discovery therefore cannot resurrect a job the filter already
 * decided on, and cannot cause a job to be paid for twice. Each company is
 * committed independently, so an interrupted run just re-polls next time.
 *
 * Usage:  node discover.js [--dry-run] [--company <board_token>]
 */

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const USER_AGENT = 'jobagent/1.0 (personal job-application pipeline; dkus2896@gmail.com)';
const REQUEST_TIMEOUT_MS = 45000;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const DELAY_BETWEEN_COMPANIES_MS = 1500; // be a polite client
const MAX_DESCRIPTION_CHARS = 40000; // filter.js truncates further at call time

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// HTML -> plain text
//
// Greenhouse returns HTML that is itself entity-encoded ("&lt;p&gt;"), so its
// content needs one decode pass before it is even HTML. Lever's list bodies
// are ordinary HTML fragments. Ashby gives us plain text directly.
// ---------------------------------------------------------------------------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n- ')
      .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s) => (s && s.length > MAX_DESCRIPTION_CHARS ? s.slice(0, MAX_DESCRIPTION_CHARS) : s);

// ---------------------------------------------------------------------------
// HTTP with retry/backoff (this box is on wifi and will drop)
// ---------------------------------------------------------------------------
function backoffMs(attempt) {
  return Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt));
}

async function fetchJson(url) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // 404 means the board token is wrong — retrying will never fix it.
      if (res.status === 404) {
        const err = new Error(`board not found (404) — check board_token`);
        err.permanent = true;
        throw err;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`upstream returned ${res.status}`);
      }
      if (!res.ok) {
        const err = new Error(`upstream returned ${res.status}`);
        err.permanent = true;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.permanent) throw err;
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const delay = backoffMs(attempt);
      log(`  ${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`gave up after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

// ---------------------------------------------------------------------------
// Per-board adapters. Each returns a normalised posting array.
// ---------------------------------------------------------------------------
const BOARDS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
    parse: (body) =>
      (body.jobs || []).map((j) => ({
        external_id: String(j.id),
        title: j.title || null,
        location: (j.location && j.location.name) || null,
        url: j.absolute_url || null,
        // content is entity-encoded HTML: decode once to get HTML, then strip.
        description: htmlToText(decodeEntities(j.content || '')),
      })),
  },

  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    parse: (body) =>
      (Array.isArray(body) ? body : []).map((j) => {
        // The JD is split across the intro, the bulleted lists, and a trailing
        // benefits/EEO block. Concatenate to reconstruct the full posting.
        const parts = [j.descriptionPlain || ''];
        for (const list of j.lists || []) {
          parts.push(`\n${list.text || ''}\n${htmlToText(list.content || '')}`);
        }
        if (j.additionalPlain) parts.push(`\n${j.additionalPlain}`);
        return {
          external_id: String(j.id),
          title: j.text || null,
          location: (j.categories && j.categories.location) || null,
          url: j.hostedUrl || j.applyUrl || null,
          description: parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        };
      }),
  },

  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    parse: (body) =>
      (body.jobs || [])
        .filter((j) => j.isListed !== false)
        .map((j) => ({
          external_id: String(j.id),
          title: (j.title || '').trim() || null,
          location: j.location || null,
          url: j.jobUrl || j.applyUrl || null,
          description: (j.descriptionPlain || htmlToText(j.descriptionHtml || '')).trim(),
        })),
  },
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Upsert one posting.
 *
 * The DO UPDATE deliberately omits `status`, `filter_reason` and
 * `filter_attempts`: re-discovering a job must never undo a filter verdict or
 * re-queue something already paid for. It also only fires when a content field
 * actually changed, so unchanged rows keep their original updated_at and don't
 * churn the stale-claim index.
 *
 * Returns 'inserted' | 'updated' | 'unchanged'.
 */
async function upsertJob(companyId, posting) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (company_id, external_id, title, location, url, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, external_id) DO UPDATE
        SET title       = EXCLUDED.title,
            location    = EXCLUDED.location,
            url         = EXCLUDED.url,
            description = EXCLUDED.description,
            updated_at  = now()
      WHERE jobs.title       IS DISTINCT FROM EXCLUDED.title
         OR jobs.location    IS DISTINCT FROM EXCLUDED.location
         OR jobs.url         IS DISTINCT FROM EXCLUDED.url
         OR jobs.description IS DISTINCT FROM EXCLUDED.description
     RETURNING (xmax = 0) AS inserted`,
    [
      companyId,
      posting.external_id,
      posting.title,
      posting.location,
      posting.url,
      clip(posting.description) || null,
    ]
  );

  if (rows.length === 0) return 'unchanged'; // conflict, but nothing differed
  return rows[0].inserted ? 'inserted' : 'updated';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function pollCompany(company, dryRun) {
  const adapter = BOARDS[company.board];
  if (!adapter) throw new Error(`no adapter for board '${company.board}'`);

  const body = await fetchJson(adapter.url(company.board_token));
  const postings = adapter.parse(body).filter((p) => p.external_id);

  const counts = { found: postings.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const posting of postings) {
    // A posting with no description is useless to the filter and would just
    // burn a call to be told the JD is empty.
    if (!posting.description) {
      counts.skipped += 1;
      continue;
    }
    if (dryRun) continue;
    counts[await upsertJob(company.id, posting)] += 1;
  }

  if (!dryRun) {
    await pool.query('UPDATE companies SET last_polled_at = now() WHERE id = $1', [company.id]);
  }
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.includes('--company') ? args[args.indexOf('--company') + 1] : null;

  const { rows: companies } = await pool.query(
    `SELECT id, name, board, board_token FROM companies
      WHERE active AND ($1::text IS NULL OR board_token = $1)
      ORDER BY id`,
    [only]
  );

  if (companies.length === 0) {
    log(only ? `no active company with board_token='${only}'` : 'watchlist is empty');
    return;
  }

  log(`polling ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}${dryRun ? ' (dry run)' : ''}`);
  const totals = { found: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  let failures = 0;

  for (const [i, company] of companies.entries()) {
    if (i > 0) await sleep(DELAY_BETWEEN_COMPANIES_MS);
    try {
      const c = await pollCompany(company, dryRun);
      for (const k of Object.keys(totals)) totals[k] += c[k];
      log(
        `${company.name} (${company.board}): ${c.found} found, ` +
          `${c.inserted} new, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped} skipped`
      );
    } catch (err) {
      // One bad board must not abort the run — the rest of the watchlist is
      // still pollable, and this company retries on the next pass.
      failures += 1;
      log(`${company.name} (${company.board}): FAILED — ${err.message}`);
    }
  }

  log('totals:', JSON.stringify(totals), failures ? `(${failures} compan${failures === 1 ? 'y' : 'ies'} failed)` : '');
  if (failures === companies.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    log('fatal:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
