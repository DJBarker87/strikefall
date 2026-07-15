# Strikefall round service

This Axum service is the authoritative, points-only ranked-solo closed alpha. It
uses `strikefall-core` and the pinned official SolMath crate for every path,
probability, score, touch, and Escape calculation. It has no wallet, custody,
entry fee, prize, or redeemable-value API.

Run it locally:

```sh
cargo run -p strikefall-round-service
```

The default development listener is `127.0.0.1:3001`. Set `HOST=0.0.0.0` for a container
listener and `PORT` to override the port. CORS defaults to this repo's Vite
preview origin, `http://localhost:4173`; set `STRIKEFALL_ALLOWED_ORIGIN` for a
deployed web origin. `STRIKEFALL_TRUST_PROXY` defaults to false. Enable it only
when the service is unreachable except through a trusted reverse proxy that
overwrites `X-Real-IP`; otherwise clients could spoof the per-IP abuse key.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process liveness |
| `GET` | `/health/live` | Explicit process liveness |
| `GET` | `/health/ready` | Repository readiness |
| `GET` | `/v1/decks/{deck_id}/{version}` | Immutable ranked deck parameters |
| `POST` | `/v1/sessions` | Issue an anonymous closed-alpha bearer session |
| `GET` | `/v1/sessions/me` | Read the current anonymous profile |
| `POST` | `/v1/sessions/rename` | Change the public handle |
| `POST` | `/v1/sessions/rotate` | Rotate the bearer token and invalidate the old token |
| `POST` | `/v1/sessions/telemetry-consent` | Change explicit shared-telemetry consent |
| `POST` | `/v1/solo-rounds` | Create an authenticated committed hidden round |
| `POST` | `/v1/solo-rounds/{id}/flag` | Update the player flag during placement |
| `POST` | `/v1/solo-rounds/{id}/escape` | Use the one irreversible midpoint Escape |
| `GET` | `/v1/solo-rounds/{id}/stream` | Ordered Ed25519-signed SSE events |
| `GET` | `/v1/solo-rounds/{id}/result` | Status, then result and reveal after resolution |
| `GET` | `/v1/solo-rounds/{id}/replay` | Sealed until the post-round reveal |
| `POST` | `/v1/solo-rounds/{id}/replay-verified` | Persist one proof-digest verification receipt |
| `GET` | `/v1/leaderboards/{deck_id}` | Daily or weekly verified deck leaderboard |
| `GET` | `/v1/public-replays/{id}` | Trusted anchor plus replay, only after matching verification receipt |
| `POST` | `/v1/telemetry/batch` | Ingest explicitly consented strict schema-v2 product events |
| `GET` | `/v1/telemetry/metrics` | Admin-token aggregate product metrics and experiment cuts (no player rows) |

Request bodies are capped at 32 KiB. Flag writes are limited to one per 100 ms,
must increase an optional client sequence, must remain inside the deck's public
ranked risk band, and are rejected for the final 750 ms of placement. Repository
writes use optimistic revisions so concurrent updates cannot silently overwrite
each other.

Ranked BOTs publish one to three signed placement decisions only when their
canonical time arrives inside the final 12-second interactive window. Each
decision is immediately followed by its signed flag move and discloses reaction
latency, its public observation timestamp, and the full candidate-utility audit.
Only state at or before that observation timestamp is evaluated. The repository
cursor schedules the next move, so restart recovery preserves timestamps
without exposing future events.

Create a session with `{"inviteCode":"...","handle":"Rider-7","telemetryConsent":false}`.
The response contains an opaque `sf_alpha_...` bearer token exactly once; send it
as `Authorization: Bearer <token>` on every private session, round, leaderboard,
and telemetry route. Only a domain-separated token digest is persisted. Handles
are unique case-insensitively and limited to 3–20 ASCII letters, digits, `_`, or
`-`. Invite validation is fail-closed when `STRIKEFALL_REQUIRE_INVITE=true`.

Leaderboard queries accept `window=daily|weekly`, `limit=1..100`, and an opaque
`cursor`. They expose one best verified round per session, deterministic ties
(score descending, resolution time ascending, round ID ascending), current
public handles, and `selfEntry`. Scores are inserted from authoritative round
results only after the replay proof digest is acknowledged and the service has
independently rerun the full replay verifier against its stored commitment and
publisher-key anchors; no score-submission endpoint exists. Points have no cash,
token, prize, or redemption value.

The public replay route returns `PublicReplayResponseDto` as
`{"anchor": {"roundId", "protocolVersion", "commitment", "serverVerifyingKey"},
"replay": {...}}`. The anchor is populated independently from the immutable
authoritative round record. A viewer must use `anchor` as its external trust
input and reject any mismatch with the enclosed replay; it must never derive
the expected commitment or publisher key from `replay` itself.

The authoritative placement deadline is 32 seconds after creation. Clients use
the first 5 seconds for the deck reveal, the next 15 seconds for the approach,
and the final 12 seconds for interactive placement; the server may safely accept
an early valid placement, and freezes all input for the final 750 ms.

The service draws a fresh 256-bit master secret from the operating system for
each round. Canonical SHA-256 domains derive separate path material, bot seed
root, and commitment salt. Only the approach is returned at creation. Path seed,
bot root, salt, and the hidden battle path stay sealed until resolution. The
service emits the explicit `strikefall/ranked-replay/v3` schema; browser-local
practice replays use a different schema. Every event is hash chained and signed
with the process Ed25519 key.

Shared telemetry is fail-closed and consent-gated. The v2 endpoint accepts ten
named events with exact bounded properties; it rejects free text, arbitrary
timing, raw lobby/path data, and unknown fields. For an owned resolved round,
the service derives flag revisions, placement spread, survivors, eliminations,
early mass-wipe status, and the player's elimination step from the authoritative
round record. It uses server receipt time for eliminated-player response,
share-opened, and clip-exported actions. The operator endpoint exposes only
aggregates and exact persisted experiment cuts; it cannot identify unique people.

## Persistence and operations

- Development uses `InMemoryRoundRepository` unless `DATABASE_URL` is set.
  Production refuses memory storage and requires Postgres.
- `PostgresRoundRepository` stores the complete round as JSONB and uses an
  indexed scheduling deadline plus optimistic revisions for crash recovery.
- Production refuses to start without a stable Ed25519 seed loaded from
  `STRIKEFALL_SIGNING_KEY_FILE` or `STRIKEFALL_SIGNING_KEY`.
- Production also refuses to start unless
  `STRIKEFALL_STREAM_TOPOLOGY=single-replica`. Live SSE fan-out is process-local,
  so an orchestrator must enforce one service replica until a cross-instance
  push bus exists; sticky routing does not make multiple recovery workers safe
  for live delivery.
- The singleton runtime starts a recovery worker that reclaims overdue
  placement and battle rows. Optimistic revisions protect a brief controlled
  replacement race, but are not authorization to run a multi-replica service.
- SSE snapshots the durable event document before broadcasting live events.
  Reconnects may send the last signed sequence in `Last-Event-ID`; the service
  resumes after that sequence and rejects cursors ahead of durable state. Live
  fan-out remains process-local; reconnect is durable gap recovery, not a
  supported cross-instance delivery topology.
- Every 250 ms `battle_frame`, immediate `flag_cluster`/`flag_hit`, bot Escape
  audit, accepted Escape, round end, and seed reveal is persisted before it is
  broadcast. A delayed or restarted worker catches up using the original frame
  deadlines and the repository's optimistic revision.
- CORS permits one configured web origin plus `Authorization`, `Accept`,
  `Content-Type`, and `Last-Event-ID`. Anonymous identity, fixed-window
  session/IP abuse controls, persisted experiments, verified leaderboards, and
  consented telemetry are stored in Postgres in production.
- Default sessions sign mandatory Escape and risk-display assignments but no
  deck cohort. Unnamed Quick Runs use one CSPRNG byte to rotate all four decks;
  only an explicit `STRIKEFALL_EXPERIMENTS_JSON` deck-structure catalog pins
  the disclosed flat/compression closed-alpha treatment.
- The fixed-point core consumes a 64-bit deterministic path seed derived from a
  256-bit secret. The hidden salt prevents commitment guessing, but a future core
  seed API can retain the full derived key.
- A self-contained replay proves internal consistency, not who published it.
  Capture the creation response's commitment and server key, then pass both as
  external anchors to `replay-inspector` for publisher authenticity.

The full environment matrix, Docker Compose quickstart, migration procedure,
key rotation rules, health checks, recovery behavior, retention query, and exact
closed-alpha limitations are in [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md).

## Repository contract

`RoundRepository::save` updates only when `revision = expected_revision`, bumps
the revision in the same SQL statement, and persists the whole round, event
chain, reveal, and result atomically. `list_due` is an at-least-once scheduler
boundary; duplicate workers rely on that same optimistic update. Round secrets
are currently plain JSONB, so closed-alpha deployment requires encrypted storage
and backups while application-level envelope encryption remains future work.
