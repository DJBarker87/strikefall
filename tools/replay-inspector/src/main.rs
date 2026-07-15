use std::fs::File;
use std::io::{self, BufReader};
use std::path::PathBuf;

use clap::Parser;
use replay_inspector::inspect_replay_reader_with_anchors;

#[derive(Debug, Parser)]
#[command(
    name = "replay-inspector",
    about = "Regenerate and audit a revealed Strikefall ranked replay"
)]
struct Arguments {
    /// Replay bundle JSON path, or '-' to read standard input.
    input: PathBuf,
    /// Emit the machine-readable verification report as JSON.
    #[arg(long)]
    json: bool,
    /// Commitment captured from the pre-round response or another trusted anchor.
    #[arg(long)]
    expected_commitment: Option<String>,
    /// Ed25519 public key captured from the service over a trusted channel.
    #[arg(long)]
    expected_server_key: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = Arguments::parse();
    let (report, bundle) = if arguments.input.as_os_str() == "-" {
        inspect_replay_reader_with_anchors(
            io::stdin().lock(),
            arguments.expected_commitment.as_deref(),
            arguments.expected_server_key.as_deref(),
        )?
    } else {
        inspect_replay_reader_with_anchors(
            BufReader::new(File::open(&arguments.input)?),
            arguments.expected_commitment.as_deref(),
            arguments.expected_server_key.as_deref(),
        )?
    };
    if arguments.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("verified round {}", report.round_id);
        println!("  {} deterministic path points", report.path_points);
        println!("  {} ordered signed events", report.signed_events);
        for check in report.verified_checks {
            println!("  ✓ {check}");
        }
        println!("  signed experiment treatments:");
        for (experiment_key, variant) in &bundle.experiment_assignments {
            println!("    {experiment_key} = {variant}");
        }
        println!(
            "  {} replayed bot decisions across {} disclosed BOTs",
            bundle.bot_placement_decisions.len(),
            bundle.bots.len()
        );
        for bot in &bundle.bots {
            let decisions: Vec<_> = bundle
                .bot_placement_decisions
                .iter()
                .filter(|decision| decision.contender_id == bot.contender_id)
                .collect();
            let persona = bot.persona.as_deref().unwrap_or("unknown");
            println!(
                "    {} [BOT] · {} · {} move{}",
                bot.name,
                persona,
                decisions.len(),
                if decisions.len() == 1 { "" } else { "s" }
            );
            for decision in decisions {
                println!(
                    "      #{} observed +{}.{:03}s → acted +{}.{:03}s · reaction {}ms · {}/{} candidates · {} @ {} · utility {} · {}",
                    decision.decision_number,
                    decision.observation_time_ms / 1_000,
                    decision.observation_time_ms % 1_000,
                    decision.decision_time_ms / 1_000,
                    decision.decision_time_ms % 1_000,
                    decision.reaction_latency_ms,
                    decision.selected_candidate + 1,
                    decision.candidate_count,
                    match decision.placement.side {
                        strikefall_protocol::SideDto::Upper => "upper",
                        strikefall_protocol::SideDto::Lower => "lower",
                    },
                    decision.placement.barrier,
                    decision.selected_utility,
                    decision.reason_code,
                );
            }
        }
    }
    Ok(())
}
