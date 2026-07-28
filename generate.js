#!/usr/bin/env node
'use strict';

/**
 * Stage 3: build a tailored resume PDF for one job.
 *
 * NO MODEL IS INVOLVED. CLAUDE.md requires every bullet to map to an id in
 * master-facts.json, which makes tailoring a selection problem rather than a
 * writing problem — and selection is deterministic. Facts are ranked by how
 * well their skills overlap the job description, the strongest are kept, and
 * their text is emitted verbatim. Nothing is rewritten, so nothing can be
 * invented.
 *
 * Three hard gates run after compilation; any failure means no PDF is
 * accepted:
 *   1. fact coverage — every selected fact's text survives into the PDF
 *   2. ATS parse    — contact details and section headers survive pdftotext
 *   3. page count   — the resume is a single page
 *
 * Usage:  node generate.js --job-id N [--out DIR] [--keep-tex]
 *         node generate.js --job-id N --dry-run     (selection only, no LaTeX)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Pool } = require('pg');

const FACTS_PATH = process.env.MASTER_FACTS || 'master-facts.json';
const TEMPLATE = path.join(__dirname, 'templates', 'resume.tex');
const OUT_DIR = process.env.RESUME_OUT || path.join(__dirname, 'build');

const MAX_BULLETS_PER_ROLE = 4;
const MAX_ROLES = 4;
// Starting caps, not ceilings. The 10pt Charter template over a 7.5in text block
// holds far more than the previous 11pt/6.5in one, so the fill loop grows past
// these routinely; the ceilings live in the growth ladder in main().
const MAX_PROJECTS = 3;
let MAX_TOTAL_BULLETS = 16;
const MIN_TOTAL_BULLETS = 6; // below this the resume stops saying anything useful

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// LaTeX escaping. A stray & or % in a company name silently breaks the build,
// and a backslash can inject commands — this runs on every value that reaches
// the template.
// ---------------------------------------------------------------------------
const TEX_ESCAPES = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

function tex(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\\&%$#_{}~^]/g, (c) => TEX_ESCAPES[c])
    // Smart punctuation the JD or facts may contain; pdflatex with T1 handles
    // these, but normalising avoids encoding surprises in extraction.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '--')
    .replace(/…/g, '...');
}

/**
 * Bold the quantified outcome so a skimming reader's eye lands on it.
 * Applied AFTER tex(): the escaper has already turned % into \\%, so this
 * matches the escaped form and must not re-escape anything.
 */
function boldMetrics(escaped) {
  // Requires a unit: percent, currency, K/M, an x multiplier, or a trailing +.
  // An earlier version bolded every digit, so "6-member team" and "3 charging
  // providers" came out emphasised alongside the real metrics — which drowns
  // the numbers that matter.
  return escaped
    .replace(/(\\\$\d[\d,.]*\s*[KM]?\b)/g, '\\textbf{$1}')
    .replace(/(\d[\d,.]*\s*\\%)/g, '\\textbf{$1}')
    .replace(/(\b\d[\d,.]*\+)/g, '\\textbf{$1}')
    .replace(/(\b\d[\d,.]*x\b)/gi, '\\textbf{$1}');
}

/**
 * Present a skill the way it is written in the industry. The facts file stores
 * skills lowercased for matching; rendering them raw produced "python, fastapi,
 * neo4j" in the project stacks, which reads as sloppy on a resume.
 */
const SKILL_CASE = {
  'react native': 'React Native', 'node.js': 'Node.js', 'next.js': 'Next.js',
  'fastapi': 'FastAPI', 'postgresql': 'PostgreSQL', 'postgis': 'PostGIS',
  'javascript': 'JavaScript', 'typescript': 'TypeScript', 'graphql': 'GraphQL',
  'neo4j': 'Neo4j', 'chromadb': 'ChromaDB', 'mongodb': 'MongoDB', 'sqlite': 'SQLite',
  'aws': 'AWS', 'gcp': 'GCP', 'ml': 'ML', 'llm': 'LLM', 'ai agents': 'AI agents',
  'vertex ai': 'Vertex AI', 'gemini live api': 'Gemini Live API', 'google adk': 'Google ADK',
  'claude sonnet': 'Claude Sonnet', 'langchain': 'LangChain', 'executorch': 'ExecuTorch',
  'whisper.cpp': 'Whisper.cpp', 'jetpack compose': 'Jetpack Compose', 'bloc': 'BLoC',
  'websockets': 'WebSockets', 'rest': 'REST', 'mcp': 'MCP', 'dqn': 'DQN', 'ns-3': 'ns-3',
  'c#': 'C#', 'c++': 'C++', 'sql': 'SQL', 'vr': 'VR', 'ux': 'UX', 'ui': 'UI',
  'cloud run': 'Cloud Run', 'firestore': 'Firestore', 'auth0': 'Auth0', 'azure': 'Azure',
  'tensorflow': 'TensorFlow', 'keras': 'Keras', 'tflite': 'TFLite', 'unity': 'Unity',
};
function skillCase(s) {
  const str = String(s).trim();
  // Already spelled by a human in master-facts.json's `skills` block ("OpenAI
  // API", "REST APIs", "GraphQL"). Lowercasing and title-casing those gave
  // "Openai Api" in the summary. Only the per-fact skill lists, stored
  // lowercase for matching, need repairing.
  if (/[A-Z]/.test(str)) return str;
  const k = str.toLowerCase();
  if (SKILL_CASE[k]) return SKILL_CASE[k];
  return k.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Relevance scoring — deterministic, explainable, no model.
// ---------------------------------------------------------------------------
const STOP = new Set(
  ('a an and are as at be by for from has have in is it its of on or that the to with we you your our will'
  ).split(' ')
);

function tokenise(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  // Plural-tolerant. A posting titled "Backend / API Engineer" must match the
  // skill "REST APIs"; matching the literal strings, it did not, and the whole
  // Backend group scored zero on a backend job. Both forms go into the haystack
  // so either side may carry the plural.
  //
  // The bounds are asymmetric on purpose. Adding an "s" needs 3+ characters, so
  // "api" reaches "apis" — a 4-character floor here skips the exact case this
  // exists for. Stripping one needs 4+, so "aws" is not truncated to "aw".
  const out = new Set();
  for (const w of words) {
    out.add(w);
    if (w.endsWith('s')) {
      if (w.length >= 4) out.add(w.slice(0, -1));
    } else if (w.length >= 3) {
      out.add(`${w}s`);
    }
  }
  return out;
}

/**
 * The posting split into what it is TITLED and everything it says.
 *
 * A term in the title states what the job is; the same term buried in the
 * company blurb does not. Scoring one flat bag of words weighted them equally,
 * which is how a Stripe billing role ranked Mobile above Backend.
 */
function jdSignals(job) {
  return {
    title: tokenise(job.title),
    all: tokenise(`${job.title || ''} ${job.description || ''}`),
  };
}

/** Words of a skill, as matched against the posting. */
function skillWords(s) {
  return String(s).toLowerCase().split(/[\s/(),]+/).filter((w) => w.length > 1);
}

/** Singular form, so "api" and "apis" count as one word when measuring spread. */
function stem(w) {
  return w.endsWith('s') && w.length >= 4 ? w.slice(0, -1) : w;
}

/**
 * How many skill groups each word appears in — inverse document frequency over
 * master-facts.json's own skill blocks.
 *
 * This is how a title match earns its weight. "android" appears in one group, so
 * a posting titled "Android Engineer" is saying something specific about which
 * group matters. "api" appears in two, so "API Engineer" says much less. Counting
 * every title match equally ranked Mobile third on a pure Android posting, and
 * ranked AI/ML above Backend on a billing posting, both because a single generic
 * word landed. Derived from the facts file rather than a hand-kept list of
 * "generic" words, so it stays true as the skills change.
 */
function skillSpread(facts) {
  const spread = new Map();
  for (const [group, list] of Object.entries(facts.skills || {})) {
    if (group.startsWith('_') || group === 'spoken_languages') continue;
    const seen = new Set();
    for (const s of list || []) {
      for (const w of skillWords(s).map(stem)) {
        if (seen.has(w)) continue;
        seen.add(w);
        spread.set(w, (spread.get(w) || 0) + 1);
      }
    }
  }
  return spread;
}

/**
 * Score a fact against the JD: how many of its declared skills the posting
 * actually mentions, plus a smaller signal from words in the bullet itself.
 * Facts with no overlap still score above zero so a role never renders empty.
 */
function scoreFact(fact, sig) {
  const skills = (fact.skills || []).map((s) => s.toLowerCase());
  let skillHits = 0;
  for (const skill of skills) {
    // Multi-word skills ("react native") match if every word appears.
    const parts = skill.split(/\s+/);
    if (!parts.every((p) => sig.all.has(p))) continue;
    // Double weight when the posting's TITLE names the skill.
    skillHits += parts.some((p) => sig.title.has(p)) ? 2 : 1;
  }

  const textTokens = tokenise(fact.text);
  let textHits = 0;
  for (const t of textTokens) if (sig.all.has(t)) textHits += 1;

  // A quantified bullet is stronger evidence; small nudge, not a thumb on the scale.
  const hasMetric = fact.metric ? 0.5 : 0;
  // A won competition is independent third-party evidence and outranks keyword
  // overlap. Without this, a 1st-place project lost its slot to a topically
  // closer but unremarkable one.
  const award = /\b(1st|first|winner|won|grand prize)\b/i.test(`${fact.metric || ''} ${fact.context || ''}`) ? 4 : 0;

  return skillHits * 3 + Math.min(textHits, 8) * 0.25 + hasMetric + award;
}

function selectContent(facts, job, bulletBudget, projectCap, roleCap) {
  const sig = jdSignals(job);
  const totalBullets = bulletBudget || MAX_TOTAL_BULLETS;
  const projectLimit = projectCap === undefined ? MAX_PROJECTS : projectCap;
  const roleLimit = roleCap === undefined ? MAX_ROLES : roleCap;

  const usable = (facts.facts || []).filter((f) => f.verified === true);
  const roles = facts.roles || [];

  // Rank roles by their best-matching content, but always keep the most recent
  // role — a resume that omits the current job reads as a gap.
  const byRole = new Map();
  usable.forEach((f, order) => {
    if (!byRole.has(f.role_id)) byRole.set(f.role_id, []);
    byRole.get(f.role_id).push({ fact: f, order, score: scoreFact(f, sig) });
  });
  for (const list of byRole.values()) list.sort((a, b) => b.score - a.score);

  // Seniority and tenure, not just keyword overlap.
  //
  // Summing bullet scores let one lucky keyword decide a whole role: a
  // four-month 2021 internship outranked a founder role because a single
  // bullet mentioned Elasticsearch. A resume reader weighs what the role WAS,
  // not only how its words align with this posting.
  const months = (r) => {
    const end = r.end === 'present' ? new Date().toISOString().slice(0, 7) : r.end;
    const [ys, ms] = String(r.start).split('-').map(Number);
    const [ye, me] = String(end).split('-').map(Number);
    return Number.isFinite(ys) && Number.isFinite(ye) ? Math.max(0, (ye - ys) * 12 + (me - ms)) : 0;
  };
  const seniority = (title) => {
    const t = String(title || '').toLowerCase();
    if (/founder|founding|principal|staff|lead|head of/.test(t)) return 2.5;
    if (/senior|sr\.?\b/.test(t)) return 1.5;
    if (/intern\b|internship/.test(t)) return -2;
    return 0;
  };

  const roleScores = roles.map((r) => {
    const list = byRole.get(r.id) || [];
    // Relevance decides WHICH bullets survive; master-facts.json order decides
    // how they READ. Sorting the survivors by score put "Tripled feature
    // velocity" above "Built the entire product from zero to production" —
    // burying the strongest claim because it matched fewer JD keywords.
    const top = list.slice(0, MAX_BULLETS_PER_ROLE).sort((a, b) => a.order - b.order);
    return {
      role: r,
      bullets: top,
      score:
        top.reduce((n, x) => n + x.score, 0) +
        seniority(r.title) +
        Math.min(months(r), 24) * 0.08,
      isCurrent: r.end === 'present',
    };
  });

  // Always keep the current role and the most recent finished one, then fill
  // the remaining slots by relevance. Purely score-based selection kept a 2021
  // internship while dropping a 2024-2026 role — chronologically odd, and it
  // loses the most recent evidence of what the candidate can do now.
  const current = roleScores.filter((r) => r.isCurrent);
  const finished = roleScores
    .filter((r) => !r.isCurrent)
    .sort((a, b) => String(b.role.end).localeCompare(String(a.role.end)));
  const mostRecent = finished.slice(0, 1);
  const remainder = finished.slice(1).sort((a, b) => b.score - a.score);
  const chosenRoles = [...current, ...mostRecent, ...remainder].slice(0, roleLimit);

  // Preserve reverse-chronological order for the reader; selection is by
  // relevance, presentation is by date.
  chosenRoles.sort((a, b) => String(b.role.start).localeCompare(String(a.role.start)));

  // Trim to a total bullet budget so one page stays achievable.
  let budget = totalBullets;
  for (const r of chosenRoles) {
    // Trim from the weakest end, then restore authored order.
    const keep = Math.max(1, Math.min(r.bullets.length, budget));
    r.bullets = [...r.bullets].sort((a, b) => b.score - a.score).slice(0, keep).sort((a, b) => a.order - b.order);
    budget -= r.bullets.length;
  }

  const projects = (facts.projects || [])
    .filter((p) => p.verified === true)
    .map((p) => ({ project: p, score: scoreFact(p, sig) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, projectLimit);

  // Skill groups, ordered by how much the posting actually asks for.
  //
  // Two bugs lived here. Groups were emitted in master-facts.json authoring order,
  // so Frontend and Mobile printed above Backend on a backend posting — the first
  // thing a reader sees under the summary said the wrong thing about the candidate.
  // And `(hit.length >= 3 ? hit : list)` meant a group with two matches dumped its
  // ENTIRE unfiltered list, which is where filler like "Machine Learning, Computer
  // Vision" came from.
  const groups = [];
  const spread = skillSpread(facts);
  for (const [group, list] of Object.entries(facts.skills || {})) {
    if (group.startsWith('_') || group === 'spoken_languages') continue;
    const hit = (list || []).filter((s) => skillWords(s).some((w) => sig.all.has(w)));
    // Title credit, weighted by how discriminating the matched word is: a skill
    // named by a word unique to one group scores a full point, one named by a
    // word shared across groups scores a fraction. See skillSpread().
    const titleHits = (list || []).reduce((n, s) => {
      const scores = skillWords(s)
        .filter((w) => sig.title.has(w))
        .map((w) => 1 / (spread.get(stem(w)) || 1));
      return n + (scores.length ? Math.max(...scores) : 0);
    }, 0);
    // Matched skills lead, then the rest of the group in authored order to give the
    // line body. A group the posting never mentions stays eligible, but ranks below
    // every group it does mention.
    const rest = (list || []).filter((s) => !hit.includes(s));
    // The group's own NAME appearing in the posting's title is the strongest
    // signal available, and it outranks any amount of incidental overlap. On
    // "Backend / API Engineer, Billing" the Backend group was dropped from the
    // resume entirely: Stripe's prose names none of its tools, while Mobile
    // scored a hit because "Android (Kotlin/Java)" contains "Java". A backend
    // resume that lists Mobile and Frontend but not Backend is worse than no
    // tailoring at all.
    const named = group.split('_').some((w) => sig.title.has(w)) ? 6 : 0;
    groups.push({ group, rank: named + titleHits * 3 + hit.length, items: [...hit, ...rest].slice(0, 9) });
  }
  groups.sort((a, b) => b.rank - a.rank);

  // Cap the skills block: every extra group costs a line, and a resume that
  // lists everything signals nothing.
  const skillsCapped = Object.fromEntries(
    groups.filter((g) => g.items.length).slice(0, 5).map((g) => [g.group, g.items])
  );

  return { roles: chosenRoles, projects, skills: skillsCapped, education: facts.education || [] };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/**
 * Section heading in the template's two-argument form: first letter full size,
 * remainder uppercase at \small. See templates/resume.tex for why the string is
 * split here in JS rather than in TeX.
 */
function heading(name) {
  // Escaped before splitting: "Patents & Publications" must reach LaTeX as
  // "\&", and the first character is always a letter so the split is safe.
  const up = tex(String(name).toUpperCase());
  return `\\resumesection{${up.slice(0, 1)}}{${up.slice(1)}}`;
}

function renderContact(contact) {
  const bits = [contact.location, contact.email && `\\href{mailto:${contact.email}}{${tex(contact.email)}}`, contact.phone]
    .filter(Boolean)
    .map((b) => (b.startsWith('\\href') ? b : tex(b)));
  // Named links, not bare URLs: shorter, and no unbreakable \href box long enough
  // to overflow the right margin — the bug that forced \nolinkurl previously.
  const l = contact.links || {};
  const links = [];
  if (l.linkedin) links.push(`\\href{${l.linkedin}}{LinkedIn}`);
  if (l.github) links.push(`\\href{${l.github}}{GitHub}`);
  if (l.website) links.push(`\\href{${l.website}}{Portfolio}`);
  return [...bits, ...links].join(' $|$\n  ');
}

/**
 * Role headline under the name, mirroring the posting's own title.
 *
 * This is the target role, not a claim about history, so it invents nothing: the
 * string comes from the job row. Trailing location/req noise that boards append
 * ("Backend Engineer, Payments (San Francisco)") is dropped.
 */
function renderHeadline(job, facts) {
  const raw = String(job.title || '').replace(/\s*[([].*$/, '').replace(/\s+/g, ' ').trim();
  return tex(raw || (facts.targets && facts.targets.headline) || 'Software Engineer');
}

function renderExperience(roles) {
  if (!roles.length) return '';
  // A role with no surviving bullets is dropped entirely. Emitting the entry
  // with an empty list environment is a hard LaTeX error ("perhaps a missing
  // \\item"), and an employer line with nothing under it says nothing anyway.
  const withBullets = roles.filter((r) => r.bullets && r.bullets.length > 0);
  if (!withBullets.length) return '';

  const out = [heading('Experience'), ''];
  for (const r of withBullets) {
    const dates = `${tex(r.role.start)} -- ${tex(r.role.end === 'present' ? 'Present' : r.role.end)}`;
    const right = [tex(r.role.location || ''), dates].filter(Boolean).join(' \\textbar{} ');
    // No \textbf here: \entry already bolds its first argument, so wrapping the
    // company again nested \textbf inside \textbf.
    out.push(`\\entry{${tex(r.role.company)} --- ${tex(r.role.title)}}{${right}}`);
    out.push('\\begin{itemize}');
    for (const b of r.bullets) out.push(`  \\item ${boldMetrics(tex(b.fact.text))}`);
    out.push('\\end{itemize}');
    out.push('\\vspace{2pt}');
  }
  return out.join('\n');
}

function renderProjects(projects) {
  if (!projects || !projects.length) return '';
  const out = [heading('Selected Projects'), '\\begin{itemize}'];
  for (const p of projects) {
    // An award is the strongest thing a project can carry, so it is bolded and
    // moved to the end as its own clause rather than buried in a parenthesis
    // after the name.
    const ctx = p.project.context ? String(p.project.context) : '';
    const award = /\b(1st place|first place|winner|won|grand prize)\b/i.test(ctx) ? ctx : '';
    const stack = (p.project.skills || []).slice(0, 6).map(skillCase).join(', ');
    let line = `  \\item \\textbf{${tex(p.project.name)}} --- ${boldMetrics(tex(p.project.text))}`;
    if (!/[.!?]$/.test(line)) line += '.';
    if (award) line += ` \\textbf{${tex(award)}}.`;
    else if (ctx) line += ` ${tex(ctx)}.`;
    if (stack) line += ` \\textit{${tex(stack)}.}`;
    out.push(line);
  }
  out.push('\\end{itemize}');
  return out.join('\n');
}

/**
 * Patents and publications: titles and venues, not a count.
 *
 * These were previously rendered only as "2 granted patents; 2 peer-reviewed
 * publications" inside the summary — a claim with no evidence anywhere on the
 * page, and the most differentiating material in the facts file.
 */
function renderPatentsPublications(facts) {
  const pats = (facts.patents || []).filter((p) => p.verified === true);
  const pubs = (facts.publications || []).filter((p) => p.verified === true);
  if (!pats.length && !pubs.length) return '';

  const sentences = [];
  if (pats.length) {
    const list = pats.map((p) => `${tex(p.title)}${p.number ? ` (${tex(p.number)})` : ''}`).join('; ');
    sentences.push(`${pats.length} granted patent${pats.length === 1 ? '' : 's'}: ${list}.`);
  }
  if (pubs.length) {
    const list = pubs.map((p) => `${tex(p.title)}${p.venue ? ` --- \\textit{${tex(p.venue)}}` : ''}`).join('; ');
    sentences.push(`${pubs.length} peer-reviewed publication${pubs.length === 1 ? '' : 's'}: ${list}.`);
  }
  return `${heading('Patents & Publications')}\n${sentences.join(' ')}`;
}

/**
 * Awards. Kept to one line: the hackathon record is a real differentiator but a
 * bulleted list of three would cost more of the page than it returns.
 */
function renderAwards(facts) {
  const awards = (facts.awards || []).filter((a) => a.verified === true);
  if (!awards.length) return '';
  const first = awards.find((a) => /1st place|first place/i.test(a.title || ''));
  const count = awards.find((a) => /\b\d+x\b/i.test(a.title || ''));
  const bits = [];
  if (count) bits.push(`\\textbf{${tex(count.title.replace(/\s*\(.*$/, ''))}}`);
  if (first && first !== count) bits.push(`including \\textbf{${tex(first.title)}}`);
  for (const a of awards) {
    if (a !== first && a !== count) bits.push(tex(a.title));
  }
  // Award titles carry their own commas ("Best Outstanding Student (2019-2023),
  // Computer Science and Engineering - REVA University"), so joining everything
  // with commas rendered three awards as four, the last a bare fragment. The
  // headline award keeps its comma; the tail is separated by semicolons.
  const line = bits.length > 2 ? `${bits[0]}, ${bits.slice(1).join('; ')}` : bits.join(', ');
  return `${heading('Awards')}\n${line}.`;
}

function renderSkills(skills) {
  const entries = Object.entries(skills);
  if (!entries.length) return '';
  // Acronyms must not be title-cased into "Ai Ml"; an ATS matching on "AI" or
  // "ML" would miss the mangled form.
  const LABELS = {
    ai_ml: 'AI/ML', cloud_devops: 'Cloud & DevOps', languages: 'Languages',
    frontend: 'Frontend', backend: 'Backend', mobile: 'Mobile',
    databases: 'Databases', systems: 'Systems',
  };
  const label = (g) => LABELS[g] || g.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const out = [heading('Skills'), '\\begin{itemize}'];
  for (const [g, list] of entries) {
    out.push(`  \\item \\textbf{${tex(label(g))}:} ${tex(list.join(', '))}`);
  }
  out.push('\\end{itemize}');
  return out.join('\n');
}

function renderEducation(education) {
  if (!education.length) return '';
  // One line per entry: a separate GPA line costs as much vertical space as a
  // whole experience bullet, which is worth far more on a one-page resume.
  // Credential first, then institution, GPA in the same left cell and only the
  // completion year on the right. Two dates per degree tell a reader nothing they
  // need, and the year alone leaves room for the GPA to sit where it reads as part
  // of the degree.
  const out = [heading('Education'), ''];
  for (const e of education) {
    const left = [`${tex(e.credential)} --- ${tex(e.institution)}`, e.gpa ? `GPA ${tex(e.gpa)}` : '']
      .filter(Boolean).join(', ');
    const year = String(e.end || '').slice(0, 4);
    out.push(`\\entry{${left}}{${tex(year)}}`);
  }
  return out.join('\n');
}

function renderSummary(facts, job, selection) {
  // Deliberately not model-written: one factual line assembled from the facts
  // file and the target title. It must describe what this resume actually
  // shows -- quoting a role count larger than the roles listed below reads as
  // padding at best and inaccuracy at worst.
  const top = (facts.roles || [])[0];
  if (!top) return '';

  // Three sentences: who they are, what of the posting's stack they actually work
  // in, and the credentials the bullets cannot show.
  //
  // The middle sentence is how the JD gets woven in truthfully: it is the
  // INTERSECTION of the candidate's own skill lists with the posting's vocabulary,
  // so every term is both in the JD and already claimed in master-facts.json.
  // Nothing is added because the posting asked for it.
  //
  // LIMIT, worth being honest about: assembling sentences is not writing one. A
  // summary that argues why this candidate fits THIS team needs either a model call
  // or a human-authored line per target role. This is the best available under the
  // never-invent rule with no API call.
  const clean = (s) => String(s).replace(/\.$/, '');
  const sentences = [];

  const years = (facts.screening_answers || {}).years_of_experience;
  const identity = `${clean(top.title)} at ${clean(top.company)}` +
    (years ? `, with ${tex(String(years))} years of professional engineering experience` : '');
  sentences.push(`${tex(identity)}.`);

  // Two tiers, not one list: skills the posting's TITLE names come first, then
  // the rest of the overlap in authored order. Only seven survive the slice, and
  // filling them from whatever happened to appear in the company blurb led this
  // sentence with "Java, C++, Android (Kotlin/Java)" on a backend billing role.
  const sig = jdSignals(job);
  const titled = [];
  const rest = [];
  // Walk the SELECTED groups, in the order the Skills block will print them.
  // Reading facts.skills directly meant the summary drew from authoring order,
  // so a backend data posting opened with "Android (Kotlin/Java)" while Mobile
  // ranked fourth in the block below it. This also guarantees the summary can
  // only name skills the page actually shows.
  const source = selection && Object.keys(selection.skills || {}).length
    ? selection.skills
    : facts.skills || {};
  for (const [group, list] of Object.entries(source)) {
    if (group.startsWith('_') || group === 'spoken_languages') continue;
    for (const s of list || []) {
      const words = skillWords(s);
      if (titled.includes(s) || rest.includes(s)) continue;
      if (words.some((w) => sig.title.has(w))) titled.push(s);
      else if (words.some((w) => sig.all.has(w))) rest.push(s);
    }
  }
  const overlap = [...titled, ...rest];
  if (overlap.length >= 3) {
    sentences.push(`Works day to day in ${tex(overlap.slice(0, 7).map(skillCase).join(', '))}.`);
  }

  const edu = (facts.education || [])[0];
  const credentials = [];
  if (edu) credentials.push(`${clean(edu.credential)}, ${clean(edu.institution)}`);
  const nPat = (facts.patents || []).filter((p) => p.verified === true).length;
  const nPub = (facts.publications || []).filter((p) => p.verified === true).length;
  if (nPat) credentials.push(`${nPat} granted patent${nPat === 1 ? '' : 's'}`);
  if (nPub) credentials.push(`${nPub} peer-reviewed publication${nPub === 1 ? '' : 's'}`);
  if (credentials.length) sentences.push(`${tex(credentials.join('; '))}.`);

  return `${heading('Summary')}\n${sentences.join(' ')}`;
}

/** Markdown mirror of exactly what the PDF shows — the source for the .docx. */
function renderMarkdown(facts, job, sel) {
  const c = facts.contact;
  const links = Object.values(c.links || {}).filter(Boolean).map((u) => u.replace(/^https?:\/\/(www\.)?/, ''));
  // Section order mirrors the PDF exactly; a .docx that reorders sections is a
  // different document, and the two get sent to different employers.
  const out = [
    `# ${c.name}`, '',
    `## ${String(job.title || '').replace(/\s*[([].*$/, '').trim()}`, '',
    [c.location, c.email, c.phone, ...links].filter(Boolean).join(' | '), '',
  ];

  const strip = (s) => String(s).replace(/\\textbar\{\}/g, '|').replace(/\\textit\{([^}]*)\}/g, '*$1*')
    .replace(/\\textbf\{([^}]*)\}/g, '**$1**').replace(/\\resumesection\{(.)\}\{([^}]*)\}/g, '')
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\\$/g, '$').replace(/\\#/g, '#')
    .replace(/---/g, '—').replace(/\s+/g, ' ').trim();

  out.push('## Summary', '', strip(renderSummary(facts, job, sel)), '');

  const label = (g) => ({ ai_ml: 'AI/ML', cloud_devops: 'Cloud & DevOps' })[g] ||
    g.replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
  out.push('## Skills', '');
  for (const [g, list] of Object.entries(sel.skills)) out.push(`- **${label(g)}:** ${list.join(', ')}`);
  out.push('');

  out.push('## Experience', '');
  for (const r of sel.roles.filter((r) => r.bullets.length)) {
    const end = r.role.end === 'present' ? 'Present' : r.role.end;
    out.push(`**${r.role.company} — ${r.role.title}**  `, `${r.role.location || ''} | ${r.role.start} – ${end}`, '');
    for (const b of r.bullets) out.push(`- ${b.fact.text}`);
    out.push('');
  }

  if (sel.projects.length) {
    out.push('## Selected Projects', '');
    for (const p of sel.projects) {
      const stack = (p.project.skills || []).slice(0, 6).map(skillCase).join(', ');
      const ctx = p.project.context ? ` ${p.project.context}.` : '';
      out.push(`- **${p.project.name}** — ${p.project.text}${ctx}${stack ? ` *${stack}.*` : ''}`);
    }
    out.push('');
  }

  const pats = (facts.patents || []).filter((p) => p.verified === true);
  const pubs = (facts.publications || []).filter((p) => p.verified === true);
  if (pats.length || pubs.length) {
    out.push('## Patents & Publications', '');
    for (const p of pats) out.push(`- ${p.title}${p.number ? ` (${p.number})` : ''}`);
    for (const p of pubs) out.push(`- ${p.title}${p.venue ? ` — *${p.venue}*` : ''}`);
    out.push('');
  }

  out.push('## Education', '');
  for (const e of sel.education) {
    out.push(`**${e.credential} — ${e.institution}**${e.gpa ? `, GPA ${e.gpa}` : ''} | ${String(e.end || '').slice(0, 4)}  `, '');
  }

  const awards = (facts.awards || []).filter((a) => a.verified === true);
  if (awards.length) {
    out.push('## Awards', '');
    for (const a of awards) out.push(`- ${a.title}`);
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// US Letter, in PostScript points, and the template's 0.45in vertical margins.
const PAGE_H = 792;
const MARGIN_BOTTOM_PT = 0.45 * 72; // 32.4pt

// How far the last ink may sit above the bottom margin before the page reads thin.
// From the template's own fill instructions: bottom-y should land within ~10pt of
// the bottom margin, and anything past ~60pt absolute (≈28pt of slack) is
// under-filled.
const SLACK_TARGET_PT = 10;
const SLACK_UNDERFILL_PT = 28;

// Share of the posting's own vocabulary — narrowed to skills the candidate really
// has — that must appear on the page. Not 100%: a posting naming ten technologies
// the candidate knows cannot all earn space on one page, and forcing it would be
// the keyword stuffing this gate exists to prevent.
const MIN_JD_COVERAGE = 0.7;

/**
 * Vertical slack: the gap between the last ink on the page and the bottom margin.
 *
 * The page-count gate only catches overflow — a half-empty resume is exactly one
 * page and sails through. The previous measure divided ink HEIGHT by the usable
 * height, which reported 93% for a page with two thirds of an inch of dead space
 * at the bottom and one project on it, because content starting at the top margin
 * makes the ratio look healthy no matter where it stops. Measuring the bottom gap
 * directly is what the template's instructions specify, and it fails that page.
 *
 * Returns points of slack (0 = flush to the margin), or null if ghostscript is
 * absent — unknown is never a failure.
 */
function measureSlack(pdfPath) {
  // gs writes the bounding box to STDERR, not stdout — execFileSync returns
  // only stdout, so this silently measured nothing until spawnSync was used.
  const r = spawnSync('gs', ['-sDEVICE=bbox', '-dNOPAUSE', '-dBATCH', '-q', pdfPath], { encoding: 'utf8' });
  if (r.error) return null;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = out.match(/%%HiResBoundingBox:\s*\S+\s+(\S+)\s+\S+\s+(\S+)/);
  if (!m) return null;
  const bottomY = parseFloat(m[1]);
  return Math.max(0, bottomY - MARGIN_BOTTOM_PT);
}
function normalise(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
}

/**
 * Whitespace- and punctuation-free form, for checking that a fact survived
 * into the PDF. pdflatex hyphenates and line-wraps freely, so "Linux-hosted"
 * can extract as "linux-\nhosted" — comparing loosely here avoids failing a
 * PDF that is actually correct, while still catching genuinely absent text.
 */
function normaliseTight(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The ATS gate. Compiling successfully proves nothing about whether a parser
 * can read the result, so the PDF is put back through pdftotext and checked
 * for the things a parser must find.
 */
function runGates(pdfPath, opts) {
  const { contact, expectedFacts, facts, jdText, logPath, headings } = opts;
  const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  const flat = normalise(txt);
  const tight = normaliseTight(txt);
  const failures = [];

  // 1. Contact details must survive — the commonest silent ATS failure.
  if (!flat.includes(normalise(contact.name))) failures.push('name not found in extracted text');
  if (!flat.includes(normalise(contact.email))) failures.push('email not found in extracted text');

  // 2. Every section heading must extract CONTIGUOUSLY.
  //
  // Not just "is the word somewhere": small-caps headings extract as "S UMMARY"
  // and "PATENTS & P UBLICATIONS", because pdftotext reads the font change after
  // the initial as a word break. Headings are what an ATS uses to segment the
  // document, so a broken one costs a whole section. Checked against the headings
  // actually emitted, so adding a section cannot skip the check.
  for (const h of headings) {
    if (!flat.includes(normalise(h))) {
      failures.push(`section heading "${h}" did not extract contiguously (small-caps regression?)`);
    }
  }

  // 3. Every selected fact must actually appear. This is the never-invent rule
  //    enforced in the other direction: what we claimed to include is present,
  //    and by construction nothing else was written.
  for (const f of expectedFacts) {
    const probe = normaliseTight(f.text).slice(0, 50);
    if (probe && !tight.includes(probe)) failures.push(`fact "${f.id}" missing from PDF`);
  }

  // 4. One page.
  const pages = (execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).match(/^Pages:\s*(\d+)/m) || [])[1];
  if (pages && Number(pages) !== 1) failures.push(`resume is ${pages} pages, expected 1`);

  // 5. No Overfull \hbox. This is the gate that makes the template's tabular*
  //    entry safe to use: an over-long left cell silently pushes the right cell
  //    past the margin, which is how an education line's dates once ran clean off
  //    the paper. LaTeX reports it; nothing was reading the report. Sub-point
  //    overflows are normal in justified text and ignored.
  if (logPath && fs.existsSync(logPath)) {
    const over = [...fs.readFileSync(logPath, 'utf8').matchAll(/Overfull \\hbox \(([\d.]+)pt too wide\)/g)]
      .map((m) => parseFloat(m[1]))
      .filter((pt) => pt > 1);
    if (over.length) {
      failures.push(`${over.length} overfull hbox(es), worst ${Math.max(...over).toFixed(1)}pt past the margin`);
    }
  }

  // 6. JD keyword coverage — the gate CLAUDE.md mandates and that was never built.
  //
  //    Scoped to the intersection of what the posting names and what the candidate
  //    already claims in master-facts.json, so it can only ever ask for truthful
  //    terms. That scoping is also what stops it degenerating into keyword
  //    stuffing: a term the candidate does not have cannot enter the denominator.
  const coverage = { want: [], missing: [], ratio: 1 };
  if (jdText && facts) {
    const jdTokens = tokenise(jdText);
    const owned = new Set();
    for (const [group, list] of Object.entries(facts.skills || {})) {
      if (group.startsWith('_') || group === 'spoken_languages') continue;
      for (const s of list || []) owned.add(s);
    }
    for (const s of owned) {
      const words = s.toLowerCase().split(/[\s/(),]+/).filter((w) => w.length > 2);
      if (!words.length || !words.some((w) => jdTokens.has(w))) continue;
      coverage.want.push(s);
      if (!tight.includes(normaliseTight(s))) coverage.missing.push(s);
    }
    coverage.ratio = coverage.want.length ? 1 - coverage.missing.length / coverage.want.length : 1;
    if (coverage.want.length >= 4 && coverage.ratio < MIN_JD_COVERAGE) {
      failures.push(
        `JD keyword coverage ${(coverage.ratio * 100).toFixed(0)}% (< ${(MIN_JD_COVERAGE * 100).toFixed(0)}%): ` +
        `missing ${coverage.missing.slice(0, 8).join(', ')}`
      );
    }
  }

  const slack = measureSlack(pdfPath);
  return { failures, pages: pages ? Number(pages) : null, chars: txt.length, slack, coverage };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function compile(texPath, outDir) {
  // Twice: hyperref needs a second pass to settle references.
  for (let i = 0; i < 2; i++) {
    execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', outDir, texPath], {
      stdio: 'pipe',
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const idFlag = args.indexOf('--job-id');
  if (idFlag < 0) throw new Error('--job-id is required');
  const jobId = Number(args[idFlag + 1]);
  if (!Number.isInteger(jobId)) throw new Error('--job-id must be an integer');
  const dryRun = args.includes('--dry-run');
  const keepTex = args.includes('--keep-tex');
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : OUT_DIR;

  if (!fs.existsSync(FACTS_PATH)) throw new Error(`${FACTS_PATH} not found`);
  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));

  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.description, j.location, j.url, c.name AS company
       FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
    [jobId]
  );
  if (rows.length === 0) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  const selection = selectContent(facts, job);
  const chosenFacts = selection.roles.flatMap((r) => r.bullets.map((b) => b.fact));

  log(`job ${job.id}: ${job.company} — ${job.title}`);
  log(`selected ${chosenFacts.length} bullet(s) across ${selection.roles.length} role(s), ` +
      `${selection.projects.length} project(s)`);
  for (const r of selection.roles) {
    log(`  ${r.role.company}: ${r.bullets.map((b) => `${b.fact.id}(${b.score.toFixed(1)})`).join(', ')}`);
  }

  if (dryRun) return;

  fs.mkdirSync(outDir, { recursive: true });
  const slug = `${job.company}_${job.title || 'role'}`.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  const base = `${facts.contact.name.replace(/[^A-Za-z0-9]+/g, '_')}_${slug}`;
  const texPath = path.join(outDir, `${base}.tex`);
  const pdfPath = path.join(outDir, `${base}.pdf`);

  const template = fs.readFileSync(TEMPLATE, 'utf8');

  // Section order is the template's: Summary, Skills, Experience, Projects,
  // Patents & Publications, Education, Awards. Skills sits above Experience on
  // purpose — it is the fastest way for a reader to confirm the stack matches.
  const sections = (sel) => ({
    __SUMMARY__: renderSummary(facts, job, sel),
    __SKILLS__: renderSkills(sel.skills),
    __EXPERIENCE__: renderExperience(sel.roles),
    __PROJECTS__: renderProjects(sel.projects),
    __PATENTS__: renderPatentsPublications(facts),
    __EDUCATION__: renderEducation(sel.education),
    __AWARDS__: renderAwards(facts),
  });

  const build = (sel) => {
    let out = template
      .replace('__NAME__', tex(facts.contact.name))
      .replace('__HEADLINE__', renderHeadline(job, facts))
      .replace('__CONTACT__', renderContact(facts.contact));
    for (const [token, body] of Object.entries(sections(sel))) out = out.replace(token, body);
    return out;
  };

  // The headings actually emitted, for the extraction gate. Derived from the
  // rendered sections rather than hardcoded, so a new section is covered without
  // anyone remembering to add it to the gate.
  const emittedHeadings = (sel) =>
    Object.values(sections(sel))
      .flatMap((body) => [...String(body).matchAll(/\\resumesection\{(.)\}\{([^}]*)\}/g)])
      .map((m) => `${m[1]}${m[2]}`.replace(/\\&/g, '&'));

  // Content length varies per job, so a fixed budget either overflows to two
  // pages or wastes half of one. Shrink until it genuinely fits, dropping the
  // weakest-scoring material first.
  let bullets = MAX_TOTAL_BULLETS;
  let projectCap = MAX_PROJECTS;
  let roleCap = MAX_ROLES;
  let grew = 0;
  let sel = selection;
  let result = null;

  for (let attempt = 0; attempt < 16; attempt++) {
    fs.writeFileSync(texPath, build(sel));
    try {
      compile(texPath, outDir);
    } catch (e) {
      const logFile = path.join(outDir, `${base}.log`);
      const detail = fs.existsSync(logFile)
        ? (fs.readFileSync(logFile, 'utf8').match(/^!.*$/m) || ['see log'])[0]
        : e.message;
      throw new Error(`pdflatex failed: ${detail}\n  tex kept at ${texPath}`);
    }

    const chosen = sel.roles.flatMap((r) => r.bullets.map((b) => b.fact));
    result = runGates(pdfPath, {
      contact: facts.contact,
      expectedFacts: chosen,
      facts,
      jdText: `${job.title} ${job.description}`,
      logPath: path.join(outDir, `${base}.log`),
      headings: emittedHeadings(sel),
    });

    const onlyTooLong = result.failures.every((f) => f.includes('pages, expected 1'));

    // One page but thin: add content back rather than shipping a sparse page.
    //
    // The growth budget is deliberately generous. The 10pt Charter template holds
    // far more than the previous 11pt one, so reaching the bottom margin from the
    // starting caps takes many steps — the old cap of 4 stopped growing while an
    // inch of page was still empty. The shrink ladder below still catches a step
    // that tips over into two pages.
    if (result.failures.length === 0 && result.slack !== null && result.slack > SLACK_UNDERFILL_PT && grew < 14) {
      const before = `${bullets}/${projectCap}/${roleCap}`;
      // Ceilings above the defaults on purpose. The ladder starts at the
      // default and only shrinks, so growth capped at the same values could
      // never fire. Bounded by the material that actually exists.
      const maxRoles = (facts.roles || []).length;
      const maxProjects = (facts.projects || []).filter((x) => x.verified === true).length;
      // Bullets first: another bullet on a role already on the page is worth more
      // than a fifth role or a fourth project, and it was ordered last before.
      if (bullets < 24) bullets += 2;
      else if (projectCap < maxProjects) projectCap += 1;
      else if (roleCap < maxRoles) roleCap += 1;
      else break; // nothing left to add
      grew += 1;
      log(`  ${result.slack.toFixed(0)}pt of empty page above the bottom margin ` +
          `— growing ${before} -> ${bullets}/${projectCap}/${roleCap}`);
      sel = selectContent(facts, job, bullets, projectCap, roleCap);
      continue;
    }

    if (result.failures.length === 0) break;
    if (!onlyTooLong) {
      throw new Error(`ATS gates failed (PDF rejected):\n  - ${result.failures.join('\n  - ')}`);
    }

    // Order matters and my first guess was wrong. Cutting projects first threw
    // away an award-winning project while keeping a fourth marginal bullet.
    // Trim bullets first (the weakest is genuinely the cheapest loss), then
    // projects, and only then drop a whole role.
    if (bullets > MIN_TOTAL_BULLETS) bullets -= 1;
    else if (projectCap > 2) projectCap -= 1;
    else if (roleCap > 3) roleCap -= 1;
    else if (projectCap > 1) projectCap -= 1;
    else if (roleCap > 2) roleCap -= 1;
    else throw new Error(`cannot fit one page even at minimum content (${result.pages} pages)`);

    log(`  ${result.pages} pages — retrying: ${bullets} bullets, ${projectCap} project(s), ${roleCap} role(s)`);
    sel = selectContent(facts, job, bullets, projectCap, roleCap);
  }

  if (!result || result.failures.length > 0) {
    throw new Error(`ATS gates failed (PDF rejected):\n  - ${(result ? result.failures : ['unknown']).join('\n  - ')}`);
  }

  const finalFacts = sel.roles.flatMap((r) => r.bullets.map((b) => b.fact));

  if (!keepTex) {
    for (const ext of ['.aux', '.out', '.log']) {
      const f = path.join(outDir, base + ext);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  await pool.query(
    `UPDATE jobs SET resume_path = $1, resume_built_at = now(), updated_at = now() WHERE id = $2`,
    [pdfPath, job.id]
  );

  // Some application portals reject PDFs outright. pandoc gives an editable
  // Word version from a Markdown mirror of the same selection — same facts,
  // same order, no second source of truth.
  const mdPath = pdfPath.replace(/\.pdf$/, '.md');
  const docxPath = pdfPath.replace(/\.pdf$/, '.docx');
  fs.writeFileSync(mdPath, renderMarkdown(facts, job, sel));
  const pd = spawnSync('pandoc', [mdPath, '-o', docxPath], { encoding: 'utf8' });
  const haveDocx = !pd.error && pd.status === 0 && fs.existsSync(docxPath);
  if (!haveDocx && !pd.error) log(`  (pandoc failed: ${(pd.stderr || '').trim().slice(0, 120)})`);

  log(`✓ ${pdfPath}`);
  log(`  gates passed: ${result.pages} page, ${result.chars} chars extracted, ` +
      `${finalFacts.length} fact(s) verified present, ${sel.projects.length} project(s)` +
      `${result.slack !== null ? `, ${result.slack.toFixed(0)}pt slack at the bottom margin` : ''}` +
      `, JD coverage ${(result.coverage.ratio * 100).toFixed(0)}% of ${result.coverage.want.length} term(s)`);
  if (result.slack !== null && result.slack > SLACK_TARGET_PT) {
    log(`  note: ${result.slack.toFixed(0)}pt of page left unused — no material remained to fill it`);
  }
  if (result.coverage.missing.length) {
    log(`  JD terms owned but not on the page: ${result.coverage.missing.join(', ')}`);
  }
  if (haveDocx) log(`  also wrote ${path.basename(docxPath)} (editable, for portals that reject PDFs)`);
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
