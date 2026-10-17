// Run: node --test skills/publish/test/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { detect } from '../scripts/detect.mjs';
import { pack } from '../scripts/pack.mjs';
import { scan } from '../scripts/scan.mjs';
import { upload } from '../scripts/upload.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A project folder from { path: content } (objects become JSON). */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'soll-plugin-test-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (dependencies, scripts = { build: 'build' }) => ({ name: 'app', scripts, dependencies });

describe('detect', () => {
  const cases = [
    ['Vite + React with a router is an SPA', { 'package.json': pkg({ vite: '5', react: '18', 'react-router-dom': '6' }) }, { framework: 'vite-react', supported: true, output_dir: 'dist', spa_fallback: true }],
    ['Vite outDir is read from the config', { 'package.json': pkg({ vite: '5', vue: '3' }), 'vite.config.ts': "export default { build: { outDir: 'public_html' } }" }, { framework: 'vite-vue', output_dir: 'public_html', spa_fallback: false }],
    ['Astro is static by default', { 'package.json': pkg({ astro: '4' }), 'astro.config.mjs': 'export default {}' }, { framework: 'astro', supported: true, output_dir: 'dist' }],
    ['Astro with the Node adapter is refused', { 'package.json': pkg({ astro: '4', '@astrojs/node': '8' }), 'astro.config.mjs': "export default { output: 'server' }" }, { framework: 'astro', supported: false }],
    ['Next.js static export goes to out/', { 'package.json': pkg({ next: '14', react: '18' }), 'next.config.mjs': "export default { output: 'export' }", 'app/page.tsx': 'export default () => null' }, { framework: 'nextjs', supported: true, output_dir: 'out' }],
    ['Next.js without export is SSR and refused', { 'package.json': pkg({ next: '14', react: '18' }), 'next.config.mjs': 'export default {}' }, { framework: 'nextjs', supported: false }],
    ['Next.js export with API routes is refused', { 'package.json': pkg({ next: '14' }), 'next.config.js': "module.exports = { output: 'export' }", 'app/api/hello/route.ts': 'export const GET = () => {}' }, { framework: 'nextjs', supported: false }],
    ['Next.js export with Server Actions is refused', { 'package.json': pkg({ next: '14' }), 'next.config.js': "module.exports = { output: 'export' }", 'app/actions.ts': "'use server'\nexport async function save() {}" }, { framework: 'nextjs', supported: false }],
    ['Nuxt generate is static', { 'package.json': pkg({ nuxt: '3' }, { generate: 'nuxt generate', build: 'nuxt build' }), 'nuxt.config.ts': 'export default {}' }, { framework: 'nuxt', supported: true, output_dir: '.output/public', build_command: 'npm run generate' }],
    ['Nuxt build only is refused', { 'package.json': pkg({ nuxt: '3' }, { build: 'nuxt build' }), 'nuxt.config.ts': 'export default {}' }, { framework: 'nuxt', supported: false }],
    ['SvelteKit with adapter-static', { 'package.json': pkg({ '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3' }), 'svelte.config.js': "import adapter from '@sveltejs/adapter-static'; export default { kit: { adapter: adapter({ fallback: '200.html' }) } }" }, { framework: 'sveltekit', supported: true, output_dir: 'build', spa_fallback: true }],
    ['SvelteKit with adapter-node is refused', { 'package.json': pkg({ '@sveltejs/kit': '2', '@sveltejs/adapter-node': '5' }), 'svelte.config.js': "import adapter from '@sveltejs/adapter-node'" }, { framework: 'sveltekit', supported: false }],
    ['An Express app is refused', { 'package.json': pkg({ express: '4' }, { start: 'node server.js' }), 'server.js': 'require("express")().listen(3000)' }, { framework: 'node-server', supported: false }],
    ['A Flask app is refused', { 'requirements.txt': 'flask==3.0\n', 'app.py': 'from flask import Flask' }, { framework: 'python', supported: false }],
    ['Plain HTML is published as is', { 'index.html': '<h1>Hi</h1>' }, { framework: 'static-html', supported: true, output_dir: '.' }],
    ['A PHP site is published as is', { 'index.php': '<?php echo 1;', 'composer.json': '{}' }, { framework: 'php', supported: true, kind: 'php', output_dir: '.' }],
    ['Laravel is refused (web root public/)', { artisan: '#!/usr/bin/env php', 'composer.json': '{}', 'public/index.php': '<?php' }, { framework: 'php-framework', supported: false }],
    ['pnpm is detected from the lock file', { 'package.json': pkg({ vite: '5' }), 'pnpm-lock.yaml': '' }, { package_manager: 'pnpm', build_command: 'pnpm run build' }],
    ['Nothing to publish', { 'README.md': '# hi' }, { supported: false }],
  ];
  for (const [title, files, expected] of cases) {
    it(title, () => {
      const result = detect(project(files));
      for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${key}: ${JSON.stringify(result)}`);
      if (!result.supported) assert.ok(result.reason.length > 10, 'a refusal explains why');
    });
  }
});

describe('scan', () => {
  it('passes a clean build and warns about source maps', () => {
    const report = scan(project({ 'index.html': '<h1>ok</h1>', 'assets/app.js': 'const k="pk_live_abcdefghijklmnopqrstuvwx";', 'assets/app.js.map': '{}' }));
    assert.equal(report.ok, true);
    assert.equal(report.files, 3);
    assert.ok(report.warnings.some((w) => w.code === 'SOURCE_MAPS'));
  });
  it('blocks a live Stripe secret key with file and line', () => {
    const report = scan(project({ 'index.html': 'ok', 'assets/app.js': `const a = 1;\nconst key = "sk_live_${'a'.repeat(24)}";` }));
    assert.equal(report.ok, false);
    assert.deepEqual(report.blocked.map((b) => [b.code, b.file, b.line]), [['STRIPE_SECRET_KEY', 'assets/app.js', 2]]);
  });
  it('blocks .env, .git, private keys and a Supabase service_role key, but not the anon key', () => {
    const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url')}.c2lnbmF0dXJlX2hlcmU`;
    const report = scan(project({
      'index.html': 'ok', '.env': 'X=1', '.env.example': 'X=', '.git/config': '[core]', 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc',
      'a.js': `createClient(u, "${jwt('service_role')}")`, 'b.js': `createClient(u, "${jwt('anon')}")`,
    }));
    assert.deepEqual(report.blocked.map((b) => b.code).sort(), ['ENV_FILE', 'GIT_FOLDER', 'PRIVATE_KEY', 'SUPABASE_SERVICE_ROLE']);
  });
  it('reports a missing folder and a folder without index', () => {
    assert.equal(scan('/nonexistent/folder').blocked[0].code, 'NO_OUTPUT');
    assert.ok(scan(project({ 'about.html': 'x' })).warnings.some((w) => w.code === 'NO_INDEX'));
  });
});

/** name -> content of a tar.gz written by pack (ustar + GNU long names). */
function untar(archive) {
  const data = gunzipSync(readFileSync(archive));
  const files = {};
  let long = null;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const type = String.fromCharCode(header[156]);
    const content = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + size + ((512 - (size % 512)) % 512);
    if (type === 'L') {
      long = content.toString('utf8').replace(/\0$/, '');
      continue;
    }
    assert.equal(type, '0', 'only regular files');
    files[long ?? header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')] = content.toString('utf8');
    long = null;
  }
  return files;
}

describe('pack', () => {
  it('packs regular files with long names, skips links and .git, and reports size and sha256', async () => {
    const longName = `assets/${'x'.repeat(130)}.js`;
    const root = project({ 'index.html': '<h1>Hi</h1>', [longName]: 'long', '.git/HEAD': 'ref', 'sub/a.css': 'body{}' });
    symlinkSync('/etc/passwd', join(root, 'link'));
    const result = await pack(root);
    roots.push(dirname(result.archive));
    assert.equal(result.files, 3);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(untar(result.archive), { 'index.html': '<h1>Hi</h1>', [longName]: 'long', 'sub/a.css': 'body{}' });
  });
  it('produces an archive GNU tar reads', async (t) => {
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' });
    } catch {
      t.skip('no tar binary');
      return;
    }
    const result = await pack(project({ 'index.html': 'x', [`d/${'y'.repeat(120)}.txt`]: 'y' }));
    roots.push(dirname(result.archive));
    const listing = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listing, [`d/${'y'.repeat(120)}.txt`, 'index.html']);
  });
});

describe('upload', () => {
  it('refuses a non-https upload address without sending anything', async () => {
    const root = project({ 'site.tar.gz': 'x' });
    const result = await upload(join(root, 'site.tar.gz'), 'http://example.org/upload', { attempts: 1 });
    assert.deepEqual([result.ok, result.code], [false, 'NETWORK_ERROR']);
    assert.match(result.message, /https/);
  });
});
