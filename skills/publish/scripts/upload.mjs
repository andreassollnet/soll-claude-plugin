#!/usr/bin/env node
// Uploads a packed archive to the signed upload_url of a soll.net deployment (HTTP PUT, no token needed). Shows
// progress on stderr and retries only network errors before the server answered. Never prints the URL.
// Usage: node upload.mjs <archivePath> <uploadUrl>  ->  JSON {ok, status, code?, message?}; exit 0 on success.

import { createReadStream, statSync } from 'node:fs';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';

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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
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

export async function upload(archive, url, { attempts = 3, onProgress = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await putOnce(archive, url, onProgress);
    } catch (error) {
      // Only errors before any answer are retried; the URL accepts one archive, so an answered request is final.
      if (error.fatal || attempt >= attempts) {
        return { ok: false, status: 0, code: 'NETWORK_ERROR', message: error.message };
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    let data = {};
    try {
      data = JSON.parse(response.body);
    } catch { /* not JSON */ }
    if (response.status === 202) {
      return { ok: true, status: 202, deployment_id: data?.data?.id ?? null };
    }
    const code = data.code ?? (response.status === 403 ? 'UPLOAD_URL_INVALID' : response.status === 413 ? 'TOO_LARGE' : 'UPLOAD_FAILED');
    const message = data.message ?? (response.status === 403
      ? 'The upload address is invalid or has expired. Start a new deployment.'
      : response.status === 413 ? 'The archive is larger than the server accepts.' : `The server answered ${response.status}.`);
    return { ok: false, status: response.status, code, message };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [archive, url] = process.argv.slice(2);
  if (!archive || !url) {
    process.stderr.write('Usage: node upload.mjs <archivePath> <uploadUrl>\n');
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
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
