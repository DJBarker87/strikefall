-- Closed-alpha identity, authoritative leaderboard, abuse controls, and
-- consented telemetry. Raw bearer tokens, invite codes, and IP addresses are
-- never persisted; only domain-separated digests reach these tables.

CREATE TABLE IF NOT EXISTS strikefall_sessions (
    id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL CHECK (revision >= 0),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    handle TEXT NOT NULL CHECK (char_length(handle) BETWEEN 3 AND 20),
    handle_key TEXT NOT NULL UNIQUE CHECK (char_length(handle_key) BETWEEN 3 AND 20),
    telemetry_consent BOOLEAN NOT NULL DEFAULT FALSE,
    experiments JSONB NOT NULL CHECK (jsonb_typeof(experiments) = 'object'),
    invite_code_hash TEXT CHECK (invite_code_hash IS NULL OR length(invite_code_hash) = 64),
    creation_ip_hash TEXT NOT NULL CHECK (length(creation_ip_hash) = 64),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
    rotated_at_ms BIGINT,
    last_renamed_at_ms BIGINT,
    revoked_at_ms BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS strikefall_sessions_expiry_idx
    ON strikefall_sessions (expires_at_ms, id)
    WHERE revoked_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS strikefall_rate_limits (
    scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64),
    action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 48),
    window_started_ms BIGINT NOT NULL CHECK (window_started_ms >= 0),
    count INTEGER NOT NULL CHECK (count > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_hash, action, window_started_ms)
);

CREATE INDEX IF NOT EXISTS strikefall_rate_limits_retention_idx
    ON strikefall_rate_limits (window_started_ms, action);

CREATE TABLE IF NOT EXISTS strikefall_leaderboard_entries (
    round_id TEXT PRIMARY KEY REFERENCES strikefall_rounds(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES strikefall_sessions(id) ON DELETE CASCADE,
    deck_id TEXT NOT NULL,
    deck_version SMALLINT NOT NULL CHECK (deck_version > 0),
    score NUMERIC(39, 0) NOT NULL CHECK (score >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('survived', 'eliminated', 'escaped')),
    player_rank SMALLINT NOT NULL CHECK (player_rank BETWEEN 1 AND 20),
    resolved_at_ms BIGINT NOT NULL CHECK (resolved_at_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS strikefall_leaderboard_window_idx
    ON strikefall_leaderboard_entries
        (deck_id, deck_version, resolved_at_ms DESC, score DESC, round_id);

CREATE INDEX IF NOT EXISTS strikefall_leaderboard_self_idx
    ON strikefall_leaderboard_entries
        (session_id, deck_id, deck_version, resolved_at_ms DESC);

CREATE TABLE IF NOT EXISTS strikefall_telemetry_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES strikefall_sessions(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL CHECK (event_name IN (
        'round_started',
        'placement_locked',
        'escape_used',
        'round_completed',
        'replay_verified',
        'ui_performance',
        'client_error'
    )),
    occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
    received_at_ms BIGINT NOT NULL CHECK (received_at_ms >= 0),
    deck_id TEXT,
    round_id TEXT,
    properties JSONB NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
    retention_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS strikefall_telemetry_metrics_idx
    ON strikefall_telemetry_events (occurred_at_ms DESC, event_name, deck_id);

CREATE INDEX IF NOT EXISTS strikefall_telemetry_session_idx
    ON strikefall_telemetry_events (session_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS strikefall_telemetry_retention_idx
    ON strikefall_telemetry_events (retention_until, event_id);

COMMENT ON TABLE strikefall_sessions IS
    'Anonymous closed-alpha sessions; token_hash is a digest, never a bearer credential';
COMMENT ON TABLE strikefall_leaderboard_entries IS
    'Server-authored resolved-round scores; no client score submission path exists';
COMMENT ON TABLE strikefall_telemetry_events IS
    'Consented, schema-whitelisted telemetry without replay secrets or arbitrary text';
