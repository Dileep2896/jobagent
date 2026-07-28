#!/usr/bin/env node
'use strict';

/**
 * Pipeline notifier — posts a digest to Discord or Slack.
 *
 * WHAT THIS REPORTS, AND WHAT IT DOES NOT
 * This pipeline never submits an application (see CLAUDE.md: stage 5 stops at
 * ready_for_review, and screening questions are always answered by a human).
 * So there is no "applied" event to report. What this sends is pipeline state:
 * what was discovered, what passed the fit filter, what is waiting on YOU, and
 * what errored. Treat every digest as a to-do list, not a receipt.
 *
 * Both Discord and Slack are supported; the format is chosen from the webhook
 * hostname, so you only ever set one env var.
 *
 *   export JOBAGENT_WEBHOOK_URL='https://discord.com/api/webhooks/...'
 *   export JOBAGENT_WEBHOOK_URL='https://hooks.slack.com/services/...'
 *
 * Idempotency: a job is stamped `notified_at` only after the webhook that
 * mentioned it returned success. A crash or a failed delivery therefore
 * re-sends next run instead of silently dropping jobs, and a successful run
 * never repeats itself.
 *
 * Usage:  node notify.js [--dry-run] [--limit N]
 */

const { Pool } = require('pg');

const WEBHOOK_URL = process.env.JOBAGENT_WEBHOOK_URL || '';
const MAX_JOBS_PER_DIGEST = 25; // keep messages readable; the rest go next run
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

function detectPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`JOBAGENT_WEBHOOK_URL is not a valid URL`);
  }
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
  if (/(^|\.)slack\.com$/.test(host)) return 'slack';
  throw new Error(`unrecognised webhook host '${host}' — expected discord.com or hooks.slack.com`);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------
async function gatherDigest(limit) {
  const { rows: counts } = await pool.query(
    `SELECT status, count(*)::int AS n FROM jobs GROUP BY status`
  );
  const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));

  // Newly shortlisted jobs the user has not been told about yet. These are the
  // actionable items — everything else is just a running total.
  const { rows: fresh } = await pool.query(
    `SELECT j.id, j.title, j.location, j.url, j.filter_reason, c.name AS company
       FROM jobs j
       JOIN companies c ON c.id = j.company_id
      WHERE j.status = 'shortlisted' AND j.notified_at IS NULL
      ORDER BY j.id
      LIMIT $1`,
    [limit]
  );

  const { rows: [{ n: pending }] } = await pool.query(
    `SELECT count(*)::int AS n FROM jobs
      WHERE status = 'shortlisted' AND notified_at IS NULL`
  );

  return { by, fresh, pending, overflow: Math.max(0, pending - fresh.length) };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function summaryLine(by) {
  return (
    `Pipeline: ${by.new || 0} awaiting filter · ${by.shortlisted || 0} shortlisted · ` +
    `${by.filtered_out || 0} filtered out` +
    (by.filter_failed ? ` · ${by.filter_failed} failed` : '')
  );
}

function buildLines(digest) {
  const { by, fresh, overflow } = digest;
  const lines = [];

  lines.push(summaryLine(by));

  if (fresh.length === 0) {
    lines.push('', 'No new shortlisted jobs since the last digest.');
    return lines;
  }

  lines.push('', `${fresh.length} new shortlisted job${fresh.length === 1 ? '' : 's'} to review:`);
  for (const j of fresh) {
    const where = j.location ? ` — ${truncate(j.location, 40)}` : '';
    const title = truncate(j.title || '(untitled)', 90);
    lines.push(j.url ? `• ${j.company}: ${title}${where}\n  ${j.url}` : `• ${j.company}: ${title}${where}`);
    if (j.filter_reason) lines.push(`  ↳ ${truncate(j.filter_reason, 160)}`);
  }
  if (overflow > 0) lines.push('', `…and ${overflow} more, queued for the next digest.`);

  lines.push('', 'Nothing has been submitted — these need your review.');
  return lines;
}

/** Discord caps content at 2000 chars, Slack at ~3000 for a text block. */
function chunk(lines, limit) {
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > limit && buf) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Discord's documented ceilings. The 6000-char cap is across ALL embeds in a
// message, not per embed, and exceeding any of these is a 400 — so chunking
// has to respect both the count and the running character total.
const DISCORD = { embedsPerMessage: 10, totalEmbedChars: 6000, title: 256, description: 4096 };

/** Rich embeds: each job becomes a tappable card rather than a line of text. */
function buildDiscordPayloads(digest) {
  const { by, fresh, overflow } = digest;
  const summary = summaryLine(by);

  if (fresh.length === 0) {
    return [
      {
        content: `${summary}\n\nNo new shortlisted jobs since the last digest.`,
        allowed_mentions: { parse: [] },
      },
    ];
  }

  const embeds = fresh.map((j) => {
    const e = {
      title: truncate(`${j.company} — ${j.title || '(untitled)'}`, DISCORD.title - 6),
      description: truncate(j.filter_reason || '', 300),
      color: 0x2ea043,
    };
    if (j.url) e.url = j.url; // makes the title tappable
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
    const payload = { embeds: g, allowed_mentions: { parse: [] } };
    if (i === 0) {
      payload.content =
        `${summary}\n\n**${fresh.length} new shortlisted job${fresh.length === 1 ? '' : 's'} to review:**`;
    }
    if (i === groups.length - 1) {
      const tail = ['Nothing has been submitted — these need your review.'];
      if (overflow > 0) tail.unshift(`…and ${overflow} more, queued for the next digest.`);
      payload.content = `${payload.content ? `${payload.content}\n` : ''}${tail.join('\n')}`;
    }
    return payload;
  });
}

function buildPayloads(platform, digest) {
  if (platform === 'discord') return buildDiscordPayloads(digest);
  return chunk(buildLines(digest), 2900).map((text) => ({
    text,
    unfurl_links: false,
    unfurl_media: false,
  }));
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
function backoffMs(attempt) {
  return Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt));
}

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

      // Both platforms rate-limit; Discord sends retry_after (seconds).
      if (res.status === 429) {
        const body = await res.text();
        let waitMs = backoffMs(attempt);
        try {
          const parsed = JSON.parse(body);
          if (parsed.retry_after) waitMs = Math.min(MAX_BACKOFF_MS, parsed.retry_after * 1000);
        } catch { /* header-only rate limit; fall back to backoff */ }
        if (attempt === MAX_RETRIES) throw new Error('rate limited, retries exhausted');
        log(`  rate limited — waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      // 4xx other than 429 means a bad or revoked webhook URL. Retrying an
      // invalid webhook forever would just wedge the digest.
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
      const delay = backoffMs(attempt);
      log(`  ${err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`delivery failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limit = args.includes('--limit')
    ? Number(args[args.indexOf('--limit') + 1])
    : MAX_JOBS_PER_DIGEST;

  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit requires a positive number');

  if (!WEBHOOK_URL && !dryRun) {
    throw new Error(
      'JOBAGENT_WEBHOOK_URL is not set.\n' +
        '  Discord: Server Settings > Integrations > Webhooks > New Webhook > Copy URL\n' +
        '  Slack:   api.slack.com/apps > your app > Incoming Webhooks > Add New Webhook\n' +
        '  Then:    export JOBAGENT_WEBHOOK_URL=\'<paste>\''
    );
  }

  const platform = WEBHOOK_URL ? detectPlatform(WEBHOOK_URL) : 'discord';
  const digest = await gatherDigest(limit);
  const payloads = buildPayloads(platform, digest);

  if (dryRun) {
    log(`[dry run] ${platform}, ${payloads.length} message(s):`);
    for (const p of payloads) {
      console.log('---');
      if (p.content || p.text) console.log(p.content || p.text);
      for (const e of p.embeds || []) {
        console.log(`  [${e.title}]${e.url ? ` <${e.url}>` : ''}`);
        if (e.description) console.log(`     ${e.description}`);
        if (e.footer) console.log(`     (${e.footer.text})`);
      }
    }
    return;
  }

  for (const payload of payloads) await post(WEBHOOK_URL, payload);

  // Stamp only after every message landed.
  if (digest.fresh.length > 0) {
    await pool.query(`UPDATE jobs SET notified_at = now() WHERE id = ANY($1)`, [
      digest.fresh.map((j) => j.id),
    ]);
  }

  log(
    `sent ${payloads.length} message(s) to ${platform}; ` +
      `${digest.fresh.length} job(s) marked notified` +
      (digest.overflow ? `, ${digest.overflow} queued for next run` : '')
  );
}

main()
  .catch((err) => {
    log('fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
