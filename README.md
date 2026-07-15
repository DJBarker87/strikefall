# Strikefall

Strikefall is a solo-first stochastic survival game. Read a volatility deck,
plant a flag above or below the line, out-position 19 disclosed bots, and
survive a path nobody has seen before.

The product roadmap and mathematical specification live in
[Strikefall_Comprehensive_Plan_Final.docx](Strikefall_Comprehensive_Plan_Final.docx).

## How a round plays

1. **Read the tape.** The approach candles print live, tick by tick, revealing
   the deck's mood before the battle path begins.
2. **Plant your flag (6 seconds).** Your flag is a price barrier, not a point
   in time: above the line is a **call** strike, below is a **put**. As you
   drag, the arena quotes the live strike odds of that exact level, and the
   19 disclosed bots jockey around you.
3. **Survive the line (60 seconds).** The battle path renders as candlesticks
   (or a plain line — your choice in Settings). One touch of your barrier
   destroys the flag. Your position is priced continuously as a one-sided
   no-touch option: **option price = locked score × live survival
   probability**, computed exactly in the Rust/SolMath WASM engine.
4. **Hold or Escape.** From 10 seconds in until 3 seconds before the end, you
   can sell the position once at its live option price and bank it.
5. **Most points wins.** Final rank sorts by score alone — a banked Escape
   competes at full value against every held flag, and a struck flag scores
   zero.

Legal placements span a 12%–97% initial no-touch band, so a cautious flag can
usually survive to see the Escape window open even on the wrong side of the
storm.

## Play modes

- **Practice** runs without an account or backend. It requires the
  Rust/SolMath WebAssembly engine and uses its client-seeded canonical fixed
  path and interval extrema, alongside local
  progression, selectable 9- or 19-bot casts, selectable Easy/Normal/Hard bot
  difficulty, exact pause/resume, and a local replay player with a scrubbable
  strike timeline. The chosen canonical roster and difficulty are replay-bound,
  and an implicit rematch preserves both. The app loads and smoke-tests WASM
  before mounting the game; if that fails, a retry screen blocks new rounds. An
  installed build precaches the versioned WASM asset, so cached Practice remains
  available offline without changing its scoring engine.
- **Ranked alpha** is enabled by `VITE_ROUND_API_URL`. An anonymous bearer
  session—optionally protected by an invite—connects to the authoritative Rust
  service. The service commits the hidden path before play, owns placement and
  Escape, streams signed events, reveals the seeds after resolution, and stores
  the complete round in Postgres. A score enters a daily or weekly leaderboard
  only after the browser verifies the replay with WebCrypto and the exact
  Rust/WASM verifier and the service independently accepts the matching proof
  receipt.
- **Daily and Weekly challenges** are UTC content overlays on the ordinary run
  paths. Daily names its featured deck and mission. Each Monday-UTC Weekly
  challenge rotates one of the four decks and names an exact disclosed rival
  from the real bot roster plus a deck-specific condition. Weekly attempts and
  completion persist locally, while every attempt still creates an ordinary
  freshly seeded round; rematches preserve the featured deck just played.

Ranked replay links use `/replay/<round-id>`. The public endpoint exposes an
identity-free replay and an independently stored pre-round anchor only after a
matching verification receipt exists. The viewer shows no result until every
signature, digest, commitment, and deterministic regeneration check passes.

If ranked networking fails, the attempt is visibly downgraded and a new local
practice round can start; a local result is never submitted as ranked.

## Run it

Requirements:

- Node.js 22 or newer
- Rust 1.85.1 (pinned by `rust-toolchain.toml`)
- Google Chrome for the default browser and QA suites
- Python 3 with `tools/model-validation/requirements.txt` installed for the
  high-precision release campaign

For local practice development:

```bash
npm install
npm run dev
```

Then open `http://localhost:4173`. Ranked networking stays disabled unless a
round-service URL is configured.

For the production-shaped Postgres + authoritative service + same-origin web
edge stack:

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export STRIKEFALL_SIGNING_KEY="$(openssl rand -hex 32)"
docker compose up --build
curl --fail http://localhost:4173/healthz
curl --fail http://localhost:4173/api/health/ready
```

To enforce an invite-only alpha, also set
`STRIKEFALL_REQUIRE_INVITE=true` and a non-empty
`STRIKEFALL_INVITE_CODES` secret before starting Compose. The stack publishes
only the web edge; `/api/*` carries API and authenticated SSE traffic to the
private service. Public TLS is an external gateway boundary. See
[docs/OPERATIONS.md](docs/OPERATIONS.md) for secrets, invites, trusted proxies,
retention, health checks, recovery, migrations, and deployment limitations.

## Verify it

```bash
npm test                 # browser modules, game rules, ranked client, UI models
npm run build            # strict TypeScript and production bundle
npm run test:e2e         # practice journey at desktop, tablet, and mobile sizes
npm run test:e2e:a11y    # axe WCAG A/AA scans across key states and viewports
npm run test:e2e:ranked-daily # Compose-backed v3 Daily create/repeat/replay proof
npm run test:qa:smoke    # reduced motion, privacy defaults, offline/WASM recovery
npm run test:qa:soak     # 50-round Chromium endurance and bounded-memory samples
npm run test:qa:performance # Quick Run, rematch, and crowd-update budgets
npm run test:wasm        # reproducible bindings, native/WASM goldens, browser load
npm run test:decks       # calibration schema, provenance, privacy, and simulations
npm run test:model       # 110k mpmath vectors plus continuous-monitor campaigns
npm run test:evidence    # source-manifest and report-schema tamper regressions
npm run test:sbf:report  # recompute retained source and both SBF artifact hashes
npm run test:deployment:topology # require the singleton process-local SSE topology
cargo test --workspace --locked
```

The axe lane covers the landing/lobby, dialogs, active play, results/sharing,
offline and error recovery, public-replay recovery, and ranked fallback across
desktop, tablet, and mobile. It disables no axe rules and excludes no DOM
regions. The expanded integrated matrix passed 24/24 automated checks across
those viewports and key states. Automated axe coverage does not replace manual
assistive-technology testing or an independent accessibility audit.

With the Compose stack running, `npm run test:e2e:ranked` exercises the full
ranked lifecycle through the web edge, including public replay re-verification.
`npm run test:e2e:ranked-daily` proves that the featured Daily sends its exact
v3 deck identity, remains authoritative, creates fresh round/commitment pairs
on repeat play, and reaches a verified public replay;
`npm run test:performance:api` enforces the 300 ms round-create budget and
retains all raw samples plus source, runner, and exact Compose image/container
metadata. `npm run test:performance:report` recomputes its summary and current
source manifest; hosted CI uploads the JSON for 30 days. The local retained run
measured 6.52 ms p50 and 8.21 ms maximum, but correctly records
`releaseBound: false` because this tree has no commit.
`npm run test:performance:ranked-mobile` enforces the warm-cache ranked
interaction budget. The retained controlled Chromium Fast 3G run measured
275.37 ms from Ranked Run click to committed deck plus proof under 150 ms
latency, 1,600 Kbps download, and 750 Kbps upload. That is synthetic shaping,
not real-radio or physical-device evidence. The full SBF campaign is
`npm run test:sbf`; it requires the documented Solana 2.3 local toolchain,
while ordinary CI recomputes the retained source manifest and both measured
binary hashes. The current SBF report is likewise not release-bound until it is
regenerated from a clean commit.

The current local Chromium soak evidence covers 50 consecutive rounds. It is
not physical mobile Chrome or Safari evidence, and automated suites are not
evidence that real players understand the game or want another round. Those
gates remain open in
[docs/ROADMAP.md](docs/ROADMAP.md) and [docs/PLAYTEST.md](docs/PLAYTEST.md).

## Architecture

```text
src/
  game/                   practice rules and ranked arena presentation adapter
  engine/, wasm/          precision-safe Rust/SolMath browser boundary
  ranked/                 authenticated HTTP/SSE client and fail-closed verifier
  alpha/                  anonymous session, leaderboard, and consented telemetry UI
  replay/                 identity-free public replay loader and verified viewer
  analytics/              bounded local alpha dashboard and safe aggregate exports
  components/, audio/     responsive canvas arena and procedural sound
  share/                   dramatic-moment detection, rolling clips, static cards
apps/round-service/        Axum authoritative lifecycle and closed-alpha APIs
crates/
  strikefall-core/        fixed-point decks, paths, no-touch, scoring, hits
  strikefall-protocol/    ranked wire types, commitments, events, replay verification
  strikefall-wasm/        exact browser bindings over core and protocol verification
migrations/               Postgres rounds, identity, leaderboards, rate limits, telemetry
tools/
  model-validation/       independent high-precision and bridge campaigns
  deck-calibrator/        sanitized versioned deck-artifact pipeline
  replay-inspector/       deterministic audit CLI with external trust anchors
  sbf-benchmark/           retained SolMath quote CU and linked-size evidence
  performance/             production-shaped round-create measurement
e2e/                      responsive, resilience, endurance, and opt-in ranked tests
deploy/nginx/             hardened SPA, WASM, API, and SSE edge configuration
```

`strikefall-core` pins the official `solmath = "=0.2.0"` crate. SolMath
supplies fixed-point transcendental, normal-CDF, and inverse-normal primitives.
Strikefall composes those released primitives into its game-specific
first-passage quote; deck data, randomness, bots, crowding, and points rules
remain outside SolMath.

Browser scoring and probability calls cross the WASM boundary as canonical
SCALE=1e12 decimal strings. Practice retains exact path closes, interval
extrema, current spot, barriers, remaining variance, locked score terms, and
Escape quotes. Touches compare fixed integers; Escape value uses BigInt
truncation identical to `solmath::fp_mul`; ranking compares fixed scores before
the final display conversion. JavaScript `Number` projections are used only for
rendering, controls, bot-policy heuristics, and telemetry; they are not fed back
into a points, probability, or player-outcome calculation.

The committed model corpus is generated independently with `mpmath` at 80
decimal digits: 100,000 production vectors plus 10,000 labelled adversarial
vectors. Active Deck v3 keeps the v2 continuous-monitoring contract—250 ms
public closes plus a committed conditional Brownian-bridge high and low for
every interval—and adds a disclosed, per-deck opening-runway schedule. Touches,
closest approach, Canvas wicks, Escape hindsight, signed events, and replay
verification use those extrema. Each one-sided marginal matches continuous
monitoring before fixed-point rounding; the joint upper/lower dependence is
explicitly an approximation. Frozen v2 fixtures remain decoder-compatible.
See [docs/FAIRNESS.md](docs/FAIRNESS.md).

## Current game loop

1. A named deck reveals its volatility schedule.
2. Approach candles establish the room's visual context.
3. The player and 19 disclosed bots jockey above or below the line.
4. Distance sets risk reward; same-side crowd density modifies the locked score.
5. Ranked placement closes with a signed two-second lock beat, then one
   generated line resolves the room. A wick touch destroys a flag.
6. At midpoint, an active contender may use one irreversible Escape to bank its
   current model value.
7. The result shows rank, closest approach, score, proof status, sharing, and an
   instant rematch.

With sound enabled, the battle clock has an audible escalating 10-to-1
countdown. Screen-reader announcements stay intentionally quieter at ten and
the final three seconds. Persona presentation uses text and shape as well as
color; reduced-motion or lower-flash settings suppress movement and flashing
while retaining the static tell.

Result sharing offers independently finalized, event-aligned 8–12 second Story
(9:16), Square (1:1), and Wide (16:9) clips with finite intrinsic media
durations, plus exact static-card fallbacks at 1080×1920, 1080×1080, and
1920×1080. A retained cluster wipe, late-hit near miss, Escape, or held-survivor
near miss exports only the matching moment window rather than an unrelated
result tail. Held survivors track their exact fixed-point minimum and retain a
bounded live candidate keyed to that authoritative battle step; the internal
capture metadata is regenerated rather than changing replay-v4's wire shape.
Reduced-motion sharing stays static and does not start the video encoder.

Every bot has a stable persona, capped reaction schedule, at most three
placement moves, and a separate deterministic randomness domain. Its signed
observation timestamp precedes its action by the declared latency, so player
moves made during that interval cannot leak into the decision. Bots never
receive the hidden battle path. Ranked replay v3 retains every candidate,
utility, public-input digest, observation time, action time, latency, and reason.

Escape (`absent`/`midpoint`) and risk display (`probability`/`danger-band`) are
the two default versioned assignments. Public Quick Run has no deck cohort: a
fresh entropy byte selects each of the four decks with equal probability. An
explicit `closed-alpha` build/service policy may add the real deck-structure
(`flat`/`compression-break`) A/B and pin its treatment deck. Daily and Weekly
launches name their featured deck, while rematches keep the deck just played.
Practice assignments are deterministic and local; ranked assignments are
server-persisted and proof-bound. Dashboard cuts remain descriptive until their
sample and human-playtest thresholds are met.

A ranked replay-verification mismatch fails closed and, when shared telemetry
is enabled, emits only the bounded fact `verification_failed` on the `replay`
surface; messages, stacks, round identifiers, seeds, commitments, and mismatch
details are excluded. The authoritative aggregate reports distinct telemetry
and round-start sessions, deduplicated starts, second/third-round proxies,
player outcomes, and client-error sessions. Second/third-round rates use
round-start sessions as their denominator; the G4 error rate uses telemetry
sessions, is strictly below 1%, and remains `insufficient` below 50 telemetry
sessions. Telemetry v2 lets the service derive bounded full-lobby pacing and
flag-revision facts from its authoritative round record, and measure five-second
spectate/rematch response plus share/clip intent from exact owned-round actions
using server receipt time. These are aggregate product signals only: the schema
still cannot count unique people, filter identity-free client errors by deck, or
replace observed comprehension and fun evidence.

## Product boundary and current limitations

Strikefall is a non-redeemable points game. It has no wallet requirement,
entry fee, prize pot, token, tradable claim, or real-money settlement. The line
is a disclosed generated deck—not a live asset price, historical replay,
prediction, or investment product.

The four alpha decks are integrity-bound to the checked-in synthetic sample
catalog. That catalog deliberately declares `ranked_promotion_ready: false`:
its digests make mutations detectable, but they do not create historical or
licensed-market provenance. Reviewed source provenance and engine-level
promotion evidence are still required before any production-ranked rotation.

The production-shaped stack is suitable for controlled closed-alpha testing,
not an assertion of finished public operations. In particular, stored round
secrets rely on encrypted Postgres storage/backups rather than application-level
envelope encryption, live SSE fan-out is process-local and production is
fail-closed to a declared singleton, human fun gates are
unobserved, and real Safari and physical mobile Chrome endurance have not been
recorded. Licensed deck
provenance, independent quantitative review, a 50–100-person error-rate result,
the required 100–250-user invite-only stage, real-radio latency,
physical-device sharing, an independent accessibility audit, a clean hosted-CI
commit, and the approved marketing demo also remain open. With no `HEAD`, an
entirely untracked worktree, and both retained reports correctly marked
`releaseBound: false`, public launch is a no-go. See
[docs/OPERATIONS.md](docs/OPERATIONS.md),
[docs/SECURITY.md](docs/SECURITY.md),
[docs/decks/CALIBRATION.md](docs/decks/CALIBRATION.md), and
[docs/ROADMAP.md](docs/ROADMAP.md) for the exact boundaries.
