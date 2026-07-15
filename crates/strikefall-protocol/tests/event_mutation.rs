use ed25519_dalek::{Signer, SigningKey};
use strikefall_protocol::{
    event_digest, verify_event_log, BotEscapeDecisionDto, BotPlacementCandidateDto,
    BotPlacementDecisionDto, ContenderPlacementDto, EscapeRecordDto, EventActorDto, FlagClusterDto,
    PathPointDto, RevealDto, RoundEventKindDto, SideDto, SignedRoundEventDto, TouchDto,
    PROTOCOL_VERSION,
};

fn placement(contender_id: u16, is_bot: bool) -> ContenderPlacementDto {
    ContenderPlacementDto {
        contender_id,
        name: if is_bot { "BOT" } else { "YOU" }.to_owned(),
        is_bot,
        persona: is_bot.then(|| "turtle".to_owned()),
        side: SideDto::Upper,
        barrier: "110000000000000".to_owned(),
    }
}

fn point(step: u16) -> PathPointDto {
    PathPointDto {
        step,
        variance_elapsed: u128::from(step).to_string(),
        log_return: "0".to_owned(),
        price: "100000000000000".to_owned(),
        interval_high: "100000000000100".to_owned(),
        interval_low: "99999999999900".to_owned(),
    }
}

#[test]
#[allow(clippy::too_many_lines)]
fn every_ranked_event_class_is_digest_chained_and_mutation_detected() {
    let player = placement(0, false);
    let bot = placement(1, true);
    let escape = EscapeRecordDto {
        step: 120,
        banked_score: "420000000000".to_owned(),
        line_value: "101000000000000".to_owned(),
    };
    let reveal = RevealDto {
        path_seed: "7".to_owned(),
        bot_seed_root: "11".repeat(32),
        salt: "22".repeat(32),
        deck_digest: "33".repeat(32),
        path_digest: "44".repeat(32),
    };
    let placement_decision = BotPlacementDecisionDto {
        contender_id: 1,
        persona: "turtle".to_owned(),
        policy_version: "strikefall/ranked-bot-placement/v3".to_owned(),
        decision_number: 1,
        decision_time_ms: 2_000,
        observation_time_ms: 1_100,
        reaction_latency_ms: 900,
        public_inputs_digest: "55".repeat(32),
        entropy_digest: "66".repeat(32),
        candidates_digest: "67".repeat(32),
        candidate_count: 1,
        selected_candidate: 0,
        selected_utility: "70000000000000".to_owned(),
        reason_code: "turtle_safety_band".to_owned(),
        candidates: vec![BotPlacementCandidateDto {
            candidate_number: 0,
            side: SideDto::Upper,
            target_survival: "800000000000".to_owned(),
            barrier: bot.barrier.clone(),
            quoted_survival: "800000000000".to_owned(),
            projected_crowd_factor: "1000000000000".to_owned(),
            terminal_score: "120000000000000".to_owned(),
            utility: "70000000000000".to_owned(),
        }],
        placement: bot.clone(),
    };
    let escape_decision = BotEscapeDecisionDto {
        contender_id: 1,
        persona: "turtle".to_owned(),
        policy_version: "strikefall/ranked-bot-escape/v2".to_owned(),
        decision_bucket: 0,
        step: 120,
        public_inputs_digest: "77".repeat(32),
        survival_probability: "900000000000".to_owned(),
        threshold: "260000000000".to_owned(),
        chance_roll: "1".to_owned(),
        decision_chance: "750000000000".to_owned(),
        accepted: true,
        reason_code: "accepted".to_owned(),
    };
    let kinds = vec![
        RoundEventKindDto::RoundCreated {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            commitment: "88".repeat(32),
            experiment_assignments: BTreeMap::from([
                ("deck-structure:v2".to_owned(), "flat".to_owned()),
                ("escape:v2".to_owned(), "midpoint".to_owned()),
                ("risk-display:v2".to_owned(), "danger-band".to_owned()),
            ]),
            player_placement: player.clone(),
        },
        RoundEventKindDto::ApproachFrame { point: point(1) },
        RoundEventKindDto::PlacementOpened {
            placement_deadline_ms: 12_000,
            input_freeze_at_ms: 11_250,
            bot_policy_version: "strikefall/ranked-bot-placement/v3".to_owned(),
        },
        RoundEventKindDto::BotPlacementDecision {
            decision: placement_decision,
        },
        RoundEventKindDto::FlagMoved {
            actor: EventActorDto::Player,
            placement: player,
            client_sequence: Some(1),
        },
        RoundEventKindDto::PlacementLocked {
            locked_scores_digest: "99".repeat(32),
            locked_scores: Vec::new(),
            battle_starts_at_ms: 14_000,
        },
        RoundEventKindDto::BattleFrame { point: point(0) },
        RoundEventKindDto::FlagCluster {
            cluster: FlagClusterDto {
                step: 5,
                contender_ids: vec![1, 2],
            },
        },
        RoundEventKindDto::BotEscapeEvaluated {
            decision: escape_decision,
        },
        RoundEventKindDto::EscapeAccepted {
            contender_id: 1,
            actor: EventActorDto::Bot,
            escape: escape.clone(),
        },
        RoundEventKindDto::FlagHit {
            touch: TouchDto {
                contender_id: 2,
                step: 5,
                side: SideDto::Lower,
                barrier: "99000000000000".to_owned(),
                line_value: "98000000000000".to_owned(),
            },
        },
        RoundEventKindDto::RoundEnded {
            proof_digest: "aa".repeat(32),
        },
        RoundEventKindDto::SeedRevealed { reveal },
        RoundEventKindDto::ReplayVerified {
            proof_digest: "aa".repeat(32),
            verifier_version: "replay-inspector/0.1.0".to_owned(),
        },
    ];

    let signing_key = SigningKey::from_bytes(&[3_u8; 32]);
    let mut events = Vec::with_capacity(kinds.len());
    for (index, kind) in kinds.into_iter().enumerate() {
        let sequence = u64::try_from(index).expect("event sequence");
        let previous_digest = events.last().map_or_else(
            || hex::encode([0_u8; 32]),
            |event: &SignedRoundEventDto| event.digest.clone(),
        );
        let server_time_ms = 1_700_000_000_000 + sequence;
        let digest =
            event_digest(&previous_digest, sequence, server_time_ms, &kind).expect("event digest");
        events.push(SignedRoundEventDto {
            sequence,
            server_time_ms,
            previous_digest,
            kind,
            digest: hex::encode(digest),
            signature: hex::encode(signing_key.sign(&digest).to_bytes()),
        });
    }
    let verifying_key = hex::encode(signing_key.verifying_key().to_bytes());
    verify_event_log(&events, &verifying_key).expect("complete event fixture verifies");

    for index in 0..events.len() {
        let mut mutated = events.clone();
        mutated[index].server_time_ms += 1;
        assert!(
            verify_event_log(&mutated, &verifying_key).is_err(),
            "mutation of event class at index {index} was accepted"
        );
    }
}
use std::collections::BTreeMap;
