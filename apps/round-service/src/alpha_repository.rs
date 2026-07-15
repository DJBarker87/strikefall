use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;
use sqlx::postgres::PgRow;
use sqlx::types::Json;
use sqlx::{Postgres, Row, Transaction};
use strikefall_protocol::{ContenderOutcomeDto, RoundEventKindDto, RoundStatusDto};

use crate::alpha::{
    AuthoritativeLeaderboardEntry, RateLimitOutcome, SessionRecord, TelemetryAggregate,
    TelemetryAggregateSlice, TelemetryInsertResult, TelemetryRecord,
};
use crate::model::RoundRecord;
use crate::repository::{
    AlphaRepository, InMemoryRoundRepository, PostgresRoundRepository, RepositoryError,
};

fn empty_outcome_counts() -> BTreeMap<String, u64> {
    ["survived", "eliminated", "escaped"]
        .into_iter()
        .map(|outcome| (outcome.to_owned(), 0))
        .collect()
}

fn empty_telemetry_aggregate_slice() -> TelemetryAggregateSlice {
    TelemetryAggregateSlice {
        player_outcome_counts: empty_outcome_counts(),
        ..TelemetryAggregateSlice::default()
    }
}

fn nonnegative_count(row: &PgRow, column: &str) -> Result<u64, RepositoryError> {
    u64::try_from(row.try_get::<i64, _>(column)?)
        .map_err(|_| RepositoryError::Backend(format!("negative telemetry {column}")))
}

fn bounded_metric(row: &PgRow, column: &str) -> Result<u16, RepositoryError> {
    let value = row.try_get::<i64, _>(column)?;
    u16::try_from(value)
        .map_err(|_| RepositoryError::Backend(format!("invalid telemetry {column}")))
}

fn apply_authoritative_fact_row(
    aggregate: &mut TelemetryAggregateSlice,
    row: &PgRow,
) -> Result<(), RepositoryError> {
    let count = nonnegative_count(row, "count")?;
    let revisions = bounded_metric(row, "player_flag_revisions")?;
    let survivors = bounded_metric(row, "survivors")?;
    let upper = bounded_metric(row, "upper_placements")?;
    let lower = bounded_metric(row, "lower_placements")?;
    let bands = bounded_metric(row, "populated_risk_bands")?;
    let eliminated = bounded_metric(row, "eliminated")?;
    let early_mass_wipe = row.try_get::<bool, _>("early_mass_wipe")?;
    let step = row
        .try_get::<Option<i64>, _>("player_elimination_step")?
        .map(|value| {
            u16::try_from(value)
                .map_err(|_| RepositoryError::Backend("invalid player elimination step".to_owned()))
        })
        .transpose()?;
    aggregate.authoritative_rounds = aggregate.authoritative_rounds.saturating_add(count);
    let revision_count = aggregate
        .flag_revision_histogram
        .entry(revisions)
        .or_insert(0);
    *revision_count = revision_count.saturating_add(count);
    let survivor_count = aggregate.survivor_histogram.entry(survivors).or_insert(0);
    *survivor_count = survivor_count.saturating_add(count);
    if upper > 0 && lower > 0 && bands >= 6 {
        aggregate.healthy_placement_spread_rounds = aggregate
            .healthy_placement_spread_rounds
            .saturating_add(count);
    }
    if eliminated == 0 {
        aggregate.no_elimination_rounds = aggregate.no_elimination_rounds.saturating_add(count);
    }
    if early_mass_wipe {
        aggregate.early_mass_wipe_rounds = aggregate.early_mass_wipe_rounds.saturating_add(count);
    }
    if let Some(step) = step {
        aggregate.dead_player_eliminations =
            aggregate.dead_player_eliminations.saturating_add(count);
        let step_count = aggregate
            .elimination_step_distribution
            .entry(step)
            .or_insert(0);
        *step_count = step_count.saturating_add(count);
    }
    Ok(())
}

fn apply_action_row(
    aggregate: &mut TelemetryAggregateSlice,
    row: &PgRow,
) -> Result<(), RepositoryError> {
    let count = nonnegative_count(row, "count")?;
    match row.try_get::<String, _>("event_name")?.as_str() {
        "dead_player_response" if row.try_get::<bool, _>("within_five_seconds")? => {
            aggregate.dead_player_responses_within_five_seconds = aggregate
                .dead_player_responses_within_five_seconds
                .saturating_add(count);
        }
        "share_opened" => {
            aggregate.share_opened_rounds = aggregate.share_opened_rounds.saturating_add(count);
        }
        "clip_exported" => {
            aggregate.clip_exported_rounds = aggregate.clip_exported_rounds.saturating_add(count);
        }
        _ => {}
    }
    Ok(())
}

fn bounded_len(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy)]
struct AuthoritativeRoundFact {
    player_flag_revisions: u16,
    upper_placements: u16,
    lower_placements: u16,
    populated_risk_bands: u16,
    survivors: u16,
    eliminated: u16,
    early_mass_wipe: bool,
    player_elimination_step: Option<u16>,
}

fn bounded_u16_property(event: &TelemetryRecord, key: &str) -> Option<u16> {
    event
        .properties
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
}

fn authoritative_round_fact(event: &TelemetryRecord) -> Option<AuthoritativeRoundFact> {
    Some(AuthoritativeRoundFact {
        player_flag_revisions: bounded_u16_property(event, "_playerFlagRevisions")?,
        upper_placements: bounded_u16_property(event, "_upperPlacements")?,
        lower_placements: bounded_u16_property(event, "_lowerPlacements")?,
        populated_risk_bands: bounded_u16_property(event, "_populatedRiskBands")?,
        survivors: bounded_u16_property(event, "_survivors")?,
        eliminated: bounded_u16_property(event, "_eliminated")?,
        early_mass_wipe: event
            .properties
            .get("_earlyMassWipe")
            .and_then(serde_json::Value::as_bool)?,
        player_elimination_step: event
            .properties
            .get("_playerEliminationStep")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u16::try_from(value).ok()),
    })
}

#[allow(clippy::too_many_lines)]
fn aggregate_telemetry_records<'a>(
    events: impl IntoIterator<Item = &'a TelemetryRecord>,
) -> TelemetryAggregateSlice {
    let mut counts = BTreeMap::new();
    let mut sessions = BTreeSet::new();
    let mut round_starts_by_session = BTreeMap::<String, BTreeSet<String>>::new();
    let mut outcomes_by_round = BTreeMap::<(String, String), String>::new();
    let mut authoritative_facts = BTreeMap::<(String, String), AuthoritativeRoundFact>::new();
    let mut client_error_sessions = BTreeSet::new();
    let mut dead_player_responses = BTreeSet::new();
    let mut share_opened_rounds = BTreeSet::new();
    let mut clip_exported_rounds = BTreeSet::new();
    for event in events {
        sessions.insert(event.session_id.clone());
        let count = counts.entry(event.event_name.clone()).or_insert(0_u64);
        *count = count.saturating_add(1);
        match event.event_name.as_str() {
            "round_started" => {
                if let Some(round_id) = &event.round_id {
                    round_starts_by_session
                        .entry(event.session_id.clone())
                        .or_default()
                        .insert(round_id.clone());
                }
            }
            "round_completed" => {
                if let (Some(round_id), Some(outcome)) = (
                    event.round_id.as_ref(),
                    event
                        .properties
                        .get("outcome")
                        .and_then(serde_json::Value::as_str),
                ) {
                    outcomes_by_round.insert(
                        (event.session_id.clone(), round_id.clone()),
                        outcome.to_owned(),
                    );
                    if let Some(fact) = authoritative_round_fact(event) {
                        authoritative_facts
                            .insert((event.session_id.clone(), round_id.clone()), fact);
                    }
                }
            }
            "client_error" => {
                client_error_sessions.insert(event.session_id.clone());
            }
            "dead_player_response" => {
                if event
                    .properties
                    .get("_withinFiveSeconds")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    if let Some(round_id) = &event.round_id {
                        dead_player_responses.insert((event.session_id.clone(), round_id.clone()));
                    }
                }
            }
            "share_opened" => {
                if let Some(round_id) = &event.round_id {
                    share_opened_rounds.insert((event.session_id.clone(), round_id.clone()));
                }
            }
            "clip_exported" => {
                if let Some(round_id) = &event.round_id {
                    clip_exported_rounds.insert((event.session_id.clone(), round_id.clone()));
                }
            }
            _ => {}
        }
    }
    let mut player_outcome_counts = empty_outcome_counts();
    for outcome in outcomes_by_round.values() {
        if let Some(count) = player_outcome_counts.get_mut(outcome) {
            *count = count.saturating_add(1);
        }
    }
    let sessions_with_at_least_two_round_starts = round_starts_by_session
        .values()
        .filter(|rounds| rounds.len() >= 2)
        .count();
    let sessions_with_at_least_three_round_starts = round_starts_by_session
        .values()
        .filter(|rounds| rounds.len() >= 3)
        .count();
    let mut flag_revision_histogram = BTreeMap::new();
    let mut survivor_histogram = BTreeMap::new();
    let mut healthy_placement_spread_rounds = 0_u64;
    let mut no_elimination_rounds = 0_u64;
    let mut early_mass_wipe_rounds = 0_u64;
    let mut elimination_step_distribution = BTreeMap::new();
    let mut dead_player_eliminations = 0_u64;
    for fact in authoritative_facts.values() {
        let revisions = flag_revision_histogram
            .entry(fact.player_flag_revisions)
            .or_insert(0_u64);
        *revisions = revisions.saturating_add(1);
        let survivors = survivor_histogram.entry(fact.survivors).or_insert(0_u64);
        *survivors = survivors.saturating_add(1);
        if fact.upper_placements > 0 && fact.lower_placements > 0 && fact.populated_risk_bands >= 6
        {
            healthy_placement_spread_rounds = healthy_placement_spread_rounds.saturating_add(1);
        }
        if fact.eliminated == 0 {
            no_elimination_rounds = no_elimination_rounds.saturating_add(1);
        }
        if fact.early_mass_wipe {
            early_mass_wipe_rounds = early_mass_wipe_rounds.saturating_add(1);
        }
        if let Some(step) = fact.player_elimination_step {
            dead_player_eliminations = dead_player_eliminations.saturating_add(1);
            let count = elimination_step_distribution.entry(step).or_insert(0_u64);
            *count = count.saturating_add(1);
        }
    }
    TelemetryAggregateSlice {
        counts,
        distinct_sessions: bounded_len(sessions.len()),
        distinct_round_starts: round_starts_by_session
            .values()
            .map(BTreeSet::len)
            .map(bounded_len)
            .fold(0_u64, u64::saturating_add),
        round_start_sessions: bounded_len(round_starts_by_session.len()),
        sessions_with_at_least_two_round_starts: bounded_len(
            sessions_with_at_least_two_round_starts,
        ),
        sessions_with_at_least_three_round_starts: bounded_len(
            sessions_with_at_least_three_round_starts,
        ),
        player_outcome_counts,
        client_error_sessions: bounded_len(client_error_sessions.len()),
        flag_revision_histogram,
        survivor_histogram,
        authoritative_rounds: bounded_len(authoritative_facts.len()),
        healthy_placement_spread_rounds,
        no_elimination_rounds,
        early_mass_wipe_rounds,
        elimination_step_distribution,
        dead_player_eliminations,
        dead_player_responses_within_five_seconds: bounded_len(
            dead_player_responses
                .iter()
                .filter(|key| {
                    authoritative_facts
                        .get(*key)
                        .is_some_and(|fact| fact.player_elimination_step.is_some())
                })
                .count(),
        ),
        share_opened_rounds: bounded_len(
            share_opened_rounds
                .iter()
                .filter(|key| authoritative_facts.contains_key(*key))
                .count(),
        ),
        clip_exported_rounds: bounded_len(
            clip_exported_rounds
                .iter()
                .filter(|key| authoritative_facts.contains_key(*key))
                .count(),
        ),
    }
}

#[async_trait]
impl AlphaRepository for InMemoryRoundRepository {
    async fn create_session(&self, session: SessionRecord) -> Result<(), RepositoryError> {
        let mut state = self.alpha.write().await;
        if state.sessions.contains_key(&session.id)
            || state.token_index.contains_key(&session.token_hash)
            || state
                .sessions
                .values()
                .any(|stored| stored.handle_key == session.handle_key)
        {
            return Err(RepositoryError::AlreadyExists);
        }
        state
            .token_index
            .insert(session.token_hash.clone(), session.id.clone());
        state.sessions.insert(session.id.clone(), session);
        Ok(())
    }

    async fn load_session_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<SessionRecord>, RepositoryError> {
        let state = self.alpha.read().await;
        Ok(state
            .token_index
            .get(token_hash)
            .and_then(|id| state.sessions.get(id))
            .cloned())
    }

    async fn save_session(
        &self,
        expected_revision: u64,
        mut session: SessionRecord,
    ) -> Result<(), RepositoryError> {
        let mut state = self.alpha.write().await;
        let current = state
            .sessions
            .get(&session.id)
            .cloned()
            .ok_or_else(|| RepositoryError::Backend("session disappeared".to_owned()))?;
        if current.revision != expected_revision {
            return Err(RepositoryError::RevisionConflict);
        }
        if state.sessions.values().any(|stored| {
            stored.id != session.id
                && (stored.handle_key == session.handle_key
                    || stored.token_hash == session.token_hash)
        }) {
            return Err(RepositoryError::AlreadyExists);
        }
        session.revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Backend("session revision overflow".to_owned()))?;
        state.token_index.remove(&current.token_hash);
        state
            .token_index
            .insert(session.token_hash.clone(), session.id.clone());
        state.sessions.insert(session.id.clone(), session);
        Ok(())
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
        let mut state = self.alpha.write().await;
        let key = (scope_hash.to_owned(), action.to_owned(), window_started_ms);
        let count = state.rate_limits.entry(key).or_insert(0);
        *count = count.saturating_add(1).min(limit.saturating_add(1));
        Ok(RateLimitOutcome {
            allowed: *count <= limit,
            retry_after_ms: window_started_ms
                .saturating_add(window_ms)
                .saturating_sub(now_ms)
                .max(1),
        })
    }

    async fn list_leaderboard_entries(
        &self,
        deck_id: &str,
        deck_version: u16,
        cutoff_ms: u64,
        limit: u32,
    ) -> Result<Vec<AuthoritativeLeaderboardEntry>, RepositoryError> {
        let state = self.alpha.read().await;
        let mut entries: Vec<_> = state
            .leaderboard
            .values()
            .filter(|entry| {
                entry.deck_id == deck_id
                    && entry.deck_version == deck_version
                    && entry.resolved_at_ms >= cutoff_ms
            })
            .filter_map(|entry| {
                let mut entry = entry.clone();
                entry.handle = state.sessions.get(&entry.session_id)?.handle.clone();
                Some(entry)
            })
            .collect();
        entries.sort_by(|left, right| {
            let left_score = left.score.parse::<u128>().unwrap_or(0);
            let right_score = right.score.parse::<u128>().unwrap_or(0);
            right_score
                .cmp(&left_score)
                .then_with(|| left.resolved_at_ms.cmp(&right.resolved_at_ms))
                .then_with(|| left.round_id.cmp(&right.round_id))
        });
        entries.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(entries)
    }

    async fn insert_telemetry(
        &self,
        events: &[TelemetryRecord],
    ) -> Result<TelemetryInsertResult, RepositoryError> {
        let mut state = self.alpha.write().await;
        let mut result = TelemetryInsertResult::default();
        for event in events {
            let semantic_duplicate = event.round_id.as_ref().is_some_and(|round_id| {
                state.telemetry.values().any(|stored| {
                    stored.session_id == event.session_id
                        && stored.round_id.as_ref() == Some(round_id)
                        && stored.event_name == event.event_name
                })
            });
            if state.telemetry.contains_key(&event.event_id) || semantic_duplicate {
                result.duplicates = result.duplicates.saturating_add(1);
            } else {
                state
                    .telemetry
                    .insert(event.event_id.clone(), event.clone());
                result.accepted = result.accepted.saturating_add(1);
            }
        }
        Ok(result)
    }

    async fn telemetry_aggregate(
        &self,
        start_ms: u64,
        end_ms: u64,
        deck_id: Option<&str>,
    ) -> Result<TelemetryAggregate, RepositoryError> {
        let state = self.alpha.read().await;
        let selected = state
            .telemetry
            .values()
            .filter(|event| {
                event.occurred_at_ms >= start_ms
                    && event.occurred_at_ms <= end_ms
                    && deck_id.is_none_or(|deck| event.deck_id.as_deref() == Some(deck))
            })
            .collect::<Vec<_>>();
        let overall = aggregate_telemetry_records(selected.iter().copied());
        let mut experiment_events = BTreeMap::new();
        for event in &selected {
            for (experiment_key, variant) in &event.experiment_assignments {
                experiment_events
                    .entry(experiment_key.clone())
                    .or_insert_with(BTreeMap::new)
                    .entry(variant.clone())
                    .or_insert_with(Vec::new)
                    .push(*event);
            }
        }
        let experiment_aggregates = experiment_events
            .into_iter()
            .map(|(experiment_key, variants)| {
                let variants = variants
                    .into_iter()
                    .map(|(variant, events)| (variant, aggregate_telemetry_records(events)))
                    .collect();
                (experiment_key, variants)
            })
            .collect();
        Ok(TelemetryAggregate {
            overall,
            experiment_aggregates,
        })
    }
}

#[async_trait]
impl AlphaRepository for PostgresRoundRepository {
    async fn create_session(&self, session: SessionRecord) -> Result<(), RepositoryError> {
        let result = sqlx::query(
            r"
            INSERT INTO strikefall_sessions (
                id, revision, token_hash, handle, handle_key, telemetry_consent,
                experiments, invite_code_hash, creation_ip_hash, created_at_ms,
                expires_at_ms, rotated_at_ms, last_renamed_at_ms, revoked_at_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ",
        )
        .bind(&session.id)
        .bind(to_i64(session.revision, "session revision")?)
        .bind(&session.token_hash)
        .bind(&session.handle)
        .bind(&session.handle_key)
        .bind(session.telemetry_consent)
        .bind(Json(&session.experiments))
        .bind(&session.invite_code_hash)
        .bind(&session.creation_ip_hash)
        .bind(to_i64(session.created_at_ms, "session created_at_ms")?)
        .bind(to_i64(session.expires_at_ms, "session expires_at_ms")?)
        .bind(optional_i64(
            session.rotated_at_ms,
            "session rotated_at_ms",
        )?)
        .bind(optional_i64(
            session.last_renamed_at_ms,
            "session last_renamed_at_ms",
        )?)
        .bind(optional_i64(
            session.revoked_at_ms,
            "session revoked_at_ms",
        )?)
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

    async fn load_session_by_token_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<SessionRecord>, RepositoryError> {
        let row = sqlx::query(
            r"
            SELECT id, revision, token_hash, handle, handle_key, telemetry_consent,
                   experiments, invite_code_hash, creation_ip_hash, created_at_ms,
                   expires_at_ms, rotated_at_ms, last_renamed_at_ms, revoked_at_ms
            FROM strikefall_sessions
            WHERE token_hash = $1
            ",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| session_from_row(&row)).transpose()
    }

    async fn save_session(
        &self,
        expected_revision: u64,
        session: SessionRecord,
    ) -> Result<(), RepositoryError> {
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Backend("session revision overflow".to_owned()))?;
        let result = sqlx::query(
            r"
            UPDATE strikefall_sessions
            SET revision = $3,
                token_hash = $4,
                handle = $5,
                handle_key = $6,
                telemetry_consent = $7,
                experiments = $8,
                expires_at_ms = $9,
                rotated_at_ms = $10,
                last_renamed_at_ms = $11,
                revoked_at_ms = $12,
                updated_at = NOW()
            WHERE id = $1 AND revision = $2
            ",
        )
        .bind(&session.id)
        .bind(to_i64(expected_revision, "expected session revision")?)
        .bind(to_i64(next_revision, "next session revision")?)
        .bind(&session.token_hash)
        .bind(&session.handle)
        .bind(&session.handle_key)
        .bind(session.telemetry_consent)
        .bind(Json(&session.experiments))
        .bind(to_i64(session.expires_at_ms, "session expires_at_ms")?)
        .bind(optional_i64(
            session.rotated_at_ms,
            "session rotated_at_ms",
        )?)
        .bind(optional_i64(
            session.last_renamed_at_ms,
            "session last_renamed_at_ms",
        )?)
        .bind(optional_i64(
            session.revoked_at_ms,
            "session revoked_at_ms",
        )?)
        .execute(&self.pool)
        .await;
        match result {
            Ok(result) if result.rows_affected() == 1 => Ok(()),
            Ok(_) => Err(RepositoryError::RevisionConflict),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                Err(RepositoryError::AlreadyExists)
            }
            Err(error) => Err(error.into()),
        }
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
        let count: i32 = sqlx::query_scalar(
            r"
            INSERT INTO strikefall_rate_limits (scope_hash, action, window_started_ms, count)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (scope_hash, action, window_started_ms)
            DO UPDATE SET count = LEAST(strikefall_rate_limits.count + 1, $4 + 1),
                          updated_at = NOW()
            RETURNING count
            ",
        )
        .bind(scope_hash)
        .bind(action)
        .bind(to_i64(window_started_ms, "rate window")?)
        .bind(i32::try_from(limit).map_err(|_| {
            RepositoryError::Backend("rate limit exceeds Postgres integer".to_owned())
        })?)
        .fetch_one(&self.pool)
        .await?;
        Ok(RateLimitOutcome {
            allowed: u32::try_from(count).unwrap_or(u32::MAX) <= limit,
            retry_after_ms: window_started_ms
                .saturating_add(window_ms)
                .saturating_sub(now_ms)
                .max(1),
        })
    }

    async fn list_leaderboard_entries(
        &self,
        deck_id: &str,
        deck_version: u16,
        cutoff_ms: u64,
        limit: u32,
    ) -> Result<Vec<AuthoritativeLeaderboardEntry>, RepositoryError> {
        let rows = sqlx::query(
            r"
            SELECT entry.round_id, entry.session_id, session.handle, entry.deck_id,
                   entry.deck_version, entry.score::text AS score, entry.outcome,
                   entry.player_rank, entry.resolved_at_ms
            FROM strikefall_leaderboard_entries AS entry
            JOIN strikefall_sessions AS session ON session.id = entry.session_id
            WHERE entry.deck_id = $1
              AND entry.deck_version = $2
              AND entry.resolved_at_ms >= $3
              AND session.revoked_at_ms IS NULL
            ORDER BY entry.score DESC, entry.resolved_at_ms ASC, entry.round_id ASC
            LIMIT $4
            ",
        )
        .bind(deck_id)
        .bind(i16::try_from(deck_version).map_err(|_| {
            RepositoryError::Backend("deck version exceeds Postgres smallint".to_owned())
        })?)
        .bind(to_i64(cutoff_ms, "leaderboard cutoff")?)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(AuthoritativeLeaderboardEntry {
                    round_id: row.try_get("round_id")?,
                    session_id: row.try_get("session_id")?,
                    handle: row.try_get("handle")?,
                    deck_id: row.try_get("deck_id")?,
                    deck_version: u16::try_from(row.try_get::<i16, _>("deck_version")?).map_err(
                        |_| RepositoryError::Backend("invalid stored deck version".to_owned()),
                    )?,
                    score: row.try_get("score")?,
                    outcome: row.try_get("outcome")?,
                    player_rank: u16::try_from(row.try_get::<i16, _>("player_rank")?).map_err(
                        |_| RepositoryError::Backend("invalid stored player rank".to_owned()),
                    )?,
                    resolved_at_ms: from_i64(row.try_get("resolved_at_ms")?, "resolved_at_ms")?,
                })
            })
            .collect()
    }

    async fn insert_telemetry(
        &self,
        events: &[TelemetryRecord],
    ) -> Result<TelemetryInsertResult, RepositoryError> {
        let mut transaction = self.pool.begin().await?;
        let mut result = TelemetryInsertResult::default();
        for event in events {
            let mut properties = event.properties.clone();
            properties
                .as_object_mut()
                .ok_or_else(|| {
                    RepositoryError::Backend(
                        "validated telemetry properties are not an object".to_owned(),
                    )
                })?
                .insert(
                    "_experimentAssignments".to_owned(),
                    serde_json::to_value(&event.experiment_assignments).map_err(|error| {
                        RepositoryError::Backend(format!(
                            "experiment assignment serialization failed: {error}"
                        ))
                    })?,
                );
            let inserted = sqlx::query(
                r"
                INSERT INTO strikefall_telemetry_events (
                    event_id, session_id, event_name, occurred_at_ms, received_at_ms,
                    deck_id, round_id, properties, retention_until
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                        to_timestamp($9::double precision / 1000.0))
                ON CONFLICT DO NOTHING
                ",
            )
            .bind(&event.event_id)
            .bind(&event.session_id)
            .bind(&event.event_name)
            .bind(to_i64(event.occurred_at_ms, "telemetry occurred_at_ms")?)
            .bind(to_i64(event.received_at_ms, "telemetry received_at_ms")?)
            .bind(&event.deck_id)
            .bind(&event.round_id)
            .bind(Json(&properties))
            .bind(to_i64(
                event.retention_until_ms,
                "telemetry retention_until_ms",
            )?)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if inserted == 1 {
                result.accepted = result.accepted.saturating_add(1);
            } else {
                result.duplicates = result.duplicates.saturating_add(1);
            }
        }
        transaction.commit().await?;
        Ok(result)
    }

    #[allow(clippy::too_many_lines)]
    async fn telemetry_aggregate(
        &self,
        start_ms: u64,
        end_ms: u64,
        deck_id: Option<&str>,
    ) -> Result<TelemetryAggregate, RepositoryError> {
        let start_ms = to_i64(start_ms, "metrics start_ms")?;
        let end_ms = to_i64(end_ms, "metrics end_ms")?;
        let rows = sqlx::query(
            r"
            SELECT event_name, COUNT(*)::bigint AS count
            FROM strikefall_telemetry_events
            WHERE occurred_at_ms >= $1
              AND occurred_at_ms <= $2
              AND ($3::text IS NULL OR deck_id = $3)
            GROUP BY event_name
            ORDER BY event_name
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        let mut overall = empty_telemetry_aggregate_slice();
        for row in rows {
            overall.counts.insert(
                row.try_get("event_name")?,
                nonnegative_count(&row, "count")?,
            );
        }

        let session_row = sqlx::query(
            r"
            WITH per_session AS (
                SELECT session_id,
                       COUNT(DISTINCT round_id)
                           FILTER (WHERE event_name = 'round_started')::bigint
                           AS round_starts,
                       BOOL_OR(event_name = 'client_error') AS has_client_error
                FROM strikefall_telemetry_events
                WHERE occurred_at_ms >= $1
                  AND occurred_at_ms <= $2
                  AND ($3::text IS NULL OR deck_id = $3)
                GROUP BY session_id
            )
            SELECT COUNT(*)::bigint AS distinct_sessions,
                   COALESCE(SUM(round_starts), 0)::bigint AS distinct_round_starts,
                   COUNT(*) FILTER (WHERE round_starts >= 1)::bigint
                       AS round_start_sessions,
                   COUNT(*) FILTER (WHERE round_starts >= 2)::bigint
                       AS second_round_sessions,
                   COUNT(*) FILTER (WHERE round_starts >= 3)::bigint
                       AS third_round_sessions,
                   COUNT(*) FILTER (WHERE has_client_error)::bigint
                       AS client_error_sessions
            FROM per_session
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_one(&self.pool)
        .await?;
        overall.distinct_sessions = nonnegative_count(&session_row, "distinct_sessions")?;
        overall.distinct_round_starts = nonnegative_count(&session_row, "distinct_round_starts")?;
        overall.round_start_sessions = nonnegative_count(&session_row, "round_start_sessions")?;
        overall.sessions_with_at_least_two_round_starts =
            nonnegative_count(&session_row, "second_round_sessions")?;
        overall.sessions_with_at_least_three_round_starts =
            nonnegative_count(&session_row, "third_round_sessions")?;
        overall.client_error_sessions = nonnegative_count(&session_row, "client_error_sessions")?;

        let outcome_rows = sqlx::query(
            r"
            SELECT outcome, COUNT(*)::bigint AS count
            FROM (
                SELECT DISTINCT session_id, round_id,
                       properties ->> 'outcome' AS outcome
                FROM strikefall_telemetry_events
                WHERE occurred_at_ms >= $1
                  AND occurred_at_ms <= $2
                  AND ($3::text IS NULL OR deck_id = $3)
                  AND event_name = 'round_completed'
                  AND round_id IS NOT NULL
            ) AS authoritative_outcomes
            GROUP BY outcome
            ORDER BY outcome
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in outcome_rows {
            let outcome = row.try_get::<String, _>("outcome")?;
            let count = nonnegative_count(&row, "count")?;
            let stored = overall
                .player_outcome_counts
                .get_mut(&outcome)
                .ok_or_else(|| {
                    RepositoryError::Backend("unsupported stored telemetry outcome".to_owned())
                })?;
            *stored = count;
        }

        let authoritative_rows = sqlx::query(
            r"
            SELECT (properties ->> '_playerFlagRevisions')::bigint
                       AS player_flag_revisions,
                   (properties ->> '_upperPlacements')::bigint AS upper_placements,
                   (properties ->> '_lowerPlacements')::bigint AS lower_placements,
                   (properties ->> '_populatedRiskBands')::bigint
                       AS populated_risk_bands,
                   (properties ->> '_survivors')::bigint AS survivors,
                   (properties ->> '_eliminated')::bigint AS eliminated,
                   (properties ->> '_earlyMassWipe')::boolean AS early_mass_wipe,
                   (properties ->> '_playerEliminationStep')::bigint
                       AS player_elimination_step,
                   COUNT(DISTINCT (session_id, round_id))::bigint AS count
            FROM strikefall_telemetry_events
            WHERE occurred_at_ms >= $1
              AND occurred_at_ms <= $2
              AND ($3::text IS NULL OR deck_id = $3)
              AND event_name = 'round_completed'
              AND properties ? '_playerFlagRevisions'
            GROUP BY player_flag_revisions, upper_placements, lower_placements,
                     populated_risk_bands, survivors, eliminated,
                     early_mass_wipe, player_elimination_step
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in authoritative_rows {
            apply_authoritative_fact_row(&mut overall, &row)?;
        }

        let action_rows = sqlx::query(
            r"
            SELECT action.event_name AS event_name,
                   COALESCE(
                       (action.properties ->> '_withinFiveSeconds')::boolean,
                       FALSE
                   ) AS within_five_seconds,
                   COUNT(DISTINCT (action.session_id, action.round_id))::bigint AS count
            FROM strikefall_telemetry_events AS action
            WHERE action.occurred_at_ms >= $1
              AND action.occurred_at_ms <= $2
              AND ($3::text IS NULL OR action.deck_id = $3)
              AND action.event_name IN (
                  'dead_player_response', 'share_opened', 'clip_exported'
              )
              AND EXISTS (
                  SELECT 1
                  FROM strikefall_telemetry_events AS completed
                  WHERE completed.session_id = action.session_id
                    AND completed.round_id = action.round_id
                    AND completed.event_name = 'round_completed'
                    AND completed.occurred_at_ms >= $1
                    AND completed.occurred_at_ms <= $2
                    AND ($3::text IS NULL OR completed.deck_id = $3)
                    AND completed.properties ? '_playerFlagRevisions'
              )
            GROUP BY action.event_name, within_five_seconds
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in action_rows {
            apply_action_row(&mut overall, &row)?;
        }

        let experiment_rows = sqlx::query(
            r"
            SELECT assignment.key AS experiment_key,
                   assignment.value AS variant,
                   event_name,
                   COUNT(*)::bigint AS count
            FROM strikefall_telemetry_events
            CROSS JOIN LATERAL jsonb_each_text(
                COALESCE(properties -> '_experimentAssignments', '{}'::jsonb)
            ) AS assignment
            WHERE occurred_at_ms >= $1
              AND occurred_at_ms <= $2
              AND ($3::text IS NULL OR deck_id = $3)
            GROUP BY assignment.key, assignment.value, event_name
            ORDER BY assignment.key, assignment.value, event_name
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        let mut experiment_aggregates = BTreeMap::new();
        for row in experiment_rows {
            let count = nonnegative_count(&row, "count")?;
            experiment_aggregates
                .entry(row.try_get::<String, _>("experiment_key")?)
                .or_insert_with(BTreeMap::new)
                .entry(row.try_get::<String, _>("variant")?)
                .or_insert_with(empty_telemetry_aggregate_slice)
                .counts
                .insert(row.try_get::<String, _>("event_name")?, count);
        }

        let experiment_session_rows = sqlx::query(
            r"
            WITH expanded AS (
                SELECT session_id, round_id, event_name,
                       assignment.key AS experiment_key,
                       assignment.value AS variant
                FROM strikefall_telemetry_events
                CROSS JOIN LATERAL jsonb_each_text(
                    COALESCE(properties -> '_experimentAssignments', '{}'::jsonb)
                ) AS assignment
                WHERE occurred_at_ms >= $1
                  AND occurred_at_ms <= $2
                  AND ($3::text IS NULL OR deck_id = $3)
            ), per_session AS (
                SELECT experiment_key, variant, session_id,
                       COUNT(DISTINCT round_id)
                           FILTER (WHERE event_name = 'round_started')::bigint
                           AS round_starts,
                       BOOL_OR(event_name = 'client_error') AS has_client_error
                FROM expanded
                GROUP BY experiment_key, variant, session_id
            )
            SELECT experiment_key, variant,
                   COUNT(*)::bigint AS distinct_sessions,
                   COALESCE(SUM(round_starts), 0)::bigint AS distinct_round_starts,
                   COUNT(*) FILTER (WHERE round_starts >= 1)::bigint
                       AS round_start_sessions,
                   COUNT(*) FILTER (WHERE round_starts >= 2)::bigint
                       AS second_round_sessions,
                   COUNT(*) FILTER (WHERE round_starts >= 3)::bigint
                       AS third_round_sessions,
                   COUNT(*) FILTER (WHERE has_client_error)::bigint
                       AS client_error_sessions
            FROM per_session
            GROUP BY experiment_key, variant
            ORDER BY experiment_key, variant
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in experiment_session_rows {
            let aggregate = experiment_aggregates
                .entry(row.try_get::<String, _>("experiment_key")?)
                .or_insert_with(BTreeMap::new)
                .entry(row.try_get::<String, _>("variant")?)
                .or_insert_with(empty_telemetry_aggregate_slice);
            aggregate.distinct_sessions = nonnegative_count(&row, "distinct_sessions")?;
            aggregate.distinct_round_starts = nonnegative_count(&row, "distinct_round_starts")?;
            aggregate.round_start_sessions = nonnegative_count(&row, "round_start_sessions")?;
            aggregate.sessions_with_at_least_two_round_starts =
                nonnegative_count(&row, "second_round_sessions")?;
            aggregate.sessions_with_at_least_three_round_starts =
                nonnegative_count(&row, "third_round_sessions")?;
            aggregate.client_error_sessions = nonnegative_count(&row, "client_error_sessions")?;
        }

        let experiment_outcome_rows = sqlx::query(
            r"
            SELECT experiment_key, variant, outcome, COUNT(*)::bigint AS count
            FROM (
                SELECT DISTINCT session_id, round_id,
                       assignment.key AS experiment_key,
                       assignment.value AS variant,
                       properties ->> 'outcome' AS outcome
                FROM strikefall_telemetry_events
                CROSS JOIN LATERAL jsonb_each_text(
                    COALESCE(properties -> '_experimentAssignments', '{}'::jsonb)
                ) AS assignment
                WHERE occurred_at_ms >= $1
                  AND occurred_at_ms <= $2
                  AND ($3::text IS NULL OR deck_id = $3)
                  AND event_name = 'round_completed'
                  AND round_id IS NOT NULL
            ) AS authoritative_outcomes
            GROUP BY experiment_key, variant, outcome
            ORDER BY experiment_key, variant, outcome
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in experiment_outcome_rows {
            let outcome = row.try_get::<String, _>("outcome")?;
            let count = nonnegative_count(&row, "count")?;
            let aggregate = experiment_aggregates
                .entry(row.try_get::<String, _>("experiment_key")?)
                .or_insert_with(BTreeMap::new)
                .entry(row.try_get::<String, _>("variant")?)
                .or_insert_with(empty_telemetry_aggregate_slice);
            let stored = aggregate
                .player_outcome_counts
                .get_mut(&outcome)
                .ok_or_else(|| {
                    RepositoryError::Backend("unsupported stored telemetry outcome".to_owned())
                })?;
            *stored = count;
        }

        let experiment_authoritative_rows = sqlx::query(
            r"
            SELECT assignment.key AS experiment_key,
                   assignment.value AS variant,
                   (properties ->> '_playerFlagRevisions')::bigint
                       AS player_flag_revisions,
                   (properties ->> '_upperPlacements')::bigint AS upper_placements,
                   (properties ->> '_lowerPlacements')::bigint AS lower_placements,
                   (properties ->> '_populatedRiskBands')::bigint
                       AS populated_risk_bands,
                   (properties ->> '_survivors')::bigint AS survivors,
                   (properties ->> '_eliminated')::bigint AS eliminated,
                   (properties ->> '_earlyMassWipe')::boolean AS early_mass_wipe,
                   (properties ->> '_playerEliminationStep')::bigint
                       AS player_elimination_step,
                   COUNT(DISTINCT (session_id, round_id))::bigint AS count
            FROM strikefall_telemetry_events
            CROSS JOIN LATERAL jsonb_each_text(
                COALESCE(properties -> '_experimentAssignments', '{}'::jsonb)
            ) AS assignment
            WHERE occurred_at_ms >= $1
              AND occurred_at_ms <= $2
              AND ($3::text IS NULL OR deck_id = $3)
              AND event_name = 'round_completed'
              AND properties ? '_playerFlagRevisions'
            GROUP BY assignment.key, assignment.value, player_flag_revisions,
                     upper_placements, lower_placements, populated_risk_bands,
                     survivors, eliminated, early_mass_wipe,
                     player_elimination_step
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in experiment_authoritative_rows {
            let aggregate = experiment_aggregates
                .entry(row.try_get::<String, _>("experiment_key")?)
                .or_insert_with(BTreeMap::new)
                .entry(row.try_get::<String, _>("variant")?)
                .or_insert_with(empty_telemetry_aggregate_slice);
            apply_authoritative_fact_row(aggregate, &row)?;
        }

        let experiment_action_rows = sqlx::query(
            r"
            SELECT assignment.key AS experiment_key,
                   assignment.value AS variant,
                   action.event_name,
                   COALESCE(
                       (action.properties ->> '_withinFiveSeconds')::boolean,
                       FALSE
                   ) AS within_five_seconds,
                   COUNT(DISTINCT (action.session_id, action.round_id))::bigint AS count
            FROM strikefall_telemetry_events AS action
            CROSS JOIN LATERAL jsonb_each_text(
                COALESCE(action.properties -> '_experimentAssignments', '{}'::jsonb)
            ) AS assignment
            WHERE action.occurred_at_ms >= $1
              AND action.occurred_at_ms <= $2
              AND ($3::text IS NULL OR action.deck_id = $3)
              AND action.event_name IN (
                  'dead_player_response', 'share_opened', 'clip_exported'
              )
              AND EXISTS (
                  SELECT 1
                  FROM strikefall_telemetry_events AS completed
                  WHERE completed.session_id = action.session_id
                    AND completed.round_id = action.round_id
                    AND completed.event_name = 'round_completed'
                    AND completed.occurred_at_ms >= $1
                    AND completed.occurred_at_ms <= $2
                    AND ($3::text IS NULL OR completed.deck_id = $3)
                    AND completed.properties ? '_playerFlagRevisions'
              )
            GROUP BY assignment.key, assignment.value, action.event_name,
                     within_five_seconds
            ",
        )
        .bind(start_ms)
        .bind(end_ms)
        .bind(deck_id)
        .fetch_all(&self.pool)
        .await?;
        for row in experiment_action_rows {
            let aggregate = experiment_aggregates
                .entry(row.try_get::<String, _>("experiment_key")?)
                .or_insert_with(BTreeMap::new)
                .entry(row.try_get::<String, _>("variant")?)
                .or_insert_with(empty_telemetry_aggregate_slice);
            apply_action_row(aggregate, &row)?;
        }
        Ok(TelemetryAggregate {
            overall,
            experiment_aggregates,
        })
    }
}

pub(crate) fn leaderboard_entry_from_round(
    round: &RoundRecord,
) -> Option<AuthoritativeLeaderboardEntry> {
    if round.status != RoundStatusDto::Resolved
        || !round
            .events
            .iter()
            .any(|event| matches!(&event.kind, RoundEventKindDto::SeedRevealed { .. }))
    {
        return None;
    }
    let session_id = round.session_id.clone()?;
    let result = round.result.as_ref()?;
    if round
        .replay_verification
        .as_ref()
        .is_none_or(|receipt| receipt.proof_digest != result.proof_digest)
    {
        return None;
    }
    let resolved_at_ms = round.events.iter().find_map(|event| {
        matches!(&event.kind, RoundEventKindDto::RoundEnded { .. }).then_some(event.server_time_ms)
    })?;
    let outcome = match result.outcome {
        ContenderOutcomeDto::Survived => "survived",
        ContenderOutcomeDto::Eliminated => "eliminated",
        ContenderOutcomeDto::Escaped => "escaped",
    };
    Some(AuthoritativeLeaderboardEntry {
        round_id: round.id.clone(),
        session_id,
        handle: String::new(),
        deck_id: round.deck_id.clone(),
        deck_version: round.deck_version,
        score: result.score.clone(),
        outcome: outcome.to_owned(),
        player_rank: result.rank,
        resolved_at_ms,
    })
}

pub(crate) async fn insert_postgres_leaderboard_entry(
    transaction: &mut Transaction<'_, Postgres>,
    entry: &AuthoritativeLeaderboardEntry,
) -> Result<(), RepositoryError> {
    sqlx::query(
        r"
        INSERT INTO strikefall_leaderboard_entries (
            round_id, session_id, deck_id, deck_version, score,
            outcome, player_rank, resolved_at_ms
        )
        VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)
        ON CONFLICT (round_id) DO NOTHING
        ",
    )
    .bind(&entry.round_id)
    .bind(&entry.session_id)
    .bind(&entry.deck_id)
    .bind(i16::try_from(entry.deck_version).map_err(|_| {
        RepositoryError::Backend("deck version exceeds Postgres smallint".to_owned())
    })?)
    .bind(&entry.score)
    .bind(&entry.outcome)
    .bind(i16::try_from(entry.player_rank).map_err(|_| {
        RepositoryError::Backend("player rank exceeds Postgres smallint".to_owned())
    })?)
    .bind(to_i64(entry.resolved_at_ms, "leaderboard resolved_at_ms")?)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn session_from_row(row: &sqlx::postgres::PgRow) -> Result<SessionRecord, RepositoryError> {
    let Json(experiments) = row.try_get::<Json<BTreeMap<String, String>>, _>("experiments")?;
    Ok(SessionRecord {
        id: row.try_get("id")?,
        revision: from_i64(row.try_get("revision")?, "session revision")?,
        token_hash: row.try_get("token_hash")?,
        handle: row.try_get("handle")?,
        handle_key: row.try_get("handle_key")?,
        telemetry_consent: row.try_get("telemetry_consent")?,
        experiments,
        invite_code_hash: row.try_get("invite_code_hash")?,
        creation_ip_hash: row.try_get("creation_ip_hash")?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "session created_at_ms")?,
        expires_at_ms: from_i64(row.try_get("expires_at_ms")?, "session expires_at_ms")?,
        rotated_at_ms: optional_u64(row.try_get("rotated_at_ms")?, "session rotated_at_ms")?,
        last_renamed_at_ms: optional_u64(
            row.try_get("last_renamed_at_ms")?,
            "session last_renamed_at_ms",
        )?,
        revoked_at_ms: optional_u64(row.try_get("revoked_at_ms")?, "session revoked_at_ms")?,
    })
}

fn to_i64(value: u64, field: &str) -> Result<i64, RepositoryError> {
    i64::try_from(value)
        .map_err(|_| RepositoryError::Backend(format!("{field} exceeds Postgres bigint")))
}

fn from_i64(value: i64, field: &str) -> Result<u64, RepositoryError> {
    u64::try_from(value).map_err(|_| RepositoryError::Backend(format!("{field} is negative")))
}

fn optional_i64(value: Option<u64>, field: &str) -> Result<Option<i64>, RepositoryError> {
    value.map(|value| to_i64(value, field)).transpose()
}

fn optional_u64(value: Option<i64>, field: &str) -> Result<Option<u64>, RepositoryError> {
    value.map(|value| from_i64(value, field)).transpose()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{aggregate_telemetry_records, TelemetryRecord};

    fn record(
        event_id: &str,
        session_id: &str,
        event_name: &str,
        round_id: Option<&str>,
        properties: serde_json::Value,
    ) -> TelemetryRecord {
        TelemetryRecord {
            event_id: event_id.to_owned(),
            session_id: session_id.to_owned(),
            event_name: event_name.to_owned(),
            occurred_at_ms: 1,
            received_at_ms: 1,
            deck_id: round_id.map(|_| "balanced_tape".to_owned()),
            round_id: round_id.map(str::to_owned),
            properties,
            experiment_assignments: BTreeMap::default(),
            retention_until_ms: 2,
        }
    }

    #[test]
    fn aggregate_deduplicates_authoritative_round_ids_and_session_errors() {
        let records = vec![
            record(
                "start-1",
                "alpha",
                "round_started",
                Some("round-1"),
                json!({}),
            ),
            record(
                "start-1-retry",
                "alpha",
                "round_started",
                Some("round-1"),
                json!({}),
            ),
            record(
                "start-2",
                "alpha",
                "round_started",
                Some("round-2"),
                json!({}),
            ),
            record(
                "complete-1",
                "alpha",
                "round_completed",
                Some("round-1"),
                json!({ "outcome": "survived" }),
            ),
            record(
                "complete-1-retry",
                "alpha",
                "round_completed",
                Some("round-1"),
                json!({ "outcome": "survived" }),
            ),
            record("error-1", "alpha", "client_error", None, json!({})),
            record("error-2", "alpha", "client_error", None, json!({})),
            record("ui-1", "ui-only", "ui_performance", None, json!({})),
        ];
        let aggregate = aggregate_telemetry_records(&records);
        assert_eq!(aggregate.distinct_sessions, 2);
        assert_eq!(aggregate.round_start_sessions, 1);
        assert_eq!(aggregate.distinct_round_starts, 2);
        assert_eq!(aggregate.sessions_with_at_least_two_round_starts, 1);
        assert_eq!(aggregate.sessions_with_at_least_three_round_starts, 0);
        assert_eq!(aggregate.player_outcome_counts.get("survived"), Some(&1));
        assert_eq!(aggregate.client_error_sessions, 1);
    }
}
