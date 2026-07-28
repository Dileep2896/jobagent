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
const NEVER_FILL = /pronoun|gender|sex\b|race|ethnic|hispanic|latino|veteran|disab|lgbt|orientation|age\b|birth|salary expectation|desired (salary|compensation)/i;

const SUBMIT_LIKE = /submit|apply now|send application|finish/i;

// Ordered: first match wins, so "linkedin" is tested before generic "url".
const FIELD_MAP = [
  { re: /(^|\W)(full[\s_-]*name|legal[\s_-]*name|your[\s_-]*name|^name\*?$)/i, get: (f) => f.contact.name },
  { re: /first[\s_-]*name/i, get: (f) => f.contact.name.split(' ')[0] },
  { re: /last[\s_-]*name|surname|family[\s_-]*name/i, get: (f) => f.contact.name.split(' ').slice(-1)[0] },
  { re: /e[-\s_]*mail/i, get: (f) => f.contact.email },
  { re: /phone|mobile|telephone/i, get: (f) => f.contact.phone },
  { re: /linkedin/i, get: (f) => (f.contact.links || {}).linkedin },
  { re: /github/i, get: (f) => (f.contact.links || {}).github },
  { re: /portfolio|personal (site|website)|website|your site/i, get: (f) => (f.contact.links || {}).website },
  // \b matters: without it this matches "reLOCATION", and a yes/no relocation
  // question gets filled with a city name.
  { re: /\b(location|city|based in|current residence)\b/i, get: (f) => f.contact.location },
];

/** Screening answers are matched loosely against the question text. */
const SCREENING_MAP = [
  { re: /legally authorized|authorized to work|work authorization|right to work/i, key: 'work_authorization_us' },
  { re: /sponsor|visa|h-?1b/i, key: 'requires_sponsorship_now_or_future' },
  { re: /relocat/i, key: 'willing_to_relocate' },
  { re: /notice period|start date|available to start/i, key: 'notice_period' },
  { re: /years of experience|how many years/i, key: 'years_of_experience' },
];

function valueFor(facts, label, name) {
  const hay = `${label} ${name}`.trim();
  if (!hay || NEVER_FILL.test(hay)) return null;

  // Screening questions are checked FIRST. They are legal attestations and
  // their wording overlaps contact fields ("open to relocation" vs "location"),
  // so a contact-shaped match must never win over an attestation. If one
  // matches with no pre-written answer, return a marker so the caller reports
  // it rather than falling through and filling something wrong.
  for (const m of SCREENING_MAP) {
    if (m.re.test(hay)) {
      const v = (facts.screening_answers || {})[m.key];
      return v ? { value: v, source: `screening_answers.${m.key}` } : { needsHuman: m.key };
    }
  }
  for (const m of FIELD_MAP) {
    if (m.re.test(hay)) {
      const v = m.get(facts);
      return v ? { value: v, source: 'contact' } : null;
    }
  }
  return null;
}

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
  const applyUrl = (() => {
    if (job.board === 'lever') return /\/apply\/?$/.test(job.url) ? job.url : `${job.url}/apply`;
    if (job.board === 'ashby') return /\/application\/?$/.test(job.url) ? job.url : `${job.url}/application`;
    if (job.board === 'greenhouse' && job.board_token && job.external_id) {
      return `https://job-boards.greenhouse.io/${job.board_token}/jobs/${job.external_id}`;
    }
    return job.url;
  })();

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

    // Upload the resume FIRST and let the parser finish. Lever (and Greenhouse)
    // read the PDF and autofill the form themselves — anything typed before
    // that lands gets silently overwritten. The screenshot from the first run
    // showed "Current location" reported as filled but actually empty for
    // exactly this reason.
    // Ashby and Greenhouse both render MULTIPLE file inputs — Resume and Cover
    // Letter. Uploading to all of them would attach the resume as the cover
    // letter, which looks careless to a reviewer and is hard to spot. Identify
    // the resume slot from its surrounding text; anything that looks like a
    // cover letter is left alone.
    // Ashby and Greenhouse both render MULTIPLE file inputs — typically an
    // unlabelled one, a Resume slot, and a Cover Letter slot. A running
    // "attach to the first thing that looks plausible" rule attaches twice.
    // Decide in two passes: prefer a slot explicitly labelled resume/CV, and
    // only fall back to an unlabelled slot if no explicit one exists. A cover
    // letter slot is never filled with a resume.
    const fileInputs = await page.$$('input[type=file]');
    const described = [];
    for (const el of fileInputs) {
      const ctx = await el.evaluate((e) => {
        const own = ((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || '').trim();
        let n = e.parentElement, up = '';
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const t = (n.innerText || '').trim();
          if (t.length > 3 && t.length < 300) { up = t; break; }
        }
        return `${own} ${up}`.toLowerCase();
      });
      described.push({ el, ctx });
    }

    const isCover = (c) => /cover\s*letter/.test(c);
    const isResume = (c) => /resume|\bcv\b/.test(c) && !isCover(c);

    let target = described.find((d) => isResume(d.ctx)) || described.find((d) => !isCover(d.ctx));

    if (fileInputs.length) {
      if (!job.resume_path || !fs.existsSync(job.resume_path)) {
        unanswered.push('resume (none built — run generate.js first)');
        target = null;
      } else if (target) {
        await target.el.setInputFiles(job.resume_path);
        filled.push(`resume <- ${path.basename(job.resume_path)}`);
      }
      for (const d of described) {
        if (d !== target && isCover(d.ctx)) skipped.push('cover letter upload (not auto-attached)');
      }
    }

    if (fileInputs.length) {
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000); // parser repaints after the request lands
    }

    const controls = await page.$$('input, textarea, select');
    for (const el of controls) {
      const info = await el.evaluate((e) => ({
        tag: e.tagName.toLowerCase(),
        type: (e.type || '').toLowerCase(),
        name: e.name || '',
        required: !!e.required,
        label: ((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || '').trim(),
        // A radio's own label is just "Yes"/"No" — the question it belongs to
        // sits in an ancestor. Without this, "Are you authorized to work in
        // the United States?" is invisible to the matcher and gets silently
        // counted as a skipped demographic control.
        groupText: (() => {
          let n = e.parentElement;
          for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
            const t = (n.innerText || '').trim();
            if (t.length > 25 && t.length < 400) return t.slice(0, 200);
          }
          return '';
        })(),
      }));
      if (['hidden', 'submit', 'button', 'image'].includes(info.type)) continue;

      const tag = `${info.label || info.name || info.type}`.replace(/\s+/g, ' ').slice(0, 60);

      if (info.type === 'file') continue; // handled above

      // Problem 2 from the first run: work-authorization and sponsorship are
      // rendered as radios, so they were lumped into the silent "skipped"
      // count alongside the demographic survey. They are legal attestations
      // and must be surfaced, not buried — the agent still does not answer
      // them, but you are told they are waiting.
      if (['checkbox', 'radio'].includes(info.type)) {
        const hay = `${info.label} ${info.name} ${info.groupText}`;
        const isAttestation = SCREENING_MAP.some((m) => m.re.test(hay));
        const isDemographic = NEVER_FILL.test(hay);
        if (isAttestation && !isDemographic) {
          const q = (info.groupText.split('\n')[0] || tag).slice(0, 80);
          const line = `${q} (attestation — answer this yourself)`;
          if (!unanswered.includes(line)) unanswered.push(line);
        }
        else skipped.push(`${tag} (${info.type})`);
        continue;
      }

      const hit = valueFor(facts, info.label, `${info.name} ${info.groupText || ''}`);
      if (hit && hit.needsHuman) {
        unanswered.push(`${tag} (attestation, no answer in screening_answers.${hit.needsHuman})`);
        continue;
      }
      if (!hit) {
        if (info.required) unanswered.push(`${tag} (required, no pre-written answer)`);
        else skipped.push(tag);
        continue;
      }

      try {
        if (info.tag === 'select') {
          // Free-text answers rarely match a dropdown option verbatim. Silently
          // swallowing the failure previously reported the field as filled when
          // it was still empty.
          let ok = true;
          await el.selectOption({ label: String(hit.value) }).catch(() => { ok = false; });
          if (!ok) { unanswered.push(`${tag} (dropdown — pick the option yourself)`); continue; }
        } else {
          await el.fill(String(hit.value));
        }
        filled.push(`${tag} <- ${hit.source}`);
      } catch {
        unanswered.push(`${tag} (could not fill)`);
      }
    }

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
