#!/usr/bin/env node
'use strict';

/**
 * Stage 6: submit an application — but only after you approved that exact job.
 *
 * This is the only script in the pipeline that sends something irreversible to
 * a real employer, so every guard is deliberately fail-closed. It refuses
 * unless ALL of these hold:
 *
 *   1. The job is at ready_for_review.
 *   2. An unexpired, unconsumed approval exists for that job id.
 *   3. The resume on disk is the same one that was approved.
 *   4. The job has not already been applied to (applied_at is null).
 *   5. After filling, NO required control on the live form is still empty.
 *   6. A form was actually found: a resume upload was accepted and at least
 *      MIN_FILLED_FIELDS controls were populated. Guard 5 alone is trivially
 *      satisfied by a page with no form on it.
 *   7. The resume on disk is the one generate.js built for THIS job, checked by
 *      its deterministic filename.
 *   8. The resume is STILL attached at the moment of the click. Guards 6 and 7
 *      both run too early to see a board that drops the upload afterwards.
 *
 * Guard 5 matters as much as the approval: an approved-but-incomplete
 * application is just as damaging as a wrong one, and the board's own scripts
 * can clear a field after we set it. The audit re-reads the DOM rather than
 * trusting what the fill step reported.
 *
 * --auto replaces guard 2 ONLY, and nothing else. The audit becomes the
 * approver: if every required field is populated and every question already had
 * a pre-written answer, the application is complete by inspection and a human
 * ticking a box adds no information. An approval row is still written, stamped
 * approved_by='auto', so the trail is identical to a hand-approved submission.
 * Guards 1, 3, 4 and 5 are untouched, --confirm is still required to send, and
 * anything the audit cannot fully satisfy still stops at ready_for_review for a
 * human. That covers every Lever posting (the location field cannot be filled
 * headlessly) and anything with a job-specific question.
 *
 * Approve with:  node approve.js --job-id N
 * Submit with:   node submit.js --job-id N            (dry run by default)
 *                node submit.js --job-id N --confirm  (actually submits)
 *                node submit.js --job-id N --auto --confirm   (no human step)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Pool } = require('pg');
const { fillForm, auditRequired, applyUrlFor, surveyOpenQuestions } = require('./lib/form-fill');
const { writeAnswers } = require('./lib/answer-writer');

const FACTS_PATH = process.env.MASTER_FACTS || 'master-facts.json';
const SHOT_DIR = process.env.PREFILL_SHOTS || path.join(__dirname, 'build', 'prefill');
const NAV_TIMEOUT_MS = 60000;
// A real application form takes a resume plus at least a name and an email.
// Below this we are not looking at an application form. See guard 6.
const MIN_FILLED_FIELDS = 3;
const SUBMIT_RE = /submit|send application|apply now|finish/i;

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function main() {
  const args = process.argv.slice(2);
  const idFlag = args.indexOf('--job-id');
  if (idFlag < 0) throw new Error('--job-id is required');
  const jobId = Number(args[idFlag + 1]);
  if (!Number.isInteger(jobId)) throw new Error('--job-id must be an integer');

  // Dry run is the DEFAULT. Sending an application must be something you typed
  // on purpose, not something you got by forgetting a flag.
  const confirm = args.includes('--confirm');
  // Replaces the human approval, and only that. See the header.
  const auto = args.includes('--auto');

  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));

  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.url, j.external_id, j.status, j.resume_path,
            j.applied_at, c.name AS company, c.board, c.board_token,
            a.approved_at, a.approved_by, a.expires_at, a.consumed_at,
            a.resume_path AS approved_resume
       FROM jobs j
       JOIN companies c ON c.id = j.company_id
  LEFT JOIN approvals a ON a.job_id = j.id
      WHERE j.id = $1`,
    [jobId]
  );
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  // ---- Guards, all fail-closed -------------------------------------------
  if (job.applied_at) {
    throw new Error(`job ${jobId} was already applied to on ${job.applied_at.toISOString()} — refusing to submit twice`);
  }
  if (job.status !== 'ready_for_review') {
    throw new Error(`job ${jobId} is '${job.status}', expected 'ready_for_review' — run prefill.js first`);
  }
  // In --auto the approval is granted later, by the audit, so these three
  // approval guards do not apply. An ALREADY-CONSUMED approval still blocks,
  // because that means this job was submitted once before.
  if (!auto) {
    if (!job.approved_at) {
      throw new Error(`job ${jobId} has no approval — run: node approve.js --job-id ${jobId}`);
    }
    if (new Date(job.expires_at) < new Date()) {
      throw new Error(`approval for job ${jobId} expired at ${job.expires_at.toISOString()} — re-approve to continue`);
    }
  }
  if (job.consumed_at) {
    throw new Error(`approval for job ${jobId} was already used at ${job.consumed_at.toISOString()}`);
  }
  if (job.approved_resume && job.resume_path && job.approved_resume !== job.resume_path) {
    throw new Error(`the resume changed since approval — approved ${job.approved_resume}, now ${job.resume_path}`);
  }
  if (!job.resume_path || !fs.existsSync(job.resume_path)) {
    throw new Error(`resume missing at ${job.resume_path} — run generate.js`);
  }

  // Guard 7: the resume must be THIS job's resume.
  //
  // generate.js names every PDF deterministically from the company and title, so
  // the filename is checkable evidence of what the document was tailored for.
  // Nothing else verifies this: resume_path is just a string, and a stale or
  // mis-set row would attach a resume written for another company without a
  // single guard objecting. A dry run during development attached a "Match Group
  // — Director of AI" resume to a Stripe backend application and every other
  // check passed it. That reaches a real employer under --auto.
  {
    // Must mirror generate.js exactly, including the job-id suffix that keeps
    // two identically-titled postings from sharing one file.
    const slug = `${job.company}_${job.title || 'role'}`.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
    const expected = `${facts.contact.name.replace(/[^A-Za-z0-9]+/g, '_')}_${slug}_${job.id}`;
    const actual = path.basename(job.resume_path, '.pdf');
    if (actual !== expected) {
      throw new Error(
        `resume does not belong to this job — expected "${expected}.pdf", found "${actual}.pdf". ` +
        `Re-run: node generate.js --job-id ${jobId}`
      );
    }
  }

  // Why this job could not be sent, recorded for the tracking sheet so the human
  // sees the exact blocking question instead of a bare "not applied". Only
  // written in --auto: a hand-driven run is already being watched by a person.
  const recordBlocker = async (why) => {
    if (!auto) return;
    await pool.query(
      `UPDATE jobs SET submit_blocker = $1, submit_checked_at = now(), updated_at = now() WHERE id = $2`,
      [why ? String(why).slice(0, 800) : null, jobId]
    );
  };

  const applyUrl = applyUrlFor(job);
  log(`job ${job.id}: ${job.company} — ${job.title}`);
  log(auto && !job.approved_at
    ? 'approval: --auto (granted by the pre-flight audit, if it passes)'
    : `approved by ${job.approved_by} at ${job.approved_at.toISOString()}`);
  log(confirm ? 'MODE: LIVE SUBMIT' : 'MODE: dry run (pass --confirm to actually submit)');

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Safari/537.36',
    viewport: { width: 1280, height: 1600 },
  });

  // In dry run, block the submission at the network layer as well as not
  // clicking it — belt and braces, so a mistake here cannot send anything.
  const applyUrlObj = new URL(applyUrl);
  const applyPath = applyUrlObj.pathname.replace(/\/+$/, '');
  let blocked = null;
  if (!confirm) {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      let u;
      try { u = new URL(req.url()); } catch { return route.continue(); }
      if (u.origin !== applyUrlObj.origin) return route.continue();
      if (req.isNavigationRequest() || u.pathname.replace(/\/+$/, '') === applyPath) {
        blocked = req.url();
        return route.abort();
      }
      return route.continue();
    });
  }

  const page = await context.newPage();
  try {
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
    log(`filled ${res.filled.length}, unanswered ${res.unanswered.length}`);

    // ---- The pre-flight audit -------------------------------------------
    const blanks = await auditRequired(page);
    const before = path.join(SHOT_DIR, `job-${job.id}-before-submit.png`);
    await page.screenshot({ path: before, fullPage: true });

    // Unanswered questions are reported BEFORE blank required fields, because
    // they are the actionable half: a blank required field is usually just the
    // downstream symptom of a question nobody has answered, and naming the
    // question tells the human what to type. Reporting "9 x text (required,
    // empty)" first told them nothing they could act on.
    if (res.unanswered.length > 0) {
      log('REFUSING TO SUBMIT — questions with no pre-written answer:');
      for (const u of res.unanswered) log(`   ✗ ${u}`);
      await recordBlocker(`${res.unanswered.length} unanswered: ${res.unanswered.join('; ')}`);
      throw new Error(`${res.unanswered.length} unanswered question(s) — fill screening_answers in master-facts.json`);
    }
    if (blanks.length > 0) {
      log('REFUSING TO SUBMIT — required fields are still empty:');
      for (const b of blanks) log(`   ✗ ${b}`);
      log(`screenshot: ${before}`);
      await recordBlocker(`${blanks.length} required field(s) empty: ${blanks.slice(0, 10).join('; ')}`);
      throw new Error(`${blanks.length} required field(s) empty — an incomplete application is not sent`);
    }

    // ---- Guard 6: the audit must not pass VACUOUSLY ----------------------
    //
    // "No required field is empty" is trivially true on a page with no form at
    // all, and that is not a hypothetical: job-boards.greenhouse.io 302s Stripe
    // postings back to stripe.com/jobs, which is a description page with an
    // "Apply for this role" button and no inputs. fillForm reported 0 filled,
    // 0 unanswered, and the audit passed — on a page it could not have applied
    // from. Without this, --auto would go hunting for a submit button there.
    //
    // Every genuine application form takes a resume, so that is the test. The
    // field floor is a second signal: name and email at minimum accompany it.
    const attachedResume = res.filled.some((f) => /^resume\b/.test(f));
    if (!attachedResume || res.filled.length < MIN_FILLED_FIELDS) {
      log('REFUSING TO SUBMIT — this does not look like an application form:');
      log(`   ✗ ${res.filled.length} field(s) filled, resume attached: ${attachedResume}`);
      log(`   ✗ URL: ${applyUrl}`);
      log(`   screenshot: ${before}`);
      await recordBlocker(`no application form found at ${applyUrl} (${res.filled.length} field(s) filled) — apply by hand`);
      throw new Error(
        `form not found at ${applyUrl} — ${res.filled.length} field(s) filled` +
        `${attachedResume ? '' : ', no resume upload control'}. Refusing to submit into a page with no form.`
      );
    }

    log(`pre-flight audit passed: ${res.filled.length} field(s) filled, every required field populated`);

    // The audit passed, so in --auto this is where approval is granted. Written
    // before the click and with the exact resume that was audited, so the record
    // says what was actually sent rather than what was intended.
    if (auto && confirm) {
      await pool.query(
        `INSERT INTO approvals (job_id, approved_by, resume_path, note, expires_at)
         VALUES ($1, 'auto', $2, $3, now() + interval '1 hour')
         ON CONFLICT (job_id) DO UPDATE
            SET approved_at = now(), approved_by = 'auto', resume_path = EXCLUDED.resume_path,
                note = EXCLUDED.note, expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
        [job.id, job.resume_path, `auto-approved: audit clean, 0 unanswered questions, ${res.filled.length} field(s) filled`]
      );
      log('approval recorded as approved_by=auto');
    }

    if (!confirm) {
      log(`dry run complete — nothing submitted. Screenshot: ${before}`);
      if (blocked) log(`(a submission POST was attempted and blocked: ${blocked})`);
      return;
    }

    // ---- The only place anything is sent ---------------------------------
      // Prefer a real submit control; fall back to matching button text.
      //
      // This was written as `btn || (await page.$$('button')).find ? A : B`,
      // which parses as `(btn || (...).find) ? A : B` — always truthy, because
      // `.find` is an Array method. So the text scan ran even when btn was
      // already found, walking every button for nothing. When the browser closed
      // on an earlier error, those in-flight innerText() calls rejected with no
      // handler and crashed the process instead of reporting the real failure.
      let submitEl = await page.$('button[type=submit], input[type=submit]');
      if (!submitEl) {
        for (const b of await page.$$('button')) {
          const t = ((await b.innerText().catch(() => '')) || '').trim();
          if (SUBMIT_RE.test(t)) { submitEl = b; break; }
        }
      }
      if (!submitEl) throw new Error('could not find a submit control on the form');

    // ---- Guard 8: the resume must still be attached AT THE CLICK ----------
    //
    // Every earlier check happens too early to see this. Greenhouse uploads the
    // file to S3 (201) and then REMOVES the file input from the DOM, so
    // auditRequired finds no required file control to check, and guard 6 proved
    // the resume was attached during filling — minutes and nineteen fields
    // earlier. A real submission of job 66 was rejected by Stripe with
    // "Resume/CV is required" while every one of our guards had passed.
    //
    // So re-read the page immediately before clicking: the filename must be
    // visible and no required-field error may be showing.
    const resumeName = path.basename(job.resume_path);
    const stillAttached = await page.evaluate((name) => {
      const text = document.body.innerText || '';
      return { hasName: text.includes(name), hasError: /is required/i.test(text) };
    }, resumeName);
    if (!stillAttached.hasName || stillAttached.hasError) {
      await recordBlocker(
        `resume no longer attached at submit time (filename visible: ${stillAttached.hasName}, ` +
        `form showing a required-field error: ${stillAttached.hasError})`
      );
      throw new Error(
        `resume is not attached at submit time — the board dropped it after upload. ` +
        `Nothing was clicked. Screenshot: ${before}`
      );
    }

    log('submitting…');
    await submitEl.click();
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const after = path.join(SHOT_DIR, `job-${job.id}-after-submit.png`);
    await page.screenshot({ path: after, fullPage: true });

    const bodyText = ((await page.innerText('body').catch(() => '')) || '').toLowerCase();
    const confirmed = /thank you|application received|we.{0,3}ve received|successfully submitted|thanks for applying|application submitted/.test(bodyText);

    // Recording 'applied' without proof is the worst outcome available: the
    // job is never retried, so a silently failed submission becomes a job you
    // never applied to and never notice. Marking applied requires positive
    // evidence; without it the job stays ready_for_review, the approval is NOT
    // consumed, and the run fails loudly so it can be retried.
    if (!confirmed) {
      log('NO CONFIRMATION DETECTED — not marking this as applied.');
      log(`  before: ${before}`);
      log(`  after:  ${after}`);
      throw new Error(
        'submission could not be confirmed — the form may have been rejected by validation. ' +
        'Job left at ready_for_review with its approval intact; check the after screenshot.'
      );
    }

    await pool.query(
      `UPDATE jobs
          SET status = 'applied', applied_at = now(), applied_method = 'agent',
              outcome_evidence = 'confirmation page detected',
              submit_blocker = NULL, submit_checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [job.id]
    );
    await pool.query(`UPDATE approvals SET consumed_at = now() WHERE job_id = $1`, [job.id]);

    log('✓ submitted — confirmation page detected');
    log(`  before: ${before}`);
    log(`  after:  ${after}`);
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
