#!/usr/bin/env node
// Checks a build output folder before it is published: the same rules the soll.net API applies to every archive, so
// a problem is found here, with the file and line, instead of after the upload.
// Usage: node scan.mjs <outputDir>  ->  JSON {ok, blocked[], warnings[], files, bytes}; exit code 2 when blocked.

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIMITS = { maxFiles: 50000, maxBytes: 2 * 1024 * 1024 * 1024, maxArchiveBytes: 500 * 1024 * 1024, maxPath: 240, scanBytes: 2 * 1024 * 1024 };
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SSH_KEYS = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);

function jwtRole(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

/** Secrets in a text, with the line they are on. */
export function findSecrets(text) {
  const found = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.exec(text);
  if (privateKey) found.push({ code: 'PRIVATE_KEY', line: lineOf(privateKey.index), message: 'A private key. Never publish it; keep it on the server side.' });
  const stripe = /\b[sr]k_live_[0-9A-Za-z]{16,}/.exec(text);
  if (stripe) found.push({ code: 'STRIPE_SECRET_KEY', line: lineOf(stripe.index), message: 'A live Stripe secret key. Only the publishable key (pk_live_...) belongs in a website; rotate this key in the Stripe dashboard.' });
  for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
    if (jwtRole(match[0]) === 'service_role') {
      found.push({ code: 'SUPABASE_SERVICE_ROLE', line: lineOf(match.index), message: 'A Supabase service_role key, which bypasses all security rules. Use the anon key in the browser and rotate this one in Supabase.' });
      break;
    }
  }
  return found;
}

export function scan(outputDir) {
  const blocked = [];
  const warnings = [];
  let files = 0;
  let bytes = 0;
  const warnOnce = new Set();
  const warn = (code, message, file) => {
    if (warnOnce.has(code + file)) return;
    warnOnce.add(code + file);
    warnings.push({ code, message, ...(file ? { file } : {}) });
  };
  let root;
  try {
    root = statSync(outputDir);
  } catch {
    return { ok: false, blocked: [{ code: 'NO_OUTPUT', message: `The folder ${outputDir} does not exist. Build the project first.` }], warnings, files, bytes };
  }
  if (!root.isDirectory()) {
    return { ok: false, blocked: [{ code: 'NO_OUTPUT', message: `${outputDir} is not a folder.` }], warnings, files, bytes };
  }

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(outputDir, path).split(sep).join('/');
      if (entry.name === '.soll' && dir === outputDir) continue;
      if (entry.name === '.git') {
        blocked.push({ code: 'GIT_FOLDER', file: rel, message: 'A .git folder holds the whole history, often with secrets. Publish the build output only.' });
        continue;
      }
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        warn('SYMLINK_SKIPPED', 'Links are not published; the file it points to is missing on the website.', rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') warn('NODE_MODULES', 'The folder contains node_modules; a built website usually does not need it.', rel);
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      files++;
      bytes += stat.size;
      if (rel.length > LIMITS.maxPath) blocked.push({ code: 'PATH_TOO_LONG', file: rel, message: `The path is longer than ${LIMITS.maxPath} characters.` });
      const name = entry.name.toLowerCase();
      if (/^\.env(\..+)?$/.test(name) && !ENV_TEMPLATES.has(name)) {
        blocked.push({ code: 'ENV_FILE', file: rel, message: 'An environment file (.env) usually holds secrets. Remove it from the output folder.' });
        continue;
      }
      if (SSH_KEYS.has(name)) {
        blocked.push({ code: 'PRIVATE_KEY', file: rel, message: 'A private SSH key.' });
        continue;
      }
      if (name.endsWith('.map')) warn('SOURCE_MAPS', 'Source maps (.map) publish the readable source code. Fine for open projects; otherwise disable them in the build.', rel);
      if (stat.size <= LIMITS.scanBytes) {
        const text = readFileSync(path, 'latin1');
        for (const secret of findSecrets(text)) blocked.push({ ...secret, file: rel });
        if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) warn('POSSIBLE_SECRET', 'Looks like an AWS access key id; make sure no AWS secret is in the website.', rel);
      }
    }
  };
  walk(outputDir);
  if (files === 0) blocked.push({ code: 'EMPTY', message: 'The output folder is empty.' });
  if (files > LIMITS.maxFiles) blocked.push({ code: 'TOO_MANY_FILES', message: `More than ${LIMITS.maxFiles} files.` });
  if (bytes > LIMITS.maxBytes) blocked.push({ code: 'TOO_LARGE', message: 'More than 2 GB of files.' });
  const entries = readdirSync(outputDir).map((name) => name.toLowerCase());
  if (!entries.includes('index.html') && !entries.includes('index.php') && !entries.includes('index.htm')) {
    warn('NO_INDEX', 'There is no index.html or index.php at the top of the folder; the address would show an error page. Is this the right output folder?');
  }
  return { ok: blocked.length === 0, blocked, warnings, files, bytes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv[2]) {
    process.stderr.write('Usage: node scan.mjs <outputDir>\n');
    process.exit(1);
  }
  const report = scan(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 2);
}
