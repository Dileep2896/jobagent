#!/usr/bin/env node
'use strict';

/**
 * Uploads resume PDFs to Google Drive so anything the submit stage cannot
 * complete can still be applied to by hand.
 *
 * This deliberately does NOT use the claude.ai Drive connector: that is scoped
 * to an interactive chat session, and this pipeline runs unattended from cron.
 *
 * It authenticates AS YOU, via Application Default Credentials, using only the
 * drive.file scope — which grants access to files this pipeline itself creates,
 * not to the rest of the Drive. A service-account key is NOT usable here and is
 * actively ignored (see getToken): an upload CREATES a file, and a service
 * account has no storage quota on a personal Google account and cannot own a
 * file outside a Workspace Shared Drive. sheets-sync.js is the opposite case —
 * it only edits a sheet that already exists, so the service account is right
 * there and wrong here.
 *
 * Setup (one time):
 *   1. Google Cloud Console > enable the Google Drive API on the project.
 *   2. ./gcloud-login.sh — runs `gcloud auth application-default login` with
 *      the openid, cloud-platform and drive.file scopes.
 *   3. node drive-upload.js --init — creates the destination folder. It must be
 *      created BY THIS APP: drive.file is a per-application grant, so a folder
 *      made through any other client is invisible here even though you own it.
 *   4. export GDRIVE_FOLDER_ID=<the id --init prints>
 *
 * Usage:  node drive-upload.js <file.pdf> [--name "Custom Name.pdf"] [--job-id N]
 *         node drive-upload.js --init           (create the folder, print its id)
 *         node drive-upload.js --check          (verify credentials only)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleAuth } = require('google-auth-library');
const { Pool } = require('pg');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '';
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 120000; // PDFs are small, but this box is on wifi

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (n) => Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** n));

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.tex': 'text/x-tex',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

async function getToken() {
  // GoogleAuth would prefer a service-account key if GOOGLE_APPLICATION_
  // CREDENTIALS is set, and for Drive uploads that key is exactly wrong — an
  // upload CREATES a file, and a service account has no storage quota on a
  // personal Google account. So the key is dropped here deliberately, leaving
  // Application Default Credentials from `gcloud auth application-default
  // login`, which authenticate AS YOU and make you the file's owner.
  //
  // The variable is set for a real reason, just not this one: sheets-sync.js
  // only edits a sheet that already exists, creates nothing, and so does need
  // the service account. Both scripts read the same .env with opposite
  // requirements, so this one drops the key in its own process rather than
  // asking you to keep the variable unset.
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const auth = new GoogleAuth({ scopes: SCOPES });
  try {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('no access token returned');

    // ADC requires a quota project for Drive, sent as x-goog-user-project.
    // The auth library adds this itself when IT makes the request — but we
    // hand-roll fetch with just the bearer token, so it has to be added here
    // or every call 403s with "requires a quota project".
    let quotaProject = process.env.GOOGLE_CLOUD_PROJECT || client.quotaProjectId || null;
    if (!quotaProject) {
      const adc = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
      if (fs.existsSync(adc)) {
        try { quotaProject = JSON.parse(fs.readFileSync(adc, 'utf8')).quota_project_id || null; } catch {}
      }
    }
    return { token, quotaProject };
  } catch (e) {
    throw new Error(
      `could not obtain Google credentials: ${e.message}\n` +
      `  Drive uploads must authenticate as you (a service account has no storage quota):\n` +
      `    gcloud auth application-default login --no-launch-browser \\\n` +
      `      --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.file`
    );
  }
}


/**
 * Drive has no unique-name constraint: uploading the same resume twice creates
 * two files with the same name. Since the pipeline must be safe to re-run, look
 * for an existing copy and update it in place instead.
 */
function authHeaders(auth) {
  const h = { authorization: `Bearer ${auth.token}` };
  if (auth.quotaProject) h['x-goog-user-project'] = auth.quotaProject;
  return h;
}

async function findExisting(auth, name) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    FOLDER_ID ? `'${FOLDER_ID}' in parents` : null,
    'trashed = false',
  ]
    .filter(Boolean)
    .join(' and ');

  const url =
    'https://www.googleapis.com/drive/v3/files' +
    `?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;

  const res = await request(url, { headers: authHeaders(auth) });
  const body = await res.json();
  return body.files && body.files[0] ? body.files[0].id : null;
}

/** fetch with retry/backoff; 4xx other than 429 is permanent. */
async function request(url, options) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res;

      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`Drive returned ${res.status}`);

      const err = new Error(`Drive rejected the request (${res.status}): ${text.slice(0, 300)}`);
      err.permanent = true;
      // The overwhelmingly common cause — worth naming rather than making the
      // user decode a raw 404 from the API.
      if (res.status === 404 && FOLDER_ID) {
        err.message +=
          `\n  The drive.file scope only grants access to files THIS app created —` +
          `\n  a folder made by another app (or by hand in the Drive UI) is invisible` +
          `\n  to it even though you own it.` +
          `\n  Create one this app owns:  node drive-upload.js --init`;
      }
      throw err;
    } catch (e) {
      if (e.permanent) throw e;
      lastErr = e;
      if (attempt === MAX_RETRIES) break;
      const delay = backoffMs(attempt);
      log(`  ${e.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new Error(`upload failed after ${MAX_RETRIES} retries: ${lastErr && lastErr.message}`);
}

/** Multipart upload: one request carrying both metadata and bytes. */
async function uploadFile(filePath, displayName) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);

  const name = displayName || path.basename(abs);
  const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const bytes = fs.readFileSync(abs);
  const auth = await getToken();

  const existingId = await findExisting(auth, name);
  const metadata = existingId
    ? { name } // parents cannot be changed via the update endpoint
    : { name, ...(FOLDER_ID ? { parents: [FOLDER_ID] } : {}) };

  const boundary = `jobagent-${Buffer.from(name).toString('hex').slice(0, 16)}-boundary`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const url =
    `https://www.googleapis.com/upload/drive/v3/files${existingId ? `/${existingId}` : ''}` +
    `?uploadType=multipart&fields=id,name,webViewLink`;

  const res = await request(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { ...authHeaders(auth), 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });

  const file = await res.json();
  return { ...file, replaced: Boolean(existingId) };
}

/**
 * Create a Drive folder this application can actually address.
 *
 * drive.file is a per-APP grant, not a per-user one: it can only touch files
 * it created itself. A folder created through a different app is invisible
 * here, so the pipeline makes its own. The folder is still owned by you and
 * appears normally in your Drive.
 */
async function initFolder() {
  const auth = await getToken();
  const name = process.env.GDRIVE_FOLDER_NAME || 'Job Applications (jobagent)';

  const res = await request('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { ...authHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const folder = await res.json();
  log(`created folder "${folder.name}"`);
  log(`  id:   ${folder.id}`);
  log(`  link: https://drive.google.com/drive/folders/${folder.id}`);
  log('');
  log('Put this in .env (replacing any existing GDRIVE_FOLDER_ID):');
  log(`  export GDRIVE_FOLDER_ID='${folder.id}'`);
  return folder;
}

async function check() {
  const auth = await getToken();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const who = keyFile && fs.existsSync(keyFile)
    ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).client_email
    : 'your Google account (application default credentials)';
  log(`✓ authenticated as ${who}`);
  if (!FOLDER_ID) {
    log('! GDRIVE_FOLDER_ID is not set — uploads would land loose in the service account drive');
    return;
  }
  const res = await request(
    `https://www.googleapis.com/drive/v3/files/${FOLDER_ID}?fields=id,name`,
    { headers: authHeaders(auth) }
  );
  const folder = await res.json();
  log(`✓ folder reachable: "${folder.name}" (${folder.id})`);
}

/** Record the Drive link on the job so the review digest can link straight to it. */
async function recordOnJob(jobId, file, localPath) {
  const pool = new Pool({
    host: process.env.PGHOST || '/var/run/postgresql',
    database: process.env.PGDATABASE || 'jobagent',
  });
  try {
    const { rowCount } = await pool.query(
      `UPDATE jobs
          SET resume_path = $1,
              resume_drive_url = $2,
              resume_drive_file_id = $3,
              resume_built_at = now(),
              updated_at = now()
        WHERE id = $4`,
      [localPath, file.webViewLink || null, file.id, jobId]
    );
    if (rowCount === 0) throw new Error(`no job with id ${jobId}`);
    log(`  recorded on job ${jobId}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--init')) return initFolder();
  if (args.includes('--check')) return check();

  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node drive-upload.js <file.pdf> [--name "Name.pdf"] [--job-id N]');
    console.error('       node drive-upload.js --check');
    process.exitCode = 1;
    return;
  }
  const nameFlag = args.indexOf('--name');
  const jobFlag = args.indexOf('--job-id');
  const jobId = jobFlag >= 0 ? Number(args[jobFlag + 1]) : null;
  if (jobFlag >= 0 && !Number.isInteger(jobId)) throw new Error('--job-id requires an integer');

  const result = await uploadFile(file, nameFlag >= 0 ? args[nameFlag + 1] : null);
  log(`${result.replaced ? 'replaced' : 'uploaded'}: ${result.name}`);
  log(`  ${result.webViewLink}`);
  if (jobId) await recordOnJob(jobId, result, path.resolve(file));
}

if (require.main === module) {
  main().catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  });
}

module.exports = { uploadFile, getToken };
