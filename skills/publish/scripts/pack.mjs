#!/usr/bin/env node
// Packs a build output folder into a tar.gz (regular files only, the folder's contents at the top) and reports the
// size and SHA-256 that hosting_deployments_create needs. Written in plain Node.js, so it works without a tar binary.
// Usage: node pack.mjs <outputDir> [archivePath]  ->  JSON {archive, bytes, sha256, files}.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

const SKIP = new Set(['.git', '.DS_Store', 'Thumbs.db', '.soll']);

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

/** The regular files below dir, relative paths with "/". */
export function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, name: relative(dir, path).split(sep).join('/'), size: stat.size });
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

export async function pack(outputDir, archivePath) {
  const files = listFiles(outputDir);
  if (files.length === 0) throw new Error('The output folder is empty.');
  const target = archivePath ?? join(mkdtempSync(join(tmpdir(), 'soll-publish-')), 'site.tar.gz');
  await pipeline(Readable.from(tarChunks(files)), createGzip({ level: 6 }), createWriteStream(target));
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(target)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { archive: target, bytes, sha256: hash.digest('hex'), files: files.length, format: 'tar.gz' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv[2]) {
    process.stderr.write('Usage: node pack.mjs <outputDir> [archivePath]\n');
    process.exit(1);
  }
  pack(process.argv[2], process.argv[3]).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
      process.exit(1);
    },
  );
}
