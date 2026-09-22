# JEV Arcade — Sudoku Duel

**You and JEV solve the same Sudoku on separate boards.** A single-page, framework-free game with a server-owned race clock, deterministic replay verification, Discord community leaderboards, and a detailed analytics workbench.

This ZIP contains **working application source**, automated tests, deployment templates, a headless benchmark, screenshots, and metric definitions. It does not contain credentials, a populated player database, or an already deployed service.

![Desktop game](reports/desktop-game.png)

## Start locally

Install a compatible Node runtime. This package was exercised on **Node 22.16.0**; the deployment template targets Node 24. The application uses the bundled `node:sqlite` module, which may emit a runtime stability warning.

```bash
cd jev-sudoku
cp .env.example .env
npm start
```

On Windows Command Prompt, use `copy .env.example .env` instead of `cp`. Open **http://localhost:3000**. No `npm install`, Python, API key, database server, or build step is needed to play.

Without a TypeSafe key, the opponent is prominently labeled **Local heuristic**, and every game is practice. It is not represented as live JEV. Guest progress and history belong to the current server session.

## What is included

| Area | Implemented functionality |
|---|---|
| Game | Two independent 9×9 boards, unique generated puzzles, simultaneous solving, notes, erase, undo, keyboard/touch controls, responsive layout, rules dialog, timed outcomes. |
| Opponent | Easy / Normal / Hard / JEV technique profiles; bounded, structured TypeSafe Choice requests; proof-validated actions; explicit branching; visible decision evidence; honest fallback. |
| Trust | Server-issued puzzle, monotonic timing, ownership checks, ordered action/hash chain, deterministic replay, result verification, one official attempt per daily challenge. |
| Community | Discord OAuth with `identify`, signed user-bound channel launches, Channel / Server / World rankings, equal ranks for equal second buckets. |
| Analytics | Solving cadence, edit heatmaps, progress leads, candidate and technique metrics, confidence/entropy, inference/preprocessing/pacing distributions, usage/cost completeness, optional browser telemetry, personal history, operator funnels/activity/retention, exports. |
| Operations | SQLite persistence, maintenance/backup commands, graceful draining, JSON operational events, privacy controls, Docker Compose and systemd/Caddy templates. |

### Race rules

Complete all rows, columns, and 3×3 boxes with digits 1–9. Starting clues are immutable. Immediate row/column/box conflicts are blocked, but locally legal incorrect guesses remain editable; there is no answer-key feedback.

The first correct completion wins. Completions in the same elapsed one-second bucket tie. When JEV finishes first, you may continue for a verified completion time. A forfeit loses the race. Neither side finishing within 60 minutes produces a timeout draw. Interrupted or expired reservations are **void**, not counted as competitive wins, losses, or draws.

Opponent strength changes techniques and decision budgets, not random mistakes. Ranked action pacing has an eight-second minimum. Opponent difficulty is not a certified puzzle difficulty rating.

## Analytics

Open **Analytics** during or after a game. It provides a progress step chart, 81-cell edit heatmap, solving/decision/reliability panels, a technique table, a decision audit, and a complete versioned JSON report.

![Analytics workbench](reports/desktop-analytics.png)

Reports separate **authoritative server observations** from **optional, forgeable browser observations**. Browser collection is off by default. A confidence value is not calibrated Sudoku accuracy; filled cells are not proof of correctness. Unknown cost and empty denominators are `null`, not invented zeroes.

Use **My stats & privacy** to opt in, remove optional observations, export account data, inspect a replay, or delete stored games/results. Operator analytics require an allowlisted Discord identity or a server-only API bearer token.

The complete field dictionary, formulas, trust labels, retention semantics, and export examples are in **[docs/ANALYTICS.md](docs/ANALYTICS.md)**.

## Enable real JEV and ranked play

1. Set `TYPESAFE_API_KEY` in `.env`. The server calls the TypeSafe API; credentials never go to the browser. The default model is `jev-1.13.0`.
2. Configure Discord application credentials and the OAuth callback described in [Deployment](docs/DEPLOYMENT.md).
3. Publish daily puzzles: `npm run puzzles -- --days 7`.
4. Sign in with Discord. A signed `/jev sudoku` launch supplies server/channel attribution; direct sign-in supports World results only.

A service fallback or answer reveal makes the attempt practice **before** answers/fallback actions are released. The daily attempt stays consumed. A configured key is not proof of healthy external access; verify an actual game with your credentials before opening ranked play publicly.

## Commands

```bash
npm test                                     # Rules, API, auth, replay, analytics tests
npm run test:coverage                        # Optional instrumented test run
npm run benchmark -- --puzzles 2              # Offline selector comparison; no paid calls
npm run puzzles -- --days 7                   # Unique daily puzzle per difficulty
npm run analytics -- --days 30 --out reports/operator.json
npm run analytics -- --match MATCH_ID --format csv --out reports/decisions.csv
npm run maintenance -- --integrity
npm run maintenance -- --backup backups/arcade.sqlite
npm run maintenance -- --purge
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

## Package guide

- [Architecture and API](docs/ARCHITECTURE.md): boundaries, decisions, schemas, diagrams, endpoint contracts.
- [Analytics dictionary](docs/ANALYTICS.md): metrics, distributions, costs, privacy, reports, interpretation.
- [Deployment](docs/DEPLOYMENT.md): configuration, Discord/JEV setup, publishing, hosting, backups.
- [Security and limitations](docs/SECURITY.md): threat coverage and remaining risks.
- [Testing and release evidence](docs/TESTING.md): exact checks and untested boundaries.
- [Source references](docs/SOURCES.md): official documentation used for integration contracts.
- `docs/source-prompt.md`: supplied architectural brief, preserved as source material.
- `reports/`: executed test results, offline benchmark data/transcripts, and browser screenshots.

## Release boundaries

This is a runnable implementation, **not a claim of production certification**. No live Discord account or paid JEV key was available during assembly. External flows were tested with mocks and cryptographic fixtures. The included benchmark measures local selectors, not actual JEV strength.

The browser test used real Chromium and the actual Node API through a localhost HTTP bridge because this environment blocks normal browser URL navigation. It simulated EventSource reconnection by polling. Native SSE was separately tested over Node HTTP; deployed browser networking, CSP enforcement, and HTTPS still need an ordinary staging-browser check. Node 24 and Docker templates are supplied but were not executed here.

Server verification cannot detect all external solvers, multi-account abuse, solution sharing, or modified clients. It verifies recorded rules and outcomes, not unaided human play. Larger-scale load testing, accessibility audits with assistive technology, independent security review, and live-model calibration remain deployment tasks.
