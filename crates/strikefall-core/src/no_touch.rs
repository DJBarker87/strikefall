use solmath::{
    exp_fixed_i, fp_div, fp_div_i, fp_mul, fp_mul_i, fp_sqrt, ln_fixed_i, norm_cdf_poly, SCALE,
    SCALE_I,
};

use crate::CoreError;

const MAX_ABS_DRIFT: i128 = 4 * SCALE_I;
const MAX_SOLVER_LOG_DISTANCE: i128 = 2 * SCALE_I;
const SOLVER_ITERATIONS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum BarrierSide {
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct NoTouchInputs {
    pub spot: u128,
    pub barrier: u128,
    pub remaining_variance: u128,
    pub drift_per_variance: i128,
    pub side: BarrierSide,
    pub already_breached: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct NoTouchQuote {
    pub survival_probability: u128,
    pub hit_probability: u128,
}

fn breached(spot: u128, barrier: u128, side: BarrierSide) -> bool {
    match side {
        BarrierSide::Upper => spot >= barrier,
        BarrierSide::Lower => spot <= barrier,
    }
}

fn validate_direction(spot: u128, barrier: u128, side: BarrierSide) -> Result<(), CoreError> {
    if spot == 0 {
        return Err(CoreError::InvalidSpot);
    }
    if barrier == 0 {
        return Err(CoreError::InvalidBarrier);
    }
    let valid = match side {
        BarrierSide::Upper => barrier > spot,
        BarrierSide::Lower => barrier < spot,
    };
    if !valid {
        return Err(CoreError::InvalidBarrier);
    }
    Ok(())
}

fn paired_quote(survival: i128) -> NoTouchQuote {
    let clamped = u128::try_from(survival.clamp(0, SCALE_I)).unwrap_or(0);
    NoTouchQuote {
        survival_probability: clamped,
        hit_probability: SCALE - clamped,
    }
}

/// Quotes the continuous one-sided no-touch claim.
///
/// The released `SolMath` crate does not yet expose the roadmap's dedicated
/// first-passage API, so this formula is assembled exclusively from its public
/// fixed-point, log, exponential, square-root, and normal-CDF primitives. It
/// remains product-side scaffolding until `SolMath` ships that independent API.
pub fn one_sided_no_touch(inputs: NoTouchInputs) -> Result<NoTouchQuote, CoreError> {
    if inputs.spot == 0 {
        return Err(CoreError::InvalidSpot);
    }
    if inputs.barrier == 0 {
        return Err(CoreError::InvalidBarrier);
    }
    if inputs.drift_per_variance.unsigned_abs() > MAX_ABS_DRIFT.unsigned_abs() {
        return Err(CoreError::InvalidPlacement);
    }
    if inputs.already_breached || breached(inputs.spot, inputs.barrier, inputs.side) {
        return Ok(paired_quote(0));
    }
    validate_direction(inputs.spot, inputs.barrier, inputs.side)?;
    if inputs.remaining_variance == 0 {
        return Ok(paired_quote(SCALE_I));
    }

    analytic_quote_with_drift(inputs)
}

fn analytic_quote_with_drift(inputs: NoTouchInputs) -> Result<NoTouchQuote, CoreError> {
    let ratio = match inputs.side {
        BarrierSide::Upper => fp_div(inputs.barrier, inputs.spot)?,
        BarrierSide::Lower => fp_div(inputs.spot, inputs.barrier)?,
    };
    let distance = ln_fixed_i(ratio)?;
    if distance <= 0 {
        return Ok(paired_quote(0));
    }
    let effective_drift = match inputs.side {
        BarrierSide::Upper => inputs.drift_per_variance,
        BarrierSide::Lower => inputs
            .drift_per_variance
            .checked_neg()
            .ok_or(CoreError::ArithmeticOverflow)?,
    };
    let sqrt_variance = i128::try_from(fp_sqrt(inputs.remaining_variance)?)
        .map_err(|_| CoreError::ArithmeticOverflow)?;
    if sqrt_variance == 0 {
        return Ok(paired_quote(SCALE_I));
    }
    let variance_i =
        i128::try_from(inputs.remaining_variance).map_err(|_| CoreError::ArithmeticOverflow)?;
    let drift_over_horizon = fp_mul_i(effective_drift, variance_i)?;
    let first_numerator = distance
        .checked_sub(drift_over_horizon)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let second_numerator = distance
        .checked_neg()
        .and_then(|value| value.checked_sub(drift_over_horizon))
        .ok_or(CoreError::ArithmeticOverflow)?;
    let first_argument = fp_div_i(first_numerator, sqrt_variance)?;
    let second_argument = fp_div_i(second_numerator, sqrt_variance)?;
    let first_cdf = norm_cdf_poly(first_argument)?;
    let second_cdf = norm_cdf_poly(second_argument)?;
    let reflection_exponent = fp_mul_i(effective_drift, distance)?
        .checked_mul(2)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let reflection = exp_fixed_i(reflection_exponent)?;
    let reflected_cdf = fp_mul_i(reflection, second_cdf)?;
    let survival = if reflected_cdf >= first_cdf {
        0
    } else {
        first_cdf - reflected_cdf
    };
    Ok(paired_quote(survival))
}

fn barrier_at_distance(spot: u128, distance: i128, side: BarrierSide) -> Result<u128, CoreError> {
    let signed_distance = match side {
        BarrierSide::Upper => distance,
        BarrierSide::Lower => distance
            .checked_neg()
            .ok_or(CoreError::ArithmeticOverflow)?,
    };
    let ratio = exp_fixed_i(signed_distance)?;
    if ratio <= 0 {
        return Err(CoreError::InvalidBarrier);
    }
    let ratio_u = u128::try_from(ratio).map_err(|_| CoreError::InvalidBarrier)?;
    Ok(fp_mul(spot, ratio_u)?)
}

/// Solves the monotone no-touch quote for a barrier using fixed 64-iteration
/// bisection in log-distance space.
pub fn barrier_for_survival(
    spot: u128,
    target_survival: u128,
    remaining_variance: u128,
    drift_per_variance: i128,
    side: BarrierSide,
) -> Result<u128, CoreError> {
    if spot == 0 {
        return Err(CoreError::InvalidSpot);
    }
    if target_survival == 0 || target_survival >= SCALE || remaining_variance == 0 {
        return Err(CoreError::InvalidProbability);
    }

    let high_barrier = barrier_at_distance(spot, MAX_SOLVER_LOG_DISTANCE, side)?;
    let high_quote = one_sided_no_touch(NoTouchInputs {
        spot,
        barrier: high_barrier,
        remaining_variance,
        drift_per_variance,
        side,
        already_breached: false,
    })?;
    if high_quote.survival_probability < target_survival {
        return Err(CoreError::TargetOutOfRange);
    }

    let mut low = 0_i128;
    let mut high = MAX_SOLVER_LOG_DISTANCE;
    for _ in 0..SOLVER_ITERATIONS {
        let midpoint = low + (high - low) / 2;
        let barrier = barrier_at_distance(spot, midpoint, side)?;
        if breached(spot, barrier, side) {
            low = midpoint;
            continue;
        }
        let quote = one_sided_no_touch(NoTouchInputs {
            spot,
            barrier,
            remaining_variance,
            drift_per_variance,
            side,
            already_breached: false,
        })?;
        if quote.survival_probability < target_survival {
            low = midpoint;
        } else {
            high = midpoint;
        }
    }
    barrier_at_distance(spot, high, side)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(barrier: u128, side: BarrierSide, variance: u128) -> NoTouchQuote {
        one_sided_no_touch(NoTouchInputs {
            spot: 100 * SCALE,
            barrier,
            remaining_variance: variance,
            drift_per_variance: -SCALE_I / 2,
            side,
            already_breached: false,
        })
        .unwrap()
    }

    #[test]
    fn neutral_quote_uses_known_solmath_reference() {
        let result = quote(120 * SCALE, BarrierSide::Upper, 90_000_000_000);
        // sqrt(0.09)=30%; SolMath documents touch around 49.4%.
        assert!(result.hit_probability > 490_000_000_000);
        assert!(result.hit_probability < 500_000_000_000);
        assert_eq!(result.survival_probability + result.hit_probability, SCALE);
    }

    #[test]
    fn already_breached_and_zero_variance_limits_are_exact() {
        let breached_quote = one_sided_no_touch(NoTouchInputs {
            spot: 100 * SCALE,
            barrier: 101 * SCALE,
            remaining_variance: 1,
            drift_per_variance: -SCALE_I / 2,
            side: BarrierSide::Upper,
            already_breached: true,
        })
        .unwrap();
        assert_eq!(breached_quote.survival_probability, 0);
        assert_eq!(breached_quote.hit_probability, SCALE);

        let deterministic = quote(120 * SCALE, BarrierSide::Upper, 0);
        assert_eq!(deterministic.survival_probability, SCALE);
        assert_eq!(deterministic.hit_probability, 0);
    }

    #[test]
    fn survival_increases_with_distance_and_falls_with_variance() {
        let close = quote(105 * SCALE, BarrierSide::Upper, 6_400_000_000);
        let far = quote(115 * SCALE, BarrierSide::Upper, 6_400_000_000);
        assert!(far.survival_probability > close.survival_probability);

        let calm = quote(110 * SCALE, BarrierSide::Upper, 3_200_000_000);
        let storm = quote(110 * SCALE, BarrierSide::Upper, 9_600_000_000);
        assert!(calm.survival_probability > storm.survival_probability);
    }

    #[test]
    fn custom_drift_path_preserves_paired_rounding() {
        for side in [BarrierSide::Upper, BarrierSide::Lower] {
            let barrier = match side {
                BarrierSide::Upper => 112 * SCALE,
                BarrierSide::Lower => 88 * SCALE,
            };
            let result = one_sided_no_touch(NoTouchInputs {
                spot: 100 * SCALE,
                barrier,
                remaining_variance: 6_400_000_000,
                drift_per_variance: SCALE_I / 4,
                side,
                already_breached: false,
            })
            .unwrap();
            assert!(result.survival_probability <= SCALE);
            assert_eq!(result.survival_probability + result.hit_probability, SCALE);
        }
    }

    #[test]
    fn upper_lower_reflection_symmetry_holds_on_a_grid() {
        for distance in [25_000_000_000, 100_000_000_000, 250_000_000_000] {
            for drift in [-750_000_000_000, -SCALE_I / 2, 0, 250_000_000_000] {
                for variance in [100_000_000, 6_400_000_000, 40_000_000_000] {
                    let upper_barrier =
                        barrier_at_distance(100 * SCALE, distance, BarrierSide::Upper).unwrap();
                    let lower_barrier =
                        barrier_at_distance(100 * SCALE, distance, BarrierSide::Lower).unwrap();
                    let upper = one_sided_no_touch(NoTouchInputs {
                        spot: 100 * SCALE,
                        barrier: upper_barrier,
                        remaining_variance: variance,
                        drift_per_variance: drift,
                        side: BarrierSide::Upper,
                        already_breached: false,
                    })
                    .unwrap();
                    let lower = one_sided_no_touch(NoTouchInputs {
                        spot: 100 * SCALE,
                        barrier: lower_barrier,
                        remaining_variance: variance,
                        drift_per_variance: -drift,
                        side: BarrierSide::Lower,
                        already_breached: false,
                    })
                    .unwrap();
                    assert!(
                        upper
                            .survival_probability
                            .abs_diff(lower.survival_probability)
                            < 100_000,
                        "distance={distance} drift={drift} variance={variance} upper={upper:?} lower={lower:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn barrier_solver_round_trips_probability_band() {
        for side in [BarrierSide::Upper, BarrierSide::Lower] {
            for target in [120_000_000_000, 450_000_000_000, 900_000_000_000] {
                let barrier =
                    barrier_for_survival(100 * SCALE, target, 6_400_000_000, -SCALE_I / 2, side)
                        .unwrap();
                let result = quote(barrier, side, 6_400_000_000);
                let error = result.survival_probability.abs_diff(target);
                assert!(
                    error < 250_000,
                    "side={side:?} target={target} got={result:?}"
                );
            }
        }
    }
}
