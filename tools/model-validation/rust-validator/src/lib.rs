use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use strikefall_core::{one_sided_no_touch, BarrierSide, NoTouchInputs, SCALE};

pub const PRODUCTION_ROWS: usize = 100_000;
pub const ADVERSARIAL_ROWS: usize = 10_000;
pub const PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED: u128 = 200_000;
pub const ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED: u128 = 1_000_000;
const HEADER: &str = "case_id,category,side,spot,barrier,remaining_variance,drift_per_variance,already_breached,survival_scaled";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationSummary {
    pub campaign: String,
    pub rows: usize,
    pub exact_matches: usize,
    pub max_absolute_error_scaled: u128,
    pub max_error_case_id: String,
    pub mean_absolute_error_scaled: u128,
    pub p50_absolute_error_scaled: u128,
    pub p95_absolute_error_scaled: u128,
    pub p99_absolute_error_scaled: u128,
    pub minimum_survival_scaled: u128,
    pub maximum_survival_scaled: u128,
}

impl ValidationSummary {
    #[must_use]
    pub fn json(&self) -> String {
        format!(
            concat!(
                "{{\"campaign\":\"{}\",\"rows\":{},\"exact_matches\":{},",
                "\"max_absolute_error_scaled\":{},\"max_error_case_id\":\"{}\",",
                "\"mean_absolute_error_scaled\":{},\"p50_absolute_error_scaled\":{},",
                "\"p95_absolute_error_scaled\":{},\"p99_absolute_error_scaled\":{},",
                "\"minimum_survival_scaled\":{},\"maximum_survival_scaled\":{}}}"
            ),
            self.campaign,
            self.rows,
            self.exact_matches,
            self.max_absolute_error_scaled,
            self.max_error_case_id,
            self.mean_absolute_error_scaled,
            self.p50_absolute_error_scaled,
            self.p95_absolute_error_scaled,
            self.p99_absolute_error_scaled,
            self.minimum_survival_scaled,
            self.maximum_survival_scaled,
        )
    }
}

fn parse_signed_fixed(value: &str) -> Result<i128, String> {
    let (negative, digits) = value
        .strip_prefix('-')
        .map_or((false, value), |rest| (true, rest));
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() || fraction.len() > 12 {
        return Err(format!("invalid fixed-point value {value:?}"));
    }
    let mut fraction_padded = fraction.to_owned();
    fraction_padded.extend(std::iter::repeat_n('0', 12 - fraction.len()));
    let whole_scaled = whole
        .parse::<i128>()
        .map_err(|error| format!("invalid fixed-point whole {value:?}: {error}"))?
        .checked_mul(i128::try_from(SCALE).expect("scale fits i128"))
        .ok_or_else(|| format!("fixed-point overflow for {value:?}"))?;
    let fractional = fraction_padded
        .parse::<i128>()
        .map_err(|error| format!("invalid fixed-point fraction {value:?}: {error}"))?;
    let magnitude = whole_scaled
        .checked_add(fractional)
        .ok_or_else(|| format!("fixed-point overflow for {value:?}"))?;
    Ok(if negative { -magnitude } else { magnitude })
}

fn parse_unsigned_fixed(value: &str) -> Result<u128, String> {
    if value.starts_with('-') {
        return Err(format!(
            "expected unsigned fixed-point value, got {value:?}"
        ));
    }
    u128::try_from(parse_signed_fixed(value)?)
        .map_err(|error| format!("fixed-point conversion failed for {value:?}: {error}"))
}

fn percentile(sorted: &[u128], numerator: usize) -> u128 {
    let index = (sorted.len() - 1) * numerator / 100;
    sorted[index]
}

struct EvaluatedRow<'a> {
    case_id: &'a str,
    absolute_error: u128,
    survival: u128,
}

fn evaluate_row<'a>(
    row: &'a str,
    campaign: &str,
    line_number: usize,
) -> Result<EvaluatedRow<'a>, String> {
    let raw_fields: Vec<_> = row.split(',').collect();
    let field_count = raw_fields.len();
    let fields: [&str; 9] = raw_fields.try_into().map_err(|_| {
        format!("{campaign} line {line_number}: expected 9 fields, got {field_count}")
    })?;
    let [case_id, _category, side_text, spot, barrier, variance, drift, breached_text, expected_text] =
        fields;
    let side = match side_text {
        "upper" => BarrierSide::Upper,
        "lower" => BarrierSide::Lower,
        value => {
            return Err(format!(
                "{campaign} line {line_number}: invalid side {value:?}"
            ))
        }
    };
    let already_breached = match breached_text {
        "true" => true,
        "false" => false,
        value => {
            return Err(format!(
                "{campaign} line {line_number}: invalid already_breached {value:?}"
            ));
        }
    };
    let expected = expected_text
        .parse::<u128>()
        .map_err(|error| format!("{campaign} line {line_number}: invalid expectation: {error}"))?;
    if expected > SCALE {
        return Err(format!(
            "{campaign} line {line_number}: expectation exceeds SCALE"
        ));
    }
    let result = one_sided_no_touch(NoTouchInputs {
        spot: parse_unsigned_fixed(spot)?,
        barrier: parse_unsigned_fixed(barrier)?,
        remaining_variance: parse_unsigned_fixed(variance)?,
        drift_per_variance: parse_signed_fixed(drift)?,
        side,
        already_breached,
    })
    .map_err(|error| {
        format!("{campaign} line {line_number} case {case_id}: quote failed: {error}")
    })?;
    if result.survival_probability > SCALE
        || result.hit_probability > SCALE
        || result.survival_probability + result.hit_probability != SCALE
    {
        return Err(format!(
            "{campaign} line {line_number} case {case_id}: public probability identity failed"
        ));
    }
    Ok(EvaluatedRow {
        case_id,
        absolute_error: result.survival_probability.abs_diff(expected),
        survival: result.survival_probability,
    })
}

pub fn validate_corpus(
    path: &Path,
    campaign: &str,
    expected_rows: usize,
    max_absolute_error_scaled: u128,
) -> Result<ValidationSummary, String> {
    let file =
        File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    validate_reader(
        BufReader::new(file),
        campaign,
        expected_rows,
        max_absolute_error_scaled,
    )
}

pub fn validate_reader(
    mut reader: impl BufRead,
    campaign: &str,
    expected_rows: usize,
    max_absolute_error_scaled: u128,
) -> Result<ValidationSummary, String> {
    if expected_rows == 0 {
        return Err(format!("{campaign}: expected row count must be positive"));
    }
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("cannot read {campaign} header: {error}"))?;
    if line.trim_end_matches(['\r', '\n']) != HEADER {
        return Err(format!("{campaign}: unexpected CSV header"));
    }

    let mut errors = Vec::with_capacity(expected_rows);
    let mut exact_matches = 0;
    let mut maximum_error = 0;
    let mut maximum_error_case = String::new();
    let mut sum_error = 0_u128;
    let mut minimum_survival = SCALE;
    let mut maximum_survival = 0;
    let mut rows = 0;

    line.clear();
    while reader
        .read_line(&mut line)
        .map_err(|error| format!("cannot read {campaign} row {}: {error}", rows + 2))?
        != 0
    {
        let evaluated = evaluate_row(line.trim_end_matches(['\r', '\n']), campaign, rows + 2)?;
        let error = evaluated.absolute_error;
        if error == 0 {
            exact_matches += 1;
        }
        if rows == 0 || error > maximum_error {
            maximum_error = error;
            maximum_error_case.clear();
            maximum_error_case.push_str(evaluated.case_id);
        }
        sum_error = sum_error
            .checked_add(error)
            .ok_or_else(|| format!("{campaign}: aggregate error overflow"))?;
        minimum_survival = minimum_survival.min(evaluated.survival);
        maximum_survival = maximum_survival.max(evaluated.survival);
        errors.push(error);
        rows += 1;
        line.clear();
    }

    if rows != expected_rows {
        return Err(format!(
            "{campaign}: expected {expected_rows} rows, validated {rows}"
        ));
    }
    errors.sort_unstable();
    let row_divisor = u128::try_from(rows)
        .map_err(|error| format!("{campaign}: row count conversion failed: {error}"))?;
    let summary = ValidationSummary {
        campaign: campaign.to_owned(),
        rows,
        exact_matches,
        max_absolute_error_scaled: maximum_error,
        max_error_case_id: maximum_error_case,
        mean_absolute_error_scaled: sum_error / row_divisor,
        p50_absolute_error_scaled: percentile(&errors, 50),
        p95_absolute_error_scaled: percentile(&errors, 95),
        p99_absolute_error_scaled: percentile(&errors, 99),
        minimum_survival_scaled: minimum_survival,
        maximum_survival_scaled: maximum_survival,
    };
    if maximum_error > max_absolute_error_scaled {
        let mut detail = String::new();
        let _ = write!(
            detail,
            "{campaign}: maximum absolute error {maximum_error} at {} exceeds declared tolerance {max_absolute_error_scaled}; summary={}",
            summary.max_error_case_id,
            summary.json()
        );
        return Err(detail);
    }
    Ok(summary)
}

#[must_use]
pub fn default_corpus_paths() -> (PathBuf, PathBuf) {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let _ = root.pop();
    (
        root.join("no_touch_production.csv"),
        root.join("no_touch_adversarial.csv"),
    )
}

pub fn validate_default_corpora() -> Result<[ValidationSummary; 2], String> {
    let (production, adversarial) = default_corpus_paths();
    Ok([
        validate_corpus(
            &production,
            "production",
            PRODUCTION_ROWS,
            PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED,
        )?,
        validate_corpus(
            &adversarial,
            "adversarial",
            ADVERSARIAL_ROWS,
            ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED,
        )?,
    ])
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn validates_a_minimal_exact_csv_and_probability_identity() {
        let csv = concat!(
            "case_id,category,side,spot,barrier,remaining_variance,drift_per_variance,already_breached,survival_scaled\n",
            "limit,zero_variance_limit,upper,100,101,0,-0.5,false,1000000000000\n"
        );
        let summary = validate_reader(Cursor::new(csv), "unit", 1, 0).unwrap();
        assert_eq!(summary.rows, 1);
        assert_eq!(summary.exact_matches, 1);
        assert_eq!(summary.minimum_survival_scaled, SCALE);
    }

    #[test]
    fn rejects_row_count_and_tolerance_failures() {
        let header = format!("{HEADER}\n");
        assert!(validate_reader(Cursor::new(header.as_bytes()), "empty", 1, 0).is_err());

        let mismatch =
            format!("{HEADER}\nlimit,zero_variance_limit,upper,100,101,0,-0.5,false,0\n");
        let error = validate_reader(Cursor::new(mismatch.as_bytes()), "mismatch", 1, 0)
            .expect_err("wrong high-precision expectation must fail");
        assert!(error.contains("exceeds declared tolerance"));
    }
}
