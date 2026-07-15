-- Lifecycle telemetry is idempotent by authoritative round and event class,
-- even when a retry mistakenly generates a fresh client event UUID.

CREATE UNIQUE INDEX IF NOT EXISTS strikefall_telemetry_round_event_unique_idx
    ON strikefall_telemetry_events (session_id, round_id, event_name)
    WHERE round_id IS NOT NULL;
