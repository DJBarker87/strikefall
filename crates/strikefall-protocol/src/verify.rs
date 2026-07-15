use strikefall_core::{deck_by_ref, one_sided_no_touch, DeckVersion, NoTouchInputs};

use crate::crypto::decode_array;
use crate::engine::regenerate_path;
use crate::{
    commitment_digest, deck_digest, deck_to_dto, escape_enabled, evaluate_bot_escapes,
    evaluate_bot_placement_decision, generate_bot_initial_roster, generate_bot_placement_schedule,
    generate_player_placement, locked_scores_digest, path_digest, resolve_round,
    validate_experiment_assignments, verify_event_log, BotEscapeDecisionDto, BotEscapeRecordDto,
    ContenderPlacementDto, EventActorDto, FlagClusterDto, ProtocolError, ReplayBundleDto,
    ReplayVerificationAckDto, RoundEventKindDto, SignedRoundEventDto, TouchDto,
    VerificationReportDto, BOT_PLACEMENT_POLICY_VERSION, BOT_PLACEMENT_WINDOW_MS,
    DECK_STRUCTURE_EXPERIMENT, PLAYER_CONTENDER_ID, PROTOCOL_VERSION, RANKED_LOCK_PHASE_MS,
};

pub fn verify_replay_bundle(
    bundle: &ReplayBundleDto,
) -> Result<VerificationReportDto, ProtocolError> {
    verify_replay_bundle_against(bundle, None, None)
}

#[allow(clippy::too_many_lines)]
pub fn verify_replay_bundle_against(
    bundle: &ReplayBundleDto,
    expected_commitment: Option<&str>,
    expected_server_key: Option<&str>,
) -> Result<VerificationReportDto, ProtocolError> {
    if bundle.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::Mismatch("protocol version"));
    }
    validate_experiment_assignments(&bundle.experiment_assignments)?;
    let escape_is_enabled = escape_enabled(&bundle.experiment_assignments)?;
    if !escape_is_enabled
        && (bundle.escape.is_some()
            || !bundle.bot_escape_decisions.is_empty()
            || !bundle.bot_escapes.is_empty())
    {
        return Err(ProtocolError::Mismatch("disabled Escape treatment"));
    }
    if expected_commitment.is_some_and(|expected| expected != bundle.commitment) {
        return Err(ProtocolError::Mismatch("external commitment anchor"));
    }
    if expected_server_key.is_some_and(|expected| expected != bundle.server_verifying_key) {
        return Err(ProtocolError::Mismatch("external server key anchor"));
    }
    let deck =
        deck_by_ref(&bundle.deck.id, bundle.deck.version).ok_or(ProtocolError::UnknownDeck)?;
    if deck_to_dto(deck) != bundle.deck {
        return Err(ProtocolError::Mismatch("deck catalog entry"));
    }
    if let Some(variant) = bundle.experiment_assignments.get(DECK_STRUCTURE_EXPERIMENT) {
        let expected_deck = match variant.as_str() {
            "flat" => "balanced_tape",
            "compression-break" => "compression_break",
            _ => return Err(ProtocolError::Mismatch("deck treatment variant")),
        };
        if bundle.deck.id != expected_deck {
            return Err(ProtocolError::Mismatch("deck treatment behavior"));
        }
    }
    let deck_hash = deck_digest(&bundle.deck)?;
    if hex::encode(deck_hash) != bundle.reveal.deck_digest {
        return Err(ProtocolError::Mismatch("deck digest"));
    }
    let seed = bundle
        .reveal
        .path_seed
        .parse::<u64>()
        .map_err(|_| ProtocolError::InvalidFixed("pathSeed"))?;
    let initial_spot = bundle
        .initial_spot
        .parse::<u128>()
        .map_err(|_| ProtocolError::InvalidFixed("initialSpot"))?;
    let regenerated = regenerate_path(deck, seed, initial_spot)?;
    if regenerated != bundle.path {
        return Err(ProtocolError::Mismatch("generated path"));
    }
    let path_hash = path_digest(&bundle.path)?;
    if hex::encode(path_hash) != bundle.reveal.path_digest {
        return Err(ProtocolError::Mismatch("path digest"));
    }
    let bot_root = decode_array::<32>(&bundle.reveal.bot_seed_root, "botSeedRoot")?;
    let salt = decode_array::<32>(&bundle.reveal.salt, "salt")?;
    let commitment = commitment_digest(
        PROTOCOL_VERSION,
        &bundle.round_id,
        &deck_hash,
        &path_hash,
        &bot_root,
        &salt,
    )?;
    if hex::encode(commitment) != bundle.commitment {
        return Err(ProtocolError::Mismatch("round commitment"));
    }
    let battle_spot = bundle
        .path
        .battle
        .first()
        .ok_or(ProtocolError::Mismatch("empty battle path"))?
        .price
        .parse::<u128>()
        .map_err(|_| ProtocolError::InvalidFixed("battleSpot"))?;
    let initial_bots = generate_bot_initial_roster(deck, &bot_root, battle_spot)?;
    let initial_player = generate_player_placement(deck, battle_spot)?;
    validate_final_placements(bundle, deck, battle_spot, &initial_player, &initial_bots)?;

    let (locked, touches, result) = resolve_round(
        deck,
        &bundle.path,
        &bundle.placements,
        &bundle.escape,
        &bundle.bot_escapes,
    )?;
    if locked != bundle.locked_scores {
        return Err(ProtocolError::Mismatch("locked scores"));
    }
    if touches != bundle.touches {
        return Err(ProtocolError::Mismatch("touch events"));
    }
    if result != bundle.result {
        return Err(ProtocolError::Mismatch("round result"));
    }
    verify_event_log(&bundle.events, &bundle.server_verifying_key)?;
    verify_event_semantics(
        bundle,
        deck,
        &bot_root,
        battle_spot,
        &initial_player,
        &initial_bots,
    )?;

    Ok(VerificationReportDto {
        valid: true,
        round_id: bundle.round_id.clone(),
        verified_checks: vec![
            "explicit ranked protocol schema".to_owned(),
            "versioned deck digest".to_owned(),
            "hidden path regeneration".to_owned(),
            "pre-round commitment".to_owned(),
            "signed versioned experiment treatments".to_owned(),
            "timed public-state bot candidate audit".to_owned(),
            "public-input-only bot Escape audit".to_owned(),
            "locked scores, touches, and result proof".to_owned(),
            "paced ordered Ed25519 event lifecycle".to_owned(),
        ],
        path_points: bundle.path.approach.len() + bundle.path.battle.len(),
        signed_events: bundle.events.len(),
    })
}

fn validate_final_placements(
    bundle: &ReplayBundleDto,
    deck: &DeckVersion,
    battle_spot: u128,
    initial_player: &ContenderPlacementDto,
    initial_bots: &[ContenderPlacementDto],
) -> Result<(), ProtocolError> {
    if bundle.placements.len() != initial_bots.len() + 1 || bundle.bots.len() != initial_bots.len()
    {
        return Err(ProtocolError::Mismatch("contender count"));
    }
    let player = bundle
        .placements
        .iter()
        .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
        .ok_or(ProtocolError::Mismatch("player placement"))?;
    if player.is_bot || player.persona.is_some() || player.name != initial_player.name {
        return Err(ProtocolError::Mismatch("player identity"));
    }
    if bundle.placements.first() != Some(player)
        || bundle.placements.get(1..) != Some(bundle.bots.as_slice())
    {
        return Err(ProtocolError::Mismatch("locked bot placements"));
    }
    for (initial, final_placement) in initial_bots.iter().zip(&bundle.bots) {
        if initial.contender_id != final_placement.contender_id
            || initial.name != final_placement.name
            || initial.is_bot != final_placement.is_bot
            || initial.persona != final_placement.persona
        {
            return Err(ProtocolError::Mismatch("bot roster identity"));
        }
        validate_ranked_placement(deck, battle_spot, final_placement)?;
    }
    let mut ids: Vec<_> = bundle
        .placements
        .iter()
        .map(|placement| placement.contender_id)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != bundle.placements.len() {
        return Err(ProtocolError::Mismatch("duplicate contender id"));
    }
    Ok(())
}

fn take_event<'a>(
    events: &'a [SignedRoundEventDto],
    index: &mut usize,
    mismatch: &'static str,
) -> Result<&'a SignedRoundEventDto, ProtocolError> {
    let event = events
        .get(*index)
        .ok_or(ProtocolError::Mismatch(mismatch))?;
    *index += 1;
    Ok(event)
}

#[allow(clippy::too_many_lines)]
fn verify_event_semantics(
    bundle: &ReplayBundleDto,
    deck: &DeckVersion,
    bot_root: &[u8; 32],
    battle_spot: u128,
    initial_player: &ContenderPlacementDto,
    initial_bots: &[ContenderPlacementDto],
) -> Result<(), ProtocolError> {
    if bundle
        .events
        .windows(2)
        .any(|pair| pair[0].server_time_ms > pair[1].server_time_ms)
    {
        return Err(ProtocolError::Mismatch("event time ordering"));
    }

    let mut index = 0;
    let created = take_event(&bundle.events, &mut index, "round-created event")?;
    let creation_time = created.server_time_ms;
    let mut current_player = match &created.kind {
        RoundEventKindDto::RoundCreated {
            protocol_version,
            commitment,
            experiment_assignments,
            player_placement,
        } if protocol_version == PROTOCOL_VERSION
            && commitment == &bundle.commitment
            && experiment_assignments == &bundle.experiment_assignments
            && player_placement == initial_player =>
        {
            player_placement.clone()
        }
        _ => return Err(ProtocolError::Mismatch("round-created event")),
    };

    for expected in &bundle.path.approach {
        let event = take_event(&bundle.events, &mut index, "approach frame lifecycle")?;
        match &event.kind {
            RoundEventKindDto::ApproachFrame { point }
                if point == expected && event.server_time_ms == creation_time => {}
            _ => return Err(ProtocolError::Mismatch("approach frame lifecycle")),
        }
    }

    let opened = take_event(&bundle.events, &mut index, "placement-opened event")?;
    let (placement_deadline_ms, input_freeze_at_ms) = match &opened.kind {
        RoundEventKindDto::PlacementOpened {
            placement_deadline_ms,
            input_freeze_at_ms,
            bot_policy_version,
        } if bot_policy_version == BOT_PLACEMENT_POLICY_VERSION
            && opened.server_time_ms == creation_time
            && creation_time < *input_freeze_at_ms
            && input_freeze_at_ms < placement_deadline_ms =>
        {
            (*placement_deadline_ms, *input_freeze_at_ms)
        }
        _ => return Err(ProtocolError::Mismatch("placement-opened event")),
    };

    let placement_duration_ms = placement_deadline_ms
        .checked_sub(creation_time)
        .ok_or(ProtocolError::Mismatch("placement timing"))?;
    let input_freeze_ms = placement_deadline_ms
        .checked_sub(input_freeze_at_ms)
        .ok_or(ProtocolError::Mismatch("placement timing"))?;
    let schedule =
        generate_bot_placement_schedule(bot_root, placement_duration_ms, input_freeze_ms)?;
    let mut current_placements = Vec::with_capacity(initial_bots.len() + 1);
    current_placements.push(current_player.clone());
    current_placements.extend(initial_bots.iter().cloned());
    let initial_placements = current_placements.clone();
    let mut placement_history: Vec<(u64, ContenderPlacementDto)> = Vec::new();
    let mut placement_cursor = 0_usize;
    let mut streamed_placement_decisions = Vec::with_capacity(schedule.len());
    let mut last_client_sequence = None;
    while let Some(event) = bundle.events.get(index) {
        match &event.kind {
            RoundEventKindDto::FlagMoved {
                actor: EventActorDto::Player,
                placement,
                client_sequence,
            } => {
                if placement.contender_id != PLAYER_CONTENDER_ID
                    || placement.is_bot
                    || placement.persona.is_some()
                    || placement.name != current_player.name
                    || event.server_time_ms >= input_freeze_at_ms
                {
                    return Err(ProtocolError::Mismatch("player flag-moved event"));
                }
                validate_ranked_placement(deck, battle_spot, placement)?;
                validate_client_sequence(&mut last_client_sequence, *client_sequence)?;
                current_player.clone_from(placement);
                current_placements[0].clone_from(placement);
                placement_history.push((event.server_time_ms, placement.clone()));
                index += 1;
            }
            RoundEventKindDto::BotPlacementDecision { decision } => {
                let scheduled = schedule
                    .get(placement_cursor)
                    .copied()
                    .ok_or(ProtocolError::Mismatch("bot placement decision count"))?;
                let decision_time = creation_time
                    .checked_add(
                        placement_duration_ms
                            .saturating_sub(BOT_PLACEMENT_WINDOW_MS)
                            .saturating_add(scheduled.decision_time_ms),
                    )
                    .ok_or(ProtocolError::Mismatch("bot placement timestamp"))?;
                if event.server_time_ms != decision_time {
                    return Err(ProtocolError::Mismatch("bot placement timestamp"));
                }
                let observation_time = creation_time
                    .checked_add(
                        placement_duration_ms
                            .saturating_sub(BOT_PLACEMENT_WINDOW_MS)
                            .saturating_add(scheduled.observation_time_ms),
                    )
                    .ok_or(ProtocolError::Mismatch("bot observation timestamp"))?;
                if decision_time.checked_sub(observation_time)
                    != Some(u64::from(scheduled.reaction_latency_ms))
                {
                    return Err(ProtocolError::Mismatch("bot reaction latency"));
                }
                let mut observed_placements = initial_placements.clone();
                for (moved_at, placement) in &placement_history {
                    if *moved_at > observation_time {
                        continue;
                    }
                    let observed = observed_placements
                        .iter_mut()
                        .find(|candidate| candidate.contender_id == placement.contender_id)
                        .ok_or(ProtocolError::Mismatch("bot observed placement contender"))?;
                    observed.clone_from(placement);
                }
                let expected = evaluate_bot_placement_decision(
                    deck,
                    bot_root,
                    battle_spot,
                    scheduled,
                    &observed_placements,
                )?;
                if decision != &expected {
                    return Err(ProtocolError::Mismatch("bot placement decision audit"));
                }
                index += 1;
                let move_event = take_event(&bundle.events, &mut index, "bot flag-moved event")?;
                match &move_event.kind {
                    RoundEventKindDto::FlagMoved {
                        actor: EventActorDto::Bot,
                        placement,
                        client_sequence: None,
                    } if placement == &expected.placement
                        && move_event.server_time_ms == decision_time => {}
                    _ => return Err(ProtocolError::Mismatch("bot flag-moved event")),
                }
                let placement = current_placements
                    .iter_mut()
                    .find(|placement| placement.contender_id == expected.contender_id)
                    .ok_or(ProtocolError::Mismatch("bot placement contender"))?;
                placement.clone_from(&expected.placement);
                placement_history.push((move_event.server_time_ms, expected.placement.clone()));
                streamed_placement_decisions.push(expected);
                placement_cursor += 1;
            }
            RoundEventKindDto::PlacementLocked { .. } => break,
            _ => return Err(ProtocolError::Mismatch("placement event lifecycle")),
        }
    }
    if placement_cursor != schedule.len()
        || streamed_placement_decisions != bundle.bot_placement_decisions
        || current_placements != bundle.placements
        || current_placements.get(1..) != Some(bundle.bots.as_slice())
    {
        return Err(ProtocolError::Mismatch("bot placement event history"));
    }

    let expected_locked_digest = hex::encode(locked_scores_digest(&bundle.locked_scores)?);
    let locked = take_event(&bundle.events, &mut index, "placement-lock event")?;
    let battle_started_at_ms = match &locked.kind {
        RoundEventKindDto::PlacementLocked {
            locked_scores_digest,
            locked_scores,
            battle_starts_at_ms,
        } if locked_scores_digest == &expected_locked_digest
            && locked_scores == &bundle.locked_scores
            && locked.server_time_ms == placement_deadline_ms
            && locked.server_time_ms.checked_add(RANKED_LOCK_PHASE_MS)
                == Some(*battle_starts_at_ms) =>
        {
            *battle_starts_at_ms
        }
        _ => return Err(ProtocolError::Mismatch("placement-lock event")),
    };

    let mut streamed_touches = Vec::new();
    let mut streamed_clusters = Vec::new();
    let mut streamed_bot_decisions = Vec::new();
    let mut streamed_bot_escapes = Vec::new();
    let mut streamed_player_escape = None;

    for expected_point in &bundle.path.battle {
        let frame = take_event(&bundle.events, &mut index, "battle frame lifecycle")?;
        let expected_time = battle_started_at_ms
            .checked_add(
                u64::from(expected_point.step)
                    .checked_mul(u64::from(deck.step_ms))
                    .ok_or(ProtocolError::Mismatch("battle frame timestamp"))?,
            )
            .ok_or(ProtocolError::Mismatch("battle frame timestamp"))?;
        match &frame.kind {
            RoundEventKindDto::BattleFrame { point }
                if point == expected_point && frame.server_time_ms == expected_time => {}
            _ => return Err(ProtocolError::Mismatch("battle frame lifecycle")),
        }

        if let Some(event) = bundle.events.get(index) {
            if let RoundEventKindDto::FlagCluster { cluster } = &event.kind {
                if cluster.step != expected_point.step || event.server_time_ms != expected_time {
                    return Err(ProtocolError::Mismatch("flag cluster event"));
                }
                streamed_clusters.push(cluster.clone());
                index += 1;
            }
        }
        while let Some(event) = bundle.events.get(index) {
            let RoundEventKindDto::FlagHit { touch } = &event.kind else {
                break;
            };
            if touch.step != expected_point.step || event.server_time_ms != expected_time {
                return Err(ProtocolError::Mismatch("flag-hit event"));
            }
            streamed_touches.push(touch.clone());
            index += 1;
        }
        while let Some(event) = bundle.events.get(index) {
            let RoundEventKindDto::BotEscapeEvaluated { decision } = &event.kind else {
                break;
            };
            if decision.step != expected_point.step || event.server_time_ms != expected_time {
                return Err(ProtocolError::Mismatch("bot Escape audit event"));
            }
            let decision = decision.clone();
            streamed_bot_decisions.push(decision.clone());
            index += 1;
            if decision.accepted {
                let accepted = take_event(&bundle.events, &mut index, "accepted bot Escape event")?;
                match &accepted.kind {
                    RoundEventKindDto::EscapeAccepted {
                        contender_id,
                        actor: EventActorDto::Bot,
                        escape,
                    } if *contender_id == decision.contender_id
                        && escape.step == expected_point.step
                        && accepted.server_time_ms == expected_time =>
                    {
                        streamed_bot_escapes.push(BotEscapeRecordDto {
                            contender_id: *contender_id,
                            decision_bucket: decision.decision_bucket,
                            escape: escape.clone(),
                        });
                    }
                    _ => return Err(ProtocolError::Mismatch("accepted bot Escape event")),
                }
            }
        }

        if let Some(event) = bundle.events.get(index) {
            if let RoundEventKindDto::EscapeAccepted {
                contender_id,
                actor: EventActorDto::Player,
                escape,
            } = &event.kind
            {
                if *contender_id != PLAYER_CONTENDER_ID
                    || streamed_player_escape.is_some()
                    || escape.step != expected_point.step
                    || event.server_time_ms < expected_time
                {
                    return Err(ProtocolError::Mismatch("accepted player Escape event"));
                }
                let next_frame_time = expected_time.saturating_add(u64::from(deck.step_ms));
                if expected_point.step < deck.battle_steps
                    && event.server_time_ms >= next_frame_time
                {
                    return Err(ProtocolError::Mismatch("player Escape timestamp"));
                }
                streamed_player_escape = Some(escape.clone());
                index += 1;
            }
        }
    }

    let ended = take_event(&bundle.events, &mut index, "round-ended event")?;
    match &ended.kind {
        RoundEventKindDto::RoundEnded { proof_digest }
            if proof_digest == &bundle.result.proof_digest => {}
        _ => return Err(ProtocolError::Mismatch("round-ended event")),
    }
    let expected_end_time = battle_started_at_ms
        .checked_add(u64::from(deck.battle_steps) * u64::from(deck.step_ms))
        .ok_or(ProtocolError::Mismatch("round end timestamp"))?;
    if ended.server_time_ms != expected_end_time {
        return Err(ProtocolError::Mismatch("round end timestamp"));
    }
    let revealed = take_event(&bundle.events, &mut index, "seed-revealed event")?;
    match &revealed.kind {
        RoundEventKindDto::SeedRevealed { reveal }
            if reveal == &bundle.reveal && revealed.server_time_ms == expected_end_time => {}
        _ => return Err(ProtocolError::Mismatch("seed-revealed event")),
    }

    if let Some(event) = bundle.events.get(index) {
        match &event.kind {
            RoundEventKindDto::ReplayVerified {
                proof_digest,
                verifier_version,
            } if proof_digest == &bundle.result.proof_digest
                && event.server_time_ms >= expected_end_time
                && valid_verifier_version(verifier_version) =>
            {
                let expected_ack = ReplayVerificationAckDto {
                    proof_digest: proof_digest.clone(),
                    verifier_version: verifier_version.clone(),
                    acknowledged_at_ms: event.server_time_ms,
                    event_sequence: event.sequence,
                };
                if bundle.replay_verification.as_ref() != Some(&expected_ack) {
                    return Err(ProtocolError::Mismatch("replay verification receipt"));
                }
                index += 1;
            }
            _ => return Err(ProtocolError::Mismatch("trailing lifecycle event")),
        }
    } else if bundle.replay_verification.is_some() {
        return Err(ProtocolError::Mismatch("missing replay verification event"));
    }
    if index != bundle.events.len() {
        return Err(ProtocolError::Mismatch("trailing lifecycle event"));
    }

    let final_player = bundle
        .placements
        .iter()
        .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
        .ok_or(ProtocolError::Mismatch("missing player placement"))?;
    if &current_player != final_player {
        return Err(ProtocolError::Mismatch("player placement event history"));
    }
    if streamed_player_escape != bundle.escape {
        return Err(ProtocolError::Mismatch("player Escape event history"));
    }
    if streamed_touches != bundle.touches {
        return Err(ProtocolError::Mismatch("touch event history"));
    }
    if streamed_clusters != expected_clusters(&bundle.touches) {
        return Err(ProtocolError::Mismatch("flag cluster history"));
    }

    let (expected_decisions, expected_escapes) = if escape_enabled(&bundle.experiment_assignments)?
    {
        regenerate_bot_escape_audit(bundle, deck, bot_root)?
    } else {
        (Vec::new(), Vec::new())
    };
    if expected_decisions != bundle.bot_escape_decisions
        || streamed_bot_decisions != bundle.bot_escape_decisions
    {
        return Err(ProtocolError::Mismatch("bot Escape decision audit"));
    }
    if expected_escapes != bundle.bot_escapes || streamed_bot_escapes != bundle.bot_escapes {
        return Err(ProtocolError::Mismatch("bot Escape event history"));
    }
    Ok(())
}

fn validate_ranked_placement(
    deck: &DeckVersion,
    battle_spot: u128,
    placement: &ContenderPlacementDto,
) -> Result<(), ProtocolError> {
    let barrier = placement
        .barrier
        .parse::<u128>()
        .map_err(|_| ProtocolError::InvalidFixed("placement.barrier"))?;
    let quote = one_sided_no_touch(NoTouchInputs {
        spot: battle_spot,
        barrier,
        remaining_variance: deck.total_integrated_variance,
        drift_per_variance: deck.drift_per_variance,
        side: placement.side.to_core(),
        already_breached: false,
    })?;
    if quote.survival_probability < deck.min_initial_survival
        || quote.survival_probability > deck.max_initial_survival
    {
        return Err(ProtocolError::Mismatch("player ranked risk band"));
    }
    Ok(())
}

fn valid_verifier_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

fn validate_client_sequence(
    previous: &mut Option<u64>,
    sequence: Option<u64>,
) -> Result<(), ProtocolError> {
    if let Some(sequence) = sequence {
        if previous.is_some_and(|value| sequence <= value) {
            return Err(ProtocolError::Mismatch("client event sequence"));
        }
        *previous = Some(sequence);
    }
    Ok(())
}

fn expected_clusters(touches: &[TouchDto]) -> Vec<FlagClusterDto> {
    let mut clusters = Vec::new();
    let mut index = 0;
    while index < touches.len() {
        let step = touches[index].step;
        let start = index;
        while index < touches.len() && touches[index].step == step {
            index += 1;
        }
        if index - start > 1 {
            clusters.push(FlagClusterDto {
                step,
                contender_ids: touches[start..index]
                    .iter()
                    .map(|touch| touch.contender_id)
                    .collect(),
            });
        }
    }
    clusters
}

fn regenerate_bot_escape_audit(
    bundle: &ReplayBundleDto,
    deck: &DeckVersion,
    bot_root: &[u8; 32],
) -> Result<(Vec<BotEscapeDecisionDto>, Vec<BotEscapeRecordDto>), ProtocolError> {
    let mut decisions = Vec::new();
    let mut escapes = Vec::new();
    for point in &bundle.path.battle {
        let line_value = point
            .price
            .parse::<u128>()
            .map_err(|_| ProtocolError::InvalidFixed("battle.price"))?;
        let touches: Vec<_> = bundle
            .touches
            .iter()
            .filter(|touch| touch.step <= point.step)
            .cloned()
            .collect();
        // Player Escape happens after the bot evaluations for its frame. It is
        // therefore public bot input only on later frames.
        let player_escape = bundle
            .escape
            .as_ref()
            .filter(|escape| escape.step < point.step)
            .cloned();
        let evaluations = evaluate_bot_escapes(
            deck,
            bot_root,
            line_value,
            point.step,
            &bundle.placements,
            &bundle.locked_scores,
            &touches,
            &player_escape,
            &escapes,
        )?;
        for evaluation in evaluations {
            decisions.push(evaluation.decision);
            if let Some(escape) = evaluation.escape {
                escapes.push(escape);
            }
        }
    }
    Ok((decisions, escapes))
}
