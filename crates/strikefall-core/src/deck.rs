use solmath::{SCALE, SCALE_I};

use crate::CoreError;

/// Wire-stable identifier for continuous one-sided bridge-extrema monitoring.
/// Upper and lower extrema use exact conditional marginals and independent
/// uniforms; only their joint dependence is approximate.
pub const TOUCH_MONITORING_VERSION: &str = "strikefall/brownian-bridge-extrema/v1";

/// Stable identifier for the four launch decks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
pub enum DeckId {
    BalancedTape,
    CompressionBreak,
    OpeningRush,
    Pulse,
}

/// Versioned pacing rule for the opening of a battle.
///
/// `variance_share_bps` assigns this share of the first quarter's exact
/// integrated variance to the first `steps` microsteps. The rest of the first
/// quarter catches up linearly, so all four public quarter totals remain
/// unchanged. Keeping the rule in deck metadata makes generation, live
/// remaining-variance quotes, commitments, and replay regeneration use the
/// same clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct OpeningRunwaySchedule {
    pub steps: u16,
    pub variance_share_bps: u16,
}

impl DeckId {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BalancedTape => "balanced_tape",
            Self::CompressionBreak => "compression_break",
            Self::OpeningRush => "opening_rush",
            Self::Pulse => "pulse",
        }
    }
}

/// Versioned public deck parameters used by both generation and pricing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct DeckVersion {
    pub id: DeckId,
    pub version: u16,
    pub display_name: &'static str,
    pub approach_steps: u16,
    pub battle_steps: u16,
    pub step_ms: u16,
    pub monitoring_convention: &'static str,
    /// Relative battle variance assigned to each quarter.
    pub variance_weights: [u16; 4],
    /// Low-variance opening window followed by an exact within-quarter catch-up.
    pub opening_runway: Option<OpeningRunwaySchedule>,
    /// Integrated log-return variance at `SolMath`'s 1e12 scale.
    pub total_integrated_variance: u128,
    /// Log drift per unit of variance. Neutral GBM is -0.5.
    pub drift_per_variance: i128,
    pub min_initial_survival: u128,
    pub max_initial_survival: u128,
    pub risk_multiplier_cap: u128,
    pub art_theme: &'static str,
    pub audio_profile: &'static str,
    /// SHA-256 digest of the canonical calibration/provenance payload bound to
    /// this deck version. The launch constants currently bind the synthetic
    /// alpha catalog and are not evidence of historical-market calibration.
    pub calibration_digest: [u8; 32],
}

impl DeckVersion {
    /// Rejects malformed schedules before they can enter a replay.
    pub fn validate(&self) -> Result<(), CoreError> {
        let weight_sum: u32 = self
            .variance_weights
            .iter()
            .map(|value| u32::from(*value))
            .sum();
        let quarter_steps = self.battle_steps / 4;
        if self.version == 0
            || self.approach_steps == 0
            || self.battle_steps == 0
            || self.battle_steps % 4 != 0
            || self.step_ms == 0
            || self.monitoring_convention != TOUCH_MONITORING_VERSION
            || weight_sum == 0
            || self.variance_weights.contains(&0)
            || self.total_integrated_variance == 0
            || self.min_initial_survival == 0
            || self.min_initial_survival >= self.max_initial_survival
            || self.max_initial_survival > SCALE
            || self.risk_multiplier_cap < SCALE
            || self.drift_per_variance.unsigned_abs() > (4 * SCALE_I).unsigned_abs()
        {
            return Err(CoreError::InvalidDeck);
        }

        let Some(opening_runway) = self.opening_runway else {
            return (self.version < 3)
                .then_some(())
                .ok_or(CoreError::InvalidDeck);
        };
        if self.version < 3
            || opening_runway.steps == 0
            || opening_runway.steps >= quarter_steps
            || opening_runway.variance_share_bps == 0
            || opening_runway.variance_share_bps >= 10_000
            || u32::from(opening_runway.variance_share_bps) * u32::from(quarter_steps)
                >= 10_000 * u32::from(opening_runway.steps)
        {
            return Err(CoreError::InvalidDeck);
        }

        let first_quarter_variance = self
            .total_integrated_variance
            .checked_mul(u128::from(self.variance_weights[0]))
            .map(|value| value / u128::from(weight_sum))
            .ok_or(CoreError::ArithmeticOverflow)?;
        let runway_variance = first_quarter_variance
            .checked_mul(u128::from(opening_runway.variance_share_bps))
            .map(|value| value / 10_000)
            .ok_or(CoreError::ArithmeticOverflow)?;
        if runway_variance < u128::from(opening_runway.steps)
            || first_quarter_variance.saturating_sub(runway_variance)
                < u128::from(quarter_steps - opening_runway.steps)
        {
            return Err(CoreError::InvalidDeck);
        }
        Ok(())
    }

    /// Integrated battle variance elapsed at an exact step boundary.
    ///
    /// The difference between adjacent boundaries is the step variance. Using
    /// cumulative integer division guarantees that all steps sum exactly to
    /// `total_integrated_variance`, with no replay-sensitive remainder loss.
    pub fn variance_at_boundary(&self, step: u16) -> Result<u128, CoreError> {
        self.validate()?;
        if step > self.battle_steps {
            return Err(CoreError::InvalidSchedule);
        }
        if step == self.battle_steps {
            return Ok(self.total_integrated_variance);
        }

        let quarter_steps = self.battle_steps / 4;
        let quarter_len = u128::from(quarter_steps);
        let quarter = usize::from(step / quarter_steps);
        let within_quarter = u128::from(step % quarter_steps);
        let prefix_weight: u128 = self.variance_weights[..quarter]
            .iter()
            .map(|value| u128::from(*value))
            .sum();
        let current_weight = u128::from(self.variance_weights[quarter]);
        let total_weight: u128 = self
            .variance_weights
            .iter()
            .map(|value| u128::from(*value))
            .sum();
        let progress = prefix_weight
            .checked_mul(quarter_len)
            .and_then(|value| value.checked_add(current_weight * within_quarter))
            .ok_or(CoreError::ArithmeticOverflow)?;
        let denominator = total_weight
            .checked_mul(quarter_len)
            .ok_or(CoreError::ArithmeticOverflow)?;

        let linear_variance = self
            .total_integrated_variance
            .checked_mul(progress)
            .map(|value| value / denominator)
            .ok_or(CoreError::ArithmeticOverflow)?;

        let Some(opening_runway) = self.opening_runway else {
            return Ok(linear_variance);
        };
        if quarter != 0 || step == 0 {
            return Ok(linear_variance);
        }

        let first_quarter_variance = self
            .total_integrated_variance
            .checked_mul(u128::from(self.variance_weights[0]))
            .map(|value| value / total_weight)
            .ok_or(CoreError::ArithmeticOverflow)?;
        let runway_variance = first_quarter_variance
            .checked_mul(u128::from(opening_runway.variance_share_bps))
            .map(|value| value / 10_000)
            .ok_or(CoreError::ArithmeticOverflow)?;
        let runway_steps = u128::from(opening_runway.steps);
        if within_quarter <= runway_steps {
            return runway_variance
                .checked_mul(within_quarter)
                .map(|value| value / runway_steps)
                .ok_or(CoreError::ArithmeticOverflow);
        }

        let catchup_steps = quarter_len - runway_steps;
        let catchup_progress = within_quarter - runway_steps;
        first_quarter_variance
            .checked_sub(runway_variance)
            .and_then(|remaining| remaining.checked_mul(catchup_progress))
            .map(|value| runway_variance + value / catchup_steps)
            .ok_or(CoreError::ArithmeticOverflow)
    }

    pub fn variance_for_step(&self, step: u16) -> Result<u128, CoreError> {
        if step >= self.battle_steps {
            return Err(CoreError::InvalidSchedule);
        }
        let before = self.variance_at_boundary(step)?;
        let after = self.variance_at_boundary(step + 1)?;
        Ok(after - before)
    }

    pub fn remaining_variance(&self, completed_steps: u16) -> Result<u128, CoreError> {
        let elapsed = self.variance_at_boundary(completed_steps)?;
        Ok(self.total_integrated_variance - elapsed)
    }
}

const COMMON_VARIANCE: u128 = 6_400_000_000; // 0.0064; 8% total log standard deviation.
const MIN_SURVIVAL: u128 = 120_000_000_000;
// Farthest legal flag keeps 97% full-round no-touch so a cautious wrong-side
// pick usually survives to the Escape window. The 0.9 risk numerator is
// unchanged: every placement at or beyond 90% survival pays the 1x floor.
const MAX_SURVIVAL: u128 = 970_000_000_000;
const RISK_CAP: u128 = 8 * SCALE;
const NEUTRAL_DRIFT: i128 = -SCALE_I / 2;
const BALANCED_RUNWAY: OpeningRunwaySchedule = OpeningRunwaySchedule {
    steps: 40,
    variance_share_bps: 340,
};
const COMPRESSION_RUNWAY: OpeningRunwaySchedule = OpeningRunwaySchedule {
    steps: 40,
    variance_share_bps: 1_600,
};
const OPENING_RUNWAY: OpeningRunwaySchedule = OpeningRunwaySchedule {
    steps: 40,
    variance_share_bps: 125,
};
const PULSE_RUNWAY: OpeningRunwaySchedule = OpeningRunwaySchedule {
    steps: 40,
    variance_share_bps: 450,
};
// SHA-256 digests of the exact versioned entries in
// docs/decks/sample-catalog.v3.json. The catalogue is synthetic alpha
// provenance, not a historical-market claim.
const BALANCED_CALIBRATION_V2: [u8; 32] = [
    0x83, 0xa8, 0x5e, 0x65, 0x66, 0x0b, 0xb6, 0x42, 0x14, 0xc2, 0x4b, 0xb7, 0xf3, 0xfa, 0x76, 0x9a,
    0x6b, 0xfb, 0x54, 0xad, 0x65, 0x7d, 0x30, 0x93, 0xc6, 0x0b, 0x9d, 0x48, 0xb8, 0x0c, 0xf0, 0x6a,
];
const COMPRESSION_CALIBRATION_V2: [u8; 32] = [
    0x8c, 0x71, 0xaf, 0x11, 0x6f, 0x2f, 0xaa, 0xda, 0x8f, 0xcb, 0xac, 0x9c, 0xad, 0x79, 0x3d, 0x0c,
    0xf1, 0xb1, 0x99, 0x92, 0x1d, 0xb8, 0xc0, 0x63, 0x61, 0x3e, 0x2e, 0x05, 0xab, 0x6c, 0xa3, 0xf1,
];
const OPENING_CALIBRATION_V2: [u8; 32] = [
    0x05, 0xd5, 0xe2, 0x45, 0xc0, 0xd5, 0x58, 0x98, 0x06, 0xa8, 0x78, 0x83, 0x82, 0x43, 0x2d, 0xca,
    0xab, 0x6e, 0x87, 0x34, 0x25, 0x95, 0xb8, 0xfb, 0x6e, 0x85, 0xe5, 0x32, 0x49, 0x48, 0xd9, 0x9d,
];
const PULSE_CALIBRATION_V2: [u8; 32] = [
    0x37, 0x30, 0x91, 0x1d, 0x76, 0x3b, 0xf9, 0xb5, 0xac, 0x4e, 0x64, 0xab, 0xd6, 0x4a, 0xb4, 0x72,
    0x75, 0xe4, 0x20, 0xc5, 0xbd, 0xad, 0x2f, 0xb1, 0x1d, 0xd7, 0xbd, 0xbd, 0x71, 0xa0, 0x19, 0x00,
];

const BALANCED_CALIBRATION: [u8; 32] = [
    0x86, 0x3f, 0x86, 0xc9, 0x7c, 0xfa, 0xbb, 0x4a, 0x84, 0x7a, 0x3e, 0x14, 0x77, 0x5c, 0x4f, 0xa8,
    0xdd, 0x83, 0x07, 0x9c, 0x50, 0xf7, 0xac, 0x1d, 0xd3, 0x29, 0xe6, 0x8e, 0xda, 0xb5, 0x75, 0xf0,
];
const COMPRESSION_CALIBRATION: [u8; 32] = [
    0xe5, 0x1e, 0x71, 0x72, 0xbd, 0xdb, 0xf4, 0x15, 0x68, 0x16, 0xc8, 0x8b, 0xf3, 0x8a, 0xe3, 0x9b,
    0x5b, 0x61, 0xd3, 0x30, 0x6b, 0x21, 0x08, 0x67, 0x31, 0xb0, 0x2a, 0xd8, 0x4c, 0xa2, 0x16, 0xeb,
];
const OPENING_CALIBRATION: [u8; 32] = [
    0x73, 0xb1, 0x6b, 0x2c, 0xdc, 0xcc, 0x3f, 0xbc, 0x95, 0x44, 0x1d, 0xbd, 0x69, 0x08, 0x8e, 0x4c,
    0x6a, 0xeb, 0x4b, 0xd4, 0xa5, 0x35, 0xd9, 0x72, 0x2f, 0x21, 0x40, 0x23, 0x73, 0x2a, 0xd2, 0x2f,
];
const PULSE_CALIBRATION: [u8; 32] = [
    0x9d, 0x26, 0x9b, 0x39, 0x8b, 0x1e, 0x14, 0xbd, 0xb3, 0x87, 0x00, 0x8f, 0x0d, 0x85, 0x37, 0x4f,
    0xfb, 0x14, 0x1e, 0x70, 0x85, 0x16, 0xa0, 0xde, 0x4b, 0xc2, 0x4c, 0x74, 0x4c, 0xdc, 0x9b, 0x69,
];

pub const BALANCED_TAPE: DeckVersion = DeckVersion {
    id: DeckId::BalancedTape,
    version: 3,
    display_name: "Balanced Tape",
    approach_steps: 60,
    battle_steps: 240,
    step_ms: 250,
    monitoring_convention: TOUCH_MONITORING_VERSION,
    variance_weights: [25, 25, 25, 25],
    opening_runway: Some(BALANCED_RUNWAY),
    total_integrated_variance: COMMON_VARIANCE,
    drift_per_variance: NEUTRAL_DRIFT,
    min_initial_survival: MIN_SURVIVAL,
    max_initial_survival: MAX_SURVIVAL,
    risk_multiplier_cap: RISK_CAP,
    art_theme: "electric_cyan",
    audio_profile: "steady_pressure",
    calibration_digest: BALANCED_CALIBRATION,
};

pub const COMPRESSION_BREAK: DeckVersion = DeckVersion {
    id: DeckId::CompressionBreak,
    display_name: "Compression Break",
    variance_weights: [5, 10, 25, 60],
    opening_runway: Some(COMPRESSION_RUNWAY),
    art_theme: "violet_storm",
    audio_profile: "rising_break",
    calibration_digest: COMPRESSION_CALIBRATION,
    ..BALANCED_TAPE
};

pub const OPENING_RUSH: DeckVersion = DeckVersion {
    id: DeckId::OpeningRush,
    display_name: "Opening Rush",
    variance_weights: [55, 25, 15, 5],
    opening_runway: Some(OPENING_RUNWAY),
    art_theme: "solar_flare",
    audio_profile: "front_loaded_impact",
    calibration_digest: OPENING_CALIBRATION,
    ..BALANCED_TAPE
};

pub const PULSE: DeckVersion = DeckVersion {
    id: DeckId::Pulse,
    display_name: "Pulse",
    variance_weights: [15, 35, 15, 35],
    opening_runway: Some(PULSE_RUNWAY),
    art_theme: "magenta_pulse",
    audio_profile: "double_drop",
    calibration_digest: PULSE_CALIBRATION,
    ..BALANCED_TAPE
};

pub const DECKS: [DeckVersion; 4] = [BALANCED_TAPE, COMPRESSION_BREAK, OPENING_RUSH, PULSE];

// Deck version 2 committed its verification band before the max widened to
// 97%; historical replays must keep resolving against the frozen 90% bound.
const MAX_SURVIVAL_V2: u128 = 900_000_000_000;

const BALANCED_TAPE_V2: DeckVersion = DeckVersion {
    version: 2,
    opening_runway: None,
    calibration_digest: BALANCED_CALIBRATION_V2,
    max_initial_survival: MAX_SURVIVAL_V2,
    ..BALANCED_TAPE
};

const COMPRESSION_BREAK_V2: DeckVersion = DeckVersion {
    version: 2,
    opening_runway: None,
    calibration_digest: COMPRESSION_CALIBRATION_V2,
    max_initial_survival: MAX_SURVIVAL_V2,
    ..COMPRESSION_BREAK
};

const OPENING_RUSH_V2: DeckVersion = DeckVersion {
    version: 2,
    opening_runway: None,
    calibration_digest: OPENING_CALIBRATION_V2,
    max_initial_survival: MAX_SURVIVAL_V2,
    ..OPENING_RUSH
};

const PULSE_V2: DeckVersion = DeckVersion {
    version: 2,
    opening_runway: None,
    calibration_digest: PULSE_CALIBRATION_V2,
    max_initial_survival: MAX_SURVIVAL_V2,
    ..PULSE
};

const LEGACY_DECKS: [DeckVersion; 4] = [
    BALANCED_TAPE_V2,
    COMPRESSION_BREAK_V2,
    OPENING_RUSH_V2,
    PULSE_V2,
];

#[must_use]
pub fn deck_by_id(id: &str) -> Option<&'static DeckVersion> {
    DECKS.iter().find(|deck| deck.id.as_str() == id)
}

/// Resolves a committed historical deck without aliasing it to the active one.
#[must_use]
pub fn deck_by_ref(id: &str, version: u16) -> Option<&'static DeckVersion> {
    DECKS
        .iter()
        .chain(LEGACY_DECKS.iter())
        .find(|deck| deck.id.as_str() == id && deck.version == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_launch_deck_is_valid_and_preserves_total_variance() {
        for deck in DECKS {
            deck.validate().unwrap();
            let sum: u128 = (0..deck.battle_steps)
                .map(|step| deck.variance_for_step(step).unwrap())
                .sum();
            assert_eq!(sum, deck.total_integrated_variance);
        }
    }

    #[test]
    fn deck_quarters_match_the_roadmap() {
        let boundary = COMPRESSION_BREAK.battle_steps / 4;
        let quarter_one = COMPRESSION_BREAK.variance_at_boundary(boundary).unwrap();
        assert_eq!(
            quarter_one,
            COMPRESSION_BREAK.total_integrated_variance / 20
        );

        let opening_first = OPENING_RUSH.variance_at_boundary(boundary).unwrap();
        assert_eq!(
            opening_first,
            OPENING_RUSH.total_integrated_variance * 55 / 100
        );
    }

    #[test]
    fn opening_runway_is_explicit_and_preserves_every_public_quarter() {
        for deck in DECKS {
            let runway = deck.opening_runway.expect("active runway");
            let quarter_steps = deck.battle_steps / 4;
            let first_quarter = deck.variance_at_boundary(quarter_steps).unwrap();
            assert_eq!(
                deck.variance_at_boundary(runway.steps).unwrap(),
                first_quarter * u128::from(runway.variance_share_bps) / 10_000,
            );
            for quarter in 0..=4 {
                let step = quarter * quarter_steps;
                let expected_weight: u128 = deck.variance_weights[..usize::from(quarter)]
                    .iter()
                    .map(|weight| u128::from(*weight))
                    .sum();
                let total_weight: u128 = deck
                    .variance_weights
                    .iter()
                    .map(|weight| u128::from(*weight))
                    .sum();
                assert_eq!(
                    deck.variance_at_boundary(step).unwrap(),
                    deck.total_integrated_variance * expected_weight / total_weight,
                );
            }
            for step in 0..deck.battle_steps {
                assert!(deck.variance_for_step(step).unwrap() > 0);
            }
            assert_eq!(
                deck.remaining_variance(runway.steps).unwrap(),
                deck.total_integrated_variance - deck.variance_at_boundary(runway.steps).unwrap(),
            );
        }
    }

    #[test]
    fn historical_v2_clock_is_resolved_without_aliasing_active_v3() {
        for active in DECKS {
            let legacy = deck_by_ref(active.id.as_str(), 2).expect("legacy deck");
            assert_eq!(deck_by_id(active.id.as_str()), Some(&active));
            assert_eq!(legacy.version, 2);
            assert_eq!(legacy.opening_runway, None);
            assert_eq!(active.version, 3);
            assert_eq!(
                legacy.variance_at_boundary(40).unwrap(),
                legacy.variance_at_boundary(60).unwrap() * 2 / 3,
            );
            assert_ne!(
                legacy.variance_at_boundary(40).unwrap(),
                active.variance_at_boundary(40).unwrap(),
            );
        }
    }

    #[test]
    fn launch_decks_match_the_synthetic_alpha_catalog() {
        struct ExpectedDeck {
            id: &'static str,
            display_name: &'static str,
            variance_weights: [u16; 4],
            art_theme: &'static str,
            audio_profile: &'static str,
            calibration_digest: [u8; 32],
        }

        const EXPECTED: [ExpectedDeck; 4] = [
            ExpectedDeck {
                id: "balanced_tape",
                display_name: "Balanced Tape",
                variance_weights: [25, 25, 25, 25],
                art_theme: "electric_cyan",
                audio_profile: "steady_pressure",
                calibration_digest: BALANCED_CALIBRATION,
            },
            ExpectedDeck {
                id: "compression_break",
                display_name: "Compression Break",
                variance_weights: [5, 10, 25, 60],
                art_theme: "violet_storm",
                audio_profile: "rising_break",
                calibration_digest: COMPRESSION_CALIBRATION,
            },
            ExpectedDeck {
                id: "opening_rush",
                display_name: "Opening Rush",
                variance_weights: [55, 25, 15, 5],
                art_theme: "solar_flare",
                audio_profile: "front_loaded_impact",
                calibration_digest: OPENING_CALIBRATION,
            },
            ExpectedDeck {
                id: "pulse",
                display_name: "Pulse",
                variance_weights: [15, 35, 15, 35],
                art_theme: "magenta_pulse",
                audio_profile: "double_drop",
                calibration_digest: PULSE_CALIBRATION,
            },
        ];

        for (deck, expected) in DECKS.iter().zip(EXPECTED) {
            assert_eq!(deck.id.as_str(), expected.id);
            assert_eq!(deck.display_name, expected.display_name);
            assert_eq!(deck.variance_weights, expected.variance_weights);
            assert_eq!(deck.art_theme, expected.art_theme);
            assert_eq!(deck.audio_profile, expected.audio_profile);
            assert_eq!(deck.calibration_digest, expected.calibration_digest);
            assert_eq!(deck.version, 3);
            assert_eq!(deck.approach_steps, 60);
            assert_eq!(deck.battle_steps, 240);
            assert_eq!(deck.step_ms, 250);
            assert_eq!(deck.monitoring_convention, TOUCH_MONITORING_VERSION);
            assert_eq!(deck.opening_runway.expect("v3 runway").steps, 40);
            assert_eq!(deck.total_integrated_variance, 6_400_000_000);
            assert_eq!(deck.drift_per_variance, -500_000_000_000);
            assert_eq!(deck.min_initial_survival, 120_000_000_000);
            assert_eq!(deck.max_initial_survival, 970_000_000_000);
            assert_eq!(deck.risk_multiplier_cap, 8_000_000_000_000);
        }
    }
}
