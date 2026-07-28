'use strict';

/**
 * Shared form-filling logic for prefill.js (never submits) and submit.js
 * (submits only after approval).
 *
 * This lives in one place deliberately. If the two stages each had their own
 * copy, they would drift — and the failure mode of drift here is an
 * application submitted with different answers than the ones you reviewed.
 */

const fs = require('fs');
const path = require('path');

// Voluntary demographic data and anything else the agent must never choose.
const NEVER_FILL =
  /pronoun|gender|sex\b|race|ethnic|hispanic|latino|veteran|disab|lgbt|orientation|age\b|birth|salary expectation|desired (salary|compensation)/i;

// Ordered: first match wins, so "linkedin" beats a generic "url".
const FIELD_MAP = [
  { re: /(^|\W)(full[\s_-]*name|legal[\s_-]*name|your[\s_-]*name|^name\*?$)/i, get: (f) => f.contact.name },
  { re: /first[\s_-]*name/i, get: (f) => f.contact.name.split(' ')[0] },
  { re: /last[\s_-]*name|surname|family[\s_-]*name/i, get: (f) => f.contact.name.split(' ').slice(-1)[0] },
  { re: /e[-\s_]*mail/i, get: (f) => f.contact.email },
  { re: /phone|mobile|telephone/i, get: (f) => f.contact.phone },
  { re: /linkedin/i, get: (f) => (f.contact.links || {}).linkedin },
  { re: /github/i, get: (f) => (f.contact.links || {}).github },
  { re: /portfolio|personal (site|website)|website|your site/i, get: (f) => (f.contact.links || {}).website },
  // \b matters: without it this matches "reLOCATION" and fills a yes/no
  // relocation question with a city name.
  { re: /\b(location|city|based in|current residence)\b/i, get: (f) => f.contact.location },
];

// Legal attestations. Matched BEFORE contact fields, because their wording
// overlaps ("open to relocation" vs "location") and an attestation must never
// lose to a contact-shaped match.
const SCREENING_MAP = [
  { re: /legally authorized|authorized to work|work authorization|right to work/i, key: 'work_authorization_us' },
  // Employers rarely use the word "sponsorship". Match Group's Lever form asks
  // whether you "require our company to file a petition or application for
  // employment-based immigration status" — no sponsor, no visa, no H-1B, so the
  // obvious regex missed a legal attestation entirely and it silently fell
  // through to "no pre-written answer".
  { re: /sponsor|visa\b|h-?1-?b\b|immigration status|petition or application for employment/i,
    key: 'requires_sponsorship_now_or_future' },
  { re: /relocat/i, key: 'willing_to_relocate' },
  { re: /notice period|start date|available to start/i, key: 'notice_period' },
  { re: /years of experience|how many years|minimum of \d+ years/i, key: 'years_of_experience' },
];

function valueFor(facts, label, extra) {
  const hay = `${label} ${extra || ''}`.trim();
  if (!hay || NEVER_FILL.test(hay)) return null;

  for (const m of SCREENING_MAP) {
    if (m.re.test(hay)) {
      const v = (facts.screening_answers || {})[m.key];
      // Blank means the human has not answered it. Reported, never guessed.
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

/** Describe a control, including the question text a radio inherits from its group. */
async function describe(el) {
  return el.evaluate((e) => ({
    tag: e.tagName.toLowerCase(),
    type: (e.type || '').toLowerCase(),
    name: e.name || '',
    required: !!e.required,
    value: e.value || '',
    checked: !!e.checked,
    label: ((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || '').trim(),
    // A radio's own label is just "Yes"/"No"; its question lives above it.
    groupText: (() => {
      // Prefer the nearest ancestor that actually reads like a question.
      // A pure size window is fragile: too small a floor latches onto the
      // option text ("Yes"), too large a floor skips past the question into
      // the whole form.
      const seen = [];
      let n = e.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const t = (n.innerText || '').trim();
        if (t.length > 10 && t.length < 600) seen.push(t);
      }
      const asked = seen.find((t) => t.includes('?'));
      return (asked || seen.find((t) => t.length > 25) || '').slice(0, 250);
    })(),
  }));
}

/**
 * Attach the resume to the right slot.
 *
 * Ashby and Greenhouse render several file inputs — often an unlabelled one, a
 * Resume slot and a Cover Letter slot. Two passes: prefer an explicit resume
 * slot, fall back to an unlabelled one, and never put a resume in a cover
 * letter field.
 */
async function attachResume(page, resumePath, out) {
  const inputs = await page.$$('input[type=file]');
  if (!inputs.length) return;

  const described = [];
  for (const el of inputs) {
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
  const target = described.find((d) => isResume(d.ctx)) || described.find((d) => !isCover(d.ctx));

  if (!resumePath || !fs.existsSync(resumePath)) {
    out.unanswered.push('resume (none built — run generate.js first)');
    return;
  }
  if (target) {
    await target.el.setInputFiles(resumePath);
    out.filled.push(`resume <- ${path.basename(resumePath)}`);
  }
  for (const d of described) {
    if (d !== target && isCover(d.ctx)) out.skipped.push('cover letter upload (not auto-attached)');
  }

  // The board's own parser reads the PDF and repaints the form; anything typed
  // before that lands is silently overwritten.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

/** Fill every control we can answer truthfully. Returns filled/skipped/unanswered. */
async function fillForm(page, facts, resumePath) {
  const out = { filled: [], skipped: [], unanswered: [] };
  // Radio groups answered already. A group can hold options beyond Yes/No
  // ("I'm already in NYC"); without this the extra option reports the question
  // as unanswered even though it was just answered, and submit.js then refuses.
  const answeredGroups = new Set();

  await attachResume(page, resumePath, out);

  for (const el of await page.$$('input, textarea, select')) {
    const info = await describe(el);
    if (['hidden', 'submit', 'button', 'image', 'file'].includes(info.type)) continue;

    const tag = `${info.label || info.name || info.type}`.replace(/\s+/g, ' ').slice(0, 60);
    const hay = `${info.label} ${info.name} ${info.groupText}`;

    if (['checkbox', 'radio'].includes(info.type)) {
      const match = SCREENING_MAP.find((m) => m.re.test(hay));
      if (!match || NEVER_FILL.test(hay)) {
        out.skipped.push(`${tag} (${info.type})`);
        continue;
      }

      const q = (info.groupText.split('\n')[0] || tag).slice(0, 80);
      const groupKey = info.name || q;
      if (answeredGroups.has(groupKey)) { out.skipped.push(`${tag} (other option)`); continue; }
      const answer = (facts.screening_answers || {})[match.key];

      // Selecting a radio from an answer YOU pre-wrote is reuse, not inference
      // — which is what CLAUDE.md permits. But only when it is unambiguous:
      // the stored answer must begin with a clear yes/no, and this option's
      // own label must be exactly that word. Anything less (a sentence answer,
      // a "Prefer not to say" option, a multi-choice list) is left for you.
      const yn = /^\s*(yes|no)\b/i.exec(String(answer || ''));
      const optionIsYesNo = /^(yes|no)$/i.test(info.label.trim());

      if (yn && optionIsYesNo) {
        if (info.label.trim().toLowerCase() === yn[1].toLowerCase()) {
          try {
            await el.check();
            answeredGroups.add(groupKey);
            out.filled.push(`${q} = ${info.label.trim()} <- screening_answers.${match.key}`);
          } catch {
            out.unanswered.push(`${q} (could not select "${info.label.trim()}")`);
          }
        }
        continue; // the non-matching option of the pair needs no report
      }

      const line = answer
        ? `${q} (answer is "${String(answer).slice(0, 40)}" — pick the option yourself)`
        : `${q} (attestation, no answer in screening_answers.${match.key})`;
      if (!out.unanswered.includes(line)) out.unanswered.push(line);
      continue;
    }

    // groupText is the ancestor's text, which for a text input is often the
    // ENTIRE form. Including it here made every field match the first rule
    // whose keyword appeared anywhere in the form — name, email and phone all
    // received the candidate's name. Radios genuinely need it (their own label
    // is just "Yes"/"No"); text inputs must match on their own label and name.
    const extra = info.tag === 'select' && !info.label ? `${info.name} ${info.groupText}` : info.name;
    const hit = valueFor(facts, info.label, extra);
    if (hit && hit.needsHuman) {
      out.unanswered.push(`${tag} (attestation, no answer in screening_answers.${hit.needsHuman})`);
      continue;
    }
    if (!hit) {
      if (info.required) out.unanswered.push(`${tag} (required, no pre-written answer)`);
      else out.skipped.push(tag);
      continue;
    }

    try {
      if (info.tag === 'select') {
        let ok = true;
        await el.selectOption({ label: String(hit.value) }).catch(() => { ok = false; });
        if (!ok) {
          // "Yes - will require H-1B sponsorship" against options [Yes, No]:
          // select the yes/no the stored answer opens with. Still the human's
          // answer, just matched to the option the form offers.
          const yn = /^\s*(yes|no)\b/i.exec(String(hit.value));
          const opts = await el.evaluate((e) => [...e.options].map((o) => o.text.trim()));
          const target = yn && opts.find((o) => o.toLowerCase() === yn[1].toLowerCase());
          if (target) {
            await el.selectOption({ label: target }).then(() => { ok = true; }).catch(() => {});
          }
        }
        if (!ok) { out.unanswered.push(`${tag} (dropdown — pick the option yourself)`); continue; }
      } else {
        // Never trust fill(). Custom widgets (Lever's location autocomplete is
        // one) swallow a programmatic set and leave the field empty, and we
        // previously reported those as filled — a false success that only
        // surfaced later as "required, empty" in the submit audit.
        await el.fill(String(hit.value)).catch(() => {});
        let landed = await el.inputValue().catch(() => '');

        if (!landed.trim()) {
          // Simulate real typing, which most widgets do accept, then take a
          // suggestion if one appears.
          await el.click({ timeout: 5000 }).catch(() => {});
          await el.type(String(hit.value), { delay: 25 }).catch(() => {});
          await page.waitForTimeout(1200);
          const option = await page.$('.dropdown-location-option, [role=option], .location-option');
          if (option) await option.click({ timeout: 3000 }).catch(() => {});
          landed = await el.inputValue().catch(() => '');
        }

        if (!landed.trim()) {
          out.unanswered.push(`${tag} (field rejected the value — fill it yourself)`);
          continue;
        }
      }
      out.filled.push(`${tag} <- ${hit.source}`);
    } catch {
      out.unanswered.push(`${tag} (could not fill)`);
    }
  }
  return out;
}

/**
 * Pre-flight audit, run immediately before a submit click.
 *
 * Re-reads the live DOM rather than trusting what fillForm reported, because
 * the board's own scripts can clear or reject a value after it was set. Any
 * required control still empty means the application is incomplete and must
 * not be sent.
 */
async function auditRequired(page) {
  const blanks = [];
  const radioGroups = new Map();

  for (const el of await page.$$('input, textarea, select')) {
    const info = await describe(el);
    if (['hidden', 'submit', 'button', 'image'].includes(info.type)) continue;

    const tag = `${info.label || info.name || info.type}`.replace(/\s+/g, ' ').slice(0, 60);

    if (info.type === 'radio' || info.type === 'checkbox') {
      if (!info.required) continue;
      const key = info.name || tag;
      radioGroups.set(key, (radioGroups.get(key) || false) || info.checked);
      continue;
    }
    if (info.type === 'file') {
      if (info.required && !info.value) blanks.push(`${tag} (required file not attached)`);
      continue;
    }
    if (info.required && !String(info.value).trim()) {
      blanks.push(`${tag} (required, empty)`);
      continue;
    }
    // A field can be populated and still block submission — an email box
    // holding a name passes an emptiness check and fails the browser's own
    // validation. Ask the browser directly.
    const validity = await el.evaluate((e) => (e.checkValidity ? { ok: e.checkValidity(), msg: e.validationMessage } : { ok: true }));
    if (!validity.ok) blanks.push(`${tag} (invalid: ${validity.msg})`);
  }

  for (const [name, anyChecked] of radioGroups) {
    if (!anyChecked) blanks.push(`${name} (required choice, nothing selected)`);
  }
  return blanks;
}

/** Build the board-specific application URL. */
function applyUrlFor(job) {
  if (job.board === 'lever') return /\/apply\/?$/.test(job.url) ? job.url : `${job.url}/apply`;
  if (job.board === 'ashby') return /\/application\/?$/.test(job.url) ? job.url : `${job.url}/application`;
  // Some employers redirect their Greenhouse links to their own careers site,
  // which has no form; rebuild from the board token instead of trusting url.
  if (job.board === 'greenhouse' && job.board_token && job.external_id) {
    return `https://job-boards.greenhouse.io/${job.board_token}/jobs/${job.external_id}`;
  }
  return job.url;
}

module.exports = { fillForm, auditRequired, applyUrlFor, NEVER_FILL, SCREENING_MAP };
