#!/usr/bin/env node
'use strict';

/**
 * Uploads resume PDFs to Google Drive so anything the submit stage cannot
 * complete can still be applied to by hand.
 *
 * This deliberately does NOT use the claude.ai Drive connector: that is scoped
 * to an interactive chat session, and this pipeline runs unattended from cron.
 * It authenticates as a Google service account instead, using only the
 * drive.file scope — which grants access to files this pipeline itself creates,
 * not to the rest of the Drive.
 *
 * Setup (one time):
 *   1. Google Cloud Console > new project > enable the Google Drive API.
 *   2. IAM & Admin > Service Accounts > create one > Keys > add JSON key.
 *   3. Save the JSON on this box, e.g. ~/.config/jobagent/gdrive.json (chmod 600).
 *   4. Share the Drive folder with the service account's client_email, as Editor.
 *   5. export GOOGLE_APPLICATION_CREDENTIALS=~/.config/jobagent/gdrive.json
 *      export GDRIVE_FOLDER_ID=<the folder id>
 *
 * Usage:  node drive-upload.js <file.pdf> [--name "Custom Name.pdf"]
 *         node drive-upload.js --check          (verify credentials only)
 */

const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

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
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set — point it at the service account JSON key.'
    );
  }
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('failed to obtain an access token from the service account');
  return token;
}

/**
 * Drive has no unique-name constraint: uploading the same resume twice creates
 * two files with the same name. Since the pipeline must be safe to re-run, look
 * for an existing copy and update it in place instead.
 */
async function findExisting(token, name) {
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

  const res = await request(url, { headers: { authorization: `Bearer ${token}` } });
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
          `\n  A 404 here usually means the folder was never shared with the service account.` +
          `\n  Share folder ${FOLDER_ID} with the client_email in your key file, as Editor.`;
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
  const token = await getToken();

  const existingId = await findExisting(token, name);
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
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  const file = await res.json();
  return { ...file, replaced: Boolean(existingId) };
}

async function check() {
  const token = await getToken();
  const creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  log(`✓ authenticated as ${creds.client_email}`);
  if (!FOLDER_ID) {
    log('! GDRIVE_FOLDER_ID is not set — uploads would land loose in the service account drive');
    return;
  }
  const res = await request(
    `https://www.googleapis.com/drive/v3/files/${FOLDER_ID}?fields=id,name`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const folder = await res.json();
  log(`✓ folder reachable: "${folder.name}" (${folder.id})`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) return check();

  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node drive-upload.js <file.pdf> [--name "Custom Name.pdf"]');
    console.error('       node drive-upload.js --check');
    process.exitCode = 1;
    return;
  }
  const nameFlag = args.indexOf('--name');
  const result = await uploadFile(file, nameFlag >= 0 ? args[nameFlag + 1] : null);
  log(`${result.replaced ? 'replaced' : 'uploaded'}: ${result.name}`);
  log(`  ${result.webViewLink}`);
}

if (require.main === module) {
  main().catch((e) => {
    log('fatal:', e.message);
    process.exitCode = 1;
  });
}

module.exports = { uploadFile, getToken };
