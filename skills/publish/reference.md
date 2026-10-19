# soll.net publish reference

## Connecting

The plugin brings the soll.net MCP server `https://api.soll.net/mcp`. It signs in with OAuth in the browser:

- **Claude Code:** run `/mcp`, select `plugin:soll:soll`, choose "Authenticate". The browser opens the soll.net portal; sign in, tick the permissions and confirm with your password.
- **Claude Desktop / Cowork:** Customize > Plugins > soll > Connectors > Connect, then the same consent page.

Permissions (scopes) to tick:

| Scope | Needed for |
| --- | --- |
| `hosting:read` | seeing packages, addresses and deployments (required) |
| `hosting:deploy` | publishing and rolling back (required) |
| `hosting:write` | creating subdomains and free preview addresses (optional) |
| `domains:read`, `dns:read` | showing domains and DNS status (optional) |
| `prices:read`, `domains:order` | checking prices and buying a domain (optional, billable) |

The user needs the permissions in the soll.net account as well (hosting.read / hosting.write in the package's division; account admins have all).

## Tools used

| Tool | Purpose |
| --- | --- |
| `token_get` | account, scopes, divisions of the connection |
| `packages_list`, `packages_get` | hosting packages, status, usage |
| `packages_offers_list` | orderable packages with `shop_url` |
| `hosting_get` | addresses (`targets`) with folder, `deployable`, DNS check (`dns.points_here`: true, false or null = not checkable), live deployment; `deployments` (`available`, `max_archive_bytes`, `keep_releases`, `daily_limit`); PHP, HTTPS |
| `hosting_subdomains_create` / `_delete` | subdomain of the package's domain |
| `hosting_previews_create` / `_delete` | free preview address `<name>.soll.run` |
| `hosting_deployments_create` | announce an archive, get `upload_url` |
| `hosting_deployments_get` / `_list` | status of a deployment |
| `hosting_deployments_rollback` | bring back an earlier version the server keeps (5 per address, plus `initial`) |
| `domains_check`, `domains_register` | price quote and billable registration |
| `portal_only_actions` | what has to be done in the portal, with links |

Deployment states: `awaiting_upload`, `queued`, `validating`, `transferring`, `live`, `failed`, `superseded` (replaced by a newer one), `rolled_back`, `expired` (no upload within 15 minutes).

The first deployment to an address moves it to the release layout: the folder's previous content (for example files uploaded by FTP) stays on the server as the version `initial`, listed as a deployment with `channel: "system"` and the note "Content of the folder before the first deployment". A rollback can bring it back; it is never pruned and does not count against the five kept versions.

## Upload answers (PUT to `upload_url`)

| Answer | Meaning |
| --- | --- |
| `202` | Received; the deployment is `queued`. |
| `409 UPLOAD_ALREADY_RECEIVED` | An archive already arrived. After a retry of `upload.mjs` (lost answer) this is success. |
| `409 UPLOAD_IN_PROGRESS` | An earlier attempt is still being received; wait and check `hosting_deployments_get`. |
| `410 UPLOAD_EXPIRED`, `403 UPLOAD_URL_INVALID` | The 15 minutes passed or the address is wrong; start a new deployment. |
| `422 UPLOAD_SIZE_MISMATCH`, `UPLOAD_HASH_MISMATCH` | The file differs from the announced one; the deployment keeps waiting, so the right file can be sent until it expires. |
| `429 RATE_LIMITED` | Too many attempts (10 per minute per address); `upload.mjs` waits for `retry_after`. |

Always check `hosting_deployments_get` before reporting an upload failure.

## Error codes

| Code | Meaning for the user |
| --- | --- |
| `TOKEN_REQUIRED` | Not connected; connect again. |
| `SCOPE_REQUIRED` | The connection lacks a permission; name it (message says which). |
| `NOT_FOUND`, `FORBIDDEN` | The package is not visible to this account or user. |
| `VALIDATION_FAILED` | A value was refused (e.g. the archive is larger than `max_archive_bytes`); the message names the field. |
| `PACKAGE_NOT_ACTIVE` | The package is locked (renewal unpaid) or not running yet. |
| `TARGET_NOT_FOUND` | The address is not part of the package or not set up on the server. |
| `TARGET_NESTED` | The address's folder contains, lies inside or is another address's folder; give it a folder of its own (e.g. a subdomain). |
| `TARGET_LAYOUT_UNSUPPORTED` | The address is served from the home folder, from outside it or redirects (`deployable: false`); it needs a folder of its own first. |
| `TARGET_LAYOUT_CONFLICT` | The folder already holds its own `current` or `releases`; rename them (FTP or portal) and deploy again. |
| `TARGET_LAYOUT_MIGRATION_PENDING` | soll.net still has to move this address to the new release layout once; try later or contact support. |
| `TARGET_CHANGED` | The address's folder changed on the server after the deployment was created; deploy again. |
| `TARGET_INVALID` | The server cannot use the folder for deployments; contact support. |
| `TARGET_BUSY` | Another deployment to this address is running; wait and check its status. |
| `WEBSPACE_EXCEEDED`, `QUOTA_EXCEEDED` | The package's storage is full (the five kept versions count too); delete old files or upgrade. |
| `DEPLOY_LIMIT_EXCEEDED`, `DEPLOY_UPLOADS_PENDING` | Too many deployments today (rollbacks included) / too many waiting for their upload; try later. |
| `UPLOAD_SIZE_MISMATCH`, `UPLOAD_HASH_MISMATCH` | The upload differs from the announced archive; pack again and start a new deployment (or send the right file). |
| `UPLOAD_EXPIRED`, `UPLOAD_URL_INVALID` | The 15 minutes passed or the address is wrong; start a new deployment. |
| `UPLOAD_ALREADY_RECEIVED`, `UPLOAD_IN_PROGRESS` | See "Upload answers": usually the upload arrived; check the status. |
| `ARCHIVE_SECRET_*` | A secret was found on the server side check (should have been caught by `scan`). |
| `ARCHIVE_*` | The archive was refused (links, `..` paths, too large, too many files, invalid names). |
| `CREDENTIAL_REVOKED` | The connection that started the deployment was revoked or expired meanwhile; connect again and deploy again. |
| `HOSTING_DEPLOY_SHELL_REFUSED` | This hosting cannot get the deploy access (panel login or an FTP account with a shell); contact soll.net support. |
| `TRANSFER_NOT_CONFIGURED` | Deployments are not set up on the hosting server yet; try later or contact support. |
| `TRANSFER_UNREACHABLE` | The hosting server was not reachable; the first deployment of a hosting waits up to 15 minutes for its access. |
| `TRANSFER_TIMEOUT`, `TRANSFER_FAILED`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_STALLED` | Server problem; check the address, try again later, then contact support. |
| `RELEASE_NOT_FOUND`, `NOTHING_TO_ROLL_BACK`, `ALREADY_LIVE` | Rollback not possible as asked. |
| `PREVIEWS_UNAVAILABLE`, `PREVIEW_LIMIT_REACHED`, `PREVIEW_NAME_*` | Preview addresses off, limit reached (3), or the name is taken/reserved. |
| `PAYMENT_REQUIRED` | A prepaid account lacks credit for a billable order. |
| `RATE_LIMITED` | Too many requests; wait (`retry_after` seconds, else a minute). |
| `PORTAL_ONLY` | Only possible in the portal; give the `portal_url`. |
| `HOSTING_UNAVAILABLE` | The hosting server is not reachable right now. |

## Deployment warnings

| Code | Meaning |
| --- | --- |
| `LAYOUT_SWITCH_PENDING` | First deployment to the address: it switches to the new version within about 5 minutes; until then the old content shows. |
| `SPA_FALLBACK_SKIPPED` | The archive has its own `.htaccess`, so no fallback rule was added; client-side routes need a rule in it. |
| `NO_INDEX` | No `index.html` / `index.php` at the top. |
| `NODE_MODULES`, `POSSIBLE_SECRET` | `node_modules` in the archive, or something like an AWS key id. |

## Local script codes

`scan.mjs` blocks: `ENV_FILE` (a `.env` with values), `PRIVATE_KEY`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE` (the server refuses these too), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `SLACK_TOKEN`, `AWS_SECRET_KEY` (provider secrets; in `.php` files only a warning, as PHP runs on the server), `PATH_INVALID`, `PATH_TOO_LONG` (240 bytes per path, 255 per name), `OUTPUT_DIR_UNSAFE`, `NO_OUTPUT`, `EMPTY`, `TOO_MANY_FILES`, `TOO_LARGE`. It warns: `GOOGLE_API_KEY`, `DATABASE_URL`, `POSSIBLE_OPENAI_STYLE_KEY`, `POSSIBLE_AWS_SECRET`, `POSSIBLE_SECRET`, `SOURCE_MAPS`, `SYMLINK_SKIPPED`, `NODE_MODULES_REFERENCED`, `NO_INDEX`. `pack.mjs`: `ARCHIVE_TOO_LARGE`, `EMPTY`, `PATH_*`. `upload.mjs`: `NETWORK_ERROR`, `NO_UPLOAD_URL`, `USAGE`, `TOO_LARGE`, `UPLOAD_FAILED`, plus the upload answers above.
