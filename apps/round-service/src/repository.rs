use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use sqlx::types::Json;
use sqlx::{PgPool, Row};
use strikefall_protocol::RoundStatusDto;
use thiserror::Error;
use tokio::sync::RwLock;

use crate::alpha::{
    AuthoritativeLeaderboardEntry, RateLimitOutcome, SessionRecord, TelemetryAggregate,
    TelemetryInsertResult, TelemetryRecord,
};
use crate::model::RoundRecord;

#[derive(Debug, Error)]
pub enum RepositoryError {
    #[error("round already exists")]
    AlreadyExists,
    #[error("round revision conflict")]
    RevisionConflict,
    #[error("repository backend unavailable: {0}")]
    Backend(String),
}

impl From<sqlx::Error> for RepositoryError {
    fn from(value: sqlx::Error) -> Self {
        Self::Backend(value.to_string())
    }
}

impl From<sqlx::migrate::MigrateError> for RepositoryError {
    fn from(value: sqlx::migrate::MigrateError) -> Self {
        Self::Backend(value.to_string())
    }
}

/// Durable boundary used by the round engine.
///
/// `save` must atomically persist the complete record only when the stored
/// revision equals `expected_revision`, then expose `expected_revision + 1` on
/// the next load. `list_due` is an at-least-once scheduler snapshot: callers may
/// process independent rows concurrently, and returning the same row to
/// multiple workers or service instances is safe because only one optimistic
/// save wins.
#[async_trait]
pub trait AlphaRepository: Send + Sync {
    async fn create_session(&self, session: SessionRecord) -> Result<(), RepositoryError>;

    async fn load_session_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<SessionRecord>, RepositoryError>;

    async fn save_session(
        &self,
        expected_revision: u64,
        session: SessionRecord,
    ) -> Result<(), RepositoryError>;

    async fn consume_rate_limit(
        &self,
        scope_hash: &str,
        action: &str,
        window_started_ms: u64,
        window_ms: u64,
        limit: u32,
        now_ms: u64,
    ) -> Result<RateLimitOutcome, RepositoryError>;

    async fn list_leaderboard_entries(
        &self,
        deck_id: &str,
        deck_version: u16,
        cutoff_ms: u64,
        limit: u32,
    ) -> Result<Vec<AuthoritativeLeaderboardEntry>, RepositoryError>;

    async fn insert_telemetry(
        &self,
        events: &[TelemetryRecord],
    ) -> Result<TelemetryInsertResult, RepositoryError>;

    async fn telemetry_aggregate(
        &self,
        start_ms: u64,
        end_ms: u64,
        deck_id: Option<&str>,
    ) -> Result<TelemetryAggregate, RepositoryError>;
}

#[async_trait]
pub trait RoundRepository: AlphaRepository + Send + Sync {
    async fn create(&self, round: RoundRecord) -> Result<(), RepositoryError>;

    async fn load(&self, round_id: &str) -> Result<Option<RoundRecord>, RepositoryError>;

    async fn save(&self, expected_revision: u64, round: RoundRecord)
        -> Result<(), RepositoryError>;

    async fn health_check(&self) -> Result<(), RepositoryError>;

    /// Refuses a heterogeneous deployment from signing an active round with a
    /// different publisher key than the one committed at creation.
    async fn validate_active_signing_key(&self, verifying_key: &str)
        -> Result<(), RepositoryError>;

    async fn list_due(&self, now_ms: u64, limit: u32) -> Result<Vec<RoundRecord>, RepositoryError>;
}

#[derive(Default)]
pub(crate) struct MemoryAlphaState {
    pub(crate) sessions: HashMap<String, SessionRecord>,
    pub(crate) token_index: HashMap<String, String>,
    pub(crate) rate_limits: HashMap<(String, String, u64), u32>,
    pub(crate) leaderboard: HashMap<String, AuthoritativeLeaderboardEntry>,
    pub(crate) telemetry: HashMap<String, TelemetryRecord>,
}

#[derive(Default)]
pub struct InMemoryRoundRepository {
    pub(crate) rounds: RwLock<HashMap<String, RoundRecord>>,
    pub(crate) alpha: RwLock<MemoryAlphaState>,
}

impl InMemoryRoundRepository {
    #[must_use]
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[async_trait]
impl RoundRepository for InMemoryRoundRepository {
    async fn create(&self, round: RoundRecord) -> Result<(), RepositoryError> {
        let mut rounds = self.rounds.write().await;
        if rounds.contains_key(&round.id) {
            return Err(RepositoryError::AlreadyExists);
        }
        rounds.insert(round.id.clone(), round);
        Ok(())
    }

    async fn load(&self, round_id: &str) -> Result<Option<RoundRecord>, RepositoryError> {
        Ok(self.rounds.read().await.get(round_id).cloned())
    }

    async fn save(
        &self,
        expected_revision: u64,
        mut round: RoundRecord,
    ) -> Result<(), RepositoryError> {
        let mut rounds = self.rounds.write().await;
        let mut alpha = self.alpha.write().await;
        let current = rounds
            .get(&round.id)
            .ok_or_else(|| RepositoryError::Backend("round disappeared during save".to_owned()))?;
        if current.revision != expected_revision {
            return Err(RepositoryError::RevisionConflict);
        }
        round.revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Backend("revision overflow".to_owned()))?;
        let leaderboard_entry = crate::alpha_repository::leaderboard_entry_from_round(&round);
        rounds.insert(round.id.clone(), round);
        if let Some(entry) = leaderboard_entry {
            if alpha.sessions.contains_key(&entry.session_id) {
                alpha
                    .leaderboard
                    .entry(entry.round_id.clone())
                    .or_insert(entry);
            }
        }
        Ok(())
    }

    async fn health_check(&self) -> Result<(), RepositoryError> {
        Ok(())
    }

    async fn validate_active_signing_key(
        &self,
        verifying_key: &str,
    ) -> Result<(), RepositoryError> {
        if let Some(round) = self.rounds.read().await.values().find(|round| {
            round.status != RoundStatusDto::Resolved && round.server_verifying_key != verifying_key
        }) {
            return Err(RepositoryError::Backend(format!(
                "active round '{}' was created with a different signing key",
                round.id
            )));
        }
        Ok(())
    }

    async fn list_due(&self, now_ms: u64, limit: u32) -> Result<Vec<RoundRecord>, RepositoryError> {
        let now_ms = millis_to_i64(now_ms, "scheduler now_ms")?;
        let mut due: Vec<_> = self
            .rounds
            .read()
            .await
            .values()
            .filter_map(|round| {
                let next_action_at_ms = lifecycle_metadata(round).ok()?.next_action_at_ms?;
                (next_action_at_ms <= now_ms).then(|| (next_action_at_ms, round.clone()))
            })
            .collect();
        due.sort_unstable_by_key(|(next_action_at_ms, round)| {
            (*next_action_at_ms, round.id.clone())
        });
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        Ok(due
            .into_iter()
            .take(limit)
            .map(|(_, round)| round)
            .collect())
    }
}

#[derive(Debug, Clone)]
pub struct PostgresRepositoryOptions {
    pub max_connections: u32,
    pub connect_timeout: Duration,
    pub run_migrations: bool,
    pub retention_days: u32,
}

impl Default for PostgresRepositoryOptions {
    fn default() -> Self {
        Self {
            max_connections: 10,
            connect_timeout: Duration::from_secs(10),
            run_migrations: true,
            retention_days: 30,
        }
    }
}

/// SQLx/Postgres repository for deployable closed-alpha rounds.
///
/// Each update stores the authoritative record and its scheduling metadata in
/// one SQL statement. The JSON document is intentionally the same shape used
/// by the memory repository so persistence cannot alter commitment or replay
/// bytes.
#[derive(Clone)]
pub struct PostgresRoundRepository {
    pub(crate) pool: PgPool,
    retention_days: u32,
}

impl PostgresRoundRepository {
    pub async fn connect(
        database_url: &str,
        options: PostgresRepositoryOptions,
    ) -> Result<Self, RepositoryError> {
        if database_url.trim().is_empty() {
            return Err(RepositoryError::Backend(
                "DATABASE_URL cannot be empty".to_owned(),
            ));
        }
        if options.max_connections == 0 {
            return Err(RepositoryError::Backend(
                "database max connections must be greater than zero".to_owned(),
            ));
        }
        if options.connect_timeout.is_zero() {
            return Err(RepositoryError::Backend(
                "database connect timeout must be greater than zero".to_owned(),
            ));
        }
        if options.retention_days == 0 {
            return Err(RepositoryError::Backend(
                "round retention must be at least one day".to_owned(),
            ));
        }
        let pool = PgPoolOptions::new()
            .max_connections(options.max_connections)
            .acquire_timeout(options.connect_timeout)
            .connect(database_url)
            .await?;
        if options.run_migrations {
            sqlx::migrate!("../../migrations").run(&pool).await?;
        }
        let repository = Self {
            pool,
            retention_days: options.retention_days,
        };
        repository.health_check().await?;
        Ok(repository)
    }

    #[must_use]
    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }
}

#[async_trait]
impl RoundRepository for PostgresRoundRepository {
    async fn create(&self, round: RoundRecord) -> Result<(), RepositoryError> {
        let metadata = lifecycle_metadata(&round)?;
        let round_id = round.id.clone();
        let revision = revision_to_i64(round.revision)?;
        let created_at_ms = millis_to_i64(round.created_at_ms, "created_at_ms")?;
        let retention_days = i32::try_from(self.retention_days).map_err(|_| {
            RepositoryError::Backend("round retention does not fit Postgres integer".to_owned())
        })?;
        let result = sqlx::query(
            r"
            INSERT INTO strikefall_rounds (
                id,
                revision,
                status,
                record,
                created_at_ms,
                next_action_at_ms,
                resolved_at_ms,
                retention_until
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                to_timestamp($5::double precision / 1000.0)
                    + ($8 * INTERVAL '1 day')
            )
            ",
        )
        .bind(&round_id)
        .bind(revision)
        .bind(metadata.status)
        .bind(Json(round))
        .bind(created_at_ms)
        .bind(metadata.next_action_at_ms)
        .bind(metadata.resolved_at_ms)
        .bind(retention_days)
        .execute(&self.pool)
        .await;
        match result {
            Ok(_) => Ok(()),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                Err(RepositoryError::AlreadyExists)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn load(&self, round_id: &str) -> Result<Option<RoundRecord>, RepositoryError> {
        let row = sqlx::query(
            "SELECT revision, record FROM strikefall_rounds WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(round_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let stored_revision: i64 = row.try_get("revision")?;
        let Json(round): Json<RoundRecord> = row.try_get("record")?;
        let document_revision = revision_to_i64(round.revision)?;
        if stored_revision != document_revision {
            return Err(RepositoryError::Backend(format!(
                "round '{round_id}' has mismatched column/document revisions"
            )));
        }
        Ok(Some(round))
    }

    async fn save(
        &self,
        expected_revision: u64,
        mut round: RoundRecord,
    ) -> Result<(), RepositoryError> {
        let new_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Backend("revision overflow".to_owned()))?;
        round.revision = new_revision;
        let round_id = round.id.clone();
        let metadata = lifecycle_metadata(&round)?;
        let expected_revision = revision_to_i64(expected_revision)?;
        let new_revision = revision_to_i64(new_revision)?;
        let leaderboard_entry = crate::alpha_repository::leaderboard_entry_from_round(&round);
        let mut transaction = self.pool.begin().await?;
        let result = sqlx::query(
            r"
            UPDATE strikefall_rounds
            SET revision = $3,
                status = $4,
                record = $5,
                next_action_at_ms = $6,
                resolved_at_ms = $7,
                updated_at = NOW()
            WHERE id = $1
              AND revision = $2
              AND deleted_at IS NULL
            ",
        )
        .bind(&round_id)
        .bind(expected_revision)
        .bind(new_revision)
        .bind(metadata.status)
        .bind(Json(round))
        .bind(metadata.next_action_at_ms)
        .bind(metadata.resolved_at_ms)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 1 {
            if let Some(entry) = leaderboard_entry {
                crate::alpha_repository::insert_postgres_leaderboard_entry(
                    &mut transaction,
                    &entry,
                )
                .await?;
            }
            transaction.commit().await?;
            return Ok(());
        }
        transaction.rollback().await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM strikefall_rounds WHERE id = $1 AND deleted_at IS NULL)",
        )
        .bind(&round_id)
        .fetch_one(&self.pool)
        .await?;
        if exists {
            Err(RepositoryError::RevisionConflict)
        } else {
            Err(RepositoryError::Backend(
                "round disappeared during save".to_owned(),
            ))
        }
    }

    async fn health_check(&self) -> Result<(), RepositoryError> {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&self.pool)
            .await?;
        Ok(())
    }

    async fn validate_active_signing_key(
        &self,
        verifying_key: &str,
    ) -> Result<(), RepositoryError> {
        let mismatch: Option<String> = sqlx::query_scalar(
            r"
            SELECT id
            FROM strikefall_rounds
            WHERE deleted_at IS NULL
              AND status IN ('placement', 'battle')
              AND record ->> 'server_verifying_key' IS DISTINCT FROM $1
            ORDER BY created_at_ms ASC, id ASC
            LIMIT 1
            ",
        )
        .bind(verifying_key)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(round_id) = mismatch {
            return Err(RepositoryError::Backend(format!(
                "active round '{round_id}' was created with a different signing key"
            )));
        }
        Ok(())
    }

    async fn list_due(&self, now_ms: u64, limit: u32) -> Result<Vec<RoundRecord>, RepositoryError> {
        let now_ms = millis_to_i64(now_ms, "scheduler now_ms")?;
        let limit = i64::from(limit);
        let rows = sqlx::query(
            r"
            SELECT revision, record
            FROM strikefall_rounds
            WHERE deleted_at IS NULL
              AND next_action_at_ms IS NOT NULL
              AND next_action_at_ms <= $1
              AND status IN ('placement', 'battle')
            ORDER BY next_action_at_ms ASC, id ASC
            LIMIT $2
            ",
        )
        .bind(now_ms)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let stored_revision: i64 = row.try_get("revision")?;
                let Json(round): Json<RoundRecord> = row.try_get("record")?;
                if revision_to_i64(round.revision)? != stored_revision {
                    return Err(RepositoryError::Backend(format!(
                        "round '{}' has mismatched column/document revisions",
                        round.id
                    )));
                }
                Ok(round)
            })
            .collect()
    }
}

struct LifecycleMetadata {
    status: &'static str,
    next_action_at_ms: Option<i64>,
    resolved_at_ms: Option<i64>,
}

fn lifecycle_metadata(round: &RoundRecord) -> Result<LifecycleMetadata, RepositoryError> {
    let (status, next_action_at_ms, resolved_at_ms) = match round.status {
        RoundStatusDto::Placement => (
            "placement",
            Some(millis_to_i64(
                round
                    .next_bot_placement_at_ms
                    .unwrap_or(round.placement_deadline_ms)
                    .min(round.placement_deadline_ms),
                "placement next action",
            )?),
            None,
        ),
        RoundStatusDto::Battle => {
            let battle_started_at_ms = round.battle_started_at_ms.ok_or_else(|| {
                RepositoryError::Backend("battle round has no start time".to_owned())
            })?;
            let deck = strikefall_core::deck_by_ref(&round.deck_id, round.deck_version)
                .ok_or_else(|| {
                    RepositoryError::Backend(format!(
                        "stored deck '{}' is unavailable",
                        round.deck_id
                    ))
                })?;
            let duration_ms = u64::from(round.battle_next_step)
                .checked_mul(u64::from(deck.step_ms))
                .ok_or_else(|| {
                    RepositoryError::Backend("battle frame deadline overflow".to_owned())
                })?;
            let due = battle_started_at_ms
                .checked_add(duration_ms)
                .ok_or_else(|| {
                    RepositoryError::Backend("battle lifecycle deadline overflow".to_owned())
                })?;
            ("battle", Some(millis_to_i64(due, "battle deadline")?), None)
        }
        RoundStatusDto::Resolved => {
            let resolved_at_ms = round
                .events
                .iter()
                .find_map(|event| {
                    matches!(
                        &event.kind,
                        strikefall_protocol::RoundEventKindDto::RoundEnded { .. }
                    )
                    .then_some(event.server_time_ms)
                })
                .unwrap_or(round.created_at_ms);
            (
                "resolved",
                None,
                Some(millis_to_i64(resolved_at_ms, "resolved_at_ms")?),
            )
        }
    };
    Ok(LifecycleMetadata {
        status,
        next_action_at_ms,
        resolved_at_ms,
    })
}

fn revision_to_i64(value: u64) -> Result<i64, RepositoryError> {
    i64::try_from(value)
        .map_err(|_| RepositoryError::Backend("revision exceeds Postgres bigint".to_owned()))
}

fn millis_to_i64(value: u64, field: &str) -> Result<i64, RepositoryError> {
    i64::try_from(value)
        .map_err(|_| RepositoryError::Backend(format!("{field} exceeds Postgres bigint")))
}
