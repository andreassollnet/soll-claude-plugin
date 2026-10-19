#!/usr/bin/env node
// Packs a build output folder into a tar.gz (regular files only, the folder's contents at the top) and reports the
// size and SHA-256 that hosting_deployments_create needs. Written in plain Node.js, so it works without a tar binary.
// Leaves out what never belongs on a web server (rules.mjs: version control, editor and tool folders, .env files, dumps,
// logs) and refuses paths the server would refuse.
// Usage: node pack.mjs <outputDir> [archivePath] [--max-bytes N]
//   ->  JSON {archive, url_file, bytes, sha256, files, excluded_count, format}; exit 1 with {error, code} on failure.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { exclusionReason, isMain, LIMITS, pathProblem } from './rules.mjs';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function header(name, size, type = '0') {
  const block = Buffer.alloc(512, 0);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const padding = (size) => Buffer.alloc((512 - (size % 512)) % 512, 0);

/** The regular files below dir, relative paths with "/", without links and excluded entries. */
export function listFiles(dir, excluded = []) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      const name = relative(dir, path).split(sep).join('/');
      if (exclusionReason(entry.name, stat.isDirectory())) {
        excluded.push(stat.isDirectory() ? `${name}/` : name);
        continue;
      }
      const problem = pathProblem(name);
      if (problem) throw fail(problem.code, `${name}: ${problem.message}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, name, size: stat.size });
    }
  };
  walk(dir);
  return files;
}

/** Yields the tar stream: GNU long names for paths over 99 bytes, two zero blocks at the end. */
async function* tarChunks(files) {
  for (const file of files) {
    const nameBytes = Buffer.byteLength(file.name, 'utf8');
    if (nameBytes > 99) {
      const long = Buffer.from(`${file.name}\0`, 'utf8');
      yield header('././@LongLink', long.length, 'L');
      yield long;
      yield padding(long.length);
    }
    yield header(file.name, file.size);
    let written = 0;
    for await (const chunk of createReadStream(file.path)) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== file.size) throw new Error(`${file.name} changed while packing`);
    yield padding(file.size);
  }
  yield Buffer.alloc(1024, 0);
}

/**
 * Packs outputDir. maxBytes: the server's archive limit (hosting_get deployments.max_archive_bytes); a larger archive
 * is deleted and refused with ARCHIVE_TOO_LARGE.
 */
export async function pack(outputDir, archivePath, { maxBytes = LIMITS.maxArchiveBytes } = {}) {
  const excluded = [];
  const files = listFiles(outputDir, excluded);
  if (files.length === 0) throw fail('EMPTY', 'The output folder is empty.');
  const tempDir = archivePath ? null : mkdtempSync(join(tmpdir(), 'soll-publish-'));
  const target = archivePath ?? join(tempDir, 'site.tar.gz');
  const discard = () => rmSync(tempDir ?? target, { recursive: true, force: true });
  try {
    await pipeline(Readable.from(tarChunks(files)), createGzip({ level: 6 }), createWriteStream(target));
  } catch (error) {
    discard();
    throw error;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(target)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes > maxBytes) {
    discard();
    throw fail('ARCHIVE_TOO_LARGE', `The archive has ${(bytes / 1048576).toFixed(1)} MB; the hosting accepts at most ${(maxBytes / 1048576).toFixed(0)} MB.`, { bytes, max_bytes: maxBytes });
  }
  return {
    archive: target, url_file: join(dirname(target), 'upload-url'), bytes, sha256: hash.digest('hex'), files: files.length,
    excluded_count: excluded.length, format: 'tar.gz',
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const maxIndex = args.indexOf('--max-bytes');
  const maxBytes = maxIndex >= 0 ? Number(args.splice(maxIndex, 2)[1]) : LIMITS.maxArchiveBytes;
  if (!args[0] || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    process.stderr.write('Usage: node pack.mjs <outputDir> [archivePath] [--max-bytes N]\n');
    process.exit(1);
  }
  pack(args[0], args[1], { maxBytes }).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      const { code = 'PACK_FAILED', bytes, max_bytes: max } = error;
      process.stdout.write(`${JSON.stringify({ error: error.message, code, ...(bytes ? { bytes, max_bytes: max } : {}) })}\n`);
      process.exit(1);
    },
  );
}
