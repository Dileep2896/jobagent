#!/usr/bin/env node
'use strict';

/**
 * Pipeline notifier — posts per-scenario digests to Discord (or Slack).
 *
 * WHAT THIS REPORTS, AND WHAT IT DOES NOT
 * This pipeline never submits an application on its own (CLAUDE.md: submission
 * requires explicit human approval, and screening questions are answered by the
 * human). Every digest is a to-do list, not a receipt.
 *
 * CHANNEL ROUTING
 * A Discord webhook is bound to one channel, so "one channel per scenario"
 * means one webhook per scenario. Set whichever you want; anything unset falls
 * back to JOBAGENT_WEBHOOK_URL, so a single-channel setup keeps working.
 *
 *   JOBAGENT_WEBHOOK_URL          fallback / default channel
 *   JOBAGENT_WEBHOOK_DISCOVERIES  #job-discoveries  — new postings found
 *   JOBAGENT_WEBHOOK_SHORTLIST    #job-shortlist    — passed the filter, scored
 *   JOBAGENT_WEBHOOK_REVIEW       #job-review       — awaiting your approval
 *   JOBAGENT_WEBHOOK_ERRORS       #job-errors       — failures needing a look
 *
 * Idempotency: a job is recorded in `notifications` for a scenario only after
 * the webhook carrying it succeeded, so a failed delivery re-sends next run and
 * a successful one never repeats.
 *
 * Usage:  node notify.js [--dry-run] [--scenario name] [--limit N]
 */

const { Pool } = require('pg');

const MAX_JOBS_PER_DIGEST = 25;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Scenarios. Each selects its own jobs and renders its own card.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  discoveries: {
    env: 'JOBAGENT_WEBHOOK_DISCOVERIES',
    colour: 0x58a6ff,
    // Volume channel. Discovery routinely finds hundreds of jobs at once, and
    // one card per posting would bury the shortlist channel you actually act
    // on. This posts a single roll-up instead, so it reads as a heartbeat:
    // the poller ran, here is what it found, the filter will triage it.
    summaryOnly: true,
    heading: (n) => `**${n} new job${n === 1 ? '' : 's'} discovered**`,
    empty: 'No new postings since the last digest.',
    sql: `SELECT j.id, j.title, j.location, j.url, NULL::text AS note, NULL::numeric AS score,
                 c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'discoveries'
           WHERE n.job_id IS NULL
        ORDER BY j.id
           LIMIT $1`,
  },

  shortlist: {
    env: 'JOBAGENT_WEBHOOK_SHORTLIST',
    colour: 0x2ea043,
    heading: (n) => `**${n} new shortlisted job${n === 1 ? '' : 's'} to review**`,
    empty: 'No new shortlisted jobs since the last digest.',
    footer: 'Nothing has been submitted — these need your review.',
    sql: `SELECT j.id, j.title, j.location, j.url, j.filter_reason AS note,
                 j.filter_score AS score, c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'shortlist'
           WHERE j.status = 'shortlisted' AND n.job_id IS NULL
        ORDER BY j.filter_score DESC NULLS LAST, j.id
           LIMIT $1`,
  },

  review: {
    env: 'JOBAGENT_WEBHOOK_REVIEW',
    colour: 0xd29922,
    heading: (n) => `**${n} application${n === 1 ? '' : 's'} ready for your approval**`,
    empty: 'Nothing awaiting approval.',
    footer: 'Approve to submit. Screening answers stay yours — nothing is auto-answered.',
    // Stage 5 is not built yet; the status simply never matches until it is.
    // The resume link is the whole point of this channel: when the agent
    // cannot finish a submission, this is what you open to apply by hand.
    sql: `SELECT j.id, j.title, j.location, j.url,
                 concat_ws(E'\n', j.filter_reason,
                           CASE WHEN j.resume_drive_url IS NOT NULL
                                THEN '📄 Resume: ' || j.resume_drive_url END) AS note,
                 j.filter_score AS score, c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'review'
           WHERE j.status = 'ready_for_review' AND n.job_id IS NULL
        ORDER BY j.id
           LIMIT $1`,
  },

  interview: {
    env: 'JOBAGENT_WEBHOOK_INTERVIEW',
    colour: 0xa371f7,
    heading: (n) => `**${n} interview${n === 1 ? '' : 's'} 🎉**`,
    empty: 'No interview invitations.',
    sql: `SELECT j.id, j.title, j.location, j.url,
                 concat_ws(E'\n', j.outcome_evidence,
                           CASE WHEN j.resume_drive_url IS NOT NULL
                                THEN '📄 Resume sent: ' || j.resume_drive_url END) AS note,
                 j.filter_score AS score, c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'interview'
           WHERE j.status = 'interview' AND n.job_id IS NULL
        ORDER BY j.outcome_at DESC NULLS LAST, j.id
           LIMIT $1`,
  },

  rejected: {
    env: 'JOBAGENT_WEBHOOK_REJECTED',
    colour: 0x6e7681,
    heading: (n) => `**${n} rejection${n === 1 ? '' : 's'}**`,
    empty: 'No rejections.',
    sql: `SELECT j.id, j.title, j.location, j.url, j.outcome_evidence AS note,
                 j.filter_score AS score, c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'rejected'
           WHERE j.status = 'rejected' AND n.job_id IS NULL
        ORDER BY j.outcome_at DESC NULLS LAST, j.id
           LIMIT $1`,
  },

  errors: {
    env: 'JOBAGENT_WEBHOOK_ERRORS',
    colour: 0xda3633,
    heading: (n) => `**${n} job${n === 1 ? ' needs' : 's need'} a look — filter failed**`,
    empty: 'No failures.',
    sql: `SELECT j.id, j.title, j.location, j.url, j.filter_reason AS note,
                 NULL::numeric AS score, c.name AS company
            FROM jobs j
            JOIN companies c ON c.id = j.company_id
       LEFT JOIN notifications n ON n.job_id = j.id AND n.scenario = 'errors'
           WHERE j.status = 'filter_failed' AND n.job_id IS NULL
        ORDER BY j.id
           LIMIT $1`,
  },
};

function webhookFor(scenario) {
  return process.env[SCENARIOS[scenario].env] || process.env.JOBAGENT_WEBHOOK_URL || '';
}

function detectPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('webhook URL is not a valid URL');
  }
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
  if (/(^|\.)slack\.com$/.test(host)) return 'slack';
  throw new Error(`unrecognised webhook host '${host}' — expected discord.com or hooks.slack.com`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// Discord's ceilings. The 6000 is across ALL embeds in a message, not each.
const DISCORD = { embedsPerMessage: 10, totalEmbedChars: 6000, title: 256 };

async function pipelineSummary() {
  const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return (
    `Pipeline: ${by.new || 0} awaiting filter · ${by.shortlisted || 0} shortlisted · ` +
    `${by.filtered_out || 0} filtered out` +
    (by.filter_failed ? ` · ${by.filter_failed} failed` : '')
  );
}

/** One roll-up message: counts by company, no per-job cards. */
function buildSummaryDiscord(scenario, jobs, summary) {
  const s = SCENARIOS[scenario];
  const byCompany = {};
  for (const j of jobs) byCompany[j.company] = (byCompany[j.company] || 0) + 1;
  const lines = Object.entries(byCompany)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([co, n]) => `• ${co}: ${n}`);

  return [
    {
      content: `${summary}\n\n${s.heading(jobs.length)}`,
      embeds: [
        {
          title: 'By company',
          description: truncate(lines.join('\n'), 3500) || '—',
          color: s.colour,
          footer: { text: 'Awaiting the fit filter — nothing scored yet.' },
        },
      ],
      allowed_mentions: { parse: [] },
    },
  ];
}

function buildDiscord(scenario, jobs, overflow, summary) {
  const s = SCENARIOS[scenario];

  if (jobs.length === 0) {
    return [{ content: `${summary}\n\n${s.empty}`, allowed_mentions: { parse: [] } }];
  }

  const embeds = jobs.map((j) => {
    const scoreTag = j.score != null ? `[${Number(j.score).toFixed(1)}] ` : '';
    const e = {
      title: truncate(`${scoreTag}${j.company} — ${j.title || '(untitled)'}`, DISCORD.title - 6),
      description: truncate(j.note || '', 300),
      color: s.colour,
    };
    if (j.url) e.url = j.url;
    if (j.location) e.footer = { text: truncate(j.location, 100) };
    return e;
  });

  const size = (e) =>
    (e.title || '').length + (e.description || '').length + ((e.footer && e.footer.text) || '').length;

  const groups = [];
  let group = [];
  let chars = 0;
  for (const e of embeds) {
    if (group.length >= DISCORD.embedsPerMessage || chars + size(e) > DISCORD.totalEmbedChars) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    group.push(e);
    chars += size(e);
  }
  if (group.length) groups.push(group);

  return groups.map((g, i) => {
    const p = { embeds: g, allowed_mentions: { parse: [] } };
    if (i === 0) p.content = `${summary}\n\n${s.heading(jobs.length)}`;
    if (i === groups.length - 1) {
      const tail = [];
      if (overflow > 0) tail.push(`…and ${overflow} more, queued for the next digest.`);
      if (s.footer) tail.push(s.footer);
      if (tail.length) p.content = `${p.content ? `${p.content}\n` : ''}${tail.join('\n')}`;
    }
    return p;
  });
}

function buildSlack(scenario, jobs, overflow, summary) {
  const s = SCENARIOS[scenario];
  const lines = [summary, ''];
  if (jobs.length === 0) lines.push(s.empty);
  else {
    lines.push(s.heading(jobs.length).replace(/\*\*/g, '*'));
    for (const j of jobs) {
      const score = j.score != null ? `[${Number(j.score).toFixed(1)}] ` : '';
      lines.push(`• ${score}${j.company}: ${truncate(j.title || '(untitled)', 90)}`);
      if (j.url) lines.push(`  ${j.url}`);
      if (j.note) lines.push(`  ↳ ${truncate(j.note, 160)}`);
    }
    if (overflow > 0) lines.push('', `…and ${overflow} more.`);
    if (s.footer) lines.push('', s.footer);
  }
  // Slack caps a text block around 3000 chars.
  const out = [];
  let buf = '';
  for (const l of lines) {
    const c = buf ? `${buf}\n${l}` : l;
    if (c.length > 2900 && buf) {
      out.push({ text: buf, unfurl_links: false, unfurl_media: false });
      buf = l;
    } else buf = c;
  }
  if (buf) out.push({ text: buf, unfurl_links: false, unfurl_media: false });
  return out;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
const backoffMs = (n) => Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** n));

async function post(url, payload) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return;

      if (res.status === 429) {
        const body = await res.text();
        let waitMs = backoffMs(attempt);
        try {
          const p = JSON.parse(body);
          if (p.retry_after) waitMs = Math.min(MAX_BACKOFF_MS, p.retry_after * 1000);
        } catch { /* header-only rate limit */ }
        if (attempt === MAX_RETRIES) throw new Error('rate limited, retries exhausted');
        log(`  rate limited — waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      // A revoked or mistyped webhook will never succeed; don't wedge the digest.
      if (res.status >= 400 && res.status < 500) {
        const err = new Error(`webhook rejected (${res.status}): ${truncate(await res.text(), 200)}`);
        err.permanent = true;
        throw err;
      }
      throw new Error(`webhook returned ${res.status}`);
    } catch (err) {
      if (err.permanent) throw err;
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const d = backoffMs(attempt);
      log(`  ${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${d}ms`);
      await sleep(d);
    }
  }
  throw new Error(`delivery failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

async function runScenario(name, { dryRun, limit, summary }) {
  const s = SCENARIOS[name];
  const url = webhookFor(name);
  if (!url && !dryRun) {
    log(`${name}: no webhook (${s.env} unset and no fallback) — skipped`);
    return { skipped: true };
  }

  // A summary scenario reports on everything outstanding, not a page of it —
  // otherwise the "N discovered" headline would undercount its own backlog.
  const effectiveLimit = s.summaryOnly ? 5000 : limit;
  const { rows: jobs } = await pool.query(s.sql, [effectiveLimit]);
  // Same query, effectively unbounded, to size the backlog behind this digest.
  // Keep the $1 placeholder — rewriting it out would leave a bound parameter
  // with nothing to bind to.
  const { rows: [{ n: pending }] } = await pool.query(
    `SELECT count(*)::int AS n FROM (${s.sql}) q`,
    [1000000]
  );
  const overflow = Math.max(0, pending - jobs.length);

  // Quiet scenarios stay quiet: an empty errors channel every hour is noise.
  if (jobs.length === 0 && name !== 'shortlist') {
    log(`${name}: nothing to report — skipped`);
    return { sent: 0, jobs: 0 };
  }

  const platform = url ? detectPlatform(url) : 'discord';
  const payloads =
    platform !== 'discord'
      ? buildSlack(name, jobs, overflow, summary)
      : s.summaryOnly
        ? buildSummaryDiscord(name, jobs, summary)
        : buildDiscord(name, jobs, overflow, summary);

  if (dryRun) {
    log(`[dry run] ${name} -> ${s.env}${process.env[s.env] ? '' : ' (falling back to default)'}, ${payloads.length} message(s):`);
    for (const p of payloads) {
      console.log('---');
      if (p.content || p.text) console.log(p.content || p.text);
      for (const e of p.embeds || []) {
        console.log(`  [${e.title}]${e.url ? ` <${e.url}>` : ''}`);
        if (e.description) console.log(`     ${e.description}`);
        if (e.footer) console.log(`     (${e.footer.text})`);
      }
    }
    return { sent: payloads.length, jobs: jobs.length, dryRun: true };
  }

  for (const p of payloads) await post(url, p);

  if (jobs.length > 0) {
    await pool.query(
      `INSERT INTO notifications (job_id, scenario)
       SELECT unnest($1::bigint[]), $2
       ON CONFLICT DO NOTHING`,
      [jobs.map((j) => j.id), name]
    );
  }
  log(`${name}: sent ${payloads.length} message(s), ${jobs.length} job(s) recorded${overflow ? `, ${overflow} queued` : ''}`);
  return { sent: payloads.length, jobs: jobs.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : MAX_JOBS_PER_DIGEST;

  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit requires a positive number');
  if (only && !SCENARIOS[only]) {
    throw new Error(`unknown scenario '${only}' — one of: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  if (!process.env.JOBAGENT_WEBHOOK_URL && !only && !dryRun) {
    const anyChannel = Object.values(SCENARIOS).some((s) => process.env[s.env]);
    if (!anyChannel) {
      throw new Error(
        'No webhook configured. Set JOBAGENT_WEBHOOK_URL, and optionally one per scenario:\n  ' +
          Object.entries(SCENARIOS).map(([k, s]) => `${s.env}  (${k})`).join('\n  ')
      );
    }
  }

  const summary = await pipelineSummary();
  const names = only ? [only] : Object.keys(SCENARIOS);
  for (const name of names) await runScenario(name, { dryRun, limit, summary });
}

main()
  .catch((err) => {
    log('fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
