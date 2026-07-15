//! Standalone deterministic verification for revealed Strikefall replays.

#![forbid(unsafe_code)]

use std::io::Read;

use strikefall_protocol::{ReplayBundleDto, VerificationReportDto};
use thiserror::Error;

pub use strikefall_protocol::{verify_replay_bundle, verify_replay_bundle_against, ProtocolError};

#[derive(Debug, Error)]
pub enum InspectorError {
    #[error("could not read replay: {0}")]
    Io(#[from] std::io::Error),
    #[error("replay is not valid protocol JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("replay verification failed: {0}")]
    Verification(#[from] ProtocolError),
}

pub fn inspect_reader(reader: impl Read) -> Result<VerificationReportDto, InspectorError> {
    inspect_reader_with_anchors(reader, None, None)
}

pub fn inspect_reader_with_anchors(
    mut reader: impl Read,
    expected_commitment: Option<&str>,
    expected_server_key: Option<&str>,
) -> Result<VerificationReportDto, InspectorError> {
    let (report, _) =
        inspect_replay_reader_with_anchors(&mut reader, expected_commitment, expected_server_key)?;
    Ok(report)
}

/// Returns the verified source bundle as well as its report for human audit
/// tools. The bundle is exposed only after every deterministic check passes.
pub fn inspect_replay_reader_with_anchors(
    mut reader: impl Read,
    expected_commitment: Option<&str>,
    expected_server_key: Option<&str>,
) -> Result<(VerificationReportDto, ReplayBundleDto), InspectorError> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    let bundle: ReplayBundleDto = serde_json::from_slice(&bytes)?;
    let report = verify_replay_bundle_against(&bundle, expected_commitment, expected_server_key)?;
    Ok((report, bundle))
}
