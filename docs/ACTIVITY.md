# Discord Activity mode

Discord can launch this game as an Activity: it loads the game in an iframe on
`https://<DISCORD_CLIENT_ID>.discordsays.com`, which Discord proxies to the Worker at `sudoku.jevplay.games`.
Nothing changes for the normal browser flow; Activity behaviour is only enabled when the page
URL carries Discord's `frame_id` query parameter.

## How it works

1. `public/activity.js` (loaded only when `frame_id` is present) loads the vendored Embedded App SDK
   (`public/vendor/discord-embedded-app-sdk.js`, see `THIRD_PARTY_NOTICES.md`), calls
   `sdk.commands.authorize` (scope `identify`) and posts the code to `POST /api/activity/session`.
2. The server exchanges the code with the game's existing `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
   and **no `redirect_uri`**, upserts the user exactly like the OAuth callback, and issues a 24-hour session.
   It returns a bearer token, the CSRF token and the Discord access token (needed once by
   `sdk.commands.authenticate`). Only the token's hash is stored; the access token is never stored.
3. The client keeps the bearer token in memory and sends `Authorization: Bearer <token>`. Browsers do not
   send the SameSite cookie inside the iframe. The game reads match state by polling `GET /api/matches/:id`
   with the same bearer header, so no special stream reader is needed (the old fetch-based event reader was removed with SSE).
4. `requireCsrf` accepts `Origin: https://<DISCORD_CLIENT_ID>.discordsays.com` **only for bearer sessions**.
   Cookie sessions, other origins and other applications' `discordsays.com` origins are still rejected, and
   the CSRF token is still required.
5. Only a non-API document loaded with `frame_id` drops `X-Frame-Options` and gets
   `frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com`; the rest of
   the CSP (`script-src 'self'`, ...) is unchanged. All other responses, including every `/api/*`
   response, remain `DENY` / `frame-ancestors 'none'`.

`GET /api/activity/config` returns the public client id. Session creation is rate limited per remote
address (300/hour, kept in D1 so every isolate shares it; the address is Cloudflare's `cf-connecting-ip`). The signed `LAUNCH_SIGNING_KEY` flow for `/jev sudoku` is untouched.

## Discord developer portal

- Enable **Activities** for the application.
- URL Mappings: prefix `/` -> target `sudoku.jevplay.games` (no scheme).
- Discord creates a primary **Entry Point** command when Activities are enabled. `npm run discord:register`
  registers `/jev sudoku` with a single POST (create/update by name), so it does not remove the Entry Point.
  If it is ever changed to a bulk overwrite, the Entry Point command must be included or it will be deleted.

No new environment variables are needed.
