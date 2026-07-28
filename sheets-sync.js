#!/usr/bin/env node
'use strict';

/**
 * Logs APPLIED jobs to a Google Sheet — one row per real submission, whether
 * the agent made it or you did by hand. Not a mirror of the whole pipeline:
 * a job appears only once applied_at is set, and its row then tracks the
 * outcome (applied -> interview / rejected).
 *
 * Postgres stays the source of truth. The sheet is a view you can annotate;
 * nothing here reads your edits back into the database.
 *
 * Reconciliation is by Job ID (column A), not by remembered row number, so
 * reordering, sorting, or deleting rows by hand cannot corrupt the mapping —
 * a deleted row is simply re-appended on the next sync.
 *
 * Setup: same service account as drive-upload.js, plus
 *   1. Enable the Google Sheets API on the project.
 *   2. Share the sheet with the service account's client_email, as Editor.
 *   3. export GSHEET_ID=<spreadsheet id from its URL>
 *
 * Usage:  node sheets-sync.js [--check] [--all] [--dry-run]
 */

const fs = require('fs');
const { Pool } = require('pg');
const os = require('os');
const { GoogleAuth } = require('google-auth-library');

// MEASURED, not assumed: drive.file lets you CREATE a spreadsheet via the
// Sheets API but every values read/write 404s, whatever the range format. The
// values endpoints need the spreadsheets scope. That scope is being blocked
// for gcloud's default ADC client, so Sheets uses the SERVICE ACCOUNT instead
// — which can request it without user consent, and needs no storage quota
// because it only edits a sheet you already own.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SHEET_ID = process.env.GSHEET_ID || '';
const TAB = process.env.GSHEET_TAB || 'Sheet1';
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;

const HEADERS = [
  'Job ID', 'Discovered', 'Company', 'Title', 'Location', 'Score',
  'Status', 'Applied', 'How', 'Resume PDF', 'Job Posting', 'Filter Reason',
];

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (n) => Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** n));

async function getToken() {
  // Service account, deliberately: see the SCOPES note above. The sheet must
  // be shared with the key's client_email as Editor — sharing is a per-identity
  // grant, unlike drive.file which is per-application.
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set — Sheets uses the service account key.\n' +
      '  export GOOGLE_APPLICATION_CREDENTIALS=~/.config/jobagent/gdrive.json'
    );
  }
  const client = await new GoogleAuth({ scopes: SCOPES }).getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('no access token returned');

  let quotaProject = process.env.GOOGLE_CLOUD_PROJECT || client.quotaProjectId || null;
  if (!quotaProject) {
    const adc = require('path').join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
    if (fs.existsSync(adc)) {
      try { quotaProject = JSON.parse(fs.readFileSync(adc, 'utf8')).quota_project_id || null; } catch {}
    }
  }
  return { token, quotaProject };
}



async function request(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res;

      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`Sheets returned ${res.status}`);

      const err = new Error(`Sheets rejected the request (${res.status}): ${text.slice(0, 300)}`);
      err.permanent = true;
      if (res.status === 403 || res.status === 404) {
        err.message +=
          `\n  Almost always one of two things:` +
          `\n   - the sheet was never shared with the service account (share it as Editor), or` +
          `\n   - the Google Sheets API is not enabled on the project.`;
      }
      throw err;
    } catch (e) {
      if (e.permanent) throw e;
      lastErr = e;
      if (attempt === MAX_RETRIES) break;
      const d = backoffMs(attempt);
      log(`  ${e.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${d}ms`);
      await sleep(d);
    }
  }
  throw new Error(`sheets request failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

const api = (path) => `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`;
const auth = (a) => {
  const h = { authorization: `Bearer ${a.token}` };
  if (a.quotaProject) h['x-goog-user-project'] = a.quotaProject;
  return h;
};

/** Map of Job ID -> 1-based sheet row, read fresh every run. */
async function readIndex(token) {
  const res = await request(
    api(`/values/${encodeURIComponent(TAB)}!A:A?majorDimension=COLUMNS`),
    { headers: auth(token) }
  );
  const body = await res.json();
  const col = (body.values && body.values[0]) || [];
  const index = new Map();
  col.forEach((v, i) => {
    const id = Number(String(v).trim());
    if (Number.isInteger(id) && id > 0) index.set(id, i + 1); // 1-based
  });
  return { index, rowCount: col.length };
}

async function ensureHeaders(token, rowCount) {
  if (rowCount > 0) return;
  await request(
    api(`/values/${encodeURIComponent(TAB)}!A1?valueInputOption=RAW`),
    {
      method: 'PUT',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ values: [HEADERS] }),
    }
  );
  log('wrote header row');
}

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function toRow(j) {
  return [
    String(j.id),
    fmtDate(j.first_seen_at),
    j.company || '',
    j.title || '',
    j.location || '',
    j.filter_score == null ? '' : Number(j.filter_score).toFixed(1),
    j.status,
    fmtDate(j.applied_at),
    j.applied_method || '',
    j.resume_drive_url || '',
    j.url || '',
    j.filter_reason || '',
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');

  if (!SHEET_ID) throw new Error('GSHEET_ID is not set — take it from the spreadsheet URL.');

  const token = await getToken();

  if (args.includes('--check')) {
    const res = await request(api('?fields=properties.title,sheets.properties.title'), { headers: auth(token) });
    const meta = await res.json();
    const creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    log(`✓ authenticated as ${creds.client_email}`);
    log(`✓ sheet reachable: "${meta.properties.title}"`);
    log(`  tabs: ${meta.sheets.map((s) => s.properties.title).join(', ')}`);
    return;
  }

  // Applied jobs only. The sheet is an application log, not a pipeline mirror:
  // shortlisted-but-not-applied jobs live in Discord and Postgres, and putting
  // them here would bury the rows that represent real submissions.
  // applied_at is the truth test — status then tracks the outcome
  // (applied -> interview / rejected).
  const { rows: jobs } = await pool.query(
    `SELECT j.id, j.title, j.location, j.url, j.status, j.filter_score, j.filter_reason,
            j.first_seen_at, j.applied_at, j.applied_method, j.resume_drive_url,
            c.name AS company
       FROM jobs j
       JOIN companies c ON c.id = j.company_id
      WHERE j.applied_at IS NOT NULL
        ${all ? '' : 'AND (j.sheet_synced_at IS NULL OR j.updated_at > j.sheet_synced_at)'}
      ORDER BY j.id`
  );

  if (jobs.length === 0) {
    log('nothing to sync');
    return;
  }

  if (dryRun) {
    log(`[dry run] would sync ${jobs.length} row(s):`);
    for (const j of jobs.slice(0, 10)) console.log('  ' + toRow(j).slice(0, 8).join(' | '));
    if (jobs.length > 10) console.log(`  …and ${jobs.length - 10} more`);
    return;
  }

  const { index, rowCount } = await readIndex(token);
  await ensureHeaders(token, rowCount);

  const updates = [];
  const appends = [];
  for (const j of jobs) {
    const row = toRow(j);
    // node-postgres returns bigint columns as strings, and the sheet index is
    // keyed by number — compare as numbers or every existing row is treated as
    // new and the sheet accumulates duplicates.
    const at = index.get(Number(j.id));
    if (at) updates.push({ range: `${TAB}!A${at}`, values: [row] });
    else appends.push(row);
  }

  if (updates.length > 0) {
    await request(api('/values:batchUpdate'), {
      method: 'POST',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    });
  }
  if (appends.length > 0) {
    await request(
      api(`/values/${encodeURIComponent(TAB)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`),
      {
        method: 'POST',
        headers: { ...auth(token), 'content-type': 'application/json' },
        body: JSON.stringify({ values: appends }),
      }
    );
  }

  // Stamped only after the write landed, so a failure re-syncs next run.
  await pool.query(`UPDATE jobs SET sheet_synced_at = now() WHERE id = ANY($1)`, [jobs.map((j) => j.id)]);
  log(`synced ${jobs.length} row(s): ${appends.length} added, ${updates.length} updated`);
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
