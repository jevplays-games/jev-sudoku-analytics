# JEV Single-Page Game — Architecture & Implementation Planning Prompt

You are a senior game engineer, web architect, security engineer, and JEV/TypeSafe AI integration engineer.

Your task is to design a complete implementation plan for a **single-page browser game where a human plays `{{GAME}}` against JEV**.

I will provide **only the game name**. Do not require me to explain the rules, architecture, UI, game loop, JEV integration, Discord integration, scoring system, deployment model, or database design unless the game itself is genuinely ambiguous.

Research and infer the conventional rules and expected player experience for the named game. When multiple common variants exist, select the simplest recognizable version appropriate for browser play and explicitly document the assumption.

The eventual implementation should be suitable for hosting many independent games that follow this same architecture.

---

# 1. Primary Objective

Plan a production-quality implementation of:

> **Human vs JEV — `{{GAME}}`**

The application should:

- run primarily as a single HTML page;
- use vanilla HTML, CSS, and JavaScript wherever practical;
- minimize dependencies;
- use JEV / TypeSafe AI for the computer opponent;
- make JEV's decisions deterministic, structured, inspectable, and easy to benchmark where practical;
- support Discord authentication;
- associate scores and game statistics with Discord users;
- provide Discord-channel, Discord-server, and worldwide leaderboards;
- be inexpensive and simple to host;
- work well on desktop and mobile;
- remain understandable enough that another coding agent can implement it from the plan without additional architectural decisions.

Treat this as one game in a future collection of **"Play Against JEV"** games.

---

# 2. Technology Philosophy

Default toward:

```text
index.html
game.js
game.css
jev.js
discord.js
api.js

```

or an even simpler structure when reasonable.

Prefer:

```text
HTML
CSS
Vanilla JavaScript
JEV / TypeSafe
Web APIs
Fetch
WebSocket only when justified

```

Avoid frameworks unless they solve a concrete problem that cannot reasonably be solved with browser-native APIs.

Do NOT automatically introduce:

```text
React
Vue
Angular
Next.js
Nuxt
Vite
Webpack
Redux
large UI libraries
large game engines
large authentication frameworks

```

A tiny build step is acceptable only if TypeSafe/JEV or another unavoidable dependency requires it.

Every dependency must be justified.

For each proposed dependency, answer:

1. What does it provide?
2. Why is native HTML/JS insufficient?
3. What is its approximate role in the application?
4. Could it be eliminated?
5. Is it required in the browser, server, build system, or development environment?

---

# 3. Important Architecture Constraint

The game itself should be as close as practical to:

```text
Static HTML
   +
CSS
   +
Vanilla JavaScript

```

However, do **not** put secrets, Discord client secrets, privileged Discord tokens, trusted score submission logic, or sensitive credentials in browser JavaScript.

Introduce the smallest possible backend/serverless component required for:

- Discord OAuth;
- secure session handling;
- Discord guild/channel verification;
- authoritative score submission;
- leaderboard persistence;
- anti-cheat validation;
- any JEV functionality that cannot safely execute client-side.

Clearly separate:

```text
What can be static/client-side
vs.
What MUST be trusted/server-side

```

Favor serverless/edge functions or a very small API over a traditional application server where appropriate.

---

# 4. First Understand `{{GAME}}`

Before proposing the architecture, analyze the game.

Determine:

- number of players;
- normal turn structure;
- board/state representation;
- legal moves/actions;
- starting state;
- terminal conditions;
- winning conditions;
- draws/ties;
- scoring;
- hidden information;
- randomness;
- simultaneous actions, if any;
- timers, if appropriate;
- state-space characteristics;
- whether perfect play is tractable;
- what information JEV should receive;
- what information JEV must not receive;
- what makes an AI opponent easy, medium, or difficult;
- what constitutes meaningful player skill.

Create a concise **formal game-state definition**.

Example conceptual shape:

```js
GameState = {
  version,
  gameId,
  turn,
  phase,
  humanPlayer,
  jevPlayer,
  board,
  inventory,
  legalActions,
  score,
  history,
  rngState,
  terminal,
  winner
}

```

Adapt this completely to `{{GAME}}`.

Do not force irrelevant fields into the design.

---

# 5. Separate Rules From Presentation

The game engine must not depend on DOM state.

Design:

```text
Game Rules Engine
        |
        +--> Browser UI
        |
        +--> Human Input
        |
        +--> JEV Adapter
        |
        +--> Replay
        |
        +--> Tests

```

The authoritative local game state should live in JavaScript data structures rather than being inferred from rendered HTML.

Functions should conceptually resemble:

```js
createGame()
getLegalActions(state)
applyAction(state, action)
isTerminal(state)
getOutcome(state)
serializeState(state)
deserializeState(data)

```

Adapt the interface to the selected game.

The same rules engine should be usable by:

- the browser;
- JEV;
- simulations;
- tests;
- replay;
- server-side score verification if needed.

---

# 6. JEV Opponent

The important feature is not merely "AI plays the game."

The game should demonstrate **JEV making structured decisions**.

Design the JEV integration carefully.

The browser/game engine should expose a finite, explicit decision surface to JEV.

Conceptually:

```text
Current Game State
        ↓
Feature Extraction
        ↓
JEV Questions
        ↓
JEV Evaluation
        ↓
Candidate Action Assessment
        ↓
Selected Legal Action
        ↓
Rules Engine Validation
        ↓
Action Applied

```

JEV must never be allowed to directly mutate arbitrary game state.

JEV proposes or selects an action.

The deterministic rules engine validates it.

Only valid actions are applied.

---

# 7. JEV / TypeSafe Representation

Identify the best way to encode the game's decision problem for JEV.

Plan:

- questions;
- answers;
- features;
- state encoding;
- candidate actions;
- action IDs;
- utility signals;
- confidence;
- validation;
- invalid-output handling.

Prefer bounded structured representations over free-form language.

For example:

```text
Questions / Features
--------------------
Is immediate victory available?
Is the human threatening victory?
Does this move improve material?
Does this move improve position?
Does this move create future options?
Does this expose JEV to a forced response?
...

```

And candidate answers/actions could map to legal moves.

Do not blindly use this example. Derive the representation from `{{GAME}}`.

Explain specifically:

- what JEV receives;
- what JEV evaluates;
- what JEV returns;
- how that output maps to a legal game action.

Where relevant, take advantage of TypeSafe/JEV's large combinatorial structured decision space rather than treating it like a text chatbot.

---

# 8. Candidate-Action Architecture

Prefer generating legal moves before asking JEV to choose.

Ideal flow:

```text
state
  ↓
legal-action generator
  ↓
candidate actions
  ↓
feature extraction
  ↓
JEV
  ↓
rank/select
  ↓
validate
  ↓
execute

```

This ensures JEV cannot invent illegal actions.

For games with too many possible actions, design a bounded candidate-generation stage.

Explain:

- how candidates are generated;
- maximum candidate count;
- pruning strategy;
- state features;
- selection mechanism;
- tie-breaking;
- fallback behavior.

---

# 9. Difficulty Levels

Design at least:

```text
Easy
Normal
Hard
JEV

```

Difficulty should ideally change the quality/depth of JEV's decision process rather than merely adding random mistakes.

Possible mechanisms include:

- number of evaluated features;
- candidate pruning;
- tactical lookahead;
- state abstraction;
- search depth;
- evaluation precision;
- decision budget.

The highest level should expose JEV's strongest practical strategy for the game.

Do not artificially cheat by giving JEV hidden information unavailable to the human.

---

# 10. Visible JEV Thinking

Make JEV a visible part of the experience.

Design an optional compact panel such as:

```text
JEV
Thinking...

Candidates: 7
Best move: E4
Confidence: 82%

Factors
✓ blocks immediate threat
✓ improves position
✓ preserves options
✕ sacrifices tempo

```

Do NOT expose hidden chain-of-thought.

Instead expose structured decision evidence generated specifically for UI display, such as:

- evaluated features;
- candidate count;
- selected action;
- confidence;
- major positive factors;
- major negative factors;
- decision latency.

Allow:

```text
JEV Analysis: ON / OFF

```

This should make the game useful as both entertainment and a demonstration of JEV.

---

# 11. JEV Failure Handling

Plan deterministic handling of:

- timeout;
- unavailable JEV service;
- malformed response;
- invalid action;
- impossible action;
- duplicate action;
- stale game state;
- disconnected client.

Example:

```text
JEV chooses action
       ↓
Validate
   ↙       ↘
valid     invalid
 ↓          ↓
apply    retry once
             ↓
          fallback policy

```

The game must remain playable even if the AI service temporarily fails.

Specify the safest fallback for this particular game.

---

# 12. Game UX

Design a polished one-page layout.

Conceptually:

```text
┌──────────────────────────────────────────────┐
│ LOGO       {{GAME}} vs JEV       LOGIN      │
├──────────────────────────────────────────────┤
│                                              │
│                 GAME                         │
│                                              │
│                                              │
├─────────────────┬────────────────────────────┤
│ PLAYER          │ JEV                        │
│ score           │ status                     │
│ record          │ analysis                   │
├─────────────────┴────────────────────────────┤
│ New Game | Difficulty | Rules | Leaderboard │
└──────────────────────────────────────────────┘

```

Adapt the design to the game instead of forcing a board-game layout where inappropriate.

Prioritize:

- responsive design;
- keyboard accessibility;
- touch controls;
- readable game state;
- minimal UI latency;
- clear player/JEV turns;
- clear game-over state.

---

# 13. Discord Authentication

Support:

> **Sign in with Discord**

Use the secure Discord OAuth flow.

Do not expose Discord secrets in client-side code.

Plan the OAuth architecture.

Conceptually:

```text
Browser
   │
   │ Sign in with Discord
   ▼
Auth Endpoint
   │
   ▼
Discord OAuth
   │
   ▼
Callback Endpoint
   │
   ├── validate
   ├── establish session
   └── retrieve permitted identity/context
             │
             ▼
          Browser

```

Use the minimum Discord OAuth scopes required.

Clearly identify those scopes and explain why each is needed.

Store only information required for authentication, leaderboard identity, moderation, and attribution.

Prefer:

```text
discord_user_id
display_name
avatar_reference

```

over unnecessary personal information.

---

# 14. Discord Context

The game should support leaderboard scopes based on Discord context.

Required leaderboard scopes:

```text
CHANNEL
SERVER
WORLD

```

Interpret these as:

### Channel

Players associated with a specific participating Discord channel.

Example:

```text
#chess
#games
#jev-arena

```

### Server

Players associated with the same Discord guild/server.

### World

All players using the hosted game platform.

Design how the game securely determines:

```text
discord_user_id
guild_id
channel_id

```

Do not trust arbitrary browser-supplied guild or channel IDs.

If Discord OAuth alone cannot prove all required context, design the minimal Discord bot/application or signed launch mechanism needed to establish that context securely.

Explicitly explain the distinction between:

```text
Discord authentication
Discord guild membership
Discord channel context

```

and how each is established.

---

# 15. Discord Launch Experience

Plan an optional Discord-native launch path.

For example:

```text
Discord
  ↓
#games
  ↓
Play {{GAME}} vs JEV
  ↓
signed game URL
  ↓
browser game

```

The signed launch context could safely identify:

```text
guild
channel
game
expiration
nonce

```

without trusting editable browser parameters.

Consider a structure conceptually similar to:

```text
/play/{{game}}?launch=<signed-token>

```

Do not expose privileged bot tokens.

---

# 16. Guest Mode

Allow anonymous users to play where practical.

Example:

```text
Guest
├── Can play
├── Can select JEV difficulty
├── Can see world leaderboard
└── Cannot submit official leaderboard scores

Discord User
├── Can play
├── Can save scores
├── Can maintain statistics
├── Can join channel leaderboard
├── Can join server leaderboard
└── Can join world leaderboard

```

Define the exact behavior.

---

# 17. Score Model

Design scoring appropriate to `{{GAME}}`.

Do not use an arbitrary score if the game's native win/loss system is more meaningful.

Potential metrics:

```text
Wins
Losses
Draws
Win rate
Current streak
Best streak
Games played
Difficulty
Average decision time
Game-specific score
Rating

```

Determine which metrics are appropriate.

If useful, include a rating system such as Elo, but only when justified by the game.

Separate results by difficulty when mixing difficulties would produce misleading rankings.

---

# 18. Leaderboards

Required views:

```text
Channel
Server
World

```

Potential UI:

```text
Leaderboard

[ Channel ] [ Server ] [ World ]

#   Player        Rating    W    L    Streak
1   @Alice        1421     51   12      8
2   @Bob          1398     46   14      3
3   @Carol        1360     39   17      1

```

Determine the best ranking metric for `{{GAME}}`.

Leaderboards should support reasonable pagination or top-N querying.

Potential additional filters:

```text
Today
This Week
All Time

Easy
Normal
Hard
JEV

```

Only include filters that produce meaningful comparisons.

---

# 19. Data Model

Design the smallest useful persistent schema.

Likely entities:

```text
users
discord_contexts
games
game_sessions
results
ratings
leaderboard_entries

```

Do not create unnecessary tables.

Show concrete schemas.

For example:

```text
User
----
id
discord_user_id
display_name
avatar
created_at
last_seen_at

```

and:

```text
GameResult
----------
id
game_type
session_id
discord_user_id
guild_id
channel_id
difficulty
result
score
moves
started_at
finished_at
verification

```

Adapt them to the actual requirements.

Identify useful indexes for:

```text
channel leaderboard
server leaderboard
world leaderboard
player history

```

---

# 20. Score Integrity / Anti-Cheat

Assume browser JavaScript can be modified by the player.

Therefore:

> Never trust a browser saying "I won with 9,999 points."

Design lightweight score verification.

Prefer approaches such as:

```text
initial state
+
random seed
+
ordered move log
+
game rules
=
verified outcome

```

When possible, submit the game's action history rather than trusting the final score.

The server should be able to validate:

- legal moves;
- move order;
- final state;
- result;
- score;
- difficulty;
- JEV opponent configuration.

For deterministic games, strongly consider replay-based verification.

For random games, use a server-issued or cryptographically committed seed.

Do not over-engineer anti-cheat, but make leaderboard fraud meaningfully harder than editing a JavaScript variable.

---

# 21. Replayability

Where appropriate, design a compact replay format.

Example:

```json
{
  "game": "{{GAME}}",
  "version": 1,
  "seed": "...",
  "difficulty": "jev",
  "actions": []
}

```

A replay should ideally be enough to reconstruct:

```text
starting state
all human actions
all JEV actions
final state
winner
score

```

Consider allowing users to share replay URLs later.

---

# 22. Determinism

Make deterministic execution a priority where the game allows it.

Given:

```text
same version
same starting state
same seed
same actions

```

the engine should generate:

```text
same resulting state

```

Avoid:

```js
Math.random()

```

for authoritative gameplay randomness unless the random values themselves are explicitly recorded.

Use seeded RNG where required.

---

# 23. Security Boundaries

Explicitly create a security boundary diagram.

Separate:

```text
UNTRUSTED
Browser
HTML
CSS
JavaScript
player input
localStorage
URL parameters

TRUSTED
OAuth callback
session issuance
Discord validation
score verification
leaderboard writes
private JEV credentials
database
signing secrets

```

Identify attack surfaces:

- forged scores;
- forged guild IDs;
- forged channel IDs;
- replay manipulation;
- session theft;
- CSRF;
- OAuth state tampering;
- XSS;
- leaderboard-name injection;
- duplicate score submission;
- replay attacks;
- API abuse;
- JEV request abuse.

Provide lightweight defenses suitable for a small hosted game.

---

# 24. Browser Storage

Use browser storage only for non-authoritative convenience state.

Potential examples:

```text
volume
animations enabled
preferred difficulty
JEV analysis visibility
guest stats
unfinished local game

```

Do not treat `localStorage` as authoritative leaderboard storage.

---

# 25. Accessibility

Include:

- semantic HTML;
- keyboard controls;
- visible focus states;
- ARIA only where needed;
- screen-reader-friendly game status;
- reduced-motion support;
- sufficient contrast;
- touch targets suitable for mobile.

For games normally dependent on visual state, describe a practical accessible representation.

---

# 26. Performance

The static portion should be extremely lightweight.

Goals should include:

```text
minimal initial JavaScript
minimal dependencies
no unnecessary runtime framework
no large image assets where CSS/SVG suffices
instant local game interactions
lazy external requests

```

The UI should not wait on the network for operations that can be resolved locally.

JEV computation may be asynchronous, but UI responsiveness should remain local.

---

# 27. Suggested Hosting Architecture

Propose the smallest sensible deployment.

Example shape:

```text
CDN / Static Host
      │
      ├── index.html
      ├── game.js
      ├── game.css
      └── assets
             │
             ▼
      Serverless API
             │
       ┌─────┼────────┐
       │     │        │
    Discord  JEV   Database

```

Potential deployment targets may include static hosting plus serverless functions.

Do not choose a provider merely because it is popular.

State what capabilities are actually required:

- static hosting;
- HTTPS;
- OAuth callback;
- server-side secrets;
- persistent database;
- serverless/API execution;
- optional caching.

---

# 28. Multi-Game Platform Compatibility

Although this plan is for `{{GAME}}`, structure it so additional games can eventually reuse:

```text
auth
Discord integration
leaderboards
profiles
sessions
JEV adapter
telemetry
replay storage
score verification
UI shell

```

Keep game-specific code isolated.

Ideal conceptual architecture:

```text
Platform
│
├── Auth
├── Discord
├── Leaderboards
├── JEV
├── API
├── Replay
│
└── Games
    ├── {{GAME}}
    ├── future-game-2
    └── future-game-3

```

However, do not turn the first game into a huge generalized framework.

Use interfaces only where reuse is obvious.

---

# 29. Proposed Game Interface

Define a very small interface that future games could implement.

For example:

```js
const game = {
  id,
  version,

  createInitialState(options),
  getLegalActions(state),
  applyAction(state, action),
  getOutcome(state),
  getScore(state),
  serialize(state),
  deserialize(data),

  getJevFeatures(state),
  getJevCandidates(state)
};

```

Improve or simplify this interface based on your analysis.

---

# 30. Observability

Include lightweight structured events.

Examples:

```text
game_started
human_action
jev_requested
jev_decision
jev_invalid_action
game_completed
score_verified
leaderboard_submitted

```

Useful JEV metrics:

```text
decision latency
candidate count
difficulty
selected action
confidence
fallback count
invalid-action count

```

Do not log secrets or unnecessary personal information.

---

# 31. Testing Strategy

Create a concrete test plan.

At minimum test:

### Rules engine

- legal moves;
- illegal moves;
- win conditions;
- tie conditions;
- edge states;
- deterministic replay.

### JEV integration

- valid response;
- invalid response;
- timeout;
- unavailable service;
- stale state;
- illegal JEV choice;
- fallback behavior.

### Authentication

- successful Discord authentication;
- rejected OAuth state;
- expired session;
- invalid guild context;
- invalid channel context.

### Score verification

- valid game;
- forged score;
- altered move history;
- duplicate submission;
- mismatched seed;
- mismatched difficulty.

### Leaderboard

- channel isolation;
- server isolation;
- global ranking;
- ties;
- pagination.

---

# 32. JEV Benchmarking

Because JEV is the defining technology, design a way to measure its performance independently of the UI.

Create a test harness capable of running:

```text
JEV vs scripted opponent
JEV vs random opponent
JEV vs heuristic opponent
JEV vs JEV

```

when applicable to `{{GAME}}`.

Record:

```text
games
wins
losses
draws
score
decision latency
invalid decisions
fallback decisions
difficulty
JEV configuration

```

The browser game and benchmark should use the same core rules engine.

---

# 33. Development Phases

Produce an implementation sequence with small reviewable milestones.

Prefer approximately:

```text
Phase 1
Pure deterministic game engine

Phase 2
Human-vs-local-opponent UI

Phase 3
JEV decision adapter

Phase 4
Human vs JEV

Phase 5
Replay and deterministic validation

Phase 6
Discord OAuth

Phase 7
Trusted result verification

Phase 8
Channel/server/world leaderboards

Phase 9
Polish, accessibility, mobile

Phase 10
JEV benchmark harness

Phase 11
Deployment

```

Change this order where the particular game demands it.

For every phase include:

- objective;
- files affected;
- major functions;
- tests;
- completion criteria.

---

# 34. File Tree

Provide a proposed repository tree.

Keep it small.

Example only:

```text
/
├── index.html
├── css/
│   └── game.css
├── js/
│   ├── game.js
│   ├── rules.js
│   ├── jev.js
│   ├── ui.js
│   └── api.js
├── api/
│   ├── auth/
│   ├── game/
│   └── leaderboard/
├── tests/
├── README.md
└── package.json

```

Do not create files unless they have a clear responsibility.

If the whole client can reasonably remain:

```text
index.html
game.js
game.css

```

prefer that simplicity.

---

# 35. API Design

Specify only the endpoints actually required.

Potential examples:

```text
GET  /api/auth/discord
GET  /api/auth/discord/callback
POST /api/logout

GET  /api/me

POST /api/game/session
POST /api/game/result

GET  /api/leaderboard/channel
GET  /api/leaderboard/server
GET  /api/leaderboard/world

```

Determine the minimum viable API.

For each endpoint provide:

```text
purpose
authentication
request
response
validation
security considerations

```

---

# 36. JEV API Boundary

Create an explicit interface between the game and JEV.

Conceptually:

```js
async function chooseJevAction({
  state,
  legalActions,
  difficulty
}) {
  // feature extraction
  // JEV evaluation
  // structured result
  // validation
}

```

Specify its input/output schema.

The rest of the game should not care how JEV internally operates.

---

# 37. Offline / Failure Mode

If feasible, allow the page to load and the game UI to function without authentication.

When JEV requires a remote service and that service is unreachable, choose one:

```text
retry
local heuristic opponent
random legal opponent
pause and explain

```

Select whichever provides the best user experience for `{{GAME}}`.

Never silently substitute another opponent while claiming it is JEV.

---

# 38. Rules Display

Include a compact in-game rules/help experience.

It should explain:

- objective;
- player controls;
- turn order;
- scoring;
- JEV opponent;
- difficulty;
- leaderboard eligibility.

Avoid forcing users to navigate to another page.

---

# 39. Visual Identity

Use a reusable visual design suitable for a collection called something conceptually similar to:

> **JEV Arcade**

Do not depend on external UI frameworks.

Favor:

- CSS variables;
- gradients only when appropriate;
- CSS/SVG icons;
- smooth but restrained animation;
- clear game-state transitions;
- obvious human/JEV distinction.

The individual game should still visually reflect `{{GAME}}`.

---

# 40. Minimalism Review

Before finalizing the architecture, perform a simplification pass.

For every:

```text
dependency
service
file
database table
API endpoint
abstraction
build step

```

ask:

> Can this be removed while preserving the required functionality?

Remove anything unnecessary.

The desired architecture is not the most sophisticated architecture.

It is:

> **the smallest architecture that is secure, maintainable, fun, and demonstrates JEV effectively.**

---

# 41. Required Final Deliverable

Return a detailed engineering plan using this exact overall structure:

## A. Game Interpretation

Explain how `{{GAME}}` will work.

## B. Player Experience

Describe the complete user flow.

## C. Game Rules Engine

Define the state, legal actions, transitions, and terminal states.

## D. JEV Decision Model

Explain exactly how JEV plays this game.

## E. JEV State Encoding

Define questions/features/answers/candidate actions.

## F. Architecture

Show client, JEV, API, Discord, and persistence architecture.

Include Mermaid.

## G. Security Boundaries

Explain browser vs trusted-server responsibilities.

## H. Discord Authentication

Define OAuth flow and required scopes.

## I. Discord Context

Explain secure channel/server identification.

## J. Scoring

Define game-specific scoring and statistics.

## K. Leaderboards

Define Channel / Server / World behavior.

## L. Data Model

Give concrete schemas.

## M. API

List minimal endpoints and request/response shapes.

## N. Anti-Cheat / Verification

Explain how submitted games are verified.

## O. Replay Format

Define replay schema and deterministic reconstruction.

## P. UI Layout

Provide a desktop/mobile layout and important states.

## Q. File Structure

Give the minimal repository tree.

## R. Dependencies

List every dependency with justification.

## S. Tests

Give unit, integration, JEV, authentication, and leaderboard tests.

## T. JEV Benchmark Plan

Explain how opponent quality will be independently measured.

## U. Deployment

Give the minimal hosting architecture.

## V. Implementation Phases

Create an ordered implementation plan with completion criteria.

## W. Risks and Open Questions

Identify uncertainties without blocking implementation unnecessarily.

## X. Simplification Pass

Identify anything that can be removed or deferred.

## Y. MVP Definition

Define the exact smallest deployable version.

## Z. Next Implementation Step

End with the **specific first implementation task** an engineering agent should perform.

---

# 42. Architecture Diagrams

Include at least these Mermaid diagrams.

### Runtime

```text
Human
 ↓
Browser Game
 ↓
Rules Engine
 ↙       ↘
UI        JEV Adapter
             ↓
            JEV

```

Expand this to show the actual proposed architecture.

### Authentication

```text
Browser
  ↓
Backend
  ↓
Discord OAuth
  ↓
Session

```

### Result Verification

```text
Completed Game
      ↓
Replay / Action Log
      ↓
Verification
      ↓
Verified Result
      ↓
Leaderboard

```

### JEV Decision Loop

```text
Game State
    ↓
Legal Actions
    ↓
Features
    ↓
JEV
    ↓
Selected Action
    ↓
Validation
    ↓
Game State

```

Adapt each diagram to `{{GAME}}`.

---

# 43. Implementation Readiness

The final plan must be concrete enough that a coding agent could immediately begin implementation without needing to decide:

- how the game state works;
- how JEV receives state;
- how legal actions are represented;
- how Discord authentication works;
- how server/channel context is established;
- how scores are calculated;
- how scores are verified;
- how leaderboard scopes work;
- what database records exist;
- what endpoints exist;
- what files need to be created;
- which dependencies are justified;
- how the project will be deployed.

Make reasonable decisions rather than repeatedly asking for clarification.

Document assumptions.

---

# 44. Core Principle

Throughout the design preserve this architecture:

```text
           HUMAN
             │
             ▼
       ┌───────────┐
       │   GAME    │
       │   STATE   │
       └─────┬─────┘
             │
       ┌─────▼─────┐
       │   RULES   │
       │  ENGINE   │
       └─────┬─────┘
             │
      legal actions
             │
             ▼
       ┌───────────┐
       │    JEV    │
       │ DECISION  │
       └─────┬─────┘
             │
       chosen action
             │
             ▼
       ┌───────────┐
       │ VALIDATOR │
       └─────┬─────┘
             │
             ▼
          GAME

```

JEV decides.

The rules engine controls reality.

Discord establishes player/community identity.

The backend establishes trust.

The leaderboard records only verified outcomes.

Everything else should remain as simple as possible.

Now design:

# `{{GAME}}`