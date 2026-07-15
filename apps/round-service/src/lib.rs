//! Authoritative, points-only ranked solo service for Strikefall.

#![forbid(unsafe_code)]

mod alpha;
mod alpha_repository;
mod api;
mod clock;
mod error;
mod model;
mod repository;
mod runtime;
mod service;

pub use alpha::{
    bearer_token_digest, default_experiments, invite_code_digest, metrics_token_digest,
    shipped_experiments, AuthoritativeLeaderboardEntry, ClosedAlphaConfig, CreateSessionRequest,
    ExperimentTelemetryCutDto, G4ErrorRateStatusDto, IssuedSessionDto, LeaderboardEntryDto,
    LeaderboardQuery, LeaderboardResponse, LeaderboardWindow, PublicReplayAnchorDto,
    PublicReplayResponseDto, RateLimitOutcome, RenameSessionRequest, SessionRecord, SessionViewDto,
    TelemetryAggregate, TelemetryAggregateSlice, TelemetryBatchRequest, TelemetryBatchResponse,
    TelemetryConsentRequest, TelemetryEventInput, TelemetryInsertResult, TelemetryMetricsQuery,
    TelemetryMetricsResponse, TelemetryProductMetricsDto, TelemetryRecord,
    DECK_STRUCTURE_EXPERIMENT, ESCAPE_EXPERIMENT, G4_MINIMUM_SAMPLE_SESSIONS,
    RISK_DISPLAY_EXPERIMENT, TELEMETRY_SCHEMA_VERSION,
};
pub use api::router;
pub use clock::{Clock, ManualClock, SystemClock};
pub use error::ServiceError;
pub use model::RoundRecord;
pub use repository::{
    AlphaRepository, InMemoryRoundRepository, PostgresRepositoryOptions, PostgresRoundRepository,
    RepositoryError, RoundRepository,
};
pub use runtime::{DeploymentMode, RepositoryKind, ServiceRuntime, StartupError};
pub use service::{RecoveryReport, RoundService, ServiceConfig};
