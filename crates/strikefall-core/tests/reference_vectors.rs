use strikefall_core::{one_sided_no_touch, BarrierSide, NoTouchInputs, SCALE};

const REFERENCE: &str = include_str!("../../../tools/model-validation/no_touch_reference.csv");
// SolMath 0.2.0's documented polynomial CDF is intentionally compact. This
// bound isolates its approximation and fixed-point rounding error from the
// independently generated 80-decimal reference values.
const MAX_ABSOLUTE_ERROR: u128 = 200_000;

fn parse_unsigned_fixed(value: &str) -> u128 {
    assert!(!value.starts_with('-'));
    u128::try_from(parse_signed_fixed(value)).unwrap()
}

fn parse_signed_fixed(value: &str) -> i128 {
    let (negative, digits) = value
        .strip_prefix('-')
        .map_or((false, value), |rest| (true, rest));
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    assert!(fraction.len() <= 12, "too many decimal places in {value}");
    let mut fraction_padded = fraction.to_owned();
    fraction_padded.extend(core::iter::repeat_n('0', 12 - fraction.len()));
    let magnitude = whole.parse::<i128>().unwrap() * i128::try_from(SCALE).unwrap()
        + fraction_padded.parse::<i128>().unwrap_or(0);
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

#[test]
fn solmath_composition_matches_independent_high_precision_corpus() {
    let mut checked = 0;
    for (line_number, line) in REFERENCE.lines().enumerate().skip(1) {
        let fields: Vec<_> = line.split(',').collect();
        assert_eq!(
            fields.len(),
            6,
            "malformed vector at line {}",
            line_number + 1
        );
        let side = match fields.first().copied().expect("side field") {
            "upper" => BarrierSide::Upper,
            "lower" => BarrierSide::Lower,
            other => panic!("unknown side {other}"),
        };
        let expected = fields[5].parse::<u128>().unwrap();
        let quote = one_sided_no_touch(NoTouchInputs {
            spot: parse_unsigned_fixed(fields[1]),
            barrier: parse_unsigned_fixed(fields[2]),
            remaining_variance: parse_unsigned_fixed(fields[3]),
            drift_per_variance: parse_signed_fixed(fields[4]),
            side,
            already_breached: false,
        })
        .unwrap();
        let error = quote.survival_probability.abs_diff(expected);
        assert!(
            error <= MAX_ABSOLUTE_ERROR,
            "line {}: expected {expected}, got {}, error {error}",
            line_number + 1,
            quote.survival_probability,
        );
        assert_eq!(quote.survival_probability + quote.hit_probability, SCALE);
        checked += 1;
    }
    assert_eq!(checked, 24);
}
