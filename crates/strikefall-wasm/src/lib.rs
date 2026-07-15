//! String-safe WebAssembly API for the deterministic Strikefall core.
//!
//! Every SCALE-valued integer crosses the JS boundary as a decimal string.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use strikefall_core::{
    barrier_for_survival, deck_by_ref, generate_battle_path, generate_round_path, lock_scores,
    one_sided_no_touch, BarrierSide, FlagPlacement, NoTouchInputs, PathPoint, ScoringRules, DECKS,
};
use wasm_bindgen::prelude::*;

fn js_error(error: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn parse_u128(value: &str, field: &str) -> Result<u128, JsValue> {
    value
        .parse::<u128>()
        .map_err(|_| JsValue::from_str(&format!("{field} must be an unsigned decimal integer")))
}

fn parse_i128(value: &str, field: &str) -> Result<i128, JsValue> {
    value
        .parse::<i128>()
        .map_err(|_| JsValue::from_str(&format!("{field} must be a signed decimal integer")))
}

fn parse_side(value: &str) -> Result<BarrierSide, JsValue> {
    match value {
        "upper" => Ok(BarrierSide::Upper),
        "lower" => Ok(BarrierSide::Lower),
        _ => Err(JsValue::from_str("side must be 'upper' or 'lower'")),
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(js_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PointDto {
    step: u16,
    variance_elapsed: String,
    log_return: String,
    price: String,
    interval_high: String,
    interval_low: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundPathDto {
    approach: Vec<PointDto>,
    battle: Vec<PointDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuoteDto {
    survival_probability: String,
    hit_probability: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlacementDto {
    contender_id: u16,
    side: String,
    barrier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockedScoreDto {
    contender_id: u16,
    side: &'static str,
    barrier: String,
    normalized_distance: String,
    initial_survival: String,
    risk_multiplier: String,
    crowd_factor: String,
    terminal_score: String,
}

fn point_dto(point: &PathPoint) -> PointDto {
    PointDto {
        step: point.step,
        variance_elapsed: point.variance_elapsed.to_string(),
        log_return: point.log_return.to_string(),
        price: point.price.to_string(),
        interval_high: point.interval_high.to_string(),
        interval_low: point.interval_low.to_string(),
    }
}

fn side_label(side: BarrierSide) -> &'static str {
    match side {
        BarrierSide::Upper => "upper",
        BarrierSide::Lower => "lower",
    }
}

/// Returns all launch decks. Fixed-point fields are decimal strings.
#[wasm_bindgen]
pub fn deck_catalog_json() -> Result<String, JsValue> {
    let decks: Vec<_> = DECKS.iter().map(strikefall_protocol::deck_to_dto).collect();
    encode(&decks)
}

/// Replays a complete approach and battle from a decimal u64 seed.
#[wasm_bindgen]
pub fn generate_round_path_json(
    deck_id: &str,
    deck_version: u16,
    seed: &str,
    initial_spot: &str,
) -> Result<String, JsValue> {
    let deck = deck_by_ref(deck_id, deck_version)
        .ok_or_else(|| JsValue::from_str("unknown deck identity"))?;
    let seed = seed
        .parse::<u64>()
        .map_err(|_| JsValue::from_str("seed must be a decimal u64"))?;
    let initial_spot = parse_u128(initial_spot, "initialSpot")?;
    let generated = generate_round_path(deck, seed, initial_spot).map_err(js_error)?;
    encode(&RoundPathDto {
        approach: generated.approach.iter().map(point_dto).collect(),
        battle: generated.battle.iter().map(point_dto).collect(),
    })
}

/// Replays the canonical battle stream from an exact starting spot. This is
/// the same generator used by ranked rounds and is exposed separately for
/// local calibration campaigns that must not synthesize paths in JavaScript.
#[wasm_bindgen]
pub fn generate_battle_path_json(
    deck_id: &str,
    deck_version: u16,
    seed: &str,
    initial_spot: &str,
) -> Result<String, JsValue> {
    let deck = deck_by_ref(deck_id, deck_version)
        .ok_or_else(|| JsValue::from_str("unknown deck identity"))?;
    let seed = seed
        .parse::<u64>()
        .map_err(|_| JsValue::from_str("seed must be a decimal u64"))?;
    let initial_spot = parse_u128(initial_spot, "initialSpot")?;
    let generated = generate_battle_path(deck, seed, initial_spot).map_err(js_error)?;
    encode(&generated.iter().map(point_dto).collect::<Vec<_>>())
}

/// Returns exact remaining integrated variance after a canonical microstep.
#[wasm_bindgen]
pub fn remaining_variance_fixed(
    deck_id: &str,
    deck_version: u16,
    completed_steps: u16,
) -> Result<String, JsValue> {
    let deck = deck_by_ref(deck_id, deck_version)
        .ok_or_else(|| JsValue::from_str("unknown deck identity"))?;
    deck.remaining_variance(completed_steps)
        .map(|variance| variance.to_string())
        .map_err(js_error)
}

/// Continuous no-touch quote. All SCALE-valued inputs and outputs are strings.
#[wasm_bindgen]
pub fn quote_no_touch_json(
    spot: &str,
    barrier: &str,
    remaining_variance: &str,
    drift_per_variance: &str,
    side: &str,
    already_breached: bool,
) -> Result<String, JsValue> {
    let quote = one_sided_no_touch(NoTouchInputs {
        spot: parse_u128(spot, "spot")?,
        barrier: parse_u128(barrier, "barrier")?,
        remaining_variance: parse_u128(remaining_variance, "remainingVariance")?,
        drift_per_variance: parse_i128(drift_per_variance, "driftPerVariance")?,
        side: parse_side(side)?,
        already_breached,
    })
    .map_err(js_error)?;
    encode(&QuoteDto {
        survival_probability: quote.survival_probability.to_string(),
        hit_probability: quote.hit_probability.to_string(),
    })
}

/// Finds a barrier for a target survival probability.
#[wasm_bindgen]
pub fn barrier_for_survival_fixed(
    spot: &str,
    target_survival: &str,
    remaining_variance: &str,
    drift_per_variance: &str,
    side: &str,
) -> Result<String, JsValue> {
    barrier_for_survival(
        parse_u128(spot, "spot")?,
        parse_u128(target_survival, "targetSurvival")?,
        parse_u128(remaining_variance, "remainingVariance")?,
        parse_i128(drift_per_variance, "driftPerVariance")?,
        parse_side(side)?,
    )
    .map(|barrier| barrier.to_string())
    .map_err(js_error)
}

/// Locks a full lobby atomically, including same-side crowding.
#[wasm_bindgen]
pub fn lock_lobby_scores_json(
    spot: &str,
    remaining_variance: &str,
    drift_per_variance: &str,
    placements_json: &str,
) -> Result<String, JsValue> {
    let request: Vec<PlacementDto> = serde_json::from_str(placements_json).map_err(js_error)?;
    let placements: Result<Vec<_>, JsValue> = request
        .into_iter()
        .map(|placement| {
            Ok(FlagPlacement {
                contender_id: placement.contender_id,
                side: parse_side(&placement.side)?,
                barrier: parse_u128(&placement.barrier, "barrier")?,
            })
        })
        .collect();
    let scores = lock_scores(
        parse_u128(spot, "spot")?,
        parse_u128(remaining_variance, "remainingVariance")?,
        parse_i128(drift_per_variance, "driftPerVariance")?,
        &placements?,
        ScoringRules::default(),
    )
    .map_err(js_error)?;
    let response: Vec<_> = scores
        .into_iter()
        .map(|score| LockedScoreDto {
            contender_id: score.contender_id,
            side: side_label(score.side),
            barrier: score.barrier.to_string(),
            normalized_distance: score.normalized_distance.to_string(),
            initial_survival: score.initial_survival.to_string(),
            risk_multiplier: score.risk_multiplier.to_string(),
            crowd_factor: score.crowd_factor.to_string(),
            terminal_score: score.terminal_score.to_string(),
        })
        .collect();
    encode(&response)
}

/// Verifies the complete authoritative ranked-v3 replay against the immutable
/// commitment and server-key values captured by the browser at round creation.
///
/// This deliberately delegates to the same Rust verifier used by the service
/// and replay-inspector CLI: path, bots, scores, Escape decisions, event
/// semantics, digest chain, and signatures must all regenerate exactly.
#[wasm_bindgen]
pub fn verify_ranked_replay_json(
    replay_json: &str,
    expected_commitment: &str,
    expected_server_key: &str,
) -> Result<String, JsValue> {
    let replay: strikefall_protocol::ReplayBundleDto =
        serde_json::from_str(replay_json).map_err(js_error)?;
    let report = strikefall_protocol::verify_replay_bundle_against(
        &replay,
        Some(expected_commitment),
        Some(expected_server_key),
    )
    .map_err(js_error)?;
    encode(&report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_boundary_keeps_fixed_values_as_strings() {
        let json = deck_catalog_json().unwrap();
        assert!(json.contains("\"totalIntegratedVariance\":\"6400000000\""));
        assert!(json.contains(
            "\"calibrationDigest\":\"863f86c97cfabb4a847a3e14775c4fa8dd83079c50f7ac1dd329e68edab575f0\""
        ));

        let quote = quote_no_touch_json(
            "100000000000000",
            "110000000000000",
            "6400000000",
            "-500000000000",
            "upper",
            false,
        )
        .unwrap();
        assert!(quote.contains("\"survivalProbability\":\""));

        let path = generate_battle_path_json("balanced_tape", 3, "7", "100000000000000").unwrap();
        assert!(path.starts_with("[{\"step\":0,"));
        assert_eq!(
            remaining_variance_fixed("balanced_tape", 3, 120).unwrap(),
            "3200000000"
        );
    }

    #[test]
    fn frozen_ranked_fixture_crosses_the_same_verifier_boundary() {
        let replay = include_str!("../../strikefall-protocol/tests/fixtures/ranked_replay_v3.json");
        let anchors: serde_json::Value = serde_json::from_str(include_str!(
            "../../strikefall-protocol/tests/fixtures/ranked_replay_v3_anchors.json"
        ))
        .expect("frozen anchors");
        let commitment = anchors["commitment"].as_str().expect("commitment");
        let server_key = anchors["serverVerifyingKey"].as_str().expect("server key");
        let report = verify_ranked_replay_json(replay, commitment, server_key)
            .expect("frozen replay verifies through the WASM boundary");
        assert!(report.contains("\"valid\":true"));
        let expected_events = anchors["eventCount"].as_u64().expect("event count");
        assert!(report.contains(&format!("\"signedEvents\":{expected_events}")));
    }
}
