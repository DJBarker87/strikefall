-- Telemetry v2 adds only bounded, consented UI-intent signals. Gameplay
-- metrics are authored by the round service from its canonical round record;
-- clients cannot submit survivor, pacing, placement-spread, or timing facts.

ALTER TABLE strikefall_telemetry_events
    DROP CONSTRAINT IF EXISTS strikefall_telemetry_events_event_name_check;

ALTER TABLE strikefall_telemetry_events
    ADD CONSTRAINT strikefall_telemetry_events_event_name_check CHECK (event_name IN (
        'round_started',
        'placement_locked',
        'escape_used',
        'round_completed',
        'replay_verified',
        'ui_performance',
        'client_error',
        'dead_player_response',
        'share_opened',
        'clip_exported'
    ));

COMMENT ON CONSTRAINT strikefall_telemetry_events_event_name_check
    ON strikefall_telemetry_events IS
    'Telemetry v2 exact event-name allowlist; properties remain service validated';
