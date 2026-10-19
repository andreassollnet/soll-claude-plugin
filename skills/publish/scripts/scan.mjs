#!/usr/bin/env node
// Checks a build output folder before it is published: the same rules the soll.net API applies to every archive (and a
// few more secret patterns), so a problem is found here, with the file and line, instead of after the upload.
// Usage: node scan.mjs <outputDir> [--project <projectDir>]
//   ->  JSON {ok, blocked[], warnings[], excluded[], excluded_count, files, bytes}; exit code 2 when blocked.
// excluded lists what pack.mjs leaves out (version control, editor and tool folders, dumps, logs, .env files): info only.

import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { exclusionReason, isEnvFile, isEnvTemplate, isMain, LIMITS, outputDirProblem, pathProblem } from './rules.mjs';

export { LIMITS };

const SSH_KEYS = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const MAX_EXCLUDED_LISTED = 50;

function jwtRole(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
}

const PLACEHOLDER_PASSWORDS = /^(pass(word)?|pwd|secret|changeme|change_me|xxx+|\*+|\.\.\.|<[^>]*>|\$\{[^}]*\}|%s|\{[^}]*\}|your[-_]?password|example)$/i;

/**
 * Secret patterns. level "block": a provider secret that must never be public (the first three are refused by the
 * soll.net server as well). level "warn": often meant to be public or ambiguous; the user decides.
 * Each test gets the text and returns the matches' indexes.
 */
const PATTERNS = [
  { code: 'PRIVATE_KEY', level: 'block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, message: 'A private key. Never publish it; keep it on the server side.' },
  { code: 'STRIPE_SECRET_KEY', level: 'block', re: /\b[sr]k_live_[0-9A-Za-z]{16,}/g, message: 'A live Stripe secret key. Only the publishable key (pk_live_...) belongs in a website; rotate this key in the Stripe dashboard.' },
  { code: 'ANTHROPIC_API_KEY', level: 'block', re: /\bsk-ant-[A-Za-z0-9_-]{32,}/g, message: 'An Anthropic API key. Call the API from a server, never from the browser; rotate the key in the Claude Console.' },
  { code: 'OPENAI_API_KEY', level: 'block', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g, message: 'An OpenAI API key. Call the API from a server, never from the browser; rotate the key in the OpenAI dashboard.' },
  { code: 'GITHUB_TOKEN', level: 'block', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/g, message: 'A GitHub token. Remove it and revoke it in GitHub (Settings > Developer settings).' },
  { code: 'NPM_TOKEN', level: 'block', re: /\/\/[^\s'"]+:_authToken=(?!\$\{)[^\s'"]{8,}|\bnpm_[A-Za-z0-9]{36}\b/g, message: 'An npm registry token. Remove it and revoke it at npmjs.com.' },
  { code: 'SLACK_TOKEN', level: 'block', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g, message: 'A Slack token or webhook URL. Remove it and revoke it in Slack.' },
  { code: 'AWS_SECRET_KEY', level: 'block', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi, message: 'An AWS secret access key. Remove it and deactivate the key in AWS IAM.' },
  { code: 'POSSIBLE_OPENAI_STYLE_KEY', level: 'warn', re: /\bsk-[A-Za-z0-9]{32,}\b/g, message: 'Looks like an API secret key (sk-...). If it is one, call that API from a server and rotate the key.' },
  { code: 'GOOGLE_API_KEY', level: 'warn', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, message: 'A Google API key. Fine in a website only when it is restricted to your domain (HTTP referrer) and to the APIs the site needs; check this in the Google Cloud console.' },
  { code: 'POSSIBLE_SECRET', level: 'warn', re: /\bAKIA[0-9A-Z]{16}\b/g, message: 'Looks like an AWS access key id; make sure no AWS secret is in the website.' },
];

const DATABASE_URL = /\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:/@'"`]+):([^\s@'"`]+)@([^\s/'"`:?]+)/g;

/**
 * Secrets in a text, with the line they are on. serverSide: the file is PHP, which the server runs instead of serving;
 * provider keys there are downgraded to warnings (the rules the server mirrors still block).
 * @returns {{code: string, level: 'block'|'warn', line: number, message: string}[]}
 */
export function findSecrets(text, { serverSide = false } = {}) {
  const found = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const blockedAt = new Set();
  const add = (code, level, index, message) => {
    if (found.some((f) => f.code === code)) return;
    found.push({ code, level, line: lineOf(index), message });
  };
  for (const { code, level, re, message } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (code === 'POSSIBLE_OPENAI_STYLE_KEY' && blockedAt.has(match.index)) continue;
      const mirrored = code === 'PRIVATE_KEY' || code === 'STRIPE_SECRET_KEY';
      const effective = level === 'block' && serverSide && !mirrored ? 'warn' : level;
      if (level === 'block') blockedAt.add(match.index);
      add(code, effective, match.index, serverSide && effective !== level ? `${message} (In a PHP file it stays on the server, but a key in the web folder is one mistake away from public: better keep it in a config file outside the site folder.)` : message);
      break;
    }
  }
  for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
    if (jwtRole(match[0]) === 'service_role') {
      add('SUPABASE_SERVICE_ROLE', 'block', match.index, 'A Supabase service_role key, which bypasses all security rules. Use the anon key in the browser and rotate this one in Supabase.');
      break;
    }
  }
  // AWS secret access key (40 characters of base64) near an access key id.
  const akia = /\bAKIA[0-9A-Z]{16}\b/.exec(text);
  if (akia && !found.some((f) => f.code === 'AWS_SECRET_KEY')) {
    const near = text.slice(Math.max(0, akia.index - 300), akia.index + 320);
    if (/(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/.test(near.replace(akia[0], ''))) {
      add('POSSIBLE_AWS_SECRET', 'warn', akia.index, 'An AWS access key id with what looks like its secret key next to it. If it is one, remove both and deactivate the key in AWS IAM.');
    }
  }
  if (!serverSide) {
    for (const match of text.matchAll(DATABASE_URL)) {
      const [, user, password, host] = match;
      if (PLACEHOLDER_PASSWORDS.test(password) || PLACEHOLDER_PASSWORDS.test(user) || /^(\$|<|\{)/.test(password)) continue;
      add('DATABASE_URL', 'warn', match.index, `A database address with a password (${host}). A browser must never get database passwords: remove it and change the password if the database is reachable from the internet.`);
      break;
    }
  }
  return found;
}

/** True when a .env file sets at least one variable to a value. */
function envHasValues(text) {
  return text.split(/\r?\n/).some((line) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*["']?[^\s"'#]/.test(line));
}

export function scan(outputDir, { projectDir = null } = {}) {
  const blocked = [];
  const warnings = [];
  const excluded = [];
  let excludedCount = 0;
  let files = 0;
  let bytes = 0;
  let referencesNodeModules = null;
  const warnOnce = new Set();
  const warn = (code, message, file) => {
    if (warnOnce.has(`${code}|${file}`)) return;
    warnOnce.add(`${code}|${file}`);
    warnings.push({ code, message, ...(file ? { file } : {}) });
  };
  const exclude = (file, reason) => {
    excludedCount++;
    if (excluded.length < MAX_EXCLUDED_LISTED) excluded.push({ file, reason });
  };
  const report = () => ({ ok: blocked.length === 0, blocked, warnings, excluded, excluded_count: excludedCount, files, bytes });
  let root;
  try {
    root = statSync(outputDir);
  } catch {
    blocked.push({ code: 'NO_OUTPUT', message: `The folder ${outputDir} does not exist. Build the project first.` });
    return report();
  }
  if (!root.isDirectory()) {
    blocked.push({ code: 'NO_OUTPUT', message: `${outputDir} is not a folder.` });
    return report();
  }
  const unsafe = outputDirProblem(outputDir, projectDir);
  if (unsafe) {
    blocked.push({ code: 'OUTPUT_DIR_UNSAFE', message: unsafe });
    return report();
  }

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(outputDir, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        warn('SYMLINK_SKIPPED', 'Links are not published; the file it points to is missing on the website.', rel);
        continue;
      }
      const reason = exclusionReason(entry.name, stat.isDirectory());
      const name = entry.name.toLowerCase();
      if (stat.isFile() && isEnvFile(name) && !isEnvTemplate(name)) {
        let text = '';
        try {
          text = readFileSync(path, 'utf8');
        } catch { /* unreadable: treat as holding values */ text = 'X=1'; }
        if (envHasValues(text)) {
          blocked.push({ code: 'ENV_FILE', file: rel, message: 'An environment file (.env) with values, usually secrets. It is never uploaded; if the site needs these values, keep them in a config file outside the published folder, then remove the .env from it.' });
          continue;
        }
      }
      if (reason) {
        exclude(stat.isDirectory() ? `${rel}/` : rel, reason);
        continue;
      }
      const problem = pathProblem(rel);
      if (problem) {
        blocked.push({ ...problem, file: rel });
        if (stat.isDirectory()) continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      files++;
      bytes += stat.size;
      if (SSH_KEYS.has(name)) {
        blocked.push({ code: 'PRIVATE_KEY', file: rel, message: 'A private SSH key.' });
        continue;
      }
      if (name.endsWith('.map')) warn('SOURCE_MAPS', 'Source maps (.map) publish the readable source code. Fine for open projects; otherwise disable them in the build.', rel);
      if (stat.size <= LIMITS.scanBytes) {
        const text = readFileSync(path, 'latin1');
        for (const secret of findSecrets(text, { serverSide: name.endsWith('.php') })) {
          const { level, ...rest } = secret;
          if (level === 'block') blocked.push({ ...rest, file: rel });
          else warn(rest.code, rest.message, rel);
        }
        if (referencesNodeModules === null && /\.(html?|php)$/.test(name) && /["'(]\.?\/?node_modules\//.test(text)) referencesNodeModules = rel;
      }
    }
  };
  walk(outputDir);
  if (referencesNodeModules && excluded.some((e) => /(^|\/)node_modules\/$/.test(e.file))) {
    warn('NODE_MODULES_REFERENCED', 'A page loads files from node_modules/, which is not published. Copy those files into the site folder (e.g. assets/) and change the links.', referencesNodeModules);
  }
  if (files === 0) blocked.push({ code: 'EMPTY', message: 'The output folder is empty.' });
  if (files > LIMITS.maxFiles) blocked.push({ code: 'TOO_MANY_FILES', message: `More than ${LIMITS.maxFiles} files.` });
  if (bytes > LIMITS.maxBytes) blocked.push({ code: 'TOO_LARGE', message: 'More than 2 GB of files.' });
  const entries = readdirSync(outputDir).map((name) => name.toLowerCase());
  if (!entries.includes('index.html') && !entries.includes('index.php') && !entries.includes('index.htm')) {
    warn('NO_INDEX', 'There is no index.html or index.php at the top of the folder; the address would show an error page. Is this the right output folder?');
  }
  return report();
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  const projectDir = projectIndex >= 0 ? args.splice(projectIndex, 2)[1] ?? null : null;
  if (!args[0]) {
    process.stderr.write('Usage: node scan.mjs <outputDir> [--project <projectDir>]\n');
    process.exit(1);
  }
  const result = scan(resolve(args[0]), { projectDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 2);
}
