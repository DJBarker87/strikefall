use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ed25519_dalek::SigningKey;
use serde_json::json;
use strikefall_protocol::{
    CreateRoundRequest, ReplayVerifiedRequest, RoundEventKindDto, RoundStatusDto,
    RANKED_LOCK_PHASE_MS,
};
use strikefall_round_service::{
    bearer_token_digest, AlphaRepository, AuthoritativeLeaderboardEntry, Clock, ClosedAlphaConfig,
    CreateSessionRequest, InMemoryRoundRepository, ManualClock, PostgresRepositoryOptions,
    PostgresRoundRepository, RateLimitOutcome, RepositoryError, RoundRecord, RoundRepository,
    RoundService, ServiceConfig, SessionRecord, TelemetryAggregate, TelemetryInsertResult,
    TelemetryRecord,
};
use tokio::sync::RwLock;

const START_MS: u64 = 1_700_000_000_000;
static POSTGRES_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct InstrumentedRoundRepository {
    inner: Arc<InMemoryRoundRepository>,
    load_delay: Duration,
    active_loads: AtomicUsize,
    max_active_loads: AtomicUsize,
    conflict_rounds: RwLock<HashSet<String>>,
    failed_rounds: RwLock<HashSet<String>>,
}

impl InstrumentedRoundRepository {
    fn new(inner: Arc<InMemoryRoundRepository>, load_delay: Duration) -> Self {
        Self {
            inner,
            load_delay,
            active_loads: AtomicUsize::new(0),
            max_active_loads: AtomicUsize::new(0),
            conflict_rounds: RwLock::new(HashSet::new()),
            failed_rounds: RwLock::new(HashSet::new()),
        }
    }

    async fn force_conflict(&self, round_id: &str) {
        self.conflict_rounds
            .write()
            .await
            .insert(round_id.to_owned());
    }

    async fn force_failure(&self, round_id: &str) {
        self.failed_rounds.write().await.insert(round_id.to_owned());
    }

    fn max_active_loads(&self) -> usize {
        self.max_active_loads.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl AlphaRepository for InstrumentedRoundRepository {
    async fn create_session(&self, session: SessionRecord) -> Result<(), RepositoryError> {
        self.inner.create_session(session).await
    }

    async fn load_session_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<SessionRecord>, RepositoryError> {
        self.inner.load_session_by_token_hash(token_hash).await
    }

    async fn save_session(
        &self,
        expected_revision: u64,
        session: SessionRecord,
    ) -> Result<(), RepositoryError> {
        self.inner.save_session(expected_revision, session).await
    }

    async fn consume_rate_limit(
        &self,
        scope_hash: &str,
        action: &str,
        window_started_ms: u64,
        window_ms: u64,
        limit: u32,
        now_ms: u64,
    ) -> Result<RateLimitOutcome, RepositoryError> {
        self.inner
            .consume_rate_limit(
                scope_hash,
                action,
                window_started_ms,
                window_ms,
                limit,
                now_ms,
            )
            .await
    }

    async fn list_leaderboard_entries(
        &self,
        deck_id: &str,
        deck_version: u16,
        cutoff_ms: u64,
        limit: u32,
    ) -> Result<Vec<AuthoritativeLeaderboardEntry>, RepositoryError> {
        self.inner
            .list_leaderboard_entries(deck_id, deck_version, cutoff_ms, limit)
            .await
    }

    async fn insert_telemetry(
        &self,
        events: &[TelemetryRecord],
    ) -> Result<TelemetryInsertResult, RepositoryError> {
        self.inner.insert_telemetry(events).await
    }

    async fn telemetry_aggregate(
        &self,
        start_ms: u64,
        end_ms: u64,
        deck_id: Option<&str>,
    ) -> Result<TelemetryAggregate, RepositoryError> {
        self.inner
            .telemetry_aggregate(start_ms, end_ms, deck_id)
            .await
    }
}

#[async_trait]
impl RoundRepository for InstrumentedRoundRepository {
    async fn create(&self, round: RoundRecord) -> Result<(), RepositoryError> {
        self.inner.create(round).await
    }

    async fn load(&self, round_id: &str) -> Result<Option<RoundRecord>, RepositoryError> {
        let active = self.active_loads.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active_loads.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(self.load_delay).await;
        self.active_loads.fetch_sub(1, Ordering::SeqCst);
        if self.failed_rounds.read().await.contains(round_id) {
            return Err(RepositoryError::Backend(
                "injected lifecycle load failure".to_owned(),
            ));
        }
        self.inner.load(round_id).await
    }

    async fn save(
        &self,
        expected_revision: u64,
        round: RoundRecord,
    ) -> Result<(), RepositoryError> {
        if self.conflict_rounds.read().await.contains(&round.id) {
            return Err(RepositoryError::RevisionConflict);
        }
        self.inner.save(expected_revision, round).await
    }

    async fn health_check(&self) -> Result<(), RepositoryError> {
        self.inner.health_check().await
    }

    async fn validate_active_signing_key(
        &self,
        verifying_key: &str,
    ) -> Result<(), RepositoryError> {
        self.inner.validate_active_signing_key(verifying_key).await
    }

    async fn list_due(&self, now_ms: u64, limit: u32) -> Result<Vec<RoundRecord>, RepositoryError> {
        self.inner.list_due(now_ms, limit).await
    }
}

async fn exercise_repository_contract(repository: Arc<dyn RoundRepository>) -> String {
    repository.health_check().await.expect("repository healthy");
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new(
        repository.clone(),
        clock,
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        SigningKey::from_bytes(&[11_u8; 32]),
    );
    let created = service
        .create_round(CreateRoundRequest {
            deck_id: Some("balanced_tape".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create contract round");
    let original = repository
        .load(&created.round_id)
        .await
        .expect("load original")
        .expect("round exists");
    assert_eq!(original.revision, 0);
    repository
        .validate_active_signing_key(&original.server_verifying_key)
        .await
        .expect("matching publisher key");
    assert!(repository
        .validate_active_signing_key(&"00".repeat(32))
        .await
        .is_err());
    assert_eq!(
        serde_json::to_value(&original).expect("serialize original"),
        serde_json::to_value(
            repository
                .load(&created.round_id)
                .await
                .expect("reload original")
                .expect("round remains")
        )
        .expect("serialize reload")
    );
    assert!(matches!(
        repository.create(original.clone()).await,
        Err(RepositoryError::AlreadyExists)
    ));

    let mut update = original.clone();
    update.last_client_sequence = Some(44);
    repository.save(0, update).await.expect("optimistic save");
    let stored = repository
        .load(&created.round_id)
        .await
        .expect("load updated")
        .expect("updated round exists");
    assert_eq!(stored.revision, 1);
    assert_eq!(stored.last_client_sequence, Some(44));
    assert!(matches!(
        repository.save(0, original).await,
        Err(RepositoryError::RevisionConflict)
    ));

    let first_bot_due = stored
        .next_bot_placement_at_ms
        .expect("placement scheduler has a first bot decision");
    let early = repository
        .list_due(first_bot_due - 1, 100)
        .await
        .expect("query early work");
    assert!(!early.iter().any(|round| round.id == created.round_id));
    let due = repository
        .list_due(first_bot_due, 100)
        .await
        .expect("query due work");
    assert!(due.iter().any(|round| round.id == created.round_id));
    created.round_id
}

#[tokio::test]
async fn in_memory_repository_obeys_contract() {
    exercise_repository_contract(InMemoryRoundRepository::shared()).await;
}

#[allow(clippy::too_many_lines)]
async fn exercise_alpha_repository_contract(
    repository: Arc<dyn RoundRepository>,
) -> (String, String) {
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new_with_alpha_config(
        repository.clone(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        ClosedAlphaConfig::default(),
        SigningKey::from_bytes(&[41_u8; 32]),
    );
    let handle = format!("Repo{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let issued = service
        .issue_session(
            CreateSessionRequest {
                invite_code: None,
                handle: Some(handle),
                telemetry_consent: true,
            },
            Some("198.51.100.77".parse().expect("test IP")),
        )
        .await
        .expect("issue repository session");
    let token_hash = bearer_token_digest(&issued.token).expect("token hash");
    let session = repository
        .load_session_by_token_hash(&token_hash)
        .await
        .expect("load session")
        .expect("session exists");
    assert_ne!(session.token_hash, issued.token);
    let created = service
        .create_round_for_bearer(
            &issued.token,
            Some("198.51.100.77".parse().expect("test IP")),
            CreateRoundRequest {
                deck_id: Some("balanced_tape".to_owned()),
                deck_version: Some(3),
            },
        )
        .await
        .expect("create repository alpha round");
    clock.set(created.placement_deadline_ms);
    service.lock_round(&created.round_id).await.expect("lock");
    clock.advance(
        RANKED_LOCK_PHASE_MS
            + u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms),
    );
    service
        .resolve_round(&created.round_id)
        .await
        .expect("resolve");
    assert!(repository
        .list_leaderboard_entries("balanced_tape", 3, START_MS, 100)
        .await
        .expect("unverified leaderboard query")
        .is_empty());
    let replay = service.replay(&created.round_id).await.expect("replay");
    service
        .acknowledge_replay(
            &created.round_id,
            ReplayVerifiedRequest {
                proof_digest: replay.result.proof_digest,
                verifier_version: "repository-contract/1".to_owned(),
            },
        )
        .await
        .expect("ack replay");
    let entries = repository
        .list_leaderboard_entries("balanced_tape", 3, START_MS, 100)
        .await
        .expect("verified leaderboard query");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].round_id, created.round_id);
    assert_eq!(entries[0].session_id, session.id);
    let telemetry = [
        TelemetryRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            event_name: "round_completed".to_owned(),
            occurred_at_ms: clock.now_ms(),
            received_at_ms: clock.now_ms(),
            deck_id: Some("balanced_tape".to_owned()),
            round_id: Some(created.round_id.clone()),
            properties: json!({
                "deckId": "balanced_tape",
                "durationMs": 60_000,
                "outcome": "eliminated",
                "rank": 9,
                "roundId": created.round_id,
                "_playerFlagRevisions": 2,
                "_upperPlacements": 10,
                "_lowerPlacements": 10,
                "_populatedRiskBands": 7,
                "_survivors": 4,
                "_eliminated": 16,
                "_earlyMassWipe": true,
                "_playerEliminationStep": 12,
            }),
            experiment_assignments: BTreeMap::from([(
                "risk-display:v2".to_owned(),
                "probability".to_owned(),
            )]),
            retention_until_ms: clock.now_ms() + 60_000,
        },
        TelemetryRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            session_id: session.id.clone(),
            event_name: "share_opened".to_owned(),
            occurred_at_ms: clock.now_ms(),
            received_at_ms: clock.now_ms(),
            deck_id: Some("balanced_tape".to_owned()),
            round_id: Some(created.round_id.clone()),
            properties: json!({
                "deckId": "balanced_tape",
                "roundId": created.round_id,
            }),
            experiment_assignments: BTreeMap::from([(
                "risk-display:v2".to_owned(),
                "probability".to_owned(),
            )]),
            retention_until_ms: clock.now_ms() + 60_000,
        },
    ];
    let inserted = repository
        .insert_telemetry(&telemetry)
        .await
        .expect("insert authoritative metric facts");
    assert_eq!(inserted.accepted, 2);
    let aggregate = repository
        .telemetry_aggregate(START_MS, clock.now_ms(), None)
        .await
        .expect("aggregate authoritative metric facts");
    assert_eq!(aggregate.overall.authoritative_rounds, 1);
    assert_eq!(aggregate.overall.flag_revision_histogram.get(&2), Some(&1));
    assert_eq!(aggregate.overall.survivor_histogram.get(&4), Some(&1));
    assert_eq!(aggregate.overall.healthy_placement_spread_rounds, 1);
    assert_eq!(aggregate.overall.early_mass_wipe_rounds, 1);
    assert_eq!(
        aggregate.overall.elimination_step_distribution.get(&12),
        Some(&1)
    );
    assert_eq!(aggregate.overall.share_opened_rounds, 1);
    assert_eq!(
        aggregate
            .experiment_aggregates
            .get("risk-display:v2")
            .and_then(|variants| variants.get("probability"))
            .map(|cut| cut.authoritative_rounds),
        Some(1)
    );
    (created.round_id, session.id)
}

#[tokio::test]
async fn in_memory_alpha_repository_obeys_contract() {
    exercise_alpha_repository_contract(InMemoryRoundRepository::shared()).await;
}

#[tokio::test]
async fn recovery_boundary_reclaims_overdue_rounds() {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let service = RoundService::new(
        repository.clone(),
        clock.clone(),
        ServiceConfig {
            auto_advance: false,
            ..ServiceConfig::default()
        },
        SigningKey::from_bytes(&[12_u8; 32]),
    );
    let created = service
        .create_round(CreateRoundRequest {
            deck_id: Some("balanced_tape".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create recovery round");
    clock.set(created.placement_deadline_ms);
    let lock = service
        .recover_due_rounds(10)
        .await
        .expect("recover placement");
    assert_eq!(lock.discovered, 1);
    assert_eq!(lock.advanced, 1);

    let battle_duration = u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
    clock.advance(RANKED_LOCK_PHASE_MS + battle_duration);
    let resolution = service
        .recover_due_rounds(10)
        .await
        .expect("recover battle");
    assert_eq!(resolution.discovered, 1);
    assert_eq!(resolution.advanced, 1);
    assert!(service.replay(&created.round_id).await.is_ok());
    assert!(repository
        .list_due(clock.now_ms(), 10)
        .await
        .expect("resolved due query")
        .is_empty());
}

#[tokio::test]
async fn recovery_is_bounded_concurrent_deterministic_and_aggregates_outcomes() {
    let inner = InMemoryRoundRepository::shared();
    let repository = Arc::new(InstrumentedRoundRepository::new(
        inner.clone(),
        Duration::from_millis(40),
    ));
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        // Direct embedders are still protected by the hard production ceiling;
        // environment startup rejects this value instead of clamping it.
        recovery_concurrency: 12,
        ..ServiceConfig::default()
    };
    let key = SigningKey::from_bytes(&[61_u8; 32]);
    let service = RoundService::new(
        repository.clone(),
        clock.clone(),
        config.clone(),
        key.clone(),
    );
    let mut created = Vec::new();
    for _ in 0..12 {
        created.push(
            service
                .create_round(CreateRoundRequest {
                    deck_id: Some("balanced_tape".to_owned()),
                    deck_version: Some(3),
                })
                .await
                .expect("create concurrent recovery round"),
        );
    }

    let initial = inner
        .load(&created[0].round_id)
        .await
        .expect("load baseline input")
        .expect("baseline round exists");
    let baseline_repository = InMemoryRoundRepository::shared();
    baseline_repository
        .create(initial)
        .await
        .expect("seed serial baseline");
    clock.set(created[0].placement_deadline_ms);
    let baseline_service =
        RoundService::new(baseline_repository.clone(), clock.clone(), config, key);
    baseline_service
        .advance_placement_round(&created[0].round_id)
        .await
        .expect("advance serial baseline");
    let expected = baseline_repository
        .load(&created[0].round_id)
        .await
        .expect("load serial baseline")
        .expect("serial baseline exists");

    repository.force_conflict(&created[10].round_id).await;
    repository.force_failure(&created[11].round_id).await;
    let report = service
        .recover_due_rounds(100)
        .await
        .expect("recover concurrent burst");
    assert_eq!(report.discovered, 12);
    assert_eq!(report.advanced, 10);
    assert_eq!(report.superseded, 1);
    assert_eq!(report.failed, 1);
    assert_eq!(repository.max_active_loads(), 4);

    let actual = inner
        .load(&created[0].round_id)
        .await
        .expect("load concurrent result")
        .expect("concurrent result exists");
    assert_eq!(
        serde_json::to_vec(&actual).expect("serialize concurrent result"),
        serde_json::to_vec(&expected).expect("serialize serial result")
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn paced_frames_survive_restart_and_reconnect_snapshot() {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        ..ServiceConfig::default()
    };
    let key = SigningKey::from_bytes(&[14_u8; 32]);
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
        .expect("create paced round");
    clock.set(created.placement_deadline_ms);
    service
        .recover_due_rounds(10)
        .await
        .expect("lock paced round");

    let locked = repository
        .load(&created.round_id)
        .await
        .expect("load locked state")
        .expect("paced round exists");
    assert_eq!(locked.status, RoundStatusDto::Battle);
    assert_eq!(locked.battle_next_step, 0);
    assert_eq!(
        locked.battle_started_at_ms,
        Some(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS)
    );
    assert!(!locked
        .events
        .iter()
        .any(|event| matches!(&event.kind, RoundEventKindDto::BattleFrame { .. })));
    assert!(locked.events.iter().any(|event| {
        event.server_time_ms == created.placement_deadline_ms
            && matches!(
                &event.kind,
                RoundEventKindDto::PlacementLocked {
                    battle_starts_at_ms,
                    ..
                } if *battle_starts_at_ms == created.placement_deadline_ms + RANKED_LOCK_PHASE_MS
            )
    }));

    clock.set(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS - 1);
    let early = service
        .recover_due_rounds(10)
        .await
        .expect("lock beat remains sealed");
    assert_eq!(early.discovered, 0);

    clock.set(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS);
    service
        .recover_due_rounds(10)
        .await
        .expect("publish battle frame zero");

    clock.advance(u64::from(created.deck.step_ms) * 3);
    service
        .recover_due_rounds(10)
        .await
        .expect("publish due frames");
    let before_restart = repository
        .load(&created.round_id)
        .await
        .expect("load paced state")
        .expect("paced round exists");
    assert_eq!(before_restart.status, RoundStatusDto::Battle);
    assert_eq!(before_restart.battle_next_step, 4);
    assert_eq!(
        before_restart
            .events
            .iter()
            .filter(|event| matches!(&event.kind, RoundEventKindDto::BattleFrame { .. }))
            .count(),
        4
    );

    let restarted = RoundService::new(repository, clock.clone(), config, key);
    assert_eq!(
        restarted
            .event_snapshot(&created.round_id)
            .await
            .expect("reconnect snapshot"),
        before_restart.events
    );

    let battle_duration = u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms);
    clock.set(created.placement_deadline_ms + RANKED_LOCK_PHASE_MS + battle_duration);
    restarted
        .recover_due_rounds(10)
        .await
        .expect("restart catches up all overdue frames");
    let replay = restarted
        .replay(&created.round_id)
        .await
        .expect("resolved replay after restart");
    assert_eq!(
        replay
            .events
            .iter()
            .filter(|event| matches!(&event.kind, RoundEventKindDto::BattleFrame { .. }))
            .count(),
        usize::from(created.deck.battle_steps) + 1
    );
    replay_inspector::verify_replay_bundle(&replay).expect("recovered replay verifies");
}

#[tokio::test]
async fn active_rounds_reject_a_mismatched_publisher_key() {
    let repository = InMemoryRoundRepository::shared();
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        ..ServiceConfig::default()
    };
    let original = RoundService::new(
        repository.clone(),
        clock.clone(),
        config.clone(),
        SigningKey::from_bytes(&[21_u8; 32]),
    );
    let created = original
        .create_round(CreateRoundRequest {
            deck_id: Some("balanced_tape".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create key fixture");
    let wrong_key = RoundService::new(
        repository.clone(),
        clock.clone(),
        config,
        SigningKey::from_bytes(&[22_u8; 32]),
    );
    assert!(wrong_key.readiness().await.is_err());
    clock.set(created.placement_deadline_ms);
    assert!(wrong_key.lock_round(&created.round_id).await.is_err());
    assert_eq!(
        repository
            .load(&created.round_id)
            .await
            .expect("load key fixture")
            .expect("key fixture exists")
            .revision,
        0
    );
    original
        .lock_round(&created.round_id)
        .await
        .expect("original publisher still advances round");
}

#[tokio::test]
#[ignore = "set STRIKEFALL_TEST_DATABASE_URL and run with --ignored"]
async fn postgres_repository_obeys_contract() {
    let _guard = POSTGRES_TEST_LOCK.lock().await;
    let Ok(database_url) = std::env::var("STRIKEFALL_TEST_DATABASE_URL") else {
        eprintln!("STRIKEFALL_TEST_DATABASE_URL is unset; skipping Postgres contract");
        return;
    };
    let repository = Arc::new(
        PostgresRoundRepository::connect(&database_url, PostgresRepositoryOptions::default())
            .await
            .expect("connect Postgres repository"),
    );
    let round_id = exercise_repository_contract(repository.clone()).await;
    sqlx::query("DELETE FROM strikefall_rounds WHERE id = $1")
        .bind(round_id)
        .execute(repository.pool())
        .await
        .expect("clean contract row");
}

#[tokio::test]
#[ignore = "set STRIKEFALL_TEST_DATABASE_URL and run with --ignored"]
async fn postgres_alpha_repository_obeys_contract() {
    let _guard = POSTGRES_TEST_LOCK.lock().await;
    let Ok(database_url) = std::env::var("STRIKEFALL_TEST_DATABASE_URL") else {
        eprintln!("STRIKEFALL_TEST_DATABASE_URL is unset; skipping Postgres alpha contract");
        return;
    };
    let repository = Arc::new(
        PostgresRoundRepository::connect(&database_url, PostgresRepositoryOptions::default())
            .await
            .expect("connect Postgres repository"),
    );
    let (round_id, session_id) = exercise_alpha_repository_contract(repository.clone()).await;
    sqlx::query("DELETE FROM strikefall_rounds WHERE id = $1")
        .bind(round_id)
        .execute(repository.pool())
        .await
        .expect("clean alpha round");
    sqlx::query("DELETE FROM strikefall_sessions WHERE id = $1")
        .bind(session_id)
        .execute(repository.pool())
        .await
        .expect("clean alpha session");
    sqlx::query(
        "DELETE FROM strikefall_rate_limits WHERE action IN ('session_issue', 'round_create')",
    )
    .execute(repository.pool())
    .await
    .expect("clean alpha rate limits");
}

#[tokio::test]
#[ignore = "set STRIKEFALL_TEST_DATABASE_URL and run with --ignored"]
async fn postgres_restart_preserves_resolved_replay_bytes() {
    let _guard = POSTGRES_TEST_LOCK.lock().await;
    let Ok(database_url) = std::env::var("STRIKEFALL_TEST_DATABASE_URL") else {
        eprintln!("STRIKEFALL_TEST_DATABASE_URL is unset; skipping Postgres restart test");
        return;
    };
    let repository = Arc::new(
        PostgresRoundRepository::connect(&database_url, PostgresRepositoryOptions::default())
            .await
            .expect("connect first Postgres repository"),
    );
    let clock = Arc::new(ManualClock::new(START_MS));
    let config = ServiceConfig {
        auto_advance: false,
        ..ServiceConfig::default()
    };
    let key = SigningKey::from_bytes(&[13_u8; 32]);
    let service = RoundService::new(repository, clock.clone(), config.clone(), key.clone());
    let created = service
        .create_round(CreateRoundRequest {
            deck_id: Some("compression_break".to_owned()),
            deck_version: Some(3),
        })
        .await
        .expect("create persisted replay");
    clock.set(created.placement_deadline_ms);
    service
        .recover_due_rounds(10)
        .await
        .expect("lock persisted round");
    clock.advance(
        RANKED_LOCK_PHASE_MS
            + u64::from(created.deck.battle_steps) * u64::from(created.deck.step_ms),
    );
    service
        .recover_due_rounds(10)
        .await
        .expect("resolve persisted round");
    let before = service
        .replay(&created.round_id)
        .await
        .expect("first replay");
    replay_inspector::verify_replay_bundle(&before).expect("first replay verifies");

    let restarted_repository = Arc::new(
        PostgresRoundRepository::connect(&database_url, PostgresRepositoryOptions::default())
            .await
            .expect("connect restarted Postgres repository"),
    );
    let restarted = RoundService::new(restarted_repository.clone(), clock, config, key);
    let after = restarted
        .replay(&created.round_id)
        .await
        .expect("replay after restart");
    assert_eq!(
        serde_json::to_vec(&before).expect("serialize before"),
        serde_json::to_vec(&after).expect("serialize after")
    );
    replay_inspector::verify_replay_bundle(&after).expect("persisted replay verifies");
    sqlx::query("DELETE FROM strikefall_rounds WHERE id = $1")
        .bind(created.round_id)
        .execute(restarted_repository.pool())
        .await
        .expect("clean replay row");
}
