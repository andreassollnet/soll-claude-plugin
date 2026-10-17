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
| `hosting_get` | addresses (`targets`) with folder, DNS check, live deployment; PHP, HTTPS |
| `hosting_subdomains_create` / `_delete` | subdomain of the package's domain |
| `hosting_previews_create` / `_delete` | free preview address `<name>.soll.run` |
| `hosting_deployments_create` | announce an archive, get `upload_url` |
| `hosting_deployments_get` / `_list` | status of a deployment |
| `hosting_deployments_rollback` | bring back an earlier version the server keeps (5 per address) |
| `domains_check`, `domains_register` | price quote and billable registration |
| `portal_only_actions` | what has to be done in the portal, with links |

Deployment states: `awaiting_upload`, `queued`, `validating`, `transferring`, `live`, `failed`, `superseded` (replaced by a newer one), `rolled_back`, `expired` (no upload within 15 minutes).

## Error codes

| Code | Meaning for the user |
| --- | --- |
| `TOKEN_REQUIRED` | Not connected; connect again. |
| `SCOPE_REQUIRED` | The connection lacks a permission; name it (message says which). |
| `NOT_FOUND`, `FORBIDDEN` | The package is not visible to this account or user. |
| `PACKAGE_NOT_ACTIVE` | The package is locked (renewal unpaid) or not running yet. |
| `TARGET_NOT_FOUND` | The address is not part of the package. |
| `TARGET_NESTED` | The address's folder is inside another one; use a subdomain with its own folder. |
| `WEBSPACE_EXCEEDED` | The package's storage is full; delete old files or upgrade. |
| `DEPLOY_LIMIT_EXCEEDED`, `DEPLOY_UPLOADS_PENDING` | Too many deployments today / waiting; try later. |
| `UPLOAD_SIZE_MISMATCH`, `UPLOAD_HASH_MISMATCH` | The upload differs from the announced archive; pack again and start a new deployment. |
| `UPLOAD_EXPIRED`, `UPLOAD_URL_INVALID` | The 15 minutes passed; start a new deployment. |
| `ARCHIVE_SECRET_*` | A secret was found on the server side check (should have been caught by `scan`). |
| `ARCHIVE_*` | The archive was refused (links, `..` paths, too large, too many files). |
| `TRANSFER_FAILED`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_STALLED` | Server problem; try again later, then contact support. |
| `RELEASE_NOT_FOUND`, `NOTHING_TO_ROLL_BACK`, `ALREADY_LIVE` | Rollback not possible as asked. |
| `PREVIEWS_UNAVAILABLE`, `PREVIEW_LIMIT_REACHED`, `PREVIEW_NAME_*` | Preview addresses off, limit reached (3), or the name is taken/reserved. |
| `PAYMENT_REQUIRED` | A prepaid account lacks credit for a billable order. |
| `RATE_LIMITED` | Too many requests; wait a minute. |
| `PORTAL_ONLY` | Only possible in the portal; give the `portal_url`. |
| `HOSTING_UNAVAILABLE` | The hosting server is not reachable right now. |
