# Source basis and integration references

The project follows the user's supplied **JEV Single-Page Game — Architecture & Implementation Planning Prompt**, preserved in `source-prompt.md`, and the Sudoku-specific plan from the conversation. The user's added requirement was detailed/exhaustive analytics plus an actual ZIP implementation. Added metric formulas, privacy defaults, UI design and concrete code are implementation choices, not claims that the original brief specified every field.

Official documentation consulted for external contracts on **September22,2026**:

- TypeSafe quickstart / System One endpoint: https://docs.typesafe.ai/introduction/quickstart
- TypeSafe Choice response and candidate protocol: https://docs.typesafe.ai/primitives/choice
- TypeSafe models / pinned model identifiers: https://docs.typesafe.ai/models
- TypeSafe API errors/retry behavior: https://docs.typesafe.ai/api
- TypeSafe confidence interpretation: https://docs.typesafe.ai/confidence
- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Discord interactions overview: https://docs.discord.com/developers/interactions/overview
- Discord receiving/responding: https://docs.discord.com/developers/interactions/receiving-and-responding
- Node bundled SQLite: https://nodejs.org/api/sqlite.html

The prior Sudoku plan also referenced conventional rules and technique vocabulary:

- Nikoli Sudoku rules: https://www.nikoli.co.jp/en/puzzles/sudoku/
- HoDoKu technique descriptions: https://hodoku.sourceforge.net/en/techniques.php
- WAI-ARIA grid keyboard pattern: https://www.w3.org/WAI/ARIA/apg/patterns/grid/
- SSE platform documentation: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- SQLite WAL deployment constraints: https://www.sqlite.org/wal.html

These references explain external behavior/terminology. They do not certify this repository, its performance, or the correctness of every implementation path. Re-check integration contracts and model availability before a later production deployment. No model pricing is assumed in the package.
