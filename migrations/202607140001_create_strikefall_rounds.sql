-- Authoritative closed-alpha round persistence.
--
-- The JSONB document is the source of truth for replay/proof bytes. The typed
-- columns are deliberately limited to concurrency, lifecycle scheduling, and
-- retention so repository loads cannot reconstruct a subtly different round.
CREATE TABLE IF NOT EXISTS strikefall_rounds (
    id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL CHECK (revision >= 0),
    status TEXT NOT NULL CHECK (status IN ('placement', 'battle', 'resolved')),
    record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    next_action_at_ms BIGINT,
    resolved_at_ms BIGINT,
    retention_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT strikefall_rounds_lifecycle_shape CHECK (
        (status IN ('placement', 'battle') AND next_action_at_ms IS NOT NULL)
        OR (status = 'resolved' AND next_action_at_ms IS NULL AND resolved_at_ms IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS strikefall_rounds_due_idx
    ON strikefall_rounds (next_action_at_ms, id)
    WHERE deleted_at IS NULL
      AND next_action_at_ms IS NOT NULL
      AND status IN ('placement', 'battle');

CREATE INDEX IF NOT EXISTS strikefall_rounds_active_signing_key_idx
    ON strikefall_rounds ((record ->> 'server_verifying_key'), created_at_ms, id)
    WHERE deleted_at IS NULL AND status IN ('placement', 'battle');

CREATE INDEX IF NOT EXISTS strikefall_rounds_retention_idx
    ON strikefall_rounds (retention_until, id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS strikefall_rounds_resolved_idx
    ON strikefall_rounds (resolved_at_ms DESC, id)
    WHERE deleted_at IS NULL AND status = 'resolved';

COMMENT ON TABLE strikefall_rounds IS
    'Complete Strikefall ranked round documents plus optimistic concurrency and lifecycle metadata';
COMMENT ON COLUMN strikefall_rounds.record IS
    'Canonical RoundRecord JSON; includes sealed round secrets until retention cleanup';
COMMENT ON COLUMN strikefall_rounds.next_action_at_ms IS
    'Placement lock or battle resolution deadline consumed by the recovery scheduler';
