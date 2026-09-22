# Testing and release evidence

## Executed checks

| Check | Observed result | Evidence |
|---|---:|---|
| Node unit/integration tests | **60 passed;0 failed** | `reports/node-tests.tap` |
| Chromium browser scenarios | **9 passed;0 failed** | `reports/browser-results.json`, screenshots |
| Isolated CLI/SQLite maintenance scenarios | **5 passed;0 failed** | `reports/maintenance-results.json` |
| Offline selector benchmark | **24 runs,24 completed,0 invalid transitions** | `reports/benchmark.json`, full decision transcripts |

These are different granularities. Do not add scenario counts to the Node test count and present the sum as a uniform unit-test total. The executable results were produced with Node22.16.0 on Linux. `reports/release-summary.json` records the environment, counts and limitations.

## Node coverage by behavior

Rules tests cover conventional units, immutable givens, wrong-but-locally-legal guesses, replacement, clear/undo, solution uniqueness, independent board arrays, completion, replay reconstruction, tamper rejection, timing buckets, first/second finish, timeouts, deduction legality and explicit backtracking. A finite collection of generated puzzles checks detector actions against independently solved fixtures; this is not a formal exhaustive proof over all Sudoku positions.

Provider tests inject deterministic responses for valid selection, malformed/unknown fields, incorrect model and candidate keys, probability validation, timeout, retry, authorization failure, long Retry-After behavior, forced actions, absent credentials and concurrency limits. No paid API calls are made by `npm test`.

Security tests exercise CSRF, HMAC launch tampering/expiry/audience/subject, real generated Ed25519 signature validation, raw-byte binding, one-use redemption, signed interaction replay rejection, OAuth state binding/expiry, session rotation, identity retrieval mocks and token non-persistence.

Service/API tests cover withholding clues, ownership, revisions, idempotency, forbidden score/time fields, server scheduling without browser polling, live ranked redaction, explicit fallback downgrade, recovery voids, one-attempt tombstones, tied ranks and scope isolation, telemetry consent/schema/purge, account export/delete, expired reservation cleanup and **native HTTP SSE initial/update frames**.

Analytics tests cover action accounting, undo heatmap effects, exact distributions/entropy, missing denominators, cost completeness, client/server trust separation, redaction, streak/profile grouping, void exclusion and CSV injection protection.

An optional `npm run test:coverage` command is supplied. An instrumented run was not completed for this release; **no coverage percentage is claimed**. The passing evidence is from the normal full test run.

## Browser scenarios and environment limitation

The test launches real headless Chromium and checks the actual HTML/CSS/ES-module UI on desktop1440px and mobile390px. It enters values through keyboard events, interacts with controls, and uses an isolated real Node server and temporary SQLite database. A test-only exact solver obtains digits for automated input; it is not part of the production human interface and is not passed to JEV.

The nine scenarios include both81-cell boards, honest local-opponent labeling, pencil marks, entry/undo acknowledgements, opt-in telemetry preference, analytics chart/heatmap, JSON download, full puzzle completion with verified server result, replay scrubbing, leaderboard empty/unauthorized states, reload recovery, mobile overflow/rules access and uncaught JavaScript error checks.

**Transport limitation:** Managed browser policy blocked ordinary URL navigation. The harness therefore mounted the project's own assets in memory and exposed a Python localhost HTTP bridge to the actual Node API. EventSource was simulated by polling. It did not change the browser's administrative policy. This validates rendering, interaction and server-backed workflows, but not ordinary browser network/CSP/HTTPS enforcement as a combined deployed stack. Native SSE was independently exercised by a Node HTTP test.

The script first attempts ordinary browser navigation and only uses the documented bridge when unavailable. Run it in your staging environment and inspect `browserTransport` to see which path executed. An ordinary browser native-SSE/CSP/HTTPS staging check remains required.

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run test:browser
```

The test chooses `CHROMIUM_PATH`, a system Chromium/Chrome, or Playwright Chromium. It starts a temporary local Node server and never kills or modifies a user-configured production service. The script may overwrite generated screenshots/reports when rerun.

## Maintenance scenarios

```bash
npm run test:maintenance
```

This creates an isolated temporary database, a completed practice fixture, and old optional telemetry. It checks unique daily publication and non-overwrite, JSON/CSV/operator CLI exports, optional telemetry expiry with complete-schema recomputation, backup reopening/integrity/foreign keys, and refusal to overwrite a backup. The test removes its temporary database afterward.

This is not a test of Docker volume backup transport, remote storage, filesystem snapshots or recovery on a separate production host. Those are explicit deployment checks.

## Benchmark protocol

```bash
npm run benchmark -- --puzzles 2 --split smoke --out reports/benchmark.json
```

The shipped report covers two independently seeded synthetic puzzle families, four technique profiles and three selectors: canonical first, deterministic greedy and seeded random. Each selector receives the same bounded candidate generation/features for a given profile.24 runs completed with no invalid transitions. This small sample does not demonstrate that the profiles are calibrated or that difficult puzzles are represented.

Unpaced wall time measures local computation during this run. Simulated paced time accumulates minimum8-second action intervals without actually sleeping; production scheduling jitter and simultaneous traffic are excluded. Raw transcripts preserve actions, proofs, candidates and feature budgets.

The report has `liveJevUsed=false`. **It measures local selection baselines, not actual TypeSafe JEV model quality.** For an explicit paid run:

```bash
npm run benchmark -- --live --selectors jev --puzzles 2 --split holdout
```

A missing key or missing `--live` prevents it. Use separate `development` and `holdout` seed namespaces and archive configs/transcripts. Set puzzle/profile/action counts deliberately; the benchmark can generate many requests and is not constrained by the web-match request budget. Compare completion and effort on held-out puzzles before making a JEV strength claim.

## Evidence provenance and privacy

Screenshots contain automated guest sessions only. Included benchmark puzzles are test fixtures, not a published production daily challenge. No real user identity, secret, populated production database or live paid-provider trace is included.

The package contains the source needed to rerun these checks. Passing finite tests are evidence for the tested behaviors, not production certification, proof of universal correctness or an assertion of unaided-human anti-cheat.
