# Analytics specification and metric dictionary

**Implementation:** `shared/analytics.js`, `server/telemetry.js`, `server/reports.js`, `public/analytics-ui.js`.

**Schemas:** `analytics-v1` per match; `operator-analytics-v1` operator summary; `benchmark-v1` headless experiments. These identifiers describe the shipped schemas, not an externally standardized format.

## 1. Evidence and trust

| Layer | Source | Trust and visibility |
|---|---|---|
| Rules/replay | Server-assigned timestamped transitions | Authoritative for this application's recorded state and race result. Does not establish unaided human reasoning. |
| Provider observations | Server-observed request attempts, validated typed responses | Authoritative for what the server observed. Provider token usage may be absent; returned confidence is not an accuracy estimate. |
| Browser observations | Explicitly opted-in, schema-validated client events | Optional, incomplete and forgeable. Never determines score, elapsed time, winner, or eligibility. |
| Aggregation | Recomputed from retained records | Descriptive and dependent on retention, deletion, query window, and model/policy version. |

Every per-match report contains `schemaVersion`, `computedThroughMs`, `complete`, `dimensions`, `game`, `human`, `jev`, `browser`, `timeline`, and `caveats`.

`computedThroughMs` is the elapsed point covered by the report. A live report is a snapshot, not a complete-game total. Server request usage that arrives after a game ends updates its stored analytics snapshot; the replay and result remain unchanged. A briefly stale completed snapshot is possible while an already-started provider call is outstanding.

### Distributions

Every distribution is `{n, min, max, mean, median, p90, p95, p99, stddev}`. Non-finite observations are excluded. With no observations, `n=0` and all other fields are `null`.

Percentiles use linear interpolation at sorted index `(n−1) × p`. Standard deviation is the population statistic `sqrt(sum((x−mean)^2)/n)`. Small samples remain labeled with their actual `n`; a p99 from two observations is not strong tail-latency evidence. Millisecond fields are always milliseconds; fractions are 0–1.

## 2. Dimensions and reproducibility

`dimensions.difficulty`: `easy`, `normal`, `hard`, or `jev`.

`puzzleBand`: the generator label `standard-v1`; **not** a solver-certified human difficulty category.

`mode`: originally requested `practice` or `ranked`. `game.eligibility` records the current eligibility separately; a ranked attempt may subsequently become practice or void.

`policyVersion`, `model`, `rulesVersion`: pinned configuration. The model field is a configuration label, not proof that the provider was called. Check `jev.modelDecisions`, `jev.models`, and decision `source` for actual use.

Per-game comparisons should match challenge, difficulty, rules, model, policy, and cadence. Cross-puzzle solve-time averages are descriptive only; they are not normalized skill rankings.

## 3. Game and progress metrics

| Field | Definition |
|---|---|
| `phase` | Ready, running, settling, or finished. |
| `outcome` | Human, JEV, draw, or pending. Void games have a neutral terminal outcome internally but are excluded from the competitive record. |
| `eligibility` / `ineligibleReason` | Ranked, practice, or void, with the first downgrade/void explanation. |
| `initialClues` / `initialEmpty` | Fixed clue count and `81 − initialClues`. |
| `durationMs` | Covered elapsed server time; includes the human's post-JEV completion continuation and finish-bucket settling when applicable. |
| `humanFinishMs` / `jevFinishMs` | Accepted correct completion timestamps; absent completions are `null`. |
| `humanCompleted` | Whether a valid human completion was recorded. |
| `completionFraction` | Currently filled editable human cells divided by initial empty cells. Not correctness. |
| `raceDeltaMs` | Human finish minus opponent finish, only when both exist. Positive means the human finished later. |
| `humanLeadMs` / `jevLeadMs` / `tiedProgressMs` | Time spent with more, fewer, or equal filled editable cells, integrated over the step timeline through the report's endpoint. |
| `progressLeadChanges` | Changes between nonzero human-leading and JEV-leading signs; equal-progress plateaus do not themselves add a switch. |
| `maxHumanProgressLead` / `maxJevProgressLead` | Largest filled-cell advantage observed for each side. |
| `timeline[]` | `{ms,human,jev,lead}` after relevant transitions. Human and JEV are filled editable cell counts; lead is human minus JEV. |

The progress chart is stepped rather than linearly interpolated, because a digit is placed at a discrete time. Clears, undo, and JEV backtracking can reduce apparent progress. No hidden answer key is consulted to color cells as correct/incorrect.

## 4. Human solving behavior

| Field | Definition |
|---|---|
| `acceptedActions` | Accepted human transitions, including set, clear, undo, and forfeit. |
| `placements` / `replacements` | Set into an empty editable cell versus changing an already filled editable cell. |
| `clears` / `undos` / `forfeits` | Counts by accepted action kind. |
| `firstActionMs` | First accepted human action time; a forfeit can be the first action. `null` until an action exists. |
| `cellEdits[81]` | Accepted cell-affecting edits, including the cell restored by undo. A forfeit affects no cell. |
| `rowEdits[9]` / `columnEdits[9]` / `boxEdits[9]` | Corresponding edit counts aggregated by unit. |
| `filledEditableCells` | Current human filled-cell count minus initial clues. |
| `distinctCellsEdited` | Number of nonzero entries in the cell edit vector. |
| `repeatedCellEdits` | Sum of `max(0, cellEdits[i]−1)` across cells. |
| `moveIntervalsMs` | Distribution of gaps between consecutive accepted human actions. First-action latency is separate. |
| `actionsPerMinute` | `acceptedActions / (durationMs/60000)`; `null` at zero elapsed time. |
| `editEfficiency` | For completed games, `initialEmpty / max(initialEmpty,acceptedActions)`; otherwise `null`. A mechanical edit ratio, not an intelligence measure. |
| `acceptedActionRate` | Accepted actions divided by accepted actions plus recorded server action rejections. `null` when both are zero. |
| `rejectedRequests` / `rejectionsByReason` | Server action failures recorded by the match handler, including stale revision and local conflict failures. Not every HTTP admission/schema failure reaches this handler. |
| `localConflictRejections` | Recorded server rejections specifically caused by a row/column/box conflict. |
| `rejectionsAreNotSolutionErrors` | Always true: this game does not derive a hidden-solution mistake count. |

Move intervals include thought, idle time, network transit, and input behavior. They are not direct measures of cognitive processing time. Local browser blocks can prevent a bad action from being sent, so server rejection rate alone is not a full picture of attempted input.

## 5. JEV actions, decisions, and distributions

| Field | Definition |
|---|---|
| `appliedActions` | Accepted opponent transitions, including placement, elimination, assumption, and backtrack. |
| `decisionSources` | Counts by `jev`, `forced`, `heuristic`, `heuristic_fallback`, or another explicit replay/benchmark source. |
| `modelDecisions` / `forcedActions` / `heuristicActions` / `fallbackActions` | Source-specific counts. A forced action does not invoke the model. |
| `models` | Actual non-null model identifiers on applied decisions. |
| `techniques` / `actionKinds` | Histograms of proof technique and elementary effect. |
| `assumptions` / `backtracks` / `peakBranchDepth` | Search behavior exposed explicitly rather than hidden as solved digits. |
| `candidateCount` | Distribution of candidate counts offered after pruning. |
| `rawCandidateCount` / `prunedCandidates` | Before-pruning distribution and cumulative number excluded. |
| `previewSteps` | Total bounded feature-preview transitions, not actual played moves. |
| `confidence` | Distribution of provider-returned concentration/confidence values where present. |
| `entropyBits` | `−sum(p log2 p)` for each returned candidate distribution. |
| `topTwoMargin` | Highest probability minus second highest; 1 for a singleton distribution. |
| `preprocessingMs` | Candidate/feature generation time measured by the runtime. On Cloudflare Workers `performance.now()` does not advance during pure computation, so this reads about 0 in production; locally it is real. |
| `inferenceMs` | Adapter-level selection latency, potentially including retry handling. |
| `pacingWaitMs` | Time a completed decision waited before application, measured against the scheduled (stamped) application time. |

Model confidence, candidate probability, entropy and margin are **not calibrated probabilities of Sudoku correctness**. Validity comes from deterministic proof regeneration and legal transition checks. The engine supplies permitted deductions, and JEV chooses among them; this evaluates policy selection inside a hybrid solver, not unconstrained neural Sudoku solving.

### Decision audit records

`jev.decisions[]` includes sequence, elapsed time, source, actual model, action ID/kind, technique, cell, digit, offered/raw/pruned candidate counts, confidence, selected probability, entropy, top-two margin, inference/preprocessing/wait time, preview transitions, branch depth, full probability map, proof certificate, and candidate evidence.

While ranked play is unfinished, the API removes **action IDs, coordinates, digits, probabilities keyed by action ID, proof details, and candidate evidence**. The same protection applies to JSON/CSV exports and account export. The UI shows at most the last 500 audit rows; full authorized JSON preserves all retained rows.

## 6. Provider usage, reliability and cost

`requestCount`: outbound attempts, including retries and calls whose result arrived after the race ended. A request is different from an applied model decision.

`requestOutcomes`: counts by clean server status category. `requestLatencyMs`: per-attempt latency distribution. `requestErrorRate`: non-`ok` attempts divided by attempts; no attempts yields `null`.

`inputTokens` and `outputTokens`: sums of **reported** usage only. `requestsWithUsage` and `requestsWithoutUsage` refer to known input usage. `requestsWithoutOutputUsage` separately reports output incompleteness. A sum of zero with unknown requests is not proof of zero billable tokens.

`costRatesUsdPerMillion` stores manually configured input/output rates. `estimatedCostUsd` is computed only when both rates are finite, at least one request exists, and **every** request has both token counts:

```
(inputTokens × inputRate + outputTokens × outputRate) / 1,000,000
```

Otherwise cost is `null`. Zero is a valid manually configured rate. `costIsEstimate` remains true: this excludes discounts, taxes, minimums, provider-side accounting differences and unreported usage. No pricing is hardcoded or presented as a current quote. Changing configured rates affects recomputed estimates; archive exports when preserving a pricing snapshot matters.

No per-provider retry counter is fabricated. Request-attempt records preserve the attempt number and outcome; detailed retained telemetry can distinguish retries. A fallback is a separate action-source metric and does not imply that every unsuccessful request caused an applied fallback.

## 7. Optional browser telemetry

Collection starts only after the user enables it under **My stats & privacy**. No advertising or external analytics SDK is included. Browser events are batched, allowlisted, bounded, deduplicated per match, and tagged `trust='client'`.

| Allowed event | Properties / interpretation |
|---|---|
| `cell_focus` | Cell 0–80 and duration 0–60,000 ms per observation. Aggregates into `focusDwellMsByCell` and `focusDwellMs`. |
| `note_added`, `note_removed` | Cell index only; no digit contents. Adds/removes counts, not remaining pencil-mark inventory. |
| `visibility` | Reported hidden duration up to one hour per observation. |
| `input_method` | `keyboard`, `touch`, or `mouse`. |
| `action_rtt` | Reported round-trip duration, bounded to 120 seconds. |
| `long_task` | Reported task duration, bounded to 120 seconds. Browser support/availability varies. |
| `reconnect`, `local_conflict` | Reconnection count; conflict cell index. |
| `analysis_opened`, `rules_opened`, `replay_opened` | Optional feature-use counts. |
| `export_requested` | `json` or `csv`. |

`browser` contains total events, eventCounts, focus vectors/sum, notesAdded/Removed, hiddenMs, inputSources, actionRttMs/longTasksMs distributions, reconnects and localConflicts. Arbitrary text, user-agent fingerprints, raw keystroke streams, email addresses and custom properties are not accepted.

A user closing the page can lose the last batch. Durations can overlap or be fabricated. The report never converts these observations into official solve time or score.

## 8. Personal history

`GET /api/analytics/me` returns up to the **most recent 200 matches**, ordered for display with an explicitly bounded summary window. `coverage` includes returned, total, limit, truncated and ordering semantics.

Summary fields include games, finished, validFinished, voided, inProgress, completed, wins/losses/draws, winRate, completionRate, current/best streak, ranked/practice results, solve-time distribution, actions, provider requests/tokens and perDifficulty.

Win rate uses `wins / validFinished`; completion rate uses completed valid finished games divided by validFinished. Voids do not become losses/draws or reset the valid-result streak. Streaks apply to the returned history window, not an implied all-time record. Per-difficulty completion distributions remain descriptive; do not mix profile strength with puzzle difficulty or cross-puzzle leaderboard ordering.

## 9. Operator analytics

`GET /api/analytics/operator?days=30` optionally accepts `difficulty=normal`. Access requires an allowlisted Discord user or configured bearer token. CLI access operates directly on the server database.

- **Coverage:** exact from/through instants, selected days/difficulty, match count, completed-report count, operation sample bounds and HTTP sample count. Live matches are excluded from the completed summary.
- **Funnel:** reserved, started, firstAction, finished, completed, rankedVerified. This counts matches reserved in the chosen creation-time window, not unique people. Expired reservations may finish void without ever starting; funnel stages are descriptive counts, not a guaranteed nested conversion sequence.
- **Activity:** authenticated DAU/WAU/MAU are unique users with started matches in rolling 1/7/30-day windows, from start-time queries rather than reservation-time queries. Insufficient requested window length returns `null` for longer metrics. Guest sessions are distinct session identifiers, not unique humans. UTC daily active rows are also supplied.
- **Retention:** first observed started-match UTC date defines cohort membership. D1/D7/D30 use an exact return day, not “on or after.” Only fully elapsed target days enter the denominator. Reports include cohort sizes, eligible/returned counts and rates. Retention includes all difficulties even when other report sections are filtered.
- **Routes:** normalized method/path, request count, 5xx, 4xx, 429, and latency distribution. Dynamic match IDs and query strings are not retained as route labels. Opponent-state polls (`GET /api/matches/:id`) are not logged, and the latency percentiles use at most the most recent 1,000 logged requests in the window (`coverage.httpMetricsSampled` says when that happened).
- **Security/reliability:** selected rejection, verification failure and scheduler error event counts.

Deleting accounts or purging operational history changes available history. No synthetic DAU, extrapolated retention, or fabricated revenue is generated to fill missing data.

## 10. Exports, retention and privacy

The analytics UI downloads full authorized JSON or tabular decision CSV. JSON is the canonical complete format; CSV is a defined flat view, not a lossless export of nested metrics. CSV fields are quoted and protected against common spreadsheet formula prefixes.

```bash
npm run analytics -- --days 30 --out reports/operator.json
npm run analytics -- --days 30 --format csv --out reports/routes.csv
npm run analytics -- --match MATCH_ID --out reports/match.json
npm run analytics -- --match MATCH_ID --format csv --out reports/decisions.csv
```

CLI detailed match exports require a finished attempt so operators do not accidentally reveal live ranked answers. Authorized owner API reports may be live but remain redacted.

Default retention: raw optional browser events and operational HTTP/security observations expire after **30 days**. These are configurable (`TELEMETRY_RETENTION_DAYS`, `OPERATIONS_RETENTION_DAYS`). On Cloudflare there are no cron triggers to spare, so expiry runs **lazily**: light requests occasionally run one small bounded sweep (at most once a minute) that deletes a few hundred expired rows at a time. A quiet site purges nothing until traffic returns, and a large backlog clears over several sweeps. `npm run maintenance -- --sweep` runs the same sweep against a local database.

Core replay, provider request usage, results and identity records persist until account deletion or operator action. Full analytics reports are not cached: they are rebuilt from the retained events and telemetry whenever they are read, so expired or withdrawn browser observations disappear from reports automatically. The stored per-result summary (outcome, eligibility, times, provider request and token totals) contains no browser observations. Disabling optional consent deletes the user's stored optional observations. Per-session collection consent is not an account-wide synchronization mechanism; other sessions have their own opt-in setting.

Account export includes owned public state, authorized analytics and completed replay files. Deletion removes owned games, results, telemetry and associated identity/session records. A keyed, non-public daily-attempt tombstone without direct user ID survives only until that challenge's UTC day ends, preventing account deletion from granting another official attempt. Backup copies follow the operator's separately managed deletion/retention policy.

## 11. Deliberate non-metrics

No IQ/cognitive diagnosis, covert fingerprint, hidden-solution error count, cheating probability, calibrated model correctness probability, normalized cross-puzzle skill score, or billing invoice is inferred. The data is suitable for gameplay inspection and engineering analysis, not those conclusions.

## 12. Workers-era notes

- **Candidate evidence.** `jev.decisions[].candidateEvidence` is large (about 10 KB per decision). `GET /api/matches/:id/analytics?evidence=omit` returns the same report with `candidateEvidence: null`; the default form is refused with `413 evidence_too_large` above 350 KB of stored events, and the replay download always contains the complete evidence.
- **Stored summaries.** Operator and personal aggregates read a small per-result summary (dimensions, outcome, eligibility, times, action count, provider request/token totals) rather than parsing full reports. Matches still in progress contribute state-derived counts and zero provider usage.
- **Operator report bounds.** Result summaries are capped at 1,000 rows per report (`coverage.rowCap`, `summariesTruncated`) and the report is cached for five minutes.
- **Scheduling stamps.** Opponent event times are their scheduled times; see [WORKERS.md](WORKERS.md).
