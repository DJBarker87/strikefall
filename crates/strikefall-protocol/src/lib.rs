//! Stable wire protocol and deterministic replay verification for Strikefall.
//!
//! Fixed-point values cross the wire as decimal strings. A replay bundle is
//! self-contained after reveal and can be audited without trusting the round
//! service that produced it.

#![forbid(unsafe_code)]

mod crypto;
mod engine;
mod error;
mod experiments;
mod types;
mod verify;

pub use crypto::{
    commitment_digest, deck_digest, derive_round_secrets, event_digest, hash_framed,
    locked_scores_digest, path_digest, result_proof_digest, verify_event_log, RoundSecrets,
};
pub use engine::{
    deck_to_dto, evaluate_bot_escapes, evaluate_bot_placement_decision,
    generate_bot_initial_roster, generate_bot_placement_schedule, generate_bot_roster,
    generate_bot_roster_with_decisions, generate_player_placement, lock_placements, path_to_dto,
    quote_escape, quote_escape_public, resolve_round, BotEscapeEvaluation, BotPlacementSchedule,
    BOT_ESCAPE_POLICY_VERSION, BOT_PLACEMENT_POLICY_VERSION, BOT_PLACEMENT_WINDOW_MS, PLAYER_NAME,
};
pub use error::ProtocolError;
pub use experiments::{
    escape_enabled, validate_experiment_assignments, DECK_STRUCTURE_EXPERIMENT, ESCAPE_EXPERIMENT,
    RISK_DISPLAY_EXPERIMENT,
};
pub use types::*;
pub use verify::{verify_replay_bundle, verify_replay_bundle_against};

/// Ranked fixed-point schema. It is deliberately distinct from the browser's
/// local-practice `strikefall/replay/v4` recipe.
pub const RANKED_PROTOCOL_VERSION: &str = "strikefall/ranked-replay/v3";

/// Backwards-compatible Rust symbol used throughout the service. The value is
/// the explicit ranked schema marker above, not the browser practice schema.
pub const PROTOCOL_VERSION: &str = RANKED_PROTOCOL_VERSION;

/// Matches the browser practice replay commitment algorithm marker.
pub const COMMITMENT_ALGORITHM: &str = "SHA-256";

/// Signed pause between the placement lock and battle frame zero.
///
/// The lock event commits the corresponding absolute battle start timestamp,
/// while this constant defines the canonical ranked timing rule verified by
/// every Rust/WASM replay inspector.
pub const RANKED_LOCK_PHASE_MS: u64 = 2_000;

/// The player has the stable contender identifier zero.
pub const PLAYER_CONTENDER_ID: u16 = 0;
