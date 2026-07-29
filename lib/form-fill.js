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
  // Postal address, BEFORE the generic location rule below.
  //
  // Greenhouse labels its field "Location (City)", which matches both rules —
  // and the generic one returned contact.location, the resume header
  // "San Francisco Bay Area, CA". That is a metro area, not a city, so the
  // geocoded autocomplete matched nothing and the field silently stayed empty.
  // A real city resolves: the list offers "Fremont, CA, USA".
  { re: /\b(street|address\s*(line\s*)?1?|mailing address)\b/i,
    get: (f) => ((f.contact || {}).address || {}).street },
  { re: /\b(city|town)\b/i,
    get: (f) => {
      const a = (f.contact || {}).address || {};
      return a.city ? [a.city, a.state_code].filter(Boolean).join(', ') : null;
    } },
  { re: /\b(state|province|region)\b/i, get: (f) => ((f.contact || {}).address || {}).state },
  { re: /\b(zip|postal\s*code|post\s*code)\b/i, get: (f) => ((f.contact || {}).address || {}).postal_code },

  // \b matters: without it this matches "reLOCATION" and fills a yes/no
  // relocation question with a city name.
  { re: /\b(location|based in|current residence)\b/i, get: (f) => f.contact.location },

  // Employment and education history. These are FACTS out of master-facts.json,
  // not attestations, so deriving them invents nothing — the same rule that lets
  // generate.js put them on the resume. Stripe's form requires all four, and
  // without them every Greenhouse application stalls on questions the facts file
  // could already answer.
  //
  // Ordered before nothing in particular, but AFTER the contact block on
  // purpose: "What is your current or previous job title?" contains no contact
  // word, while "Location (City)" must still reach contact.location.
  { re: /current or previous employer|current employer|most recent employer|present employer/i,
    get: (f) => (f.roles || [])[0] && f.roles[0].company },
  { re: /current or previous job title|current title|most recent (job )?title|present job title/i,
    get: (f) => (f.roles || [])[0] && f.roles[0].title },
  { re: /most recent school|school you attended|university attended|institution/i,
    get: (f) => (f.education || [])[0] && f.education[0].institution },
  { re: /most recent degree|degree you (obtained|earned|received)|highest degree/i,
    get: (f) => (f.education || [])[0] && f.education[0].credential },
  // "Country" on its own, and "the country where you currently reside".
  { re: /\bcountry\b/i, get: (f) => (f.contact || {}).country },
];

// Legal attestations. Matched BEFORE contact fields, because their wording
// overlaps ("open to relocation" vs "location") and an attestation must never
// lose to a contact-shaped match.
// Countries whose mention makes a US-specific answer the wrong answer.
//
// Match Group's Lever form asks "What is your current work authorization status
// in South Korea?" — which matched /work authorization/ and proposed
// "Yes — authorized to work in the United States (F-1 OPT)". Nothing was
// submitted, because the option list happened not to match, but the mapping was
// wrong and the failure mode is a FALSE ATTESTATION about a country the
// candidate has no status in. The never-guess rule was satisfied and still would
// not have caught this: the answer was pre-written by the human, just for a
// different question.
const NON_US_COUNTRY =
  /\b(south korea|korea|japan|india|canada|mexico|brazil|argentina|chile|colombia|australia|new zealand|singapore|malaysia|indonesia|thailand|taiwan|china|hong kong|philippines|vietnam|united kingdom|u\.?k\.?|ireland|france|germany|spain|italy|portugal|netherlands|belgium|luxembourg|switzerland|sweden|norway|denmark|finland|poland|romania|czech|austria|greece|israel|turkey|uae|saudi|egypt|nigeria|kenya|south africa)\b/i;
const MENTIONS_US = /\b(united states|u\.?s\.?a?\b|america)/i;

const SCREENING_MAP = [
  // usOnly: the stored answer is explicitly about the United States, so a
  // question naming a different country must NOT receive it.
  { re: /legally authorized|authorized to work|work authorization|right to work/i,
    key: 'work_authorization_us', usOnly: true },
  // Employers rarely use the word "sponsorship". Match Group's Lever form asks
  // whether you "require our company to file a petition or application for
  // employment-based immigration status" — no sponsor, no visa, no H-1B, so the
  // obvious regex missed a legal attestation entirely and it silently fell
  // through to "no pre-written answer".
  // Also US-only: the stored answer names H-1B specifically.
  { re: /sponsor|visa\b|h-?1-?b\b|immigration status|petition or application for employment/i,
    key: 'requires_sponsorship_now_or_future', usOnly: true },
  { re: /relocat/i, key: 'willing_to_relocate' },
  { re: /notice period|start date|available to start/i, key: 'notice_period' },
  { re: /years of experience|how many years|minimum of \d+ years/i, key: 'years_of_experience' },

  // Added after reading Stripe's real Greenhouse form. Each of these is either a
  // statement to an employer about the candidate's history or a standing
  // preference, so none may be derived — "almost certainly No" is exactly the
  // reasoning the never-guess rule exists to stop. Blank until the human writes
  // one, and a blank pauses the application rather than being filled.
  { re: /ever been employed by|previously (been )?employed|former employee|worked (here|at .{0,40}) before/i,
    key: 'previously_employed_here' },
  { re: /plan to work remotely|work from a remote location|remote work preference/i,
    key: 'remote_work_preference' },
  { re: /opt.?in to receive|whatsapp|text messages|sms|marketing (emails|messages)/i,
    key: 'recruiting_messages_opt_in' },
  // Consent to interview recording and the personal-data processing that comes
  // with it. Stripe uses BrightHire; other employers use Metaview, Hume, Zoom
  // transcription. A consent is the human's to give, so it is matched here to be
  // NAMED in the tracking sheet rather than falling through as the anonymous
  // "required, no pre-written answer".
  { re: /brighthire|metaview|record and transcribe|recording of (this|the) interview|consent to .{0,40}record|interview.{0,20}recorded/i,
    key: 'interview_recording_consent' },
  // "Please select the country or countries you anticipate working in for the
  // role in which you are applying" — a 30-option checkbox list on Stripe's
  // form. A forward-looking statement to an employer about where you will work,
  // so it is the human's to make even though targets.locations implies it.
  { re: /countr(y|ies) you anticipate working|anticipate working in|where will you (be )?work/i,
    key: 'anticipated_work_countries' },
];

function valueFor(facts, label, extra) {
  const hay = `${label} ${extra || ''}`.trim();
  if (!hay || NEVER_FILL.test(hay)) return null;

  for (const m of SCREENING_MAP) {
    if (m.re.test(hay)) {
      // A US-specific answer must not be given to a question about elsewhere.
      // See NON_US_COUNTRY. Reported for the human rather than answered.
      if (m.usOnly && NON_US_COUNTRY.test(hay) && !MENTIONS_US.test(hay)) {
        return { needsHuman: m.key, wrongCountry: true };
      }
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
    // aria-labelledby matters as much as the other three. Greenhouse gives its
    // standard fields an aria-label ("First Name") but wires CUSTOM questions up
    // by id instead, so without resolving it every job-specific question came
    // back as a bare "text" — and a blocker the sheet reports as "text
    // (required, no pre-written answer)" tells the human nothing they can act
    // on, which is the entire point of recording it.
    label: (() => {
      const own = (e.labels && e.labels[0] && e.labels[0].innerText) || '';
      const aria = e.getAttribute('aria-label') || '';
      const by = (e.getAttribute('aria-labelledby') || '')
        .split(/\s+/).filter(Boolean)
        .map((id) => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; })
        .join(' ');
      if (own || aria || by) return (own || aria || by).replace(/\s+/g, ' ').trim();

      // react-select. Greenhouse renders its dropdowns as a bare <input> with no
      // id, name, aria-label or aria-labelledby, inside a "Select..." widget —
      // so all four lookups above come back empty and the question reported to
      // the human was the useless string "text". The question text lives on the
      // .select__container ancestor ("Country*", "Location (City)*"). Strip the
      // widget's own chrome so what is left is the question itself.
      const clean = (t) => String(t || '')
        .replace(/\bSelect\.\.\.\s*/g, ' ')
        .replace(/\bLocate me\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const shell = e.closest('.select__container, .select, .field-wrapper');
      if (shell) {
        const t = clean(shell.innerText);
        if (t) return t;
      }
      const ph = clean(e.placeholder);
      if (ph) return ph;

      // Last resort: walk up for ANY nearby text.
      //
      // A control that reaches here has no label, no aria-*, no recognised
      // widget shell and no placeholder, and the report said only "text
      // (required, no pre-written answer)" — which named nothing, so neither the
      // human nor I could tell what was being asked. Probing the page directly
      // never reproduced it, so the answer has to come from the running form
      // itself. Bounded tightly: a small ancestor's text is the question, a
      // large one's is the whole form.
      let n = e.parentElement;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        const t = clean(n.innerText);
        if (t.length > 2 && t.length < 200) return `${t} [unlabelled ${(e.type || 'field')}]`;
      }
      return '';
    })(),
    // react-select's hidden validation shim:
    //   <input required tabindex="-1" aria-hidden="true" class="...-requiredInput">
    // An invisible input that carries `required` so native HTML5 validation
    // fires, with its value mirroring whatever the visible widget holds. It is
    // not a question and cannot be typed into, but it IS the only element on a
    // react-select that reports `required` — so the filler must skip it while
    // the audit must keep it, or an unset dropdown would sail through.
    shim: e.getAttribute('aria-hidden') === 'true' || e.getAttribute('tabindex') === '-1',
    // Marks the control as a react-select so the filler drives it by keyboard
    // rather than trying to type into it. Clicking the input directly fails:
    // .select__value-container intercepts the pointer event.
    combo: !!e.closest('.select__container, .select-shell'),
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
    // Attach, then PROVE it stuck, and retry if it did not.
    //
    // Greenhouse uploads the file to S3 asynchronously and tracks it in JS state
    // rather than in the DOM, and the attach intermittently fails to register.
    // Two live submissions of the same job behaved differently: one was rejected
    // by Stripe with "Resume/CV is required", the other was caught by guard 8
    // with the filename simply absent from the page. setInputFiles resolving is
    // NOT evidence the board accepted the file — the rendered filename is.
    const base = path.basename(resumePath);
    let attached = false;
    for (let attempt = 1; attempt <= 3 && !attached; attempt++) {
      await target.el.setInputFiles(resumePath).catch(() => {});
      for (let waited = 0; waited < 12000; waited += 750) {
        await page.waitForTimeout(750);
        attached = await page
          .evaluate((n) => (document.body.innerText || '').includes(n), base)
          .catch(() => false);
        if (attached) break;
      }
      if (!attached && attempt < 3) {
        out.skipped.push(`resume attach retry ${attempt} (board did not register the upload)`);
      }
    }
    if (attached) out.filled.push(`resume <- ${base}`);
    else out.unanswered.push('resume (board would not accept the upload after 3 attempts)');
  }
  for (const d of described) {
    if (d !== target && isCover(d.ctx)) out.skipped.push('cover letter upload (not auto-attached)');
  }

  // The board's own parser reads the PDF and repaints the form; anything typed
  // before that lands is silently overwritten.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

/**
 * Score how well a rendered dropdown option matches the value we want.
 *
 * Needed because option vocabularies are not the answer vocabularies. Stripe's
 * "country where you currently reside" offers "US", not "United States", so an
 * exact-string match answers nothing and typing the full value filters the list
 * down to "No options".
 *
 * Returns 0 for "not a match". The caller REFUSES on a low score rather than
 * picking the closest thing: a wrong answer on an employer's form is worse than
 * an unanswered one, which merely pauses the application.
 */
const COMBO_SYNONYMS = [
  ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.'],
  ['united kingdom', 'uk', 'great britain', 'gb'],
  ['yes', 'y', 'true'],
  ['no', 'n', 'false'],
];

/**
 * Alternative strings to look for, beyond the literal answer.
 *
 * The facts file stores what is true ("M.S. Computer Science", "San Francisco
 * Bay Area, CA"); a form offers what it offers ("Master's Degree", "San
 * Francisco, CA, USA"). These derive the form's vocabulary from ours without
 * changing the answer: a degree LEVEL is entailed by the degree, and the leading
 * words of a location are the location. Nothing here invents a new claim.
 */
function comboCandidates(want) {
  const w = String(want || '');
  const out = [w];
  if (/\b(m\.?\s?s\.?|m\.?sc|m\.?tech|master)/i.test(w)) out.push("Master's Degree");
  else if (/\b(b\.?\s?s\.?|b\.?tech|b\.?a\.?|bachelor)/i.test(w)) out.push("Bachelor's Degree");
  else if (/\bph\.?\s?d|doctor of philosophy/i.test(w)) out.push('Doctor of Philosophy (Ph.D.)');
  else if (/\bm\.?b\.?a\.?\b/i.test(w)) out.push('Master of Business Administration (M.B.A.)');
  // Drop a trailing qualifier: "Fremont, CA" -> "Fremont". A geocoded list
  // returns "Fremont, CA, USA", which the bare city name prefix-matches while
  // the comma form may over-filter.
  const head = w.replace(/,.*$/, '').trim();
  if (head && head.toLowerCase() !== w.toLowerCase()) out.push(head);
  // And the leading two words, for a metro-area style value.
  const words = head.split(/\s+/);
  if (words.length >= 2) out.push(words.slice(0, 2).join(' '));
  return [...new Set(out.filter(Boolean))];
}

function comboScore(optionText, want) {
  const o = String(optionText).toLowerCase().replace(/\s+/g, ' ').trim();
  const w = String(want).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!o || !w) return 0;
  if (o === w) return 100;

  for (const group of COMBO_SYNONYMS) {
    if (group.includes(o) && group.includes(w)) return 95;
  }

  // A bare number against a bracketed option. Stripe asks "How many years of
  // experience..." and offers "1 - 4 years of experience as a software
  // engineer"; the stored answer is "2", which matches no option as a string.
  // Deciding that 2 lies inside 1-4 is arithmetic on the human's own answer, not
  // a judgement about it, so it is safe to resolve here rather than ask.
  const wantNum = /^\d+(\.\d+)?$/.test(w) ? parseFloat(w) : null;
  if (wantNum !== null) {
    const plus = o.match(/(\d+)\s*\+/);
    if (plus && wantNum >= parseFloat(plus[1])) return 85;
    const range = o.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/);
    if (range && wantNum >= parseFloat(range[1]) && wantNum <= parseFloat(range[2])) return 85;
  }
  // "United States" wanted, "United States of America" offered.
  if (o.startsWith(w) || w.startsWith(o)) return 80;
  // Guarded containment: a 2-character needle matches far too much ("us" is
  // inside "Australia"), so require the option to be word-bounded.
  if (w.length >= 4 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(o)) return 60;
  return 0;
}

const COMBO_MIN_SCORE = 60;

/**
 * Drive one react-select control by keyboard and pick a matching option.
 *
 * Keyboard, not mouse: .select__value-container swallows clicks aimed at the
 * inner input, so el.click() times out. ArrowDown opens the menu without
 * filtering, which is what lets the real option vocabulary be read before
 * committing to anything.
 *
 * Returns the chosen option text, or null if nothing scored high enough.
 */
async function fillCombobox(page, el, want) {
  const readOptions = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[class*=option]')]
        .map((n) => (n.innerText || '').trim())
        .filter((t) => t && !/^no options$/i.test(t))
    );

  const candidates = comboCandidates(want);
  const rank = (opts) =>
    opts
      .flatMap((t) => candidates.map((c) => ({ t, s: comboScore(t, c) })))
      .sort((a, b) => b.s - a.s)[0];

  await el.focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(500);

  let best = rank(await readOptions());

  // Two reasons the opened menu may not hold the answer: long lists render
  // lazily, and a geocoded city list returns NOTHING until something is typed.
  // Probe with each candidate's leading words — the full string over-filters to
  // nothing when the option is an abbreviation ("US") or differently worded.
  for (const cand of candidates) {
    if (best && best.s >= COMBO_MIN_SCORE) break;
    const probe = cand.trim().slice(0, 12);
    if (!probe) continue;
    await el.focus();
    await page.keyboard.type(probe, { delay: 25 });
    // Poll rather than wait a fixed slice. "Location (City)" is a GEOCODED
    // lookup — it goes to the network — so a flat 700ms passed or failed
    // depending on the wifi, which is what made this field look intermittently
    // broken across otherwise identical runs.
    let got = null;
    for (let waited = 0; waited < 4000; waited += 400) {
      await page.waitForTimeout(400);
      got = rank(await readOptions());
      if (got && got.s >= COMBO_MIN_SCORE) break;
    }
    if (got && (!best || got.s > best.s)) best = got;
    if (best && best.s >= COMBO_MIN_SCORE) break;
    for (let i = 0; i < probe.length; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
  }

  if (!best || best.s < COMBO_MIN_SCORE) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }

  const picked = await page.evaluate((text) => {
    const node = [...document.querySelectorAll('[class*=option]')]
      .find((n) => (n.innerText || '').trim() === text);
    if (!node) return false;
    node.click();
    return true;
  }, best.t);

  if (!picked) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }
  await page.waitForTimeout(300);
  return best.t;
}

/** Fill every control we can answer truthfully. Returns filled/skipped/unanswered. */
async function fillForm(page, facts, resumePath) {
  const out = { filled: [], skipped: [], unanswered: [] };
  // Radio groups answered already. A group can hold options beyond Yes/No
  // ("I'm already in NYC"); without this the extra option reports the question
  // as unanswered even though it was just answered, and submit.js then refuses.
  const answeredGroups = new Set();
  const groupOfLine = new Map();

  await attachResume(page, resumePath, out);

  for (const el of await page.$$('input, textarea, select')) {
    const info = await describe(el);
    if (['hidden', 'submit', 'button', 'image', 'file'].includes(info.type)) continue;
    // Not a question — see `shim` in describe(). This is what reported as the
    // anonymous "text (required, no pre-written answer)" and named nothing the
    // human could act on. The visible widget beside it is what gets driven.
    if (info.shim) continue;

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

      // Not a yes/no pair: a named-option list, like Stripe's 30-country "where
      // do you anticipate working".
      //
      // Scored with the same matcher the dropdowns use, not string equality,
      // because the form's vocabulary is not the human's: this list spells the
      // United States "US", so an exact match ticked nothing and reported "pick
      // the option yourself" for an answer that was already given. comboScore
      // knows US/USA/United States are one country and returns 0 for anything
      // it does not recognise, so a wrong country still cannot be ticked.
      if (answer && info.label.trim() &&
          comboScore(info.label.trim(), String(answer)) >= COMBO_MIN_SCORE) {
        try {
          await el.check();
          answeredGroups.add(groupKey);
          out.filled.push(`${q} = ${info.label.trim()} <- screening_answers.${match.key}`);
        } catch {
          out.unanswered.push(`${q} (could not select "${info.label.trim()}")`);
        }
        continue;
      }
      // A named option that is NOT the stored answer needs no report; the group
      // is reported once, by whichever option runs last, if nothing was ticked.
      if (answer && info.label.trim() && answeredGroups.has(groupKey)) continue;

      const line = answer
        ? `${q} (answer is "${String(answer).slice(0, 40)}" — pick the option yourself)`
        : `${q} (attestation, no answer in screening_answers.${match.key})`;
        // Options are visited in DOM order, so a group is reported BEFORE the
        // option that answers it is reached: "Australia" scores 0 and files the
        // complaint, then "US" ticks and the complaint is stale. Remember the
        // group so it can be withdrawn at the end.
        groupOfLine.set(line, groupKey);
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
      out.unanswered.push(hit.wrongCountry
        ? `${tag} (asks about a country your ${hit.needsHuman} answer does not cover — answer it yourself)`
        : `${tag} (attestation, no answer in screening_answers.${hit.needsHuman})`);
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
      } else if (info.combo) {
        // react-select: fill() on the inner input is discarded on the next
        // render, so it has to be driven the way a person would.
        const chosen = await fillCombobox(page, el, String(hit.value));
        if (!chosen) {
          out.unanswered.push(`${tag} (dropdown — no option matched "${String(hit.value).slice(0, 30)}", pick it yourself)`);
          continue;
        }
        out.filled.push(`${tag} = ${chosen} <- ${hit.source}`);
        continue;
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
  // react-select renders more than one input per widget, so an unhandled
  // dropdown reported its question twice and the tracking sheet showed the
  // human the same task twice.
    out.unanswered = [...new Set(out.unanswered)]
      .filter((l) => !(groupOfLine.has(l) && answeredGroups.has(groupOfLine.get(l))));
  out.filled = [...new Set(out.filled)];
  out.skipped = [...new Set(out.skipped)];
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
  // Greenhouse: the EMBED endpoint, which is the only one that reliably serves
  // an actual form.
  //
  // This used to build job-boards.greenhouse.io/<token>/jobs/<id>, on the theory
  // that going straight to the board dodged employers who redirect their
  // Greenhouse links to their own careers site. Greenhouse redirects it anyway:
  // for Stripe it 302s to stripe.com/jobs/search?gh_jid=<id>, a description page
  // with an "Apply for this role" button and no inputs at all. fillForm filled
  // nothing and the audit passed on a page it could never have applied from —
  // 533 of the 734 watchlist jobs.
  //
  // /embed/job_app is what the employer's own site iframes, so it cannot
  // redirect away: it returns "Job Application for <title> at <company>" with
  // first_name, last_name, email and a file input. Verified against Stripe.
  if (job.board === 'greenhouse' && job.board_token && job.external_id) {
    return `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(job.board_token)}` +
           `&token=${encodeURIComponent(job.external_id)}`;
  }
  return job.url;
}

module.exports = { fillForm, auditRequired, applyUrlFor, NEVER_FILL, SCREENING_MAP };
