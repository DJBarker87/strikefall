use ed25519_dalek::{Signer, SigningKey};
use strikefall_protocol::{
    event_digest, locked_scores_digest, verify_replay_bundle, ReplayBundleDto, RoundEventKindDto,
    SignedRoundEventDto, RANKED_LOCK_PHASE_MS,
};

const REPLAY_JSON: &str = include_str!("fixtures/ranked_replay_v3.json");
const ACTIVE_REPLAY_JSON: &str = include_str!("fixtures/ranked_replay_v3_deck_v3.json");
const ACTIVE_ANCHORS_JSON: &str = include_str!("fixtures/ranked_replay_v3_deck_v3_anchors.json");

#[test]
fn active_deck_v3_fixture_binds_the_opening_runway() {
    let replay: ReplayBundleDto = serde_json::from_str(ACTIVE_REPLAY_JSON).expect("fixture JSON");
    let anchors: serde_json::Value =
        serde_json::from_str(ACTIVE_ANCHORS_JSON).expect("anchor JSON");
    verify_replay_bundle(&replay).expect("active fixture verifies");
    assert_eq!(replay.protocol_version, "strikefall/ranked-replay/v3");
    assert_eq!(replay.deck.version, 3);
    let runway = replay.deck.opening_runway.expect("v3 runway");
    assert_eq!(u64::from(runway.steps), anchors["openingRunway"]["steps"]);
    assert_eq!(
        u64::from(runway.variance_share_bps),
        anchors["openingRunway"]["varianceShareBps"]
    );
    assert_eq!(replay.commitment, anchors["commitment"]);
    assert_eq!(replay.reveal.deck_digest, anchors["deckDigest"]);
    assert_eq!(replay.reveal.path_digest, anchors["pathDigest"]);
    assert_eq!(replay.result.proof_digest, anchors["resultProofDigest"]);
    assert_eq!(
        u64::try_from(replay.events.len()).expect("event count"),
        anchors["eventCount"]
    );
}

#[test]
fn complete_ranked_v3_cross_language_fixture_is_stable() {
    let replay: ReplayBundleDto = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    verify_replay_bundle(&replay).expect("fixture verifies");

    assert_eq!(replay.protocol_version, "strikefall/ranked-replay/v3");
    assert_eq!(
        replay.commitment,
        "ed3be1e423e032b84356e173569ac879450cae76611215202188125f9ea6f6f0"
    );
    assert_eq!(
        replay.server_verifying_key,
        "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61"
    );
    assert_eq!(
        replay.reveal.deck_digest,
        "1c955f0f071de9b676d2551ff4ff9398c3f30b576c364090e3632b1217c31b51"
    );
    assert_eq!(
        replay.reveal.path_digest,
        "4faf4b39c7e9e0de3d9b4c4d9400ba59676d889517f6c9e7dd426e03486c70a1"
    );
    assert_eq!(
        hex::encode(locked_scores_digest(&replay.locked_scores).expect("locked digest")),
        "0f36629deb97d3dac4134429f29467689aa74cc66a1d3fcd57ddad59cbcb6c16"
    );
    assert_eq!(
        replay.result.proof_digest,
        "ba174bb9dfe2a9977e9706491e27d21b158b7277ff25e0078e215a4bba514f49"
    );
    assert_eq!(replay.events.len(), 424);
    assert_eq!(
        replay
            .experiment_assignments
            .get("deck-structure:v2")
            .map(String::as_str),
        Some("flat")
    );
    let locked = replay
        .events
        .iter()
        .find_map(|event| match &event.kind {
            RoundEventKindDto::PlacementLocked {
                locked_scores_digest,
                locked_scores,
                battle_starts_at_ms,
            } => Some((
                event.server_time_ms,
                locked_scores_digest,
                locked_scores,
                *battle_starts_at_ms,
            )),
            _ => None,
        })
        .expect("placement-locked event");
    assert_eq!(
        locked.1,
        &"0f36629deb97d3dac4134429f29467689aa74cc66a1d3fcd57ddad59cbcb6c16"
    );
    assert_eq!(locked.2, &replay.locked_scores);
    assert_eq!(locked.3, locked.0 + RANKED_LOCK_PHASE_MS);
    let first_battle = replay
        .events
        .iter()
        .find(|event| matches!(&event.kind, RoundEventKindDto::BattleFrame { .. }))
        .expect("battle frame zero");
    assert_eq!(first_battle.server_time_ms, locked.3);
    assert!(matches!(
        &first_battle.kind,
        RoundEventKindDto::BattleFrame { point } if point.step == 0
    ));

    let first = replay.events.first().expect("first event");
    assert_eq!(
        first.digest,
        "3a357f789e3fb620285fb9c89bafabf2b0807068e33a1ddff5070d2023f073c0"
    );
    assert_eq!(
        first.signature,
        "9546b8f6f32448da01e4866e749a6d89ab3c8962ac5437bec97409d39269ac9cc67cca194a2650df3c0eb95be74a243b4d4390d08fa34343442a459405c6640e"
    );
    let ended = replay
        .events
        .iter()
        .find(|event| matches!(&event.kind, RoundEventKindDto::RoundEnded { .. }))
        .expect("round-ended event");
    assert_eq!(
        ended.digest,
        "498a447bd5e3993a058b430201decf5c4c176a64c2a8977c4ab437f28fee5277"
    );
}

fn resign_events(events: &mut [SignedRoundEventDto], signing_key: &SigningKey) {
    let mut previous_digest = "0".repeat(64);
    for (index, event) in events.iter_mut().enumerate() {
        event.sequence = u64::try_from(index).expect("event sequence");
        event.previous_digest.clone_from(&previous_digest);
        let digest = event_digest(
            &event.previous_digest,
            event.sequence,
            event.server_time_ms,
            &event.kind,
        )
        .expect("event digest");
        event.digest = hex::encode(digest);
        event.signature = hex::encode(signing_key.sign(&digest).to_bytes());
        previous_digest.clone_from(&event.digest);
    }
}

#[test]
fn signed_noncanonical_lock_phase_is_rejected_by_semantic_verification() {
    let mut replay: ReplayBundleDto = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    let lock = replay
        .events
        .iter_mut()
        .find(|event| matches!(&event.kind, RoundEventKindDto::PlacementLocked { .. }))
        .expect("placement lock");
    let RoundEventKindDto::PlacementLocked {
        battle_starts_at_ms,
        ..
    } = &mut lock.kind
    else {
        unreachable!("selected placement lock")
    };
    *battle_starts_at_ms += 1;

    let signing_key = SigningKey::from_bytes(&[42_u8; 32]);
    resign_events(&mut replay.events, &signing_key);
    assert_eq!(
        replay.server_verifying_key,
        hex::encode(signing_key.verifying_key().to_bytes())
    );
    let error = verify_replay_bundle(&replay).expect_err("2,001ms lock must fail");
    assert!(error.to_string().contains("placement-lock event"));
}

#[test]
fn ranked_event_json_uses_snake_case_types_and_camel_case_data() {
    let replay: serde_json::Value = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    let kind = &replay["events"][0]["kind"];
    assert_eq!(kind["type"], "round_created");
    assert!(kind["data"].get("protocolVersion").is_some());
    assert!(kind["data"].get("playerPlacement").is_some());
    assert!(kind["data"].get("protocol_version").is_none());
    assert!(kind["data"].get("player_placement").is_none());
}

#[test]
fn retained_interval_extrema_are_committed_and_mutation_detected() {
    let mut replay: ReplayBundleDto = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    let point = replay.path.battle.get_mut(1).expect("battle point");
    point.interval_high = point.price.clone();
    let error = verify_replay_bundle(&replay).expect_err("mutated wick must fail");
    assert!(error.to_string().contains("generated path"));
}

#[test]
fn experiment_assignment_mutation_is_rejected_by_the_signed_replay() {
    let mut replay: ReplayBundleDto = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    replay
        .experiment_assignments
        .insert("risk-display:v2".to_owned(), "probability".to_owned());
    let error = verify_replay_bundle(&replay).expect_err("unsigned cohort mutation must fail");
    assert!(error.to_string().contains("round-created event"));

    let mut disabled: ReplayBundleDto = serde_json::from_str(REPLAY_JSON).expect("fixture JSON");
    disabled
        .experiment_assignments
        .insert("escape:v2".to_owned(), "absent".to_owned());
    let error = verify_replay_bundle(&disabled).expect_err("absent Escape cannot carry decisions");
    assert!(error.to_string().contains("disabled Escape treatment"));
}
