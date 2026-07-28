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
const { execFileSync } = require('child_process');
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

  return skillHits * 3 + Math.min(textHits, 8) * 0.25 + hasMetric;
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
  for (const f of usable) {
    if (!byRole.has(f.role_id)) byRole.set(f.role_id, []);
    byRole.get(f.role_id).push({ fact: f, score: scoreFact(f, jdTokens) });
  }
  for (const list of byRole.values()) list.sort((a, b) => b.score - a.score);

  const roleScores = roles.map((r) => {
    const list = byRole.get(r.id) || [];
    const top = list.slice(0, MAX_BULLETS_PER_ROLE);
    return {
      role: r,
      bullets: top,
      score: top.reduce((n, x) => n + x.score, 0),
      isCurrent: r.end === 'present',
    };
  });

  const current = roleScores.filter((r) => r.isCurrent);
  const rest = roleScores.filter((r) => !r.isCurrent).sort((a, b) => b.score - a.score);
  const chosenRoles = [...current, ...rest].slice(0, roleLimit);

  // Preserve reverse-chronological order for the reader; selection is by
  // relevance, presentation is by date.
  chosenRoles.sort((a, b) => String(b.role.start).localeCompare(String(a.role.start)));

  // Trim to a total bullet budget so one page stays achievable.
  let budget = totalBullets;
  for (const r of chosenRoles) {
    r.bullets = r.bullets.slice(0, Math.max(1, Math.min(r.bullets.length, budget)));
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
  if (l.linkedin) links.push(`\\href{${l.linkedin}}{${tex(l.linkedin.replace(/^https?:\/\/(www\.)?/, ''))}}`);
  if (l.github) links.push(`\\href{${l.github}}{${tex(l.github.replace(/^https?:\/\/(www\.)?/, ''))}}`);
  if (l.website) links.push(`\\href{${l.website}}{${tex(l.website.replace(/^https?:\/\/(www\.)?/, ''))}}`);
  return [...bits, ...links].join(' \\textbar{} ');
}

function renderExperience(roles) {
  if (!roles.length) return '';
  const out = ['\\resumesection{Experience}'];
  for (const r of roles) {
    const dates = `${tex(r.role.start)} -- ${tex(r.role.end === 'present' ? 'Present' : r.role.end)}`;
    out.push(`\\resumerole{${tex(r.role.title)}}{${tex(r.role.company)}}{${dates}}{${tex(r.role.location || '')}}`);
    out.push('\\begin{resumebullets}');
    for (const b of r.bullets) out.push(`  \\item ${tex(b.fact.text)}`);
    out.push('\\end{resumebullets}');
  }
  return out.join('\n');
}

function renderProjects(projects) {
  if (!projects.length) return '';
  const out = ['\\resumesection{Projects}', '\\begin{resumebullets}'];
  for (const p of projects) {
    const ctx = p.project.context ? ` (${tex(p.project.context)})` : '';
    out.push(`  \\item {\\bfseries ${tex(p.project.name)}}${ctx} --- ${tex(p.project.text)}`);
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
    const gpa = e.gpa ? ` (GPA ${tex(e.gpa)})` : '';
    out.push(
      `{\\bfseries ${tex(e.credential)}} \\textbar{} ${tex(e.institution)}${gpa} ` +
      `\\hfill ${tex(e.start)} -- ${tex(e.end)}\\\\[1pt]`
    );
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
  const shown = selection.roles.length;
  return (
    `\\resumesection{Summary}\n` +
    `${tex(top.title)} at ${tex(top.company)}, applying for ${tex(job.title || 'this role')} ` +
    `at ${tex(job.company)}. ${shown} role${shown === 1 ? '' : 's'} across full-stack, mobile, and AI engineering.`
  );
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
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

  return { failures, pages: pages ? Number(pages) : null, chars: txt.length };
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
    if (result.failures.length === 0) break;
    if (!onlyTooLong) {
      throw new Error(`ATS gates failed (PDF rejected):\n  - ${result.failures.join('\n  - ')}`);
    }

    // Shrink in order of least value lost: a project, then bullets, then the
    // oldest role entirely.
    if (projectCap > 1) projectCap -= 1;
    else if (bullets > MIN_TOTAL_BULLETS) bullets -= 2;
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

  log(`✓ ${pdfPath}`);
  log(`  gates passed: ${result.pages} page, ${result.chars} chars extracted, ` +
      `${finalFacts.length} fact(s) verified present, ${sel.projects.length} project(s)`);
}

main()
  .catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
