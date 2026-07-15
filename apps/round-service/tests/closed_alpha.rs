use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use ed25519_dalek::SigningKey;
use serde_json::json;
use strikefall_protocol::{
    verify_replay_bundle, CreateRoundRequest, EscapeRequest, ReplayVerifiedRequest,
    RoundEventKindDto, RoundStatusDto, PLAYER_CONTENDER_ID, PROTOCOL_VERSION, RANKED_LOCK_PHASE_MS,
};
use strikefall_round_service::{
    bearer_token_digest, invite_code_digest, metrics_token_digest, router, AlphaRepository, Clock,
    ClosedAlphaConfig, CreateSessionRequest, G4ErrorRateStatusDto, InMemoryRoundRepository,
    LeaderboardQuery, LeaderboardWindow, ManualClock, RenameSessionRequest, RoundRepository,
    RoundService, ServiceConfig, ServiceError, TelemetryBatchRequest, TelemetryConsentRequest,
    TelemetryEventInput, TelemetryMetricsQuery, TelemetryRecord, DECK_STRUCTURE_EXPERIMENT,
    ESCAPE_EXPERIMENT, RISK_DISPLAY_EXPERIMENT, TELEMETRY_SCHEMA_VERSION,
};
use tower::ServiceExt;
use uuid::Uuid;

const START_MS: u64 = 1_700_000_000_000;
const INVITE: &str = "closed-alpha-2026";
const METRICS_TOKEN: &str = "metrics-test-token";

fn alpha_service(
    alpha_config: ClosedAlphaConfig,
) -> (RoundService, Arc<InMemoryRoundRepository>, Arc<ManualClock>) {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new_with_alpha_config(
        repository.clone(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        alpha_config,
        SigningKey::from_bytes(&[31_u8; 32]),
    );
    (service, repository, clock)
}

fn invite_config() -> ClosedAlphaConfig {
    ClosedAlphaConfig {
        invite_required: true,
        invite_code_hashes: BTreeSet::from([invite_code_digest(INVITE).expect("invite digest")]),
        metrics_token_hash: Some(metrics_token_digest(METRICS_TOKEN)),
        ..ClosedAlphaConfig::default()
    }
}

async fn issue(
    service: &RoundService,
    handle: &str,
    consent: bool,
    ip: IpAddr,
) -> strikefall_round_service::IssuedSessionDto {
    service
        .issue_session(
            CreateSessionRequest {
                invite_code: Some(INVITE.to_owned()),
                handle: Some(handle.to_owned()),
                telemetry_consent: consent,
            },
            Some(ip),
        )
        .await
        .expect("issue session")
}

async fn post_session(app: &axum::Router, handle: &str, ip: &str) -> StatusCode {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/v1/sessions")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-real-ip", ip)
        .body(Body::from(
            serde_json::to_vec(&CreateSessionRequest {
                invite_code: Some(INVITE.to_owned()),
                handle: Some(handle.to_owned()),
                telemetry_consent: false,
            })
            .expect("session body"),
        ))
        .expect("session request");
    app.clone()
        .oneshot(request)
        .await
        .expect("session response")
        .status()
}

async fn create_and_resolve(
    service: &RoundService,
    clock: &ManualClock,
    bearer: &str,
) -> strikefall_protocol::CreateRoundResponse {
    let created = service
        .create_round_for_bearer(
            bearer,
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            CreateRoundRequest {
                deck_id: Some("balanced_tape".to_owned()),
                deck_version: Some(3),
            },
        )
        .await
        .expect("create authenticated round");
    clock.set(created.placement_deadline_ms);
    service
        .lock_round(&created.round_id)
        .await
        .expect("lock round");
    clock.advance(
        RANKED_LOCK_PHASE_MS
            + u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms),
    );
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve round");
    created
}

fn forced_experiments(deck: &str, escape: &str, risk: &str) -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([
        (DECK_STRUCTURE_EXPERIMENT.to_owned(), vec![deck.to_owned()]),
        (ESCAPE_EXPERIMENT.to_owned(), vec![escape.to_owned()]),
        (RISK_DISPLAY_EXPERIMENT.to_owned(), vec![risk.to_owned()]),
    ])
}

#[tokio::test]
async fn public_quick_run_signs_only_mandatory_assignments_without_a_deck_cohort() {
    let (service, repository, _) = alpha_service(invite_config());
    let issued = issue(
        &service,
        "FourDecks",
        false,
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, 87)),
    )
    .await;
    let quick = service
        .create_round_for_bearer(&issued.token, None, CreateRoundRequest::default())
        .await
        .expect("public quick run");
    assert_eq!(quick.experiment_assignments, issued.session.experiments);
    assert!(!quick
        .experiment_assignments
        .contains_key(DECK_STRUCTURE_EXPERIMENT));
    assert!(matches!(
        quick.deck.id.as_str(),
        "balanced_tape" | "compression_break" | "opening_rush" | "pulse"
    ));
    let stored = repository
        .load(&quick.round_id)
        .await
        .expect("load round")
        .expect("stored round");
    let created_assignments = stored.events.iter().find_map(|event| match &event.kind {
        strikefall_protocol::RoundEventKindDto::RoundCreated {
            experiment_assignments,
            ..
        } => Some(experiment_assignments),
        _ => None,
    });
    assert_eq!(created_assignments, Some(&quick.experiment_assignments));
}

#[tokio::test]
async fn quick_run_uses_the_assigned_deck_while_explicit_daily_decks_win() {
    let mut config = invite_config();
    config.experiments = forced_experiments("compression-break", "midpoint", "danger-band");
    let (service, repository, _) = alpha_service(config);
    let issued = issue(
        &service,
        "DeckTester",
        false,
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, 88)),
    )
    .await;
    let quick = service
        .create_round_for_bearer(
            &issued.token,
            None,
            CreateRoundRequest {
                deck_id: None,
                deck_version: None,
            },
        )
        .await
        .expect("assigned quick run");
    assert_eq!(quick.deck.id, "compression_break");
    let stored = repository
        .load(&quick.round_id)
        .await
        .expect("load round")
        .expect("stored round");
    assert_eq!(stored.experiment_assignments, issued.session.experiments);

    let daily = service
        .create_round_for_bearer(
            &issued.token,
            None,
            CreateRoundRequest {
                deck_id: Some("opening_rush".to_owned()),
                deck_version: Some(3),
            },
        )
        .await
        .expect("explicit daily run");
    assert_eq!(daily.deck.id, "opening_rush");
}

#[tokio::test]
async fn absent_escape_disables_player_and_bot_escape_authoritatively() {
    let mut config = invite_config();
    config.experiments = forced_experiments("flat", "absent", "probability");
    let (service, _, clock) = alpha_service(config);
    let issued = issue(
        &service,
        "NoEscape",
        false,
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, 89)),
    )
    .await;
    let created = service
        .create_round_for_bearer(&issued.token, None, CreateRoundRequest::default())
        .await
        .expect("create absent-Escape round");
    assert_eq!(
        created
            .experiment_assignments
            .get(ESCAPE_EXPERIMENT)
            .map(String::as_str),
        Some("absent")
    );
    clock.set(created.placement_deadline_ms);
    service.lock_round(&created.round_id).await.expect("lock");
    let battle_duration = u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
    clock.set(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS + battle_duration / 2);
    service
        .advance_battle_round(&created.round_id)
        .await
        .expect("advance to midpoint");
    assert!(matches!(
        service
            .escape(
                &created.round_id,
                EscapeRequest {
                    client_sequence: Some(1),
                },
            )
            .await,
        Err(ServiceError::InvalidState(_))
    ));
    clock.set(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS + battle_duration);
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve without Escape");
    let replay = service.replay(&created.round_id).await.expect("replay");
    assert!(replay.escape.is_none());
    assert!(replay.bot_escape_decisions.is_empty());
    assert!(replay.bot_escapes.is_empty());
    verify_replay_bundle(&replay).expect("absent-Escape replay verifies");
}

#[tokio::test]
async fn invite_tokens_handles_rotation_expiry_and_ip_limits_are_fail_closed() {
    let mut config = invite_config();
    config.session_ttl_ms = 1_000;
    let (service, repository, clock) = alpha_service(config);
    let ip = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));

    let invalid = service
        .issue_session(
            CreateSessionRequest {
                invite_code: Some("wrong-code".to_owned()),
                handle: Some("AlphaRider".to_owned()),
                telemetry_consent: false,
            },
            Some(ip),
        )
        .await;
    assert!(matches!(invalid, Err(ServiceError::Forbidden(_))));

    let issued = issue(&service, "AlphaRider", false, ip).await;
    assert!(issued.token.starts_with("sf_alpha_"));
    assert_eq!(
        issued
            .session
            .experiments
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec![ESCAPE_EXPERIMENT, RISK_DISPLAY_EXPERIMENT]
    );
    let digest = bearer_token_digest(&issued.token).expect("token digest");
    let stored = repository
        .load_session_by_token_hash(&digest)
        .await
        .expect("load hashed token")
        .expect("session stored");
    assert_eq!(stored.token_hash, digest);
    assert!(!serde_json::to_string(&stored)
        .expect("stored session JSON")
        .contains(&issued.token));
    assert_eq!(stored.creation_ip_hash.len(), 64);

    assert!(service
        .rename_session(
            &issued.token,
            RenameSessionRequest {
                handle: " admin".to_owned()
            },
            Some(ip)
        )
        .await
        .is_err());
    let renamed = service
        .rename_session(
            &issued.token,
            RenameSessionRequest {
                handle: "NeonRider".to_owned(),
            },
            Some(ip),
        )
        .await
        .expect("rename");
    assert_eq!(renamed.handle, "NeonRider");

    let rotated = service
        .rotate_session(&issued.token, Some(ip))
        .await
        .expect("rotate");
    assert_ne!(rotated.token, issued.token);
    assert!(matches!(
        service.session_view(&issued.token).await,
        Err(ServiceError::Unauthorized(_))
    ));
    assert!(service.session_view(&rotated.token).await.is_ok());
    clock.advance(1_001);
    assert!(matches!(
        service.session_view(&rotated.token).await,
        Err(ServiceError::Unauthorized(_))
    ));

    let (rate_service, _, _) = alpha_service(invite_config());
    for index in 0..5 {
        issue(&rate_service, &format!("Rider{index}"), false, ip).await;
    }
    assert!(matches!(
        rate_service
            .issue_session(
                CreateSessionRequest {
                    invite_code: Some(INVITE.to_owned()),
                    handle: Some("RiderSix".to_owned()),
                    telemetry_consent: false,
                },
                Some(ip),
            )
            .await,
        Err(ServiceError::AbuseRateLimited(_))
    ));
}

#[tokio::test]
async fn reverse_proxy_ip_is_ignored_unless_the_trust_boundary_is_enabled() {
    let service = |trust_proxy_headers| {
        RoundService::new_with_alpha_config(
            InMemoryRoundRepository::shared(),
            Arc::new(ManualClock::new(START_MS)),
            ServiceConfig {
                auto_advance: false,
                trust_proxy_headers,
                ..ServiceConfig::default()
            },
            invite_config(),
            SigningKey::from_bytes(&[91_u8; 32]),
        )
    };

    let untrusted = router(service(false));
    for index in 0..5 {
        let status = post_session(
            &untrusted,
            &format!("Untrusted{index}"),
            &format!("198.51.100.{}", index + 1),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }
    assert_eq!(
        post_session(&untrusted, "UntrustedSix", "198.51.100.99").await,
        StatusCode::TOO_MANY_REQUESTS
    );

    let trusted = router(service(true));
    for index in 0..6 {
        let status = post_session(
            &trusted,
            &format!("Trusted{index}"),
            &format!("203.0.113.{}", index + 1),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }
}

#[tokio::test]
async fn verified_rounds_alone_feed_short_lived_private_safe_leaderboards_and_shares() {
    let (service, repository, clock) = alpha_service(invite_config());
    let ip = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 4));
    let issued = issue(&service, "ScorePilot", false, ip).await;
    let created = create_and_resolve(&service, &clock, &issued.token).await;
    let stored = repository
        .load(&created.round_id)
        .await
        .expect("load round")
        .expect("round stored");
    assert_eq!(stored.status, RoundStatusDto::Resolved);
    assert!(stored.session_id.is_some());
    let mut expected_round_experiments = issued.session.experiments.clone();
    expected_round_experiments.remove(DECK_STRUCTURE_EXPERIMENT);
    assert_eq!(stored.experiment_assignments, expected_round_experiments);

    let query = || LeaderboardQuery {
        window: Some(LeaderboardWindow::Daily),
        limit: Some(25),
        cursor: None,
    };
    let before_ack = service
        .leaderboard(&issued.token, Some(ip), "balanced_tape", query())
        .await
        .expect("leaderboard before verification");
    assert!(before_ack.entries.is_empty());
    assert!(matches!(
        service.public_replay(&created.round_id, Some(ip)).await,
        Err(ServiceError::NotFound)
    ));

    let replay = service.replay(&created.round_id).await.expect("replay");
    service
        .acknowledge_replay(
            &created.round_id,
            ReplayVerifiedRequest {
                proof_digest: replay.result.proof_digest.clone(),
                verifier_version: "closed-alpha-test/1".to_owned(),
            },
        )
        .await
        .expect("verify replay");
    let leaderboard = service
        .leaderboard(&issued.token, Some(ip), "balanced_tape", query())
        .await
        .expect("verified leaderboard");
    assert_eq!(leaderboard.entries.len(), 1);
    assert_eq!(leaderboard.entries[0].handle, "ScorePilot");
    assert!(leaderboard.entries[0].is_self);
    assert_eq!(leaderboard.self_entry, Some(leaderboard.entries[0].clone()));

    service
        .rename_session(
            &issued.token,
            RenameSessionRequest {
                handle: "SaferHandle".to_owned(),
            },
            Some(ip),
        )
        .await
        .expect("rename after score");
    let renamed_board = service
        .leaderboard(&issued.token, Some(ip), "balanced_tape", query())
        .await
        .expect("renamed leaderboard");
    assert_eq!(renamed_board.entries[0].handle, "SaferHandle");

    let public = service
        .public_replay(&created.round_id, Some(ip))
        .await
        .expect("verified replay is shareable");
    assert_eq!(public.anchor.round_id, public.replay.round_id);
    assert_eq!(public.anchor.protocol_version, PROTOCOL_VERSION);
    assert_eq!(public.anchor.commitment, public.replay.commitment);
    assert_eq!(
        public.anchor.server_verifying_key,
        public.replay.server_verifying_key
    );
    let public_json = serde_json::to_string(&public).expect("public replay JSON");
    assert!(!public_json.contains("ScorePilot"));
    assert!(!public_json.contains("SaferHandle"));
    assert!(!public_json.contains(&issued.token));
    assert!(!public_json.contains("sessionId"));

    clock.advance(24 * 60 * 60 * 1_000 + 1);
    let expired_daily = service
        .leaderboard(&issued.token, Some(ip), "balanced_tape", query())
        .await
        .expect("daily window");
    assert!(expired_daily.entries.is_empty());
    let weekly = service
        .leaderboard(
            &issued.token,
            Some(ip),
            "balanced_tape",
            LeaderboardQuery {
                window: Some(LeaderboardWindow::Weekly),
                limit: Some(101),
                cursor: None,
            },
        )
        .await
        .expect("weekly window");
    assert_eq!(weekly.entries.len(), 1);
}

#[tokio::test]
async fn replay_ack_reverifies_authoritative_bytes_before_ranking() {
    let (service, repository, clock) = alpha_service(invite_config());
    let ip = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 45));
    let issued = issue(&service, "ProofRider", false, ip).await;
    let created = create_and_resolve(&service, &clock, &issued.token).await;
    let replay = service.replay(&created.round_id).await.expect("replay");

    let mut corrupted = repository
        .load(&created.round_id)
        .await
        .expect("load round")
        .expect("stored round");
    let expected_revision = corrupted.revision;
    corrupted.path.battle[0].price = "1".to_owned();
    repository
        .save(expected_revision, corrupted)
        .await
        .expect("persist simulated corruption");

    assert!(matches!(
        service
            .acknowledge_replay(
                &created.round_id,
                ReplayVerifiedRequest {
                    proof_digest: replay.result.proof_digest,
                    verifier_version: "closed-alpha-test/1".to_owned(),
                },
            )
            .await,
        Err(ServiceError::Computation(_))
    ));
    let leaderboard = service
        .leaderboard(
            &issued.token,
            Some(ip),
            "balanced_tape",
            LeaderboardQuery {
                window: Some(LeaderboardWindow::Daily),
                limit: Some(25),
                cursor: None,
            },
        )
        .await
        .expect("leaderboard after rejected verification");
    assert!(leaderboard.entries.is_empty());
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn telemetry_is_consented_strict_idempotent_authoritative_and_aggregated() {
    let (service, _, clock) = alpha_service(invite_config());
    let ip = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 9));
    let issued = issue(&service, "MetricRider", false, ip).await;
    let created = create_and_resolve(&service, &clock, &issued.token).await;
    let replay = service.replay(&created.round_id).await.expect("replay");
    let outcome = match replay.result.outcome {
        strikefall_protocol::ContenderOutcomeDto::Survived => "survived",
        strikefall_protocol::ContenderOutcomeDto::Eliminated => "eliminated",
        strikefall_protocol::ContenderOutcomeDto::Escaped => "escaped",
    };
    let player_side = replay
        .placements
        .iter()
        .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
        .map(|placement| match placement.side {
            strikefall_protocol::SideDto::Upper => "upper",
            strikefall_protocol::SideDto::Lower => "lower",
        })
        .expect("player placement");
    let complete_id = Uuid::new_v4().to_string();
    let placement_id = Uuid::new_v4().to_string();
    let performance_id = Uuid::new_v4().to_string();
    let client_error_id = Uuid::new_v4().to_string();
    let share_id = Uuid::new_v4().to_string();
    let clip_id = Uuid::new_v4().to_string();
    let batch = || TelemetryBatchRequest {
        schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
        events: vec![
            TelemetryEventInput {
                event_id: complete_id.clone(),
                name: "round_completed".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "deckId": created.deck.id,
                    "durationMs": 60_000,
                    "outcome": outcome,
                    "rank": replay.result.rank,
                    "roundId": created.round_id,
                }),
            },
            TelemetryEventInput {
                event_id: performance_id.clone(),
                name: "ui_performance".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "fpsBucket": "60",
                    "reducedMotion": false,
                    "screen": "results",
                }),
            },
            TelemetryEventInput {
                event_id: placement_id.clone(),
                name: "placement_locked".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "deckId": created.deck.id,
                    "roundId": created.round_id,
                    "side": player_side,
                }),
            },
            TelemetryEventInput {
                event_id: client_error_id.clone(),
                name: "client_error".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "code": "render_failure",
                    "surface": "arena",
                }),
            },
            TelemetryEventInput {
                event_id: share_id.clone(),
                name: "share_opened".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "deckId": created.deck.id,
                    "roundId": created.round_id,
                }),
            },
            TelemetryEventInput {
                event_id: clip_id.clone(),
                name: "clip_exported".to_owned(),
                occurred_at_ms: clock.now_ms(),
                properties: json!({
                    "deckId": created.deck.id,
                    "roundId": created.round_id,
                }),
            },
        ],
    };
    assert!(matches!(
        service
            .ingest_telemetry(&issued.token, Some(ip), batch())
            .await,
        Err(ServiceError::Forbidden(_))
    ));
    service
        .update_telemetry_consent(
            &issued.token,
            Some(ip),
            TelemetryConsentRequest { consent: true },
        )
        .await
        .expect("consent");
    let mut legacy = batch();
    legacy.schema_version = "strikefall/telemetry/v1".to_owned();
    assert!(matches!(
        service
            .ingest_telemetry(&issued.token, Some(ip), legacy)
            .await,
        Err(ServiceError::InvalidRequest(_))
    ));
    let inserted = service
        .ingest_telemetry(&issued.token, Some(ip), batch())
        .await
        .expect("valid telemetry");
    assert_eq!(inserted.accepted, 6);
    assert_eq!(inserted.duplicates, 0);
    let duplicate = service
        .ingest_telemetry(&issued.token, Some(ip), batch())
        .await
        .expect("idempotent telemetry");
    assert_eq!(duplicate.accepted, 0);
    assert_eq!(duplicate.duplicates, 6);
    let mut semantic_retry = batch();
    semantic_retry.events.truncate(1);
    semantic_retry.events[0].event_id = Uuid::new_v4().to_string();
    let semantic_duplicate = service
        .ingest_telemetry(&issued.token, Some(ip), semantic_retry)
        .await
        .expect("semantic telemetry idempotency");
    assert_eq!(semantic_duplicate.accepted, 0);
    assert_eq!(semantic_duplicate.duplicates, 1);

    let metrics_time = clock.now_ms();
    let player_eliminated_at = replay.events.iter().find_map(|event| match &event.kind {
        RoundEventKindDto::FlagHit { touch } if touch.contender_id == PLAYER_CONTENDER_ID => {
            Some(event.server_time_ms)
        }
        _ => None,
    });
    let dead_response = |occurred_at_ms| TelemetryBatchRequest {
        schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
        events: vec![TelemetryEventInput {
            event_id: Uuid::new_v4().to_string(),
            name: "dead_player_response".to_owned(),
            occurred_at_ms,
            properties: json!({
                "action": "spectate",
                "deckId": created.deck.id,
                "roundId": created.round_id,
            }),
        }],
    };
    if let Some(eliminated_at_ms) = player_eliminated_at {
        clock.set(eliminated_at_ms + 1_000);
        let inserted = service
            .ingest_telemetry(&issued.token, Some(ip), dead_response(clock.now_ms()))
            .await
            .expect("bounded dead-player response");
        assert_eq!(inserted.accepted, 1);
        clock.set(metrics_time);
    } else {
        assert!(matches!(
            service
                .ingest_telemetry(&issued.token, Some(ip), dead_response(clock.now_ms()),)
                .await,
            Err(ServiceError::InvalidRequest(_))
        ));
    }

    let poisoned = TelemetryBatchRequest {
        schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
        events: vec![TelemetryEventInput {
            event_id: Uuid::new_v4().to_string(),
            name: "ui_performance".to_owned(),
            occurred_at_ms: clock.now_ms(),
            properties: json!({
                "fpsBucket": "60",
                "pathSeed": "must-not-be-accepted",
                "reducedMotion": false,
                "screen": "arena",
            }),
        }],
    };
    assert!(matches!(
        service
            .ingest_telemetry(&issued.token, Some(ip), poisoned)
            .await,
        Err(ServiceError::InvalidRequest(_))
    ));
    let leaking_error = TelemetryBatchRequest {
        schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
        events: vec![TelemetryEventInput {
            event_id: Uuid::new_v4().to_string(),
            name: "client_error".to_owned(),
            occurred_at_ms: clock.now_ms(),
            properties: json!({
                "code": "render_failure",
                "message": "private browser diagnostic",
                "stack": "private stack",
                "surface": "arena",
            }),
        }],
    };
    assert!(matches!(
        service
            .ingest_telemetry(&issued.token, Some(ip), leaking_error)
            .await,
        Err(ServiceError::InvalidRequest(_))
    ));
    let forged_result = TelemetryBatchRequest {
        schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
        events: vec![TelemetryEventInput {
            event_id: Uuid::new_v4().to_string(),
            name: "round_completed".to_owned(),
            occurred_at_ms: clock.now_ms(),
            properties: json!({
                "deckId": created.deck.id,
                "durationMs": 60_000,
                "outcome": outcome,
                "rank": if replay.result.rank == 1 { 2 } else { 1 },
                "roundId": created.round_id,
            }),
        }],
    };
    assert!(matches!(
        service
            .ingest_telemetry(&issued.token, Some(ip), forged_result)
            .await,
        Err(ServiceError::InvalidRequest(_))
    ));

    assert!(matches!(
        service
            .telemetry_metrics(
                "wrong-token",
                TelemetryMetricsQuery {
                    window_hours: Some(24),
                    deck_id: None,
                }
            )
            .await,
        Err(ServiceError::Unauthorized(_))
    ));
    let metrics = service
        .telemetry_metrics(
            METRICS_TOKEN,
            TelemetryMetricsQuery {
                window_hours: Some(24),
                deck_id: None,
            },
        )
        .await
        .expect("aggregate metrics");
    assert_eq!(metrics.counts.get("round_completed"), Some(&1));
    assert_eq!(metrics.counts.get("ui_performance"), Some(&1));
    assert_eq!(metrics.counts.get("client_error"), Some(&1));
    assert_eq!(metrics.counts.get("placement_locked"), Some(&1));
    assert_eq!(metrics.counts.get("share_opened"), Some(&1));
    assert_eq!(metrics.counts.get("clip_exported"), Some(&1));
    assert_eq!(
        metrics
            .counts
            .get("dead_player_response")
            .copied()
            .unwrap_or(0),
        u64::from(player_eliminated_at.is_some())
    );
    assert_eq!(metrics.product_metrics.distinct_sessions, 1);
    assert_eq!(metrics.product_metrics.second_round_sessions, 0);
    assert_eq!(metrics.product_metrics.third_round_sessions, 0);
    assert_eq!(metrics.product_metrics.client_error_sessions, 1);
    assert_eq!(
        metrics.product_metrics.error_session_rate_per_million,
        Some(1_000_000)
    );
    assert_eq!(
        metrics.product_metrics.g4_error_status,
        G4ErrorRateStatusDto::Insufficient
    );
    assert_eq!(metrics.product_metrics.outcomes.get(outcome), Some(&1));
    assert_eq!(metrics.product_metrics.flag_revision_samples, 1);
    assert_eq!(metrics.product_metrics.median_flag_revisions_milli, Some(0));
    assert_eq!(metrics.product_metrics.survivor_samples, 1);
    assert_eq!(
        metrics.product_metrics.median_survivors_milli,
        Some(u32::from(replay.result.survivors) * 1_000)
    );
    assert_eq!(metrics.product_metrics.placement_spread_rounds, 1);
    assert_eq!(metrics.product_metrics.share_intent_rounds, 1);
    assert_eq!(
        metrics.product_metrics.share_intent_rate_per_mille,
        Some(1_000)
    );
    assert_eq!(metrics.product_metrics.clip_exported_rounds, 1);
    assert_eq!(
        metrics.product_metrics.clip_export_rate_per_mille,
        Some(1_000)
    );
    assert_eq!(
        metrics.product_metrics.dead_player_eliminations,
        u64::from(player_eliminated_at.is_some())
    );
    assert_eq!(
        metrics
            .product_metrics
            .dead_player_responses_within_five_seconds,
        u64::from(player_eliminated_at.is_some())
    );
    assert_eq!(
        metrics.product_metrics.dead_player_response_rate_per_mille,
        player_eliminated_at.map(|_| 1_000)
    );
    assert!(metrics
        .product_metrics
        .elimination_step_distribution
        .is_some());
    assert!(metrics
        .product_metrics
        .elimination_step_distribution_note
        .contains("Authoritative"));
    assert_eq!(metrics.experiment_cuts.len(), 2);
    assert!(metrics.experiment_cuts.iter().all(|cut| {
        issued.session.experiments.get(&cut.experiment_key) == Some(&cut.variant)
            && cut.counts.get("ui_performance") == Some(&1)
            && cut.counts.get("client_error") == Some(&1)
            && cut.counts.get("share_opened") == Some(&1)
            && cut.counts.get("clip_exported") == Some(&1)
            && if cut.experiment_key == DECK_STRUCTURE_EXPERIMENT {
                !cut.counts.contains_key("round_completed")
            } else {
                cut.counts.get("round_completed") == Some(&1)
            }
    }));
    assert!(metrics.experiment_cuts.iter().all(|cut| {
        matches!(
            cut.experiment_key.as_str(),
            DECK_STRUCTURE_EXPERIMENT | ESCAPE_EXPERIMENT | RISK_DISPLAY_EXPERIMENT
        )
    }));
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn authoritative_metrics_count_repeat_sessions_outcomes_and_error_sessions_without_ids() {
    let (service, repository, clock) = alpha_service(invite_config());
    let experiment_key = RISK_DISPLAY_EXPERIMENT.to_owned();
    let assignments = BTreeMap::from([(experiment_key.clone(), "probability".to_owned())]);
    let mut records = Vec::new();
    for session_index in 0..50 {
        let starts = match session_index {
            0 => 3,
            1 => 2,
            _ => 1,
        };
        for _ in 0..starts {
            let round_id = Uuid::new_v4().to_string();
            records.push(TelemetryRecord {
                event_id: Uuid::new_v4().to_string(),
                session_id: format!("aggregate-session-{session_index}"),
                event_name: "round_started".to_owned(),
                occurred_at_ms: clock.now_ms(),
                received_at_ms: clock.now_ms(),
                deck_id: Some("balanced_tape".to_owned()),
                round_id: Some(round_id.clone()),
                properties: json!({
                    "deckId": "balanced_tape",
                    "roundId": round_id,
                }),
                experiment_assignments: assignments.clone(),
                retention_until_ms: clock.now_ms() + 60_000,
            });
        }
    }
    records.push(TelemetryRecord {
        event_id: Uuid::new_v4().to_string(),
        session_id: "aggregate-ui-only-session".to_owned(),
        event_name: "ui_performance".to_owned(),
        occurred_at_ms: clock.now_ms(),
        received_at_ms: clock.now_ms(),
        deck_id: None,
        round_id: None,
        properties: json!({
            "fpsBucket": "60",
            "reducedMotion": false,
            "screen": "onboarding",
        }),
        experiment_assignments: assignments.clone(),
        retention_until_ms: clock.now_ms() + 60_000,
    });
    let facts = [
        ("survived", 1, 20, 0, false, None),
        ("eliminated", 2, 4, 16, false, Some(12)),
        ("escaped", 3, 0, 20, true, None),
    ];
    let mut completed_round_ids = Vec::new();
    for (session_index, (outcome, revisions, survivors, eliminated, early_wipe, step)) in
        facts.into_iter().enumerate()
    {
        let round_id = Uuid::new_v4().to_string();
        completed_round_ids.push(round_id.clone());
        records.push(TelemetryRecord {
            event_id: Uuid::new_v4().to_string(),
            session_id: format!("aggregate-session-{session_index}"),
            event_name: "round_completed".to_owned(),
            occurred_at_ms: clock.now_ms(),
            received_at_ms: clock.now_ms(),
            deck_id: Some("balanced_tape".to_owned()),
            round_id: Some(round_id.clone()),
            properties: json!({
                "deckId": "balanced_tape",
                "durationMs": 60_000,
                "outcome": outcome,
                "rank": session_index + 1,
                "roundId": round_id,
                "_playerFlagRevisions": revisions,
                "_upperPlacements": 10,
                "_lowerPlacements": 10,
                "_populatedRiskBands": 7,
                "_survivors": survivors,
                "_eliminated": eliminated,
                "_earlyMassWipe": early_wipe,
                "_playerEliminationStep": step,
            }),
            experiment_assignments: assignments.clone(),
            retention_until_ms: clock.now_ms() + 60_000,
        });
    }
    for (event_name, session_index, round_index, properties) in [
        (
            "dead_player_response",
            1,
            1,
            json!({
                "action": "rematch",
                "deckId": "balanced_tape",
                "roundId": completed_round_ids[1],
                "_withinFiveSeconds": true,
            }),
        ),
        (
            "share_opened",
            0,
            0,
            json!({
                "deckId": "balanced_tape",
                "roundId": completed_round_ids[0],
            }),
        ),
        (
            "clip_exported",
            0,
            0,
            json!({
                "deckId": "balanced_tape",
                "roundId": completed_round_ids[0],
            }),
        ),
    ] {
        records.push(TelemetryRecord {
            event_id: Uuid::new_v4().to_string(),
            session_id: format!("aggregate-session-{session_index}"),
            event_name: event_name.to_owned(),
            occurred_at_ms: clock.now_ms(),
            received_at_ms: clock.now_ms(),
            deck_id: Some("balanced_tape".to_owned()),
            round_id: Some(completed_round_ids[round_index].clone()),
            properties,
            experiment_assignments: assignments.clone(),
            retention_until_ms: clock.now_ms() + 60_000,
        });
    }
    for code in ["render_failure", "unhandled_rejection"] {
        records.push(TelemetryRecord {
            event_id: Uuid::new_v4().to_string(),
            session_id: "aggregate-session-0".to_owned(),
            event_name: "client_error".to_owned(),
            occurred_at_ms: clock.now_ms(),
            received_at_ms: clock.now_ms(),
            deck_id: None,
            round_id: None,
            properties: json!({ "code": code, "surface": "arena" }),
            experiment_assignments: assignments.clone(),
            retention_until_ms: clock.now_ms() + 60_000,
        });
    }
    let inserted = repository
        .insert_telemetry(&records)
        .await
        .expect("aggregate fixtures");
    assert_eq!(inserted.accepted, 62);

    let metrics = service
        .telemetry_metrics(
            METRICS_TOKEN,
            TelemetryMetricsQuery {
                window_hours: Some(24),
                deck_id: None,
            },
        )
        .await
        .expect("aggregate metrics");
    assert_eq!(metrics.counts.get("round_started"), Some(&53));
    assert_eq!(metrics.counts.get("client_error"), Some(&2));
    assert_eq!(metrics.product_metrics.distinct_sessions, 51);
    assert_eq!(metrics.product_metrics.distinct_round_starts, 53);
    assert_eq!(metrics.product_metrics.round_start_sessions, 50);
    assert_eq!(metrics.product_metrics.second_round_sessions, 2);
    assert_eq!(metrics.product_metrics.third_round_sessions, 1);
    assert_eq!(metrics.product_metrics.rematch_rate_per_mille, 40);
    assert_eq!(metrics.product_metrics.third_round_rate_per_mille, 20);
    assert_eq!(metrics.product_metrics.client_error_sessions, 1);
    assert_eq!(
        metrics.product_metrics.error_session_rate_per_million,
        Some(19_607)
    );
    assert_eq!(
        metrics.product_metrics.g4_error_status,
        G4ErrorRateStatusDto::Fail
    );
    assert_eq!(metrics.product_metrics.outcomes.get("survived"), Some(&1));
    assert_eq!(metrics.product_metrics.outcomes.get("eliminated"), Some(&1));
    assert_eq!(metrics.product_metrics.outcomes.get("escaped"), Some(&1));
    assert_eq!(metrics.product_metrics.flag_revision_samples, 3);
    assert_eq!(
        metrics.product_metrics.median_flag_revisions_milli,
        Some(2_000)
    );
    assert_eq!(metrics.product_metrics.survivor_samples, 3);
    assert_eq!(metrics.product_metrics.median_survivors_milli, Some(4_000));
    assert_eq!(metrics.product_metrics.placement_spread_rounds, 3);
    assert_eq!(metrics.product_metrics.healthy_placement_spread_rounds, 3);
    assert_eq!(
        metrics.product_metrics.placement_spread_rate_per_mille,
        Some(1_000)
    );
    assert_eq!(metrics.product_metrics.no_elimination_rounds, 1);
    assert_eq!(
        metrics.product_metrics.no_elimination_rate_per_mille,
        Some(333)
    );
    assert_eq!(metrics.product_metrics.early_mass_wipe_rounds, 1);
    assert_eq!(
        metrics.product_metrics.early_mass_wipe_rate_per_mille,
        Some(333)
    );
    assert_eq!(
        metrics.product_metrics.elimination_step_distribution,
        Some(BTreeMap::from([("12".to_owned(), 1)]))
    );
    assert_eq!(metrics.product_metrics.dead_player_eliminations, 1);
    assert_eq!(
        metrics
            .product_metrics
            .dead_player_responses_within_five_seconds,
        1
    );
    assert_eq!(
        metrics.product_metrics.dead_player_response_rate_per_mille,
        Some(1_000)
    );
    assert_eq!(metrics.product_metrics.share_intent_rounds, 1);
    assert_eq!(
        metrics.product_metrics.share_intent_rate_per_mille,
        Some(333)
    );
    assert_eq!(metrics.product_metrics.clip_exported_rounds, 1);
    assert_eq!(
        metrics.product_metrics.clip_export_rate_per_mille,
        Some(333)
    );
    assert_eq!(
        metrics
            .product_metrics
            .outcome_distribution_per_mille
            .get("survived"),
        Some(&333)
    );
    assert_eq!(metrics.experiment_cuts.len(), 1);
    assert_eq!(metrics.experiment_cuts[0].experiment_key, experiment_key);
    assert_eq!(
        metrics.experiment_cuts[0].product_metrics.distinct_sessions,
        51
    );
    assert_eq!(
        metrics.experiment_cuts[0]
            .product_metrics
            .round_start_sessions,
        50
    );
    assert_eq!(
        metrics.experiment_cuts[0]
            .product_metrics
            .client_error_sessions,
        1
    );

    let response = serde_json::to_value(&metrics).expect("metrics JSON");
    assert!(response.get("sessionIds").is_none());
    assert_eq!(response["eliminationStepDistribution"], json!({ "12": 1 }));
    assert_eq!(response["g4ErrorStatus"], "fail");

    let deck_metrics = service
        .telemetry_metrics(
            METRICS_TOKEN,
            TelemetryMetricsQuery {
                window_hours: Some(24),
                deck_id: Some("balanced_tape".to_owned()),
            },
        )
        .await
        .expect("deck metrics");
    assert_eq!(deck_metrics.product_metrics.distinct_sessions, 50);
    assert_eq!(
        deck_metrics.product_metrics.error_session_rate_per_million,
        None
    );
    assert_eq!(
        deck_metrics.product_metrics.g4_error_status,
        G4ErrorRateStatusDto::Insufficient
    );
    assert!(deck_metrics
        .product_metrics
        .g4_note
        .contains("not attributed to a deck"));
}

#[tokio::test]
async fn authenticated_http_rounds_enforce_owner_boundary() {
    let (service, _, _) = alpha_service(invite_config());
    let first = issue(
        &service,
        "HttpOwner",
        false,
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
    )
    .await;
    let second = issue(
        &service,
        "HttpOther",
        false,
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)),
    )
    .await;
    let app = router(service);
    let create = Request::builder()
        .method(Method::POST)
        .uri("/v1/solo-rounds")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {}", first.token))
        .body(Body::from(
            serde_json::to_vec(&CreateRoundRequest {
                deck_id: Some("balanced_tape".to_owned()),
                deck_version: Some(3),
            })
            .expect("create body"),
        ))
        .expect("create request");
    let response = app.clone().oneshot(create).await.expect("create response");
    assert_eq!(response.status(), StatusCode::CREATED);
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("create bytes");
    let created: strikefall_protocol::CreateRoundResponse =
        serde_json::from_slice(&bytes).expect("created JSON");

    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/solo-rounds/{}/result", created.round_id))
                .body(Body::empty())
                .expect("unauthorized request"),
        )
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let forbidden = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/solo-rounds/{}/result", created.round_id))
                .header(header::AUTHORIZATION, format!("Bearer {}", second.token))
                .body(Body::empty())
                .expect("forbidden request"),
        )
        .await
        .expect("forbidden response");
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn public_replay_route_reveals_only_acknowledged_identity_free_bundles() {
    let (service, _, clock) = alpha_service(invite_config());
    let ip = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 90));
    let issued = issue(&service, "ShareOwner", false, ip).await;
    let unresolved = service
        .create_round_for_bearer(
            &issued.token,
            Some(ip),
            CreateRoundRequest {
                deck_id: Some("balanced_tape".to_owned()),
                deck_version: Some(3),
            },
        )
        .await
        .expect("unresolved round");
    let app = router(service.clone());
    for round_id in [&unresolved.round_id] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/public-replays/{round_id}"))
                    .body(Body::empty())
                    .expect("public replay request"),
            )
            .await
            .expect("public replay response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    clock.set(unresolved.placement_deadline_ms);
    service
        .lock_round(&unresolved.round_id)
        .await
        .expect("lock share round");
    clock.advance(
        RANKED_LOCK_PHASE_MS
            + u64::from(unresolved.deck.battle_steps) * u64::from(unresolved.deck.step_ms),
    );
    service
        .resolve_round(&unresolved.round_id)
        .await
        .expect("resolve share round");
    let unacknowledged = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/public-replays/{}", unresolved.round_id))
                .body(Body::empty())
                .expect("unacknowledged request"),
        )
        .await
        .expect("unacknowledged response");
    assert_eq!(unacknowledged.status(), StatusCode::NOT_FOUND);

    let replay = service
        .replay(&unresolved.round_id)
        .await
        .expect("owner replay");
    service
        .acknowledge_replay(
            &unresolved.round_id,
            ReplayVerifiedRequest {
                proof_digest: replay.result.proof_digest,
                verifier_version: "share-route-test/1".to_owned(),
            },
        )
        .await
        .expect("acknowledge share replay");
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/public-replays/{}", unresolved.round_id))
                .body(Body::empty())
                .expect("verified public request"),
        )
        .await
        .expect("verified public response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .expect("public replay body");
    let public: strikefall_round_service::PublicReplayResponseDto =
        serde_json::from_slice(&body).expect("public replay JSON");
    assert_eq!(public.anchor.round_id, unresolved.round_id);
    assert_eq!(public.replay.round_id, unresolved.round_id);
    assert_eq!(public.anchor.commitment, public.replay.commitment);
    assert_eq!(
        public.anchor.server_verifying_key,
        public.replay.server_verifying_key
    );
    let text = String::from_utf8(body.to_vec()).expect("UTF-8 replay");
    assert!(!text.contains("ShareOwner"));
    assert!(!text.contains(&issued.token));
    assert!(!text.contains("sessionId"));
}
