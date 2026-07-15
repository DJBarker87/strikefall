use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use strikefall_protocol::{
    locked_scores_digest, verify_replay_bundle, CreateRoundRequest, ReplayVerifiedRequest,
    RoundEventKindDto, RANKED_LOCK_PHASE_MS,
};
use strikefall_round_service::{InMemoryRoundRepository, ManualClock, RoundService, ServiceConfig};

const START_MS: u64 = 1_700_000_000_000;

#[tokio::main]
async fn main() {
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new(
        InMemoryRoundRepository::shared(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        SigningKey::from_bytes(&[42_u8; 32]),
    );
    let created = service
        .create_round(CreateRoundRequest::default())
        .await
        .expect("create fixture round");
    clock.set(created.placement_deadline_ms);
    service
        .lock_round(&created.round_id)
        .await
        .expect("lock fixture round");
    clock.advance(
        RANKED_LOCK_PHASE_MS
            + u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms),
    );
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve fixture round");
    let proof_digest = service
        .replay(&created.round_id)
        .await
        .expect("unacknowledged replay")
        .result
        .proof_digest;
    service
        .acknowledge_replay(
            &created.round_id,
            ReplayVerifiedRequest {
                proof_digest,
                verifier_version: "cross-language-fixture/1".to_owned(),
            },
        )
        .await
        .expect("acknowledge fixture replay");
    let replay = service
        .replay(&created.round_id)
        .await
        .expect("fixture replay");
    verify_replay_bundle(&replay).expect("generated fixture verifies");

    let locked_digest = locked_scores_digest(&replay.locked_scores).expect("locked digest");
    let first = replay.events.first().expect("first event");
    let ended = replay
        .events
        .iter()
        .find(|event| matches!(&event.kind, RoundEventKindDto::RoundEnded { .. }))
        .expect("round-ended event");
    let last = replay.events.last().expect("last event");
    let anchors = serde_json::json!({
        "protocolVersion": replay.protocol_version,
        "roundId": replay.round_id,
        "commitment": replay.commitment,
        "serverVerifyingKey": replay.server_verifying_key,
        "experimentAssignments": replay.experiment_assignments,
        "deckDigest": replay.reveal.deck_digest,
        "deckVersion": replay.deck.version,
        "openingRunway": replay.deck.opening_runway,
        "pathDigest": replay.reveal.path_digest,
        "lockedScoresDigest": hex::encode(locked_digest),
        "resultProofDigest": replay.result.proof_digest,
        "eventCount": replay.events.len(),
        "firstEvent": first,
        "roundEndedEvent": ended,
        "lastEvent": last,
    });

    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/strikefall-protocol/tests/fixtures");
    fs::create_dir_all(&fixture_dir).expect("create fixture directory");
    fs::write(
        fixture_dir.join("ranked_replay_v3_deck_v3.json"),
        serde_json::to_vec_pretty(&replay).expect("serialize replay"),
    )
    .expect("write replay fixture");
    fs::write(
        fixture_dir.join("ranked_replay_v3_deck_v3_anchors.json"),
        serde_json::to_vec_pretty(&anchors).expect("serialize anchors"),
    )
    .expect("write anchor fixture");
}
