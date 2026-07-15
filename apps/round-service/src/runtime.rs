use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::SigningKey;
use thiserror::Error;

use crate::service::RECOVERY_CONCURRENCY_CEILING;
use crate::{
    invite_code_digest, metrics_token_digest, shipped_experiments, ClosedAlphaConfig,
    InMemoryRoundRepository, PostgresRepositoryOptions, PostgresRoundRepository, RepositoryError,
    RoundRepository, RoundService, ServiceConfig, SystemClock, ESCAPE_EXPERIMENT,
    RISK_DISPLAY_EXPERIMENT,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeploymentMode {
    Development,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepositoryKind {
    Memory,
    Postgres,
}

#[derive(Debug, Error)]
pub enum StartupError {
    #[error("invalid service environment: {0}")]
    InvalidEnvironment(String),
    #[error("signing key file '{path}' could not be read: {source}")]
    SigningKeyFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("repository startup failed: {0}")]
    Repository(#[from] RepositoryError),
    #[error("cryptographically secure randomness is unavailable")]
    RandomUnavailable,
}

pub struct ServiceRuntime {
    pub service: RoundService,
    pub deployment_mode: DeploymentMode,
    pub repository_kind: RepositoryKind,
    pub recovery_interval: Duration,
    pub recovery_batch_size: u32,
}

impl RoundService {
    /// Builds the runtime from environment variables with production fail-safe
    /// defaults: production refuses ephemeral keys and the memory repository.
    pub async fn from_environment() -> Result<ServiceRuntime, StartupError> {
        let deployment_mode = deployment_mode()?;
        let stream_topology = optional_env("STRIKEFALL_STREAM_TOPOLOGY")?;
        validate_stream_topology(deployment_mode, stream_topology.as_deref())?;
        let repository_kind = repository_kind(deployment_mode)?;
        let signing_key = load_signing_key(deployment_mode)?;
        let (repository, recovery_concurrency_limit): (Arc<dyn RoundRepository>, usize) =
            match repository_kind {
                RepositoryKind::Memory => (
                    InMemoryRoundRepository::shared(),
                    RECOVERY_CONCURRENCY_CEILING,
                ),
                RepositoryKind::Postgres => {
                    let database_url = required_env("DATABASE_URL")?;
                    let max_connections = env_number("STRIKEFALL_DB_MAX_CONNECTIONS", 10_u32)?;
                    let options = PostgresRepositoryOptions {
                        max_connections,
                        connect_timeout: Duration::from_millis(env_number(
                            "STRIKEFALL_DB_CONNECT_TIMEOUT_MS",
                            10_000_u64,
                        )?),
                        run_migrations: env_bool("STRIKEFALL_RUN_MIGRATIONS", true)?,
                        retention_days: env_number("STRIKEFALL_ROUND_RETENTION_DAYS", 30)?,
                    };
                    let pool_headroom = usize::try_from(max_connections.saturating_sub(2).max(1))
                        .unwrap_or(usize::MAX);
                    (
                        Arc::new(PostgresRoundRepository::connect(&database_url, options).await?),
                        pool_headroom.min(RECOVERY_CONCURRENCY_CEILING),
                    )
                }
            };
        let mut config = ServiceConfig {
            // The recovery worker is the single lifecycle mechanism for runtime
            // instances. This avoids relying on untracked per-round timers.
            auto_advance: false,
            ..ServiceConfig::default()
        };
        if let Some(origin) = optional_env("STRIKEFALL_ALLOWED_ORIGIN")? {
            config.allowed_origin = origin;
        }
        config.trust_proxy_headers = env_bool("STRIKEFALL_TRUST_PROXY", false)?;
        config.placement_duration_ms = env_number(
            "STRIKEFALL_PLACEMENT_DURATION_MS",
            config.placement_duration_ms,
        )?;
        config.input_freeze_ms = env_number("STRIKEFALL_INPUT_FREEZE_MS", config.input_freeze_ms)?;
        config.minimum_flag_update_interval_ms = env_number(
            "STRIKEFALL_FLAG_UPDATE_INTERVAL_MS",
            config.minimum_flag_update_interval_ms,
        )?;
        config.escape_close_before_end_ms = env_number(
            "STRIKEFALL_ESCAPE_CLOSE_MS",
            config.escape_close_before_end_ms,
        )?;
        config.recovery_concurrency = env_number(
            "STRIKEFALL_RECOVERY_CONCURRENCY",
            config.recovery_concurrency.min(recovery_concurrency_limit),
        )?;
        validate_recovery_concurrency(config.recovery_concurrency, recovery_concurrency_limit)?;
        validate_service_config(&config)?;
        let alpha_config = closed_alpha_config(deployment_mode)?;
        let recovery_interval_ms = env_number("STRIKEFALL_RECOVERY_INTERVAL_MS", 250_u64)?;
        if recovery_interval_ms < 100 {
            return Err(StartupError::InvalidEnvironment(
                "STRIKEFALL_RECOVERY_INTERVAL_MS must be at least 100".to_owned(),
            ));
        }
        let recovery_batch_size = env_number("STRIKEFALL_RECOVERY_BATCH_SIZE", 100_u32)?;
        if recovery_batch_size == 0 {
            return Err(StartupError::InvalidEnvironment(
                "STRIKEFALL_RECOVERY_BATCH_SIZE must be greater than zero".to_owned(),
            ));
        }
        repository
            .validate_active_signing_key(&hex::encode(signing_key.verifying_key().to_bytes()))
            .await?;
        let service = Self::new_with_alpha_config(
            repository,
            Arc::new(SystemClock),
            config,
            alpha_config,
            signing_key,
        );
        Ok(ServiceRuntime {
            service,
            deployment_mode,
            repository_kind,
            recovery_interval: Duration::from_millis(recovery_interval_ms),
            recovery_batch_size,
        })
    }
}

fn closed_alpha_config(mode: DeploymentMode) -> Result<ClosedAlphaConfig, StartupError> {
    let invite_required = env_bool("STRIKEFALL_REQUIRE_INVITE", false)?;
    let invite_codes = optional_env("STRIKEFALL_INVITE_CODES")?;
    let mut invite_code_hashes = BTreeSet::new();
    if let Some(codes) = invite_codes {
        for code in codes.split(',').map(str::trim) {
            if code.is_empty() {
                return Err(StartupError::InvalidEnvironment(
                    "STRIKEFALL_INVITE_CODES contains an empty code".to_owned(),
                ));
            }
            invite_code_hashes.insert(invite_code_digest(code).map_err(|_| {
                StartupError::InvalidEnvironment(
                    "STRIKEFALL_INVITE_CODES entries must be 8-128 non-whitespace characters"
                        .to_owned(),
                )
            })?);
        }
    }
    if invite_required && invite_code_hashes.is_empty() {
        return Err(StartupError::InvalidEnvironment(format!(
            "{} requires non-empty STRIKEFALL_INVITE_CODES when STRIKEFALL_REQUIRE_INVITE=true",
            if mode == DeploymentMode::Production {
                "production"
            } else {
                "closed-alpha mode"
            }
        )));
    }
    let ttl_hours = env_number("STRIKEFALL_SESSION_TTL_HOURS", 168_u64)?;
    if !(1..=720).contains(&ttl_hours) {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_SESSION_TTL_HOURS must be between 1 and 720".to_owned(),
        ));
    }
    let telemetry_retention_days = env_number("STRIKEFALL_TELEMETRY_RETENTION_DAYS", 30_u32)?;
    if !(1..=90).contains(&telemetry_retention_days) {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_TELEMETRY_RETENTION_DAYS must be between 1 and 90".to_owned(),
        ));
    }
    let metrics_token_hash =
        optional_env("STRIKEFALL_METRICS_TOKEN")?.map(|token| metrics_token_digest(&token));
    let experiments = optional_env("STRIKEFALL_EXPERIMENTS_JSON")?.map_or_else(
        || Ok(ClosedAlphaConfig::default().experiments),
        |json| parse_experiments(&json),
    )?;
    Ok(ClosedAlphaConfig {
        invite_required,
        invite_code_hashes,
        session_ttl_ms: ttl_hours * 60 * 60 * 1_000,
        telemetry_retention_days,
        metrics_token_hash,
        experiments,
    })
}

fn parse_experiments(value: &str) -> Result<BTreeMap<String, Vec<String>>, StartupError> {
    let experiments: BTreeMap<String, Vec<String>> = serde_json::from_str(value).map_err(|_| {
        StartupError::InvalidEnvironment(
            "STRIKEFALL_EXPERIMENTS_JSON must be an object of string arrays".to_owned(),
        )
    })?;
    if experiments.len() > 16
        || experiments.iter().any(|(name, variants)| {
            name.is_empty()
                || name.len() > 48
                || !name.bytes().all(valid_experiment_byte)
                || variants.is_empty()
                || variants.len() > 8
                || variants.iter().any(|variant| {
                    variant.is_empty()
                        || variant.len() > 32
                        || !variant.bytes().all(valid_experiment_byte)
                })
        })
    {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_EXPERIMENTS_JSON exceeds experiment or variant bounds".to_owned(),
        ));
    }
    let shipped = shipped_experiments();
    let valid_catalog = (2..=3).contains(&experiments.len())
        && experiments.contains_key(ESCAPE_EXPERIMENT)
        && experiments.contains_key(RISK_DISPLAY_EXPERIMENT)
        && experiments.iter().all(|(name, variants)| {
            let Some(allowed) = shipped.get(name) else {
                return false;
            };
            let unique = variants.iter().collect::<BTreeSet<_>>();
            unique.len() == variants.len()
                && variants.iter().all(|variant| allowed.contains(variant))
        });
    if !valid_catalog {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_EXPERIMENTS_JSON must configure escape:v2 and risk-display:v2, with optional deck-structure:v2, using shipped variants".to_owned(),
        ));
    }
    Ok(experiments)
}

fn valid_experiment_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.' | b':')
}

fn deployment_mode() -> Result<DeploymentMode, StartupError> {
    let value = optional_env("STRIKEFALL_ENV")?.unwrap_or_else(|| "development".to_owned());
    match value.to_ascii_lowercase().as_str() {
        "development" | "dev" | "test" => Ok(DeploymentMode::Development),
        "production" | "prod" => Ok(DeploymentMode::Production),
        _ => Err(StartupError::InvalidEnvironment(format!(
            "STRIKEFALL_ENV must be development or production, got '{value}'"
        ))),
    }
}

fn repository_kind(mode: DeploymentMode) -> Result<RepositoryKind, StartupError> {
    let configured = optional_env("STRIKEFALL_REPOSITORY")?;
    let kind = match configured.as_deref() {
        Some("memory") => RepositoryKind::Memory,
        Some("postgres") => RepositoryKind::Postgres,
        Some(value) => {
            return Err(StartupError::InvalidEnvironment(format!(
                "STRIKEFALL_REPOSITORY must be memory or postgres, got '{value}'"
            )));
        }
        None if env::var_os("DATABASE_URL").is_some() => RepositoryKind::Postgres,
        None => RepositoryKind::Memory,
    };
    if mode == DeploymentMode::Production && kind == RepositoryKind::Memory {
        return Err(StartupError::InvalidEnvironment(
            "production requires STRIKEFALL_REPOSITORY=postgres and DATABASE_URL".to_owned(),
        ));
    }
    Ok(kind)
}

fn load_signing_key(mode: DeploymentMode) -> Result<SigningKey, StartupError> {
    let inline = optional_env("STRIKEFALL_SIGNING_KEY")?;
    let file = optional_env("STRIKEFALL_SIGNING_KEY_FILE")?.map(PathBuf::from);
    match (inline, file) {
        (Some(_), Some(_)) => Err(StartupError::InvalidEnvironment(
            "configure only one of STRIKEFALL_SIGNING_KEY or STRIKEFALL_SIGNING_KEY_FILE"
                .to_owned(),
        )),
        (Some(encoded), None) => decode_hex_signing_key(&encoded),
        (None, Some(path)) => {
            ensure_private_key_file(&path, mode)?;
            let bytes = fs::read(&path).map_err(|source| StartupError::SigningKeyFile {
                path: path.clone(),
                source,
            })?;
            decode_signing_key(&bytes)
        }
        (None, None) if mode == DeploymentMode::Production => {
            Err(StartupError::InvalidEnvironment(
                "production requires STRIKEFALL_SIGNING_KEY_FILE or STRIKEFALL_SIGNING_KEY"
                    .to_owned(),
            ))
        }
        (None, None) => {
            let mut secret = [0_u8; 32];
            getrandom::fill(&mut secret).map_err(|_| StartupError::RandomUnavailable)?;
            tracing::warn!(
                "using an ephemeral development signing key; replays will not retain a stable publisher identity"
            );
            Ok(SigningKey::from_bytes(&secret))
        }
    }
}

fn decode_signing_key(input: &[u8]) -> Result<SigningKey, StartupError> {
    let bytes = if input.len() == 32 {
        input.to_vec()
    } else {
        let encoded = std::str::from_utf8(input).map_err(|_| {
            StartupError::InvalidEnvironment(
                "signing key must be 32 raw bytes or 64 hexadecimal characters".to_owned(),
            )
        })?;
        hex::decode(encoded.trim()).map_err(|_| {
            StartupError::InvalidEnvironment(
                "signing key must be 32 raw bytes or 64 hexadecimal characters".to_owned(),
            )
        })?
    };
    let secret: [u8; 32] = bytes.try_into().map_err(|_| {
        StartupError::InvalidEnvironment(
            "signing key must be exactly 32 bytes (64 hexadecimal characters)".to_owned(),
        )
    })?;
    Ok(SigningKey::from_bytes(&secret))
}

fn decode_hex_signing_key(encoded: &str) -> Result<SigningKey, StartupError> {
    let bytes = hex::decode(encoded.trim()).map_err(|_| {
        StartupError::InvalidEnvironment(
            "STRIKEFALL_SIGNING_KEY must be 64 hexadecimal characters".to_owned(),
        )
    })?;
    let secret: [u8; 32] = bytes.try_into().map_err(|_| {
        StartupError::InvalidEnvironment(
            "STRIKEFALL_SIGNING_KEY must be exactly 64 hexadecimal characters".to_owned(),
        )
    })?;
    Ok(SigningKey::from_bytes(&secret))
}

#[cfg(unix)]
fn ensure_private_key_file(path: &Path, mode: DeploymentMode) -> Result<(), StartupError> {
    use std::os::unix::fs::PermissionsExt;

    if mode != DeploymentMode::Production {
        return Ok(());
    }
    let metadata = fs::metadata(path).map_err(|source| StartupError::SigningKeyFile {
        path: path.to_path_buf(),
        source,
    })?;
    let permissions = metadata.permissions().mode() & 0o777;
    if permissions & 0o077 != 0 {
        return Err(StartupError::InvalidEnvironment(format!(
            "production signing key file '{}' must not be readable or writable by group/other (mode is {permissions:o})",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_private_key_file(_path: &Path, _mode: DeploymentMode) -> Result<(), StartupError> {
    Ok(())
}

fn required_env(name: &str) -> Result<String, StartupError> {
    optional_env(name)?.ok_or_else(|| {
        StartupError::InvalidEnvironment(format!("{name} must be configured and non-empty"))
    })
}

fn optional_env(name: &str) -> Result<Option<String>, StartupError> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Err(StartupError::InvalidEnvironment(format!(
            "{name} cannot be empty"
        ))),
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(StartupError::InvalidEnvironment(format!(
            "{name} must be valid UTF-8"
        ))),
    }
}

fn env_bool(name: &str, default: bool) -> Result<bool, StartupError> {
    let Some(value) = optional_env(name)? else {
        return Ok(default);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(StartupError::InvalidEnvironment(format!(
            "{name} must be true or false"
        ))),
    }
}

fn env_number<T>(name: &str, default: T) -> Result<T, StartupError>
where
    T: std::str::FromStr,
{
    let Some(value) = optional_env(name)? else {
        return Ok(default);
    };
    value.parse().map_err(|_| {
        StartupError::InvalidEnvironment(format!("{name} has an invalid numeric value"))
    })
}

fn validate_recovery_concurrency(configured: usize, pool_limit: usize) -> Result<(), StartupError> {
    if configured == 0 || configured > RECOVERY_CONCURRENCY_CEILING {
        return Err(StartupError::InvalidEnvironment(format!(
            "STRIKEFALL_RECOVERY_CONCURRENCY must be between 1 and {RECOVERY_CONCURRENCY_CEILING}"
        )));
    }
    if configured > pool_limit {
        return Err(StartupError::InvalidEnvironment(format!(
            "STRIKEFALL_RECOVERY_CONCURRENCY must not exceed {pool_limit} for the configured database pool"
        )));
    }
    Ok(())
}

fn validate_stream_topology(
    mode: DeploymentMode,
    configured: Option<&str>,
) -> Result<(), StartupError> {
    match (mode, configured) {
        (_, Some("single-replica")) | (DeploymentMode::Development, None) => Ok(()),
        (DeploymentMode::Production, None) => Err(StartupError::InvalidEnvironment(
            "production requires STRIKEFALL_STREAM_TOPOLOGY=single-replica because live SSE fan-out is process-local"
                .to_owned(),
        )),
        (_, Some(value)) => Err(StartupError::InvalidEnvironment(format!(
            "STRIKEFALL_STREAM_TOPOLOGY must be single-replica, got '{value}'"
        ))),
    }
}

fn validate_service_config(config: &ServiceConfig) -> Result<(), StartupError> {
    if config.placement_duration_ms == 0 {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_PLACEMENT_DURATION_MS must be greater than zero".to_owned(),
        ));
    }
    if config.input_freeze_ms >= config.placement_duration_ms {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_INPUT_FREEZE_MS must be shorter than placement duration".to_owned(),
        ));
    }
    if config.minimum_flag_update_interval_ms == 0 {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_FLAG_UPDATE_INTERVAL_MS must be greater than zero".to_owned(),
        ));
    }
    let shortest_battle_ms = strikefall_core::DECKS
        .iter()
        .map(|deck| u64::from(deck.battle_steps) * u64::from(deck.step_ms))
        .min()
        .ok_or_else(|| {
            StartupError::InvalidEnvironment("no game decks are available".to_owned())
        })?;
    if config.escape_close_before_end_ms >= shortest_battle_ms / 2 {
        return Err(StartupError::InvalidEnvironment(
            "STRIKEFALL_ESCAPE_CLOSE_MS must leave time after the midpoint unlock".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_hex_signing_key, decode_signing_key, parse_experiments,
        validate_recovery_concurrency, validate_service_config, validate_stream_topology,
        DeploymentMode,
    };
    use crate::ServiceConfig;

    #[test]
    fn accepts_raw_and_hex_signing_keys() {
        let raw = [9_u8; 32];
        let from_raw = decode_signing_key(&raw).expect("raw key");
        let from_hex = decode_hex_signing_key(&hex::encode(raw)).expect("hex key");
        assert_eq!(
            from_raw.verifying_key().to_bytes(),
            from_hex.verifying_key().to_bytes()
        );
    }

    #[test]
    fn rejects_wrong_length_signing_keys() {
        assert!(decode_signing_key(b"deadbeef").is_err());
        assert!(decode_hex_signing_key("not-a-key").is_err());
        assert!(decode_hex_signing_key(&"ab".repeat(31)).is_err());
    }

    #[test]
    fn rejects_runtime_timing_without_a_valid_input_or_escape_window() {
        let defaults = ServiceConfig::default();
        assert_eq!(defaults.placement_duration_ms, 32_000);
        let config = ServiceConfig {
            input_freeze_ms: defaults.placement_duration_ms,
            ..defaults
        };
        assert!(validate_service_config(&config).is_err());

        let config = ServiceConfig {
            escape_close_before_end_ms: 30_000,
            ..ServiceConfig::default()
        };
        assert!(validate_service_config(&config).is_err());
    }

    #[test]
    fn recovery_concurrency_preserves_pool_and_foreground_headroom() {
        assert!(validate_recovery_concurrency(1, 1).is_ok());
        assert!(validate_recovery_concurrency(4, 8).is_ok());
        assert!(validate_recovery_concurrency(0, 8).is_err());
        assert!(validate_recovery_concurrency(5, 8).is_err());
        assert!(validate_recovery_concurrency(4, 3).is_err());
    }

    #[test]
    fn production_fails_closed_without_the_single_replica_stream_topology() {
        assert!(validate_stream_topology(DeploymentMode::Development, None).is_ok());
        assert!(
            validate_stream_topology(DeploymentMode::Production, Some("single-replica")).is_ok()
        );
        assert!(validate_stream_topology(DeploymentMode::Production, None).is_err());
        assert!(validate_stream_topology(DeploymentMode::Production, Some("sticky")).is_err());
        assert!(
            validate_stream_topology(DeploymentMode::Development, Some("multi-replica")).is_err()
        );
    }

    #[test]
    fn accepts_mandatory_public_treatments_and_optional_deck_alpha() {
        let public = r#"{
          "escape:v2":["midpoint"],
          "risk-display:v2":["probability","danger-band"]
        }"#;
        let parsed = parse_experiments(public).expect("public experiment catalog");
        assert_eq!(parsed.len(), 2);
        assert!(!parsed.contains_key("deck-structure:v2"));

        let alpha = r#"{
          "deck-structure:v2":["flat","compression-break"],
          "escape:v2":["midpoint"],
          "risk-display:v2":["probability","danger-band"]
        }"#;
        let parsed = parse_experiments(alpha).expect("closed-alpha experiment catalog");
        assert_eq!(parsed.len(), 3);
        assert!(parse_experiments(
            r#"{"impact_fx_v1":["control","enhanced"],"placement_copy_v1":["control","risk_first"]}"#
        )
        .is_err());
        assert!(parse_experiments(
            r#"{"deck-structure:v2":["flat"],"escape:v2":["midpoint"],"risk-display:v2":["invented"]}"#
        )
        .is_err());
        assert!(
            parse_experiments(r#"{"deck-structure:v2":["flat"],"escape:v2":["midpoint"]}"#)
                .is_err()
        );
    }
}
