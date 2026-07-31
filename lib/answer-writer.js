'use strict';

/**
 * answer-writer.js — model-written application prose, fenced in.
 *
 * Two kinds of thing sit behind a "screening question" text box, and they are
 * not the same kind of thing at all:
 *
 *   1. ATTESTATIONS. "Are you authorized to work in the US?", "Have you been
 *      convicted of a felony?", "What is your expected salary?", "Are you a
 *      protected veteran?". These are statements of FACT about the candidate,
 *      made to an employer, that the employer may act on and later verify. A
 *      wrong one is not a bad answer — it is a false statement on a job
 *      application, and it can cost an offer or a job after the fact. A model
 *      cannot know these. Nothing here will write one. They come verbatim from
 *      master-facts.json screening_answers or the application pauses.
 *
 *   2. NARRATIVE. "Why do you want to work here?", "Describe a project you are
 *      proud of", "What interests you about this role?". These are marketing
 *      prose about work the candidate actually did. Writing them from verified
 *      facts is the same act as writing the resume, and the resume is already
 *      generated. There is nothing to attest to and nothing to get legally
 *      wrong — only something to get badly written.
 *
 * This module writes (2) and refuses (1). The split is deterministic, matched
 * before the model is ever called, and defaults to REFUSING when unsure.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANSWER_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 4096;

const anthropic = new Anthropic({ maxRetries: 2, timeout: 120000 });

/**
 * Questions a model may NEVER answer, however obvious the answer looks.
 *
 * Deliberately broad and deliberately fail-CLOSED: a false positive here costs
 * one paused application, which the human finishes by hand. A false negative
 * is a fabricated legal attestation sent under the candidate's name.
 */
const ATTESTATION_RE = new RegExp(
  [
    // Immigration and right to work
    'work authorization', 'authorized to work', 'legally authorized', 'right to work',
    'sponsor', 'visa\\b', 'h-?1-?b', 'immigration', 'citizen', 'green card',
    'permanent resident', 'work permit', 'employment eligibility', 'i-?9\\b',
    // Criminal / background
    'felony', 'misdemeanor', 'convict', 'criminal', 'background check',
    'background screen', 'arrest', 'pending charges',
    // Protected characteristics — self-identification, never inferred
    'veteran', 'disabilit', 'race', 'ethnicit', 'gender', 'sex\\b',
    'sexual orientation', 'transgender', 'pronoun', 'date of birth',
    'age\\b', 'over 18', 'at least 18', 'eeo', 'equal employment',
    'self-?identif', 'hispanic', 'latino',
    // Clearance and export control
    'security clearance', 'clearance', 'export control', 'itar', 'polygraph',
    // Contractual encumbrances
    'non-?compete', 'non-?solicit', 'restrictive covenant', 'confidentiality agreement',
    'nda\\b',
    // Money and dates — commitments, not opinions
    'salary', 'compensation', 'pay expectation', 'expected pay', 'current pay',
    'hourly rate', 'desired rate', 'notice period', 'start date',
    'available to start', 'earliest.{0,20}start', 'relocat',
    // History the employer will verify
    'previously employed', 'former employee', 'ever been employed',
    'terminated', 'been fired', 'disciplinary', 'reference',
    'gpa\\b', 'grade point', 'transcript', 'graduation date', 'degree verif',
    'drug test', 'drug screen',
    // Signatures and consents
    'certify', 'attest', 'i agree', 'acknowledge', 'consent', 'authorize .{0,30}to',
    'electronic signature', 'sign(ature)? below',
  ].join('|'),
  'i'
);

/**
 * Classify a question. Only 'narrative' is ever sent to the model.
 *
 * `tag` is the DOM tag: narrative answers are written for free-text areas only.
 * A <select> or radio group offers a fixed set of options, and picking one the
 * matcher could not match is guessing at a structured claim, not writing prose.
 */
function classify(label, tag) {
  const q = String(label || '').trim();
  if (!q) return 'refuse';
  if (ATTESTATION_RE.test(q)) return 'attestation';
  if (String(tag || '').toLowerCase() !== 'textarea') return 'refuse';
  return 'narrative';
}

// Words that may start with a capital without naming anything.
const COMMON = new Set(
  ('a an the i my me we our us you your it its this that these those and or but so ' +
   'if when while as at by for from in into of on to with within without over under ' +
   'he she they them their his her there here what which who whom whose how why ' +
   'january february march april may june july august september october november december ' +
   'monday tuesday wednesday thursday friday saturday sunday ' +
   'yes no not never always also then than after before during since until ' +
   'building built build working worked work shipping shipped ship led leading ' +
   'most more best better much many both each every all any some ' +
   'dear sincerely regards hi hello thanks thank team hiring manager role position ' +
   'company engineer engineering software developer product user users customer customers'
  ).split(/\s+/)
);

/**
 * Every capitalised token in `text` that does not appear anywhere in `allowed`.
 *
 * This is the anti-fabrication check. The model is given the facts file and the
 * job description and nothing else, so any employer, product, technology or
 * metric it names that appears in NEITHER is something it made up. Catching
 * invented proper nouns catches the failure mode that matters: a cover letter
 * claiming experience at a company the candidate never worked for.
 */
function groundingViolations(text, allowed) {
  const hay = String(allowed).toLowerCase();
  const bad = new Set();
  for (const sentence of String(text).split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9+#]+$/, '');
      if (w.length < 2) return;
      const hasCap = /[A-Z]/.test(w);
      if (!hasCap) return;
      // A sentence-initial ordinary word is not evidence of a proper noun.
      if (i === 0 && /^[A-Z][a-z]+$/.test(w)) return;
      if (COMMON.has(w.toLowerCase())) return;
      if (hay.includes(w.toLowerCase())) return;
      bad.add(w);
    });
  }
  return [...bad];
}

/**
 * Employer claims specifically — "at Google I led the migration".
 *
 * groundingViolations() alone is not enough for these, and the gap is the
 * dangerous one. It tests whether a name appears ANYWHERE in the facts file, so
 * a company that appears in a skills list ("Google Cloud", "Stripe API") licenses
 * a sentence claiming employment there. Using a technology and working somewhere
 * are different claims, and only one of them is a lie a recruiter can check in
 * thirty seconds.
 *
 * So employment-shaped phrases are matched against the ACTUAL employer list:
 * roles, schools, projects, and the company being applied to.
 */
function employerViolations(text, facts, job) {
  const allowedNames = new Set();
  const add = (s) => {
    const v = String(s || '').trim().toLowerCase();
    if (v) allowedNames.add(v);
  };
  for (const r of facts.roles || []) add(r.company);
  for (const e of facts.education || []) { add(e.school); add(e.institution); }
  for (const p of facts.projects || []) { add(p.name); add(p.id); }
  add(job.company);

  const bad = new Set();
  // The preposition is spelled in both cases explicitly rather than using the
  // /i flag: /i would also case-fold the [A-Z] in the NAME group, which then
  // matches lowercase words and swallows the rest of the sentence as a company.
  //
  // "with" and "for" are deliberately absent. They precede technologies far more
  // often than employers ("worked with Kotlin", "responsible for the API"), and
  // every one of those is a false rejection of a perfectly honest answer.
  const re = /(?:^|\s)(?:[Aa]t|[Jj]oined|[Ii]nterned at|[Ee]mployed by|[Ww]orked at|[Ww]orking at)\s+((?:[A-Z][\w&.'-]*)(?:\s+(?:[A-Z][\w&.'-]*|of|and|the))*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim().replace(/\s+(I|we|as|where|from|in|on|to)$/i, '').trim();
    if (!name || name.length < 2) continue;
    const lc = name.toLowerCase();
    if (COMMON.has(lc)) continue;
    // Allow if it matches a real employer/school/project, in either direction
    // ("Metis" for "Metis AI", "Metis AI Inc" for "Metis AI").
    let ok = false;
    for (const a of allowedNames) {
      if (a === lc || a.includes(lc) || lc.includes(a)) { ok = true; break; }
    }
    if (!ok) bad.add(name);
  }
  return [...bad];
}

/** The only context the model is allowed to draw on. */
function groundingContext(job, facts) {
  const roles = (facts.roles || []).map(
    (r) => `- ${r.title} at ${r.company} (${r.start || ''}–${r.end || 'present'})`
  );
  const factLines = (facts.facts || []).map((f) => `- [${f.id}] ${f.text}`);
  const projects = (facts.projects || []).map(
    (p) => `- [${p.id}] ${p.name}: ${p.text || p.description || ''}`
  );
  const skills = Object.entries(facts.skills || {})
    .map(([k, v]) => `- ${k}: ${(Array.isArray(v) ? v : [v]).join(', ')}`);

  return [
    '## The candidate (this is the ONLY source of truth about them)',
    `Name: ${facts.contact?.name || ''}`,
    '',
    '### Roles', ...roles,
    '', '### Verified accomplishments', ...factLines,
    '', '### Projects', ...projects,
    '', '### Skills', ...skills,
    '',
    '## The job',
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location || 'not stated'}`,
    '',
    String(job.description || '').slice(0, 12000),
  ].join('\n');
}

const SYSTEM = `You write job-application prose for one specific candidate.

ABSOLUTE RULE: every concrete claim you make must be traceable to the candidate
material you are given. You may select, summarise, reorder and connect those
facts to the job description. You may NOT invent:
  - employers, job titles, dates or durations
  - projects, products, or features
  - technologies the candidate has not used
  - metrics, numbers, percentages, team sizes or scale figures
  - degrees, certifications, awards or publications

If the material does not support a good answer to a question, say so in the
"cannot_answer" field instead of writing a weak or padded one. An honest gap is
recoverable; a fabricated credential is not.

Voice: first person, direct, concrete, specific. No superlatives about
yourself, no "I am passionate about", no restating the job description back.
Lead with what was actually built. Short sentences. British or American
spelling consistent with the candidate material.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          cannot_answer: { type: 'string' },
          fact_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

/**
 * Write answers to narrative questions. Attestations must be filtered out by
 * the caller via classify(); anything that slips through is refused here too.
 *
 * Returns a Map question -> { answer, factIds } for answers that passed the
 * grounding check, plus a list of refusals for the human.
 */
async function writeAnswers({ job, facts, questions }) {
  const out = { answers: new Map(), refused: [], usage: { input: 0, output: 0 } };
  const narrative = [];
  for (const q of questions) {
    const kind = classify(q.label, q.tag);
    if (kind === 'narrative') narrative.push(q);
    else out.refused.push({ question: q.label, reason: kind === 'attestation'
      ? 'legal or self-identification attestation — must be answered by the human'
      : 'not a free-text question — no pre-written answer matched the options' });
  }
  if (!narrative.length) return out;

  const context = groundingContext(job, facts);
  const asks = narrative
    .map((q, i) => `${i + 1}. ${q.label}${q.maxLength ? `  (max ${q.maxLength} characters)` : ''}`)
    .join('\n');

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
    messages: [{
      role: 'user',
      content: `${context}\n\n## Questions on the application form\n${asks}\n\n` +
        `Answer each one. Return the question text verbatim in "question" so it can be matched back. ` +
        `Keep each answer under 150 words unless a character limit says otherwise. ` +
        `List the fact ids you used in "fact_ids". If the candidate material cannot support an ` +
        `honest answer, fill "cannot_answer" instead of "answer".`,
    }],
  });

  out.usage.input = res.usage?.input_tokens || 0;
  out.usage.output = res.usage?.output_tokens || 0;

  const parsed = JSON.parse(
    res.content.find((c) => c.type === 'text')?.text || '{"answers":[]}'
  );
  const allowed = `${JSON.stringify(facts)} ${job.title} ${job.company} ${job.description || ''}`;

  for (const a of parsed.answers || []) {
    const match = narrative.find(
      (q) => q.label === a.question || q.label.includes(a.question) || a.question.includes(q.label)
    );
    if (!match) continue;
    if (!a.answer || a.cannot_answer) {
      out.refused.push({ question: match.label, reason: a.cannot_answer || 'model declined to answer' });
      continue;
    }
    const bad = groundingViolations(a.answer, allowed);
    const badEmployer = employerViolations(a.answer, facts, job);
    if (bad.length || badEmployer.length) {
      out.refused.push({
        question: match.label,
        reason: badEmployer.length
          ? `answer claimed association with a non-employer: ${badEmployer.join(', ')}`
          : `answer named something absent from the facts file and the JD: ${bad.join(', ')}`,
      });
      continue;
    }
    out.answers.set(match.label, { answer: a.answer.trim(), factIds: a.fact_ids || [] });
  }
  return out;
}

const COVER_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string' },
    fact_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['body', 'fact_ids'],
  additionalProperties: false,
};

/**
 * A cover letter for one job, grounded the same way. Returns null if the
 * grounding check fails — a letter that names an invented employer is worse
 * than no letter, and the field is almost always optional.
 */
async function writeCoverLetter({ job, facts }) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: COVER_SCHEMA } },
    messages: [{
      role: 'user',
      content: `${groundingContext(job, facts)}\n\n## Task\n` +
        `Write a cover letter body for this application: 3 short paragraphs, 200-280 words total.\n` +
        `- Open with the single most relevant thing the candidate has actually built, named concretely.\n` +
        `- Middle paragraph: connect two or three specific requirements in the posting to specific work.\n` +
        `- Close briefly on why this company and role in particular.\n` +
        `No greeting line and no sign-off — those are added by the renderer. ` +
        `Do not restate the job title back at them. Do not use the word "passionate".`,
    }],
  });

  const parsed = JSON.parse(res.content.find((c) => c.type === 'text')?.text || '{}');
  if (!parsed.body) return null;
  const allowed = `${JSON.stringify(facts)} ${job.title} ${job.company} ${job.description || ''}`;
  const bad = groundingViolations(parsed.body, allowed);
  const badEmployer = employerViolations(parsed.body, facts, job);
  if (bad.length || badEmployer.length) {
    return {
      rejected: badEmployer.length
        ? `cover letter claimed association with a non-employer: ${badEmployer.join(', ')}`
        : `cover letter named something absent from the facts file and the JD: ${bad.join(', ')}`,
    };
  }
  return {
    body: parsed.body.trim(),
    factIds: parsed.fact_ids || [],
    usage: { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 },
  };
}

module.exports = {
  ATTESTATION_RE,
  classify,
  groundingViolations,
  employerViolations,
  groundingContext,
  writeAnswers,
  writeCoverLetter,
  MODEL,
};
