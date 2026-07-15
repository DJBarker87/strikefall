# Strikefall build roadmap

This checklist tracks the implementation against the comprehensive product
plan. A checked engineering item means the behavior exists in code and has
direct automated coverage; it does not replace human playtest, device, security,
or production-operations evidence. Fun gates remain release gates even when
later architecture is implemented.

## G0 — Understandable prototype

- [x] Instant one-player + 19-bot lobby
- [x] Offline Practice contract with selectable 9/19-bot canonical casts and
  Easy/Normal/Hard bot difficulty, clock-exact pause/resume, and a proof-backed
  result replay scrubber; roster and difficulty are replay-bound, and implicit
  rematch preserves both
- [x] Deck reveal, approach, placement, lock, battle, result
- [x] Pointer, touch, slider, and keyboard flag placement
- [x] Visible risk reward, crowd factor, and potential score
- [x] One-touch elimination, cluster cascades, kill feed, spectate, rematch
- [x] Four variance decks
- [x] Mobile, tablet, and desktop layouts
- [x] Reduced-motion and keyboard support
- [x] Axe WCAG A/AA regression lane spans key desktop, tablet, and mobile states
  with no disabled rules or DOM exclusions
- [x] Bounded local telemetry plus privacy-limited authoritative aggregates;
  dashboards expose distinct telemetry and round-start sessions, deduplicated
  starts, second/third-round proxies, player outcomes, exact experiment cuts,
  server-derived full-lobby pacing/placement facts, five-second eliminated-player
  response, share intent, clip export, and a strict `<1%` client-error-session
  gate that is `insufficient` below 50 telemetry sessions. Unique people and
  deck-filtered identity-free client errors remain unavailable from the schema
- [ ] Human comprehension gate: 8/10 observed first-time players can predict a
  touch and place a flag without explanation

The browser and unit suites establish behavior and accessibility mechanics, not
first-time-player comprehension. The expanded integrated axe matrix passed
24/24 automated checks across desktop/tablet/mobile viewports and key states;
manual assistive-technology testing and an independent audit remain open.

## G1 — Fun

- [x] Deterministic 19-bot persona engine
- [x] Visible bot moves capped at three
- [x] Automated balance campaign
- [x] Median survivor target of 2–6 in the automated campaign
- [x] First-ten-second mass-wipe guard using committed interval extrema
- [x] Procedural sound and impact presentation, including an audible escalating
  battle countdown from 10 through 1 when sound is enabled
- [x] Color-independent text/shape persona tells with static meaning retained
  when reduced-motion or lower-flash settings suppress movement and flashing
- [x] Result stories and one-tap rematch
- [ ] Observed 10–15 person playtest
- [ ] Same-session second round at least 60%
- [ ] Same-session third round at least 35%

Gate: continue only when real people show “one more” behavior. No automated
metric or persisted local profile is counted as this evidence.

## G2 — Deterministic mathematical core

- [x] Rust workspace and `no_std`-friendly core
- [x] Official `solmath = "=0.2.0"` dependency pinned exactly
- [x] Fixed-point deck/path generation
- [x] One-sided no-touch quote and probability-to-barrier solver
- [x] Fixed scoring/crowd/Escape-value primitives
- [x] WASM boundary with decimal-string fixed values
- [x] Native, release, `no_std`, WASM, and browser-load verification
- [x] Browser requires Rust/WASM for every new score and quote; an unavailable
  engine blocks new rounds behind an explicit retry screen, while an installed
  offline shell reuses its precached versioned WASM asset
- [x] Practice Escape retains canonical fixed strings and uses BigInt
  multiplication/division with the same truncation as `solmath::fp_mul`
- [x] Ranked browser verification regenerates the complete replay through the
  exact Rust/WASM protocol verifier and fails closed without it
- [x] Reproducible 80-decimal reference campaigns: 100,000 production vectors
  across all launch schedules plus 10,000 labelled near-barrier, low-variance,
  drift-boundary, limit, reflection, and fixed-point adversarial vectors;
  manifest-bound CSV SHA-256 digests and release-mode Rust reports validate the
  shipped SolMath composition at declared 2e-7/1e-6 absolute bounds
- [x] Deterministic monotonicity grids, 25,000 supported-domain property cases,
  and 10,000 overflow/domain fuzz cases preserve public probability identities
- [x] Retained 200-vector Agave/SBF quote report: 10,904 average, 11,308 p99,
  and 11,317 maximum math CU (<30,000), plus linked-size and artifact-SHA
  evidence; both exact binaries and the declared source/tooling manifest are recomputed in
  ordinary CI (current local report is explicitly not clean-commit-bound)
- [x] Active Deck v3 preserves frozen v2 continuous one-sided monitoring and
  adds a disclosed per-deck opening runway. Deterministic conditional
  Brownian-bridge high/low extrema remain inside each 250 ms public frame and
  are used consistently by touch, closest approach, Escape hindsight, Canvas,
  signed stream, commitment, and replay verification
- [x] Independent 100,000-sample bridge-extrema acceptance campaign across both
  sides and three regimes: 0.2305 percentage-point worst observed quote/monitor
  residual against a 0.75-point enforced ceiling; endpoint-only undercount is
  retained as a negative control
- [x] Residual boundary documented honestly: exact one-sided conditional
  marginals before fixed-point rounding, but approximate joint upper/lower
  dependence and 250 ms touch-time quantization
- [x] G2 production-engine campaign with scoring defaults `d_target = 0.8` and
  `h = 1.25`: eight bands, both sides, four lobbies × 320 common continuations
  per deck, and 2,560 side outcomes per band/deck
- [x] No materially dominant tested band: maximum exact expected band/deck mean
  about 1.126 (<1.15), worst one-sided 99% realized-advantage UCB 17.3%
  (<22%), and natural exact crowd-factor spans at least 0.30

## G3 — Trustworthy ranked solo

- [x] Authoritative Axum/Rust round service using the shared deterministic core
- [x] Immutable versioned deck endpoint and shared protocol crate; active deck
  catalog v3 and ranked replay v3 bind the bridge-extrema monitoring convention,
  while catalog v2 remains frozen for historical replay compatibility
- [x] Production-Compose Daily proof pins the featured deck request and response
  to v3, rejects Practice fallback, proves fresh round/commitment identity on a
  repeat attempt, and verifies the resolved public replay
- [x] Fresh hidden path secret and isolated bot seed root per round
- [x] Pre-round SHA-256 commitment and post-round reveal
- [x] Ordered, hash-chained, Ed25519-signed durable event log
- [x] Versioned replay bundle and standalone inspector with external trust anchors
- [x] Optimistic, crash-recoverable Postgres round/result persistence
- [x] Server-authoritative rate-limited player placement and ordered one-to-three
  bot moves with 250–1,500 ms reaction intervals
- [x] Ranked bot decisions reconstruct public state at the signed observation
  cutoff, disclose all candidate utilities and reasons, publish only when due,
  and persist a crash-recoverable schedule cursor
- [x] Signed placement lock commits exact scores and a battle start exactly two
  seconds later; native, browser, and WASM verification reject timeline changes
- [x] One authoritative midpoint Escape command, with absent/midpoint treatment
  enforced for both player and bots
- [x] Authenticated SSE with durable snapshot, deduplication, gap detection, and
  `Last-Event-ID` recovery
- [x] Browser and service replay mismatches fail closed and cannot enter ranking
- [x] Frozen replay fixtures reproduce deck, path, bots, Escape audits, touches,
  scores, results, lifecycle events, and signatures in native Rust and WASM
- [ ] Replace the synthetic sample catalog with reviewed, licensed provenance
  and pass its engine-level promotion campaign before production-ranked rotation

The deterministic and cryptographic closed-alpha protocol is implemented. The
last item is deliberately open because the bound catalog says
`ranked_promotion_ready: false`; integrity digests do not turn synthetic fixture
data into production provenance.

## G4 — Closed alpha

- [x] Anonymous bearer identity with token rotation and expiry
- [x] Verified-only daily and weekly leaderboards with stable pagination and
  self rank
- [x] One irreversible midpoint Escape action
- [x] Near-miss, cluster-wipe, Escape, greed, and rivalry moment detection with
  bounded 15 fps rolling compositors for 720×1280 Story, 720×720 Square, and
  1280×720 Wide clips. Independently finalized, keyed candidates have finite
  intrinsic 8–12 second durations and preserve the selected live event rather
  than a later result tail. Cluster wipes, late-hit near misses, Escape, and
  held-survivor near misses can export video; held survivors use exact
  closest-approach tracking plus a bounded live replacement slot without
  changing replay-v4's public wire shape. Exact 1080×1920 Story,
  1080×1080 Square, and 1920×1080 Wide cards provide the fallback; reduced
  motion never starts the video encoder
- [x] Monday-UTC Weekly challenge rotates the four featured decks, names an
  exact disclosed rival from the real bot roster and a deck condition, persists
  bounded local attempts/completion, and launches each attempt through an
  ordinary freshly seeded path; rematch preserves the featured deck
- [x] Result sharing and identity-free public ranked replay links
- [x] Fail-closed public replay viewer with trusted anchors, WebCrypto, and exact
  Rust/WASM regeneration
- [x] Verified replay exposes the committed deck version and a dominant
  “Play a fresh round” action that returns to a newly seeded run
- [x] Escape `absent|midpoint` and risk display `probability|danger-band` are
  mandatory versioned assignments; public Quick Run omits a deck cohort and
  rotates all four decks uniformly, while explicit closed-alpha policy may add
  the real deck-structure `flat|compression-break` A/B. Ranked assignments are
  session-persisted, proof-bound, and cut only by exact present keys
- [x] Honest sample-sufficiency labels and safe aggregate JSON/CSV exports
- [x] Ranked disconnect-to-labelled-practice recovery; degraded results are never
  submitted as ranked
- [x] Local/off/shared privacy controls and schema-whitelisted consented alpha
  telemetry
- [x] Ranked replay mismatches emit one consent-gated bounded error fact with no
  message, stack, identifiers, seeds, commitments, or mismatch detail
- [x] 50 consecutive Chromium phase-machine rounds with forced-GC memory, DOM,
  listener, telemetry, and runtime checks
- [x] Enforced local/CI performance lanes for Quick Run and rematch under two
  seconds, crowd input p99 under 16 ms, round creation under 300 ms, and a
  retained SBF quote below 30,000 CU
- [x] Warm-cache production-Compose ranked interaction measured 275.37 ms from
  click to committed deck plus proof under controlled Chromium Fast 3G shaping;
  this is not real-radio or physical-device evidence
- [ ] 50 consecutive rounds on real desktop/mobile Safari and physical mobile
  Chrome without sustained memory growth
- [x] Production-shaped invite-gated Compose deployment, private Postgres/service
  network, same-origin static/API/SSE edge, health checks, and operational runbook
- [x] Bounded four-worker lifecycle catch-up preserves foreground pool headroom
  and passes the ranked journey with 29 simultaneously active authoritative rounds

The Chromium result is recorded in [PLAYTEST.md](PLAYTEST.md). The expanded
integrated axe matrix passed 24/24 automated checks across
desktop/tablet/mobile viewports and key states; that does not replace manual
assistive-technology testing or an independent accessibility audit. Playwright
WebKit may provide a compatibility signal, but it is not evidence for the open
Safari device gate. Browser clip/card evidence and the still-open physical
matrix are in
[SHARE_CLIP_DEVICE_CHECKLIST.md](SHARE_CLIP_DEVICE_CHECKLIST.md).

## Closed-alpha release evidence still open

- [ ] G0 first-time-player comprehension observation
- [ ] G1 same-session second- and third-round retention observation
- [ ] 50–100-person closed alpha with measured crash/error rate below 1%
- [ ] 100–250-user invite-only staged alpha before any public launch
- [ ] Real Safari desktop/mobile and physical mobile Chrome 50-round endurance
  evidence
- [ ] Physical iPhone/Android/Safari Story/Square/Wide clip-and-card
  share/export evidence, including explicit static fallback where encoding is
  unsupported
- [ ] Independent accessibility and assistive-technology audit
- [ ] Reviewed licensed deck provenance and human/browser promotion evidence
- [ ] Independent quantitative review of the first-passage implementation and
  monitoring assumptions
- [ ] Normal-mobile-network latency evidence beyond controlled Chromium shaping
  and local Compose
- [ ] Clean committed release SHA with hosted CI evidence
- [ ] Approved and produced 30-second marketing demo

The implementation-level G2 engine campaign is complete. Promotion remains
open because the checked-in deck catalog is synthetic and deliberately declares
`ranked_promotion_ready: false`, and automated continuations are not a human
browser playtest.

The service also has documented closed-alpha operational limits: round secrets
are not application-envelope-encrypted, scheduler discovery uses optimistic
revisions rather than durable leases, and live SSE fan-out is process-local.
Production fails closed to an explicit single-replica topology; any external
orchestrator must enforce that singleton until cross-instance pub/sub exists.
See [OPERATIONS.md](OPERATIONS.md) and [PERFORMANCE.md](PERFORMANCE.md).

## Later, outside the critical path

- Optional human rooms replacing unlocked bot slots
- Solana batch commitments and finished-round verifier
- Two-sided corridor and hidden-regime research
- Tail-aware generators only with a matching touch pricer

Real money, redeemable points, entry fees, shared survivor pots, wallets in the
core loop, and per-frame transactions remain explicitly out of scope.
