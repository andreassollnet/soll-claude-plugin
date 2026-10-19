// Rules shared by scan.mjs and pack.mjs: what never goes onto the web server, path rules mirroring the soll.net
// ArchiveInspector, limits, and the main-module check. No dependencies: Node.js 18+ standard library only.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same values as the backend's defaults (HOSTING_DEPLOY_*). hosting_get reports the real max_archive_bytes. */
export const LIMITS = {
  maxFiles: 50000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveBytes: 500 * 1024 * 1024,
  maxPathBytes: 240,
  maxSegmentBytes: 255,
  scanBytes: 2 * 1024 * 1024,
};

/**
 * Folders that belong to version control, editors, tools or dependencies, never to a website. Matched case-insensitively
 * at any depth (the server refuses ".git" in any case, also inside vendor/ packages installed from source).
 */
const EXCLUDED_DIRS = new Map([
  ['.git', 'version control (git)'],
  ['.hg', 'version control (Mercurial)'],
  ['.svn', 'version control (Subversion)'],
  ['.bzr', 'version control (Bazaar)'],
  ['.claude', 'Claude Code settings'],
  ['.cursor', 'editor settings'],
  ['.vscode', 'editor settings'],
  ['.idea', 'editor settings'],
  ['.soll', 'soll.net publish settings'],
  ['node_modules', 'dependencies (node_modules); copy files the pages load from it into the site folder'],
]);

/** Single files that are local, tool or dependency configuration. */
const EXCLUDED_FILES = new Map([
  ['.ds_store', 'system file'],
  ['thumbs.db', 'system file'],
  ['desktop.ini', 'system file'],
  ['.npmrc', 'npm configuration (may hold a registry token)'],
  ['.yarnrc', 'yarn configuration'],
  ['.yarnrc.yml', 'yarn configuration (may hold a registry token)'],
  ['.gitignore', 'git configuration'],
  ['.gitattributes', 'git configuration'],
  ['.gitmodules', 'git configuration'],
  ['.git', 'git worktree link'],
]);

/**
 * File types that are data or leftovers and must not be readable on a website: database dumps and files, backups, logs,
 * editor swap files. A site's live data does not belong in a release folder either: each deployment replaces it.
 */
const EXCLUDED_PATTERNS = [
  [/\.sql(\.gz|\.bz2|\.zip)?$/, 'database dump'],
  [/\.(sqlite|sqlite3|db|db3)$/, 'database file (live data is replaced by every deployment; keep it outside the site folder)'],
  [/\.(bak|old|orig|swp|swo)$|~$/, 'backup or editor file'],
  [/\.log$/, 'log file'],
];

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
export const isEnvFile = (name) => /^\.env(\..+)?$/i.test(name);
export const isEnvTemplate = (name) => ENV_TEMPLATES.has(name.toLowerCase());

/**
 * Why an entry is left out of the archive, or null when it is published. .env files are always left out (the server
 * refuses them); scan.mjs still blocks one that holds values, because the site may depend on it.
 */
export function exclusionReason(name, isDirectory) {
  const lower = name.toLowerCase();
  if (isDirectory) return EXCLUDED_DIRS.get(lower) ?? null;
  if (EXCLUDED_FILES.has(lower)) return EXCLUDED_FILES.get(lower);
  if (isEnvFile(lower)) return isEnvTemplate(lower) ? 'environment template' : 'environment file';
  for (const [pattern, reason] of EXCLUDED_PATTERNS) if (pattern.test(lower)) return reason;
  return null;
}

/**
 * The problem of a relative path ("a/b.html") that the server's ArchiveInspector would refuse, or null: control
 * characters, backslashes, names that are not valid UTF-8, a segment over 255 bytes or a path over 240 bytes.
 */
export function pathProblem(rel) {
  if (/[\x00-\x1f\x7f]/.test(rel)) return { code: 'PATH_INVALID', message: 'The name contains control characters.' };
  if (rel.includes('\\')) return { code: 'PATH_INVALID', message: 'Backslashes are not allowed in file names.' };
  if (rel.includes('�')) return { code: 'PATH_INVALID', message: 'The name is not valid UTF-8.' };
  if (rel.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > LIMITS.maxSegmentBytes)) {
    return { code: 'PATH_TOO_LONG', message: `A file or folder name is longer than ${LIMITS.maxSegmentBytes} bytes.` };
  }
  if (Buffer.byteLength(rel, 'utf8') > LIMITS.maxPathBytes) {
    return { code: 'PATH_TOO_LONG', message: `The path is longer than ${LIMITS.maxPathBytes} bytes (UTF-8).` };
  }
  return null;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Why a folder must not be published as a whole, or null: the home folder or the root of a drive, or, with a project
 * folder, a folder outside it (output_dir from a repository's config could point anywhere).
 */
export function outputDirProblem(outputDir, projectDir = null) {
  const dir = real(resolve(projectDir ?? '.', outputDir));
  if (dir === real(homedir())) return 'The output folder is your home folder; publish the website folder only.';
  if (dir === parse(dir).root) return 'The output folder is the root of the drive; publish the website folder only.';
  if (projectDir !== null) {
    const rel = relative(real(resolve(projectDir)), dir);
    if (rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\') || isAbsolute(rel)) {
      return `The output folder ${outputDir} lies outside the project folder; only folders inside the project are published.`;
    }
  }
  return null;
}

/** True when the module with this import.meta.url is the script node started, also through a symlinked path. */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  return real(process.argv[1]) === real(fileURLToPath(importMetaUrl));
}
