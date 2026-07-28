#!/usr/bin/env node
'use strict';

/**
 * Deterministic validator for master-facts.json.
 *
 * This is the gate behind CLAUDE.md's hardest rule: every resume bullet must
 * map to an id in master-facts.json, so that file has to be structurally sound
 * before anything downstream is allowed to read it. No model involved — these
 * are mechanical checks that either pass or fail.
 *
 * Usage:  node validate-facts.js [path]        (default: master-facts.json)
 * Exit:   0 = valid, 1 = invalid or missing
 */

const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || 'master-facts.json';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BULLET_CHARS = 240; // longer bullets wrap badly and read as padding

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function checkDateRange(label, obj) {
  if (!MONTH.test(obj.start || '')) {
    err(`${label}: start must be YYYY-MM, got ${JSON.stringify(obj.start)}`);
  }
  const end = obj.end;
  if (end !== 'present' && !MONTH.test(end || '')) {
    err(`${label}: end must be YYYY-MM or "present", got ${JSON.stringify(end)}`);
  }
  if (MONTH.test(obj.start || '') && MONTH.test(end || '') && end < obj.start) {
    err(`${label}: end ${end} precedes start ${obj.start}`);
  }
}

function main() {
  const abs = path.resolve(FILE);

  if (!fs.existsSync(abs)) {
    console.error(`✗ ${FILE} not found.`);
    console.error(`  Start from the template:  cp master-facts.example.json ${FILE}`);
    console.error(`  Then replace every EXAMPLE value with your real history.`);
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`✗ ${FILE} is not valid JSON: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // --- contact -----------------------------------------------------------
  // ATS parsers need name/email/location in the document body; if they are
  // missing here they cannot appear in the PDF either.
  const contact = data.contact || {};
  for (const f of ['name', 'email', 'location']) {
    if (!isNonEmptyString(contact[f])) err(`contact.${f} is required`);
  }
  if (isNonEmptyString(contact.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) {
    err(`contact.email is not a valid address: ${contact.email}`);
  }

  // --- roles / education -------------------------------------------------
  const roleIds = new Set();
  const roles = Array.isArray(data.roles) ? data.roles : [];
  if (roles.length === 0) err('roles must contain at least one entry');

  roles.forEach((r, i) => {
    const label = `roles[${i}]`;
    if (!isNonEmptyString(r.id)) return err(`${label}.id is required`);
    if (roleIds.has(r.id)) err(`${label}: duplicate role id '${r.id}'`);
    roleIds.add(r.id);
    for (const f of ['company', 'title']) {
      if (!isNonEmptyString(r[f])) err(`${label} (${r.id}).${f} is required`);
    }
    checkDateRange(`${label} (${r.id})`, r);
  });

  (Array.isArray(data.education) ? data.education : []).forEach((e, i) => {
    const label = `education[${i}]`;
    if (!isNonEmptyString(e.institution)) err(`${label}.institution is required`);
    if (!isNonEmptyString(e.credential)) err(`${label}.credential is required`);
    checkDateRange(label, e);
  });

  // --- facts -------------------------------------------------------------
  // The referential integrity check is the important one: a fact pointing at a
  // role that does not exist would render a bullet under no employer.
  const factIds = new Set();
  const facts = Array.isArray(data.facts) ? data.facts : [];
  if (facts.length === 0) err('facts must contain at least one entry — resumes are built only from these');

  const usedRoles = new Set();
  facts.forEach((f, i) => {
    const label = `facts[${i}]`;
    if (!isNonEmptyString(f.id)) return err(`${label}.id is required`);
    if (factIds.has(f.id)) err(`${label}: duplicate fact id '${f.id}'`);
    factIds.add(f.id);

    if (!isNonEmptyString(f.text)) err(`${label} (${f.id}).text is required`);
    else if (f.text.length > MAX_BULLET_CHARS) {
      warn(`${label} (${f.id}): ${f.text.length} chars — over ${MAX_BULLET_CHARS}, will wrap badly`);
    }

    if (!isNonEmptyString(f.role_id)) {
      err(`${label} (${f.id}).role_id is required`);
    } else if (!roleIds.has(f.role_id)) {
      err(`${label} (${f.id}): role_id '${f.role_id}' does not match any role`);
    } else {
      usedRoles.add(f.role_id);
    }

    if (!Array.isArray(f.skills) || f.skills.length === 0) {
      warn(`${label} (${f.id}): no skills listed — weakens JD keyword-coverage scoring`);
    }
    // `verified: true` is the human attesting the claim is true. Anything not
    // explicitly verified must not reach a real application.
    if (f.verified !== true) {
      warn(`${label} (${f.id}): not marked verified:true — will be excluded from generation`);
    }
  });

  for (const id of roleIds) {
    if (!usedRoles.has(id)) warn(`role '${id}' has no facts — it will render with no bullets`);
  }

  // --- screening answers -------------------------------------------------
  const screening = data.screening_answers || {};
  const unanswered = Object.entries(screening)
    .filter(([k, v]) => !k.startsWith('_') && !isNonEmptyString(v))
    .map(([k]) => k);
  if (unanswered.length > 0) {
    warn(
      `screening_answers unanswered (${unanswered.join(', ')}) — ` +
        `the submit stage will pause on these rather than guess`
    );
  }

  // --- template check ----------------------------------------------------
  const raw = JSON.stringify(data);
  if (raw.includes('EXAMPLE') || raw.includes('example.com')) {
    err('placeholder content still present (EXAMPLE / example.com) — this is the template, not your history');
  }

  // --- report ------------------------------------------------------------
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const e of errors) console.error(`  ✗ ${e}`);

  if (errors.length > 0) {
    console.error(`\n✗ ${FILE}: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exitCode = 1;
    return;
  }

  const usable = facts.filter((f) => f.verified === true).length;
  console.log(
    `\n✓ ${FILE}: ${facts.length} fact(s) (${usable} verified and usable), ` +
      `${roles.length} role(s), ${warnings.length} warning(s)`
  );
}

main();
