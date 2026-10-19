#!/usr/bin/env node
// Uploads a packed archive to the signed upload_url of a soll.net deployment (HTTP PUT, no token needed). Shows
// progress on stderr. Never takes the URL as an argument (it would show in the process list and the command) and never
// prints it: the URL comes from a file (deleted right after reading), from stdin, or from SOLL_UPLOAD_URL.
// Usage: node upload.mjs <archivePath> [--url-file <file>] [--keep]
//   URL source, first found: --url-file <file>; "upload-url" next to the archive (pack.mjs reports it as url_file);
//   SOLL_UPLOAD_URL; stdin (when not a terminal).
//   ->  JSON {ok, status, code?, message?, retry_after?, note?, archive_deleted}; exit 0 on success.
// After a successful upload the archive (and pack's temporary folder) is deleted unless --keep is given.
// Proxies: no HTTPS_PROXY support of its own; Node.js 24 honours it with NODE_USE_ENV_PROXY=1.

import { createReadStream, existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { isMain } from './rules.mjs';

function putOnce(archive, url, onProgress) {
  return new Promise((resolve, reject) => {
    const size = statSync(archive).size;
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(Object.assign(new Error('The upload address must use https.'), { fatal: true }));
      return;
    }
    const req = request(target, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size }, timeout: 120000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, retryAfter: res.headers['retry-after'] ?? null }));
    });
    req.on('timeout', () => req.destroy(new Error('The connection timed out.')));
    req.on('error', reject);
    let sent = 0;
    const stream = createReadStream(archive);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress(sent, size);
    });
    stream.on('error', (error) => req.destroy(error));
    stream.pipe(req);
  });
}

const retryAfterSeconds = (value) => {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value ?? '');
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

/**
 * PUTs the archive. Network errors are retried (the upload address takes one archive, but a size or hash mismatch or
 * a cut connection leaves it waiting). Because a retry may follow a request whose answer was lost:
 * - UPLOAD_ALREADY_RECEIVED on a retry means the earlier attempt arrived: success (with a note);
 * - UPLOAD_IN_PROGRESS means an earlier attempt is still being received: wait and ask again;
 * - 429 RATE_LIMITED waits for Retry-After (up to a minute) and tries again.
 * transport and wait are replaceable for tests.
 */
export async function upload(archive, url, { attempts = 3, onProgress = () => {}, transport = putOnce, wait = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 2000, inProgressWaits = 6 } = {}) {
  let networkFailures = 0;
  let busyWaits = 0;
  let rateWaits = 0;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await transport(archive, url, onProgress);
    } catch (error) {
      networkFailures++;
      if (error.fatal || networkFailures >= attempts) {
        return { ok: false, status: 0, code: 'NETWORK_ERROR', message: error.message, ...(attempt > 1 ? { note: 'An earlier attempt may have reached the server: check hosting_deployments_get before reporting a failure.' } : {}) };
      }
      await wait(retryDelayMs * networkFailures);
      continue;
    }
    let data = {};
    try {
      data = JSON.parse(response.body) ?? {};
    } catch { /* not JSON */ }
    if (response.status === 202) {
      return { ok: true, status: 202, deployment_id: data?.data?.id ?? null };
    }
    const code = data.code ?? (response.status === 403 ? 'UPLOAD_URL_INVALID' : response.status === 413 ? 'TOO_LARGE' : response.status === 429 ? 'RATE_LIMITED' : 'UPLOAD_FAILED');
    if (code === 'UPLOAD_ALREADY_RECEIVED' && attempt > 1) {
      return { ok: true, status: response.status, code, note: 'An earlier attempt reached the server although its answer was lost. Poll hosting_deployments_get as usual.' };
    }
    if (code === 'UPLOAD_IN_PROGRESS') {
      if (busyWaits < inProgressWaits) {
        busyWaits++;
        await wait(10000);
        continue;
      }
      return { ok: false, status: response.status, code, message: 'The server is still receiving an earlier attempt.', note: 'Poll hosting_deployments_get: it moves to queued when that upload arrived.' };
    }
    if (code === 'RATE_LIMITED') {
      const retryAfter = retryAfterSeconds(response.retryAfter) ?? 60;
      if (rateWaits < 2 && retryAfter <= 60) {
        rateWaits++;
        await wait(retryAfter * 1000);
        continue;
      }
      return { ok: false, status: response.status, code, retry_after: retryAfter, message: `Too many upload attempts; try again in ${retryAfter} seconds.` };
    }
    const message = data.message ?? (response.status === 403
      ? 'The upload address is invalid or has expired. Start a new deployment.'
      : response.status === 413 ? 'The archive is larger than the server accepts.' : `The server answered ${response.status}.`);
    return { ok: false, status: response.status, code, message };
  }
}

/** The upload URL from --url-file, the file next to the archive, SOLL_UPLOAD_URL or stdin; a URL file is deleted. */
export function readUploadUrl(archive, urlFile, { env = process.env, stdin = () => (process.stdin.isTTY ? '' : readFileSync(0, 'utf8')) } = {}) {
  const file = urlFile ?? join(dirname(archive), 'upload-url');
  if (urlFile || existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    rmSync(file, { force: true });
    return text.trim();
  }
  if (env.SOLL_UPLOAD_URL) return env.SOLL_UPLOAD_URL.trim();
  return stdin().trim();
}

/** Deletes the archive and, when it is pack.mjs's own temporary folder and now empty, that folder. */
export function removeArchive(archive) {
  rmSync(archive, { force: true });
  const dir = dirname(archive);
  if (basename(dir).startsWith('soll-publish-')) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch { /* leave it */ }
  }
}

if (isMain(import.meta.url)) {
  const positional = [];
  let keep = false;
  let urlFile = null;
  let usage = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--keep') keep = true;
    else if (arg === '--url-file') {
      urlFile = process.argv[++i] ?? null;
      usage ||= !urlFile;
    } else positional.push(arg);
  }
  const [archive, extra] = positional;
  if (!archive || usage) {
    process.stderr.write('Usage: node upload.mjs <archivePath> [--url-file <file>] [--keep]  (URL from the file, SOLL_UPLOAD_URL or stdin)\n');
    process.exit(1);
  }
  if (extra) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 0, code: 'USAGE', message: 'Do not pass the upload address as an argument; write it to the url_file that pack.mjs reported.' })}\n`);
    process.exit(1);
  }
  let url;
  try {
    url = readUploadUrl(archive, urlFile);
  } catch {
    url = '';
  }
  if (!url) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 0, code: 'NO_UPLOAD_URL', message: 'No upload address: write upload_url to the url_file that pack.mjs reported (or use --url-file, SOLL_UPLOAD_URL or stdin).' })}\n`);
    process.exit(1);
  }
  let last = -1;
  const result = await upload(archive, url, {
    onProgress: (sent, size) => {
      const percent = Math.floor((sent * 100) / size);
      if (percent >= last + 10 || percent === 100) {
        last = percent;
        process.stderr.write(`upload ${percent}% (${(sent / 1048576).toFixed(1)} of ${(size / 1048576).toFixed(1)} MB)\n`);
      }
    },
  });
  let deleted = false;
  if (result.ok && !keep) {
    removeArchive(archive);
    deleted = true;
  }
  process.stdout.write(`${JSON.stringify({ ...result, archive_deleted: deleted, ...(deleted ? {} : { archive }) })}\n`);
  process.exit(result.ok ? 0 : 1);
}
