#!/usr/bin/env node
'use strict';

/**
 * Stage 5: open a job's application form, fill what can be filled truthfully,
 * and STOP.
 *
 * THIS SCRIPT NEVER SUBMITS. CLAUDE.md requires explicit human approval before
 * any application is sent, so there is no code path here that clicks a submit
 * control — and a guard actively blocks the request if a stray interaction ever
 * tries. It fills, screenshots, records what it could not answer, and sets the
 * job to ready_for_review.
 *
 * What it will fill: name, email, phone, location, and profile links, plus
 * screening answers YOU pre-wrote in master-facts.json, matched on the
 * question's own label.
 *
 * What it deliberately will NOT fill:
 *   - EEO/demographic questions (pronouns, gender, race, veteran, disability).
 *     These are voluntary and personal; guessing them is not the agent's call.
 *   - Any screening question with no pre-written answer. Work authorization and
 *     sponsorship are legal attestations — an unanswered one is reported, never
 *     inferred.
 *
 * Usage:  node prefill.js --job-id N [--headed] [--keep-open]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Pool } = require('pg');
const { fillForm, applyUrlFor, surveyOpenQuestions } = require('./lib/form-fill');
const { writeAnswers } = require('./lib/answer-writer');

const FACTS_PATH = process.env.MASTER_FACTS || 'master-facts.json';
const SHOT_DIR = process.env.PREFILL_SHOTS || path.join(__dirname, 'build', 'prefill');
const NAV_TIMEOUT_MS = 60000;

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Anything matching this is voluntary demographic data or a control we must not
// touch. Checked against the field's label and name.
async function main() {
  const args = process.argv.slice(2);
  const idFlag = args.indexOf('--job-id');
  if (idFlag < 0) throw new Error('--job-id is required');
  const jobId = Number(args[idFlag + 1]);
  const headed = args.includes('--headed');

  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.url, j.external_id, j.resume_path,
            c.name AS company, c.board, c.board_token
       FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
    [jobId]
  );
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];
  if (!job.url) throw new Error(`job ${jobId} has no url`);

  // Each board serves its form at a different place, and the stored URL is not
  // always it: Stripe's Greenhouse links redirect to their own careers site,
  // which has no form at all, so Greenhouse is rebuilt from the board token and
  // external id instead of trusting job.url.
  const applyUrl = applyUrlFor(job);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
    viewport: { width: 1280, height: 1600 },
  });

  // Hard guard: block a real submission at the network layer, even if some
  // future refactor clicks something it should not.
  //
  // Matching on "apply" in the URL is far too broad — these pages embed
  // third-party widgets (LinkedIn's apply-with-linkedin, hCaptcha, Cloudflare)
  // that POST on load and would trip a naive guard on every run. A genuine
  // submission is same-origin AND either a form navigation or a multipart
  // upload, so require all of that before treating it as one.
  // Two refinements learned by running this against a live Lever form:
  //  - Matching "apply" anywhere in the URL trips on third-party widgets that
  //    POST on page load (LinkedIn's apply-with-linkedin, hCaptcha, Cloudflare).
  //  - Blocking every same-origin multipart POST trips on /parseResume, which
  //    is the form reading the uploaded PDF to autofill itself — part of
  //    filling, not submitting.
  // A real submission navigates, or posts to the application endpoint itself.
  // Anything else same-origin is the form doing its own work.
  const applyUrlObj = new URL(applyUrl);
  const applyPath = applyUrlObj.pathname.replace(/\/+$/, '');
  let submitAttempted = null;
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();

    let u;
    try { u = new URL(req.url()); } catch { return route.continue(); }
    if (u.origin !== applyUrlObj.origin) return route.continue();

    const postPath = u.pathname.replace(/\/+$/, '');
    const isSubmit = req.isNavigationRequest() || postPath === applyPath;

    if (isSubmit) {
      submitAttempted = req.url();
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();
  const filled = [];
  const skipped = [];
  const unanswered = [];

  try {
    log(`job ${job.id}: ${job.company} — ${job.title}`);
    log(`opening ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(2500);


    // Narrative questions the stored answers do not cover ("have you built AI
    // agents?", "why this role?"). Surveyed first so the writer is called ONCE
    // per job rather than once per question, and only for free-text areas —
    // lib/answer-writer.js refuses anything the attestation list recognises,
    // before any model call.
    let generated;
    if (!process.env.NO_GENERATED_ANSWERS) {
      try {
        const asks = await surveyOpenQuestions(page, facts);
        if (asks.length) {
          const written = await writeAnswers({ job, facts, questions: asks });
          generated = written.answers;
          for (const r of written.refused) log(`   ~ not written: ${r.question.slice(0, 60)} — ${r.reason}`);
          if (written.answers.size) log(`wrote ${written.answers.size} narrative answer(s)`);
        }
      } catch (err) {
        log(`answer-writer unavailable (${err.message.split('\n')[0]}) — those questions will stop for the human`);
      }
    }

    const res = await fillForm(page, facts, job.resume_path, { generated });
    filled.push(...res.filled);
    skipped.push(...res.skipped);
    unanswered.push(...res.unanswered);

    const shot = path.join(SHOT_DIR, `job-${job.id}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    if (submitAttempted) {
      throw new Error(`a form submission was attempted and blocked: ${submitAttempted}`);
    }

    log(`filled ${filled.length}:`);
    for (const f of filled) log(`   ✓ ${f}`);
    if (unanswered.length) {
      log(`needs you (${unanswered.length}):`);
      for (const u of unanswered) log(`   ! ${u}`);
    }
    log(`skipped ${skipped.length} demographic/optional control(s)`);
    log(`screenshot: ${shot}`);
    log('NOT submitted — this stops at ready_for_review by design.');

    await pool.query(
      `UPDATE jobs SET status = 'ready_for_review', updated_at = now() WHERE id = $1 AND status <> 'ready_for_review'`,
      [job.id]
    );
  } finally {
    if (!args.includes('--keep-open')) await browser.close();
  }
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
