# Security model and remaining limitations

## Implemented controls

| Threat | Shipped control |
|---|---|
| Browser-forged score or time | No score-write endpoint; server clock and deterministic event replay establish result. |
| Unauthorized match reads/edits | Ownership enforced for actions, SSE, replay and reports; no arbitrary user override. |
| Forged guild/channel | Signed Discord interaction and user-bound, one-use HMAC launch; fresh context required to query private scopes. |
| Duplicate official attempts | Unique per-user/challenge attempt reservation plus a short-lived keyed tombstone that survives account deletion. |
| Stale/replayed requests | Idempotency keys, human revisions, opponent revision checks, OAuth/launch nonces and signed-interaction freshness. |
| Arbitrary model mutation | Server-generated bounded candidates; typed response validation; proof/action regeneration before applying. |
| Ranked answer leakage | Explicit public projection; no opponent digits, action IDs, proof cells, probability keys or candidate evidence in unfinished ranked analytics. |
| Session exposure | Random opaque tokens, hashes in SQLite, HttpOnly/SameSite cookies, Secure in production, rotation at login. |
| CSRF | Matching Origin and synchronizer token on browser mutations. |
| XSS | `textContent`, fixed templates, no user HTML, restrictive CSP and allowed static files only. |
| SQL injection | Prepared parameters; enumerated filters for dynamic query fragments. |
| CSV formula injection | Quoted CSV plus prefix protection for common formula-triggering cells. |
| Secret logging | Normalized routes without query strings; whitelist telemetry; no raw provider prompt/token logging. |
| Unbounded requests | JSON/body/candidate/response limits, rate limits, per-match provider/event budgets, concurrency and active-match caps. |
| Silent fallback | Downgrade to practice before heuristic application; clear source labels. |
| Analytics overreach | Optional client observations off by default, separate trust tags, export/delete, purge tooling and restricted operator routes. |

## Boundaries that remain

**Verification is not cheat-proofing.** A user can solve externally, share solutions, automate legal inputs, create multiple Discord accounts, or modify local code. Recorded legal moves do not prove unaided human reasoning. This release does not make a cheating-probability claim or attempt device fingerprinting.

**Deployment matters.** HTTPS, secret handling, database file access, OS patching, backups, retention schedules and edge protection remain operator responsibilities. Host administrators can read the database and hidden puzzle data; application-level redaction is not protection from a malicious host administrator.

**Rate limits are process-local.** Restarting resets buckets. The app does not trust arbitrary forwarded IP headers; behind a reverse proxy, its socket-level address may identify the proxy and cause aggregate limiting. Configure additional edge limits and capacity for your deployment. Public guests can still consume finite capacity and provider budget; use provider-wide limits or access controls before unrestricted launch.

**Timing is server acceptance time.** Network delays can affect human rankings. One-second buckets reduce false precision but do not compensate measured client latency. No client-reported timing subtraction is trusted.

**Sessions/context have finite scope.** Launch association proves a signed invocation at a point in time, not permanent channel membership. A user removed from a channel after invocation may retain short-lived existing context until expiry. Same-account sessions can inspect owned games. Optional telemetry consent is per session; revoking it in one session deletes stored optional data but does not silently synchronize preferences in other sessions.

**Account deletion exception.** The live database removes user/game/result/telemetry records. A keyed HMAC attempt identifier without a direct Discord ID is retained until the current UTC challenge day ends to prevent official-attempt resets. Operational logs use normalized routes rather than direct user IDs. Externally copied exports/backups cannot be deleted by the app; manage them separately.

**Provider and policy quality are uncalibrated.** Typed responses and proof checking reduce malformed action risk. They do not prove optimal decisions or fair speed. The pure Sudoku detectors and hybrid policy need broader evaluation before competitive claims. The included test samples are finite, not a formal proof of every advanced detector state.

**No external certification.** Live Discord/JEV credentials, production Node24/Docker, public TLS, full browser CSP enforcement, assistive-technology audits, and adversarial penetration tests were not available/executed during assembly. The supplied tests cover specific contracts, not all security scenarios.

## Recommended release gate

Before public ranked play, use a dedicated staging Discord application/key, verify signed callback and interaction behavior, test the real provider and all downgrade paths, inspect active-ranked payloads, run ordinary browser native-SSE/CSP checks, restore a backup, and measure concurrency/costs on the intended host. Do not add fake identities or client-side official-score overrides to bypass configuration.

Keep source and test changes reviewable. Do not upload `.env`, database files, backups, user exports or live API response traces to a public repository.
