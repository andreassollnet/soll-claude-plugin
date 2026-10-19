# Changelog

## 0.2.0 - 2026-10-19

Fixes from the 2026-10-19 audit.

- PHP and plain HTML projects inside a git repository can be published: one shared exclude list (`scripts/rules.mjs`)
  for scan and pack leaves out version control (`.git` in any case and depth), editor and tool folders, `node_modules`,
  `.npmrc`, `.env` templates, database dumps and files, backups and logs, and lists them as info. `.htaccess`,
  `.user.ini` and `.well-known/` are published; a `.env` with values stays blocked.
- Secret scan: OpenAI, Anthropic, GitHub, npm, Slack and AWS secret keys block; Google API keys, database URLs with a
  password, other `sk-` keys and AWS key ids with a secret nearby warn. Provider keys in PHP files only warn.
- Paths are checked like the server does: 240 bytes per path, 255 per name, no backslashes or control characters.
- Scripts work when started through a symlinked path.
- `upload.mjs` reads the upload address from a file next to the archive (or stdin / `SOLL_UPLOAD_URL`), never from
  the command line; treats `UPLOAD_ALREADY_RECEIVED` after a lost answer as success, waits on `UPLOAD_IN_PROGRESS`
  and `RATE_LIMITED`, and deletes the archive after a successful upload.
- `pack.mjs --max-bytes` checks the archive against the hosting's `max_archive_bytes` before a deployment is created.
- Output folders outside the project, the home folder or a drive root are refused (detect and `scan --project`).
- Detection: Laravel/Symfony with Vite are recognised as PHP frameworks; TanStack Start, SolidStart, Vike, Analog and
  Qwik City are refused as server-rendered; Eleventy, Jekyll and Parcel publish their build output.
- Skill and reference: the per-site release layout (`initial` version reachable by rollback, `LAYOUT_SWITCH_PENDING`,
  `TARGET_LAYOUT_*`, `TARGET_CHANGED`, `TRANSFER_TIMEOUT`, `HOSTING_DEPLOY_SHELL_REFUSED` and the other backend codes),
  `dns.points_here` null, one `type` per `packages_list` call, confirmation before running a `build_command` from
  `.soll/deploy.json`.

## 0.1.0 - 2026-10-17

First public version.
