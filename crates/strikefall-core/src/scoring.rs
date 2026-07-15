use alloc::vec::Vec;

use solmath::{fp_div, fp_mul, fp_sqrt, ln_fixed_i, SCALE};

use crate::{one_sided_no_touch, BarrierSide, CoreError, NoTouchInputs};

const DEFAULT_RISK_NUMERATOR: u128 = 900_000_000_000;
const DEFAULT_RISK_CAP: u128 = 8 * SCALE;
const DEFAULT_CROWD_MIN: u128 = 750_000_000_000;
const DEFAULT_CROWD_MAX: u128 = 1_600_000_000_000;
// An empty band reads as the documented 1.34× bonus (sqrt(1.8)), while the
// wider kernel stops a permanently sparse sheltered band becoming optimal.
const DEFAULT_TARGET_DENSITY: u128 = 800_000_000_000;
const DEFAULT_BANDWIDTH: u128 = 1_250_000_000_000;
const DEFAULT_BASE_SCORE: u128 = 100 * SCALE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct ScoringRules {
    pub base_score: u128,
    pub risk_numerator: u128,
    pub risk_cap: u128,
    pub target_density: u128,
    pub crowd_bandwidth: u128,
    pub crowd_min: u128,
    pub crowd_max: u128,
}

impl Default for ScoringRules {
    fn default() -> Self {
        Self {
            base_score: DEFAULT_BASE_SCORE,
            risk_numerator: DEFAULT_RISK_NUMERATOR,
            risk_cap: DEFAULT_RISK_CAP,
            target_density: DEFAULT_TARGET_DENSITY,
            crowd_bandwidth: DEFAULT_BANDWIDTH,
            crowd_min: DEFAULT_CROWD_MIN,
            crowd_max: DEFAULT_CROWD_MAX,
        }
    }
}

impl ScoringRules {
    fn validate(self) -> Result<(), CoreError> {
        if self.base_score == 0
            || self.risk_numerator == 0
            || self.risk_cap < SCALE
            || self.crowd_bandwidth == 0
            || self.crowd_min == 0
            || self.crowd_min > self.crowd_max
        {
            return Err(CoreError::InvalidPlacement);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct FlagPlacement {
    pub contender_id: u16,
    pub side: BarrierSide,
    pub barrier: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct LockedScore {
    pub contender_id: u16,
    pub side: BarrierSide,
    pub barrier: u128,
    pub normalized_distance: u128,
    pub initial_survival: u128,
    pub risk_multiplier: u128,
    pub crowd_factor: u128,
    pub terminal_score: u128,
}

pub fn risk_multiplier(initial_survival: u128) -> Result<u128, CoreError> {
    risk_multiplier_with_rules(initial_survival, ScoringRules::default())
}

fn risk_multiplier_with_rules(
    initial_survival: u128,
    rules: ScoringRules,
) -> Result<u128, CoreError> {
    rules.validate()?;
    if initial_survival == 0 || initial_survival > SCALE {
        return Err(CoreError::InvalidProbability);
    }
    Ok(fp_div(rules.risk_numerator, initial_survival)?.clamp(SCALE, rules.risk_cap))
}

pub fn terminal_score(risk: u128, crowd: u128) -> Result<u128, CoreError> {
    terminal_score_with_rules(risk, crowd, ScoringRules::default())
}

fn terminal_score_with_rules(
    risk: u128,
    crowd: u128,
    rules: ScoringRules,
) -> Result<u128, CoreError> {
    rules.validate()?;
    let risk_points = fp_mul(rules.base_score, risk)?;
    Ok(fp_mul(risk_points, crowd)?)
}

pub fn escape_value(
    locked_terminal_score: u128,
    remaining_survival: u128,
) -> Result<u128, CoreError> {
    if remaining_survival > SCALE {
        return Err(CoreError::InvalidProbability);
    }
    Ok(fp_mul(locked_terminal_score, remaining_survival)?)
}

/// Absolute log barrier distance divided by the remaining standard deviation.
pub fn normalized_barrier_distance(
    spot: u128,
    barrier: u128,
    side: BarrierSide,
    remaining_variance: u128,
) -> Result<u128, CoreError> {
    if spot == 0 || barrier == 0 || remaining_variance == 0 {
        return Err(CoreError::InvalidPlacement);
    }
    let ratio = match side {
        BarrierSide::Upper if barrier > spot => fp_div(barrier, spot)?,
        BarrierSide::Lower if barrier < spot => fp_div(spot, barrier)?,
        _ => return Err(CoreError::InvalidBarrier),
    };
    let distance = ln_fixed_i(ratio)?;
    if distance <= 0 {
        return Err(CoreError::InvalidBarrier);
    }
    let standard_deviation = fp_sqrt(remaining_variance)?;
    let distance_u = u128::try_from(distance).map_err(|_| CoreError::InvalidBarrier)?;
    Ok(fp_div(distance_u, standard_deviation)?)
}

/// Computes the smooth, side-local crowd factor for one candidate.
pub fn crowd_factor(
    candidate_index: usize,
    sides: &[BarrierSide],
    normalized_distances: &[u128],
    rules: ScoringRules,
) -> Result<u128, CoreError> {
    rules.validate()?;
    if candidate_index >= normalized_distances.len() || sides.len() != normalized_distances.len() {
        return Err(CoreError::InvalidPlacement);
    }

    let mut density = 0_u128;
    for (index, distance) in normalized_distances.iter().enumerate() {
        if index == candidate_index || sides[index] != sides[candidate_index] {
            continue;
        }
        let separation = normalized_distances[candidate_index].abs_diff(*distance);
        if separation < rules.crowd_bandwidth {
            let relative = fp_div(separation, rules.crowd_bandwidth)?;
            density = density
                .checked_add(SCALE - relative)
                .ok_or(CoreError::ArithmeticOverflow)?;
        }
    }

    let numerator = rules
        .target_density
        .checked_add(SCALE)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let denominator = density
        .checked_add(SCALE)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let ratio = fp_div(numerator, denominator)?;
    Ok(fp_sqrt(ratio)?.clamp(rules.crowd_min, rules.crowd_max))
}

/// Freezes probability, risk, crowding, and points for all flags at lock.
pub fn lock_scores(
    spot: u128,
    remaining_variance: u128,
    drift_per_variance: i128,
    placements: &[FlagPlacement],
    rules: ScoringRules,
) -> Result<Vec<LockedScore>, CoreError> {
    rules.validate()?;
    if placements.is_empty() {
        return Ok(Vec::new());
    }

    let mut distances = Vec::with_capacity(placements.len());
    let mut probabilities = Vec::with_capacity(placements.len());
    let mut sides = Vec::with_capacity(placements.len());
    for placement in placements {
        distances.push(normalized_barrier_distance(
            spot,
            placement.barrier,
            placement.side,
            remaining_variance,
        )?);
        probabilities.push(
            one_sided_no_touch(NoTouchInputs {
                spot,
                barrier: placement.barrier,
                remaining_variance,
                drift_per_variance,
                side: placement.side,
                already_breached: false,
            })?
            .survival_probability,
        );
        sides.push(placement.side);
    }

    let mut locked = Vec::with_capacity(placements.len());
    for (index, placement) in placements.iter().enumerate() {
        let crowd = crowd_factor(index, &sides, &distances, rules)?;
        let risk = risk_multiplier_with_rules(probabilities[index], rules)?;
        let score = terminal_score_with_rules(risk, crowd, rules)?;
        locked.push(LockedScore {
            contender_id: placement.contender_id,
            side: placement.side,
            barrier: placement.barrier,
            normalized_distance: distances[index],
            initial_survival: probabilities[index],
            risk_multiplier: risk,
            crowd_factor: crowd,
            terminal_score: score,
        });
    }
    Ok(locked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SCALE_I;

    #[test]
    fn roadmap_risk_ladder_is_preserved() {
        assert_eq!(risk_multiplier(900_000_000_000).unwrap(), SCALE);
        assert_eq!(risk_multiplier(450_000_000_000).unwrap(), 2 * SCALE);
        assert_eq!(risk_multiplier(180_000_000_000).unwrap(), 5 * SCALE);
        assert_eq!(risk_multiplier(100_000_000_000).unwrap(), 8 * SCALE);
    }

    #[test]
    fn crowding_is_separate_by_side_and_locks_scores() {
        let placements = [
            FlagPlacement {
                contender_id: 1,
                side: BarrierSide::Upper,
                barrier: 110 * SCALE,
            },
            FlagPlacement {
                contender_id: 2,
                side: BarrierSide::Upper,
                barrier: 110_500_000_000_000,
            },
            FlagPlacement {
                contender_id: 3,
                side: BarrierSide::Lower,
                barrier: 90 * SCALE,
            },
        ];
        let scores = lock_scores(
            100 * SCALE,
            6_400_000_000,
            -SCALE_I / 2,
            &placements,
            ScoringRules::default(),
        )
        .unwrap();
        assert!(scores[0].crowd_factor < scores[2].crowd_factor);
        assert!(scores.iter().all(|score| score.terminal_score > 0));
    }

    #[test]
    fn empty_band_matches_the_published_uncrowded_bonus() {
        let crowd =
            crowd_factor(0, &[BarrierSide::Upper], &[SCALE], ScoringRules::default()).unwrap();
        assert!((1_341_000_000_000..=1_342_000_000_000).contains(&crowd));
    }

    #[test]
    fn escape_is_locked_score_times_live_survival() {
        let maximum = 320 * SCALE;
        assert_eq!(escape_value(maximum, 625_000_000_000).unwrap(), 200 * SCALE);
    }
}
