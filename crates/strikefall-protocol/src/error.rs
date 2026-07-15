use thiserror::Error;

/// Failure while encoding, reproducing, or verifying a ranked round.
#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("unknown or unsupported deck")]
    UnknownDeck,
    #[error("invalid decimal fixed-point field: {0}")]
    InvalidFixed(&'static str),
    #[error("invalid hexadecimal field: {0}")]
    InvalidHex(&'static str),
    #[error("invalid Ed25519 key or signature")]
    InvalidSignature,
    #[error("replay mismatch: {0}")]
    Mismatch(&'static str),
    #[error("deterministic core rejected the round: {0}")]
    Core(String),
    #[error("protocol serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl From<strikefall_core::CoreError> for ProtocolError {
    fn from(value: strikefall_core::CoreError) -> Self {
        Self::Core(value.to_string())
    }
}
