#!/usr/bin/env node
// Detects the framework of a project and whether soll.net web hosting (Apache + PHP, no Node/Python servers) can run it.
// Usage: node detect.mjs [projectDir]  ->  one JSON object on stdout.
// No dependencies: Node.js 18+ standard library only.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (dir, file) => {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
};

const firstExisting = (dir, files) => files.find((file) => existsSync(join(dir, file))) ?? null;

function packageManager(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

const runScript = (pm, script) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
const installCommand = (pm) => ({ npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install' })[pm];

/** Files below dir (max depth, skipping dependencies and build output) whose name matches. */
function findFiles(dir, test, depth = 4) {
  const found = [];
  const walk = (current, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (['node_modules', '.git', '.next', 'dist', 'build', 'out', '.output', '.svelte-kit', '.astro', 'vendor'].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, level + 1);
      else if (test(path, entry.name)) found.push(path);
    }
  };
  walk(dir, 0);
  return found;
}

const SERVER_PACKAGES = ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi', 'hono', 'socket.io', 'next-auth', '@trpc/server'];

function result(base) {
  return {
    framework: 'unknown',
    supported: false,
    reason: '',
    kind: null, // static | spa | php
    install_command: null,
    build_command: null,
    output_dir: null,
    spa_fallback: false,
    package_manager: null,
    notes: [],
    ...base,
  };
}

export function detect(projectDir = '.') {
  const dir = resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return result({ reason: `The folder ${dir} does not exist.` });
  }
  const pkgText = read(dir, 'package.json');
  let pkg = null;
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      return result({ reason: 'package.json is not valid JSON.' });
    }
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const scripts = pkg?.scripts ?? {};
  const pm = pkg ? packageManager(dir) : null;
  const base = pkg ? { package_manager: pm, install_command: installCommand(pm) } : {};

  // Python and other server runtimes: never on this hosting.
  const pyproject = read(dir, 'pyproject.toml') ?? '';
  const requirements = read(dir, 'requirements.txt') ?? '';
  if (/\b(django|flask|fastapi|streamlit|gradio)\b/i.test(pyproject + requirements) || existsSync(join(dir, 'manage.py'))) {
    return result({ framework: 'python', reason: 'This is a Python web app. soll.net web hosting runs static sites and PHP, not Python servers.', notes: ['Host the Python backend elsewhere (e.g. a PaaS) and publish only a static frontend here.'] });
  }

  // Next.js: only a static export works.
  if (has('next')) {
    const configFile = firstExisting(dir, ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']);
    const config = configFile ? read(dir, configFile) : '';
    const exported = /output\s*:\s*['"`]export['"`]/.test(config ?? '');
    const fileText = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    };
    const serverFeatures = [];
    if (findFiles(dir, (path) => /[\\/]app[\\/](.*[\\/])?api[\\/].*route\.(t|j)sx?$/.test(path) || /[\\/]pages[\\/]api[\\/]/.test(path)).length > 0) serverFeatures.push('API routes');
    if (firstExisting(dir, ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'])) serverFeatures.push('middleware');
    if (findFiles(dir, (path, name) => /\.(t|j)sx?$/.test(name) && /^\s*['"]use server['"]/m.test(fileText(path))).length > 0) serverFeatures.push('Server Actions');
    const features = [...new Set(serverFeatures)];
    if (!exported || features.length > 0) {
      return result({
        ...base,
        framework: 'nextjs',
        reason: exported
          ? `This Next.js app uses ${features.join(', ')}, which need a Node.js server. soll.net web hosting serves static files and PHP only.`
          : 'This Next.js app is built for a Node.js server (no output: "export" in next.config). soll.net web hosting serves static files and PHP only.',
        notes: features.length === 0
          ? ['It looks like the app has no server-only features: adding output: "export" to next.config makes it a static site that can be published here.']
          : ['Move API routes and Server Actions to a separate backend (or a service like Supabase) and use output: "export", or host the app on a Node.js platform.'],
      });
    }
    const distDir = (config ?? '').match(/distDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    return result({ ...base, framework: 'nextjs', supported: true, kind: 'spa', build_command: runScript(pm, 'build'), output_dir: distDir ?? 'out', reason: 'Next.js static export.', notes: ['next/image needs images.unoptimized = true in a static export.'] });
  }

  // Nuxt: nuxt generate (or ssr: false) produces static files; nuxt build alone is a Node server.
  if (has('nuxt') || has('nuxt3')) {
    const config = read(dir, firstExisting(dir, ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) ?? '') ?? '';
    const generate = Object.entries(scripts).find(([, cmd]) => /nux[ti]\s+generate/.test(cmd));
    const spa = /ssr\s*:\s*false/.test(config);
    if (!generate && !spa) {
      return result({ ...base, framework: 'nuxt', reason: 'This Nuxt app is built for a Node.js server (nuxt build). soll.net web hosting serves static files and PHP only.', notes: ['Use "nuxt generate" (static site generation) if the app does not need server routes.'] });
    }
    return result({ ...base, framework: 'nuxt', supported: true, kind: spa ? 'spa' : 'static', build_command: generate ? runScript(pm, generate[0]) : 'npx nuxi generate', output_dir: '.output/public', spa_fallback: spa, reason: 'Nuxt static generation.' });
  }

  // SvelteKit: adapter-static only.
  if (has('@sveltejs/kit')) {
    const config = read(dir, firstExisting(dir, ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts']) ?? '') ?? '';
    if (!has('@sveltejs/adapter-static') || !/adapter-static/.test(config)) {
      return result({ ...base, framework: 'sveltekit', reason: 'This SvelteKit app uses a server adapter. soll.net web hosting serves static files and PHP only.', notes: ['Switch to @sveltejs/adapter-static (prerender or SPA mode with a fallback page) if the app has no server endpoints.'] });
    }
    const pages = config.match(/pages\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const fallback = /fallback\s*:/.test(config);
    return result({ ...base, framework: 'sveltekit', supported: true, kind: fallback ? 'spa' : 'static', build_command: runScript(pm, 'build'), output_dir: pages ?? 'build', spa_fallback: fallback, reason: 'SvelteKit with adapter-static.' });
  }

  // Astro: static unless output server/hybrid or a server adapter.
  if (has('astro')) {
    const config = read(dir, firstExisting(dir, ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) ?? '') ?? '';
    const serverOutput = /output\s*:\s*['"`](server|hybrid)['"`]/.test(config);
    const adapter = ['@astrojs/node', '@astrojs/vercel', '@astrojs/netlify', '@astrojs/cloudflare'].find(has);
    if (serverOutput || adapter) {
      return result({ ...base, framework: 'astro', reason: `This Astro site renders on a server (${adapter ?? 'output: server'}). soll.net web hosting serves static files and PHP only.`, notes: ['Remove the adapter and use the default static output if no page needs server rendering.'] });
    }
    const outDir = config.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    return result({ ...base, framework: 'astro', supported: true, kind: 'static', build_command: runScript(pm, 'build'), output_dir: outDir ?? 'dist', reason: 'Astro static site.' });
  }

  // Remix / React Router framework mode: server-rendered unless SPA mode.
  if (has('@remix-run/react') || has('@react-router/dev')) {
    const config = read(dir, firstExisting(dir, ['react-router.config.ts', 'react-router.config.js']) ?? '') ?? '';
    if (has('@react-router/dev') && /ssr\s*:\s*false/.test(config)) {
      return result({ ...base, framework: 'react-router', supported: true, kind: 'spa', build_command: runScript(pm, 'build'), output_dir: 'build/client', spa_fallback: true, reason: 'React Router in SPA mode.' });
    }
    return result({ ...base, framework: has('@remix-run/react') ? 'remix' : 'react-router', reason: 'This app renders on a Node.js server. soll.net web hosting serves static files and PHP only.', notes: ['React Router supports SPA mode (ssr: false) which produces static files.'] });
  }

  if (has('gatsby')) {
    return result({ ...base, framework: 'gatsby', supported: true, kind: 'static', build_command: runScript(pm, 'build'), output_dir: 'public', reason: 'Gatsby static site.' });
  }

  if (has('@angular/core')) {
    if (has('@angular/ssr') || has('@nguniversal/express-engine')) {
      return result({ ...base, framework: 'angular', reason: 'This Angular app uses server-side rendering. soll.net web hosting serves static files and PHP only.', notes: ['Build without SSR (browser build only) to publish it here.'] });
    }
    let output = 'dist';
    try {
      const angular = JSON.parse(read(dir, 'angular.json') ?? '{}');
      const project = Object.values(angular.projects ?? {})[0];
      const outputPath = project?.architect?.build?.options?.outputPath;
      output = typeof outputPath === 'string' ? `${outputPath}/browser` : (outputPath?.base ? `${outputPath.base}/browser` : output);
    } catch { /* default */ }
    return result({ ...base, framework: 'angular', supported: true, kind: 'spa', build_command: runScript(pm, 'build'), output_dir: output, spa_fallback: true, reason: 'Angular browser build.', notes: ['Check that the output folder contains index.html; older Angular versions build to dist/<project> without /browser.'] });
  }

  if (has('vite')) {
    const config = read(dir, firstExisting(dir, ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) ?? '') ?? '';
    const outDir = config.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const router = ['react-router-dom', 'react-router', 'vue-router', '@tanstack/react-router', 'svelte-spa-router', '@solidjs/router', 'wouter'].find(has);
    const framework = has('react') ? 'vite-react' : has('vue') ? 'vite-vue' : has('svelte') ? 'vite-svelte' : has('solid-js') ? 'vite-solid' : 'vite';
    const server = SERVER_PACKAGES.find(has);
    return result({
      ...base, framework, supported: true, kind: router ? 'spa' : 'static', build_command: runScript(pm, 'build'), output_dir: outDir ?? 'dist', spa_fallback: Boolean(router),
      reason: `Vite build${router ? ` with client-side routing (${router})` : ''}.`,
      notes: server ? [`The project also depends on ${server}: only the built frontend is published; a server part will not run here.`] : [],
    });
  }

  if (has('react-scripts')) {
    return result({ ...base, framework: 'create-react-app', supported: true, kind: has('react-router-dom') ? 'spa' : 'static', build_command: runScript(pm, 'build'), output_dir: 'build', spa_fallback: has('react-router-dom'), reason: 'Create React App build.' });
  }

  // A Node server without a frontend build.
  const server = SERVER_PACKAGES.find(has);
  if (server) {
    return result({ ...base, framework: 'node-server', reason: `This is a Node.js server app (${server}). soll.net web hosting runs static sites and PHP, not Node.js servers.`, notes: ['Host the server on a Node.js platform; a static frontend of it can be published here.'] });
  }

  // PHP: plain PHP sites run; frameworks with a public/ web root (Laravel, Symfony) do not fit a single web folder.
  if (existsSync(join(dir, 'artisan')) || existsSync(join(dir, 'bin', 'console')) || existsSync(join(dir, 'symfony.lock'))) {
    return result({ framework: 'php-framework', reason: 'Laravel/Symfony apps need their public/ folder as the web root and their code outside of it. Publishing through this plugin would put the whole app, including .env, in the web folder.', notes: ['Ask soll.net support for a hosting setup with a separate web root.'] });
  }
  const phpFiles = findFiles(dir, (path, name) => name.endsWith('.php'), 1);
  if (phpFiles.length > 0) {
    const composer = existsSync(join(dir, 'composer.json'));
    return result({
      framework: 'php', supported: true, kind: 'php', install_command: composer ? 'composer install --no-dev --optimize-autoloader' : null,
      output_dir: '.', reason: 'PHP site (PHP 8.2 to 8.4 with MySQL).',
      notes: [composer ? 'Run composer install before packing so vendor/ is included.' : null, 'Database credentials belong in a config file outside the published folder or are set in the portal; never publish a .env file.'].filter(Boolean),
    });
  }

  // Plain HTML.
  if (existsSync(join(dir, 'index.html'))) {
    return result({ framework: 'static-html', supported: true, kind: 'static', output_dir: '.', reason: 'Plain HTML site.' });
  }
  if (!pkg && existsSync(join(dir, 'public', 'index.html'))) {
    return result({ framework: 'static-html', supported: true, kind: 'static', output_dir: 'public', reason: 'Plain HTML site in public/.' });
  }
  if (pkg && scripts.build) {
    return result({ ...base, framework: 'unknown-node', supported: false, build_command: runScript(pm, 'build'), reason: 'The framework is not recognised. After building, check whether the output folder holds static files (index.html).', notes: ['If the build produces a folder with index.html and no server, it can be published: tell me the folder.'] });
  }
  return result({ reason: 'No website found: no index.html, no PHP files and no known framework.' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(`${JSON.stringify(detect(process.argv[2] ?? '.'), null, 2)}\n`);
}
