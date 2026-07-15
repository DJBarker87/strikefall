use serde_json::{json, Value};
use strikefall_core::{deck_by_ref, DECKS};
use strikefall_protocol::deck_to_dto;

const SAMPLE_CATALOG: &str = include_str!("../../../docs/decks/sample-catalog.v3.json");
const LEGACY_CATALOG: &str = include_str!("../../../docs/decks/sample-catalog.v2.json");

#[test]
fn runtime_decks_match_the_checked_in_synthetic_catalog() {
    let catalog: Value = serde_json::from_str(SAMPLE_CATALOG).expect("sample catalog JSON");
    assert_eq!(catalog["catalog_version"], 3);
    assert_eq!(catalog["validation"]["ranked_promotion_ready"], false);
    assert_eq!(catalog["source_provenance"][0]["source_kind"], "synthetic");

    let entries = catalog["decks"].as_array().expect("catalog decks");
    assert_eq!(entries.len(), DECKS.len());

    for deck in DECKS {
        let dto = deck_to_dto(&deck);
        let entry = entries
            .iter()
            .find(|entry| entry["id"] == dto.id && entry["version"] == u64::from(dto.version))
            .expect("runtime deck exists in sample catalog");

        assert_eq!(entry["display_name"], dto.display_name);
        assert_eq!(entry["approach_steps"], u64::from(dto.approach_steps));
        assert_eq!(entry["battle_steps"], u64::from(dto.battle_steps));
        assert_eq!(entry["step_ms"], u64::from(dto.step_ms));
        assert_eq!(entry["monitoring_convention"], dto.monitoring_convention);
        let runway = dto.opening_runway.expect("active catalog runway");
        assert_eq!(entry["opening_runway"]["steps"], u64::from(runway.steps));
        assert_eq!(
            entry["opening_runway"]["variance_share_bps"],
            u64::from(runway.variance_share_bps)
        );
        assert_eq!(
            entry["total_integrated_variance"],
            dto.total_integrated_variance
        );
        assert_eq!(entry["drift_per_variance"], dto.drift_per_variance);
        assert_eq!(
            entry["allowed_initial_survival"]["min"],
            dto.min_initial_survival
        );
        assert_eq!(
            entry["allowed_initial_survival"]["max"],
            dto.max_initial_survival
        );
        assert_eq!(entry["risk_multiplier_cap"], dto.risk_multiplier_cap);
        assert_eq!(entry["visual"]["art_theme"], dto.art_theme);
        assert_eq!(entry["audio"]["profile"], dto.audio_profile);
        assert_eq!(entry["calibration_digest"], dto.calibration_digest);

        let weights_ppm: Vec<u64> = dto
            .variance_weights
            .iter()
            .map(|weight| u64::from(*weight) * 10_000)
            .collect();
        assert_eq!(entry["variance_weights_ppm"], json!(weights_ppm));

        let boundary_variance: Vec<String> = entry["test_fixtures"]["boundary_steps"]
            .as_array()
            .expect("boundary steps")
            .iter()
            .map(|step| {
                let step =
                    u16::try_from(step.as_u64().expect("integer boundary")).expect("u16 boundary");
                deck.variance_at_boundary(step)
                    .expect("catalog boundary is valid")
                    .to_string()
            })
            .collect();
        assert_eq!(
            entry["test_fixtures"]["cumulative_variance"],
            json!(boundary_variance)
        );
    }
}

#[test]
fn frozen_v2_catalog_remains_resolvable_for_historical_replays() {
    let catalog: Value = serde_json::from_str(LEGACY_CATALOG).expect("legacy catalog JSON");
    for entry in catalog["decks"].as_array().expect("legacy catalog decks") {
        let id = entry["id"].as_str().expect("legacy deck id");
        let version = u16::try_from(entry["version"].as_u64().expect("legacy version"))
            .expect("legacy u16 version");
        let dto = deck_to_dto(deck_by_ref(id, version).expect("legacy deck definition"));
        assert_eq!(dto.version, 2);
        assert!(dto.opening_runway.is_none());
        assert_eq!(entry["calibration_digest"], dto.calibration_digest);
    }
}
