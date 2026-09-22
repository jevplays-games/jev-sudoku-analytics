# Generated release evidence

- `release-summary.json`: environment, test counts and explicit unverified boundaries.
- `node-tests.tap`: full60-test Node run;0 failures.
- `browser-results.json`: nine real Chromium DOM scenarios with the documented localhost bridge limitation.
- `desktop-game.png`, `desktop-analytics.png`, `mobile-game.png`: automated guest test screenshots.
- `maintenance-results.json`: five isolated CLI/SQLite maintenance scenarios.
- `benchmark.json`:24 offline local-selector runs on two synthetic families, not live JEV evaluation.
- `benchmark-transcripts.ndjson`: one full decision trace per puzzle/profile/selector run.
- Console/log files: reproducible execution context; no live credentials or real player records.

The benchmark is deliberately labeled synthetic/local. The screenshots' short times reflect automated input and accelerated practice pacing, not human performance or paid-model speed. Browser networking used a localhost bridge because URL navigation was blocked by the environment; see `docs/TESTING.md`.
