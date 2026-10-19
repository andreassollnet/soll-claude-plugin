# soll.net Publish – Claude plugin

[Deutsch](#deutsch) · [English](#english)

---

## Deutsch

Mit diesem Plugin stellst du eine Website oder Web-App, die du mit KI gebaut hast (Lovable, Bolt, Cursor, Claude Code …), mit einem Satz auf deinem soll.net-Webhosting online: **„Veröffentliche das auf soll.net.“** Kein FTP, kein Server-Wissen.

Das Plugin erkennt das Framework, baut das Projekt, prüft es auf versehentlich enthaltene Geheimnisse (z. B. `.env`, API-Schlüssel von OpenAI, Anthropic, Stripe, GitHub-Tokens), lässt Entwicklungsdateien weg (`.git`, `.vscode`, `node_modules`, Datenbank-Dumps, Logs), lädt es hoch und nennt dir die Live-Adresse. Eine frühere Version holst du mit `/soll:rollback` zurück.

### Was läuft

- **Ja:** statische Seiten und Single-Page-Apps (Vite/React/Vue/Svelte, Astro, Next.js mit `output: 'export'`, Nuxt `generate`, SvelteKit `adapter-static`, Eleventy, Jekyll, Parcel, reines HTML), PHP 8.2–8.4 mit MySQL. HTTPS mit Let's Encrypt automatisch.
- **Nein:** Node.js- oder Python-Server, Next.js mit SSR/API-Routes/Server Actions, TanStack Start, SolidStart, Vike, Analog, Qwik City, Laravel/Symfony, Docker, Hintergrundprozesse. Das Plugin sagt das ehrlich und schlägt – wo möglich – einen statischen Export vor.

### Installation (Claude Code)

1. Marketplace hinzufügen: `/plugin marketplace add andreassollnet/soll-claude-plugin`
2. Plugin installieren: `/plugin install soll@soll-net`
3. Mit soll.net verbinden: `/mcp` → `plugin:soll:soll` → **Authenticate**. Im Browser beim soll.net-Portal anmelden, die Berechtigungen **hosting:read** und **hosting:deploy** anhaken (optional **hosting:write** für Subdomains und Vorschau-Adressen) und mit deinem Passwort bestätigen.
4. Im Projektordner sagen: „Veröffentliche das auf soll.net“ – oder `/soll:publish`.

**Claude Desktop / Cowork:** Customize → Plugins → Add marketplace → `https://github.com/andreassollnet/soll-claude-plugin` → Plugin **soll** installieren → unter Connectors **Connect**. Die Skripte laufen in Cowork auf deinem Rechner (Node.js 18+ nötig); im reinen Chat ohne lokalen Ordner kann nicht hochgeladen werden.

### Voraussetzungen

- Ein soll.net-Konto mit einem **Hosting-Paket** (ohne Paket zeigt das Plugin die Angebote mit Link zum Shop).
- **Node.js 18 oder neuer** auf deinem Rechner.
- Ohne eigene Domain: kostenlose Vorschau-Adresse `<name>.soll.run` (mit kleinem Hinweis-Banner).

### Befehle

| Befehl | |
| --- | --- |
| `/soll:publish [domain]` | veröffentlichen (auch ohne Befehl, wenn du „online stellen“, „deployen“ … sagst) |
| `/soll:status [domain]` | Live-Adresse, letzte Deployments, HTTPS und DNS |
| `/soll:rollback [domain]` | eine frühere Version zurückholen (die letzten fünf bleiben erhalten, dazu der Inhalt von vor dem ersten Veröffentlichen) |

Nach dem ersten Veröffentlichen kann das Plugin die Einstellungen in `.soll/deploy.json` speichern (ohne Geheimnisse); dann reicht beim nächsten Mal ein Satz.

### Sicherheit

- Keine Zugangsdaten im Plugin: die Anmeldung läuft über OAuth im soll.net-Portal; du wählst die Berechtigungen und kannst sie dort jederzeit widerrufen.
- Hochgeladen wird über eine 15 Minuten gültige Adresse, die genau ein Archiv annimmt und nie in einer Befehlszeile steht; soll.net prüft jedes Archiv noch einmal.
- Beim ersten Veröffentlichen bleibt der bisherige Inhalt der Adresse (z. B. per FTP hochgeladen) als Version „initial“ erhalten und lässt sich mit `/soll:rollback` zurückholen.
- Kostenpflichtiges (Domainkauf) und Überschreiben passiert nur nach deinem ausdrücklichen „Ja“.

---

## English

Publish a website or web app you built with AI (Lovable, Bolt, Cursor, Claude Code …) to your soll.net web hosting with one sentence: **"Publish this on soll.net."** No FTP, no server knowledge.

The plugin detects the framework, builds the project, checks it for leaked secrets (e.g. `.env`, OpenAI, Anthropic and Stripe secret keys, GitHub tokens), leaves out development files (`.git`, `.vscode`, `node_modules`, database dumps, logs), uploads it and tells you the live address. `/soll:rollback` brings back an earlier version.

### What runs

- **Yes:** static sites and single-page apps (Vite/React/Vue/Svelte, Astro, Next.js with `output: 'export'`, Nuxt `generate`, SvelteKit `adapter-static`, Eleventy, Jekyll, Parcel, plain HTML), PHP 8.2–8.4 with MySQL. HTTPS with Let's Encrypt automatically.
- **No:** Node.js or Python servers, Next.js with SSR/API routes/Server Actions, TanStack Start, SolidStart, Vike, Analog, Qwik City, Laravel/Symfony, Docker, background jobs. The plugin says so and suggests a static export where possible.

### Installation (Claude Code)

1. Add the marketplace: `/plugin marketplace add andreassollnet/soll-claude-plugin`
2. Install the plugin: `/plugin install soll@soll-net`
3. Connect to soll.net: `/mcp` → `plugin:soll:soll` → **Authenticate**. Sign in to the soll.net portal in the browser, tick **hosting:read** and **hosting:deploy** (optionally **hosting:write** for subdomains and preview addresses) and confirm with your password.
4. In your project folder say "Publish this on soll.net" – or run `/soll:publish`.

**Claude Desktop / Cowork:** Customize → Plugins → Add marketplace → `https://github.com/andreassollnet/soll-claude-plugin` → install **soll** → Connectors → **Connect**. The scripts run on your computer in Cowork (Node.js 18+ required); plain Chat without a local folder cannot upload.

### Requirements

- A soll.net account with a **web hosting package** (without one, the plugin shows the offers with a link to the shop).
- **Node.js 18 or newer** on your computer.
- No domain yet: a free preview address `<name>.soll.run` (with a small banner).

### Commands

| Command | |
| --- | --- |
| `/soll:publish [domain]` | publish (also without the command when you say "put it online", "deploy" …) |
| `/soll:status [domain]` | live address, last deployments, HTTPS and DNS |
| `/soll:rollback [domain]` | bring back an earlier version (the last five are kept, plus the content from before the first publish) |

After the first publish the plugin can save the settings in `.soll/deploy.json` (no secrets), so the next publish is one sentence.

### Security

- No credentials in the plugin: you sign in with OAuth in the soll.net portal, choose the permissions and can revoke them there at any time.
- Uploads go to an address valid for 15 minutes that accepts exactly one archive and never appears in a command line; soll.net checks every archive again.
- On the first publish the address's previous content (e.g. uploaded by FTP) is kept as the version "initial" and can be brought back with `/soll:rollback`.
- Billable steps (buying a domain) and replacing a live site only happen after your explicit "yes".

---

## Development

```
node --test skills/publish/test/scripts.test.mjs   # unit tests of detect, scan, pack, upload (Node.js 18+)
claude plugin validate . --strict                  # marketplace; also .claude-plugin/plugin.json, skills, commands
claude --plugin-dir .                              # try the plugin locally
```

Backend side: soll.net customer API (`docs/customer-api.md`, `docs/hosting-deployments.md` in the portal backend). License: MIT.
