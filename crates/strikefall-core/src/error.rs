use core::fmt;

use solmath::SolMathError;

/// Errors emitted by deterministic Strikefall rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    InvalidDeck,
    InvalidSchedule,
    InvalidSpot,
    InvalidBarrier,
    InvalidProbability,
    InvalidPlacement,
    TargetOutOfRange,
    ArithmeticOverflow,
    Math(SolMathError),
}

impl From<SolMathError> for CoreError {
    fn from(value: SolMathError) -> Self {
        Self::Math(value)
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDeck => formatter.write_str("invalid deck"),
            Self::InvalidSchedule => formatter.write_str("invalid variance schedule"),
            Self::InvalidSpot => formatter.write_str("spot must be positive"),
            Self::InvalidBarrier => formatter.write_str("barrier is on the wrong side of spot"),
            Self::InvalidProbability => formatter.write_str("probability must be in (0, 1]"),
            Self::InvalidPlacement => formatter.write_str("flag placement is invalid"),
            Self::TargetOutOfRange => {
                formatter.write_str("target survival is outside solver bounds")
            }
            Self::ArithmeticOverflow => formatter.write_str("fixed-point arithmetic overflow"),
            Self::Math(error) => write!(formatter, "SolMath error: {error:?}"),
        }
    }
}
