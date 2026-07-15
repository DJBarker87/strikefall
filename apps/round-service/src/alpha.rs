use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use strikefall_core::{deck_by_id, SCALE};
use strikefall_protocol::{
    hash_framed, ContenderOutcomeDto, CreateRoundRequest, CreateRoundResponse, EventActorDto,
    ReplayBundleDto, RoundEventKindDto, RoundStatusDto, SideDto, PLAYER_CONTENDER_ID,
};
pub use strikefall_protocol::{
    DECK_STRUCTURE_EXPERIMENT, ESCAPE_EXPERIMENT, RISK_DISPLAY_EXPERIMENT,
};
use uuid::Uuid;

use crate::{RoundService, ServiceError};

pub const TELEMETRY_SCHEMA_VERSION: &str = "strikefall/telemetry/v2";
const TOKEN_PREFIX: &str = "sf_alpha_";
const MAX_TELEMETRY_BYTES: usize = 32 * 1_024;
const MAX_TELEMETRY_EVENTS: usize = 50;
const LEADERBOARD_CANDIDATE_CAP: u32 = 10_000;

#[derive(Clone, Debug)]
pub struct ClosedAlphaConfig {
    pub invite_required: bool,
    pub invite_code_hashes: BTreeSet<String>,
    pub session_ttl_ms: u64,
    pub telemetry_retention_days: u32,
    pub metrics_token_hash: Option<String>,
    pub experiments: BTreeMap<String, Vec<String>>,
}

impl Default for ClosedAlphaConfig {
    fn default() -> Self {
        Self {
            invite_required: false,
            invite_code_hashes: BTreeSet::new(),
            session_ttl_ms: 7 * 24 * 60 * 60 * 1_000,
            telemetry_retention_days: 30,
            metrics_token_hash: None,
            experiments: default_experiments(),
        }
    }
}

/// The allowed alpha catalog. Deck structure remains available only for an
/// explicitly configured closed-alpha deployment.
#[must_use]
pub fn shipped_experiments() -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([
        (
            DECK_STRUCTURE_EXPERIMENT.to_owned(),
            vec!["flat".to_owned(), "compression-break".to_owned()],
        ),
        (
            ESCAPE_EXPERIMENT.to_owned(),
            vec!["absent".to_owned(), "midpoint".to_owned()],
        ),
        (
            RISK_DISPLAY_EXPERIMENT.to_owned(),
            vec!["probability".to_owned(), "danger-band".to_owned()],
        ),
    ])
}

/// Public/default assignments. Quick Run has no deck cohort and therefore
/// rotates across the full catalog; Escape and risk remain mandatory.
#[must_use]
pub fn default_experiments() -> BTreeMap<String, Vec<String>> {
    let mut experiments = shipped_experiments();
    experiments.remove(DECK_STRUCTURE_EXPERIMENT);
    experiments
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub revision: u64,
    pub token_hash: String,
    pub handle: String,
    pub handle_key: String,
    pub telemetry_consent: bool,
    pub experiments: BTreeMap<String, String>,
    pub invite_code_hash: Option<String>,
    pub creation_ip_hash: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub rotated_at_ms: Option<u64>,
    pub last_renamed_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionContext {
    pub id: String,
    pub handle: String,
    pub experiments: BTreeMap<String, String>,
}

impl From<&SessionRecord> for SessionContext {
    fn from(value: &SessionRecord) -> Self {
        Self {
            id: value.id.clone(),
            handle: value.handle.clone(),
            experiments: value.experiments.clone(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionRequest {
    pub invite_code: Option<String>,
    pub handle: Option<String>,
    #[serde(default)]
    pub telemetry_consent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewDto {
    pub handle: String,
    pub expires_at_ms: u64,
    pub telemetry_consent: bool,
    pub experiments: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedSessionDto {
    pub token: String,
    pub session: SessionViewDto,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameSessionRequest {
    pub handle: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryConsentRequest {
    pub consent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthoritativeLeaderboardEntry {
    pub round_id: String,
    pub session_id: String,
    pub handle: String,
    pub deck_id: String,
    pub deck_version: u16,
    pub score: String,
    pub outcome: String,
    pub player_rank: u16,
    pub resolved_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntryDto {
    pub rank: u32,
    pub handle: String,
    pub score: String,
    pub outcome: String,
    pub round_id: String,
    pub resolved_at_ms: u64,
    pub is_self: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeaderboardWindow {
    Daily,
    Weekly,
}

impl LeaderboardWindow {
    #[must_use]
    pub const fn duration_ms(self) -> u64 {
        match self {
            Self::Daily => 24 * 60 * 60 * 1_000,
            Self::Weekly => 7 * 24 * 60 * 60 * 1_000,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaderboardQuery {
    pub window: Option<LeaderboardWindow>,
    pub limit: Option<u16>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardResponse {
    pub deck_id: String,
    pub deck_version: u16,
    pub window: LeaderboardWindow,
    pub generated_at_ms: u64,
    pub entries: Vec<LeaderboardEntryDto>,
    pub self_entry: Option<LeaderboardEntryDto>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicReplayAnchorDto {
    pub round_id: String,
    pub protocol_version: String,
    pub commitment: String,
    pub server_verifying_key: String,
    pub experiment_assignments: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicReplayResponseDto {
    pub anchor: PublicReplayAnchorDto,
    pub replay: ReplayBundleDto,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryEventInput {
    pub event_id: String,
    pub name: String,
    pub occurred_at_ms: u64,
    pub properties: Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryBatchRequest {
    pub schema_version: String,
    pub events: Vec<TelemetryEventInput>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRecord {
    pub event_id: String,
    pub session_id: String,
    pub event_name: String,
    pub occurred_at_ms: u64,
    pub received_at_ms: u64,
    pub deck_id: Option<String>,
    pub round_id: Option<String>,
    pub properties: Value,
    /// Server-authored, versioned cohort map. Round-linked events inherit the
    /// immutable round assignment rather than trusting client properties.
    pub experiment_assignments: BTreeMap<String, String>,
    pub retention_until_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TelemetryInsertResult {
    pub accepted: u32,
    pub duplicates: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBatchResponse {
    pub accepted: u32,
    pub duplicates: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TelemetryMetricsQuery {
    pub window_hours: Option<u16>,
    pub deck_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TelemetryAggregateSlice {
    pub counts: BTreeMap<String, u64>,
    pub distinct_sessions: u64,
    pub distinct_round_starts: u64,
    pub round_start_sessions: u64,
    pub sessions_with_at_least_two_round_starts: u64,
    pub sessions_with_at_least_three_round_starts: u64,
    pub player_outcome_counts: BTreeMap<String, u64>,
    pub client_error_sessions: u64,
    pub flag_revision_histogram: BTreeMap<u16, u64>,
    pub survivor_histogram: BTreeMap<u16, u64>,
    pub authoritative_rounds: u64,
    pub healthy_placement_spread_rounds: u64,
    pub no_elimination_rounds: u64,
    pub early_mass_wipe_rounds: u64,
    pub elimination_step_distribution: BTreeMap<u16, u64>,
    pub dead_player_eliminations: u64,
    pub dead_player_responses_within_five_seconds: u64,
    pub share_opened_rounds: u64,
    pub clip_exported_rounds: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TelemetryAggregate {
    pub overall: TelemetryAggregateSlice,
    pub experiment_aggregates: BTreeMap<String, BTreeMap<String, TelemetryAggregateSlice>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum G4ErrorRateStatusDto {
    Insufficient,
    Pass,
    Fail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryProductMetricsDto {
    pub distinct_sessions: u64,
    pub distinct_round_starts: u64,
    pub round_start_sessions: u64,
    pub second_round_sessions: u64,
    pub third_round_sessions: u64,
    pub rematch_rate_per_mille: u16,
    pub third_round_rate_per_mille: u16,
    pub outcomes: BTreeMap<String, u64>,
    pub outcome_distribution_per_mille: BTreeMap<String, u16>,
    pub client_error_sessions: u64,
    pub error_session_rate_per_million: Option<u32>,
    pub g4_error_status: G4ErrorRateStatusDto,
    pub g4_minimum_sessions: u64,
    pub g4_note: String,
    pub flag_revision_samples: u64,
    pub median_flag_revisions_milli: Option<u32>,
    pub survivor_samples: u64,
    pub median_survivors_milli: Option<u32>,
    pub placement_spread_rounds: u64,
    pub healthy_placement_spread_rounds: u64,
    pub placement_spread_rate_per_mille: Option<u16>,
    pub no_elimination_rounds: u64,
    pub no_elimination_rate_per_mille: Option<u16>,
    pub early_mass_wipe_rounds: u64,
    pub early_mass_wipe_rate_per_mille: Option<u16>,
    pub elimination_step_distribution: Option<BTreeMap<String, u64>>,
    pub elimination_step_distribution_note: String,
    pub dead_player_eliminations: u64,
    pub dead_player_responses_within_five_seconds: u64,
    pub dead_player_response_rate_per_mille: Option<u16>,
    pub dead_player_response_note: String,
    pub share_intent_rounds: u64,
    pub share_intent_rate_per_mille: Option<u16>,
    pub clip_exported_rounds: u64,
    pub clip_export_rate_per_mille: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentTelemetryCutDto {
    /// Exact persisted identifier, including the treatment version (`:v2`).
    pub experiment_key: String,
    pub variant: String,
    pub counts: BTreeMap<String, u64>,
    pub completion_rate_per_mille: u16,
    #[serde(flatten)]
    pub product_metrics: TelemetryProductMetricsDto,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryMetricsResponse {
    pub schema_version: String,
    pub window_start_ms: u64,
    pub window_end_ms: u64,
    pub deck_id: Option<String>,
    pub counts: BTreeMap<String, u64>,
    pub completion_rate_per_mille: u16,
    #[serde(flatten)]
    pub product_metrics: TelemetryProductMetricsDto,
    pub experiment_cuts: Vec<ExperimentTelemetryCutDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimitOutcome {
    pub allowed: bool,
    pub retry_after_ms: u64,
}

/// The roadmap calls for a 50-100 tester closed alpha. G4 remains
/// `insufficient` until the aggregate reaches that cohort's lower bound.
pub const G4_MINIMUM_SAMPLE_SESSIONS: u64 = 50;

const ELIMINATION_STEP_DISTRIBUTION_NOTE: &str =
    "Authoritative player-elimination steps from consented completed rounds; empty means no eliminated-player sample in this window.";
const DEAD_PLAYER_RESPONSE_NOTE: &str =
    "Server-received spectate or rematch action within five seconds of the authoritative player FlagHit; verbal reactions are not measured.";
const G4_ERROR_RATE_NOTE: &str =
    "Coarse session proxy: distinct sessions with at least one bounded client_error divided by distinct telemetry sessions; target is strictly below 1%.";
const DECK_FILTERED_G4_NOTE: &str =
    "Unavailable for deck-filtered metrics: bounded client_error events have no deck identifier and are not attributed to a deck.";

fn rate_per_mille(numerator: u64, denominator: u64) -> u16 {
    if denominator == 0 {
        0
    } else {
        u16::try_from(numerator.saturating_mul(1_000) / denominator)
            .unwrap_or(u16::MAX)
            .min(1_000)
    }
}

fn optional_rate_per_mille(numerator: u64, denominator: u64) -> Option<u16> {
    (denominator > 0).then(|| rate_per_mille(numerator, denominator))
}

fn histogram_samples(histogram: &BTreeMap<u16, u64>) -> u64 {
    histogram.values().copied().fold(0_u64, u64::saturating_add)
}

fn histogram_value_at(histogram: &BTreeMap<u16, u64>, index: u64) -> Option<u16> {
    let mut seen = 0_u64;
    for (value, count) in histogram {
        seen = seen.saturating_add(*count);
        if index < seen {
            return Some(*value);
        }
    }
    None
}

fn histogram_median_milli(histogram: &BTreeMap<u16, u64>) -> Option<u32> {
    let samples = histogram_samples(histogram);
    if samples == 0 {
        return None;
    }
    let lower = histogram_value_at(histogram, (samples - 1) / 2)?;
    let upper = histogram_value_at(histogram, samples / 2)?;
    Some((u32::from(lower) + u32::from(upper)).saturating_mul(500))
}

fn completion_rate(started: u64, completed: u64) -> u16 {
    rate_per_mille(completed, started)
}

fn rate_per_million(numerator: u64, denominator: u64) -> u32 {
    if denominator == 0 {
        0
    } else {
        u32::try_from(numerator.saturating_mul(1_000_000) / denominator)
            .unwrap_or(u32::MAX)
            .min(1_000_000)
    }
}

fn product_metrics(
    aggregate: &TelemetryAggregateSlice,
    error_rate_available: bool,
) -> TelemetryProductMetricsDto {
    let completed = aggregate.player_outcome_counts.values().copied().sum();
    let outcome_distribution_per_mille = aggregate
        .player_outcome_counts
        .iter()
        .map(|(outcome, count)| (outcome.clone(), rate_per_mille(*count, completed)))
        .collect();
    let error_session_rate_per_million = (error_rate_available && aggregate.distinct_sessions > 0)
        .then(|| rate_per_million(aggregate.client_error_sessions, aggregate.distinct_sessions));
    let status = if !error_rate_available
        || aggregate.distinct_sessions < G4_MINIMUM_SAMPLE_SESSIONS
    {
        G4ErrorRateStatusDto::Insufficient
    } else if aggregate.client_error_sessions.saturating_mul(100) < aggregate.distinct_sessions {
        G4ErrorRateStatusDto::Pass
    } else {
        G4ErrorRateStatusDto::Fail
    };
    let elimination_step_distribution = aggregate
        .elimination_step_distribution
        .iter()
        .map(|(step, count)| (step.to_string(), *count))
        .collect();
    TelemetryProductMetricsDto {
        distinct_sessions: aggregate.distinct_sessions,
        distinct_round_starts: aggregate.distinct_round_starts,
        round_start_sessions: aggregate.round_start_sessions,
        second_round_sessions: aggregate.sessions_with_at_least_two_round_starts,
        third_round_sessions: aggregate.sessions_with_at_least_three_round_starts,
        rematch_rate_per_mille: rate_per_mille(
            aggregate.sessions_with_at_least_two_round_starts,
            aggregate.round_start_sessions,
        ),
        third_round_rate_per_mille: rate_per_mille(
            aggregate.sessions_with_at_least_three_round_starts,
            aggregate.round_start_sessions,
        ),
        outcomes: aggregate.player_outcome_counts.clone(),
        outcome_distribution_per_mille,
        client_error_sessions: aggregate.client_error_sessions,
        error_session_rate_per_million,
        g4_error_status: status,
        g4_minimum_sessions: G4_MINIMUM_SAMPLE_SESSIONS,
        g4_note: if error_rate_available {
            G4_ERROR_RATE_NOTE
        } else {
            DECK_FILTERED_G4_NOTE
        }
        .to_owned(),
        flag_revision_samples: histogram_samples(&aggregate.flag_revision_histogram),
        median_flag_revisions_milli: histogram_median_milli(&aggregate.flag_revision_histogram),
        survivor_samples: histogram_samples(&aggregate.survivor_histogram),
        median_survivors_milli: histogram_median_milli(&aggregate.survivor_histogram),
        placement_spread_rounds: aggregate.authoritative_rounds,
        healthy_placement_spread_rounds: aggregate.healthy_placement_spread_rounds,
        placement_spread_rate_per_mille: optional_rate_per_mille(
            aggregate.healthy_placement_spread_rounds,
            aggregate.authoritative_rounds,
        ),
        no_elimination_rounds: aggregate.no_elimination_rounds,
        no_elimination_rate_per_mille: optional_rate_per_mille(
            aggregate.no_elimination_rounds,
            aggregate.authoritative_rounds,
        ),
        early_mass_wipe_rounds: aggregate.early_mass_wipe_rounds,
        early_mass_wipe_rate_per_mille: optional_rate_per_mille(
            aggregate.early_mass_wipe_rounds,
            aggregate.authoritative_rounds,
        ),
        elimination_step_distribution: Some(elimination_step_distribution),
        elimination_step_distribution_note: ELIMINATION_STEP_DISTRIBUTION_NOTE.to_owned(),
        dead_player_eliminations: aggregate.dead_player_eliminations,
        dead_player_responses_within_five_seconds: aggregate
            .dead_player_responses_within_five_seconds,
        dead_player_response_rate_per_mille: optional_rate_per_mille(
            aggregate.dead_player_responses_within_five_seconds,
            aggregate.dead_player_eliminations,
        ),
        dead_player_response_note: DEAD_PLAYER_RESPONSE_NOTE.to_owned(),
        share_intent_rounds: aggregate.share_opened_rounds,
        share_intent_rate_per_mille: optional_rate_per_mille(
            aggregate.share_opened_rounds,
            aggregate.authoritative_rounds,
        ),
        clip_exported_rounds: aggregate.clip_exported_rounds,
        clip_export_rate_per_mille: optional_rate_per_mille(
            aggregate.clip_exported_rounds,
            aggregate.authoritative_rounds,
        ),
    }
}

impl RoundService {
    pub async fn issue_session(
        &self,
        request: CreateSessionRequest,
        ip: Option<IpAddr>,
    ) -> Result<IssuedSessionDto, ServiceError> {
        let now = self.clock.now_ms();
        let ip_hash = self.ip_scope_hash(ip);
        self.enforce_limit(&ip_hash, "session_issue", now, 5, 60 * 60 * 1_000)
            .await?;
        let invite_code_hash = match request.invite_code.as_deref() {
            Some(code) => Some(invite_code_digest(code)?),
            None => None,
        };
        if self.alpha_config.invite_required
            && invite_code_hash
                .as_ref()
                .is_none_or(|digest| !self.alpha_config.invite_code_hashes.contains(digest))
        {
            return Err(ServiceError::Forbidden(
                "a valid closed-alpha invite is required",
            ));
        }
        let requested_handle = request.handle.as_deref().map(validate_handle).transpose()?;
        for _ in 0..8 {
            let id = Uuid::new_v4().to_string();
            let handle = requested_handle
                .clone()
                .unwrap_or_else(|| generated_handle(&id));
            let token = generate_bearer_token()?;
            let token_hash = bearer_token_digest(&token)
                .ok_or_else(|| ServiceError::Computation("generated invalid token".to_owned()))?;
            let session = SessionRecord {
                id: id.clone(),
                revision: 0,
                token_hash,
                handle_key: handle.to_ascii_lowercase(),
                handle,
                telemetry_consent: request.telemetry_consent,
                experiments: assign_experiments(&id, &self.alpha_config.experiments),
                invite_code_hash: invite_code_hash.clone(),
                creation_ip_hash: ip_hash.clone(),
                created_at_ms: now,
                expires_at_ms: now
                    .checked_add(self.alpha_config.session_ttl_ms)
                    .ok_or_else(|| {
                        ServiceError::Computation("session expiry overflow".to_owned())
                    })?,
                rotated_at_ms: None,
                last_renamed_at_ms: None,
                revoked_at_ms: None,
            };
            match self.repository.create_session(session.clone()).await {
                Ok(()) => {
                    return Ok(IssuedSessionDto {
                        token,
                        session: session_view(&session),
                    });
                }
                Err(crate::RepositoryError::AlreadyExists) if requested_handle.is_none() => {}
                Err(crate::RepositoryError::AlreadyExists) => {
                    return Err(ServiceError::Conflict);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(ServiceError::RandomUnavailable)
    }

    pub async fn session_view(&self, bearer: &str) -> Result<SessionViewDto, ServiceError> {
        self.authenticate_session(bearer)
            .await
            .map(|session| session_view(&session))
    }

    pub async fn session_view_for_ip(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
    ) -> Result<SessionViewDto, ServiceError> {
        self.authenticate_for_action(bearer, ip, "session_read", 120, 60_000)
            .await
            .map(|session| session_view(&session))
    }

    pub async fn rename_session(
        &self,
        bearer: &str,
        request: RenameSessionRequest,
        ip: Option<IpAddr>,
    ) -> Result<SessionViewDto, ServiceError> {
        let now = self.clock.now_ms();
        let mut session = self
            .authenticate_for_action(bearer, ip, "session_rename", 3, 86_400_000)
            .await?;
        let handle = validate_handle(&request.handle)?;
        if session.handle == handle {
            return Ok(session_view(&session));
        }
        let expected_revision = session.revision;
        session.handle_key = handle.to_ascii_lowercase();
        session.handle = handle;
        session.last_renamed_at_ms = Some(now);
        match self
            .repository
            .save_session(expected_revision, session.clone())
            .await
        {
            Ok(()) => {
                session.revision = expected_revision + 1;
                Ok(session_view(&session))
            }
            Err(crate::RepositoryError::AlreadyExists) => Err(ServiceError::Conflict),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn rotate_session(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
    ) -> Result<IssuedSessionDto, ServiceError> {
        let now = self.clock.now_ms();
        let mut session = self
            .authenticate_for_action(bearer, ip, "session_rotate", 5, 86_400_000)
            .await?;
        let token = generate_bearer_token()?;
        let token_hash = bearer_token_digest(&token)
            .ok_or_else(|| ServiceError::Computation("generated invalid token".to_owned()))?;
        let expected_revision = session.revision;
        session.token_hash = token_hash;
        session.rotated_at_ms = Some(now);
        session.expires_at_ms = now
            .checked_add(self.alpha_config.session_ttl_ms)
            .ok_or_else(|| ServiceError::Computation("session expiry overflow".to_owned()))?;
        self.repository
            .save_session(expected_revision, session.clone())
            .await?;
        session.revision = expected_revision + 1;
        Ok(IssuedSessionDto {
            token,
            session: session_view(&session),
        })
    }

    pub async fn update_telemetry_consent(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        request: TelemetryConsentRequest,
    ) -> Result<SessionViewDto, ServiceError> {
        let mut session = self
            .authenticate_for_action(bearer, ip, "telemetry_consent", 12, 86_400_000)
            .await?;
        if session.telemetry_consent == request.consent {
            return Ok(session_view(&session));
        }
        let expected_revision = session.revision;
        session.telemetry_consent = request.consent;
        self.repository
            .save_session(expected_revision, session.clone())
            .await?;
        session.revision = expected_revision + 1;
        Ok(session_view(&session))
    }

    pub async fn create_round_for_bearer(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        request: CreateRoundRequest,
    ) -> Result<CreateRoundResponse, ServiceError> {
        let session = self
            .authenticate_for_action(bearer, ip, "round_create", 8, 5 * 60 * 1_000)
            .await?;
        self.create_round_for_session(request, SessionContext::from(&session))
            .await
    }

    pub(crate) async fn authorize_round_bearer(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        round_id: &str,
        action: &'static str,
        limit: u32,
    ) -> Result<SessionContext, ServiceError> {
        let session = self
            .authenticate_for_action(bearer, ip, action, limit, 60_000)
            .await?;
        let round = self.load(round_id).await?;
        if round.session_id.as_deref() != Some(&session.id) {
            return Err(ServiceError::Forbidden("round belongs to another session"));
        }
        Ok(SessionContext::from(&session))
    }

    pub async fn leaderboard(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        deck_id: &str,
        query: LeaderboardQuery,
    ) -> Result<LeaderboardResponse, ServiceError> {
        let session = self
            .authenticate_for_action(bearer, ip, "leaderboard_read", 60, 60_000)
            .await?;
        let now = self.clock.now_ms();
        let deck = deck_by_id(deck_id)
            .ok_or_else(|| ServiceError::InvalidRequest(format!("unknown deck '{deck_id}'")))?;
        let window = query.window.unwrap_or(LeaderboardWindow::Daily);
        let limit = query.limit.unwrap_or(25).clamp(1, 100);
        let offset = decode_cursor(query.cursor.as_deref())?;
        if offset > 10_000 {
            return Err(ServiceError::InvalidRequest(
                "leaderboard cursor is outside the closed-alpha window".to_owned(),
            ));
        }
        let cutoff = now.saturating_sub(window.duration_ms());
        let mut candidates = self
            .repository
            .list_leaderboard_entries(deck_id, deck.version, cutoff, LEADERBOARD_CANDIDATE_CAP)
            .await?;
        rank_leaderboard(&mut candidates);
        let ranked = best_per_session(candidates, &session.id)?;
        let self_entry = ranked.iter().find(|entry| entry.is_self).cloned();
        let page: Vec<_> = ranked
            .iter()
            .skip(offset)
            .take(usize::from(limit))
            .cloned()
            .collect();
        let next_offset = offset.saturating_add(page.len());
        let next_cursor = (next_offset < ranked.len()).then(|| encode_cursor(next_offset));
        Ok(LeaderboardResponse {
            deck_id: deck_id.to_owned(),
            deck_version: deck.version,
            window,
            generated_at_ms: now,
            entries: page,
            self_entry,
            next_cursor,
        })
    }

    pub async fn public_replay(
        &self,
        round_id: &str,
        ip: Option<IpAddr>,
    ) -> Result<PublicReplayResponseDto, ServiceError> {
        if Uuid::parse_str(round_id)
            .ok()
            .is_none_or(|id| id.to_string() != round_id)
        {
            return Err(ServiceError::NotFound);
        }
        let now = self.clock.now_ms();
        let ip_scope = self.ip_scope_hash(ip);
        self.enforce_limit(&ip_scope, "public_replay", now, 60, 60_000)
            .await?;
        let round = self.load(round_id).await?;
        let verified = round.result.as_ref().is_some_and(|result| {
            round
                .replay_verification
                .as_ref()
                .is_some_and(|receipt| receipt.proof_digest == result.proof_digest)
        });
        if !verified {
            return Err(ServiceError::NotFound);
        }
        let replay = round
            .replay_bundle()
            .ok_or_else(|| ServiceError::Computation("verified replay is incomplete".to_owned()))?;
        Ok(PublicReplayResponseDto {
            anchor: PublicReplayAnchorDto {
                round_id: round.id,
                protocol_version: round.protocol_version,
                commitment: hex::encode(round.commitment),
                server_verifying_key: round.server_verifying_key,
                experiment_assignments: round.experiment_assignments,
            },
            replay,
        })
    }

    pub async fn ingest_telemetry(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        request: TelemetryBatchRequest,
    ) -> Result<TelemetryBatchResponse, ServiceError> {
        let session = self
            .authenticate_for_action(bearer, ip, "telemetry_batch", 30, 60_000)
            .await?;
        if !session.telemetry_consent {
            return Err(ServiceError::Forbidden("telemetry consent is not enabled"));
        }
        let now = self.clock.now_ms();
        if serde_json::to_vec(&request)?.len() > MAX_TELEMETRY_BYTES {
            return Err(ServiceError::InvalidRequest(
                "telemetry batch exceeds 32 KiB".to_owned(),
            ));
        }
        if request.schema_version != TELEMETRY_SCHEMA_VERSION {
            return Err(ServiceError::InvalidRequest(
                "unsupported telemetry schemaVersion".to_owned(),
            ));
        }
        if request.events.is_empty() || request.events.len() > MAX_TELEMETRY_EVENTS {
            return Err(ServiceError::InvalidRequest(
                "telemetry batch must contain 1-50 events".to_owned(),
            ));
        }
        let retention_ms = u64::from(self.alpha_config.telemetry_retention_days)
            .checked_mul(86_400_000)
            .ok_or_else(|| ServiceError::Computation("telemetry retention overflow".to_owned()))?;
        let mut ids = BTreeSet::new();
        let mut records = Vec::with_capacity(request.events.len());
        for event in request.events {
            let event_id = Uuid::parse_str(&event.event_id)
                .map_err(|_| ServiceError::InvalidRequest("invalid telemetry eventId".to_owned()))?
                .to_string();
            if !ids.insert(event_id.clone()) {
                return Err(ServiceError::InvalidRequest(
                    "duplicate eventId inside telemetry batch".to_owned(),
                ));
            }
            if event.occurred_at_ms < now.saturating_sub(86_400_000)
                || event.occurred_at_ms > now.saturating_add(5 * 60_000)
            {
                return Err(ServiceError::InvalidRequest(
                    "telemetry occurredAtMs is outside the accepted time window".to_owned(),
                ));
            }
            let validated = self
                .validate_telemetry_event(&session, &event.name, event.properties, now)
                .await?;
            let occurred_at_ms = if matches!(
                event.name.as_str(),
                "dead_player_response" | "share_opened" | "clip_exported"
            ) {
                now
            } else {
                event.occurred_at_ms
            };
            records.push(TelemetryRecord {
                event_id,
                session_id: session.id.clone(),
                event_name: event.name,
                occurred_at_ms,
                received_at_ms: now,
                deck_id: validated.deck_id,
                round_id: validated.round_id,
                properties: Value::Object(validated.properties),
                experiment_assignments: validated.experiment_assignments,
                retention_until_ms: now.checked_add(retention_ms).ok_or_else(|| {
                    ServiceError::Computation("telemetry expiry overflow".to_owned())
                })?,
            });
        }
        let inserted = self.repository.insert_telemetry(&records).await?;
        Ok(TelemetryBatchResponse {
            accepted: inserted.accepted,
            duplicates: inserted.duplicates,
        })
    }

    pub async fn telemetry_metrics(
        &self,
        bearer: &str,
        query: TelemetryMetricsQuery,
    ) -> Result<TelemetryMetricsResponse, ServiceError> {
        let supplied = secret_digest("strikefall/metrics-token/v1", bearer);
        if self
            .alpha_config
            .metrics_token_hash
            .as_ref()
            .is_none_or(|expected| expected != &supplied)
        {
            return Err(ServiceError::Unauthorized("invalid metrics credential"));
        }
        let now = self.clock.now_ms();
        let hours = query.window_hours.unwrap_or(24);
        if !(1..=168).contains(&hours) {
            return Err(ServiceError::InvalidRequest(
                "windowHours must be between 1 and 168".to_owned(),
            ));
        }
        if let Some(deck_id) = &query.deck_id {
            if deck_by_id(deck_id).is_none() {
                return Err(ServiceError::InvalidRequest(format!(
                    "unknown deck '{deck_id}'"
                )));
            }
        }
        let start = now.saturating_sub(u64::from(hours) * 60 * 60 * 1_000);
        let aggregate = self
            .repository
            .telemetry_aggregate(start, now, query.deck_id.as_deref())
            .await?;
        let started = aggregate.overall.distinct_round_starts;
        let completed = aggregate
            .overall
            .player_outcome_counts
            .values()
            .copied()
            .sum();
        let completion_rate_per_mille = completion_rate(started, completed);
        let error_rate_available = query.deck_id.is_none();
        let overall_product_metrics = product_metrics(&aggregate.overall, error_rate_available);
        let experiment_cuts = aggregate
            .experiment_aggregates
            .into_iter()
            .flat_map(|(experiment_key, variants)| {
                variants.into_iter().map(move |(variant, aggregate)| {
                    let started = aggregate.distinct_round_starts;
                    let completed = aggregate.player_outcome_counts.values().copied().sum();
                    let product_metrics = product_metrics(&aggregate, error_rate_available);
                    ExperimentTelemetryCutDto {
                        experiment_key: experiment_key.clone(),
                        variant,
                        completion_rate_per_mille: completion_rate(started, completed),
                        counts: aggregate.counts,
                        product_metrics,
                    }
                })
            })
            .collect();
        Ok(TelemetryMetricsResponse {
            schema_version: TELEMETRY_SCHEMA_VERSION.to_owned(),
            window_start_ms: start,
            window_end_ms: now,
            deck_id: query.deck_id,
            counts: aggregate.overall.counts,
            completion_rate_per_mille,
            product_metrics: overall_product_metrics,
            experiment_cuts,
        })
    }

    pub(crate) async fn authenticate_session(
        &self,
        bearer: &str,
    ) -> Result<SessionRecord, ServiceError> {
        let token_hash = bearer_token_digest(bearer)
            .ok_or(ServiceError::Unauthorized("invalid bearer token"))?;
        let session = self
            .repository
            .load_session_by_token_hash(&token_hash)
            .await?
            .ok_or(ServiceError::Unauthorized("invalid bearer token"))?;
        let now = self.clock.now_ms();
        if session.revoked_at_ms.is_some() || now >= session.expires_at_ms {
            return Err(ServiceError::Unauthorized("session has expired"));
        }
        Ok(session)
    }

    async fn authenticate_for_action(
        &self,
        bearer: &str,
        ip: Option<IpAddr>,
        action: &'static str,
        limit: u32,
        window_ms: u64,
    ) -> Result<SessionRecord, ServiceError> {
        let now = self.clock.now_ms();
        let ip_scope = self.ip_scope_hash(ip);
        self.enforce_limit(&ip_scope, action, now, limit.saturating_mul(4), window_ms)
            .await?;
        let session = self.authenticate_session(bearer).await?;
        let session_scope = secret_digest("strikefall/abuse-session/v1", &session.id);
        self.enforce_limit(&session_scope, action, now, limit, window_ms)
            .await?;
        Ok(session)
    }

    async fn enforce_limit(
        &self,
        scope: &str,
        action: &str,
        now: u64,
        limit: u32,
        window_ms: u64,
    ) -> Result<(), ServiceError> {
        let window_started_ms = now / window_ms * window_ms;
        let outcome = self
            .repository
            .consume_rate_limit(scope, action, window_started_ms, window_ms, limit, now)
            .await?;
        if outcome.allowed {
            Ok(())
        } else {
            Err(ServiceError::AbuseRateLimited(outcome.retry_after_ms))
        }
    }

    fn ip_scope_hash(&self, ip: Option<IpAddr>) -> String {
        let ip = ip.map_or_else(|| "unavailable".to_owned(), |value| value.to_string());
        hex::encode(hash_framed(
            b"strikefall/abuse-ip/v1",
            [self.signing_key.to_bytes().as_slice(), ip.as_bytes()],
        ))
    }

    async fn validate_telemetry_event(
        &self,
        session: &SessionRecord,
        name: &str,
        properties: Value,
        received_at_ms: u64,
    ) -> Result<ValidatedTelemetry, ServiceError> {
        let mut properties = properties.as_object().cloned().ok_or_else(|| {
            ServiceError::InvalidRequest("telemetry properties must be an object".to_owned())
        })?;
        let references = validate_telemetry_shape(name, &properties)?;
        let experiment_assignments = if references.round_id.is_some() {
            self.validate_authoritative_telemetry(
                session,
                name,
                &mut properties,
                &references,
                received_at_ms,
            )
            .await?
        } else {
            session.experiments.clone()
        };
        Ok(ValidatedTelemetry {
            deck_id: references.deck_id,
            round_id: references.round_id,
            properties,
            experiment_assignments,
        })
    }

    async fn validate_authoritative_telemetry(
        &self,
        session: &SessionRecord,
        name: &str,
        properties: &mut Map<String, Value>,
        references: &TelemetryReferences,
        received_at_ms: u64,
    ) -> Result<BTreeMap<String, String>, ServiceError> {
        let deck_id = references
            .deck_id
            .as_deref()
            .ok_or_else(|| ServiceError::InvalidRequest("deckId is required".to_owned()))?;
        let deck = deck_by_id(deck_id).ok_or_else(|| {
            ServiceError::InvalidRequest("telemetry deckId is unknown".to_owned())
        })?;
        let round_id = references
            .round_id
            .as_deref()
            .ok_or_else(|| ServiceError::InvalidRequest("roundId is required".to_owned()))?;
        let round = self.load(round_id).await?;
        if round.session_id.as_deref() != Some(&session.id) || round.deck_id != deck.id.as_str() {
            return Err(ServiceError::Forbidden(
                "telemetry round does not belong to this session",
            ));
        }
        match name {
            "placement_locked" => {
                validate_placement_telemetry(&round, properties)?;
                enrich_placement_metrics(&round, properties)?;
                Ok(())
            }
            "escape_used" => validate_escape_telemetry(&round, properties),
            "round_completed" => {
                validate_completed_telemetry(&round, properties)?;
                enrich_completed_metrics(&round, properties)?;
                Ok(())
            }
            "dead_player_response" => {
                validate_dead_player_response(&round, properties, received_at_ms)
            }
            "share_opened" | "clip_exported" if round.status != RoundStatusDto::Resolved => {
                Err(ServiceError::InvalidRequest(
                    "share telemetry requires a resolved round".to_owned(),
                ))
            }
            "replay_verified" if round.replay_verification.is_none() => {
                Err(ServiceError::InvalidRequest(
                    "replay telemetry requires an acknowledged verification".to_owned(),
                ))
            }
            _ => Ok(()),
        }?;
        Ok(round.experiment_assignments)
    }
}

struct ValidatedTelemetry {
    deck_id: Option<String>,
    round_id: Option<String>,
    properties: Map<String, Value>,
    experiment_assignments: BTreeMap<String, String>,
}

#[derive(Default)]
struct TelemetryReferences {
    deck_id: Option<String>,
    round_id: Option<String>,
}

fn validate_telemetry_shape(
    name: &str,
    properties: &Map<String, Value>,
) -> Result<TelemetryReferences, ServiceError> {
    match name {
        "round_started" | "replay_verified" => {
            exact_keys(properties, &["deckId", "roundId"])?;
            round_references(properties)
        }
        "placement_locked" => {
            exact_keys(properties, &["deckId", "roundId", "side"])?;
            enum_property(properties, "side", &["upper", "lower"])?;
            round_references(properties)
        }
        "escape_used" => {
            exact_keys(properties, &["deckId", "roundId", "step"])?;
            if !(1..=10_000).contains(&integer_property(properties, "step")?) {
                return Err(ServiceError::InvalidRequest(
                    "invalid telemetry Escape step".to_owned(),
                ));
            }
            round_references(properties)
        }
        "round_completed" => validate_completed_shape(properties),
        "dead_player_response" => {
            exact_keys(properties, &["action", "deckId", "roundId"])?;
            enum_property(properties, "action", &["spectate", "rematch"])?;
            round_references(properties)
        }
        "share_opened" | "clip_exported" => {
            exact_keys(properties, &["deckId", "roundId"])?;
            round_references(properties)
        }
        "ui_performance" => validate_performance_shape(properties),
        "client_error" => validate_client_error_shape(properties),
        _ => Err(ServiceError::InvalidRequest(
            "telemetry event name is not in the v2 whitelist".to_owned(),
        )),
    }
}

fn round_references(properties: &Map<String, Value>) -> Result<TelemetryReferences, ServiceError> {
    Ok(TelemetryReferences {
        deck_id: Some(string_property(properties, "deckId")?),
        round_id: Some(string_property(properties, "roundId")?),
    })
}

fn validate_completed_shape(
    properties: &Map<String, Value>,
) -> Result<TelemetryReferences, ServiceError> {
    exact_keys(
        properties,
        &["deckId", "durationMs", "outcome", "rank", "roundId"],
    )?;
    enum_property(
        properties,
        "outcome",
        &["survived", "eliminated", "escaped"],
    )?;
    let rank = integer_property(properties, "rank")?;
    let duration = integer_property(properties, "durationMs")?;
    if !(1..=20).contains(&rank) || !(1_000..=300_000).contains(&duration) {
        return Err(ServiceError::InvalidRequest(
            "invalid round-completed telemetry bounds".to_owned(),
        ));
    }
    round_references(properties)
}

fn validate_performance_shape(
    properties: &Map<String, Value>,
) -> Result<TelemetryReferences, ServiceError> {
    exact_keys(properties, &["fpsBucket", "reducedMotion", "screen"])?;
    enum_property(
        properties,
        "fpsBucket",
        &["under_30", "30_49", "50_59", "60"],
    )?;
    enum_property(properties, "screen", &["onboarding", "arena", "results"])?;
    if !properties
        .get("reducedMotion")
        .is_some_and(Value::is_boolean)
    {
        return Err(ServiceError::InvalidRequest(
            "reducedMotion must be boolean".to_owned(),
        ));
    }
    Ok(TelemetryReferences::default())
}

fn validate_client_error_shape(
    properties: &Map<String, Value>,
) -> Result<TelemetryReferences, ServiceError> {
    exact_keys(properties, &["code", "surface"])?;
    enum_property(
        properties,
        "surface",
        &["session", "arena", "replay", "leaderboard"],
    )?;
    enum_property(
        properties,
        "code",
        &[
            "request_failed",
            "session_expired",
            "stream_disconnected",
            "unsupported_protocol",
            "verification_failed",
            "uncaught_exception",
            "unhandled_rejection",
            "render_failure",
        ],
    )?;
    Ok(TelemetryReferences::default())
}

fn validate_placement_telemetry(
    round: &crate::RoundRecord,
    properties: &Map<String, Value>,
) -> Result<(), ServiceError> {
    let side = properties.get("side").and_then(Value::as_str);
    let expected_side = round
        .placements
        .iter()
        .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
        .map(|placement| match placement.side {
            strikefall_protocol::SideDto::Upper => "upper",
            strikefall_protocol::SideDto::Lower => "lower",
        });
    if round.locked_scores.is_empty() || side != expected_side {
        return Err(ServiceError::InvalidRequest(
            "placement telemetry does not match authoritative round state".to_owned(),
        ));
    }
    Ok(())
}

fn validate_escape_telemetry(
    round: &crate::RoundRecord,
    properties: &Map<String, Value>,
) -> Result<(), ServiceError> {
    let step = integer_property(properties, "step")?;
    if round.escape.as_ref().map(|escape| u64::from(escape.step)) != Some(step) {
        return Err(ServiceError::InvalidRequest(
            "Escape telemetry does not match authoritative round state".to_owned(),
        ));
    }
    Ok(())
}

fn validate_completed_telemetry(
    round: &crate::RoundRecord,
    properties: &Map<String, Value>,
) -> Result<(), ServiceError> {
    let result = round.result.as_ref().ok_or_else(|| {
        ServiceError::InvalidRequest(
            "round-completed telemetry requires a resolved round".to_owned(),
        )
    })?;
    let expected_outcome = match result.outcome {
        ContenderOutcomeDto::Survived => "survived",
        ContenderOutcomeDto::Eliminated => "eliminated",
        ContenderOutcomeDto::Escaped => "escaped",
    };
    if properties.get("outcome").and_then(Value::as_str) != Some(expected_outcome)
        || integer_property(properties, "rank")? != u64::from(result.rank)
    {
        return Err(ServiceError::InvalidRequest(
            "round-completed telemetry does not match authoritative result".to_owned(),
        ));
    }
    Ok(())
}

fn bounded_count(value: usize, field: &str) -> Result<u64, ServiceError> {
    u64::try_from(value).map_err(|_| ServiceError::Computation(format!("{field} count overflow")))
}

fn enrich_placement_metrics(
    round: &crate::RoundRecord,
    properties: &mut Map<String, Value>,
) -> Result<(), ServiceError> {
    if round.locked_scores.len() != round.placements.len() || round.locked_scores.is_empty() {
        return Err(ServiceError::Computation(
            "authoritative placement metrics are incomplete".to_owned(),
        ));
    }
    let upper = round
        .placements
        .iter()
        .filter(|placement| placement.side == SideDto::Upper)
        .count();
    let lower = round.placements.len().saturating_sub(upper);
    let mut risk_bands = BTreeSet::new();
    for score in &round.locked_scores {
        let survival = score.initial_survival.parse::<u128>().map_err(|_| {
            ServiceError::Computation("authoritative survival probability is invalid".to_owned())
        })?;
        if survival > SCALE {
            return Err(ServiceError::Computation(
                "authoritative survival probability exceeds one".to_owned(),
            ));
        }
        let band = survival
            .saturating_mul(10)
            .checked_div(SCALE)
            .unwrap_or(0)
            .min(9);
        risk_bands.insert(u8::try_from(band).unwrap_or(9));
    }
    let player_flag_revisions = round
        .events
        .iter()
        .filter(|event| {
            matches!(
                event.kind,
                RoundEventKindDto::FlagMoved {
                    actor: EventActorDto::Player,
                    ..
                }
            )
        })
        .count();
    properties.insert(
        "_playerFlagRevisions".to_owned(),
        Value::from(bounded_count(
            player_flag_revisions,
            "player flag revision",
        )?),
    );
    properties.insert(
        "_upperPlacements".to_owned(),
        Value::from(bounded_count(upper, "upper placement")?),
    );
    properties.insert(
        "_lowerPlacements".to_owned(),
        Value::from(bounded_count(lower, "lower placement")?),
    );
    properties.insert(
        "_populatedRiskBands".to_owned(),
        Value::from(bounded_count(risk_bands.len(), "risk band")?),
    );
    Ok(())
}

fn enrich_completed_metrics(
    round: &crate::RoundRecord,
    properties: &mut Map<String, Value>,
) -> Result<(), ServiceError> {
    enrich_placement_metrics(round, properties)?;
    let result = round.result.as_ref().ok_or_else(|| {
        ServiceError::Computation("authoritative result metrics are incomplete".to_owned())
    })?;
    let eliminated = result
        .contenders
        .iter()
        .filter(|contender| contender.outcome == ContenderOutcomeDto::Eliminated)
        .count();
    let player_elimination_step = result
        .contenders
        .iter()
        .find(|contender| contender.contender_id == PLAYER_CONTENDER_ID)
        .and_then(|contender| contender.touch_step);
    let battle_started_at_ms = round.battle_started_at_ms.ok_or_else(|| {
        ServiceError::Computation("authoritative battle start is unavailable".to_owned())
    })?;
    let early_mass_wipe = round.events.iter().any(|event| {
        matches!(
            &event.kind,
            RoundEventKindDto::FlagCluster { cluster } if cluster.contender_ids.len() >= 3
        ) && event.server_time_ms >= battle_started_at_ms
            && event.server_time_ms <= battle_started_at_ms.saturating_add(10_000)
    });
    properties.insert("_survivors".to_owned(), Value::from(result.survivors));
    properties.insert(
        "_eliminated".to_owned(),
        Value::from(bounded_count(eliminated, "eliminated contender")?),
    );
    properties.insert("_earlyMassWipe".to_owned(), Value::from(early_mass_wipe));
    properties.insert(
        "_playerEliminationStep".to_owned(),
        player_elimination_step.map_or(Value::Null, Value::from),
    );
    Ok(())
}

fn validate_dead_player_response(
    round: &crate::RoundRecord,
    properties: &mut Map<String, Value>,
    received_at_ms: u64,
) -> Result<(), ServiceError> {
    let eliminated_at_ms = round
        .events
        .iter()
        .find_map(|event| match &event.kind {
            RoundEventKindDto::FlagHit { touch } if touch.contender_id == PLAYER_CONTENDER_ID => {
                Some(event.server_time_ms)
            }
            _ => None,
        })
        .ok_or_else(|| {
            ServiceError::InvalidRequest(
                "dead-player response requires an authoritative player elimination".to_owned(),
            )
        })?;
    if received_at_ms < eliminated_at_ms {
        return Err(ServiceError::InvalidRequest(
            "dead-player response predates the authoritative elimination".to_owned(),
        ));
    }
    properties.insert(
        "_withinFiveSeconds".to_owned(),
        Value::from(received_at_ms - eliminated_at_ms <= 5_000),
    );
    Ok(())
}

fn session_view(session: &SessionRecord) -> SessionViewDto {
    SessionViewDto {
        handle: session.handle.clone(),
        expires_at_ms: session.expires_at_ms,
        telemetry_consent: session.telemetry_consent,
        experiments: session.experiments.clone(),
    }
}

fn validate_handle(value: &str) -> Result<String, ServiceError> {
    if value.trim() != value
        || !(3..=20).contains(&value.len())
        || !value.bytes().all(valid_handle_byte)
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(ServiceError::InvalidRequest(
            "handle must be 3-20 ASCII letters, digits, '_' or '-', starting with a letter or digit"
                .to_owned(),
        ));
    }
    let key = value.to_ascii_lowercase();
    if [
        "admin",
        "moderator",
        "strikefall",
        "system",
        "support",
        "bot",
        "you",
    ]
    .contains(&key.as_str())
    {
        return Err(ServiceError::InvalidRequest(
            "handle is reserved".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn valid_handle_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn generated_handle(session_id: &str) -> String {
    let digest = hash_framed(b"strikefall/anonymous-handle/v1", [session_id.as_bytes()]);
    format!("Rider-{}", &hex::encode(digest)[..8])
}

fn generate_bearer_token() -> Result<String, ServiceError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ServiceError::RandomUnavailable)?;
    Ok(format!("{TOKEN_PREFIX}{}", hex::encode(bytes)))
}

#[must_use]
pub fn bearer_token_digest(token: &str) -> Option<String> {
    let encoded = token.strip_prefix(TOKEN_PREFIX)?;
    if encoded.len() != 64 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(secret_digest("strikefall/session-token/v1", token))
}

pub fn invite_code_digest(code: &str) -> Result<String, ServiceError> {
    if !(8..=128).contains(&code.len()) || code.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err(ServiceError::Forbidden(
            "a valid closed-alpha invite is required",
        ));
    }
    Ok(secret_digest("strikefall/invite-code/v1", code))
}

#[must_use]
pub fn metrics_token_digest(token: &str) -> String {
    secret_digest("strikefall/metrics-token/v1", token)
}

fn secret_digest(domain: &str, value: &str) -> String {
    hex::encode(hash_framed(domain.as_bytes(), [value.as_bytes()]))
}

fn assign_experiments(
    session_id: &str,
    experiments: &BTreeMap<String, Vec<String>>,
) -> BTreeMap<String, String> {
    experiments
        .iter()
        .filter_map(|(name, variants)| {
            if variants.is_empty() {
                return None;
            }
            let digest = hash_framed(
                b"strikefall/experiment-assignment/v1",
                [session_id.as_bytes(), name.as_bytes()],
            );
            let index = usize::from(digest[0]) % variants.len();
            Some((name.clone(), variants[index].clone()))
        })
        .collect()
}

fn rank_leaderboard(entries: &mut [AuthoritativeLeaderboardEntry]) {
    entries.sort_by(|left, right| {
        let left_score = left.score.parse::<u128>().unwrap_or(0);
        let right_score = right.score.parse::<u128>().unwrap_or(0);
        right_score
            .cmp(&left_score)
            .then_with(|| left.resolved_at_ms.cmp(&right.resolved_at_ms))
            .then_with(|| left.round_id.cmp(&right.round_id))
    });
}

fn best_per_session(
    entries: Vec<AuthoritativeLeaderboardEntry>,
    session_id: &str,
) -> Result<Vec<LeaderboardEntryDto>, ServiceError> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for entry in entries {
        if !seen.insert(entry.session_id.clone()) {
            continue;
        }
        let rank = u32::try_from(result.len() + 1)
            .map_err(|_| ServiceError::Computation("leaderboard rank overflow".to_owned()))?;
        result.push(LeaderboardEntryDto {
            rank,
            handle: entry.handle,
            score: entry.score,
            outcome: entry.outcome,
            round_id: entry.round_id,
            resolved_at_ms: entry.resolved_at_ms,
            is_self: entry.session_id == session_id,
        });
    }
    Ok(result)
}

fn encode_cursor(offset: usize) -> String {
    format!("v1-{offset:x}")
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, ServiceError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let encoded = cursor
        .strip_prefix("v1-")
        .ok_or_else(|| ServiceError::InvalidRequest("invalid leaderboard cursor".to_owned()))?;
    usize::from_str_radix(encoded, 16)
        .map_err(|_| ServiceError::InvalidRequest("invalid leaderboard cursor".to_owned()))
}

fn exact_keys(properties: &Map<String, Value>, expected: &[&str]) -> Result<(), ServiceError> {
    let keys: BTreeSet<_> = properties.keys().map(String::as_str).collect();
    let expected: BTreeSet<_> = expected.iter().copied().collect();
    if keys != expected {
        return Err(ServiceError::InvalidRequest(
            "telemetry properties do not match the v1 event schema".to_owned(),
        ));
    }
    Ok(())
}

fn string_property(properties: &Map<String, Value>, key: &str) -> Result<String, ServiceError> {
    let value = properties
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::InvalidRequest(format!("{key} must be a string")))?;
    if value.is_empty() || value.len() > 64 {
        return Err(ServiceError::InvalidRequest(format!(
            "{key} is outside its size bound"
        )));
    }
    Ok(value.to_owned())
}

fn integer_property(properties: &Map<String, Value>, key: &str) -> Result<u64, ServiceError> {
    properties
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ServiceError::InvalidRequest(format!("{key} must be an unsigned integer")))
}

fn enum_property(
    properties: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<(), ServiceError> {
    let value = properties
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::InvalidRequest(format!("{key} must be a string enum")))?;
    if !allowed.contains(&value) {
        return Err(ServiceError::InvalidRequest(format!(
            "{key} has an unsupported value"
        )));
    }
    Ok(())
}

impl From<serde_json::Error> for ServiceError {
    fn from(value: serde_json::Error) -> Self {
        Self::InvalidRequest(format!("invalid JSON payload: {value}"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        assign_experiments, best_per_session, decode_cursor, default_experiments, encode_cursor,
        product_metrics, rank_leaderboard, shipped_experiments, validate_handle,
        validate_telemetry_shape, AuthoritativeLeaderboardEntry, G4ErrorRateStatusDto,
        TelemetryAggregateSlice, DECK_STRUCTURE_EXPERIMENT, ESCAPE_EXPERIMENT,
        G4_MINIMUM_SAMPLE_SESSIONS, RISK_DISPLAY_EXPERIMENT,
    };

    #[test]
    fn handles_and_cursors_are_bounded() {
        assert_eq!(
            validate_handle("Neon_Rider-7").expect("handle"),
            "Neon_Rider-7"
        );
        assert!(validate_handle(" admin").is_err());
        assert!(validate_handle("bot").is_err());
        assert!(validate_handle("🔥rider").is_err());
        assert_eq!(
            decode_cursor(Some(&encode_cursor(255))).expect("cursor"),
            255
        );
        assert!(decode_cursor(Some("255")).is_err());
    }

    #[test]
    fn authoritative_experiment_assignment_is_versioned_bounded_and_deterministic() {
        let catalog = shipped_experiments();
        let first = assign_experiments("stable-session", &catalog);
        let second = assign_experiments("stable-session", &catalog);
        assert_eq!(first, second);
        assert_eq!(
            first.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                DECK_STRUCTURE_EXPERIMENT,
                ESCAPE_EXPERIMENT,
                RISK_DISPLAY_EXPERIMENT,
            ]
        );
        assert!(matches!(
            first.get(DECK_STRUCTURE_EXPERIMENT).map(String::as_str),
            Some("flat" | "compression-break")
        ));
        assert!(matches!(
            first.get(ESCAPE_EXPERIMENT).map(String::as_str),
            Some("absent" | "midpoint")
        ));
        assert!(matches!(
            first.get(RISK_DISPLAY_EXPERIMENT).map(String::as_str),
            Some("probability" | "danger-band")
        ));

        let public = assign_experiments("public-session", &default_experiments());
        assert_eq!(
            public.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![ESCAPE_EXPERIMENT, RISK_DISPLAY_EXPERIMENT]
        );
    }

    #[test]
    fn client_runtime_errors_accept_only_bounded_codes_and_surfaces() {
        for code in [
            "uncaught_exception",
            "unhandled_rejection",
            "render_failure",
        ] {
            let properties = json!({ "code": code, "surface": "arena" });
            assert!(validate_telemetry_shape(
                "client_error",
                properties.as_object().expect("properties"),
            )
            .is_ok());
        }

        for properties in [
            json!({
                "code": "uncaught_exception",
                "message": "must-not-leave-the-client",
                "surface": "arena",
            }),
            json!({ "code": "private-error-name", "surface": "arena" }),
            json!({ "code": "render_failure", "surface": "/replay/private-id" }),
        ] {
            assert!(validate_telemetry_shape(
                "client_error",
                properties.as_object().expect("properties"),
            )
            .is_err());
        }
    }

    #[test]
    fn telemetry_v2_actions_accept_only_owned_round_reference_shapes() {
        for (name, properties) in [
            (
                "dead_player_response",
                json!({
                    "action": "spectate",
                    "deckId": "balanced_tape",
                    "roundId": "00000000-0000-0000-0000-000000000001",
                }),
            ),
            (
                "share_opened",
                json!({
                    "deckId": "balanced_tape",
                    "roundId": "00000000-0000-0000-0000-000000000001",
                }),
            ),
            (
                "clip_exported",
                json!({
                    "deckId": "balanced_tape",
                    "roundId": "00000000-0000-0000-0000-000000000001",
                }),
            ),
        ] {
            assert!(
                validate_telemetry_shape(name, properties.as_object().expect("properties"),)
                    .is_ok()
            );
        }
        for (name, properties) in [
            (
                "dead_player_response",
                json!({
                    "action": "waited",
                    "deckId": "balanced_tape",
                    "roundId": "00000000-0000-0000-0000-000000000001",
                }),
            ),
            (
                "share_opened",
                json!({
                    "deckId": "balanced_tape",
                    "destination": "private-account",
                    "roundId": "00000000-0000-0000-0000-000000000001",
                }),
            ),
        ] {
            assert!(
                validate_telemetry_shape(name, properties.as_object().expect("properties"),)
                    .is_err()
            );
        }
    }

    #[test]
    fn g4_error_gate_is_strict_and_requires_the_declared_alpha_sample() {
        let metrics_for = |sessions, error_sessions| {
            product_metrics(
                &TelemetryAggregateSlice {
                    distinct_sessions: sessions,
                    client_error_sessions: error_sessions,
                    ..TelemetryAggregateSlice::default()
                },
                true,
            )
        };
        let insufficient = metrics_for(G4_MINIMUM_SAMPLE_SESSIONS - 1, 0);
        assert_eq!(
            insufficient.g4_error_status,
            G4ErrorRateStatusDto::Insufficient
        );
        assert_eq!(insufficient.g4_minimum_sessions, 50);

        let pass = metrics_for(50, 0);
        assert_eq!(pass.g4_error_status, G4ErrorRateStatusDto::Pass);
        assert_eq!(pass.error_session_rate_per_million, Some(0));

        let exact_threshold = metrics_for(100, 1);
        assert_eq!(exact_threshold.g4_error_status, G4ErrorRateStatusDto::Fail);
        assert_eq!(exact_threshold.error_session_rate_per_million, Some(10_000));

        let below_threshold = metrics_for(101, 1);
        assert_eq!(below_threshold.g4_error_status, G4ErrorRateStatusDto::Pass);
        assert_eq!(below_threshold.error_session_rate_per_million, Some(9_900));
    }

    #[test]
    fn leaderboard_ties_and_repeat_sessions_are_deterministic() {
        let entry =
            |round_id: &str, session_id: &str, resolved_at_ms: u64| AuthoritativeLeaderboardEntry {
                round_id: round_id.to_owned(),
                session_id: session_id.to_owned(),
                handle: format!("Rider-{session_id}"),
                deck_id: "balanced_tape".to_owned(),
                deck_version: 1,
                score: "5000".to_owned(),
                outcome: "survived".to_owned(),
                player_rank: 1,
                resolved_at_ms,
            };
        let mut entries = vec![
            entry("00000000-0000-0000-0000-000000000003", "beta", 20),
            entry("00000000-0000-0000-0000-000000000002", "alpha", 20),
            entry("00000000-0000-0000-0000-000000000001", "alpha", 10),
        ];
        rank_leaderboard(&mut entries);
        assert_eq!(entries[0].resolved_at_ms, 10);
        assert_eq!(entries[1].round_id, "00000000-0000-0000-0000-000000000002");
        assert_eq!(entries[2].round_id, "00000000-0000-0000-0000-000000000003");

        let ranked = best_per_session(entries, "beta").expect("rank tied entries");
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].rank, 1);
        assert_eq!(ranked[0].round_id, "00000000-0000-0000-0000-000000000001");
        assert_eq!(ranked[1].rank, 2);
        assert!(ranked[1].is_self);
    }
}
