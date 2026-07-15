//! Deterministic gameplay rules for Strikefall.
//!
//! This crate owns product concepts such as decks, generated paths, flags,
//! crowding, hits, and points. Numerical primitives come from `solmath`.
//! It intentionally stays `no_std`-friendly and uses fixed-point values scaled
//! by [`SCALE`](solmath_core::SCALE); JavaScript never needs to calculate a
//! probability or score with a floating-point `Number`.

#![forbid(unsafe_code)]
#![no_std]

extern crate alloc;

#[cfg(test)]
extern crate std;

mod deck;
mod error;
mod hit;
mod no_touch;
mod path;
mod rng;
mod scoring;

pub use deck::{
    deck_by_id, deck_by_ref, DeckId, DeckVersion, OpeningRunwaySchedule, BALANCED_TAPE,
    COMPRESSION_BREAK, DECKS, OPENING_RUSH, PULSE, TOUCH_MONITORING_VERSION,
};
pub use error::CoreError;
pub use hit::{closest_approach, first_touch, resolve_touches, TouchEvent};
pub use no_touch::{
    barrier_for_survival, one_sided_no_touch, BarrierSide, NoTouchInputs, NoTouchQuote,
};
pub use path::{
    candleize, generate_battle_path, generate_round_path, Candle, GeneratedRoundPath, PathPoint,
};
pub use rng::DeterministicRng;
pub use scoring::{
    crowd_factor, escape_value, lock_scores, normalized_barrier_distance, risk_multiplier,
    terminal_score, FlagPlacement, LockedScore, ScoringRules,
};
pub use solmath::{SCALE, SCALE_I};
