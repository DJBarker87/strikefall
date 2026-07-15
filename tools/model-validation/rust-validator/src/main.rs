use std::process::ExitCode;

use strikefall_model_validator::validate_default_corpora;

fn main() -> ExitCode {
    let json = std::env::args()
        .skip(1)
        .any(|argument| argument == "--json");
    match validate_default_corpora() {
        Ok(summaries) => {
            if json {
                println!(
                    "{{\"schema\":\"strikefall/model-validation-report/v1\",\"corpora\":[{},{}]}}",
                    summaries[0].json(),
                    summaries[1].json()
                );
            } else {
                for summary in summaries {
                    println!(
                        "{}: rows={} exact={} mean_error={} p50={} p95={} p99={} max={} max_case={} survival_range={}..={}",
                        summary.campaign,
                        summary.rows,
                        summary.exact_matches,
                        summary.mean_absolute_error_scaled,
                        summary.p50_absolute_error_scaled,
                        summary.p95_absolute_error_scaled,
                        summary.p99_absolute_error_scaled,
                        summary.max_absolute_error_scaled,
                        summary.max_error_case_id,
                        summary.minimum_survival_scaled,
                        summary.maximum_survival_scaled,
                    );
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("model validation failed: {error}");
            ExitCode::FAILURE
        }
    }
}
