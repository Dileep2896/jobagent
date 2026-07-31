#!/usr/bin/env node
'use strict';

/**
 * cover-letter.js — one grounded cover letter per job.
 *
 * Usage:
 *   node cover-letter.js --job-id N            build one, write PDF + text
 *   node cover-letter.js --pipeline [--limit N] build for every ready_for_review
 *                                               job that has none yet
 *   node cover-letter.js --job-id N --dry-run   print it, write nothing
 *
 * Unlike generate.js this DOES make a model call — a cover letter is prose, and
 * prose is the one thing selection cannot do. The never-invent rule still holds
 * and is enforced mechanically in lib/answer-writer.js: the letter may name only
 * what appears in master-facts.json or in the job description, and any
 * employment-shaped claim about a company that is not a real employer rejects
 * the whole letter. A rejected letter is not retried with softer rules; the job
 * simply goes out without one, which is what would have happened anyway.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const { writeCoverLetter } = require('./lib/answer-writer');

const FACTS_PATH = process.env.FACTS_PATH || path.join(__dirname, 'master-facts.json');
const OUT_DIR = process.env.BUILD_DIR || path.join(__dirname, 'build');

const pool = new Pool({
  host: process.env.PGHOST || '/var/run/postgresql',
  database: process.env.PGDATABASE || 'jobagent',
});

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

const TEX_ESCAPES = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$',
  '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

function tex(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/[\\&%$#_{}~^]/g, (c) => TEX_ESCAPES[c])
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '--')
    .replace(/…/g, '...')
    .replace(/ - /g, ' -- ');
}

/**
 * Charter, same 10pt body and margins as the resume, so the two documents look
 * like they came from the same person — which they did.
 */
function renderTex(facts, job, body) {
  const c = facts.contact || {};
  const contactLine = [c.email, c.phone, c.location, c.linkedin, c.github]
    .filter(Boolean)
    .map(tex)
    .join(' $\\cdot$ ');

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => tex(p.trim()))
    .filter(Boolean)
    .join('\n\n');

  return `\\documentclass[10pt,letterpaper]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{charter}
\\usepackage[left=0.9in,right=0.9in,top=0.85in,bottom=0.85in]{geometry}
\\usepackage[hidelinks]{hyperref}
\\usepackage{parskip}
\\pagestyle{empty}
\\input{glyphtounicode}
\\pdfgentounicode=1

\\begin{document}

{\\Large\\bfseries ${tex(c.name || '')}}\\\\[2pt]
{\\small ${contactLine}}

\\vspace{1.2em}
${tex(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}

\\vspace{0.8em}
Hiring Team\\\\
${tex(job.company)}

\\vspace{1.2em}
Dear Hiring Team,

\\vspace{0.6em}
${paragraphs}

\\vspace{1.2em}
Sincerely,\\\\
${tex(c.name || '')}

\\end{document}
`;
}

function compile(texPath, outDir) {
  execFileSync(
    'pdflatex',
    ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', outDir, texPath],
    { stdio: 'pipe' }
  );
}

/**
 * Round trip: the PDF must extract back to the text we wrote. Same principle as
 * the resume gates — a document that looks right and extracts wrong is a
 * document an ATS will read wrong.
 */
function verifyExtraction(pdfPath, body) {
  const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' })
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const probes = body
    .split(/[.!?]\s+/)
    .map((s) => s.trim().split(/\s+/).slice(0, 6).join(' ').toLowerCase())
    .filter((s) => s.split(' ').length >= 4);
  const missing = probes.filter((p) => !txt.includes(p.replace(/\s+/g, ' ')));
  const pages = (execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).match(/^Pages:\s*(\d+)/m) || [])[1];
  return { missing, pages: Number(pages) };
}

async function buildFor(job, facts, { dryRun }) {
  const res = await writeCoverLetter({ job, facts });
  if (!res) return { skipped: 'model returned nothing' };
  if (res.rejected) return { skipped: res.rejected };

  const words = res.body.split(/\s+/).length;
  if (dryRun) {
    console.log(`\n--- ${job.company} — ${job.title} (${words} words) ---\n${res.body}\n`);
    return { dryRun: true, words };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = `${(facts.contact?.name || 'candidate').replace(/[^A-Za-z0-9]+/g, '_')}_` +
    `${`${job.company}_${job.title}`.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 70)}_${job.id}_cover`;
  const texPath = path.join(OUT_DIR, `${base}.tex`);
  const pdfPath = path.join(OUT_DIR, `${base}.pdf`);

  fs.writeFileSync(texPath, renderTex(facts, job, res.body));
  compile(texPath, OUT_DIR);

  const check = verifyExtraction(pdfPath, res.body);
  if (check.missing.length) {
    return { skipped: `PDF did not extract cleanly (${check.missing.length} passage(s) lost)` };
  }
  if (check.pages !== 1) return { skipped: `cover letter ran to ${check.pages} pages` };

  for (const ext of ['.aux', '.log', '.out']) {
    fs.rmSync(path.join(OUT_DIR, base + ext), { force: true });
  }
  fs.rmSync(texPath, { force: true });

  await pool.query(
    'UPDATE jobs SET cover_letter_path = $1, cover_letter_text = $2 WHERE id = $3',
    [pdfPath, res.body, job.id]
  );
  return { pdfPath, words, factIds: res.factIds };
}

async function loadJobs(args) {
  const idFlag = args.indexOf('--job-id');
  if (idFlag >= 0) {
    const { rows } = await pool.query(
      `SELECT j.id, j.title, j.location, j.description, c.name AS company
         FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = $1`,
      [Number(args[idFlag + 1])]
    );
    return rows;
  }
  const limFlag = args.indexOf('--limit');
  const limit = limFlag >= 0 ? Number(args[limFlag + 1]) : 25;
  const { rows } = await pool.query(
    `SELECT j.id, j.title, j.location, j.description, c.name AS company
       FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE j.status = 'ready_for_review' AND j.cover_letter_path IS NULL
      ORDER BY j.filter_score DESC NULLS LAST, j.id
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const facts = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  const jobs = await loadJobs(args);
  if (!jobs.length) { log('no jobs need a cover letter'); return; }

  let built = 0, skipped = 0;
  for (const job of jobs) {
    try {
      const r = await buildFor(job, facts, { dryRun });
      if (r.skipped) { skipped += 1; log(`job ${job.id} — NO cover letter: ${r.skipped}`); }
      else { built += 1; log(`job ${job.id} — ${r.dryRun ? 'drafted' : path.basename(r.pdfPath)} (${r.words} words)`); }
    } catch (err) {
      skipped += 1;
      log(`job ${job.id} — failed: ${err.message}`);
    }
  }
  log(`cover letters: ${built} built, ${skipped} skipped`);
}

main()
  .catch((err) => { console.error('fatal:', err); process.exitCode = 1; })
  .finally(() => pool.end());
