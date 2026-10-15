<p align="center"><img src="assets/banner.png" alt="Flat pink and ink pixel-window banner for Typedoku showing two sudoku boards racing side by side, a typed next-action panel and the Jev robot" width="100%"></p>

<div align="center">

# Typedoku

**Race Jev on the same Sudoku with separate boards, a server-owned clock and every decision on the record.**

![Play: typedoku.jevplay.games](https://img.shields.io/badge/Play-typedoku.jevplay.games-F386A1?style=flat-square&labelColor=1E1E1E)
![Status: live](https://img.shields.io/badge/Status-live-E551BA?style=flat-square&labelColor=1E1E1E)
![Node: 22.16+](https://img.shields.io/badge/Node-22.16%2B-F386A1?style=flat-square&labelColor=1E1E1E)
![License: MIT](https://img.shields.io/badge/License-MIT-DEDEDE?style=flat-square&labelColor=1E1E1E)

[Quick start](#quick-start) · [How it works](#how-it-works) · [What is included](#what-is-included) · [Analytics](#analytics) · [Enable real Jev and ranked play](#enable-real-jev-and-ranked-play) · [Commands](#commands) · [Repository layout](#repository-layout) · [Contributing](#contributing)

</div>

---

Typedoku is a Sudoku race: you and Jev get the same puzzle on separate boards, and the first correct completion wins. Jev answers each move as a typed `Choice` question, so every digit it places comes with validated evidence you can inspect. It is a single-page, framework-free game on one **Cloudflare Worker with D1** at **https://typedoku.jevplay.games**, part of [jevplay.games](https://jevplay.games); it was called Sudoku Duel before the rename.

> [!NOTE]
> **What is shipped and measured.** This is a runnable implementation, not a claim of production certification. No live Discord account or paid Jev key was available during assembly; external flows were tested with mocks and cryptographic fixtures, and the included benchmark measures local selectors, not Jev's actual strength. See [Release boundaries](#release-boundaries).

![Typedoku in a desktop browser: your board on the left, Jev's board on the right, with the race clock above.](reports/desktop-game.png)

## Quick start

Node **22.16 or newer** is required (built-in `node:sqlite` and `node --test`; Node prints an experimental SQLite warning).

```bash
cp .env.example .env      # optional
npm start
```

Open **http://localhost:3000**. No `npm install`, Python, API key, database server or build step is needed to play. `npm start` runs the exact Worker Cloudflare runs behind a small Node adapter (`local/server.js`) with `node:sqlite` standing in for D1.

Without a TypeSafe key, the opponent is prominently labeled **Local heuristic**, and every game is practice. It is not represented as live Jev. Guest progress and history belong to the current session.

## How it works

```mermaid
%%{init: {"theme": "base", "themeVariables": {"lineColor": "#E551BA", "fontFamily": "Inter, sans-serif"}}}%%
flowchart LR
  B["Browser<br/>public/, no build"]:::ink -->|"/api/* polls and actions"| W["Worker handle()<br/>server/worker.js"]:::pink
  W --> R["Rules and match engine<br/>public/shared/"]:::grey
  W --> D[("D1<br/>matches, events, results")]:::grey
  W -->|"typed Choice request"| J["TypeSafe API<br/>Jev"]:::ink
  W <-->|"OAuth, signed /jev typedoku"| X["Discord"]:::ink
  N["local/server.js<br/>npm start, Train container"]:::grey -->|"same handle()"| W
  classDef ink fill:#1E1E1E,stroke:#1E1E1E,color:#FEFEFE
  classDef pink fill:#F386A1,stroke:#1E1E1E,color:#1E1E1E
  classDef grey fill:#DEDEDE,stroke:#1E1E1E,color:#1E1E1E
```

The server issues the puzzle and owns the clock. Every human action and every Jev decision is appended to a hash-chained event log with compare-and-swap, validated against the rules, and replayable offline.

### Race rules

Complete all rows, columns, and 3×3 boxes with digits 1–9. Starting clues are immutable. Immediate row/column/box conflicts are blocked, but locally legal incorrect guesses remain editable; there is no answer-key feedback.

The first correct completion wins. Completions in the same elapsed one-second bucket tie. When Jev finishes first, you may continue for a verified completion time. A forfeit loses the race. Neither side finishing within 60 minutes produces a timeout draw. Expired reservations and attempts abandoned for ten minutes are **void**, not counted as competitive wins, losses, or draws.

Opponent strength changes techniques and decision budgets, not random mistakes. Ranked action pacing has an eight-second minimum. Opponent difficulty is not a certified puzzle difficulty rating.

There is no server process to keep the opponent moving between requests, so the browser polls once a second while a race runs and every poll lets the server apply any opponent step that has become due. Opponent moves are stamped with their scheduled time. See [docs/WORKERS.md](docs/WORKERS.md).

## What is included

| Area | Implemented functionality |
|---|---|
| Game | Two independent 9×9 boards, unique-solution puzzles, simultaneous solving, notes, erase, undo, keyboard/touch controls, responsive layout, rules dialog, timed outcomes. |
| Opponent | Easy / Normal / Hard / Jev technique profiles; bounded, structured TypeSafe Choice requests; proof-validated actions; explicit branching; visible decision evidence; honest fallback. |
| Trust | Server-issued puzzle, server clock, ownership checks, compare-and-swap event log with a hash chain, per-append validation, verified results, one official attempt per daily challenge. |
| Community | Discord OAuth with `identify`, signed user-bound channel launches, Discord Activity mode, Channel / Server / World rankings, equal ranks for equal second buckets. |
| Analytics | Solving cadence, edit heatmaps, progress leads, candidate and technique metrics, confidence/entropy, inference/preprocessing/pacing distributions, usage/cost completeness, optional browser telemetry, personal history, operator funnels/activity/retention, exports. |
| Operations | Cloudflare Workers + D1, lazy bounded maintenance (no cron), D1-reserved provider quotas, privacy controls, JSON operational events. |

## Analytics

Open **Analytics** during or after a game. It provides a progress step chart, 81-cell edit heatmap, solving/decision/reliability panels, a technique table, a decision audit, and a complete versioned JSON report.

![The analytics workbench: a progress step chart, an 81-cell edit heatmap and decision panels for one finished race.](reports/desktop-analytics.png)

Reports separate **authoritative server observations** from **optional, forgeable browser observations**. Browser collection is off by default. A confidence value is not calibrated Sudoku accuracy; filled cells are not proof of correctness. Unknown cost and empty denominators are `null`, not invented zeroes.

Use **My stats & privacy** to opt in, remove optional observations, export account data, inspect a replay, or delete stored games/results. Operator analytics require an allowlisted Discord identity or a server-only API bearer token.

The complete field dictionary, formulas, trust labels, retention semantics, and export examples are in **[docs/ANALYTICS.md](docs/ANALYTICS.md)**.

## Enable real Jev and ranked play

1. Set `TYPESAFE_API_KEY` (`.env` locally, a Wrangler secret on Cloudflare). The Worker calls the TypeSafe API; credentials never go to the browser. The default model is `jev-1.13.0`.
2. Configure the Discord application credentials and callbacks described in [Deployment](docs/DEPLOYMENT.md).
3. Publish daily puzzles out of band (they are secret until played): `npm run puzzles -- --days 7` locally, or `--sql` to produce a file for `wrangler d1 execute`.
4. Sign in with Discord. A signed `/jev typedoku` launch supplies server/channel attribution; direct sign-in supports World results only.

A service fallback, quota exhaustion or answer reveal makes the attempt practice **before** answers/fallback actions are released. The daily attempt stays consumed. A configured key is not proof of healthy external access; verify an actual game with your credentials before opening ranked play publicly.

## Commands

```bash
npm start                                    # local Worker adapter, .data/sudoku.sqlite
npm test                                     # rules, API, auth, scheduling, budgets, analytics, runtime
npm run bench:requests                       # CPU + D1-query benchmark of the hot request paths
npm run benchmark -- --puzzles 2             # offline selector comparison; no paid calls
npm run puzzles -- --days 7                  # ranked daily puzzles into the local database
npm run puzzles -- --days 7 --sql .data/challenges.sql   # ...or as SQL for D1
npm run analytics -- --days 30 --out reports/operator.json
npm run maintenance -- --integrity           # local database file only
npm run deploy                               # wrangler deploy (Worker jev-typedoku)
npm run db:remote                            # D1 migrations (database keeps its pre-rename name)
npm run discord:register                     # (re)register /jev typedoku
```

The optional browser smoke test needs Python, Playwright, and Chromium, but these are **not application dependencies**:

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run test:browser
```

A paid live-model benchmark requires both a configured key and an explicit opt-in:

```bash
npm run benchmark -- --live --selectors jev --puzzles 2 --split holdout
```

Review the number of puzzles, profiles, and maximum actions before running it. The benchmark is not capped by the web match request budget.

### Documentation

- [Deployment](docs/DEPLOYMENT.md): Cloudflare setup, secrets, D1, DNS, Discord, operations, free-plan limits, local development.
- [Workers design](docs/WORKERS.md): how the match lifecycle works without timers, voiding semantics, integrity, CPU and query measurements, remaining risks.
- [Architecture and API](docs/ARCHITECTURE.md): boundaries, decisions, schemas, diagrams, endpoint contracts.
- [Analytics dictionary](docs/ANALYTICS.md): metrics, distributions, costs, privacy, reports, interpretation.
- [Discord Activity](docs/ACTIVITY.md): running the game inside Discord.
- [Security and limitations](docs/SECURITY.md): threat coverage and remaining risks.
- [Testing and release evidence](docs/TESTING.md): exact checks and untested boundaries.
- [Source references](docs/SOURCES.md): official documentation used for integration contracts.
- `docs/source-prompt.md`: supplied architectural brief, preserved as source material.
- `reports/workers/`: regenerated evidence for the Cloudflare build (request CPU benchmark, tests, browser and maintenance smoke). `reports/*` outside that folder is the original container-era evidence, kept as history.

## Repository layout

```text
public/                 Static game: index.html, game.js, game.css, brand/ (shared jevplay.games kit), art/
public/shared/          Pure rules, match engine, replay and analytics, shared by browser and server
server/                 Worker: routing, auth and Discord, matches, Jev client, reports, maintenance
local/                  Node adapter (npm start, Train container) and the node:sqlite D1 shim
migrations/             D1 schema and the practice puzzle pool
scripts/                Benchmarks, puzzle publishing, analytics, Discord registration, browser smoke
fixtures/               Golden candidates, rule cases and a pre-rename replay
tests/                  node --test suites
docs/                   Deployment, Workers design, architecture, analytics, security, testing, sources
reports/                Screenshots and release evidence (history; not rewritten by the rename)
wrangler.jsonc          Worker jev-typedoku, routes, D1 binding, vars
```

### Release boundaries

This is a runnable implementation, **not a claim of production certification**. No live Discord account or paid Jev key was available during assembly, and the Worker has not been deployed to Cloudflare from this repository yet. External flows were tested with mocks and cryptographic fixtures. The included benchmark measures local selectors, not actual Jev strength.

CPU figures were measured on Node/V8, not on the Workers runtime; cold `jev`-profile opponent steps sit within a few milliseconds of the 10 ms free-plan limit ([docs/WORKERS.md](docs/WORKERS.md)). Deployed browser networking, CSP enforcement and HTTPS on the real origin still need an ordinary staging check.

Server verification cannot detect all external solvers, multi-account abuse, solution sharing, or modified clients. It verifies recorded rules and outcomes, not unaided human play. Larger-scale load testing, accessibility audits with assistive technology, independent security review, and live-model calibration remain deployment tasks.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening one, keep `public/shared/` free of DOM and I/O, and do not change stored identifiers without a version bump: the replay format `jev-sudoku-replay`, `RULES_VERSION` `sudoku-v1` and the `sudoku-policy-v1` benchmark cohort describe the rules, not the product, and replays exported before the Typedoku rename must keep loading. Licensed under the [MIT License](LICENSE).

<p align="center">
<sub>A jevplay.games game · Steward: CompleteTech LLC · MIT licensed<br>
Not an official TypeSafe AI publication; the pink, ink and pixel-window styling is a nod to <a href="https://typesafe.ai">typesafe.ai</a>. Jev, System One and TypeSafe are their respective owners' names.</sub>
</p>
