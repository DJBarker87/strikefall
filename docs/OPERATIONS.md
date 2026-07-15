# Strikefall production operations

This runbook covers the production-shaped web edge and authoritative,
points-only closed-alpha round service. The edge serves the Vite SPA and proxies
same-origin `/api/*` requests to the service; the service persists complete
replayable rounds in Postgres and loads one stable Ed25519 publisher key at
startup. Strikefall does not provide wallets, custody, entry fees, prizes, or
redeemable balances.

## Local persistent stack

Generate a 32-byte signing seed, keep it stable between restarts, and start the
web edge, service, and Postgres:

```sh
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export STRIKEFALL_SIGNING_KEY="$(openssl rand -hex 32)"
docker compose up --build
curl --fail --include http://localhost:4173/healthz
curl --fail --include http://localhost:4173/api/health/ready
```

`docker compose down` preserves the `strikefall-postgres` volume. `docker
compose down --volumes` irreversibly removes local round history. The compose
file deliberately uses production startup checks, so it refuses to start if the
database password or signing key is absent. The browser is at `http://localhost:4173`; the round
service has no host-published port and is reachable only through `/api`.

`.env.example` documents every Compose-facing setting. Copy it to `.env`,
replace its required placeholders, and keep that file out of version control.
`docker compose config` validates interpolation before a deployment and fails
when either required secret is absent. Do not put
an empty `STRIKEFALL_INVITE_CODES` in `.env`: omit it unless invite access is
enabled.

For a process-only development server, omit `DATABASE_URL` and run `cargo run -p
strikefall-round-service`. Development defaults to memory storage and warns
that its generated signing key is ephemeral.

## Required production configuration

| Variable | Meaning | Production rule |
| --- | --- | --- |
| `STRIKEFALL_ENV` | `development` or `production` | Set `production` |
| `STRIKEFALL_REPOSITORY` | `memory` or `postgres` | Must be `postgres` |
| `DATABASE_URL` | SQLx Postgres connection URL | Required; use TLS (`sslmode=verify-full`) outside a private local network |
| `STRIKEFALL_SIGNING_KEY_FILE` | File containing 32 raw bytes or 64 hex characters | Preferred; file mode must deny group/other access on Unix |
| `STRIKEFALL_SIGNING_KEY` | 64-character hex signing seed | Alternative secret-manager injection; never commit it |
| `STRIKEFALL_ALLOWED_ORIGIN` | Exact web origin allowed by CORS | Set to the deployed HTTPS origin |
| `STRIKEFALL_TRUST_PROXY` | Trust the single-hop `X-Real-IP` header | Compose sets `true` because the service is not published; never enable on a directly reachable service |
| `STRIKEFALL_STREAM_TOPOLOGY` | Live-event delivery topology acknowledgement | Required value is `single-replica`; production startup rejects absence or any other value while SSE fan-out is process-local |
| `STRIKEFALL_REQUIRE_INVITE` | Require a configured invite at session creation | Set `true` for an invite-only external alpha |
| `STRIKEFALL_INVITE_CODES` | Comma-separated 8–128-character invite codes | Required and non-empty when invites are required; inject as a secret |
| `STRIKEFALL_SESSION_TTL_HOURS` | Anonymous session lifetime, 1–720 hours | Default `168` |
| `STRIKEFALL_TELEMETRY_RETENTION_DAYS` | Raw consented-event lifetime, 1–90 days | Default `30`; run the cleanup job below |
| `STRIKEFALL_METRICS_TOKEN` | Operator bearer token for `/v1/telemetry/metrics` | Optional; metrics fail closed when absent |
| `STRIKEFALL_EXPERIMENTS_JSON` | Shipped v2 treatment catalog | Optional override; Escape and risk are mandatory, while deck structure is an explicit closed-alpha opt-in |
| `VITE_STRIKEFALL_DECK_STRUCTURE_EXPERIMENT` | Local Practice deck A/B build policy | Leave unset for public four-deck rotation; the only enabling value is `closed-alpha` |
| `STRIKEFALL_EDGE_TRUSTED_PROXY_CIDR` | Source CIDR allowed to supply the edge's client `X-Real-IP` | Default loopback; set to the exact external TLS-gateway source CIDR |
| `STRIKEFALL_WEB_BIND` | Host address mapped to edge port 8080 | Default `127.0.0.1`; expose only to the TLS gateway |
| `STRIKEFALL_WEB_PORT` | Host port mapped to edge port 8080 | Default `4173`; the only Compose-published application port |

Exactly one signing-key variable may be set. Production aborts before binding a
socket if the key is missing, malformed, or (for a file on Unix) accessible to
group/other; it also aborts if memory storage is selected or the explicit
single-replica stream topology is absent. A valid file setup is typically:

```sh
install -m 0400 /dev/stdin /run/secrets/strikefall-signing-key <<EOF
$(openssl rand -hex 32)
EOF
```

Invite codes, bearer tokens, and client IP addresses are never persisted in raw
form. The database holds domain-separated hashes, and telemetry accepts only a
bounded event/property whitelist after explicit consent. An invite code is an
access-control secret, not a payment instrument; every score remains
nonredeemable.

External rollout stays invite-only after the 50–100-person error-rate cohort:
complete a distinct monitored 100–250-user staged alpha, including the rollback
drill below, before considering public launch. Repository automation cannot
close that operational gate.

Do not casually rotate this key. The public key is included in each replay, but
a verifier needs the independently published key to establish who issued it.
Before rotation, archive and publish the old public key with its validity window;
then let every active round resolve, drain old instances, and deploy the new key
as one coordinated release. Startup and readiness reject any active row whose
stored publisher key differs from the instance key, and mutation paths repeat
the check so a heterogeneous deployment cannot corrupt an in-flight proof.

Optional tuning variables:

| Variable | Default | Notes |
| --- | ---: | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | Container sets `0.0.0.0` |
| `STRIKEFALL_DB_MAX_CONNECTIONS` | `10` | Per service instance |
| `STRIKEFALL_DB_CONNECT_TIMEOUT_MS` | `10000` | Pool acquisition/startup timeout |
| `STRIKEFALL_RUN_MIGRATIONS` | `true` | Set false when migrations run as a separate release job |
| `STRIKEFALL_ROUND_RETENTION_DAYS` | `30` | Stored on each new row as `retention_until` |
| `STRIKEFALL_RECOVERY_INTERVAL_MS` | `250` | Minimum accepted value is 100 ms; 250 ms matches battle pacing |
| `STRIKEFALL_RECOVERY_BATCH_SIZE` | `100` | Maximum overdue documents inspected per pass |
| `STRIKEFALL_RECOVERY_CONCURRENCY` | `4` | Concurrent due-round transitions; capped at 4 and must leave two connections free in pools larger than two |
| `STRIKEFALL_PLACEMENT_DURATION_MS` | `32000` | 5s deck reveal + 15s approach presentation + 12s interactive placement |
| `STRIKEFALL_INPUT_FREEZE_MS` | `750` | Final placement freeze |
| `STRIKEFALL_FLAG_UPDATE_INTERVAL_MS` | `100` | Per-round write throttle |
| `STRIKEFALL_ESCAPE_CLOSE_MS` | `3000` | Escape closes this long before battle end |

## Versioned experiment policy

The public/default service assigns the two mandatory treatments that change
shipped behavior:

```json
{
  "escape:v2": ["absent", "midpoint"],
  "risk-display:v2": ["probability", "danger-band"]
}
```

With no `deck-structure:v2` key, each new Quick Run selects from all four decks
using one CSPRNG byte; the four-entry catalog divides the 256-value domain
exactly. To run the real deck-structure A/B in a controlled closed alpha, set
the server catalog to:

```json
{
  "deck-structure:v2": ["flat", "compression-break"],
  "escape:v2": ["absent", "midpoint"],
  "risk-display:v2": ["probability", "danger-band"]
}
```

Build the web shell with
`VITE_STRIKEFALL_DECK_STRUCTURE_EXPERIMENT=closed-alpha`. The two systems use
separate anonymous subjects, so their variants are not claimed to match.

An assignment is stable on the anonymous session, copied into every ranked
round, signed in `round_created`, verified in replay v3, and included in the
public anchor. An explicit Daily or Weekly deck overrides the optional Quick
deck treatment and removes `deck-structure:v2` from that round's effective map;
rematches request the deck just played. `escape:absent` rejects the player
command and suppresses bot Escape evaluation; the risk treatment changes exact
SolMath placement copy, not scoring. Unknown keys, legacy labels, wrong
versions, and invalid variants fail closed at startup or round verification.
Dashboard cuts are descriptive until sample thresholds and human A/B evidence
are met.

The JSONB schema already accepts both maps. Existing three-key sessions and
replays retain their honest historical treatment and remain verifiable; newly
issued public sessions receive two keys. Do not rewrite old assignment maps or
backfill a synthetic deck cohort, so no destructive SQL migration is required.

## Web edge, client IP, and TLS

`Dockerfile.web` builds the browser with Node 22 and serves only the resulting
static files from an unprivileged nginx process on container port 8080. The
ranked API base is compiled as `/api`; nginx removes that prefix before proxying
to `round-service:3001`. Hashed `/assets/*` responses are immutable for one
year, navigation/HTML and API responses are `no-store`, and `.wasm` is served as
`application/wasm` under `X-Content-Type-Options: nosniff`. Unknown asset paths
return 404 while unknown navigation paths receive the SPA entry point.

The `/api` proxy deliberately disables response/request buffering, caching,
compression, and automatic upstream retry. Its 75-second read timeout exceeds
the service's 10-second SSE heartbeat. This preserves low-latency event frames
and avoids replaying a non-idempotent command after an ambiguous upstream
failure.

Compose publishes only the web port. It sets `STRIKEFALL_TRUST_PROXY=true` on
the non-published round service, while nginx overwrites `X-Real-IP` with the
address it actually accepted. Do not publish port 3001 or enable this option in
a topology where untrusted clients can reach the service directly; they could
otherwise spoof the address used by abuse controls.

This image serves plaintext HTTP. Production TLS, HSTS, certificates, and
public request-size/connection controls belong at an external gateway or load
balancer. Keep `STRIKEFALL_WEB_BIND` private to that gateway (or enforce the
equivalent host firewall) so public clients cannot bypass TLS. Configure
`STRIKEFALL_EDGE_TRUSTED_PROXY_CIDR` to that gateway's
exact source CIDR and require it to overwrite (not append or preserve)
`X-Real-IP` with a verified client address. The default `127.0.0.1/32` trusts no
remote header. The TLS gateway must also leave `/api/*` SSE unbuffered and
uncompressed, keep an idle timeout above the heartbeat, disable request retries,
and forward the `Authorization` and `Last-Event-ID` headers. Set
`STRIKEFALL_ALLOWED_ORIGIN` to the final HTTPS origin.

Validate the edge independently with:

```sh
docker build -f Dockerfile.web -t strikefall-web:local .
container_id=$(docker run --detach --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --publish 127.0.0.1:18080:8080 strikefall-web:local)
docker exec "$container_id" nginx -t
curl --fail --include http://127.0.0.1:18080/healthz
docker rm --force "$container_id"
```

## Schema and migrations

SQL migrations live in `migrations/` and are embedded in the service binary.
With `STRIKEFALL_RUN_MIGRATIONS=true`, SQLx applies pending migrations before
the readiness endpoint can succeed. For controlled production releases, run a
single migration job first, then deploy instances with that variable set to
false.

`strikefall_rounds.record` is the complete `RoundRecord` JSONB document. Its
proof inputs, event chain, reveal, result, and revision therefore commit in one
statement. Side columns exist only for optimistic concurrency, lifecycle scans,
and retention:

- `revision` gates every update with `WHERE revision = expected_revision`;
- `status` and `next_action_at_ms` drive an indexed recovery scan;
- `retention_until` supports small, index-backed cleanup batches;
- `deleted_at` is reserved for a future soft-delete/audit workflow.

Back up the database with a Postgres-consistent tool (`pg_dump` for this single
database or provider snapshots/PITR). Restore into an isolated database, run
the same service version, and verify several `/replay` responses with the
independently pinned publisher key before directing traffic to it.

## Lifecycle recovery

The repository exposes an explicit `list_due(now, limit)` scheduler boundary.
The single production service process polls it immediately at startup and then
on the configured interval:

1. an overdue `placement` row publishes every due bot decision and corresponding
   move in canonical order, using public state reconstructed at each signed
   observation cutoff; its persisted cursor then advances to the next action;
2. at the placement deadline, the row publishes any remaining due moves, locks
   exact scores, signs `placement_locked` with an absolute battle start exactly
   2,000 ms later, and moves to `battle` without emitting frame zero early;
3. an overdue `battle` row emits every due 250 ms frame, immediate hit cluster,
   bot Escape audit, and accepted Escape; the final frame emits `round_ended`
   followed by `seed_revealed`;
4. the complete document and its next action deadline are saved with one
   optimistic revision update.

The repository remains revision-safe if overlapping processes briefly discover
the same row during a controlled replacement: one revision update wins and the
other treats the conflict as superseded work. That database property does not
make a multi-replica live topology supported. Timed bot actions and their
observation/action intervals are
deterministically regenerated from the isolated bot root, so a delayed recovery
pass produces the same audit sequence and never publishes a future action. A
recovered placement begins its battle only after the signed two-second lock
beat; a long outage does not silently consume a battle while clients cannot
observe it. A battle that was already started retains every original frame
deadline; a delayed worker catches up all overdue frames in one atomic document
update without changing their signed logical timestamps.

The repository contract and recovery transitions run in the ordinary test
suite without Postgres:

```sh
cargo test -p strikefall-round-service --locked
```

Run the same contract against an isolated Postgres database explicitly:

```sh
export STRIKEFALL_TEST_DATABASE_URL=postgres://strikefall:password@localhost/strikefall_test
cargo test -p strikefall-round-service --locked \
  --test repository_contract postgres_repository_obeys_contract -- --ignored
```

## Health, shutdown, and deployment

- `GET /healthz` on the web edge returns `204` after nginx is accepting
  requests. It does not check the service or database.
- `GET /health` and `GET /health/live` return `204` if the process/event loop is
  alive. They intentionally do not query dependencies.
- `GET /health/ready` runs `SELECT 1` through the selected repository and returns
  `204` only while the service can reach it; failure returns `503`.
- `SIGTERM` and `SIGINT` stop new HTTP work, drain Axum connections, notify the
  recovery worker, and allow up to ten seconds for it to stop.

Use edge `/healthz` for edge liveness and `/api/health/ready` for end-to-end
readiness. The service container's own health check uses `/health/ready`. Give
it at least the configured 15-second termination grace period. Keep the signing
key identical during a controlled replacement, but do not run an ordinary
multi-replica rolling deployment: SSE live fan-out is process-local. Drain the
old singleton before admitting traffic to the replacement, or accept a brief
maintenance window. Sticky routing alone is insufficient because any recovery
worker may commit a lifecycle transition (see limitations below).

Before promoting an image, run `npm run test:performance:api` against the same
Compose edge, then `npm run test:performance:report`. The first command retains
all 3 warmups and 25 samples plus source, worktree, runner, and exact container
image metadata; the second recomputes the summary and current source manifest.
CI uploads the report for 30 days. It validates the commitment, approach,
identity, and 19-bot roster on every request and fails if the maximum exceeds
300 ms. Pair it with the browser and SBF budgets in
[PERFORMANCE.md](PERFORMANCE.md); local latency is not evidence for every mobile
radio path.

Recommended alerts:

- readiness failures or Postgres pool acquisition errors;
- repeated `durable lifecycle transition failed` logs;
- a growing count of overdue rows;
- any revision conflict outside a controlled singleton replacement;
- disk, WAL, connection, and replication-lag saturation;
- signing public key unexpectedly changing between instances.

An overdue-row check suitable for monitoring is:

```sql
SELECT status, count(*), max((extract(epoch FROM clock_timestamp()) * 1000)::bigint - next_action_at_ms) AS max_late_ms
FROM strikefall_rounds
WHERE deleted_at IS NULL AND next_action_at_ms <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint
GROUP BY status;
```

## Retention

The service records retention deadlines but does not delete rows in request or
scheduler paths. Run deletion as a separate, monitored maintenance job so API
latency and WAL growth remain predictable. A small concurrent-safe batch is:

```sql
WITH doomed AS (
  SELECT id
  FROM strikefall_rounds
  WHERE deleted_at IS NULL AND retention_until < NOW()
  ORDER BY retention_until, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1000
)
DELETE FROM strikefall_rounds AS rounds
USING doomed
WHERE rounds.id = doomed.id;
```

Retain database backups no longer than the product/privacy policy allows.
Deleting a row makes its replay unavailable from this service, so export any
audit fixtures before cleanup.

Consented telemetry, completed leaderboard rows, expired rate windows, and
anonymous sessions need their own small maintenance batches. Run these on a
schedule after aligning the cutoffs with the published privacy policy. The
following defaults retain the weekly leaderboard for eight days, discard rate
windows only after twice the longest current 24-hour window, and remove a
session only after all referencing telemetry/leaderboard rows are gone:

```sql
DELETE FROM strikefall_telemetry_events
WHERE event_id IN (
  SELECT event_id
  FROM strikefall_telemetry_events
  WHERE retention_until < NOW()
  ORDER BY retention_until, event_id
  LIMIT 1000
);

DELETE FROM strikefall_leaderboard_entries
WHERE round_id IN (
  SELECT round_id
  FROM strikefall_leaderboard_entries
  WHERE resolved_at_ms < (extract(epoch FROM NOW() - interval '8 days') * 1000)::bigint
  ORDER BY resolved_at_ms, round_id
  LIMIT 1000
);

DELETE FROM strikefall_rate_limits
WHERE (scope_hash, action, window_started_ms) IN (
  SELECT scope_hash, action, window_started_ms
  FROM strikefall_rate_limits
  WHERE window_started_ms < (extract(epoch FROM NOW() - interval '48 hours') * 1000)::bigint
  ORDER BY window_started_ms, scope_hash, action
  LIMIT 1000
);

DELETE FROM strikefall_sessions AS session
WHERE session.id IN (
  SELECT candidate.id
  FROM strikefall_sessions AS candidate
  WHERE candidate.expires_at_ms < (extract(epoch FROM NOW() - interval '24 hours') * 1000)::bigint
    AND NOT EXISTS (
      SELECT 1 FROM strikefall_telemetry_events AS event
      WHERE event.session_id = candidate.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM strikefall_leaderboard_entries AS entry
      WHERE entry.session_id = candidate.id
    )
  ORDER BY candidate.expires_at_ms, candidate.id
  LIMIT 1000
);
```

## Current closed-alpha limitations

The dependency-audit exception, immutable CI/image pin policy, and complete
secret boundary are documented in [SECURITY.md](SECURITY.md).

- Persisted round secret material is plain JSONB. Use encrypted Postgres storage,
  encrypted backups, strict database roles, and a private network. Application-
  level envelope encryption is not implemented yet.
- The scheduler has no durable lease. Optimistic revisions keep committed state
  safe during a controlled replacement, but they do not provide live-event
  delivery across replicas.
- SSE snapshots are durable because events live in the round document, but live
  broadcast is process-local. Production therefore fails closed unless
  `STRIKEFALL_STREAM_TOPOLOGY=single-replica`, and Compose declares exactly one
  service replica. An external orchestrator must enforce the same singleton.
  Do not scale out until a cross-instance push bus (with tested gap recovery)
  replaces this boundary; load-balancer affinity alone is not sufficient.
- Closed-alpha authentication is anonymous and points-only. Bearer, invite, and
  IP values are hashed at rest; this is not a substitute for encrypted storage,
  restricted database roles, rate-limit monitoring, or normal incident response.
- The ranked service emits `strikefall/ranked-replay/v3`; browser-local practice
  emits `strikefall/replay/v4`. They are intentionally separate schemas, and a
  client must select its decoder from `protocolVersion`.
- A self-contained replay proves consistency, not publisher identity. Preserve
  the creation commitment and independently pin the service public key.
