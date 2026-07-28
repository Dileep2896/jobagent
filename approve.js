#!/usr/bin/env node
'use strict';

/**
 * Record your approval to submit one specific application.
 *
 * This is the human step CLAUDE.md requires. It is deliberately a separate
 * command from submit.js: approving and sending are two decisions, and
 * collapsing them into one flag makes it far too easy to send by accident.
 *
 * An approval is per job, expires (default 24h), and is single-use. It also
 * pins the resume file — if the resume is rebuilt afterwards, the approval no
 * longer refers to what would be sent and submit.js refuses.
 *
 * Usage:  node approve.js --job-id N [--note "..."] [--hours 24]
 *         node approve.js --list            show pending approvals
 *         node approve.js --revoke N        withdraw an approval
 */

const os = require('os');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const args = process.argv.slice(2);
  const arg = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

  if (args.includes('--list')) {
    const { rows } = await pool.query(
      `SELECT a.job_id, c.name AS company, j.title, a.approved_by, a.expires_at, a.consumed_at
         FROM approvals a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
        ORDER BY a.approved_at DESC LIMIT 25`
    );
    if (!rows.length) return log('no approvals recorded');
    for (const r of rows) {
      const state = r.consumed_at ? 'used' : new Date(r.expires_at) < new Date() ? 'EXPIRED' : 'pending';
      log(`  [${state}] job ${r.job_id}: ${r.company} — ${r.title} (by ${r.approved_by})`);
    }
    return;
  }

  if (args.includes('--revoke')) {
    const id = Number(arg('--revoke'));
    const { rowCount } = await pool.query('DELETE FROM approvals WHERE job_id = $1', [id]);
    return log(rowCount ? `approval for job ${id} revoked` : `no approval for job ${id}`);
  }

  const jobId = Number(arg('--job-id'));
  if (!Number.isInteger(jobId)) throw new Error('--job-id is required');
  const hours = Number(arg('--hours') || 24);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number');

  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.status, j.resume_path, j.applied_at, j.filter_score,
            c.name AS company
       FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
    [jobId]
  );
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  if (job.applied_at) throw new Error(`job ${jobId} was already applied to — nothing to approve`);
  if (job.status !== 'ready_for_review') {
    throw new Error(`job ${jobId} is '${job.status}' — run prefill.js so there is something to approve`);
  }
  if (!job.resume_path) throw new Error(`job ${jobId} has no resume — run generate.js first`);

  await pool.query(
    `INSERT INTO approvals (job_id, approved_by, resume_path, note, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
     ON CONFLICT (job_id) DO UPDATE
        SET approved_at = now(), approved_by = EXCLUDED.approved_by,
            resume_path = EXCLUDED.resume_path, note = EXCLUDED.note,
            expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
    [jobId, process.env.USER || os.userInfo().username, job.resume_path, arg('--note'), String(hours)]
  );

  log(`approved: ${job.company} — ${job.title}`);
  log(`  resume:  ${job.resume_path}`);
  log(`  expires: in ${hours}h`);
  log(`  submit:  node submit.js --job-id ${jobId} --confirm`);
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
