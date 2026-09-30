# Deployment and operations

## 1. Local smoke

```bash
cp .env.example .env
npm start
```

Use `http://localhost:3000`, matching `APP_ORIGIN` exactly. `127.0.0.1` and `localhost` are different origins. The server starts without secrets, creates `data/arcade.sqlite`, and labels the opponent Local heuristic. Empty leaderboards are expected without published challenges and verified authenticated results.

Node22.16.0 was exercised for this package. Node24 is the Docker target but was not run in this environment. Pin a tested patch version/image digest in your deployment after staging validation. The bundled SQLite API can emit a stability warning; persistence is isolated in `server/db.js`.

## 2. Production settings

Set these in a protected `.env` outside source control:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
APP_ORIGIN=https://sudoku.example.com
GAME_DOMAIN=sudoku.example.com
DATABASE_PATH=/app/data/arcade.sqlite
LAUNCH_SIGNING_KEY=REPLACE_WITH_RANDOM_SECRET
TYPESAFE_API_KEY=REPLACE_WITH_YOUR_KEY
JEV_MODEL=jev-1.13.0
DISCORD_CLIENT_ID=YOUR_APPLICATION_ID
DISCORD_CLIENT_SECRET=YOUR_CLIENT_SECRET
DISCORD_PUBLIC_KEY=YOUR_INTERACTIONS_PUBLIC_KEY
ADMIN_DISCORD_IDS=YOUR_DISCORD_USER_ID
```

The hostname and placeholders are examples, not provisioned resources. Generate a signing key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Production startup rejects non-HTTPS origins and missing/short signing keys. Keep the key stable across restarts; it signs launch context and keys daily-attempt tombstones. A key rotation intentionally invalidates outstanding launches and changes tombstone derivation, so rotate with ranked play closed or after a challenge boundary.

The browser never needs `TYPESAFE_API_KEY`, `DISCORD_CLIENT_SECRET`, an operator bearer token or a signing key. Do not paste them into public JavaScript, query strings, screenshots or committed files.

## 3. Discord application

In your Discord application configuration, register exactly:

```
https://sudoku.example.com/api/auth/discord/callback
```

as the OAuth redirect, and:

```
https://sudoku.example.com/api/discord/interactions
```

as the interactions endpoint. Replace the domain consistently. Set the public key from that same application. The endpoint implements signed PING and command requests; expose it over HTTPS before saving the endpoint configuration.

Register the `/jev sudoku` command:

```bash
npm run discord:register
```

An optional `DISCORD_TEST_GUILD_ID` selects a guild-scoped registration during staging; omit it for global registration. The script uses an application access token with `applications.commands.update`, creates/updates this command without replacing the application's unrelated commands, and does not persist the access token. The command launch uses `applications.commands`; it does not require a message-reading bot or Gateway process.

Install the application's command in a participating server using Discord's application installation flow. A player's browser login requests `identify` only. A signed command interaction binds guild/channel/user context; a browser OAuth login alone cannot establish channel context.

Test both a direct login (World only) and a channel invocation. Confirm a launch shared with a different user is rejected and repeated token redemption fails. Tokens expire after ten minutes; redeemed context lasts one hour. DM command launches are not the MVP path.

No real Discord credentials were available during package testing. Registration, installation and public callbacks must be exercised in your application before public launch.

## 4. TypeSafe JEV

Set the API key and pinned model, restart, and verify the game no longer advertises local-only capabilities. The server uses the documented `POST /v1/systemone` typed Choice protocol with a finite candidate set and no arbitrary user prompt.

Confirm actual report records have `source=jev`, the expected model, a validated candidate distribution, request latency and reported usage. A forced single-candidate step is correctly labeled forced and does not call the API. A configured-but-invalid key produces a visible fallback and practice downgrade; it does not produce official ranked wins against a fake JEV.

Defaults: eight simultaneous outbound requests, two-second per-attempt timeout, up to one bounded retry, at most600 provider requests per web match,20 active reservations/matches. A fallback is permanent for the attempt. Per-match bounds are not a provider-wide spending cap; configure provider limits and restrict public access as appropriate.

Cost estimates are optional. Set both `JEV_INPUT_USD_PER_MILLION` and `JEV_OUTPUT_USD_PER_MILLION` to your own documented rate snapshot. Leave them blank rather than guessing. The app reports `null` when usage is incomplete.

## 5. Daily challenge publication

Publish in advance:

```bash
npm run puzzles -- --days 7
npm run puzzles -- --date 2026-09-22 --days 7
```

The default start date is the current UTC date; the explicit date above is only a reproducible example. Each date gets four independent unique puzzles, one per opponent profile. Seeds remain private in SQLite. Existing challenges are not overwritten. A previously published challenge with another model is rejected rather than silently mixing model versions.

Arrange a deployment scheduler to keep future dates available. The package does not silently create cron jobs. Publication verifies uniqueness, not an externally standardized human difficulty grade. The generator targets36 clues and records actual clue counts.

## 6. Docker Compose

Install Docker/Compose on the host, point your DNS hostname at it, and allow inbound80/443. With the production `.env` set:

```bash
docker compose up -d --build
docker compose exec app node scripts/puzzles.js --days 7
docker compose exec app node scripts/maintenance.js --integrity
```

The app's database is in the persistent `arcade-data` volume. Caddy handles the public origin; the Node port is exposed to the Compose network, not published directly to the internet. Caddy certificates/configuration use separate persistent volumes.

These templates were not launched in the build environment. Validate volume permissions, healthcheck behavior, DNS/TLS, graceful stop behavior and backups in staging. `docker compose down -v` destroys volumes; do not use it on a production dataset unintentionally.

The optional systemd unit assumes `/opt/jev-sudoku`, a dedicated `jev` user, and Node at `/usr/bin/node`. Adapt paths explicitly. The supplied Caddyfile's upstream `app:3000` is for Compose; on a same-host systemd deployment change it to `127.0.0.1:3000` and configure the hostname in your Caddy environment.

## 7. Operational reporting

Allowlist operator Discord IDs to enable the in-page operator section. Alternatively set `ADMIN_ANALYTICS_TOKEN` and call the read-only report endpoint from an operator environment:

```bash
curl --fail -H "Authorization: Bearer $ADMIN_ANALYTICS_TOKEN" \
  "https://sudoku.example.com/api/analytics/operator?days=30"
```

Do not store that bearer token in browser localStorage. CLI reports require local database access:

```bash
npm run analytics -- --days 30 --out reports/operator.json
npm run analytics -- --match MATCH_ID --out reports/completed-match.json
```

HTTP metrics are application-handler observations, not a replacement for host CPU, disk, TLS and upstream monitoring. `/healthz` reports liveness/draining, not the readiness of Discord or the paid JEV account.

## 8. Backup, retention and restoration

Create a consistent SQLite backup to a new destination:

```bash
npm run maintenance -- --backup backups/arcade-2026-09-22.sqlite
npm run maintenance -- --integrity
npm run maintenance -- --purge
```

The backup command refuses to overwrite an existing file and uses `VACUUM INTO`. In Compose, write into a persistent mounted directory and copy the backup to separately secured storage. Do not rely on the ephemeral container layer as backup storage.

Configure a scheduler for `--purge`. Defaults delete optional browser and operational observations older than30 days, along with expired session/security tokens. Retained provider usage/core replay evidence remains with the result. Affected browser-derived saved reports are recomputed from retained raw evidence.

To restore: stop/drain the app, preserve the previous database safely, restore a tested backup to the configured path with correct ownership, and ensure no mismatched old WAL/SHM files remain alongside it. Start once, run integrity/foreign-key checks, and inspect an existing replay/result. Active games in a restored backup are voided on recovery rather than restarted with fabricated timing.

Backups contain identities, gameplay and possibly detailed telemetry. Encrypt/access-control them, define an expiry policy, and account for user deletion requests in that policy. The in-app delete cannot erase external operator-made backup copies.

## 9. Draining and failure handling

SIGTERM/SIGINT first stops accepting new matches and waits for active games to end. A second signal forces shutdown. Compose allows61 minutes of stop grace for60-minute games. Unexpected restarts recover durable state but mark active attempts void; daily attempts remain consumed.

A ready reservation expires after five minutes or its UTC challenge date boundary. This prevents abandoned countdowns from occupying capacity indefinitely. An event cap or internal verification issue produces an explicit void/failure, not a leaderboard entry.

Do not run multiple independent schedulers over the same database. This release has one authoritative process and a local SQLite volume. Horizontal replication requires a new coordinated scheduling/storage design.

## 9a. GoDaddy Node.js hosting

The app is a plain Node server and runs unchanged on GoDaddy Node hosting (Node 22.16+; the platform runs `npm run build`, then `npm start`).

- Zip layout: repository root contents (`package.json`, `server/`, `shared/`, `public/`, `db/`) plus a production `.env` at the zip root. `npm start` loads it through `--env-file-if-exists=.env`; real process env vars, including the platform-injected `PORT`, win over the file, so leave `PORT` out of `.env`.
- `npm run build` is a no-op (there is no build step).
- Required env: `NODE_ENV=production`, `HOST=0.0.0.0`, `APP_ORIGIN` (HTTPS public origin), `LAUNCH_SIGNING_KEY` (32+ chars), `DATABASE_PATH` (private relative path such as `data/sudoku.sqlite`; the directory is created on start and is never served, only `public/` is). Also `TYPESAFE_API_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, `ADMIN_DISCORD_IDS` as needed. `GAME_DOMAIN` is used only by Docker Compose/Caddy. Keep `TRUST_PROXY=0` unless the proxy is loopback; origin and CSRF checks are unchanged.
- Production mode (HSTS, Secure cookies, required `LAUNCH_SIGNING_KEY`, HTTPS-only origin, default bind `0.0.0.0`) is on when `NODE_ENV=production` or when `APP_ORIGIN` is HTTPS with a non-loopback host, because GoDaddy may override `NODE_ENV`.
- The filesystem is ephemeral: the SQLite database, results and leaderboards are lost on redeploy or host recycle. Active attempts are voided on recovery as usual.
- `SHUTDOWN_GRACE_MS` (for example `25000`) caps the SIGTERM drain so platform restarts cannot hang; when unset the drain waits for active games as described in section 9.

## 10. Staging acceptance

Verify an ordinary desktop/mobile browser can load the app with its CSP, create a guest game, receive native EventSource updates, survive reconnect, complete a puzzle, export analytics, and replay it. Then test Discord login/context, real JEV choices, ranked redaction, provider failure downgrade and scoped results.

Run backup restoration and inspect privacy behavior. Conduct load tests at your actual machine/network capacity. The included smoke benchmark and browser harness are not evidence of public-internet capacity, full accessibility compliance or penetration-test certification.
