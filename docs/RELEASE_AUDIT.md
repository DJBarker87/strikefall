# Strikefall release audit

Audit date: 2026-07-15 (Europe/London)

This matrix compares the repository with
[the comprehensive product plan](../Strikefall_Comprehensive_Plan_Final.docx).
“Implemented” means the behavior exists with focused automated evidence. The
expanded integrated axe matrix passed 24/24 automated checks across desktop,
tablet, and mobile viewports and key states. Local evidence never substitutes
for a clean release SHA, hosted CI, human, physical-device, real-radio,
provenance, manual assistive-technology, independent-review, or production
evidence.
Detailed boundaries live in [FAIRNESS.md](FAIRNESS.md),
[PERFORMANCE.md](PERFORMANCE.md), [PLAYTEST.md](PLAYTEST.md),
[OPERATIONS.md](OPERATIONS.md), and [decks/CALIBRATION.md](decks/CALIBRATION.md).

## Status legend

- **Implemented + focused evidence** — code and direct tests or a retained
  measurement exist. Automated evidence is stated explicitly rather than
  inferred from this label.
- **Implemented; external acceptance open** — the engineering exists, but the
  plan's human, device, network, or production criterion is not locally provable.
- **Product-core variance / external** — Strikefall implements the need, but not
  the separately released upstream SolMath feature or independent sign-off
  described by the plan.
- **External evidence** — cannot be established from this repository alone.
- **Later by plan** — deliberately outside the first-public-alpha critical path.

## Primary modes and screen flow

| Area | Status | Evidence and boundary |
| --- | --- | --- |
| Quick Run | Implemented + focused evidence | One player plus 19 disclosed bots, no matchmaking, local Practice and opt-in ranked paths. Public Quick Run carries no deck cohort: fresh entropy selects each of the four decks uniformly. A mobile-emulation lane enforces entry under two seconds; normal-radio evidence remains open. |
| Daily Deck | Implemented + focused evidence | UTC featured rotation, missions, mastery, and explicit Daily-deck override of the deck-structure treatment. A production-Compose browser lane sends the featured ID with `deckVersion: 3`, requires a matching HTTP 201 authoritative deck without Practice downgrade, repeats with a distinct round/commitment pair, and verifies the resolved public replay. |
| Weekly Rivalry | Implemented + focused evidence | Each Monday UTC rotates one of the four featured decks, names an exact disclosed rival from the real Practice/ranked roster plus a deck condition, and persists bounded local attempts/completion. Every attempt uses an ordinary freshly seeded run path, and rematch preserves the featured deck. |
| Practice | Implemented + focused evidence | Selectable 9/19-bot casts and Easy/Normal/Hard difficulty, pause/resume, progression, and installed offline shell. Roster and difficulty are bound into the local replay, and implicit rematch preserves both. New rounds require the cached Rust/SolMath WASM engine and fail closed behind Retry if it cannot load. |
| Ranked alpha | Implemented + focused evidence | Anonymous session, authoritative lifecycle, Postgres, signed SSE, commit/reveal, verified-only ranking, public replay, and labelled Practice downgrade on sustained loss. |
| Home → reveal → approach → placement → lock → battle → result | Implemented + focused evidence | Responsive browser journeys cover input, timing, Escape, elimination/spectate, replay, result stories, sharing, and rematch. Ranked lock is a signed two-second beat. |
| Gauntlet, Private Room, Storm Event | Later by plan | These are post-alpha modes; live-price play and human matchmaking are not v1 dependencies. |

## FF-001 through FF-030

| ID | Status | Evidence and boundary |
| --- | --- | --- |
| FF-001 Arena state machine | Implemented + focused evidence | Deterministic approach → placement → lock → battle → result timing in `src/game/round.ts`; sound-enabled battle announces an escalating audible countdown from 10 through 1. |
| FF-002 Flag drag and side switch | Implemented + focused evidence | Pointer, touch, range, side, and keyboard controls clamp to the legal 12%–90% SolMath range. |
| FF-003 Line renderer and auto-zoom | Implemented + focused evidence | Canvas keeps the nearest active upper/lower flags visible and preserves meaning under reduced motion; static text/shape cues retain information when motion or flashing is suppressed. |
| FF-004 Elimination effects and feed | Implemented + focused evidence | Ordered continuous-extrema touches, cluster events, staggered impacts, killcam, feed, and no-duplicate guards. |
| FF-005 Prototype generator | Implemented + focused evidence | Four equal-total-variance schedules, deterministic paths, and versioned replay fixtures. |
| FF-006 Bot persona model | Implemented + focused evidence | Nineteen labelled bots span eight declared personas with isolated deterministic randomness. Presentation tells are color-independent, and named animated/flash tells retain a static reduced-motion/lower-flash alternative without changing scoring input. |
| FF-007 Bot placement loop | Implemented + focused evidence | Practice and ranked make one-to-three moves. Ranked commits 250–1,500 ms reaction latency, observes only public state at `action - latency`, publishes only due actions, and tests an intervening player move for no-future leakage. |
| FF-008 Crowd kernel prototype | Implemented + focused evidence | Exact Rust kernel uses `d_target = 0.8`, `h = 1.25`, and bounded factors; the browser performance lane enforces crowd-input dispatch below 16 ms at p99. |
| FF-009 Telemetry events | Implemented + focused evidence | Planned local vocabulary, bounded queue, strict consent-gated v2 shared subset, distinct telemetry and authoritative round-start sessions, deduplicated starts, second/third-round proxies, player outcomes, exact experiment cuts, operator dashboard, and safe exports. The service enriches owned resolved-round events from its own round record to derive bounded flag revisions, placement spread, survivor/elimination pacing, early mass wipes, five-second eliminated-player response, share intent, and clip export. Second/third rates use round-start sessions as the denominator; the G4 client-error-session rate uses telemetry sessions, is strictly `<1%`, and remains `insufficient` below 50. The identity-free schema cannot count unique people or filter client errors by deck; human gates remain external. |
| FF-010 First-passage API design | Product-core variance / external | Public fixed-point types, errors, `no_std` core, and monitoring contract exist in Strikefall. The plan's separately released upstream SolMath first-passage feature does not. |
| FF-011 No-touch implementation | Implemented + focused evidence | Upper/lower, drift, breach/limit behavior, paired rounding, and exact public conservation compose pinned `solmath = "=0.2.0"`. |
| FF-012 High-precision generator | Implemented + focused evidence | Manifest-bound 80-decimal `mpmath` corpora contain 100,000 production and 10,000 labelled adversarial vectors. Max observed errors are 276 and 546,984 scaled units, inside 200,000 and 1,000,000 bounds. |
| FF-013 Properties and monotonicity | Implemented + focused evidence | Conservation, monotonicity, reflection, limits, solver round trips, 25,000 supported-domain property cases, and 10,000 domain/overflow fuzz cases. |
| FF-014 SBF CU and footprint harness | Implemented + retained local evidence | A fresh 200-vector Agave/SBF report records math CU 10,904 average, 11,308 p99, 11,317 max (<30,000), a 107,608-byte quote artifact, and 85,256-byte linked delta. Both measured binaries are retained; ordinary CI recomputes their sizes/hashes and the declared source/tooling manifest. The run honestly has no clean commit binding, so hosted release evidence remains open. |
| FF-015 Deck schema and validation | Implemented; external acceptance open | Versioned fixed schedules, digests, bridge convention, catalog schema, provenance fields, and campaigns exist. The sample catalog is synthetic and intentionally not promotion-ready. |
| FF-016 Deterministic path generator | Implemented + focused evidence | Native, WASM, protocol, and replay fixtures regenerate closes plus committed interval highs/lows. |
| FF-017 Probability-to-barrier solver | Implemented + focused evidence | Bounded monotone upper/lower search and legal-range round trips use exact fixed strings. |
| FF-018 Scoring engine | Implemented + focused evidence | Rust/SolMath owns risk, crowd, terminal score, live quote, outcome, and exact fixed-point Escape. |
| FF-019 Bot audit trace | Implemented + focused evidence | Ranked replay v3 retains all candidate barriers, quotes, crowd factors, scores, utilities, selection, reason, public/entropy digests, observation/action timestamps, and latency; native/WASM replay and inspector verify them. |
| FF-020 WASM package | Implemented + focused evidence | Browser startup loads and smoke-tests WASM before mounting play; failure blocks new rounds. Practice retains canonical fixed path/extrema, spot, barrier, remaining variance, score, touch, Escape, and rank inputs end to end. Exact-integer outcome comparisons fail closed when a fixed barrier is missing; Escape multiplication matches `solmath::fp_mul`. JavaScript `Number` is presentation/control/bot-policy only; the TypeScript fallback is legacy replay metadata, not a new-round scorer. |
| FF-021 Round creation API | Implemented + retained local evidence | Authoritative CSPRNG, commitment, approach, player placement, 19 bots, and persistence exist. The final production-shaped run used exactly 3 warmups, 25 samples, and 4 sessions; it retained every raw timing and measured 6.52 ms p50, 7.98 ms p95, and 8.21 ms maximum (<300 ms), bound to a 45-file source/tooling manifest plus exact healthy image/container identities. Its validator passes, but `releaseBound` is false because the repository has no `HEAD` and all files are untracked. The ranked Daily lane additionally proves two exact featured-deck v3 creates return 201 with distinct UUIDs and commitments. A separate warm-cache controlled Fast 3G browser run measured 275.37 ms from Ranked Run click to committed deck plus proof; it is not real-radio evidence. |
| FF-022 Authoritative placement stream | Implemented + focused evidence | Player updates and timed bot actions are signed, ordered, rate-limited, frozen, cursor-persisted, and recovery-tested. |
| FF-023 Battle stream and hit service | Implemented + focused evidence | Signed 250 ms closes/extrema, immediate touches/clusters, Escape, SSE recovery, and presentation reconciliation. |
| FF-024 Commit-reveal verifier | Implemented + focused evidence | Browser-native and exact Rust/WASM verification reject mutated deck, path, extrema, bot audit, lock timeline, event, signature, result, or external anchor. A caught ranked mismatch fails closed and emits only one consent-gated bounded `verification_failed`/`replay` fact for the same failure object, with no diagnostic payload. |
| FF-025 Escape command | Implemented; external acceptance open | Exactly one action, midpoint open/final-three-second close, fixed `Q_t`, bot policies, hindsight copy, and absent/midpoint treatment. Only observed A/B evidence can establish improved agency. |
| FF-026 Replay inspector CLI | Implemented + focused evidence | Ranked JSON plus independently captured commitment/key produces a human-readable deterministic audit. |
| FF-027 Result and rematch | Implemented; external acceptance open | Result proof/stories and one-tap rematch exist. Local mobile emulation enforces the two-second budget; controlled Fast 3G ranked startup measured 275.37 ms, while real-radio and physical-device timing remain open. |
| FF-028 Clip buffer/export | Implemented; external acceptance open | Bounded 15 fps compositors export independently finalized, decoded 720×1280 Story, 720×720 Square, and 1280×720 Wide clips with finite intrinsic 8–12 second durations and public overlays. Keyed candidate retention keeps the selected cluster wipe, late-hit near miss, Escape, or held-survivor closest-approach step aligned to its own live window and never substitutes an earlier candidate or unrelated tail. Practice selects the frame with exact fixed-point distance; Ranked selects it from signed fixed extrema/result data. Internal capture fields are omitted from replay-v4's canonical wire shape. Static cards render at 1080×1920 Story, 1080×1080 Square, and 1920×1080 Wide; reduced motion never starts the video encoder. Native share sheets, device codec acceptance, and heat remain open on physical targets. |
| FF-029 Experiment framework | Implemented; external acceptance open | Escape and risk-display are mandatory real treatments. Public Quick Run carries no deck cohort and rotates all four decks uniformly; explicit closed-alpha policy may add the real `deck-structure:v2` A/B and pin its treatment. Only present assignments enter signed rounds/replays and exact dashboard cuts. Cuts remain descriptive until sufficient human cohorts exist. |
| FF-030 Solana batch commitment | Later by plan | Correctly absent from the twelve-week critical path; the SBF quote harness is measurement only. |

## Continuous monitoring and G2 balance evidence

Active Deck v3 preserves frozen v2's
`strikefall/brownian-bridge-extrema/v1` contract and adds a disclosed per-deck
opening runway: every 250 ms interval commits a conditional Brownian-bridge
high and low. Touches, closest approach, Canvas wicks, Escape hindsight,
events, commitments, and replay verification consume the same extrema. Each
upper/lower one-sided marginal is exact before fixed-point rounding;
independent upper/lower uniforms approximate their joint same-interval
dependence, and touch time is quantized to the frame boundary.
The separate 100,000-sample campaign observes a 0.2305 percentage-point worst
quote/monitor residual against a 0.75-point ceiling; endpoint-only monitoring is
the negative control.

`src/game/balanceG2.test.ts` evaluates eight survival bands, both sides, four
locked lobbies × 320 common continuations per deck, and 2,560 side outcomes per
band/deck. With `d_target = 0.8` and `h = 1.25`, the largest exact expected
band/deck-mean ratio is about 1.126 (<1.15), the worst paired one-sided 99%
realized-advantage UCB is 17.3% (<22%), and every natural crowd-factor span is at
least 0.30. This closes the automated no-dominant-band claim for the tested
engine distribution, not licensed provenance or human browser behavior.

## Twelve-week exit criteria

| Week | Local result | Remaining acceptance |
| --- | --- | --- |
| 1 Prototype hardening | Engineering complete | G0/G1 observed comprehension and fun evidence. |
| 2 Rust core | Engineering complete | Clean release SHA and hosted-CI evidence. |
| 3 First-passage maths | Product core complete | Upstream SolMath release and independent review. |
| 4 Validation and WASM | Engineering complete | Independent review and clean hosted-CI evidence. |
| 5 Real scoring | Engineering complete | Human/browser promotion evidence and licensed deck inputs. |
| 6 Bot engine | Engineering complete | Human fun/tuning evidence. |
| 7–8 Ranked service and trust | Engineering complete | Hosted operations/security evidence for the chosen deployment. |
| 9 Escape | Mechanic and treatments complete | Observed agency/rematch A/B outcome. |
| 10 Replay and sharing | Engineering complete | Physical target-device share/export matrix. |
| 11 Closed alpha | Tooling complete | 50–100 real testers and measured error rate below 1%, followed by a 100–250-user invite-only stage before public launch. |
| 12 Launch candidate | Engineering/doc set complete | Physical Safari and mobile Chrome endurance, real-radio timing, independent accessibility audit, clean release SHA/hosted CI, the completed invite-only stage, external gates, and approved 30-second marketing demo. |

## Public-alpha definition of done

| Requirement | Status | Boundary |
| --- | --- | --- |
| Quick Run under two seconds; no humans waited for | Implemented; external acceptance open | No matchmaking and enforced local mobile-emulation budget. Warm-cache ranked click to committed deck plus proof measured 275.37 ms under controlled Fast 3G; normal real-radio and physical-device timing remain unmeasured. |
| Bot labels and reproducible decisions | Implemented + focused evidence | Full ranked candidate/timestamp audit and no-future regression. |
| Ranked replay verifies or is excluded | Implemented + focused evidence | Service receipt gates ranking and public replay. |
| Four decks paced; no dominant band | Implemented; external acceptance open | Engine G2 campaign passes; licensed provenance and observed browser pacing remain open. |
| First-passage SolMath release independently evidenced | Product-core variance / external | Strikefall composition is extensively validated; upstream release and independent quant sign-off are absent. |
| Pricing and touch monitoring agree | Implemented with declared boundary | Continuous one-sided bridge-extrema marginals; joint two-sided dependence remains approximate. |
| No raw JavaScript `Number` for scoring/probability | Implemented + focused evidence | Exact WASM/fixed-string/BigInt path for every new round; `Number` only after scoring for display/control. |
| Physical mobile Chrome and Safari 50-round endurance | Implemented locally / external | Current desktop Chromium 50-round forced-GC soak and Playwright WebKit resilience pass; 50-round endurance with OS-level inspection remains open on physical mobile Chrome and real desktop/mobile Safari. |
| Accessibility and privacy | Implemented + focused evidence | Motion/flash/sound/shape/keyboard/touch/privacy controls exist. The expanded integrated axe WCAG A/AA matrix passed 24/24 automated checks across desktop/tablet/mobile and key states with no disabled rules or DOM exclusions; manual assistive-technology testing and an independent accessibility audit remain open. |
| Rematch, card, and near-miss clip on targets | Implemented; external acceptance open | Browser dimensions and fallbacks pass focused automation; physical-device sharing remains open. |

## Release evidence still open

1. Observe 8/10 first-time-player comprehension and the G1 60% second-round /
   35% third-round retention gates.
2. Run a 50–100-person closed alpha and measure crash/error rate below 1%.
3. After that gate, complete a 100–250-user invite-only staged alpha before any
   public launch.
4. Complete 50 rounds on real desktop/mobile Safari and physical mobile Chrome
   with OS-level memory inspection; exercise Story/Square/Wide clip-and-card
   sharing and explicit static fallback on physical iPhone and Android targets.
5. Replace the synthetic catalog with reviewed licensed provenance and record
   the human/browser promotion campaign.
6. Obtain independent quantitative review before claiming a SolMath
   first-passage release.
7. Record normal-mobile-network latency, not only controlled Chromium shaping.
8. Complete an independent accessibility and assistive-technology audit.
9. Record a clean committed release SHA and hosted-CI/deployment evidence.
10. Approve the marketing brief and produce the required 30-second demo.

The repository currently has no `HEAD`, all files are untracked, and both
retained machine-readable reports correctly record `releaseBound: false`.
Together with the external items above, that makes public launch a no-go.

Gauntlet, private human rooms, Storm Events, optional Solana batch commitments,
hidden regimes, tail/jump decks, corridor play, sabotage, real money, wallets,
and redeemable value remain later by plan.
