use alloc::vec::Vec;

use solmath::{exp_fixed_i, fp_mul, fp_mul_i, fp_sqrt, inverse_norm_cdf, ln_fixed_i};

use crate::{CoreError, DeckVersion, DeterministicRng};

const APPROACH_DOMAIN: u64 = 0x5354_524B_2F41_5050;
const BATTLE_DOMAIN: u64 = 0x5354_524B_2F42_4154;
const APPROACH_HIGH_DOMAIN: u64 = 0x4150_502F_4849_4748;
const APPROACH_LOW_DOMAIN: u64 = 0x4150_502F_4C4F_5721;
const BATTLE_HIGH_DOMAIN: u64 = 0x4241_542F_4849_4748;
const BATTLE_LOW_DOMAIN: u64 = 0x4241_542F_4C4F_5721;

/// One deterministic micro-path sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct PathPoint {
    pub step: u16,
    pub variance_elapsed: u128,
    /// Cumulative log return from this path's first sample.
    pub log_return: i128,
    pub price: u128,
    /// Exact one-sided Brownian-bridge maximum marginal for the interval
    /// ending at this point. At step zero this equals `price`.
    pub interval_high: u128,
    /// Exact one-sided Brownian-bridge minimum marginal for the interval
    /// ending at this point. At step zero this equals `price`.
    pub interval_low: u128,
}

/// OHLC view derived from micro-path samples without losing endpoint extrema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Candle {
    pub sequence: u16,
    pub open: u128,
    pub high: u128,
    pub low: u128,
    pub close: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct GeneratedRoundPath {
    pub approach: Vec<PathPoint>,
    pub battle: Vec<PathPoint>,
}

fn price_at_log_return(initial_spot: u128, log_return: i128) -> Result<u128, CoreError> {
    let growth = exp_fixed_i(log_return)?;
    if growth <= 0 {
        return Err(CoreError::Math(solmath::SolMathError::DomainError));
    }
    let growth_u = u128::try_from(growth).map_err(|_| CoreError::ArithmeticOverflow)?;
    fp_mul(initial_spot, growth_u).map_err(Into::into)
}

/// Samples the upper and lower one-sided extrema of a Brownian bridge in log
/// space, conditional on its two endpoints. The two uniforms are independent:
/// each marginal is exact for continuous monitoring, while their joint
/// upper/lower dependence is deliberately an approximation (and versioned in
/// every deck/replay). Drift disappears after conditioning on the endpoints.
fn sample_bridge_log_extrema(
    opening: i128,
    closing: i128,
    variance: u128,
    upper_uniform: i128,
    lower_uniform: i128,
) -> Result<(i128, i128), CoreError> {
    let variance_i = i128::try_from(variance).map_err(|_| CoreError::ArithmeticOverflow)?;
    let delta = opening
        .checked_sub(closing)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let delta_squared = fp_mul_i(delta, delta)?;

    let root_for = |uniform: i128| -> Result<i128, CoreError> {
        let uniform_u = u128::try_from(uniform).map_err(|_| CoreError::InvalidSchedule)?;
        if uniform_u == 0 || uniform_u >= solmath::SCALE {
            return Err(CoreError::InvalidSchedule);
        }
        // If E=-ln(U), the conditional bridge-extremum discriminant is
        // (x-y)^2 + 2*v*E. Sampling U instead of 1-U is distributionally
        // identical and avoids a lossy subtraction near one.
        let log_uniform = ln_fixed_i(uniform_u)?;
        let variance_tail = fp_mul_i(variance_i, log_uniform)?;
        let radicand = delta_squared
            .checked_sub(
                variance_tail
                    .checked_mul(2)
                    .ok_or(CoreError::ArithmeticOverflow)?,
            )
            .ok_or(CoreError::ArithmeticOverflow)?;
        let radicand_u = u128::try_from(radicand).map_err(|_| CoreError::InvalidSchedule)?;
        i128::try_from(fp_sqrt(radicand_u)?).map_err(|_| CoreError::ArithmeticOverflow)
    };

    let endpoint_sum = opening
        .checked_add(closing)
        .ok_or(CoreError::ArithmeticOverflow)?;
    let upper = (endpoint_sum
        .checked_add(root_for(upper_uniform)?)
        .ok_or(CoreError::ArithmeticOverflow)?
        / 2)
    .max(opening)
    .max(closing);
    let lower = (endpoint_sum
        .checked_sub(root_for(lower_uniform)?)
        .ok_or(CoreError::ArithmeticOverflow)?
        / 2)
    .min(opening)
    .min(closing);
    Ok((upper, lower))
}

fn generate_with_schedule<F>(
    steps: u16,
    drift_per_variance: i128,
    initial_spot: u128,
    rng: &mut DeterministicRng,
    upper_rng: &mut DeterministicRng,
    lower_rng: &mut DeterministicRng,
    mut variance_at_boundary: F,
) -> Result<Vec<PathPoint>, CoreError>
where
    F: FnMut(u16) -> Result<u128, CoreError>,
{
    if initial_spot == 0 {
        return Err(CoreError::InvalidSpot);
    }

    let mut points = Vec::with_capacity(usize::from(steps) + 1);
    let mut cumulative_log_return = 0_i128;
    points.push(PathPoint {
        step: 0,
        variance_elapsed: 0,
        log_return: 0,
        price: initial_spot,
        interval_high: initial_spot,
        interval_low: initial_spot,
    });

    let mut previous_variance = 0_u128;
    for step in 1..=steps {
        let variance_elapsed = variance_at_boundary(step)?;
        let variance_increment = variance_elapsed
            .checked_sub(previous_variance)
            .ok_or(CoreError::InvalidSchedule)?;
        if variance_increment == 0 {
            return Err(CoreError::InvalidSchedule);
        }

        let z = inverse_norm_cdf(rng.open_unit_fixed())?;
        let standard_deviation = fp_sqrt(variance_increment)?;
        let standard_deviation_i =
            i128::try_from(standard_deviation).map_err(|_| CoreError::ArithmeticOverflow)?;
        let variance_increment_i =
            i128::try_from(variance_increment).map_err(|_| CoreError::ArithmeticOverflow)?;
        let shock = fp_mul_i(standard_deviation_i, z)?;
        let drift = fp_mul_i(drift_per_variance, variance_increment_i)?;
        let log_increment = drift
            .checked_add(shock)
            .ok_or(CoreError::ArithmeticOverflow)?;
        let opening_log_return = cumulative_log_return;
        cumulative_log_return = cumulative_log_return
            .checked_add(log_increment)
            .ok_or(CoreError::ArithmeticOverflow)?;
        let price = price_at_log_return(initial_spot, cumulative_log_return)?;
        let (high_log_return, low_log_return) = sample_bridge_log_extrema(
            opening_log_return,
            cumulative_log_return,
            variance_increment,
            upper_rng.open_unit_fixed(),
            lower_rng.open_unit_fixed(),
        )?;
        let previous_price = points.last().ok_or(CoreError::InvalidSchedule)?.price;
        let interval_high = price_at_log_return(initial_spot, high_log_return)?
            .max(previous_price)
            .max(price);
        let interval_low = price_at_log_return(initial_spot, low_log_return)?
            .min(previous_price)
            .min(price);

        points.push(PathPoint {
            step,
            variance_elapsed,
            log_return: cumulative_log_return,
            price,
            interval_high,
            interval_low,
        });
        previous_variance = variance_elapsed;
    }

    Ok(points)
}

/// Generates only the battle, useful for deterministic simulation campaigns.
pub fn generate_battle_path(
    deck: &DeckVersion,
    seed: u64,
    initial_spot: u128,
) -> Result<Vec<PathPoint>, CoreError> {
    deck.validate()?;
    let mut rng = DeterministicRng::domain(seed, BATTLE_DOMAIN);
    let mut upper_rng = DeterministicRng::domain(seed, BATTLE_HIGH_DOMAIN);
    let mut lower_rng = DeterministicRng::domain(seed, BATTLE_LOW_DOMAIN);
    generate_with_schedule(
        deck.battle_steps,
        deck.drift_per_variance,
        initial_spot,
        &mut rng,
        &mut upper_rng,
        &mut lower_rng,
        |step| deck.variance_at_boundary(step),
    )
}

/// Generates the disclosed approach and hidden battle from domain-separated
/// streams. The approach consumes one quarter of the battle's integrated
/// variance and is never reused as bot randomness.
pub fn generate_round_path(
    deck: &DeckVersion,
    seed: u64,
    initial_spot: u128,
) -> Result<GeneratedRoundPath, CoreError> {
    deck.validate()?;
    let approach_variance = deck.total_integrated_variance / 4;
    let approach_steps = deck.approach_steps;
    let mut approach_rng = DeterministicRng::domain(seed, APPROACH_DOMAIN);
    let mut approach_upper_rng = DeterministicRng::domain(seed, APPROACH_HIGH_DOMAIN);
    let mut approach_lower_rng = DeterministicRng::domain(seed, APPROACH_LOW_DOMAIN);
    let approach = generate_with_schedule(
        approach_steps,
        deck.drift_per_variance,
        initial_spot,
        &mut approach_rng,
        &mut approach_upper_rng,
        &mut approach_lower_rng,
        |step| {
            approach_variance
                .checked_mul(u128::from(step))
                .map(|value| value / u128::from(approach_steps))
                .ok_or(CoreError::ArithmeticOverflow)
        },
    )?;
    let battle_spot = approach.last().ok_or(CoreError::InvalidSchedule)?.price;
    let battle = generate_battle_path(deck, seed, battle_spot)?;

    Ok(GeneratedRoundPath { approach, battle })
}

/// Converts micro samples into display candles. Each candle includes all
/// samples in its bucket, so its high/low preserves the versioned continuous
/// one-sided bridge-extrema monitoring convention.
pub fn candleize(points: &[PathPoint], samples_per_candle: u16) -> Result<Vec<Candle>, CoreError> {
    if points.len() < 2 || samples_per_candle == 0 {
        return Err(CoreError::InvalidSchedule);
    }
    let width = usize::from(samples_per_candle);
    let mut candles = Vec::with_capacity((points.len() - 1).div_ceil(width));
    for (index, body) in points[1..].chunks(width).enumerate() {
        let opening_index = index * width;
        let open = points[opening_index].price;
        let close = body.last().ok_or(CoreError::InvalidSchedule)?.price;
        let mut high = open;
        let mut low = open;
        for point in body {
            high = high.max(point.interval_high);
            low = low.min(point.interval_low);
        }
        candles.push(Candle {
            sequence: u16::try_from(index).map_err(|_| CoreError::ArithmeticOverflow)?,
            open,
            high,
            low,
            close,
        });
    }
    Ok(candles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BALANCED_TAPE, COMPRESSION_BREAK, OPENING_RUSH, SCALE};

    #[test]
    fn same_seed_replays_bit_for_bit() {
        let first = generate_battle_path(&BALANCED_TAPE, 0xCAFE_BABE, 100 * SCALE).unwrap();
        let second = generate_battle_path(&BALANCED_TAPE, 0xCAFE_BABE, 100 * SCALE).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), usize::from(BALANCED_TAPE.battle_steps) + 1);
        assert_eq!(
            first.last().unwrap().variance_elapsed,
            BALANCED_TAPE.total_integrated_variance
        );
        assert_eq!(first[60].price, 103_463_072_715_200);
        assert_eq!(first[120].price, 106_413_350_192_700);
        assert_eq!(first[240].price, 108_017_322_448_800);
        for (previous, point) in first.iter().zip(first.iter().skip(1)) {
            assert!(point.interval_high >= previous.price.max(point.price));
            assert!(point.interval_low <= previous.price.min(point.price));
        }
    }

    #[test]
    fn deck_shape_changes_path_even_with_same_seed() {
        let front = generate_battle_path(&OPENING_RUSH, 9, 100 * SCALE).unwrap();
        let back = generate_battle_path(&COMPRESSION_BREAK, 9, 100 * SCALE).unwrap();
        assert_ne!(front[60], back[60]);
    }

    #[test]
    fn round_has_contiguous_approach_and_battle() {
        let round = generate_round_path(&BALANCED_TAPE, 123, 100 * SCALE).unwrap();
        assert_eq!(round.approach.last().unwrap().price, round.battle[0].price);
        let candles = candleize(&round.approach, 4).unwrap();
        assert_eq!(candles.len(), 15);
        assert!(candles.iter().all(|candle| candle.low <= candle.open
            && candle.low <= candle.close
            && candle.high >= candle.open
            && candle.high >= candle.close));
    }

    #[test]
    fn bridge_inverse_matches_a_known_symmetric_extremum() {
        let uniform = 135_335_283_237_i128; // exp(-2) at SCALE, rounded down.
        let (high, low) = sample_bridge_log_extrema(
            0,
            0,
            10_000_000_000, // variance 0.01
            uniform,
            uniform,
        )
        .unwrap();
        // sqrt(-2 * .01 * ln(exp(-2))) / 2 = 0.1.
        assert!(high.abs_diff(100_000_000_000) <= 2_000);
        assert!(low.abs_diff(-100_000_000_000) <= 2_000);
    }

    #[test]
    fn public_frame_count_stays_constant_when_continuous_extrema_are_added() {
        let started = std::time::Instant::now();
        for seed in 0..64 {
            let path = generate_battle_path(&BALANCED_TAPE, seed, 100 * SCALE).unwrap();
            assert_eq!(path.len(), 241);
        }
        // Generous regression ceiling: bridge extrema must not accidentally
        // expand into signed 40 Hz micro-events or superlinear work.
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }
}
