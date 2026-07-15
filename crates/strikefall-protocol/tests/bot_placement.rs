use strikefall_core::{deck_by_id, SCALE};
use strikefall_protocol::{
    evaluate_bot_placement_decision, generate_bot_initial_roster, generate_bot_placement_schedule,
    generate_player_placement,
};

const WINDOW_MS: u64 = 12_000;
const FREEZE_MS: u64 = 750;

#[test]
fn schedule_is_deterministic_human_limited_and_caps_every_bot_at_three_moves() {
    let seed = [41_u8; 32];
    let first =
        generate_bot_placement_schedule(&seed, WINDOW_MS, FREEZE_MS).expect("canonical schedule");
    let replayed =
        generate_bot_placement_schedule(&seed, WINDOW_MS, FREEZE_MS).expect("replayed schedule");
    let other = generate_bot_placement_schedule(&[42_u8; 32], WINDOW_MS, FREEZE_MS)
        .expect("other schedule");
    assert_eq!(first, replayed);
    assert_ne!(first, other);
    assert!(first.windows(2).all(|entries| {
        (
            entries[0].decision_time_ms,
            entries[0].contender_id,
            entries[0].decision_number,
        ) <= (
            entries[1].decision_time_ms,
            entries[1].contender_id,
            entries[1].decision_number,
        )
    }));
    for contender_id in 1..=19 {
        let moves: Vec<_> = first
            .iter()
            .filter(|entry| entry.contender_id == contender_id)
            .collect();
        assert!((1..=3).contains(&moves.len()));
        assert!(moves.iter().enumerate().all(|(index, entry)| {
            entry.decision_number == u16::try_from(index + 1).expect("decision number")
                && (250..=1_500).contains(&entry.reaction_latency_ms)
                && entry.decision_time_ms >= u64::from(entry.reaction_latency_ms)
                && entry.decision_time_ms - entry.observation_time_ms
                    == u64::from(entry.reaction_latency_ms)
                && entry.decision_time_ms <= WINDOW_MS - FREEZE_MS
        }));
        assert!(moves
            .windows(2)
            .all(|entries| { entries[0].decision_time_ms < entries[1].observation_time_ms }));
    }
}

#[test]
fn due_decision_discloses_all_candidates_and_commits_only_public_state() {
    let deck = deck_by_id("balanced_tape").expect("deck");
    let seed = [91_u8; 32];
    let spot = 100 * SCALE;
    let bots = generate_bot_initial_roster(deck, &seed, spot).expect("initial bots");
    let mut placements = vec![generate_player_placement(deck, spot).expect("player")];
    placements.extend(bots);
    let scheduled =
        generate_bot_placement_schedule(&seed, WINDOW_MS, FREEZE_MS).expect("schedule")[0];
    let first = evaluate_bot_placement_decision(deck, &seed, spot, scheduled, &placements)
        .expect("first evaluation");
    let replayed = evaluate_bot_placement_decision(deck, &seed, spot, scheduled, &placements)
        .expect("replayed evaluation");
    assert_eq!(first, replayed);
    assert_eq!(first.candidate_count, 12);
    assert_eq!(first.candidates.len(), 12);
    assert_eq!(first.decision_time_ms, scheduled.decision_time_ms);
    assert_eq!(first.observation_time_ms, scheduled.observation_time_ms);
    assert_eq!(
        first.decision_time_ms - first.observation_time_ms,
        u64::from(first.reaction_latency_ms)
    );
    assert_eq!(first.reaction_latency_ms, scheduled.reaction_latency_ms);
    assert_eq!(first.public_inputs_digest.len(), 64);
    assert_eq!(first.entropy_digest.len(), 64);
    assert_eq!(first.candidates_digest.len(), 64);
    let selected = &first.candidates[usize::from(first.selected_candidate)];
    assert_eq!(selected.utility, first.selected_utility);
    assert_eq!(selected.side, first.placement.side);
    assert_eq!(selected.barrier, first.placement.barrier);
    assert!(first.candidates.iter().all(|candidate| {
        candidate
            .quoted_survival
            .parse::<u128>()
            .is_ok_and(|value| value <= SCALE)
            && candidate.utility.parse::<i128>().is_ok()
    }));

    // A visible player move changes the public-state commitment. The hidden
    // path is intentionally absent from this API, so it cannot influence the
    // placement decision.
    placements[0].side = strikefall_protocol::SideDto::Lower;
    placements[0].barrier = (spot - SCALE).to_string();
    let changed = evaluate_bot_placement_decision(deck, &seed, spot, scheduled, &placements)
        .expect("evaluation against changed visible state");
    assert_ne!(changed.public_inputs_digest, first.public_inputs_digest);
    assert_eq!(changed.entropy_digest, first.entropy_digest);
}

#[test]
fn invalid_short_window_cannot_create_a_final_millisecond_advantage() {
    assert!(generate_bot_placement_schedule(&[1_u8; 32], 1_500, 750).is_err());
    assert!(generate_bot_placement_schedule(&[1_u8; 32], 12_000, 12_000).is_err());
}
