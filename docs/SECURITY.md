# Security model and remaining limitations

## Implemented controls

| Threat | Shipped control |
|---|---|
| Browser-forged score or time | No score-write endpoint; server clock and deterministic event replay establish result. |
| Unauthorized match reads/edits | Ownership enforced for polls, actions, replay and reports; no arbitrary user override. |
| Forged guild/channel | Signed Discord interaction and user-bound, one-use HMAC launch; fresh context required to query private scopes. |
| Duplicate official attempts | Unique per-user/challenge attempt reservation plus a short-lived keyed tombstone that survives account deletion. |
| Stale/replayed requests | Idempotency keys, human revisions, opponent revision checks, OAuth/launch nonces and signed-interaction freshness. |
| Arbitrary model mutation | Server-generated bounded candidates; typed response validation; proof/action regeneration before applying. |
| Ranked answer leakage | Explicit public projection; no opponent digits, action IDs, proof cells, probability keys or candidate evidence in unfinished ranked analytics. |
| Session exposure | Random opaque tokens, hashes in D1, HttpOnly/SameSite cookies, Secure in production, rotation at login. |
| CSRF | Matching Origin and synchronizer token on browser mutations. |
| XSS | `textContent`, fixed templates, no user HTML, restrictive CSP and allowed static files only. |
| SQL injection | Prepared parameters; enumerated filters for dynamic query fragments. |
| CSV formula injection | Quoted CSV plus prefix protection for common formula-triggering cells. |
| Secret logging | Normalized routes without query strings; whitelist telemetry; no raw provider prompt/token logging. |
| Unbounded requests | JSON/body/candidate/response limits, per-isolate and D1-backed rate limits, D1-reserved daily/hourly provider quotas, per-match provider/event budgets, per-request opponent step budgets and active-match caps. |
| Silent fallback | Downgrade to practice before heuristic application; clear source labels. |
| Analytics overreach | Optional client observations off by default, separate trust tags, export/delete, lazy purge and restricted operator routes. |

## Boundaries that remain

**Verification is not cheat-proofing.** A user can solve externally, share solutions, automate legal inputs, create multiple Discord accounts, or modify local code. Recorded legal moves do not prove unaided human reasoning. This release does not make a cheating-probability claim or attempt device fingerprinting.

**Deployment matters.** Secret handling (Wrangler secrets), Cloudflare account access, D1 exports and backups, and edge protection remain operator responsibilities. Anyone with access to the Cloudflare account can read the database and hidden puzzle data; application-level redaction is not protection from a malicious account administrator. Ranked puzzles are generated locally and loaded out of band; keep the generated SQL out of source control.

**Read-path rate limits are per-isolate.** The in-memory limiter is a best-effort brake on cheap reads only: an isolate can be evicted or duplicated at any time. Match creation, sign-in and provider calls use D1-backed fixed-window reservations that cannot be overspent by concurrent isolates. Client addresses come from `cf-connecting-ip`, which Cloudflare sets. Add a Cloudflare rate-limiting rule for `/api/*` if you expect abuse. Public guests can still consume finite capacity and provider budget; the provider quotas cap spend, after which games fall back to the labeled heuristic and become practice.

**Timing is server acceptance time.** Network delays can affect human rankings. One-second buckets reduce false precision but do not compensate measured client latency. No client-reported timing subtraction is trusted.

**Sessions/context have finite scope.** Launch association proves a signed invocation at a point in time, not permanent channel membership. A user removed from a channel after invocation may retain short-lived existing context until expiry. Same-account sessions can inspect owned games. Optional telemetry consent is per session; revoking it in one session deletes stored optional data but does not silently synchronize preferences in other sessions.

**Account deletion exception.** The live database removes user/game/result/telemetry records. A keyed HMAC attempt identifier without a direct Discord ID is retained until the current UTC challenge day ends to prevent official-attempt resets. Operational logs use normalized routes rather than direct user IDs. Externally copied exports/backups cannot be deleted by the app; manage them separately.

**Provider and policy quality are uncalibrated.** Typed responses and proof checking reduce malformed action risk. They do not prove optimal decisions or fair speed. The pure Sudoku detectors and hybrid policy need broader evaluation before competitive claims. The included test samples are finite, not a formal proof of every advanced detector state.

**No external certification.** Live Discord/JEV credentials, the deployed Cloudflare runtime and its real CPU behavior, public TLS, full browser CSP enforcement on the deployed origin, assistive-technology audits, and adversarial penetration tests were not available/executed during assembly. The supplied tests cover specific contracts, not all security scenarios.

## Recommended release gate

Before public ranked play, use a dedicated staging Discord application/key, verify signed callback and interaction behavior, test the real provider and all downgrade paths, inspect active-ranked payloads, run ordinary browser CSP checks on the deployed origin, export and restore a D1 backup, watch the Workers CPU-time and D1 dashboards under real concurrency, and measure costs. Do not add fake identities or client-side official-score overrides to bypass configuration.

Keep source and test changes reviewable. Do not upload `.env`, `.dev.vars`, database files, D1 exports, generated ranked-puzzle SQL, user exports or live API response traces to a public repository.

## Workers-specific notes

- **Verification moved to append time.** Each event is validated against the authoritative state when written, each write re-checks the previous state hash, and the events form a hash chain that becomes the replay hash. A full independent replay is still available (the replay download plus `replayEvents`) but is not run inside a request. See [WORKERS.md](WORKERS.md).
- **Lazy timing.** The opponent's moves are stamped with their scheduled time; a human move is stamped with server acceptance time and is ordered after every opponent step already due. An attempt whose owner has not touched it for `ABANDONED_AFTER_MS` is voided, not left running.
- **No secrets in the client or in `vars`.** `TYPESAFE_API_KEY`, `LAUNCH_SIGNING_KEY`, `DISCORD_CLIENT_SECRET` and `ADMIN_ANALYTICS_TOKEN` are Wrangler secrets. Discord interaction signatures are verified with Web Crypto (Ed25519) over the raw body.
