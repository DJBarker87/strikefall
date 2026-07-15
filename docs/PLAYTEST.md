# Strikefall observed playtest protocol

Automated balance and browser suites protect correctness; they cannot prove
that a person understands the rule or wants another round. Run this script with
15–25 first-time players before opening the alpha.

## Session setup

1. Use a mobile device the participant would normally play on.
2. Say only: “This is a short points game. Please think aloud.”
3. Do not explain options, probability, bots, crowding, or Escape before play.
4. Observe at least three available rounds without prompting a rematch.
5. Record confusion and exact words, not interpretations. Do not record video or
   personal data without explicit consent.

After round one, ask: “What destroys a flag?”, “What changes the score?”, “What
did the crowd do?”, and “What would Escape do?” After the session, ask which
moment they would share and what they would change.

## Pass gates

- At least 8/10 can plant a flag and predict a touch without explanation.
- At least 60% of completers start a second round in the same session.
- At least 35% start a third.
- Median placement revisions are at least two.
- At least 70% of eliminated players spectate or rematch within five seconds.
- At least 80% can explain touch, multiplier, and crowding after one round.
- At least 15% use or request sharing after a dramatic moment.

For pacing, confirm 2–6 median untouched survivors, fewer than 10% no-hit
rounds, fewer than 10% first-ten-second mass wipes, both sides populated, and at
least six risk bands across typical lobbies. Compare Escape-on and Escape-off:
it passes only if agency improves without weakening rematch or causing automatic
midpoint exits.

Treat versioned assignments as real treatments, not labels. Escape
(`absent|midpoint`) and risk display (`probability|danger-band`) are always
assigned. Public Quick Run should show no `deck-structure:v2` key and should
exercise all four decks; only an explicitly configured closed-alpha cohort may
show `flat|compression-break` and pin that deck. Practice and ranked use separate
subjects, so record the assignment map shown for the round rather than assuming
they match. Do not interpret a dashboard cut until its sufficiency label passes.

For Practice balance, record both cast size (9 or 19) and Easy/Normal/Hard
difficulty. An implicit rematch must preserve those settings, and the result
replay must reproduce the same bound roster and difficulty; changing either is
an explicit new-round choice, not a silent rematch mutation.

For the Weekly rivalry, record the Monday-UTC challenge ID, featured deck,
exact named rival, deck condition, attempt number, and completion state. Confirm
that the named rival is present in the ordinary bot cast, each attempt receives
a fresh unseen path, and rematch keeps the featured deck. Locally persisted
attempts are progression evidence, not proof that different people returned.

## Decision log

Record build SHA, device/browser, deck, experiment assignments, completed
rounds, revision count, elimination response, share response, comprehension
answers, and one verbatim observation. End each cohort with an explicit
continue / tune / remove / stop decision. Human gate checkboxes in the roadmap
remain open until this evidence exists.

Before a public alpha, also record 50–100 distinct closed-alpha testers and a
measured crash/error rate below 1%. Automated rounds, local profiles, and a
test-runner pass rate do not count as people or production error-rate evidence.
After that cohort passes, run a distinct 100–250-user invite-only staged alpha
before any public launch. That stage must use the production monitoring and
rollback process; repository automation cannot satisfy it.

### Operator metric semantics

The consented service aggregate counts distinct anonymous telemetry sessions,
distinct authoritative round-start sessions, deduplicated round IDs,
round-start sessions with at least two and three starts, player result outcomes,
and distinct sessions containing one or more bounded `client_error` events.
The second/third-round rates use round-start sessions as their denominator. The
G4 engineering signal uses telemetry sessions as its denominator, is strict at
fewer than 1% error sessions, and stays `insufficient` until at least 50 distinct
telemetry sessions are present. One session can contain several errors but
contributes only once to the rate. This is a browser-session proxy, not a
unique-person or operating-system crash rate, so it supports—but cannot close—
the observed 50–100-person gate above.

Telemetry v2 still does not accept raw lobby state, contender coordinates,
paths, or arbitrary client timing. Instead, when an owned round reaches lock or
result, the service derives bounded flag-revision, side/risk-band spread,
survivor, elimination-step, and early-cluster facts from the authoritative
round record. Explicit `dead_player_response`, `share_opened`, and
`clip_exported` actions carry only the owned round/deck references (plus the
spectate/rematch choice); the service replaces their timestamps with receipt
time. Central aggregates can therefore calculate authoritative pacing,
five-second dead-player response, share intent, clip export, and exact persisted
experiment cuts. Second/third-round counts remain repeat-start proxies, and no
aggregate is a unique-person count or a substitute for observed comprehension.
The on-device dashboard remains useful for local-only events; do not merge the
two sources by inventing missing denominators.

Because the privacy-bounded shared `client_error` event contains no deck ID,
the G4 error-session gate cannot be filtered by featured deck or deck-structure
treatment. Experiment cuts remain available only for aggregates whose source
events carry the exact present assignment keys.

## Automated endurance and resilience lane

The observed-player gates above remain human evidence. Before each playtest
build, run the complementary browser checks:

```sh
npm run test:qa:smoke
npm run test:qa:soak
npm run test:qa:performance
npm run test:e2e:a11y
npm run test:e2e:ranked-daily
npm run test:performance:ranked-mobile
npx playwright test e2e/share-clip.spec.ts --project=desktop-1280
```

The smoke lane verifies system and explicit reduced-motion behavior, proves
that telemetry defaults to a local queue and that “Off” clears and suppresses
it, and proves that a browser without WebAssembly stops at a clear SolMath
retry screen with no playable controls. It must never select the legacy
TypeScript replay decoder as a new-round scorer. The production offline-install
lane separately proves that the service worker precaches the versioned WASM
asset, then reloads offline and completes a Practice round through the same
Rust/SolMath engine.

The soak lane runs 50 consecutive real phase-machine rounds in desktop Chrome.
Every five rounds it forces a V8 garbage collection through Chromium's DevTools
protocol and samples heap, document, DOM-node, and JavaScript-listener counts.
It fails on sustained late-run growth, unbounded telemetry, runtime errors, or
an incomplete result. The HTML report at `e2e/qa/report-soak/index.html` and
its attached `soak-memory-report.json` contain the exact samples. The smoke
report is kept separately at `e2e/qa/report-smoke/index.html`; this is a
regression guard, not a substitute for OS-level memory profiling on release
hardware.

The accessibility lane runs axe WCAG A/AA rules over the landing/lobby,
dialogs, placement/battle, result/share/replay, offline and error recovery,
invalid public-replay recovery, and ranked-ready/fallback states at desktop,
tablet, and mobile viewports. It has no disabled axe rules and no DOM
exclusions. The expanded integrated matrix passed 24/24 automated checks across
those viewports and key states. Automated axe checks do not replace a
keyboard/screen-reader review or an independent accessibility audit.

WebKit is opt-in because Playwright does not install every browser by default:

```sh
npx playwright install webkit
npm run test:qa:webkit
```

Passing Playwright WebKit is a Safari-compatibility signal, not a claim that
real desktop or iOS Safari was tested. Record actual Safari device evidence in
the decision log above.

The local performance lane records Quick Run and rematch time plus 160
alternating crowd inputs. Its enforced budgets are under 2,000 ms for each
transition and under 16 ms for crowd-input dispatch at p99. With the production
Compose stack running, `npm run test:performance:ranked-mobile` warms the
fingerprinted JavaScript, CSS, and SolMath WASM assets, then measures Ranked Run
click through committed deck and proof under controlled Chromium Fast 3G
shaping. The retained run measured 275.37 ms against the 2,000 ms target at
150 ms latency, 1,600 Kbps download, and 750 Kbps upload. These are controlled
browser-emulation results, not normal real-radio or physical-phone evidence.

The share lane decodes real, independently finalized Chromium exports and
checks finite intrinsic durations of 8–12 seconds plus 720×1280 Story, 720×720
Square, and 1280×720 Wide video dimensions. Event-key assertions prove that a
retained held-survivor closest-approach step is not replaced by its earlier
candidate or an unrelated result tail. The same keyed path covers cluster
wipes, late-hit near misses, and Escape. The lane also checks exact 1080×1920
Story, 1080×1080 Square, and 1920×1080 Wide card
dimensions. Layout tests cover public branding, deck, multiplier, the labelled
bot field, result, and moment overlays; reduced motion produces static cards
without starting a video encoder. Native share sheets, device codec acceptance,
heat, and physical-device duration still need the matrix in
[SHARE_CLIP_DEVICE_CHECKLIST.md](SHARE_CLIP_DEVICE_CHECKLIST.md).

### Current integrated automated evidence

On 2026-07-15 (Europe/London), the final uncommitted tree produced:

- Endurance soak: 50/50 consecutive real phase-machine rounds completed in 1.6
  minutes with no page, console, or runtime failures. Telemetry remained at its
  explicit 500-event cap.
- Forced-GC heap: 6.31 MiB at round 5 and 7.25 MiB at round 50; warm median
  6.80 MiB, tail median 7.22 MiB, and a late-run slope of 5,392 bytes per round
  (5.27 KiB/round), far below the 384 KiB/round guard.
- DOM: one document throughout, 1,643 nodes at round 5 and 1,650 at round 50;
  late node slope 2.58 per round and listener slope -0.02 per round.
- Chromium resilience/offline: 4/4 passed; Playwright WebKit resilience: 3/3
  passed; mobile performance: 1/1 passed.
- The responsive product matrix covers desktop, tablet, and mobile. The
  expanded integrated accessibility matrix passed 24/24 automated axe checks
  across those viewports and key states, with no disabled rules or DOM
  exclusions. The separate visual matrix retained 18 full/reduced-motion
  screenshots; real Chromium Story/Square/Wide encoding and all three static
  card exports passed at their declared dimensions.
- Production Compose: the 25-sample API gate and a complete ranked/public-replay
  journey passed in exact CI order while 29 authoritative rounds were active.
  The separate ranked Daily lane passed 1/1: two featured-deck v3 POSTs each
  returned 201 without Practice downgrade, retained the same Daily deck but
  produced distinct round IDs and commitments, and the second public replay
  verified in the browser.
  The separate warm-cache controlled Fast 3G ranked interaction measured
  275.37 ms from click to committed deck plus proof.

This is current automated evidence, not observed human fun/comprehension,
physical-device sharing, normal-radio latency, real Safari or physical mobile
Chrome 50-round endurance, or an independent accessibility audit. Record those
results, complete the 100–250-user invite-only stage, and bind the evidence to a
clean committed SHA before promotion.

The run generated the attached JSON sample set in its Playwright HTML report.
Generated browser reports are ignored by git; rerunning the commands above recreates
the separate smoke, soak, and WebKit artifacts. Playwright WebKit is a useful
engine-compatibility signal, but this evidence still makes no claim about real
desktop/mobile Safari or physical mobile Chrome hardware. Fifty consecutive
rounds with OS-level memory inspection remain open on those targets. The
current repository has no `HEAD`, all files are untracked, and retained
machine-readable evidence is not release-bound, so public launch is a no-go.
