# Source basis and integration references

The project follows the user's supplied **JEV Single-Page Game — Architecture & Implementation Planning Prompt**, preserved in `source-prompt.md`, and the Sudoku-specific plan from the conversation. The user's added requirement was detailed/exhaustive analytics plus an actual ZIP implementation. Added metric formulas, privacy defaults, UI design and concrete code are implementation choices, not claims that the original brief specified every field.

Official documentation consulted for external contracts on **September22,2026** (Cloudflare references added for the Workers deployment; the exact limits figures should be re-checked against the current pages before relying on them):

- TypeSafe quickstart / System One endpoint: https://docs.typesafe.ai/introduction/quickstart
- TypeSafe Choice response and candidate protocol: https://docs.typesafe.ai/primitives/choice
- TypeSafe models / pinned model identifiers: https://docs.typesafe.ai/models
- TypeSafe API errors/retry behavior: https://docs.typesafe.ai/api
- TypeSafe confidence interpretation: https://docs.typesafe.ai/confidence
- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Discord interactions overview: https://docs.discord.com/developers/interactions/overview
- Discord receiving/responding: https://docs.discord.com/developers/interactions/receiving-and-responding
- Node bundled SQLite (local adapter): https://nodejs.org/api/sqlite.html
- Cloudflare Workers limits (free plan CPU time, subrequests, cron triggers): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 (limits, batch, migrations, free-plan quotas): https://developers.cloudflare.com/d1/platform/limits/
- Workers Static Assets and `run_worker_first`: https://developers.cloudflare.com/workers/static-assets/
- Wrangler configuration and custom domains: https://developers.cloudflare.com/workers/wrangler/configuration/
- Web Crypto Ed25519 in Workers: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

The prior Sudoku plan also referenced conventional rules and technique vocabulary:

- Nikoli Sudoku rules: https://www.nikoli.co.jp/en/puzzles/sudoku/
- HoDoKu technique descriptions: https://hodoku.sourceforge.net/en/techniques.php
- WAI-ARIA grid keyboard pattern: https://www.w3.org/WAI/ARIA/apg/patterns/grid/

These references explain external behavior/terminology. They do not certify this repository, its performance, or the correctness of every implementation path. Re-check integration contracts and model availability before a later production deployment. No model pricing is assumed in the package.
