use std::collections::BTreeMap;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use ed25519_dalek::SigningKey;
use serde::de::DeserializeOwned;
use serde::Serialize;
use strikefall_core::{barrier_for_survival, deck_by_id, BarrierSide, SCALE};
use strikefall_protocol::{
    evaluate_bot_placement_decision, generate_bot_placement_schedule, ApiErrorDto,
    CreateRoundRequest, CreateRoundResponse, EscapeRequest, FlagUpdateRequest, FlagUpdateResponse,
    ReplayBundleDto, ReplayVerifiedRequest, ReplayVerifiedResponse, RoundResultResponse,
    RoundStatusDto, SideDto, RANKED_LOCK_PHASE_MS,
};
use strikefall_round_service::{
    router, ClosedAlphaConfig, CreateSessionRequest, InMemoryRoundRepository, IssuedSessionDto,
    ManualClock, RoundRepository, RoundService, ServiceConfig, DECK_STRUCTURE_EXPERIMENT,
    ESCAPE_EXPERIMENT, RISK_DISPLAY_EXPERIMENT,
};
use tower::ServiceExt;

const START_MS: u64 = 1_700_000_000_000;

async fn request_json<I: Serialize, O: DeserializeOwned>(
    app: &Router,
    method: Method,
    uri: &str,
    input: &I,
) -> (StatusCode, O) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(input).expect("request JSON")))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1_024 * 1_024)
        .await
        .expect("response body");
    let output = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        panic!(
            "response was not expected JSON ({error}): {}",
            String::from_utf8_lossy(&bytes)
        )
    });
    (status, output)
}

async fn get_json<O: DeserializeOwned>(app: &Router, uri: &str) -> (StatusCode, O) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1_024 * 1_024)
        .await
        .expect("response body");
    (
        status,
        serde_json::from_slice(&bytes).expect("response JSON"),
    )
}

async fn request_json_with_bearer<I: Serialize, O: DeserializeOwned>(
    app: &Router,
    method: Method,
    uri: &str,
    token: &str,
    input: &I,
) -> (StatusCode, O) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(serde_json::to_vec(input).expect("request JSON")))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1_024 * 1_024)
        .await
        .expect("response body");
    let output = serde_json::from_slice(&bytes).expect("authenticated response JSON");
    (status, output)
}

async fn get_json_with_bearer<O: DeserializeOwned>(
    app: &Router,
    uri: &str,
    token: &str,
) -> (StatusCode, O) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1_024 * 1_024)
        .await
        .expect("response body");
    (
        status,
        serde_json::from_slice(&bytes).expect("response JSON"),
    )
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn ranked_round_commits_locks_resolves_reveals_and_rejects_mutation() {
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        ..ServiceConfig::default()
    };
    let alpha_config = ClosedAlphaConfig {
        experiments: BTreeMap::from([
            (
                DECK_STRUCTURE_EXPERIMENT.to_owned(),
                vec!["compression-break".to_owned()],
            ),
            (ESCAPE_EXPERIMENT.to_owned(), vec!["midpoint".to_owned()]),
            (
                RISK_DISPLAY_EXPERIMENT.to_owned(),
                vec!["danger-band".to_owned()],
            ),
        ]),
        ..ClosedAlphaConfig::default()
    };
    let service = RoundService::new_with_alpha_config(
        InMemoryRoundRepository::shared(),
        clock.clone(),
        config.clone(),
        alpha_config,
        SigningKey::from_bytes(&[7_u8; 32]),
    );
    let app = router(service.clone());

    let (status, issued): (_, IssuedSessionDto) = request_json(
        &app,
        Method::POST,
        "/v1/sessions",
        &CreateSessionRequest {
            invite_code: None,
            handle: Some("ReplayTester".to_owned()),
            telemetry_consent: false,
        },
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = issued.token;

    for path in ["/health", "/health/live", "/health/ready"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("health request"),
            )
            .await
            .expect("health response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{path}");
    }

    let (status, created): (_, CreateRoundResponse) = request_json_with_bearer(
        &app,
        Method::POST,
        "/v1/solo-rounds",
        &token,
        &CreateRoundRequest {
            deck_id: Some("compression_break".to_owned()),
            deck_version: Some(3),
        },
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created.protocol_version, "strikefall/ranked-replay/v3");
    assert_eq!(created.bots.len(), 19);
    assert_eq!(created.player_placement.contender_id, 0);
    assert!(!created.player_placement.is_bot);
    assert_eq!(created.commitment.len(), 64);
    assert_eq!(created.status, RoundStatusDto::Placement);
    assert!(!created
        .experiment_assignments
        .contains_key(DECK_STRUCTURE_EXPERIMENT));
    assert!(created
        .experiment_assignments
        .contains_key(ESCAPE_EXPERIMENT));
    assert!(created
        .experiment_assignments
        .contains_key(RISK_DISPLAY_EXPERIMENT));

    let (status, deck): (_, strikefall_protocol::DeckDto) = get_json(
        &app,
        &format!("/v1/decks/{}/{}", created.deck.id, created.deck.version),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deck, created.deck);
    let (status, legacy_deck): (_, strikefall_protocol::DeckDto) =
        get_json(&app, "/v1/decks/compression_break/2").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(legacy_deck.version, 2);
    assert!(legacy_deck.opening_runway.is_none());
    let cors_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v1/decks/{}/{}",
                    created.deck.id, created.deck.version
                ))
                .header(header::ORIGIN, "http://localhost:4173")
                .body(Body::empty())
                .expect("CORS request"),
        )
        .await
        .expect("CORS response");
    assert_eq!(
        cors_response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .expect("allowed origin"),
        "http://localhost:4173"
    );

    let result_uri = format!("/v1/solo-rounds/{}/result", created.round_id);
    let (status, pending): (_, RoundResultResponse) =
        get_json_with_bearer(&app, &result_uri, &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pending.status, RoundStatusDto::Placement);
    assert!(
        pending.reveal.is_none(),
        "secret material leaked before resolution"
    );

    let battle_spot = created
        .approach
        .last()
        .expect("approach endpoint")
        .price
        .parse::<u128>()
        .expect("fixed spot");
    let barrier = barrier_for_survival(
        battle_spot,
        850_000_000_000,
        created
            .deck
            .total_integrated_variance
            .parse()
            .expect("variance"),
        created.deck.drift_per_variance.parse().expect("drift"),
        BarrierSide::Lower,
    )
    .expect("valid ranked barrier");
    let flag_uri = format!("/v1/solo-rounds/{}/flag", created.round_id);
    let invalid_flag = FlagUpdateRequest {
        side: SideDto::Upper,
        barrier: battle_spot.saturating_sub(1).to_string(),
        client_sequence: Some(1),
    };
    let (status, invalid): (_, ApiErrorDto) =
        request_json_with_bearer(&app, Method::POST, &flag_uri, &token, &invalid_flag).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.code, "invalid_request");

    let flag = FlagUpdateRequest {
        side: SideDto::Lower,
        barrier: barrier.to_string(),
        client_sequence: Some(1),
    };
    let (status, accepted): (_, FlagUpdateResponse) =
        request_json_with_bearer(&app, Method::POST, &flag_uri, &token, &flag).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(accepted.placement.side, SideDto::Lower);

    let (status, limited): (_, ApiErrorDto) =
        request_json_with_bearer(&app, Method::POST, &flag_uri, &token, &flag).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.code, "flag_rate_limited");
    assert_eq!(
        limited.retry_after_ms,
        Some(config.minimum_flag_update_interval_ms)
    );

    clock.set(created.input_freeze_at_ms);
    let (status, frozen): (_, ApiErrorDto) =
        request_json_with_bearer(&app, Method::POST, &flag_uri, &token, &flag).await;
    assert_eq!(status, StatusCode::LOCKED);
    assert_eq!(frozen.code, "input_frozen");

    clock.set(created.placement_deadline_ms);
    service
        .lock_round(&created.round_id)
        .await
        .expect("lock round");
    let (status, battle): (_, RoundResultResponse) =
        get_json_with_bearer(&app, &result_uri, &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(battle.status, RoundStatusDto::Battle);
    assert!(battle.reveal.is_none());

    let escape_uri = format!("/v1/solo-rounds/{}/escape", created.round_id);
    let (status, early_escape): (_, ApiErrorDto) = request_json_with_bearer(
        &app,
        Method::POST,
        &escape_uri,
        &token,
        &EscapeRequest {
            client_sequence: Some(2),
        },
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(early_escape.code, "invalid_round_state");

    let stream_uri = format!("/v1/solo-rounds/{}/stream", created.round_id);
    let stream_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(stream_uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .expect("stream request"),
        )
        .await
        .expect("stream response");
    assert_eq!(stream_response.status(), StatusCode::OK);
    assert_eq!(
        stream_response
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("SSE content type"),
        "text/event-stream"
    );
    drop(stream_response);

    let battle_duration = u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
    clock.advance(RANKED_LOCK_PHASE_MS + battle_duration);
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve round");

    let (status, resolved): (_, RoundResultResponse) =
        get_json_with_bearer(&app, &result_uri, &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved.status, RoundStatusDto::Resolved);
    assert!(resolved.result.is_some());
    let reveal = resolved.reveal.expect("post-round reveal");
    assert_eq!(reveal.path_digest.len(), 64);
    assert_eq!(reveal.bot_seed_root.len(), 64);
    assert_eq!(reveal.salt.len(), 64);

    let replay_uri = format!("/v1/solo-rounds/{}/replay", created.round_id);
    let (status, replay): (_, ReplayBundleDto) =
        get_json_with_bearer(&app, &replay_uri, &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay.commitment, created.commitment);
    assert_eq!(replay.placements.len(), 20);
    assert_eq!(replay.locked_scores.len(), 20);
    let locked_event = replay
        .events
        .iter()
        .find_map(|event| match &event.kind {
            strikefall_protocol::RoundEventKindDto::PlacementLocked {
                locked_scores_digest,
                locked_scores,
                ..
            } => Some((locked_scores_digest, locked_scores)),
            _ => None,
        })
        .expect("placement lock event");
    assert_eq!(locked_event.1, &replay.locked_scores);
    assert_eq!(locked_event.0.len(), 64);
    assert!(replay
        .events
        .iter()
        .enumerate()
        .all(|(index, event)| event.sequence == u64::try_from(index).expect("sequence")));

    let verification = replay_inspector::verify_replay_bundle(&replay).expect("valid replay");
    assert!(verification.valid);
    assert_eq!(verification.round_id, created.round_id);
    assert_eq!(
        replay.experiment_assignments,
        created.experiment_assignments
    );

    let replay_json = serde_json::to_vec(&replay).expect("replay JSON");
    let reader_report = replay_inspector::inspect_reader(replay_json.as_slice())
        .expect("CLI library verifies JSON");
    assert_eq!(reader_report, verification);
    replay_inspector::verify_replay_bundle_against(
        &replay,
        Some(&created.commitment),
        Some(&created.server_verifying_key),
    )
    .expect("trusted pre-round anchors verify");
    assert!(replay_inspector::verify_replay_bundle_against(
        &replay,
        Some(&"0".repeat(64)),
        Some(&created.server_verifying_key),
    )
    .is_err());

    assert!((19..=57).contains(&replay.bot_placement_decisions.len()));
    for contender_id in 1..=19 {
        let moves: Vec<_> = replay
            .bot_placement_decisions
            .iter()
            .filter(|decision| decision.contender_id == contender_id)
            .collect();
        assert!(
            (1..=3).contains(&moves.len()),
            "bot {contender_id} move cap"
        );
        assert!(moves.iter().enumerate().all(|(index, decision)| {
            decision.decision_number == u16::try_from(index + 1).expect("move number")
                && (250..=1_500).contains(&decision.reaction_latency_ms)
                && decision.decision_time_ms <= 11_250
                && decision.candidate_count == 12
                && decision.candidates.len() == 12
                && decision
                    .candidates
                    .get(usize::from(decision.selected_candidate))
                    .is_some_and(|candidate| {
                        candidate.utility == decision.selected_utility
                            && candidate.side == decision.placement.side
                            && candidate.barrier == decision.placement.barrier
                    })
        }));
    }
    assert_eq!(
        replay
            .events
            .iter()
            .filter(|event| matches!(
                &event.kind,
                strikefall_protocol::RoundEventKindDto::BotPlacementDecision { .. }
            ))
            .count(),
        replay.bot_placement_decisions.len()
    );
    assert!(!replay.bot_escape_decisions.is_empty());
    let mut changed_placement_audit = replay.clone();
    changed_placement_audit.bot_placement_decisions[0].entropy_digest = "00".repeat(32);
    assert!(replay_inspector::verify_replay_bundle(&changed_placement_audit).is_err());
    let mut changed_candidate_utility = replay.clone();
    changed_candidate_utility.bot_placement_decisions[0].candidates[0].utility = "0".to_owned();
    assert!(replay_inspector::verify_replay_bundle(&changed_candidate_utility).is_err());
    let mut changed_escape_audit = replay.clone();
    changed_escape_audit.bot_escape_decisions[0].public_inputs_digest = "00".repeat(32);
    assert!(replay_inspector::verify_replay_bundle(&changed_escape_audit).is_err());

    let ack_uri = format!("/v1/solo-rounds/{}/replay-verified", created.round_id);
    let proof_digest = replay.result.proof_digest.clone();
    let (status, invalid_ack): (_, ApiErrorDto) = request_json_with_bearer(
        &app,
        Method::POST,
        &ack_uri,
        &token,
        &ReplayVerifiedRequest {
            proof_digest: "00".repeat(32),
            verifier_version: "replay-inspector/0.1.0".to_owned(),
        },
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_ack.code, "invalid_request");
    let ack_request = ReplayVerifiedRequest {
        proof_digest,
        verifier_version: "replay-inspector/0.1.0".to_owned(),
    };
    let (status, first_ack): (_, ReplayVerifiedResponse) =
        request_json_with_bearer(&app, Method::POST, &ack_uri, &token, &ack_request).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!first_ack.already_acknowledged);
    let (status, repeated_ack): (_, ReplayVerifiedResponse) =
        request_json_with_bearer(&app, Method::POST, &ack_uri, &token, &ack_request).await;
    assert_eq!(status, StatusCode::OK);
    assert!(repeated_ack.already_acknowledged);
    assert_eq!(repeated_ack.event_sequence, first_ack.event_sequence);

    let (status, acknowledged_replay): (_, ReplayBundleDto) =
        get_json_with_bearer(&app, &replay_uri, &token).await;
    assert_eq!(status, StatusCode::OK);
    let receipt = acknowledged_replay
        .replay_verification
        .as_ref()
        .expect("durable replay verification receipt");
    assert_eq!(receipt.event_sequence, first_ack.event_sequence);
    replay_inspector::verify_replay_bundle(&acknowledged_replay)
        .expect("acknowledged replay verifies");

    let mut changed_path = acknowledged_replay.clone();
    changed_path.path.battle[20].price = (changed_path.path.battle[20]
        .price
        .parse::<u128>()
        .expect("price")
        + SCALE)
        .to_string();
    assert!(replay_inspector::verify_replay_bundle(&changed_path).is_err());

    let mut changed_event = acknowledged_replay;
    changed_event.events[0].server_time_ms += 1;
    assert!(replay_inspector::verify_replay_bundle(&changed_event).is_err());
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn timed_bot_moves_stay_sealed_until_due_and_survive_restart_recovery() {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        ..ServiceConfig::default()
    };
    let key = SigningKey::from_bytes(&[73_u8; 32]);
    let service = RoundService::new(
        repository.clone(),
        clock.clone(),
        config.clone(),
        key.clone(),
    );
    let created = service
        .create_round(CreateRoundRequest {
            deck_id: Some("balanced_tape".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create timed-bot round");
    let initial = repository
        .load(&created.round_id)
        .await
        .expect("load initial round")
        .expect("initial round exists");
    let first_due = initial
        .next_bot_placement_at_ms
        .expect("first bot decision is scheduled");
    assert!(initial.bot_placement_decisions.is_empty());
    assert!(!initial.events.iter().any(|event| matches!(
        &event.kind,
        strikefall_protocol::RoundEventKindDto::BotPlacementDecision { .. }
    )));

    clock.set(first_due - 1);
    let early = service
        .recover_due_rounds(10)
        .await
        .expect("early scheduler pass");
    assert_eq!(early.discovered, 0, "future bot events must remain sealed");
    assert_eq!(
        service
            .event_snapshot(&created.round_id)
            .await
            .expect("early snapshot"),
        initial.events
    );

    clock.set(first_due);
    let due = service
        .recover_due_rounds(10)
        .await
        .expect("due scheduler pass");
    assert_eq!(due.discovered, 1);
    assert_eq!(due.advanced, 1);
    let after_first = repository
        .load(&created.round_id)
        .await
        .expect("load first decision")
        .expect("round remains");
    assert!(!after_first.bot_placement_decisions.is_empty());
    assert!(after_first
        .events
        .iter()
        .all(|event| event.server_time_ms <= first_due));
    let interactive_lead = created
        .placement_deadline_ms
        .saturating_sub(created.created_at_ms)
        .saturating_sub(12_000);
    for decision in &after_first.bot_placement_decisions {
        assert_eq!(
            first_due,
            created.created_at_ms + interactive_lead + decision.decision_time_ms,
            "only decisions sharing the first canonical due time may be published"
        );
    }

    let restarted = RoundService::new(repository.clone(), clock.clone(), config, key);
    clock.set(created.placement_deadline_ms);
    let recovered = restarted
        .recover_due_rounds(10)
        .await
        .expect("restart catches up placement");
    assert_eq!(recovered.discovered, 1);
    assert_eq!(recovered.advanced, 1);
    let locked = repository
        .load(&created.round_id)
        .await
        .expect("load recovered round")
        .expect("recovered round exists");
    assert_eq!(locked.status, RoundStatusDto::Battle);
    assert!(locked.next_bot_placement_at_ms.is_none());
    assert_eq!(
        locked.bot_placement_next_index,
        locked.bot_placement_decisions.len()
    );
    assert!(locked
        .events
        .windows(2)
        .all(|events| { events[0].server_time_ms <= events[1].server_time_ms }));
    assert!(locked.bot_placement_decisions.iter().all(|decision| {
        let expected_time = created.created_at_ms + interactive_lead + decision.decision_time_ms;
        locked.events.iter().any(|event| {
            event.server_time_ms == expected_time
                && matches!(
                    &event.kind,
                    strikefall_protocol::RoundEventKindDto::BotPlacementDecision {
                        decision: streamed
                    } if streamed == decision
                )
        })
    }));
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn bot_reaction_interval_excludes_player_moves_after_observation() {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new(
        repository.clone(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        SigningKey::from_bytes(&[74_u8; 32]),
    );
    let created = service
        .create_round(CreateRoundRequest {
            deck_id: Some("balanced_tape".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create observation-cutoff round");
    let initial = repository
        .load(&created.round_id)
        .await
        .expect("load observation-cutoff round")
        .expect("round exists");
    let placement_duration_ms = created.placement_deadline_ms - created.created_at_ms;
    let input_freeze_ms = created.placement_deadline_ms - created.input_freeze_at_ms;
    let first = generate_bot_placement_schedule(
        &initial.bot_seed_root,
        placement_duration_ms,
        input_freeze_ms,
    )
    .expect("bot schedule")[0];
    let interactive_lead = placement_duration_ms.saturating_sub(12_000);
    let observation_at = created.created_at_ms + interactive_lead + first.observation_time_ms;
    let decision_at = created.created_at_ms + interactive_lead + first.decision_time_ms;
    assert_eq!(
        decision_at - observation_at,
        u64::from(first.reaction_latency_ms)
    );

    let deck = deck_by_id("balanced_tape").expect("balanced deck");
    let battle_spot = initial.path.battle[0]
        .price
        .parse::<u128>()
        .expect("battle spot");
    let mut observed = vec![created.player_placement.clone()];
    observed.extend(initial.initial_bots.iter().cloned());
    let expected = evaluate_bot_placement_decision(
        deck,
        &initial.bot_seed_root,
        battle_spot,
        first,
        &observed,
    )
    .expect("decision from observation snapshot");

    let moved_side = match created.player_placement.side {
        SideDto::Upper => SideDto::Lower,
        SideDto::Lower => SideDto::Upper,
    };
    let moved_barrier = barrier_for_survival(
        battle_spot,
        700_000_000_000,
        deck.total_integrated_variance,
        deck.drift_per_variance,
        moved_side.to_core(),
    )
    .expect("legal post-observation barrier");
    clock.set(observation_at + 1);
    let moved = service
        .update_flag(
            &created.round_id,
            FlagUpdateRequest {
                side: moved_side,
                barrier: moved_barrier.to_string(),
                client_sequence: Some(1),
            },
        )
        .await
        .expect("player moves during committed reaction interval");
    observed[0].clone_from(&moved.placement);
    let leaked = evaluate_bot_placement_decision(
        deck,
        &initial.bot_seed_root,
        battle_spot,
        first,
        &observed,
    )
    .expect("counterfactual action-time decision");
    assert_ne!(expected.public_inputs_digest, leaked.public_inputs_digest);

    clock.set(decision_at);
    service
        .recover_due_rounds(10)
        .await
        .expect("publish first due decision");
    let after = repository
        .load(&created.round_id)
        .await
        .expect("load decided round")
        .expect("round remains");
    assert_eq!(after.bot_placement_decisions[0], expected);
    assert_eq!(
        after.bot_placement_decisions[0].observation_time_ms,
        first.observation_time_ms
    );

    clock.set(created.placement_deadline_ms);
    service
        .lock_round(&created.round_id)
        .await
        .expect("lock observation-cutoff round");
    let battle_duration = u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
    clock.advance(RANKED_LOCK_PHASE_MS + battle_duration);
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve observation-cutoff round");
    let replay = service
        .replay(&created.round_id)
        .await
        .expect("observation-cutoff replay");
    replay_inspector::verify_replay_bundle(&replay)
        .expect("verifier reconstructs the committed observation snapshot");
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn midpoint_escape_banks_once_and_remains_replayable() {
    let clock = Arc::new(ManualClock::new(START_MS));
    let repository = InMemoryRoundRepository::shared();
    let service = RoundService::new(
        repository.clone(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        SigningKey::from_bytes(&[8_u8; 32]),
    );

    for attempt in 0..32_u64 {
        clock.set(START_MS + attempt * 100_000);
        let created = service
            .create_round(CreateRoundRequest {
                deck_id: Some("balanced_tape".to_owned()),
                deck_version: Some(3),
            })
            .await
            .expect("create escape fixture");
        let stored = repository
            .load(&created.round_id)
            .await
            .expect("load fixture")
            .expect("stored fixture");
        let midpoint = usize::from(created.deck.battle_steps / 2);
        let prefix_prices: Vec<u128> = stored.path.battle[..=midpoint]
            .iter()
            .map(|point| point.price.parse().expect("path price"))
            .collect();
        let battle_spot = prefix_prices[0];
        let mut candidate = None;
        for (side, core_side) in [
            (SideDto::Upper, BarrierSide::Upper),
            (SideDto::Lower, BarrierSide::Lower),
        ] {
            let barrier = barrier_for_survival(
                battle_spot,
                875_000_000_000,
                created
                    .deck
                    .total_integrated_variance
                    .parse()
                    .expect("variance"),
                created.deck.drift_per_variance.parse().expect("drift"),
                core_side,
            )
            .expect("escape candidate barrier");
            let untouched = match side {
                SideDto::Upper => prefix_prices.iter().all(|price| *price < barrier),
                SideDto::Lower => prefix_prices.iter().all(|price| *price > barrier),
            };
            if untouched {
                candidate = Some((side, barrier));
                break;
            }
        }
        let Some((side, barrier)) = candidate else {
            continue;
        };

        service
            .update_flag(
                &created.round_id,
                FlagUpdateRequest {
                    side,
                    barrier: barrier.to_string(),
                    client_sequence: Some(1),
                },
            )
            .await
            .expect("place an untouched midpoint flag");
        clock.set(created.placement_deadline_ms);
        service.lock_round(&created.round_id).await.expect("lock");
        let battle_duration =
            u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
        clock.advance(RANKED_LOCK_PHASE_MS + battle_duration / 2);
        let escaped = service
            .escape(
                &created.round_id,
                EscapeRequest {
                    client_sequence: Some(2),
                },
            )
            .await
            .expect("midpoint Escape succeeds");
        assert!(escaped.escape.banked_score.parse::<u128>().expect("score") > 0);
        assert!(service
            .escape(
                &created.round_id,
                EscapeRequest {
                    client_sequence: Some(3),
                },
            )
            .await
            .is_err());
        clock.advance(battle_duration - battle_duration / 2);
        service
            .resolve_round(&created.round_id)
            .await
            .expect("resolve");
        let replay = service.replay(&created.round_id).await.expect("replay");
        assert_eq!(
            replay.result.outcome,
            strikefall_protocol::ContenderOutcomeDto::Escaped
        );
        replay_inspector::verify_replay_bundle(&replay).expect("escaped replay verifies");
        let mut mutated_escape = replay;
        mutated_escape
            .escape
            .as_mut()
            .expect("player Escape")
            .banked_score = "1".to_owned();
        assert!(replay_inspector::verify_replay_bundle(&mutated_escape).is_err());
        return;
    }
    panic!("could not generate an untouched midpoint flag fixture");
}
