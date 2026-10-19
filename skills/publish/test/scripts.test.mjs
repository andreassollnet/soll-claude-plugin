// Run from the plugin folder: node --test skills/publish/test/scripts.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { detect } from '../scripts/detect.mjs';
import { pack } from '../scripts/pack.mjs';
import { pathProblem } from '../scripts/rules.mjs';
import { findSecrets, scan } from '../scripts/scan.mjs';
import { readUploadUrl, upload } from '../scripts/upload.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

/** Runs a script as the skill does; returns {status, stdout, stderr}. */
function runScript(script, args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script.startsWith('/') ? script : join(SCRIPTS, script), ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    if (error.status === undefined || error.status === null) throw error;
    return { status: error.status, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' };
  }
}

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
    ['Laravel with Vite is a PHP framework, not a Vite SPA', { artisan: '#!/usr/bin/env php', 'composer.json': '{}', 'package.json': pkg({ vite: '5', 'laravel-vite-plugin': '1' }), 'vite.config.js': 'export default {}' }, { framework: 'php-framework', supported: false }],
    ['Symfony from composer.json with Vite is refused', { 'composer.json': { require: { 'symfony/framework-bundle': '7.1' } }, 'package.json': pkg({ vite: '5' }) }, { framework: 'php-framework', supported: false }],
    ['TanStack Start is refused (SSR)', { 'package.json': pkg({ vite: '6', react: '19', '@tanstack/react-start': '1' }) }, { framework: 'tanstack-start', supported: false }],
    ['SolidStart is refused (SSR)', { 'package.json': pkg({ vite: '6', 'solid-js': '1', '@solidjs/start': '1' }) }, { framework: 'solidstart', supported: false }],
    ['Vike is refused (SSR)', { 'package.json': pkg({ vite: '6', vike: '0.4' }) }, { framework: 'vike', supported: false }],
    ['Analog is refused (SSR)', { 'package.json': pkg({ vite: '6', '@analogjs/platform': '1' }) }, { framework: 'analog', supported: false }],
    ['Qwik City is refused (SSR)', { 'package.json': pkg({ vite: '6', '@builder.io/qwik-city': '1' }) }, { framework: 'qwik-city', supported: false }],
    ['Parcel with a root index.html publishes dist/', { 'package.json': pkg({ parcel: '2' }, { build: 'parcel build index.html' }), 'index.html': '<script src="app.js"></script>' }, { framework: 'parcel', supported: true, output_dir: 'dist', build_command: 'npm run build' }],
    ['Eleventy publishes _site/', { 'package.json': pkg({ '@11ty/eleventy': '3' }, {}), 'index.html': 'x' }, { framework: 'eleventy', supported: true, output_dir: '_site', build_command: 'npx @11ty/eleventy' }],
    ['Eleventy output folder from the config', { 'package.json': pkg({ '@11ty/eleventy': '3' }), 'eleventy.config.js': 'export default { dir: { output: "public" } }' }, { output_dir: 'public' }],
    ['Jekyll publishes _site/', { Gemfile: 'gem "jekyll", "~> 4.3"', '_config.yml': 'title: x', 'index.html': '---\n---' }, { framework: 'jekyll', supported: true, output_dir: '_site', build_command: 'bundle exec jekyll build' }],
    ['An output folder outside the project is refused', { 'package.json': pkg({ vite: '5' }), 'vite.config.ts': "export default { build: { outDir: '../../../../srv' } }" }, { supported: false }],
    ['An absolute output folder outside the project is refused', { 'package.json': pkg({ astro: '4' }), 'astro.config.mjs': "export default { outDir: '/etc' }" }, { supported: false }],
    ['An output folder inside the project is fine', { 'package.json': pkg({ vite: '5' }), 'vite.config.ts': "export default { build: { outDir: './web/../public_html' } }" }, { supported: true, output_dir: './web/../public_html' }],
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
  it('blocks .env with values, private keys and a Supabase service_role key, but not the anon key', () => {
    const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url')}.c2lnbmF0dXJlX2hlcmU`;
    const report = scan(project({
      'index.html': 'ok', '.env': 'X=1', '.env.example': 'X=', '.git/config': '[core]', 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc',
      'a.js': `createClient(u, "${jwt('service_role')}")`, 'b.js': `createClient(u, "${jwt('anon')}")`,
    }));
    assert.deepEqual(report.blocked.map((b) => b.code).sort(), ['ENV_FILE', 'PRIVATE_KEY', 'SUPABASE_SERVICE_ROLE']);
  });
  it('publishes a PHP site inside a git repository and lists what it leaves out', () => {
    const report = scan(project({
      'index.php': '<?php echo 1;', '.htaccess': 'RewriteEngine On', '.well-known/security.txt': 'Contact: x', '.user.ini': 'memory_limit=256M',
      '.git/HEAD': 'ref', '.gitignore': 'x', '.vscode/settings.json': '{}', '.idea/x.xml': '', '.claude/settings.json': '{}', '.soll/deploy.json': '{}',
      'node_modules/a/index.js': '', 'dump.sql': 'INSERT', 'data/app.sqlite': '', 'error.log': '', 'config.php.bak': '', '.env.example': 'DB_PASS=',
      '.env.local': '# nothing set\nDB_PASS=\n', '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}', '.DS_Store': '',
      'vendor/pkg/.GIT/config': '[core]', 'vendor/pkg/src/A.php': '<?php',
    }));
    assert.equal(report.ok, true, JSON.stringify(report.blocked));
    assert.equal(report.files, 5);
    assert.deepEqual(report.excluded.map((e) => e.file).sort(), [
      '.DS_Store', '.claude/', '.env.example', '.env.local', '.git/', '.gitignore', '.idea/', '.npmrc', '.soll/', '.vscode/',
      'config.php.bak', 'data/app.sqlite', 'dump.sql', 'error.log', 'node_modules/', 'vendor/pkg/.GIT/',
    ]);
    assert.equal(report.excluded_count, 16);
    assert.ok(report.excluded.every((e) => e.reason.length > 3));
  });
  it('warns when a page loads files from the left-out node_modules', () => {
    const report = scan(project({ 'index.html': '<link href="node_modules/bootstrap/dist/css/bootstrap.min.css">', 'node_modules/bootstrap/dist/css/bootstrap.min.css': '' }));
    assert.ok(report.warnings.some((w) => w.code === 'NODE_MODULES_REFERENCED'));
  });
  it('checks path lengths in bytes and refuses backslashes and control characters', () => {
    const okName = `${'ä'.repeat(100)}/${'b'.repeat(30)}`; // 231 bytes
    const longName = `${'ä'.repeat(100)}/${'b'.repeat(45)}`; // 246 bytes, 146 characters
    const report = scan(project({ 'index.html': 'x', [okName]: 'x', [longName]: 'x', 'a\\b.html': 'x', 'c\u0001.html': 'x' }));
    assert.deepEqual(report.blocked.map((b) => b.code).sort(), ['PATH_INVALID', 'PATH_INVALID', 'PATH_TOO_LONG']);
    assert.ok(!report.blocked.some((b) => b.file === okName));
    // A name over 255 bytes cannot be created on most file systems; the rule itself:
    assert.equal(pathProblem(`${'é'.repeat(128)}.html`).code, 'PATH_TOO_LONG');
    assert.equal(pathProblem(`${'é'.repeat(100)}.html`), null);
  });
  it('refuses an output folder outside the project or the home folder', () => {
    const outside = project({ 'index.html': 'x' });
    const proj = project({ 'index.html': 'x' });
    assert.equal(scan(outside, { projectDir: proj }).blocked[0].code, 'OUTPUT_DIR_UNSAFE');
    assert.equal(scan(proj, { projectDir: proj }).ok, true);
    const run = runScript('scan.mjs', [proj], { env: { ...process.env, HOME: proj, USERPROFILE: proj } });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).blocked[0].code, 'OUTPUT_DIR_UNSAFE');
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

describe('secret patterns', () => {
  const r = (n, chars = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz') => Array.from({ length: n }, (_, i) => chars[(i * 7) % chars.length]).join('');
  const codes = (text, options) => findSecrets(text, options).map((f) => `${f.code}:${f.level}`);
  const cases = [
    ['Anthropic key', `const k = "sk-ant-api03-${r(93)}AA";`, ['ANTHROPIC_API_KEY:block']],
    ['OpenAI project key', `key: 'sk-proj-${r(40)}_${r(20)}'`, ['OPENAI_API_KEY:block']],
    ['OpenAI legacy key', `sk-${r(20)}T3BlbkFJ${r(20)}`, ['OPENAI_API_KEY:block']],
    ['other sk- key is a warning', `apiKey="sk-${r(32)}"`, ['POSSIBLE_OPENAI_STYLE_KEY:warn']],
    ['GitHub classic token', `ghp_${r(36)}`, ['GITHUB_TOKEN:block']],
    ['GitHub server token', `"ghs_${r(36)}"`, ['GITHUB_TOKEN:block']],
    ['GitHub fine-grained token', `github_pat_${r(22)}_${r(59)}`, ['GITHUB_TOKEN:block']],
    ['npm auth token', `//registry.npmjs.org/:_authToken=npm_${r(36)}`, ['NPM_TOKEN:block']],
    ['npm granular token alone', `token=npm_${r(36)}`, ['NPM_TOKEN:block']],
    ['Slack bot token', `xoxb-123456789012-1234567890123-${r(24)}`, ['SLACK_TOKEN:block']],
    ['Slack webhook', `https://hooks.slack.com/services/T0123ABCD/B0123ABCD/${r(24)}`, ['SLACK_TOKEN:block']],
    ['AWS secret by name', `aws_secret_access_key = ${r(40, 'abcdEFGH1234/+xyz')}`, ['AWS_SECRET_KEY:block']],
    ['AWS key id with a secret next to it', `{accessKeyId:"AKIAIOSFODNN7EXAMPLE",secretAccessKey:"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}`, ['POSSIBLE_SECRET:warn', 'POSSIBLE_AWS_SECRET:warn']],
    ['Stripe live secret', `sk_live_${r(24)}`, ['STRIPE_SECRET_KEY:block']],
    ['Google API key is a warning', `apiKey: "AIza${r(35)}"`, ['GOOGLE_API_KEY:warn']],
    ['database URL with password is a warning', 'const db = "postgres://app:Xk29fjQ8mmzP@db.example.net:5432/app"', ['DATABASE_URL:warn']],
    ['mongodb+srv URL', 'mongodb+srv://admin:h7G2kLp9Q@cluster0.abcde.mongodb.net/test', ['DATABASE_URL:warn']],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl', ['PRIVATE_KEY:block']],
  ];
  for (const [title, text, expected] of cases) it(title, () => assert.deepEqual(codes(text), expected));

  const clean = [
    ['short sk- strings and words ending in sk', 'risk-assessment desk-top sk-abc sk-1234 task-runner-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['Stripe publishable and test keys', `pk_live_${r(24)} sk_test_${r(24)}`],
    ['npm token from an environment variable', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'],
    ['GitHub prefixes without a token', 'ghp_short gho_ github_pat_x'],
    ['Google key that is too short', 'AIzaShort'],
    ['database URL placeholders', 'postgres://user:password@localhost/db mysql://root:${DB_PASS}@db/app redis://:<password>@host:6379'],
    ['database URL without a password', 'postgresql://localhost/mydb mongodb://db.example.net:27017'],
    ['a public key block', '-----BEGIN PUBLIC KEY-----'],
    ['Slack-like words', 'xoxo-gossip xoxb-short'],
  ];
  for (const [title, text] of clean) it(`no finding: ${title}`, () => assert.deepEqual(codes(text), []));

  it('provider keys in PHP files are warnings, mirrored server rules still block', () => {
    assert.deepEqual(codes(`<?php $key = 'sk-ant-api03-${r(93)}';`, { serverSide: true }), ['ANTHROPIC_API_KEY:warn']);
    assert.deepEqual(codes(`<?php $s = 'sk_live_${r(24)}';`, { serverSide: true }), ['STRIPE_SECRET_KEY:block']);
    assert.deepEqual(codes('<?php $db = "mysql://shop:Xk29fjQ8mmzP@localhost/shop";', { serverSide: true }), []);
  });
  it('scan blocks a token in a JavaScript bundle and only warns in PHP', () => {
    const report = scan(project({ 'index.php': `<?php $k = "ghp_${r(36)}";`, 'assets/app.js': `fetch(u,{headers:{Authorization:"Bearer ghp_${r(36)}"}})`, 'assets/maps.js': `const key="AIza${r(35)}"` }));
    assert.deepEqual(report.blocked.map((b) => [b.code, b.file]), [['GITHUB_TOKEN', 'assets/app.js']]);
    assert.deepEqual(report.warnings.map((w) => [w.code, w.file]).sort(), [['GITHUB_TOKEN', 'index.php'], ['GOOGLE_API_KEY', 'assets/maps.js']]);
  });
});

describe('pack excludes', () => {
  it('leaves out VCS, editor and tool folders, .env files, dumps and logs; keeps .htaccess and .well-known', async () => {
    const root = project({
      'index.php': '<?php', '.htaccess': 'x', '.well-known/security.txt': 'x', '.git/HEAD': 'ref', '.GIT/x': 'y', '.vscode/s.json': '{}',
      '.env': 'A=1', '.env.example': 'A=', 'dump.sql': 'x', 'debug.log': 'x', 'node_modules/a.js': 'x', '.npmrc': 'x', 'sub/.svn/entries': 'x',
    });
    const result = await pack(root);
    roots.push(dirname(result.archive));
    assert.deepEqual(Object.keys(untar(result.archive)).sort(), ['.htaccess', '.well-known/security.txt', 'index.php']);
    assert.equal(result.excluded_count, 10);
    assert.equal(result.url_file, join(dirname(result.archive), 'upload-url'));
  });
  it('refuses an archive over the size limit and deletes it', async () => {
    const root = project({ 'index.html': 'x'.repeat(5000), 'b.bin': Array.from({ length: 5000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join('') });
    await assert.rejects(pack(root, join(root, '..', `${root.split('/').pop()}-big.tar.gz`), { maxBytes: 100 }), (error) => error.code === 'ARCHIVE_TOO_LARGE' && error.max_bytes === 100);
    assert.equal(existsSync(join(root, '..', `${root.split('/').pop()}-big.tar.gz`)), false);
  });
  it('refuses a path the server would refuse', async () => {
    await assert.rejects(pack(project({ 'index.html': 'x', 'a\\b.html': 'x' })), (error) => error.code === 'PATH_INVALID');
  });
});

describe('upload retries', () => {
  const archive = () => join(project({ 'site.tar.gz': 'x' }), 'site.tar.gz');
  const scripted = (answers) => {
    const calls = [];
    return {
      calls,
      transport: async () => {
        const next = answers[calls.length] ?? answers.at(-1);
        calls.push(next);
        if (next instanceof Error) throw next;
        return { status: next.status, body: JSON.stringify(next.body ?? {}), retryAfter: next.retryAfter ?? null };
      },
    };
  };
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };

  it('counts UPLOAD_ALREADY_RECEIVED after a lost answer as success', async () => {
    const { transport, calls } = scripted([new Error('socket hang up'), { status: 409, body: { code: 'UPLOAD_ALREADY_RECEIVED' } }]);
    const result = await upload(archive(), 'https://x.test/u', { transport, wait });
    assert.equal(calls.length, 2);
    assert.deepEqual([result.ok, result.code], [true, 'UPLOAD_ALREADY_RECEIVED']);
    assert.match(result.note, /hosting_deployments_get/);
  });
  it('does not count UPLOAD_ALREADY_RECEIVED on the first attempt as success', async () => {
    const { transport } = scripted([{ status: 409, body: { code: 'UPLOAD_ALREADY_RECEIVED', message: 'm' } }]);
    assert.deepEqual((await upload(archive(), 'https://x.test/u', { transport, wait })).ok, false);
  });
  it('waits while an earlier attempt is still being received', async () => {
    const { transport, calls } = scripted([new Error('reset'), { status: 409, body: { code: 'UPLOAD_IN_PROGRESS' } }, { status: 409, body: { code: 'UPLOAD_ALREADY_RECEIVED' } }]);
    const result = await upload(archive(), 'https://x.test/u', { transport, wait });
    assert.equal(calls.length, 3);
    assert.equal(result.ok, true);
  });
  it('gives up on UPLOAD_IN_PROGRESS with a polling hint', async () => {
    const { transport } = scripted([{ status: 409, body: { code: 'UPLOAD_IN_PROGRESS' } }]);
    const result = await upload(archive(), 'https://x.test/u', { transport, wait, inProgressWaits: 2 });
    assert.deepEqual([result.ok, result.code], [false, 'UPLOAD_IN_PROGRESS']);
    assert.match(result.note, /hosting_deployments_get/);
  });
  it('maps 429 to RATE_LIMITED, waits for a short Retry-After and reports a long one', async () => {
    waits.length = 0;
    const short = scripted([{ status: 429, retryAfter: '3' }, { status: 202, body: { data: { id: 'dpl_1' } } }]);
    assert.deepEqual(await upload(archive(), 'https://x.test/u', { transport: short.transport, wait }), { ok: true, status: 202, deployment_id: 'dpl_1' });
    assert.deepEqual(waits, [3000]);
    const long = scripted([{ status: 429, retryAfter: '120', body: { message: 'Too Many Attempts.' } }]);
    const result = await upload(archive(), 'https://x.test/u', { transport: long.transport, wait });
    assert.deepEqual([result.ok, result.code, result.retry_after], [false, 'RATE_LIMITED', 120]);
  });
  it('reads the upload URL from the file next to the archive and deletes the file', () => {
    const path = archive();
    writeFileSync(join(dirname(path), 'upload-url'), 'https://api.test/upload?signature=abc\n');
    assert.equal(readUploadUrl(path, null, { env: {}, stdin: () => '' }), 'https://api.test/upload?signature=abc');
    assert.equal(existsSync(join(dirname(path), 'upload-url')), false);
    assert.equal(readUploadUrl(path, null, { env: { SOLL_UPLOAD_URL: 'https://e.test/u' }, stdin: () => '' }), 'https://e.test/u');
    assert.equal(readUploadUrl(path, null, { env: {}, stdin: () => 'https://s.test/u\n' }), 'https://s.test/u');
  });
  it('refuses an upload URL on the command line', () => {
    const run = runScript('upload.mjs', [archive(), 'https://api.test/upload?signature=abc']);
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout).code, 'USAGE');
    assert.ok(!run.stdout.includes('signature'));
  });
});

describe('scripts started through a symlink', () => {
  for (const script of ['detect.mjs', 'scan.mjs', 'pack.mjs']) {
    it(`${script} prints its result`, () => {
      const dir = project({});
      const site = project({ 'index.html': '<h1>x</h1>' });
      symlinkSync(join(SCRIPTS, script), join(dir, script));
      const run = runScript(join(dir, script), [site]);
      assert.equal(run.status, 0, run.stderr);
      const output = JSON.parse(run.stdout);
      assert.ok(output && typeof output === 'object');
      if (output.archive) roots.push(dirname(output.archive));
    });
  }
  it('detect refuses the home folder as the output folder', () => {
    const home = project({ 'index.html': 'x' });
    const run = runScript('detect.mjs', [home], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    const output = JSON.parse(run.stdout);
    assert.equal(output.supported, false);
    assert.match(output.reason, /home folder/);
  });
});
