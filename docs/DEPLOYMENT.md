# Deployment (Cloudflare Workers + D1, free plan)

JEV Sudoku runs as one Cloudflare Worker with a D1 database and static assets, served at **https://sudoku.jevplay.games**. It
needs no server, no container and no paid plan. The earlier Docker/Caddy/systemd and GoDaddy Node deployments were removed
(they remain in git history); nothing in this document depends on them. The same handler runs locally through `npm start`.

Read [WORKERS.md](WORKERS.md) first if you want to know *why* it is built this way (no timers, lazy scheduling, CPU and
query budgets, what happens to an abandoned match). This page is the operator checklist.

## What is deployed

| Piece | Where |
|---|---|
| Worker (`server/worker.js`, `wrangler.jsonc`) | name `jev-sudoku`, custom domain `sudoku.jevplay.games` |
| Database | D1 `jev-sudoku` (binding `DB`), schema in `migrations/` |
| Static game | `public/` through the `ASSETS` binding; the Worker sees `/api/*` and `/` only (`run_worker_first`) |
| Crons / Durable Objects / containers | none (the account's five free cron triggers are already used) |

## One-time setup

Run these from the repository root (`jev-sudoku/`). `npm run deploy` and the `db:*` scripts call `npx wrangler@4.35.0`, so no
install is needed. Log in once with `npx wrangler login`.

1. **Create the database**

   ```sh
   npx wrangler d1 create jev-sudoku
   ```

   Copy the printed `database_id` over `REPLACE_WITH_D1_ID` in `wrangler.jsonc`.

2. **Apply the migrations** (schema plus the 300-puzzle practice pool)

   ```sh
   npm run db:remote
   ```

3. **Set secrets** (never in `wrangler.jsonc`, never in git). Names only here:

   | Name | Required | Purpose |
   |---|---|---|
   | `LAUNCH_SIGNING_KEY` | yes | 32+ random characters; signs Discord launch links and derives quota keys. Generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. The Worker refuses to serve (503 `configuration_invalid`) without it on a public origin. |
   | `TYPESAFE_API_KEY` | for live JEV and ranked play | Sent only to `https://api.typesafe.ai/v1/systemone`. Without it the opponent is the labeled local heuristic and every game is practice. |
   | `DISCORD_CLIENT_SECRET` | for Discord sign-in | OAuth code exchange (also used by Activity sign-in). |
   | `ADMIN_ANALYTICS_TOKEN` | optional | Bearer token for `GET /api/analytics/operator`. |

   ```sh
   npx wrangler secret put LAUNCH_SIGNING_KEY      # repeat for each name above
   ```

   `DISCORD_CLIENT_ID`, `DISCORD_PUBLIC_KEY` and `ADMIN_DISCORD_IDS` (comma-separated user IDs) are not secret; set them with
   `wrangler secret put` or add them to `vars` in `wrangler.jsonc`.

   Tunable `vars` already in `wrangler.jsonc`: `APP_ORIGIN`, `JEV_MODEL` (`jev-1.13.0`), `PRACTICE_PACING_MS`,
   `MAX_ACTIVE_MATCHES`, `MAX_JEV_CALLS_PER_DAY`, `JEV_CALLS_PER_HOUR`, `MAX_JEV_REQUESTS_PER_MATCH`, `ABANDONED_AFTER_MS`,
   `TELEMETRY_RETENTION_DAYS`, `OPERATIONS_RETENTION_DAYS`. Optional: `JEV_TIMEOUT_MS`, `MAX_MATCH_EVENTS`,
   `JEV_INPUT_USD_PER_MILLION` / `JEV_OUTPUT_USD_PER_MILLION` (both blank means unknown cost, never zero), `ADMIN_DISCORD_IDS`.
   Full list with defaults: `.env.example`.

4. **Deploy**

   ```sh
   npm run deploy
   ```

   The `routes` entry (`custom_domain: true`) creates the DNS record and certificate for `sudoku.jevplay.games` on deploy, provided the
   `jevplay.games` zone is on the same Cloudflare account. If DNS for the zone is still elsewhere, move it first.

5. **Publish ranked daily puzzles** (only needed for ranked play). They are secret until played, so they are generated locally and
   loaded with `INSERT OR IGNORE` (never overwriting an existing day). Do not commit the file.

   ```sh
   npm run puzzles -- --date 2026-10-01 --days 14 --sql .data/challenges.sql
   npx wrangler d1 execute jev-sudoku --remote --file .data/challenges.sql
   ```

   Ranked mode reports `daily_challenge_not_published` when today's puzzle for a difficulty is missing. Put a reminder in your
   calendar: there is no scheduler to publish more.

6. **Discord** (only if you use community features)
   - Interactions Endpoint URL: `https://sudoku.jevplay.games/api/discord/interactions` (Discord sends a signed ping; the Worker
     verifies it with Web Crypto and `DISCORD_PUBLIC_KEY`).
   - OAuth2 redirect: `https://sudoku.jevplay.games/api/auth/discord/callback`, scope `identify`.
   - Register the slash command from your machine with the same variables in `.env`: `npm run discord:register`
     (`DISCORD_TEST_GUILD_ID` limits it to one guild for instant registration).
   - Activity mode: see [ACTIVITY.md](ACTIVITY.md) (URL mapping `/` to `sudoku.jevplay.games`).
   - `LAUNCH_SIGNING_KEY` must not change while launch links are outstanding (they live ten minutes).

7. **Verify**

   ```sh
   curl https://sudoku.jevplay.games/api/health            # {"status":"ok","runtime":"workers"}
   curl -s -o /dev/null -w "%{http_code}\n" https://sudoku.jevplay.games/api/analytics/operator   # 403
   ```

   Then play a practice game in a browser (the page polls once a second while a race runs). For ranked play, do one real game
   with your key and confirm the decisions are labeled `jev` in Analytics before opening it to others. A configured key is not
   proof of healthy provider access.

## Everyday operations

| Task | Command |
|---|---|
| Deploy a change | `npm test && npm run deploy` |
| New migration | add `migrations/0003_name.sql`, then `npm run db:remote` (apply before deploying code that needs it) |
| Live logs | `npx wrangler tail jev-sudoku` |
| Roll back the Worker | `npx wrangler rollback` (database migrations are not rolled back) |
| Back up D1 | `npx wrangler d1 export jev-sudoku --remote --output backup.sql` (contains player data; keep it private) |
| Operator analytics | `curl -H "Authorization: Bearer $ADMIN_ANALYTICS_TOKEN" "https://sudoku.jevplay.games/api/analytics/operator?days=30"` (cached five minutes; add `&fresh=1` to bypass) |
| Inspect a table | `npx wrangler d1 execute jev-sudoku --remote --command "SELECT COUNT(*) FROM matches"` |

Retention and cleanup run **lazily**: a request to a light endpoint occasionally runs one bounded sweep (at most once a minute, gated
by a row in `meta`) that voids abandoned matches, retries a finished match whose result write failed, and purges expired sessions,
tokens, quota windows, operations and optional telemetry. There is nothing to schedule and nothing to monitor beyond the free-plan
dashboards. If traffic is zero, nothing is cleaned up, and nothing needs to be.

## Free-plan limits this design lives inside

| Limit (Workers Free / D1 Free) | How the design respects it |
|---|---|
| 10 ms CPU per request | Hot paths measured at 0.2 to 6 ms; see [WORKERS.md](WORKERS.md) for the numbers and the paths that are over |
| 50 queries per invocation | Opponent steps applied per request are capped by profile; tests count statements per invocation |
| 100,000 requests per day | The game polls once a second in a visible tab (4 s hidden) only while a race is running. Ten minutes of play is about 600 requests, so budget roughly 150 such games a day |
| D1 100,000 rows written per day, 5 M read | A full game writes a few hundred rows; retention sweeps keep tables small. Watch the D1 dashboard if you open ranked play widely |
| 5 cron triggers per account | Not used |
| 128 MB memory | The largest object handled is one game's event log (about 1 MB for a long `jev`-profile game) |

If usage outgrows the free plan the code does not change; the limits do. The provider quotas (`MAX_JEV_CALLS_PER_DAY`,
`JEV_CALLS_PER_HOUR`, `MAX_JEV_REQUESTS_PER_MATCH`) are the spend controls: when a quota is exhausted the opponent falls back to the
labeled heuristic and the game becomes practice, it never blocks and never relabels the decision.

## Local development

```sh
cp .env.example .env      # optional
npm start                 # http://localhost:3000, database .data/sudoku.sqlite, Node >= 22.16
npm test
```

`npm start` runs `local/server.js`: a small Node adapter that turns `http` requests into the Worker's `handle(request, env, ctx)` call,
serves `public/` as `env.ASSETS`, and provides `env.DB` from `node:sqlite` behind a D1-compatible interface (`prepare().bind().first()/all()/run()`,
`batch()`). The migrations in `migrations/` are applied on open, so local and Cloudflare databases have the same schema. A
database file written by the old container build is refused with a clear message; point `DATABASE_PATH` at a new file.

Wrangler's own local mode also works (`npm run db:local`, then `npx wrangler dev`) but is not required.

Local ranked play needs `TYPESAFE_API_KEY`, a Discord application and `npm run puzzles -- --days 3`.

## Historical note

Earlier revisions were deployed as a Docker container behind Caddy (and once to GoDaddy Node hosting) with an in-process match
scheduler and a 60-minute drain on shutdown. Those files, the `SHUTDOWN_GRACE_MS`, `HOST`, `GAME_DOMAIN`, `NODE_ENV` and
`MAX_OUTBOUND_JEV_REQUESTS` settings, and the `/healthz` and `/api/matches/:id/events` (SSE) routes no longer exist. There is no data
migration: the Cloudflare database starts empty, and container-era SQLite files are not compatible.
