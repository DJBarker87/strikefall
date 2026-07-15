use serde::Serialize;
use strikefall_core::{
    barrier_for_survival, closest_approach, escape_value, first_touch, generate_round_path,
    lock_scores as core_lock_scores, one_sided_no_touch, resolve_touches, BarrierSide, DeckVersion,
    DeterministicRng, FlagPlacement, GeneratedRoundPath, LockedScore, NoTouchInputs, PathPoint,
    ScoringRules, SCALE,
};

use crate::{
    deck_digest, hash_framed, path_digest, result_proof_digest, BotEscapeDecisionDto,
    BotEscapeRecordDto, BotPlacementCandidateDto, BotPlacementDecisionDto, ContenderOutcomeDto,
    ContenderPlacementDto, ContenderResultDto, DeckDto, EscapeRecordDto, LockedScoreDto,
    OpeningRunwayDto, PathPointDto, ProtocolError, RoundPathDto, RoundResultDto, TouchDto,
    PLAYER_CONTENDER_ID,
};

const BOT_DOMAIN: u64 = 0x5354_524B_2F42_4F54;
const BOT_SCHEDULE_DOMAIN: u64 = 0x5354_524B_2F53_4348;
const BOT_CANDIDATE_DOMAIN: u64 = 0x5354_524B_2F43_414E;
const CANONICAL_PLACEMENT_DURATION_MS: u64 = 32_000;
const CANONICAL_INPUT_FREEZE_MS: u64 = 750;
const CANDIDATE_BANDS: u16 = 6;
pub const BOT_PLACEMENT_WINDOW_MS: u64 = 12_000;
pub const BOT_PLACEMENT_POLICY_VERSION: &str = "strikefall/ranked-bot-placement/v3";
pub const BOT_ESCAPE_POLICY_VERSION: &str = "strikefall/ranked-bot-escape/v2";
pub const PLAYER_NAME: &str = "YOU";
const BOT_NAMES: [&str; 19] = [
    "Turtle.exe",
    "Wick Witch",
    "Late Bidder",
    "Mimic",
    "Chaos Kid",
    "Range Ranger",
    "Crowd Surfer",
    "Cold Storage",
    "Gamma Goblin",
    "Quiet Quasar",
    "Pixel Pilot",
    "Risk Biscuit",
    "Neon Nomad",
    "Tape Reader",
    "Moon Moth",
    "Echo Vector",
    "Static Bloom",
    "Drift King",
    "Final Form",
];
const BOT_PERSONAS: [&str; 8] = [
    "turtle",
    "wick_watcher",
    "late_bidder",
    "mimic",
    "chaos",
    "range_reader",
    "crowd_avoider",
    "score_hunter",
];

#[must_use]
pub fn deck_to_dto(deck: &DeckVersion) -> DeckDto {
    DeckDto {
        id: deck.id.as_str().to_owned(),
        version: deck.version,
        display_name: deck.display_name.to_owned(),
        approach_steps: deck.approach_steps,
        battle_steps: deck.battle_steps,
        step_ms: deck.step_ms,
        monitoring_convention: deck.monitoring_convention.to_owned(),
        variance_weights: deck.variance_weights,
        opening_runway: deck.opening_runway.map(|runway| OpeningRunwayDto {
            steps: runway.steps,
            variance_share_bps: runway.variance_share_bps,
        }),
        total_integrated_variance: deck.total_integrated_variance.to_string(),
        drift_per_variance: deck.drift_per_variance.to_string(),
        min_initial_survival: deck.min_initial_survival.to_string(),
        max_initial_survival: deck.max_initial_survival.to_string(),
        risk_multiplier_cap: deck.risk_multiplier_cap.to_string(),
        art_theme: deck.art_theme.to_owned(),
        audio_profile: deck.audio_profile.to_owned(),
        calibration_digest: hex::encode(deck.calibration_digest),
    }
}

#[must_use]
pub fn path_to_dto(path: &GeneratedRoundPath) -> RoundPathDto {
    let map = |point: &PathPoint| PathPointDto {
        step: point.step,
        variance_elapsed: point.variance_elapsed.to_string(),
        log_return: point.log_return.to_string(),
        price: point.price.to_string(),
        interval_high: point.interval_high.to_string(),
        interval_low: point.interval_low.to_string(),
    };
    RoundPathDto {
        approach: path.approach.iter().map(map).collect(),
        battle: path.battle.iter().map(map).collect(),
    }
}

pub fn generate_bot_roster(
    deck: &DeckVersion,
    bot_seed_root: &[u8; 32],
    battle_spot: u128,
) -> Result<Vec<ContenderPlacementDto>, ProtocolError> {
    generate_bot_initial_roster(deck, bot_seed_root, battle_spot)
}

pub fn generate_player_placement(
    deck: &DeckVersion,
    battle_spot: u128,
) -> Result<ContenderPlacementDto, ProtocolError> {
    let barrier = barrier_for_survival(
        battle_spot,
        (deck.min_initial_survival + deck.max_initial_survival) / 2,
        deck.total_integrated_variance,
        deck.drift_per_variance,
        BarrierSide::Upper,
    )?;
    Ok(ContenderPlacementDto {
        contender_id: PLAYER_CONTENDER_ID,
        name: PLAYER_NAME.to_owned(),
        is_bot: false,
        persona: None,
        side: BarrierSide::Upper.into(),
        barrier: barrier.to_string(),
    })
}

/// Stable initial disclosed field. These are lobby positions, not audit
/// decisions; every later move is emitted at its scheduled public time.
pub fn generate_bot_initial_roster(
    deck: &DeckVersion,
    bot_seed_root: &[u8; 32],
    battle_spot: u128,
) -> Result<Vec<ContenderPlacementDto>, ProtocolError> {
    let mut seed = [0_u8; 8];
    seed.copy_from_slice(&bot_seed_root[..8]);
    let root_seed = u64::from_be_bytes(seed);
    let survival_span = deck
        .max_initial_survival
        .checked_sub(deck.min_initial_survival)
        .ok_or(ProtocolError::Mismatch("deck probability range"))?;
    let mut bots = Vec::with_capacity(BOT_NAMES.len());
    for (index, name) in BOT_NAMES.iter().enumerate() {
        let contender_id = u16::try_from(index + 1)
            .map_err(|_| ProtocolError::Mismatch("bot identifier overflow"))?;
        let persona = BOT_PERSONAS[index % BOT_PERSONAS.len()];
        let mut rng = DeterministicRng::domain(
            root_seed ^ u64::from(contender_id).rotate_left(17),
            BOT_DOMAIN,
        );
        let side = if index % 2 == 0 {
            BarrierSide::Upper
        } else {
            BarrierSide::Lower
        };
        let random_offset = u128::from(rng.next_u64()) % survival_span;
        let target = deck.min_initial_survival + random_offset;
        let barrier = barrier_for_survival(
            battle_spot,
            target,
            deck.total_integrated_variance,
            deck.drift_per_variance,
            side,
        )?;
        let placement = ContenderPlacementDto {
            contender_id,
            name: (*name).to_owned(),
            is_bot: true,
            persona: Some(persona.to_owned()),
            side: side.into(),
            barrier: barrier.to_string(),
        };
        bots.push(placement);
    }
    Ok(bots)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BotPlacementSchedule {
    pub contender_id: u16,
    pub decision_number: u16,
    pub decision_time_ms: u64,
    pub observation_time_ms: u64,
    pub reaction_latency_ms: u16,
}

fn persona_move_range(persona: &str) -> (u16, u16) {
    match persona {
        "late_bidder" | "mimic" | "wick_watcher" | "score_hunter" => (2, 3),
        "chaos" => (1, 3),
        _ => (1, 2),
    }
}

fn persona_latency_range(persona: &str) -> (u16, u16) {
    match persona {
        "wick_watcher" => (250, 650),
        "late_bidder" => (650, 1_250),
        "turtle" => (850, 1_500),
        "mimic" => (500, 1_100),
        "chaos" => (300, 900),
        _ => (400, 1_050),
    }
}

/// Produces only public relative timing metadata. The decision itself is
/// evaluated later against the placements visible at that event boundary.
pub fn generate_bot_placement_schedule(
    bot_seed_root: &[u8; 32],
    placement_duration_ms: u64,
    input_freeze_ms: u64,
) -> Result<Vec<BotPlacementSchedule>, ProtocolError> {
    let interactive_duration_ms = placement_duration_ms.min(BOT_PLACEMENT_WINDOW_MS);
    let available = interactive_duration_ms
        .checked_sub(input_freeze_ms)
        .ok_or(ProtocolError::Mismatch("bot placement timing"))?;
    if available < 2_000 {
        return Err(ProtocolError::Mismatch("bot placement timing"));
    }
    let mut root = [0_u8; 8];
    root.copy_from_slice(&bot_seed_root[..8]);
    let root_seed = u64::from_be_bytes(root);
    let mut schedule = Vec::with_capacity(BOT_NAMES.len() * 2);

    for (index, persona) in (0_u16..)
        .zip(BOT_PERSONAS.iter().cycle())
        .take(BOT_NAMES.len())
    {
        let contender_id = index + 1;
        let mut rng = DeterministicRng::domain(
            root_seed ^ u64::from(contender_id).rotate_left(29),
            BOT_SCHEDULE_DOMAIN,
        );
        let (minimum, maximum) = persona_move_range(persona);
        let count = minimum
            + u16::try_from(rng.next_u64() % u64::from(maximum - minimum + 1))
                .map_err(|_| ProtocolError::Mismatch("bot move count"))?;
        let (latency_min, latency_max) = persona_latency_range(persona);
        let mut previous = 0_u64;

        for decision_index in 0..count {
            let latency_span = u64::from(latency_max - latency_min + 1);
            let latency = latency_min
                + u16::try_from(rng.next_u64() % latency_span)
                    .map_err(|_| ProtocolError::Mismatch("bot reaction latency"))?;
            let base = if *persona == "late_bidder" {
                // Late bidders visibly wait for the room, while still respecting
                // the same final-input freeze as the player.
                let start = available * 58 / 100;
                start + (available - start) * u64::from(decision_index + 1) / u64::from(count + 1)
            } else {
                available * u64::from(decision_index + 1) / u64::from(count + 1)
            };
            let jitter_span = (available / u64::from(count + 1) / 5).max(1);
            let jitter = i64::try_from(rng.next_u64() % (jitter_span * 2 + 1))
                .map_err(|_| ProtocolError::Mismatch("bot schedule jitter"))?
                - i64::try_from(jitter_span)
                    .map_err(|_| ProtocolError::Mismatch("bot schedule jitter"))?;
            let jittered = if jitter.is_negative() {
                base.saturating_sub(jitter.unsigned_abs())
            } else {
                base.saturating_add(jitter.unsigned_abs())
            };
            // A bot cannot start observing for its next move until its prior
            // move has landed. This keeps every declared reaction interval
            // serial and makes the observation cutoff meaningful.
            let earliest = if decision_index == 0 {
                u64::from(latency)
            } else {
                previous
                    .saturating_add(u64::from(latency))
                    .saturating_add(100)
            };
            let decision_time_ms = jittered.clamp(earliest, available);
            let observation_time_ms = decision_time_ms
                .checked_sub(u64::from(latency))
                .ok_or(ProtocolError::Mismatch("bot reaction latency"))?;
            previous = decision_time_ms;
            schedule.push(BotPlacementSchedule {
                contender_id,
                decision_number: decision_index + 1,
                decision_time_ms,
                observation_time_ms,
                reaction_latency_ms: latency,
            });
        }
    }
    schedule.sort_unstable_by_key(|entry| {
        (
            entry.decision_time_ms,
            entry.contender_id,
            entry.decision_number,
        )
    });
    Ok(schedule)
}

fn fixed_mul(left: u128, right: u128) -> Result<u128, ProtocolError> {
    left.checked_mul(right)
        .map(|product| product / SCALE)
        .ok_or(ProtocolError::Mismatch("bot utility overflow"))
}

fn persona_risk_aversion(persona: &str) -> u128 {
    match persona {
        "turtle" => 900_000_000_000,
        "wick_watcher" => 260_000_000_000,
        "late_bidder" => 180_000_000_000,
        "mimic" => 420_000_000_000,
        "chaos" => 120_000_000_000,
        "range_reader" => 480_000_000_000,
        "crowd_avoider" => 520_000_000_000,
        _ => 220_000_000_000,
    }
}

fn signed_points(points: u128) -> Result<i128, ProtocolError> {
    i128::try_from(points).map_err(|_| ProtocolError::Mismatch("bot utility overflow"))
}

fn persona_bias(
    persona: &str,
    probability: u128,
    crowd_factor: u128,
    terminal_score: u128,
    side: BarrierSide,
    player: Option<&ContenderPlacementDto>,
    decision_number: u16,
) -> Result<i128, ProtocolError> {
    let safety = fixed_mul(probability, 36 * SCALE)?;
    let danger = fixed_mul(SCALE.saturating_sub(probability), 34 * SCALE)?;
    let crowd_bonus = fixed_mul(crowd_factor, 18 * SCALE)?;
    let score_bonus = terminal_score / 18;
    let bias = match persona {
        "turtle" => safety,
        "wick_watcher" => danger,
        "late_bidder" => {
            danger
                .checked_mul(u128::from(decision_number).min(3))
                .ok_or(ProtocolError::Mismatch("bot utility overflow"))?
                / 2
        }
        "mimic" if player.is_some_and(|placement| placement.side.to_core() == side) => 30 * SCALE,
        "chaos" => 4 * SCALE,
        "range_reader" => {
            let midpoint = 500_000_000_000_u128;
            28 * SCALE - probability.abs_diff(midpoint).min(28 * SCALE)
        }
        "crowd_avoider" => crowd_bonus,
        "score_hunter" => score_bonus,
        _ => 0,
    };
    signed_points(bias)
}

fn persona_reason(persona: &str) -> String {
    match persona {
        "turtle" => "turtle_safety_band",
        "wick_watcher" => "wick_watcher_pressure",
        "late_bidder" => "late_bidder_room_read",
        "mimic" => "mimic_visible_player_side",
        "chaos" => "chaos_bounded_noise",
        "range_reader" => "range_reader_mid_band",
        "crowd_avoider" => "crowd_avoider_clean_air",
        "score_hunter" => "score_hunter_terminal_score",
        _ => "public_state_utility",
    }
    .to_owned()
}

/// Evaluates one due move from public state only. `visible_placements` must be
/// the state reconstructed at the committed observation timestamp, never the
/// later action snapshot.
#[allow(clippy::too_many_lines)]
pub fn evaluate_bot_placement_decision(
    deck: &DeckVersion,
    bot_seed_root: &[u8; 32],
    battle_spot: u128,
    scheduled: BotPlacementSchedule,
    visible_placements: &[ContenderPlacementDto],
) -> Result<BotPlacementDecisionDto, ProtocolError> {
    let current = visible_placements
        .iter()
        .find(|placement| placement.contender_id == scheduled.contender_id)
        .ok_or(ProtocolError::Mismatch("scheduled bot placement"))?;
    if !current.is_bot {
        return Err(ProtocolError::Mismatch("scheduled bot identity"));
    }
    let persona = current
        .persona
        .as_deref()
        .ok_or(ProtocolError::Mismatch("scheduled bot persona"))?;
    let player = visible_placements
        .iter()
        .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID);
    let mut public_placements = visible_placements.to_vec();
    public_placements.sort_unstable_by_key(|placement| placement.contender_id);
    let public_inputs = serde_json::to_vec(&serde_json::json!({
        "battleSpot": battle_spot.to_string(),
        "contenderId": scheduled.contender_id,
        "decisionNumber": scheduled.decision_number,
        "decisionTimeMs": scheduled.decision_time_ms,
        "deckId": deck.id.as_str(),
        "deckVersion": deck.version,
        "persona": persona,
        "placements": public_placements,
        "policyVersion": BOT_PLACEMENT_POLICY_VERSION,
        "observationTimeMs": scheduled.observation_time_ms,
        "reactionLatencyMs": scheduled.reaction_latency_ms,
    }))?;
    let contender_bytes = scheduled.contender_id.to_be_bytes();
    let decision_bytes = scheduled.decision_number.to_be_bytes();
    let entropy = hash_framed(
        b"strikefall/ranked-bot-placement-entropy/v3",
        [
            bot_seed_root.as_slice(),
            contender_bytes.as_slice(),
            decision_bytes.as_slice(),
        ],
    );
    let mut entropy_seed = [0_u8; 8];
    entropy_seed.copy_from_slice(&entropy[..8]);
    let mut rng = DeterministicRng::domain(u64::from_be_bytes(entropy_seed), BOT_CANDIDATE_DOMAIN);
    let span = deck
        .max_initial_survival
        .checked_sub(deck.min_initial_survival)
        .ok_or(ProtocolError::Mismatch("deck probability range"))?;
    let mut candidates = Vec::with_capacity(usize::from(CANDIDATE_BANDS * 2));

    for side in [BarrierSide::Upper, BarrierSide::Lower] {
        for band in 0..CANDIDATE_BANDS {
            // Keep canonical candidates one band-width inside the legal edge;
            // the fixed bisection intentionally rounds outward by a few units.
            let target = deck.min_initial_survival
                + span * u128::from(band + 1) / u128::from(CANDIDATE_BANDS + 1);
            let barrier = barrier_for_survival(
                battle_spot,
                target,
                deck.total_integrated_variance,
                deck.drift_per_variance,
                side,
            )?;
            let mut proposed = visible_placements.to_vec();
            let placement = proposed
                .iter_mut()
                .find(|placement| placement.contender_id == scheduled.contender_id)
                .ok_or(ProtocolError::Mismatch("scheduled bot placement"))?;
            placement.side = side.into();
            placement.barrier = barrier.to_string();
            let scores = core_lock_scores(
                battle_spot,
                deck.total_integrated_variance,
                deck.drift_per_variance,
                &placements_to_core(&proposed)?,
                ScoringRules::default(),
            )?;
            let selected = scores
                .iter()
                .find(|score| score.contender_id == scheduled.contender_id)
                .ok_or(ProtocolError::Mismatch("bot candidate score"))?;
            let expected = fixed_mul(selected.initial_survival, selected.terminal_score)?;
            let variance = fixed_mul(
                selected.initial_survival,
                SCALE.saturating_sub(selected.initial_survival),
            )?;
            let variance_points = fixed_mul(variance, selected.terminal_score)?;
            let penalty = fixed_mul(variance_points, persona_risk_aversion(persona))?;
            let noise_limit = if persona == "chaos" { 24 } else { 7 };
            let noise_span = u64::try_from(noise_limit * 2 + 1)
                .map_err(|_| ProtocolError::Mismatch("bot candidate noise"))?;
            let noise_points = i128::from(
                i16::try_from(rng.next_u64() % noise_span)
                    .map_err(|_| ProtocolError::Mismatch("bot candidate noise"))?
                    - noise_limit,
            ) * i128::try_from(SCALE)
                .map_err(|_| ProtocolError::Mismatch("bot utility overflow"))?;
            let utility = signed_points(expected)?
                .checked_sub(signed_points(penalty)?)
                .and_then(|value| {
                    persona_bias(
                        persona,
                        selected.initial_survival,
                        selected.crowd_factor,
                        selected.terminal_score,
                        side,
                        player,
                        scheduled.decision_number,
                    )
                    .ok()
                    .and_then(|bias| value.checked_add(bias))
                })
                .and_then(|value| value.checked_add(noise_points))
                .ok_or(ProtocolError::Mismatch("bot utility overflow"))?;
            let candidate_number = u16::try_from(candidates.len())
                .map_err(|_| ProtocolError::Mismatch("bot candidate count"))?;
            candidates.push(BotPlacementCandidateDto {
                candidate_number,
                side: side.into(),
                target_survival: target.to_string(),
                barrier: barrier.to_string(),
                quoted_survival: selected.initial_survival.to_string(),
                projected_crowd_factor: selected.crowd_factor.to_string(),
                terminal_score: selected.terminal_score.to_string(),
                utility: utility.to_string(),
            });
        }
    }
    let selected = candidates
        .iter()
        .max_by(|left, right| {
            let left_utility = left.utility.parse::<i128>().unwrap_or(i128::MIN);
            let right_utility = right.utility.parse::<i128>().unwrap_or(i128::MIN);
            left_utility
                .cmp(&right_utility)
                .then_with(|| right.candidate_number.cmp(&left.candidate_number))
        })
        .ok_or(ProtocolError::Mismatch("bot candidate count"))?;
    let placement = ContenderPlacementDto {
        side: selected.side,
        barrier: selected.barrier.clone(),
        ..current.clone()
    };
    let candidates_json = serde_json::to_vec(&candidates)?;
    Ok(BotPlacementDecisionDto {
        contender_id: scheduled.contender_id,
        persona: persona.to_owned(),
        policy_version: BOT_PLACEMENT_POLICY_VERSION.to_owned(),
        decision_number: scheduled.decision_number,
        decision_time_ms: scheduled.decision_time_ms,
        observation_time_ms: scheduled.observation_time_ms,
        reaction_latency_ms: scheduled.reaction_latency_ms,
        public_inputs_digest: hex::encode(hash_framed(
            b"strikefall/ranked-bot-placement-public/v3",
            [public_inputs.as_slice()],
        )),
        entropy_digest: hex::encode(entropy),
        candidates_digest: hex::encode(hash_framed(
            b"strikefall/ranked-bot-placement-candidates/v3",
            [candidates_json.as_slice()],
        )),
        candidate_count: u16::try_from(candidates.len())
            .map_err(|_| ProtocolError::Mismatch("bot candidate count"))?,
        selected_candidate: selected.candidate_number,
        selected_utility: selected.utility.clone(),
        reason_code: persona_reason(persona),
        candidates,
        placement,
    })
}

/// Convenience regeneration for callers without interleaved player input.
/// Replay verification uses the event-aware evaluator instead.
pub fn generate_bot_roster_with_decisions(
    deck: &DeckVersion,
    bot_seed_root: &[u8; 32],
    battle_spot: u128,
) -> Result<(Vec<ContenderPlacementDto>, Vec<BotPlacementDecisionDto>), ProtocolError> {
    let bots = generate_bot_initial_roster(deck, bot_seed_root, battle_spot)?;
    let mut placements = Vec::with_capacity(bots.len() + 1);
    placements.push(generate_player_placement(deck, battle_spot)?);
    placements.extend(bots);
    let schedule = generate_bot_placement_schedule(
        bot_seed_root,
        CANONICAL_PLACEMENT_DURATION_MS,
        CANONICAL_INPUT_FREEZE_MS,
    )?;
    let initial_placements = placements.clone();
    let mut placement_history: Vec<(u64, ContenderPlacementDto)> =
        Vec::with_capacity(schedule.len());
    let mut decisions = Vec::with_capacity(schedule.len());
    for scheduled in schedule {
        let mut visible = initial_placements.clone();
        for (action_time_ms, prior) in &placement_history {
            if *action_time_ms > scheduled.observation_time_ms {
                continue;
            }
            let placement = visible
                .iter_mut()
                .find(|placement| placement.contender_id == prior.contender_id)
                .ok_or(ProtocolError::Mismatch("scheduled bot placement"))?;
            placement.clone_from(prior);
        }
        let decision =
            evaluate_bot_placement_decision(deck, bot_seed_root, battle_spot, scheduled, &visible)?;
        let placement = placements
            .iter_mut()
            .find(|placement| placement.contender_id == scheduled.contender_id)
            .ok_or(ProtocolError::Mismatch("scheduled bot placement"))?;
        placement.clone_from(&decision.placement);
        placement_history.push((scheduled.decision_time_ms, decision.placement.clone()));
        decisions.push(decision);
    }
    Ok((placements.into_iter().skip(1).collect(), decisions))
}

fn parse_u128(value: &str, field: &'static str) -> Result<u128, ProtocolError> {
    value
        .parse::<u128>()
        .map_err(|_| ProtocolError::InvalidFixed(field))
}

fn parse_i128(value: &str, field: &'static str) -> Result<i128, ProtocolError> {
    value
        .parse::<i128>()
        .map_err(|_| ProtocolError::InvalidFixed(field))
}

fn placements_to_core(
    placements: &[ContenderPlacementDto],
) -> Result<Vec<FlagPlacement>, ProtocolError> {
    placements
        .iter()
        .map(|placement| {
            Ok(FlagPlacement {
                contender_id: placement.contender_id,
                side: placement.side.to_core(),
                barrier: parse_u128(&placement.barrier, "placement.barrier")?,
            })
        })
        .collect()
}

fn points_to_core(points: &[PathPointDto]) -> Result<Vec<PathPoint>, ProtocolError> {
    let decoded: Vec<PathPoint> = points
        .iter()
        .map(|point| {
            Ok::<PathPoint, ProtocolError>(PathPoint {
                step: point.step,
                variance_elapsed: parse_u128(&point.variance_elapsed, "varianceElapsed")?,
                log_return: parse_i128(&point.log_return, "logReturn")?,
                price: parse_u128(&point.price, "price")?,
                interval_high: parse_u128(&point.interval_high, "intervalHigh")?,
                interval_low: parse_u128(&point.interval_low, "intervalLow")?,
            })
        })
        .collect::<Result<_, _>>()?;
    for (index, point) in decoded.iter().enumerate() {
        let previous = decoded.get(index.saturating_sub(1)).unwrap_or(point);
        if point.interval_high < point.price.max(previous.price)
            || point.interval_low > point.price.min(previous.price)
        {
            return Err(ProtocolError::Mismatch("path interval extrema"));
        }
    }
    Ok(decoded)
}

fn locked_to_dto(score: &LockedScore) -> LockedScoreDto {
    LockedScoreDto {
        contender_id: score.contender_id,
        side: score.side.into(),
        barrier: score.barrier.to_string(),
        normalized_distance: score.normalized_distance.to_string(),
        initial_survival: score.initial_survival.to_string(),
        risk_multiplier: score.risk_multiplier.to_string(),
        crowd_factor: score.crowd_factor.to_string(),
        terminal_score: score.terminal_score.to_string(),
    }
}

pub fn lock_placements(
    deck: &DeckVersion,
    battle_spot: u128,
    placements: &[ContenderPlacementDto],
) -> Result<Vec<LockedScoreDto>, ProtocolError> {
    let core_placements = placements_to_core(placements)?;
    core_lock_scores(
        battle_spot,
        deck.total_integrated_variance,
        deck.drift_per_variance,
        &core_placements,
        ScoringRules::default(),
    )
    .map(|scores| scores.iter().map(locked_to_dto).collect())
    .map_err(Into::into)
}

pub fn quote_escape(
    deck: &DeckVersion,
    path: &RoundPathDto,
    player: &ContenderPlacementDto,
    player_locked: &LockedScoreDto,
    step: u16,
) -> Result<EscapeRecordDto, ProtocolError> {
    let battle = points_to_core(&path.battle)?;
    let player_core = placements_to_core(core::slice::from_ref(player))?
        .into_iter()
        .next()
        .ok_or(ProtocolError::Mismatch("missing player placement"))?;
    if step == 0 || step >= deck.battle_steps {
        return Err(ProtocolError::Mismatch("escape step outside battle"));
    }
    if first_touch(&battle[..=usize::from(step)], player_core).is_some() {
        return Err(ProtocolError::Mismatch("escape after player touch"));
    }
    let point = battle
        .get(usize::from(step))
        .ok_or(ProtocolError::Mismatch("escape path step"))?;
    quote_escape_public(deck, point.price, player, player_locked, step)
}

/// Quotes Escape using only the public line, public time/deck state, and a
/// contender's already-locked terms. This is the only quote available to bot
/// policy code; it deliberately accepts no path or path seed.
pub fn quote_escape_public(
    deck: &DeckVersion,
    line_value: u128,
    contender: &ContenderPlacementDto,
    locked: &LockedScoreDto,
    step: u16,
) -> Result<EscapeRecordDto, ProtocolError> {
    if step == 0 || step >= deck.battle_steps {
        return Err(ProtocolError::Mismatch("escape step outside battle"));
    }
    let contender_core = placements_to_core(core::slice::from_ref(contender))?
        .into_iter()
        .next()
        .ok_or(ProtocolError::Mismatch("missing escape contender"))?;
    let remaining_variance = deck.remaining_variance(step)?;
    let quote = one_sided_no_touch(NoTouchInputs {
        spot: line_value,
        barrier: contender_core.barrier,
        remaining_variance,
        drift_per_variance: deck.drift_per_variance,
        side: contender_core.side,
        already_breached: false,
    })?;
    let locked_terminal = parse_u128(&locked.terminal_score, "terminalScore")?;
    let banked_score = escape_value(locked_terminal, quote.survival_probability)?;
    Ok(EscapeRecordDto {
        step,
        banked_score: banked_score.to_string(),
        line_value: line_value.to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotEscapeEvaluation {
    pub decision: BotEscapeDecisionDto,
    pub escape: Option<BotEscapeRecordDto>,
}

#[derive(Clone, Copy)]
struct EscapePolicy {
    earliest_per_mille: u16,
    threshold: u128,
    interval_ms: u16,
    decision_chance: u128,
}

fn escape_policy(persona: &str) -> EscapePolicy {
    match persona {
        "turtle" => EscapePolicy {
            earliest_per_mille: 720,
            threshold: 260_000_000_000,
            interval_ms: 3_000,
            decision_chance: 750_000_000_000,
        },
        "wick_watcher" => EscapePolicy {
            earliest_per_mille: 500,
            threshold: 760_000_000_000,
            interval_ms: 2_500,
            decision_chance: SCALE,
        },
        "late_bidder" => EscapePolicy {
            earliest_per_mille: 820,
            threshold: 550_000_000_000,
            interval_ms: 2_250,
            decision_chance: SCALE,
        },
        "mimic" => EscapePolicy {
            earliest_per_mille: 550,
            threshold: 780_000_000_000,
            interval_ms: 2_500,
            decision_chance: 850_000_000_000,
        },
        "chaos" => EscapePolicy {
            earliest_per_mille: 550,
            threshold: 500_000_000_000,
            interval_ms: 3_500,
            decision_chance: 250_000_000_000,
        },
        "range_reader" => EscapePolicy {
            earliest_per_mille: 580,
            threshold: 760_000_000_000,
            interval_ms: 3_000,
            decision_chance: 850_000_000_000,
        },
        "crowd_avoider" => EscapePolicy {
            earliest_per_mille: 520,
            threshold: 820_000_000_000,
            interval_ms: 3_000,
            decision_chance: 900_000_000_000,
        },
        _ => EscapePolicy {
            earliest_per_mille: 760,
            threshold: 960_000_000_000,
            interval_ms: 4_000,
            decision_chance: 180_000_000_000,
        },
    }
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn evaluate_bot_escapes(
    deck: &DeckVersion,
    bot_seed_root: &[u8; 32],
    line_value: u128,
    step: u16,
    placements: &[ContenderPlacementDto],
    locked_scores: &[LockedScoreDto],
    touches: &[TouchDto],
    player_escape: &Option<EscapeRecordDto>,
    bot_escapes: &[BotEscapeRecordDto],
) -> Result<Vec<BotEscapeEvaluation>, ProtocolError> {
    if step == 0 || step >= deck.battle_steps {
        return Ok(Vec::new());
    }
    let close_steps = 3_000_u64.div_ceil(u64::from(deck.step_ms));
    let close_step = u64::from(deck.battle_steps).saturating_sub(close_steps);
    if u64::from(step) >= close_step {
        return Ok(Vec::new());
    }
    let player_escaped = player_escape.is_some();
    let mut evaluations = Vec::new();
    for placement in placements.iter().filter(|placement| placement.is_bot) {
        if touches
            .iter()
            .any(|touch| touch.contender_id == placement.contender_id)
            || bot_escapes
                .iter()
                .any(|escape| escape.contender_id == placement.contender_id)
        {
            continue;
        }
        let persona = placement.persona.as_deref().unwrap_or("score_hunter");
        let policy = escape_policy(persona);
        let earliest = u64::from(deck.battle_steps)
            .saturating_mul(u64::from(policy.earliest_per_mille))
            .div_ceil(1_000)
            .max(u64::from(deck.battle_steps / 2));
        let interval_steps = u64::from(policy.interval_ms)
            .div_ceil(u64::from(deck.step_ms))
            .max(1);
        let schedule_digest = hash_framed(
            b"strikefall/ranked-bot-escape-schedule/v2",
            [
                bot_seed_root.as_slice(),
                placement.contender_id.to_be_bytes().as_slice(),
            ],
        );
        let mut offset_bytes = [0_u8; 8];
        offset_bytes.copy_from_slice(&schedule_digest[..8]);
        let first = earliest + u64::from_be_bytes(offset_bytes) % interval_steps;
        let step_u64 = u64::from(step);
        if step_u64 < first || (step_u64 - first) % interval_steps != 0 {
            continue;
        }
        let bucket = u16::try_from((step_u64 - first) / interval_steps)
            .map_err(|_| ProtocolError::Mismatch("bot escape bucket overflow"))?;
        let locked = locked_scores
            .iter()
            .find(|score| score.contender_id == placement.contender_id)
            .ok_or(ProtocolError::Mismatch("bot locked score"))?;
        let quote = quote_escape_public(deck, line_value, placement, locked, step)?;
        let remaining_variance = deck.remaining_variance(step)?;
        let public_payload = serde_json::to_vec(&serde_json::json!({
            "contenderId": placement.contender_id,
            "deckId": deck.id.as_str(),
            "deckVersion": deck.version,
            "lineValue": line_value.to_string(),
            "lockedScore": locked.terminal_score,
            "persona": persona,
            "playerEscaped": player_escaped,
            "policyVersion": BOT_ESCAPE_POLICY_VERSION,
            "remainingVariance": remaining_variance.to_string(),
            "side": placement.side,
            "step": step,
        }))?;
        let public_inputs_digest = hex::encode(hash_framed(
            b"strikefall/ranked-bot-escape-public/v2",
            [public_payload.as_slice()],
        ));
        let chance_digest = hash_framed(
            b"strikefall/ranked-bot-escape-decision/v2",
            [
                bot_seed_root.as_slice(),
                placement.contender_id.to_be_bytes().as_slice(),
                bucket.to_be_bytes().as_slice(),
            ],
        );
        let mut roll_bytes = [0_u8; 8];
        roll_bytes.copy_from_slice(&chance_digest[..8]);
        let chance_roll = u128::from(u64::from_be_bytes(roll_bytes)) % SCALE;
        let survival = parse_u128(&quote.banked_score, "bankedScore")?
            .checked_mul(SCALE)
            .and_then(|value| {
                let terminal = parse_u128(&locked.terminal_score, "terminalScore").ok()?;
                (terminal > 0).then(|| value / terminal)
            })
            .unwrap_or(0)
            .min(SCALE);
        let threshold = if persona == "mimic" && player_escaped {
            policy.threshold.min(350_000_000_000)
        } else {
            policy.threshold
        };
        let chance_passed = chance_roll < policy.decision_chance;
        let accepted = chance_passed && survival >= threshold;
        let reason_code = if !chance_passed {
            "chance_skip"
        } else if survival < threshold {
            "below_threshold"
        } else {
            "accepted"
        };
        let decision = BotEscapeDecisionDto {
            contender_id: placement.contender_id,
            persona: persona.to_owned(),
            policy_version: BOT_ESCAPE_POLICY_VERSION.to_owned(),
            decision_bucket: bucket,
            step,
            public_inputs_digest,
            survival_probability: survival.to_string(),
            threshold: threshold.to_string(),
            chance_roll: chance_roll.to_string(),
            decision_chance: policy.decision_chance.to_string(),
            accepted,
            reason_code: reason_code.to_owned(),
        };
        let escape = accepted.then_some(BotEscapeRecordDto {
            contender_id: placement.contender_id,
            decision_bucket: bucket,
            escape: quote,
        });
        evaluations.push(BotEscapeEvaluation { decision, escape });
    }
    evaluations.sort_unstable_by_key(|value| value.decision.contender_id);
    Ok(evaluations)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolutionProof<'a> {
    escape: &'a Option<EscapeRecordDto>,
    bot_escapes: &'a [BotEscapeRecordDto],
    touches: &'a [TouchDto],
    contenders: &'a [ContenderResultDto],
}

#[allow(clippy::too_many_lines)]
pub fn resolve_round(
    deck: &DeckVersion,
    path: &RoundPathDto,
    placements: &[ContenderPlacementDto],
    escape: &Option<EscapeRecordDto>,
    bot_escapes: &[BotEscapeRecordDto],
) -> Result<(Vec<LockedScoreDto>, Vec<TouchDto>, RoundResultDto), ProtocolError> {
    let battle = points_to_core(&path.battle)?;
    let battle_spot = battle
        .first()
        .ok_or(ProtocolError::Mismatch("empty battle path"))?
        .price;
    let core_placements = placements_to_core(placements)?;
    let locked = lock_placements(deck, battle_spot, placements)?;
    if let Some(record) = escape {
        let player = placements
            .iter()
            .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
            .ok_or(ProtocolError::Mismatch("missing player placement"))?;
        let player_locked = locked
            .iter()
            .find(|score| score.contender_id == PLAYER_CONTENDER_ID)
            .ok_or(ProtocolError::Mismatch("missing player locked score"))?;
        if quote_escape(deck, path, player, player_locked, record.step)? != *record {
            return Err(ProtocolError::Mismatch("escape value"));
        }
    }
    for bot_escape in bot_escapes {
        let bot = placements
            .iter()
            .find(|placement| placement.contender_id == bot_escape.contender_id && placement.is_bot)
            .ok_or(ProtocolError::Mismatch("missing escaped bot placement"))?;
        let bot_locked = locked
            .iter()
            .find(|score| score.contender_id == bot_escape.contender_id)
            .ok_or(ProtocolError::Mismatch("missing escaped bot score"))?;
        if quote_escape(deck, path, bot, bot_locked, bot_escape.escape.step)? != bot_escape.escape {
            return Err(ProtocolError::Mismatch("bot escape value"));
        }
    }

    let mut touches: Vec<_> = resolve_touches(&battle, &core_placements)
        .into_iter()
        .filter(|touch| {
            let player_active = escape.as_ref().is_none_or(|record| {
                touch.contender_id != PLAYER_CONTENDER_ID || touch.step <= record.step
            });
            let bot_active = bot_escapes.iter().all(|record| {
                touch.contender_id != record.contender_id || touch.step <= record.escape.step
            });
            player_active && bot_active
        })
        .map(|touch| TouchDto {
            contender_id: touch.contender_id,
            step: touch.step,
            side: touch.side.into(),
            barrier: touch.barrier.to_string(),
            line_value: touch.line_value.to_string(),
        })
        .collect();
    touches.sort_unstable_by_key(|touch| (touch.step, touch.contender_id));

    let mut contenders = Vec::with_capacity(placements.len());
    for (placement, core_placement) in placements.iter().zip(core_placements.iter()) {
        let score = locked
            .iter()
            .find(|score| score.contender_id == placement.contender_id)
            .ok_or(ProtocolError::Mismatch("locked contender"))?;
        let touch = touches
            .iter()
            .find(|touch| touch.contender_id == placement.contender_id);
        let escape_score = if placement.contender_id == PLAYER_CONTENDER_ID {
            escape.as_ref().map(|record| record.banked_score.clone())
        } else {
            bot_escapes
                .iter()
                .find(|record| record.contender_id == placement.contender_id)
                .map(|record| record.escape.banked_score.clone())
        };
        let escaped = escape_score.is_some();
        let (outcome, final_score) = if escaped {
            (
                ContenderOutcomeDto::Escaped,
                escape_score.ok_or(ProtocolError::Mismatch("missing escape"))?,
            )
        } else if touch.is_some() {
            (ContenderOutcomeDto::Eliminated, "0".to_owned())
        } else {
            (ContenderOutcomeDto::Survived, score.terminal_score.clone())
        };
        contenders.push(ContenderResultDto {
            contender_id: placement.contender_id,
            name: placement.name.clone(),
            outcome,
            score: final_score,
            rank: 0,
            touch_step: touch.map(|value| value.step),
            closest_approach: closest_approach(&battle, *core_placement)
                .ok_or(ProtocolError::Mismatch("closest approach"))?
                .to_string(),
        });
    }
    contenders.sort_by(|left, right| {
        let left_score = parse_u128(&left.score, "result.score").unwrap_or(0);
        let right_score = parse_u128(&right.score, "result.score").unwrap_or(0);
        right_score
            .cmp(&left_score)
            .then_with(|| left.contender_id.cmp(&right.contender_id))
    });
    for (index, contender) in contenders.iter_mut().enumerate() {
        contender.rank =
            u16::try_from(index + 1).map_err(|_| ProtocolError::Mismatch("rank overflow"))?;
    }
    let survivors = u16::try_from(
        contenders
            .iter()
            .filter(|contender| contender.outcome == ContenderOutcomeDto::Survived)
            .count(),
    )
    .map_err(|_| ProtocolError::Mismatch("survivor count overflow"))?;
    let player = contenders
        .iter()
        .find(|contender| contender.contender_id == PLAYER_CONTENDER_ID)
        .ok_or(ProtocolError::Mismatch("player result"))?;
    let mut result = RoundResultDto {
        outcome: player.outcome,
        score: player.score.clone(),
        rank: player.rank,
        survivors,
        closest_approach: player.closest_approach.clone(),
        contenders,
        proof_digest: String::new(),
    };
    let deck_hash = deck_digest(&deck_to_dto(deck))?;
    let path_hash = path_digest(path)?;
    let proof = result_proof_digest(
        &deck_hash,
        &path_hash,
        &placements,
        &locked,
        &ResolutionProof {
            escape,
            bot_escapes,
            touches: &touches,
            contenders: &result.contenders,
        },
    )?;
    result.proof_digest = hex::encode(proof);
    Ok((locked, touches, result))
}

pub(crate) fn regenerate_path(
    deck: &DeckVersion,
    seed: u64,
    initial_spot: u128,
) -> Result<RoundPathDto, ProtocolError> {
    generate_round_path(deck, seed, initial_spot)
        .map(|path| path_to_dto(&path))
        .map_err(Into::into)
}
