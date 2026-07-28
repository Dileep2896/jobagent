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
const MAX_PROJECTS = 3;
let MAX_TOTAL_BULLETS = 16; // starting budget; shrunk automatically to fit one page
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
  const k = String(s).toLowerCase().trim();
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
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
  );
}

/**
 * Score a fact against the JD: how many of its declared skills the posting
 * actually mentions, plus a smaller signal from words in the bullet itself.
 * Facts with no overlap still score above zero so a role never renders empty.
 */
function scoreFact(fact, jdTokens) {
  const skills = (fact.skills || []).map((s) => s.toLowerCase());
  let skillHits = 0;
  for (const skill of skills) {
    // Multi-word skills ("react native") match if every word appears.
    const parts = skill.split(/\s+/);
    if (parts.every((p) => jdTokens.has(p))) skillHits += 1;
  }

  const textTokens = tokenise(fact.text);
  let textHits = 0;
  for (const t of textTokens) if (jdTokens.has(t)) textHits += 1;

  // A quantified bullet is stronger evidence; small nudge, not a thumb on the scale.
  const hasMetric = fact.metric ? 0.5 : 0;
  // A won competition is independent third-party evidence and outranks keyword
  // overlap. Without this, a 1st-place project lost its slot to a topically
  // closer but unremarkable one.
  const award = /\b(1st|first|winner|won|grand prize)\b/i.test(`${fact.metric || ''} ${fact.context || ''}`) ? 4 : 0;

  return skillHits * 3 + Math.min(textHits, 8) * 0.25 + hasMetric + award;
}

function selectContent(facts, jd, bulletBudget, projectCap, roleCap) {
  const jdTokens = tokenise(jd);
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
    byRole.get(f.role_id).push({ fact: f, order, score: scoreFact(f, jdTokens) });
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
    .map((p) => ({ project: p, score: scoreFact(p, jdTokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, projectLimit);

  // Skill groups, filtered to what the posting actually mentions, so the
  // section reflects the role instead of listing everything.
  const skills = {};
  for (const [group, list] of Object.entries(facts.skills || {})) {
    if (group.startsWith('_') || group === 'spoken_languages') continue;
    const hit = (list || []).filter((s) =>
      s.toLowerCase().split(/[\s/(),]+/).some((w) => w.length > 1 && jdTokens.has(w))
    );
    const chosen = (hit.length >= 3 ? hit : (list || [])).slice(0, 9);
    if (chosen.length) skills[group] = chosen;
  }

  // Cap the skills block: every extra group costs a line, and a resume that
  // lists everything signals nothing.
  const skillsCapped = Object.fromEntries(Object.entries(skills).slice(0, 5));

  return { roles: chosenRoles, projects, skills: skillsCapped, education: facts.education || [] };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderContact(contact) {
  const bits = [contact.location, contact.email, contact.phone].filter(Boolean).map(tex);
  const links = [];
  const l = contact.links || {};
  // \\href makes an unbreakable box: a long URL at the end of the contact line
  // overflowed the right margin instead of wrapping. \\nolinkurl inside allows
  // breaks at the URL's own punctuation.
  const link = (u) => `\\href{${u}}{\\nolinkurl{${u.replace(/^https?:\/\/(www\.)?/, '')}}}`;
  if (l.linkedin) links.push(link(l.linkedin));
  if (l.github) links.push(link(l.github));
  if (l.website) links.push(link(l.website));
  return [...bits, ...links].join(' \\textbar{} ');
}

function renderExperience(roles) {
  if (!roles.length) return '';
  // A role with no surviving bullets is dropped entirely. Emitting the entry
  // with an empty list environment is a hard LaTeX error ("perhaps a missing
  // \\item"), and an employer line with nothing under it says nothing anyway.
  const withBullets = roles.filter((r) => r.bullets && r.bullets.length > 0);
  if (!withBullets.length) return '';

  const out = ['\\resumesection{Experience}'];
  for (const r of withBullets) {
    const dates = `${tex(r.role.start)} -- ${tex(r.role.end === 'present' ? 'Present' : r.role.end)}`;
    const right = [tex(r.role.location || ''), dates].filter(Boolean).join(' \\textbar{} ');
    out.push(`\\entry{\\textbf{${tex(r.role.company)}} --- ${tex(r.role.title)}}{${right}}`);
    out.push('\\begin{resumebullets}');
    for (const b of r.bullets) out.push(`  \\item ${boldMetrics(tex(b.fact.text))}`);
    out.push('\\end{resumebullets}');
    out.push('\\vspace{2pt}');
  }
  return out.join('\n');
}

function renderProjects(projects) {
  if (!projects || !projects.length) return '';
  const out = ['\\resumesection{Projects}', '\\begin{resumebullets}'];
  for (const p of projects) {
    const ctx = p.project.context ? ` (${tex(p.project.context)})` : '';
    const stack = (p.project.skills || []).slice(0, 7).map(skillCase).join(', ');
    out.push(
      `  \\item \\textbf{${tex(p.project.name)}}${ctx}: ${boldMetrics(tex(p.project.text))}` +
      (stack ? ` \\textit{${tex(stack)}}` : '')
    );
  }
  out.push('\\end{resumebullets}');
  return out.join('\n');
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
  const out = ['\\resumesection{Skills}', '\\begin{resumebullets}'];
  for (const [g, list] of entries) {
    out.push(`  \\item {\\bfseries ${tex(label(g))}:} ${tex(list.join(', '))}`);
  }
  out.push('\\end{resumebullets}');
  return out.join('\n');
}

function renderEducation(education) {
  if (!education.length) return '';
  // One line per entry: a separate GPA line costs as much vertical space as a
  // whole experience bullet, which is worth far more on a one-page resume.
  const out = ['\\resumesection{Education}'];
  for (const e of education) {
    const right = [e.gpa ? `GPA ${tex(e.gpa)}` : '', `${tex(e.start)} -- ${tex(e.end)}`]
      .filter(Boolean).join(' \\textbar{} ');
    out.push(`\\entry{\\textbf{${tex(e.institution)}} --- ${tex(e.credential)}}{${right}}`);
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

  // Assembled from facts, never authored. The previous version told the reader
  // which job they were reading an application for — which they know — and
  // padded with a role count. Credentials they cannot infer from the bullets
  // are worth the three lines instead.
  const edu = (facts.education || [])[0];
  const bits = [`${tex(top.title)} at ${tex(top.company)}`];
  if (edu) bits.push(`${tex(edu.credential)}, ${tex(edu.institution)}`);

  const credentials = [];
  const nPat = (facts.patents || []).length;
  const nPub = (facts.publications || []).length;
  if (nPat) credentials.push(`${nPat} granted patent${nPat === 1 ? '' : 's'}`);
  if (nPub) credentials.push(`${nPub} peer-reviewed publication${nPub === 1 ? '' : 's'}`);
  const award = (facts.awards || []).find((a) => /1st place/i.test(a.title || ''));
  if (award) credentials.push(tex(award.title.replace(/\s*\(.*$/, '')));

  // Company and credential names often already end in a period ("Metis AI
  // Inc."), which produced "Inc..". Join without doubling terminal punctuation.
  const sentence = bits.map((b) => b.replace(/\.$/, '')).join('. ');
  return `\\resumesection{Summary}\n${sentence}.` +
         (credentials.length ? ` ${credentials.join('; ')}.` : '');
}

/** Markdown mirror of exactly what the PDF shows — the source for the .docx. */
function renderMarkdown(facts, job, sel) {
  const c = facts.contact;
  const links = Object.values(c.links || {}).filter(Boolean).map((u) => u.replace(/^https?:\/\/(www\.)?/, ''));
  const out = [`# ${c.name}`, '', [c.location, c.email, c.phone, ...links].filter(Boolean).join(' | '), ''];

  out.push('## Experience', '');
  for (const r of sel.roles.filter((r) => r.bullets.length)) {
    const end = r.role.end === 'present' ? 'Present' : r.role.end;
    out.push(`**${r.role.company}** — ${r.role.title}  `, `${r.role.location || ''} | ${r.role.start} – ${end}`, '');
    for (const b of r.bullets) out.push(`- ${b.fact.text}`);
    out.push('');
  }
  if (sel.projects.length) {
    out.push('## Projects', '');
    for (const p of sel.projects) {
      const ctx = p.project.context ? ` (${p.project.context})` : '';
      out.push(`- **${p.project.name}**${ctx}: ${p.project.text}`);
    }
    out.push('');
  }
  const label = (g) => g.replace(/_/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
  out.push('## Skills', '');
  for (const [g, list] of Object.entries(sel.skills)) out.push(`- **${label(g)}:** ${list.join(', ')}`);
  out.push('', '## Education', '');
  for (const e of sel.education) {
    out.push(`**${e.institution}** — ${e.credential}${e.gpa ? ` (GPA ${e.gpa})` : ''}  `, `${e.location || ''} | ${e.start} – ${e.end}`, '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// US Letter, in PostScript points, and the template's 0.45in vertical margins.
const PAGE_H = 792;
const MARGIN_PT = 0.75 * 72;
const MIN_FILL = 0.82; // below this the page reads as padded-out and thin

/**
 * How much of the usable page the content actually occupies.
 *
 * The page-count gate only catches overflow: a half-empty resume is exactly
 * one page and sails through. Ghostscript's bbox device reports the ink
 * extents, which turns "does it fit" into "does it fill" — the difference
 * between a resume that looks deliberate and one that looks thin.
 */
function measureFill(pdfPath) {
  // gs writes the bounding box to STDERR, not stdout — execFileSync returns
  // only stdout, so this silently measured nothing until spawnSync was used.
  const r = spawnSync('gs', ['-sDEVICE=bbox', '-dNOPAUSE', '-dBATCH', '-q', pdfPath], { encoding: 'utf8' });
  if (r.error) return null; // ghostscript absent — unknown, never a failure
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = out.match(/%%HiResBoundingBox:\s*\S+\s+(\S+)\s+\S+\s+(\S+)/);
  if (!m) return null;
  const bottom = parseFloat(m[1]);
  const top = parseFloat(m[2]);
  const usable = PAGE_H - 2 * MARGIN_PT;
  return Math.min(1, (top - bottom) / usable);
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
function runGates(pdfPath, selection, contact, expectedFacts) {
  const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  const flat = normalise(txt);
  const tight = normaliseTight(txt);
  const failures = [];

  // 1. Contact details must survive — the commonest silent ATS failure.
  if (!flat.includes(normalise(contact.name))) failures.push('name not found in extracted text');
  if (!flat.includes(normalise(contact.email))) failures.push('email not found in extracted text');

  // 2. Standard section headers must survive.
  for (const h of ['experience', 'skills', 'education']) {
    if (!flat.includes(h)) failures.push(`section heading "${h}" not found`);
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

  const fill = measureFill(pdfPath);
  return { failures, pages: pages ? Number(pages) : null, chars: txt.length, fill };
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

  const selection = selectContent(facts, `${job.title} ${job.description}`);
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

  const build = (sel) =>
    template
      .replace('__NAME__', tex(facts.contact.name))
      .replace('__CONTACT__', renderContact(facts.contact))
      .replace('__SUMMARY__', renderSummary(facts, job, sel))
      .replace('__EXPERIENCE__', renderExperience(sel.roles))
      .replace('__PROJECTS__', renderProjects(sel.projects))
      .replace('__SKILLS__', renderSkills(sel.skills))
      .replace('__EDUCATION__', renderEducation(sel.education));

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
    result = runGates(pdfPath, sel, facts.contact, chosen);

    const onlyTooLong = result.failures.every((f) => f.includes('pages, expected 1'));

    // One page but thin: add content back rather than shipping a sparse page.
    // Only grows while there is unused material, and the shrink ladder still
    // catches it if a growth step tips over into two pages.
    if (result.failures.length === 0 && result.fill !== null && result.fill < MIN_FILL && grew < 4) {
      const before = `${bullets}/${projectCap}/${roleCap}`;
      // Ceilings above the defaults on purpose. The ladder starts at the
      // default and only shrinks, so growth capped at the same values could
      // never fire. Bounded by the material that actually exists.
      const maxRoles = (facts.roles || []).length;
      const maxProjects = (facts.projects || []).filter((x) => x.verified === true).length;
      if (roleCap < maxRoles) roleCap += 1;
      else if (projectCap < maxProjects) projectCap += 1;
      else if (bullets < 24) bullets += 2;
      else break; // nothing left to add
      grew += 1;
      log(`  page only ${(result.fill * 100).toFixed(0)}% full — growing ${before} -> ${bullets}/${projectCap}/${roleCap}`);
      sel = selectContent(facts, `${job.title} ${job.description}`, bullets, projectCap, roleCap);
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
    sel = selectContent(facts, `${job.title} ${job.description}`, bullets, projectCap, roleCap);
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
      `${result.fill !== null ? `, ${(result.fill * 100).toFixed(0)}% page fill` : ''}`);
  if (haveDocx) log(`  also wrote ${path.basename(docxPath)} (editable, for portals that reject PDFs)`);
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
