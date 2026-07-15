# Strikefall alpha privacy notice

Strikefall is a points-only game. Quick Run does not require a name, email,
wallet, payment method, social account, or blockchain transaction.

## What the browser stores

The browser stores an opaque anonymous alpha session token. The ranked public
handle and server experiment assignments are reloaded from the service; the
separate practice profile stores its local callsign and progression. The
browser also stores accessibility/privacy preferences, local experiment
assignments, and at most 500 local product events. Those events describe
bounded gameplay and interface actions. They do not include wallet data, typed
chat, contact lists, live asset positions, or precise location.

Telemetry defaults to **local only**. The current UI uses that bounded queue for
the on-device alpha dashboard and does not upload it. A player can turn
telemetry off, which stops new events and clears the queue, or explicitly
choose **shared** to allow a small ranked-lifecycle schema to be sent to the
closed-alpha metrics endpoint as transitions occur. Network upload never occurs
under the local default. A failed direct ranked upload does not block play and
is not silently retried. Telemetry v2 accepts only ten named event types with
exact property sets: seven lifecycle/performance/error facts plus
`dead_player_response`, `share_opened`, and `clip_exported`. The three action
facts are sent only for an owned authoritative round, use server receipt time,
and contain no free text. The service rejects arbitrary fields, replay secrets,
forged round results, and unrecognized error strings.

For owned ranked rounds, the service enriches accepted placement and completion
facts from the authoritative round record. It stores bounded counts and
booleans—flag revisions, side/risk-band spread, survivors, elimination pacing,
and early-cluster presence—not contender coordinates or path samples. Central
metrics therefore derive five-second elimination response, pacing, share intent,
and exact persisted experiment cuts without trusting browser-supplied outcomes.
The browser's richer local dashboard remains separate; neither source identifies
a unique person or replaces an observed playtest.

The shared `client_error` event contains exactly two bounded enum values: a
failure code and a product surface. Ranked proof mismatches use only
`verification_failed` plus `replay`. Error messages, stacks, verifier check
names, round or contender identifiers, paths, seeds, commitments, and mismatch
details are never placed in the local event payload or sent to the service.
Error objects are used only as in-memory deduplication identities.

## Ranked rounds

The ranked service receives an opaque bearer token, deck selection, rate-limited
flag updates, an optional Escape command, and standard connection metadata
needed to operate the HTTP service. It stores only a domain-separated digest of
the bearer token, invite code, and creation IP address—not their raw values. It
also stores the public handle, persisted experiment assignments, versioned
round state, ordered signed events, results, and replay proof material. A replay
deliberately reveals the finished synthetic path and bot audit data after
resolution; it does not contain a session identifier or public handle and never
reveals another player’s future path.

Anonymous sessions expire after seven days by default. Shared telemetry expires
after 30 days by default; operators can shorten both windows within documented
bounds. Operational logs must not contain unrevealed path seeds, signing
secrets, raw authorization tokens, invite codes, IP addresses, or full client
storage dumps.

## Player controls

- Telemetry: off, local only, or explicitly shared.
- Lower flash and reduced motion settings.
- Clear local profile, progression, and event history.
- Play practice rounds when ranked networking is unavailable.

This notice must be updated before accounts, prizes, payments, wallets, third-
party analytics, or new categories of personal data are added.
