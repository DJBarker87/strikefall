use solmath::{exp_fixed_i, fp_mul, SCALE_I};
use strikefall_core::{one_sided_no_touch, BarrierSide, NoTouchInputs, SCALE};

fn barrier_at_distance(spot: u128, distance: i128, side: BarrierSide) -> u128 {
    let exponent = match side {
        BarrierSide::Upper => distance,
        BarrierSide::Lower => -distance,
    };
    let ratio = u128::try_from(exp_fixed_i(exponent).unwrap()).unwrap();
    let barrier = fp_mul(spot, ratio).unwrap();
    match side {
        BarrierSide::Upper => barrier.max(spot + 1),
        BarrierSide::Lower => barrier.clamp(1, spot - 1),
    }
}

fn quote(distance: i128, variance: u128, drift: i128, side: BarrierSide) -> u128 {
    let spot = 100 * SCALE;
    one_sided_no_touch(NoTouchInputs {
        spot,
        barrier: barrier_at_distance(spot, distance, side),
        remaining_variance: variance,
        drift_per_variance: drift,
        side,
        already_breached: false,
    })
    .unwrap()
    .survival_probability
}

#[test]
fn survival_is_monotone_across_the_supported_distance_variance_and_drift_grid() {
    let distances = [
        1_000_000,
        100_000_000,
        1_000_000_000,
        5_000_000_000,
        25_000_000_000,
        100_000_000_000,
        250_000_000_000,
        500_000_000_000,
    ];
    let variances = [
        1,
        1_000,
        1_000_000,
        100_000_000,
        6_400_000_000,
        40_000_000_000,
        200_000_000_000,
        500_000_000_000,
    ];
    let drifts = [
        -4 * SCALE_I,
        -SCALE_I,
        -SCALE_I / 2,
        0,
        SCALE_I / 4,
        SCALE_I,
        4 * SCALE_I,
    ];

    for side in [BarrierSide::Upper, BarrierSide::Lower] {
        for drift in drifts {
            for variance in variances {
                let values: Vec<_> = distances
                    .iter()
                    .map(|distance| quote(*distance, variance, drift, side))
                    .collect();
                assert!(
                    values.windows(2).all(|pair| pair[0] <= pair[1]),
                    "distance monotonicity failed: side={side:?} drift={drift} variance={variance} values={values:?}"
                );
            }
            for distance in distances {
                let values: Vec<_> = variances
                    .iter()
                    .map(|variance| quote(distance, *variance, drift, side))
                    .collect();
                assert!(
                    values.windows(2).all(|pair| pair[0] >= pair[1]),
                    "variance monotonicity failed: side={side:?} drift={drift} distance={distance} values={values:?}"
                );
            }
        }
    }
}

#[derive(Clone, Copy)]
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(self) -> (Self, u64) {
        let state = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = state;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (Self(state), value ^ (value >> 31))
    }
}

#[test]
fn deterministic_property_fuzz_preserves_public_probability_conservation() {
    let mut rng = SplitMix64(0x5354_5249_4B45_4641);
    for case in 0..25_000 {
        let (next, word) = rng.next();
        rng = next;
        let side = if word & 1 == 0 {
            BarrierSide::Upper
        } else {
            BarrierSide::Lower
        };
        let spot = (10 + u128::from(word % 991)) * SCALE + u128::from(word % 1_000_000);

        let (next, word) = rng.next();
        rng = next;
        let distance = 1_000_000 + i128::from(word % 499_999_000_001);
        let barrier = barrier_at_distance(spot, distance, side);

        let (next, word) = rng.next();
        rng = next;
        let variance = 1 + u128::from(word % 500_000_000_000);

        let (next, word) = rng.next();
        rng = next;
        let drift = i128::from(word % 8_000_000_000_001) - 4 * SCALE_I;

        let result = one_sided_no_touch(NoTouchInputs {
            spot,
            barrier,
            remaining_variance: variance,
            drift_per_variance: drift,
            side,
            already_breached: false,
        })
        .unwrap_or_else(|error| panic!("supported fuzz case {case} failed: {error}"));
        assert!(result.survival_probability <= SCALE);
        assert!(result.hit_probability <= SCALE);
        assert_eq!(result.survival_probability + result.hit_probability, SCALE);
    }
}

#[test]
fn extreme_domain_fuzz_returns_an_error_or_a_conserved_probability_pair() {
    let mut rng = SplitMix64(0x4F56_4552_464C_4F57);
    let fixed_cases = [
        NoTouchInputs {
            spot: 0,
            barrier: SCALE,
            remaining_variance: SCALE,
            drift_per_variance: 0,
            side: BarrierSide::Upper,
            already_breached: false,
        },
        NoTouchInputs {
            spot: SCALE,
            barrier: 0,
            remaining_variance: SCALE,
            drift_per_variance: 0,
            side: BarrierSide::Lower,
            already_breached: false,
        },
        NoTouchInputs {
            spot: SCALE,
            barrier: 2 * SCALE,
            remaining_variance: u128::MAX,
            drift_per_variance: 4 * SCALE_I,
            side: BarrierSide::Upper,
            already_breached: false,
        },
        NoTouchInputs {
            spot: u128::MAX - 1,
            barrier: u128::MAX,
            remaining_variance: u128::MAX,
            drift_per_variance: -4 * SCALE_I,
            side: BarrierSide::Upper,
            already_breached: false,
        },
    ];

    for inputs in fixed_cases {
        if let Ok(result) = one_sided_no_touch(inputs) {
            assert_eq!(result.survival_probability + result.hit_probability, SCALE);
        }
    }

    for _ in 0..10_000 {
        let (next, spot_low) = rng.next();
        rng = next;
        let (next, spot_high) = rng.next();
        rng = next;
        let (next, barrier_low) = rng.next();
        rng = next;
        let (next, barrier_high) = rng.next();
        rng = next;
        let (next, variance_low) = rng.next();
        rng = next;
        let (next, variance_high) = rng.next();
        rng = next;
        let (next, drift_word) = rng.next();
        rng = next;
        let inputs = NoTouchInputs {
            spot: (u128::from(spot_high) << 64) | u128::from(spot_low),
            barrier: (u128::from(barrier_high) << 64) | u128::from(barrier_low),
            remaining_variance: (u128::from(variance_high) << 64) | u128::from(variance_low),
            drift_per_variance: i128::from(drift_word),
            side: if drift_word & 1 == 0 {
                BarrierSide::Upper
            } else {
                BarrierSide::Lower
            },
            already_breached: false,
        };
        if let Ok(result) = one_sided_no_touch(inputs) {
            assert!(result.survival_probability <= SCALE);
            assert!(result.hit_probability <= SCALE);
            assert_eq!(result.survival_probability + result.hit_probability, SCALE);
        }
    }
}
