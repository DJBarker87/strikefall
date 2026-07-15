use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use strikefall_core::{
    deck_by_id, deck_by_ref, one_sided_no_touch, DeckVersion, NoTouchInputs, DECKS, SCALE,
};
use strikefall_protocol::{
    commitment_digest, deck_digest, deck_to_dto, derive_round_secrets, escape_enabled,
    evaluate_bot_escapes, evaluate_bot_placement_decision, event_digest,
    generate_bot_initial_roster, generate_bot_placement_schedule, generate_player_placement,
    lock_placements, locked_scores_digest, path_digest, path_to_dto, quote_escape,
    resolve_round as compute_resolution, validate_experiment_assignments, CreateRoundRequest,
    CreateRoundResponse, DeckDto, EscapeRequest, EscapeResponse, EventActorDto, FlagClusterDto,
    FlagUpdateRequest, FlagUpdateResponse, ReplayBundleDto, ReplayVerificationAckDto,
    ReplayVerifiedRequest, ReplayVerifiedResponse, RoundEventKindDto, RoundResultResponse,
    RoundStatusDto, SideDto, SignedRoundEventDto, TouchDto, BOT_PLACEMENT_POLICY_VERSION,
    BOT_PLACEMENT_WINDOW_MS, PLAYER_CONTENDER_ID, PROTOCOL_VERSION, RANKED_LOCK_PHASE_MS,
};
use tokio::sync::{broadcast, watch};
use tokio::task::{JoinHandle, JoinSet};
use uuid::Uuid;

use crate::alpha::{
    ClosedAlphaConfig, SessionContext, DECK_STRUCTURE_EXPERIMENT, ESCAPE_EXPERIMENT,
    RISK_DISPLAY_EXPERIMENT,
};
use crate::clock::Clock;
use crate::error::ServiceError;
use crate::model::RoundRecord;
use crate::repository::{RepositoryError, RoundRepository};

const INITIAL_SPOT: u128 = 100 * SCALE;
// The production Postgres pool defaults to ten connections. Recovery is
// capped at four workers so foreground API work retains most of the pool and
// CPU even when many rounds become due together.
pub(crate) const RECOVERY_CONCURRENCY_CEILING: usize = 4;

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub placement_duration_ms: u64,
    pub input_freeze_ms: u64,
    pub minimum_flag_update_interval_ms: u64,
    pub escape_close_before_end_ms: u64,
    pub recovery_concurrency: usize,
    pub auto_advance: bool,
    pub allowed_origin: String,
    pub trust_proxy_headers: bool,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            placement_duration_ms: 32_000,
            input_freeze_ms: 750,
            minimum_flag_update_interval_ms: 100,
            escape_close_before_end_ms: 3_000,
            recovery_concurrency: RECOVERY_CONCURRENCY_CEILING,
            auto_advance: true,
            allowed_origin: "http://localhost:4173".to_owned(),
            trust_proxy_headers: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StreamEnvelope {
    pub round_id: String,
    pub event: SignedRoundEventDto,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub discovered: usize,
    pub advanced: usize,
    pub superseded: usize,
    pub failed: usize,
}

#[derive(Clone)]
pub struct RoundService {
    pub(crate) repository: Arc<dyn RoundRepository>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) config: ServiceConfig,
    pub(crate) alpha_config: ClosedAlphaConfig,
    pub(crate) signing_key: Arc<SigningKey>,
    event_sender: broadcast::Sender<StreamEnvelope>,
}

impl RoundService {
    pub fn new(
        repository: Arc<dyn RoundRepository>,
        clock: Arc<dyn Clock>,
        config: ServiceConfig,
        signing_key: SigningKey,
    ) -> Self {
        Self::new_with_alpha_config(
            repository,
            clock,
            config,
            ClosedAlphaConfig::default(),
            signing_key,
        )
    }

    pub fn new_with_alpha_config(
        repository: Arc<dyn RoundRepository>,
        clock: Arc<dyn Clock>,
        config: ServiceConfig,
        alpha_config: ClosedAlphaConfig,
        signing_key: SigningKey,
    ) -> Self {
        let (event_sender, _) = broadcast::channel(1_024);
        Self {
            repository,
            clock,
            config,
            alpha_config,
            signing_key: Arc::new(signing_key),
            event_sender,
        }
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<StreamEnvelope> {
        self.event_sender.subscribe()
    }

    #[must_use]
    pub fn verifying_key_hex(&self) -> String {
        hex::encode(self.signing_key.verifying_key().to_bytes())
    }

    #[must_use]
    pub fn allowed_origin(&self) -> &str {
        &self.config.allowed_origin
    }

    #[must_use]
    pub const fn trust_proxy_headers(&self) -> bool {
        self.config.trust_proxy_headers
    }

    pub async fn readiness(&self) -> Result<(), ServiceError> {
        self.repository.health_check().await?;
        self.repository
            .validate_active_signing_key(&self.verifying_key_hex())
            .await?;
        Ok(())
    }

    /// Advances every overdue row returned by the repository scheduler boundary.
    ///
    /// Multiple processes may run this concurrently. Each process can discover
    /// the same document, but the repository's optimistic revision check allows
    /// only one transition to commit. Work within one process is bounded below
    /// the default Postgres pool size so a burst cannot starve foreground API
    /// requests while independent rounds advance in parallel.
    pub async fn recover_due_rounds(&self, limit: u32) -> Result<RecoveryReport, ServiceError> {
        let rounds = self.repository.list_due(self.clock.now_ms(), limit).await?;
        let mut report = RecoveryReport {
            discovered: rounds.len(),
            ..RecoveryReport::default()
        };

        let mut pending = rounds.into_iter();
        let mut tasks = JoinSet::new();
        let spawn = |tasks: &mut JoinSet<_>, round: RoundRecord| {
            let service = self.clone();
            tasks.spawn(async move {
                let round_id = round.id;
                let result = match round.status {
                    RoundStatusDto::Placement => {
                        Some(service.advance_placement_round(&round_id).await)
                    }
                    RoundStatusDto::Battle => Some(service.advance_battle_round(&round_id).await),
                    RoundStatusDto::Resolved => None,
                };
                (round_id, result)
            });
        };

        let recovery_concurrency = self
            .config
            .recovery_concurrency
            .clamp(1, RECOVERY_CONCURRENCY_CEILING);
        for round in pending.by_ref().take(recovery_concurrency) {
            spawn(&mut tasks, round);
        }
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((_, Some(Ok(())))) => report.advanced += 1,
                Ok((_, Some(Err(ServiceError::Conflict | ServiceError::InvalidState(_))))) => {
                    report.superseded += 1;
                }
                Ok((round_id, Some(Err(error)))) => {
                    report.failed += 1;
                    tracing::error!(%round_id, %error, "durable lifecycle transition failed");
                }
                Ok((_, None)) => {}
                Err(error) => {
                    report.failed += 1;
                    tracing::error!(%error, "durable lifecycle recovery task failed");
                }
            }
            if let Some(round) = pending.next() {
                spawn(&mut tasks, round);
            }
        }
        Ok(report)
    }

    #[must_use]
    pub fn spawn_recovery_worker(
        &self,
        interval: Duration,
        batch_size: u32,
        mut shutdown: watch::Receiver<bool>,
    ) -> JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                match service.recover_due_rounds(batch_size).await {
                    Ok(report) if report.discovered > 0 => tracing::info!(
                        discovered = report.discovered,
                        advanced = report.advanced,
                        superseded = report.superseded,
                        failed = report.failed,
                        "durable lifecycle recovery pass completed"
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::error!(%error, "durable lifecycle recovery pass failed");
                    }
                }
                tokio::select! {
                    () = tokio::time::sleep(interval) => {}
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            break;
                        }
                    }
                }
            }
        })
    }

    #[allow(clippy::too_many_lines)]
    pub async fn create_round(
        &self,
        request: CreateRoundRequest,
    ) -> Result<CreateRoundResponse, ServiceError> {
        self.create_round_internal(request, None).await
    }

    pub(crate) async fn create_round_for_session(
        &self,
        request: CreateRoundRequest,
        session: SessionContext,
    ) -> Result<CreateRoundResponse, ServiceError> {
        self.create_round_internal(request, Some(session)).await
    }

    #[allow(clippy::too_many_lines)]
    async fn create_round_internal(
        &self,
        request: CreateRoundRequest,
        session: Option<SessionContext>,
    ) -> Result<CreateRoundResponse, ServiceError> {
        if self.config.input_freeze_ms >= self.config.placement_duration_ms {
            return Err(ServiceError::InvalidRequest(
                "input freeze must be shorter than placement".to_owned(),
            ));
        }
        let now = self.clock.now_ms();
        let round_id = Uuid::new_v4().to_string();
        let mut master_secret = [0_u8; 32];
        getrandom::fill(&mut master_secret).map_err(|_| ServiceError::RandomUnavailable)?;
        let session_assignments = session
            .as_ref()
            .map_or_else(default_ranked_experiment_assignments, |value| {
                value.experiments.clone()
            });
        let deck = select_deck(&request, master_secret[0], &session_assignments)?;
        let mut experiment_assignments = session_assignments;
        if request.deck_id.is_some() {
            // An explicit Daily deck overrides, rather than participates in,
            // the Quick Run deck-structure treatment.
            experiment_assignments.remove(DECK_STRUCTURE_EXPERIMENT);
        }
        validate_experiment_assignments(&experiment_assignments)?;
        let secrets = derive_round_secrets(&master_secret, &round_id)?;
        let generated =
            strikefall_core::generate_round_path(deck, secrets.path_seed, INITIAL_SPOT)?;
        let path = path_to_dto(&generated);
        let battle_spot = generated
            .battle
            .first()
            .ok_or_else(|| ServiceError::Computation("empty battle path".to_owned()))?
            .price;
        let bots = generate_bot_initial_roster(deck, &secrets.bot_seed_root, battle_spot)?;
        let bot_schedule = generate_bot_placement_schedule(
            &secrets.bot_seed_root,
            self.config.placement_duration_ms,
            self.config.input_freeze_ms,
        )?;
        let mut placements = Vec::with_capacity(bots.len() + 1);
        placements.push(generate_player_placement(deck, battle_spot)?);
        placements.extend(bots.iter().cloned());
        let deck_dto = deck_to_dto(deck);
        let deck_hash = deck_digest(&deck_dto)?;
        let path_hash = path_digest(&path)?;
        let commitment = commitment_digest(
            PROTOCOL_VERSION,
            &round_id,
            &deck_hash,
            &path_hash,
            &secrets.bot_seed_root,
            &secrets.salt,
        )?;
        let placement_deadline_ms = now
            .checked_add(self.config.placement_duration_ms)
            .ok_or_else(|| ServiceError::Computation("deadline overflow".to_owned()))?;
        let input_freeze_at_ms = placement_deadline_ms - self.config.input_freeze_ms;
        let mut record = RoundRecord {
            id: round_id.clone(),
            protocol_version: PROTOCOL_VERSION.to_owned(),
            revision: 0,
            session_id: session.as_ref().map(|value| value.id.clone()),
            experiment_assignments: experiment_assignments.clone(),
            deck_id: deck.id.as_str().to_owned(),
            deck_version: deck.version,
            initial_spot: INITIAL_SPOT,
            path_seed: secrets.path_seed,
            bot_seed_root: secrets.bot_seed_root,
            salt: secrets.salt,
            deck_digest: deck_hash,
            path_digest: path_hash,
            commitment,
            server_verifying_key: self.verifying_key_hex(),
            status: RoundStatusDto::Placement,
            created_at_ms: now,
            placement_deadline_ms,
            input_freeze_at_ms,
            battle_started_at_ms: None,
            battle_next_step: 0,
            last_flag_update_ms: None,
            last_client_sequence: None,
            initial_bots: bots.clone(),
            bots: bots.clone(),
            bot_placement_next_index: 0,
            next_bot_placement_at_ms: bot_schedule.first().map(|scheduled| {
                now.saturating_add(bot_decision_offset_ms(
                    self.config.placement_duration_ms,
                    scheduled.decision_time_ms,
                ))
            }),
            bot_placement_decisions: Vec::with_capacity(bot_schedule.len()),
            placements,
            locked_scores: Vec::new(),
            path: path.clone(),
            escape: None,
            bot_escape_decisions: Vec::new(),
            bot_escapes: Vec::new(),
            touches: Vec::new(),
            result: None,
            replay_verification: None,
            events: Vec::new(),
        };
        let initial_player = record
            .placements
            .first()
            .cloned()
            .ok_or_else(|| ServiceError::Computation("player placement missing".to_owned()))?;
        self.append_event(
            &mut record,
            now,
            RoundEventKindDto::RoundCreated {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                commitment: hex::encode(commitment),
                experiment_assignments: experiment_assignments.clone(),
                player_placement: initial_player.clone(),
            },
        )?;
        for point in &path.approach {
            self.append_event(
                &mut record,
                now,
                RoundEventKindDto::ApproachFrame {
                    point: point.clone(),
                },
            )?;
        }
        self.append_event(
            &mut record,
            now,
            RoundEventKindDto::PlacementOpened {
                placement_deadline_ms,
                input_freeze_at_ms,
                bot_policy_version: BOT_PLACEMENT_POLICY_VERSION.to_owned(),
            },
        )?;
        self.repository.create(record.clone()).await?;

        if self.config.auto_advance {
            self.spawn_lifecycle(round_id.clone(), deck);
        }
        Ok(CreateRoundResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            round_id: round_id.clone(),
            deck: deck_dto,
            status: RoundStatusDto::Placement,
            commitment: hex::encode(commitment),
            server_verifying_key: self.verifying_key_hex(),
            created_at_ms: now,
            placement_deadline_ms,
            input_freeze_at_ms,
            experiment_assignments,
            approach: path.approach,
            player_placement: initial_player,
            bots,
            stream_url: format!("/v1/solo-rounds/{round_id}/stream"),
        })
    }

    fn visible_placements_at(
        round: &RoundRecord,
        decision_at_ms: u64,
    ) -> Result<Vec<strikefall_protocol::ContenderPlacementDto>, ServiceError> {
        let player = round
            .events
            .iter()
            .find_map(|event| match &event.kind {
                RoundEventKindDto::RoundCreated {
                    player_placement, ..
                } => Some(player_placement.clone()),
                _ => None,
            })
            .ok_or_else(|| ServiceError::Computation("initial player event missing".to_owned()))?;
        let mut visible = Vec::with_capacity(round.initial_bots.len() + 1);
        visible.push(player);
        visible.extend(round.initial_bots.iter().cloned());
        for event in &round.events {
            if event.server_time_ms > decision_at_ms {
                break;
            }
            let RoundEventKindDto::FlagMoved { placement, .. } = &event.kind else {
                continue;
            };
            let current = visible
                .iter_mut()
                .find(|current| current.contender_id == placement.contender_id)
                .ok_or_else(|| {
                    ServiceError::Computation("placement event contender missing".to_owned())
                })?;
            current.clone_from(placement);
        }
        Ok(visible)
    }

    /// Publishes only placement decisions whose public reaction timestamp has
    /// elapsed. The durable cursor and canonical timestamps make a delayed
    /// recovery pass byte-for-byte equivalent to uninterrupted publication.
    #[allow(clippy::too_many_lines)]
    pub async fn advance_placement_round(&self, round_id: &str) -> Result<(), ServiceError> {
        let mut round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        if round.status != RoundStatusDto::Placement {
            return Err(ServiceError::InvalidState(
                "round is not accepting placements",
            ));
        }
        let now = self.clock.now_ms();
        let expected_revision = round.revision;
        let first_new_event = round.events.len();
        let deck = Self::deck_for(&round)?;
        let battle_spot = battle_spot(&round)?;
        let placement_duration_ms = round
            .placement_deadline_ms
            .checked_sub(round.created_at_ms)
            .ok_or_else(|| ServiceError::Computation("placement timing underflow".to_owned()))?;
        let input_freeze_ms = round
            .placement_deadline_ms
            .checked_sub(round.input_freeze_at_ms)
            .ok_or_else(|| ServiceError::Computation("input freeze timing underflow".to_owned()))?;
        let schedule = generate_bot_placement_schedule(
            &round.bot_seed_root,
            placement_duration_ms,
            input_freeze_ms,
        )?;
        if round.bot_placement_next_index > schedule.len()
            || round.bot_placement_decisions.len() != round.bot_placement_next_index
        {
            return Err(ServiceError::Computation(
                "bot placement cursor is inconsistent".to_owned(),
            ));
        }

        while let Some(scheduled) = schedule.get(round.bot_placement_next_index).copied() {
            let decision_at_ms = round
                .created_at_ms
                .checked_add(bot_decision_offset_ms(
                    placement_duration_ms,
                    scheduled.decision_time_ms,
                ))
                .ok_or_else(|| {
                    ServiceError::Computation("bot decision time overflow".to_owned())
                })?;
            if decision_at_ms > now {
                break;
            }
            if round
                .events
                .last()
                .is_some_and(|event| event.server_time_ms > decision_at_ms)
            {
                return Err(ServiceError::Computation(
                    "bot decision would follow future public state".to_owned(),
                ));
            }
            let observation_at_ms = round
                .created_at_ms
                .checked_add(bot_decision_offset_ms(
                    placement_duration_ms,
                    scheduled.observation_time_ms,
                ))
                .ok_or_else(|| {
                    ServiceError::Computation("bot observation time overflow".to_owned())
                })?;
            if decision_at_ms.checked_sub(observation_at_ms)
                != Some(u64::from(scheduled.reaction_latency_ms))
            {
                return Err(ServiceError::Computation(
                    "bot reaction interval is inconsistent".to_owned(),
                ));
            }
            let visible = Self::visible_placements_at(&round, observation_at_ms)?;
            let decision = evaluate_bot_placement_decision(
                deck,
                &round.bot_seed_root,
                battle_spot,
                scheduled,
                &visible,
            )?;
            self.append_event(
                &mut round,
                decision_at_ms,
                RoundEventKindDto::BotPlacementDecision {
                    decision: decision.clone(),
                },
            )?;
            self.append_event(
                &mut round,
                decision_at_ms,
                RoundEventKindDto::FlagMoved {
                    actor: EventActorDto::Bot,
                    placement: decision.placement.clone(),
                    client_sequence: None,
                },
            )?;
            let placement = round
                .placements
                .iter_mut()
                .find(|placement| placement.contender_id == decision.contender_id)
                .ok_or_else(|| ServiceError::Computation("bot placement missing".to_owned()))?;
            placement.clone_from(&decision.placement);
            let bot = round
                .bots
                .iter_mut()
                .find(|placement| placement.contender_id == decision.contender_id)
                .ok_or_else(|| ServiceError::Computation("bot roster entry missing".to_owned()))?;
            bot.clone_from(&decision.placement);
            round.bot_placement_decisions.push(decision);
            round.bot_placement_next_index += 1;
        }
        round.next_bot_placement_at_ms =
            schedule
                .get(round.bot_placement_next_index)
                .map(|scheduled| {
                    round.created_at_ms.saturating_add(bot_decision_offset_ms(
                        placement_duration_ms,
                        scheduled.decision_time_ms,
                    ))
                });

        if now >= round.placement_deadline_ms {
            if round.bot_placement_next_index != schedule.len() {
                return Err(ServiceError::Computation(
                    "placement deadline preceded bot schedule".to_owned(),
                ));
            }
            round.locked_scores = lock_placements(deck, battle_spot, &round.placements)?;
            round.status = RoundStatusDto::Battle;
            let battle_starts_at_ms = round
                .placement_deadline_ms
                .checked_add(RANKED_LOCK_PHASE_MS)
                .ok_or_else(|| ServiceError::Computation("battle start overflow".to_owned()))?;
            round.battle_started_at_ms = Some(battle_starts_at_ms);
            round.battle_next_step = 0;
            round.next_bot_placement_at_ms = None;
            let locked_digest = locked_scores_digest(&round.locked_scores)?;
            let locked_scores = round.locked_scores.clone();
            let locked_at = round.placement_deadline_ms;
            self.append_event(
                &mut round,
                locked_at,
                RoundEventKindDto::PlacementLocked {
                    locked_scores_digest: hex::encode(locked_digest),
                    locked_scores,
                    battle_starts_at_ms,
                },
            )?;
        }

        if first_new_event == round.events.len() {
            return Ok(());
        }
        self.save_and_publish(expected_revision, round, first_new_event)
            .await
    }

    pub async fn update_flag(
        &self,
        round_id: &str,
        request: FlagUpdateRequest,
    ) -> Result<FlagUpdateResponse, ServiceError> {
        self.advance_placement_round(round_id).await?;
        let mut round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        let expected_revision = round.revision;
        let first_new_event = round.events.len();
        let now = self.clock.now_ms();
        if round.status != RoundStatusDto::Placement {
            return Err(ServiceError::InvalidState("placement has ended"));
        }
        if now >= round.input_freeze_at_ms {
            return Err(ServiceError::InputFrozen);
        }
        if let Some(previous) = round.last_flag_update_ms {
            let next = previous.saturating_add(self.config.minimum_flag_update_interval_ms);
            if now < next {
                return Err(ServiceError::RateLimited(next - now));
            }
        }
        if let (Some(previous), Some(sequence)) =
            (round.last_client_sequence, request.client_sequence)
        {
            if sequence <= previous {
                return Err(ServiceError::InvalidRequest(
                    "clientSequence must increase".to_owned(),
                ));
            }
        }
        let barrier = request.barrier.parse::<u128>().map_err(|_| {
            ServiceError::InvalidRequest("barrier must be a decimal u128".to_owned())
        })?;
        let deck = Self::deck_for(&round)?;
        let battle_spot = battle_spot(&round)?;
        let quote = one_sided_no_touch(NoTouchInputs {
            spot: battle_spot,
            barrier,
            remaining_variance: deck.total_integrated_variance,
            drift_per_variance: deck.drift_per_variance,
            side: request.side.to_core(),
            already_breached: false,
        })
        .map_err(|error| ServiceError::InvalidRequest(error.to_string()))?;
        if quote.survival_probability < deck.min_initial_survival
            || quote.survival_probability > deck.max_initial_survival
        {
            return Err(ServiceError::InvalidRequest(
                "flag is outside this deck's ranked risk band".to_owned(),
            ));
        }
        let placement = round
            .placements
            .iter_mut()
            .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
            .ok_or_else(|| ServiceError::Computation("player placement missing".to_owned()))?;
        placement.side = request.side;
        placement.barrier = barrier.to_string();
        let placement = placement.clone();
        round.last_flag_update_ms = Some(now);
        round.last_client_sequence = request.client_sequence.or(round.last_client_sequence);
        let event = self.append_event(
            &mut round,
            now,
            RoundEventKindDto::FlagMoved {
                actor: EventActorDto::Player,
                placement: placement.clone(),
                client_sequence: request.client_sequence,
            },
        )?;
        self.save_and_publish(expected_revision, round, first_new_event)
            .await?;
        Ok(FlagUpdateResponse {
            event_sequence: event.sequence,
            placement,
            input_freeze_at_ms: self.load(round_id).await?.input_freeze_at_ms,
        })
    }

    pub async fn escape(
        &self,
        round_id: &str,
        request: EscapeRequest,
    ) -> Result<EscapeResponse, ServiceError> {
        self.advance_battle_round(round_id).await?;
        let mut round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        let expected_revision = round.revision;
        let first_new_event = round.events.len();
        if round.status != RoundStatusDto::Battle {
            return Err(ServiceError::InvalidState(
                "escape requires an active battle",
            ));
        }
        if !escape_enabled(&round.experiment_assignments)? {
            return Err(ServiceError::InvalidState(
                "escape is disabled for this experiment assignment",
            ));
        }
        if round.escape.is_some() {
            return Err(ServiceError::InvalidState("escape was already used"));
        }
        if round
            .touches
            .iter()
            .any(|touch| touch.contender_id == PLAYER_CONTENDER_ID)
        {
            return Err(ServiceError::InvalidState("player flag was already hit"));
        }
        if let (Some(previous), Some(sequence)) =
            (round.last_client_sequence, request.client_sequence)
        {
            if sequence <= previous {
                return Err(ServiceError::InvalidRequest(
                    "clientSequence must increase".to_owned(),
                ));
            }
        }
        let deck = Self::deck_for(&round)?;
        let start = round
            .battle_started_at_ms
            .ok_or_else(|| ServiceError::Computation("battle start missing".to_owned()))?;
        let now = self.clock.now_ms();
        let elapsed = now.saturating_sub(start);
        let duration = battle_duration_ms(deck);
        if elapsed < duration / 2 {
            return Err(ServiceError::InvalidState("escape has not unlocked"));
        }
        if elapsed >= duration.saturating_sub(self.config.escape_close_before_end_ms) {
            return Err(ServiceError::InvalidState("escape window has closed"));
        }
        let step = u16::try_from(elapsed / u64::from(deck.step_ms))
            .map_err(|_| ServiceError::Computation("escape step overflow".to_owned()))?;
        let player = round
            .placements
            .iter()
            .find(|placement| placement.contender_id == PLAYER_CONTENDER_ID)
            .ok_or_else(|| ServiceError::Computation("player placement missing".to_owned()))?;
        let player_locked = round
            .locked_scores
            .iter()
            .find(|score| score.contender_id == PLAYER_CONTENDER_ID)
            .ok_or_else(|| ServiceError::Computation("player locked score missing".to_owned()))?;
        let escape = quote_escape(deck, &round.path, player, player_locked, step)?;
        round.escape = Some(escape.clone());
        round.last_client_sequence = request.client_sequence.or(round.last_client_sequence);
        let event = self.append_event(
            &mut round,
            now,
            RoundEventKindDto::EscapeAccepted {
                contender_id: PLAYER_CONTENDER_ID,
                actor: EventActorDto::Player,
                escape: escape.clone(),
            },
        )?;
        self.save_and_publish(expected_revision, round, first_new_event)
            .await?;
        Ok(EscapeResponse {
            event_sequence: event.sequence,
            escape,
        })
    }

    pub async fn lock_round(&self, round_id: &str) -> Result<(), ServiceError> {
        let round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        if round.status != RoundStatusDto::Placement {
            return Err(ServiceError::InvalidState(
                "round is not accepting placements",
            ));
        }
        let now = self.clock.now_ms();
        if now < round.placement_deadline_ms {
            return Err(ServiceError::InvalidState(
                "placement deadline has not elapsed",
            ));
        }
        self.advance_placement_round(round_id).await
    }

    pub async fn resolve_round(&self, round_id: &str) -> Result<(), ServiceError> {
        let round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        if round.status == RoundStatusDto::Resolved {
            return Ok(());
        }
        if round.status != RoundStatusDto::Battle {
            return Err(ServiceError::InvalidState("round is not in battle"));
        }
        let deck = Self::deck_for(&round)?;
        let start = round
            .battle_started_at_ms
            .ok_or_else(|| ServiceError::Computation("battle start missing".to_owned()))?;
        let now = self.clock.now_ms();
        if now < start.saturating_add(battle_duration_ms(deck)) {
            return Err(ServiceError::InvalidState("battle has not elapsed"));
        }
        self.advance_battle_round(round_id).await
    }

    /// Durably appends every battle frame whose public deadline has elapsed.
    ///
    /// A delayed worker may catch up several frames in one optimistic write,
    /// but each frame keeps its canonical logical timestamp. That makes crash
    /// recovery byte-for-byte equivalent to an uninterrupted publisher.
    pub async fn advance_battle_round(&self, round_id: &str) -> Result<(), ServiceError> {
        let mut round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        if round.status == RoundStatusDto::Resolved {
            return Ok(());
        }
        if round.status != RoundStatusDto::Battle {
            return Err(ServiceError::InvalidState("round is not in battle"));
        }
        let deck = Self::deck_for(&round)?;
        let start = round
            .battle_started_at_ms
            .ok_or_else(|| ServiceError::Computation("battle start missing".to_owned()))?;
        let now = self.clock.now_ms();
        let expected_revision = round.revision;
        let first_new_event = round.events.len();

        while round.battle_next_step <= deck.battle_steps {
            let frame_time = start
                .checked_add(
                    u64::from(round.battle_next_step)
                        .checked_mul(u64::from(deck.step_ms))
                        .ok_or_else(|| {
                            ServiceError::Computation("battle frame time overflow".to_owned())
                        })?,
                )
                .ok_or_else(|| {
                    ServiceError::Computation("battle frame deadline overflow".to_owned())
                })?;
            if frame_time > now {
                break;
            }
            let step = round.battle_next_step;
            self.append_battle_frame(&mut round, deck, step, frame_time)?;
            round.battle_next_step = step.checked_add(1).ok_or_else(|| {
                ServiceError::Computation("battle frame sequence overflow".to_owned())
            })?;
        }

        if round.battle_next_step > deck.battle_steps {
            let ended_at = start
                .checked_add(battle_duration_ms(deck))
                .ok_or_else(|| ServiceError::Computation("battle end overflow".to_owned()))?;
            self.finalize_round(&mut round, deck, ended_at)?;
        }

        if first_new_event == round.events.len() {
            return Ok(());
        }
        self.save_and_publish(expected_revision, round, first_new_event)
            .await
    }

    pub async fn acknowledge_replay(
        &self,
        round_id: &str,
        request: ReplayVerifiedRequest,
    ) -> Result<ReplayVerifiedResponse, ServiceError> {
        let mut round = self.load(round_id).await?;
        self.ensure_round_signing_key(&round)?;
        if round.status != RoundStatusDto::Resolved {
            return Err(ServiceError::InvalidState(
                "replay verification requires a resolved round",
            ));
        }
        let result = round
            .result
            .as_ref()
            .ok_or_else(|| ServiceError::Computation("resolved result missing".to_owned()))?;
        if request.proof_digest != result.proof_digest {
            return Err(ServiceError::InvalidRequest(
                "proofDigest does not match the resolved replay".to_owned(),
            ));
        }
        validate_verifier_version(&request.verifier_version)?;
        if let Some(existing) = &round.replay_verification {
            if existing.proof_digest == request.proof_digest
                && existing.verifier_version == request.verifier_version
            {
                return Ok(ReplayVerifiedResponse {
                    event_sequence: existing.event_sequence,
                    already_acknowledged: true,
                });
            }
            return Err(ServiceError::Conflict);
        }

        let replay = round
            .replay_bundle()
            .ok_or_else(|| ServiceError::Computation("resolved replay is incomplete".to_owned()))?;
        let commitment_anchor = hex::encode(round.commitment);
        strikefall_protocol::verify_replay_bundle_against(
            &replay,
            Some(&commitment_anchor),
            Some(&round.server_verifying_key),
        )?;

        let expected_revision = round.revision;
        let first_new_event = round.events.len();
        let acknowledged_at_ms = self.clock.now_ms();
        let event = self.append_event(
            &mut round,
            acknowledged_at_ms,
            RoundEventKindDto::ReplayVerified {
                proof_digest: request.proof_digest.clone(),
                verifier_version: request.verifier_version.clone(),
            },
        )?;
        round.replay_verification = Some(ReplayVerificationAckDto {
            proof_digest: request.proof_digest,
            verifier_version: request.verifier_version,
            acknowledged_at_ms,
            event_sequence: event.sequence,
        });
        self.save_and_publish(expected_revision, round, first_new_event)
            .await?;
        Ok(ReplayVerifiedResponse {
            event_sequence: event.sequence,
            already_acknowledged: false,
        })
    }

    pub async fn result(&self, round_id: &str) -> Result<RoundResultResponse, ServiceError> {
        let round = self.load(round_id).await?;
        let reveal = (round.status == RoundStatusDto::Resolved).then(|| round.reveal());
        Ok(RoundResultResponse {
            round_id: round.id,
            status: round.status,
            result: round.result,
            reveal,
        })
    }

    pub async fn replay(&self, round_id: &str) -> Result<ReplayBundleDto, ServiceError> {
        let round = self.load(round_id).await?;
        if round.status != RoundStatusDto::Resolved {
            return Err(ServiceError::InvalidState(
                "replay is sealed until resolution",
            ));
        }
        round
            .replay_bundle()
            .ok_or_else(|| ServiceError::Computation("resolved replay is incomplete".to_owned()))
    }

    pub async fn event_snapshot(
        &self,
        round_id: &str,
    ) -> Result<Vec<SignedRoundEventDto>, ServiceError> {
        Ok(self.load(round_id).await?.events)
    }

    pub fn deck(&self, deck_id: &str, version: u16) -> Result<DeckDto, ServiceError> {
        let deck = deck_by_ref(deck_id, version)
            .ok_or_else(|| ServiceError::InvalidRequest(format!("unknown deck '{deck_id}'")))?;
        Ok(deck_to_dto(deck))
    }

    fn append_event(
        &self,
        round: &mut RoundRecord,
        server_time_ms: u64,
        kind: RoundEventKindDto,
    ) -> Result<SignedRoundEventDto, ServiceError> {
        let sequence = u64::try_from(round.events.len())
            .map_err(|_| ServiceError::Computation("event sequence overflow".to_owned()))?;
        let previous_digest = round
            .events
            .last()
            .map_or_else(|| hex::encode([0_u8; 32]), |event| event.digest.clone());
        let digest = event_digest(&previous_digest, sequence, server_time_ms, &kind)?;
        let signature = self.signing_key.sign(&digest);
        let event = SignedRoundEventDto {
            sequence,
            server_time_ms,
            previous_digest,
            kind,
            digest: hex::encode(digest),
            signature: hex::encode(signature.to_bytes()),
        };
        round.events.push(event.clone());
        Ok(event)
    }

    pub(crate) async fn load(&self, round_id: &str) -> Result<RoundRecord, ServiceError> {
        self.repository
            .load(round_id)
            .await?
            .ok_or(ServiceError::NotFound)
    }

    async fn save_and_publish(
        &self,
        expected_revision: u64,
        round: RoundRecord,
        first_new_event: usize,
    ) -> Result<(), ServiceError> {
        let new_events = round.events[first_new_event..].to_vec();
        let round_id = round.id.clone();
        match self.repository.save(expected_revision, round).await {
            Ok(()) => {
                for event in new_events {
                    let _ = self.event_sender.send(StreamEnvelope {
                        round_id: round_id.clone(),
                        event,
                    });
                }
                Ok(())
            }
            Err(RepositoryError::RevisionConflict) => Err(ServiceError::Conflict),
            Err(error) => Err(error.into()),
        }
    }

    fn deck_for(round: &RoundRecord) -> Result<&'static DeckVersion, ServiceError> {
        let deck = deck_by_ref(&round.deck_id, round.deck_version)
            .ok_or_else(|| ServiceError::Computation("stored deck is unavailable".to_owned()))?;
        Ok(deck)
    }

    fn ensure_round_signing_key(&self, round: &RoundRecord) -> Result<(), ServiceError> {
        if round.server_verifying_key != self.verifying_key_hex() {
            return Err(ServiceError::Computation(
                "active round publisher key does not match this service instance".to_owned(),
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    fn append_battle_frame(
        &self,
        round: &mut RoundRecord,
        deck: &DeckVersion,
        step: u16,
        server_time_ms: u64,
    ) -> Result<(), ServiceError> {
        let point = round
            .path
            .battle
            .get(usize::from(step))
            .cloned()
            .ok_or_else(|| ServiceError::Computation("battle frame missing".to_owned()))?;
        if point.step != step {
            return Err(ServiceError::Computation(
                "battle frame sequence mismatch".to_owned(),
            ));
        }
        self.append_event(
            round,
            server_time_ms,
            RoundEventKindDto::BattleFrame {
                point: point.clone(),
            },
        )?;

        let line_value = point
            .price
            .parse::<u128>()
            .map_err(|_| ServiceError::Computation("battle line is invalid".to_owned()))?;
        let interval_high = point
            .interval_high
            .parse::<u128>()
            .map_err(|_| ServiceError::Computation("battle interval high is invalid".to_owned()))?;
        let interval_low = point
            .interval_low
            .parse::<u128>()
            .map_err(|_| ServiceError::Computation("battle interval low is invalid".to_owned()))?;
        let mut new_touches = Vec::new();
        for placement in &round.placements {
            let inactive = round
                .touches
                .iter()
                .any(|touch| touch.contender_id == placement.contender_id)
                || (placement.contender_id == PLAYER_CONTENDER_ID && round.escape.is_some())
                || round
                    .bot_escapes
                    .iter()
                    .any(|escape| escape.contender_id == placement.contender_id);
            if inactive {
                continue;
            }
            let barrier = placement.barrier.parse::<u128>().map_err(|_| {
                ServiceError::Computation("stored placement barrier is invalid".to_owned())
            })?;
            let hit = match placement.side {
                SideDto::Upper => interval_high >= barrier,
                SideDto::Lower => interval_low <= barrier,
            };
            if hit {
                new_touches.push(TouchDto {
                    contender_id: placement.contender_id,
                    step,
                    side: placement.side,
                    barrier: placement.barrier.clone(),
                    line_value: match placement.side {
                        SideDto::Upper => point.interval_high.clone(),
                        SideDto::Lower => point.interval_low.clone(),
                    },
                });
            }
        }
        new_touches.sort_unstable_by_key(|touch| touch.contender_id);
        if new_touches.len() > 1 {
            self.append_event(
                round,
                server_time_ms,
                RoundEventKindDto::FlagCluster {
                    cluster: FlagClusterDto {
                        step,
                        contender_ids: new_touches.iter().map(|touch| touch.contender_id).collect(),
                    },
                },
            )?;
        }
        for touch in new_touches {
            round.touches.push(touch.clone());
            self.append_event(round, server_time_ms, RoundEventKindDto::FlagHit { touch })?;
        }

        let evaluations = if escape_enabled(&round.experiment_assignments)? {
            evaluate_bot_escapes(
                deck,
                &round.bot_seed_root,
                line_value,
                step,
                &round.placements,
                &round.locked_scores,
                &round.touches,
                &round.escape,
                &round.bot_escapes,
            )?
        } else {
            Vec::new()
        };
        for evaluation in evaluations {
            round.bot_escape_decisions.push(evaluation.decision.clone());
            self.append_event(
                round,
                server_time_ms,
                RoundEventKindDto::BotEscapeEvaluated {
                    decision: evaluation.decision,
                },
            )?;
            if let Some(escape) = evaluation.escape {
                self.append_event(
                    round,
                    server_time_ms,
                    RoundEventKindDto::EscapeAccepted {
                        contender_id: escape.contender_id,
                        actor: EventActorDto::Bot,
                        escape: escape.escape.clone(),
                    },
                )?;
                round.bot_escapes.push(escape);
            }
        }
        Ok(())
    }

    fn finalize_round(
        &self,
        round: &mut RoundRecord,
        deck: &DeckVersion,
        server_time_ms: u64,
    ) -> Result<(), ServiceError> {
        let (locked_scores, touches, result) = compute_resolution(
            deck,
            &round.path,
            &round.placements,
            &round.escape,
            &round.bot_escapes,
        )?;
        if locked_scores != round.locked_scores {
            return Err(ServiceError::Computation(
                "locked score recomputation mismatch".to_owned(),
            ));
        }
        if touches != round.touches {
            return Err(ServiceError::Computation(
                "streamed touch recomputation mismatch".to_owned(),
            ));
        }
        self.append_event(
            round,
            server_time_ms,
            RoundEventKindDto::RoundEnded {
                proof_digest: result.proof_digest.clone(),
            },
        )?;
        self.append_event(
            round,
            server_time_ms,
            RoundEventKindDto::SeedRevealed {
                reveal: round.reveal(),
            },
        )?;
        round.result = Some(result);
        round.status = RoundStatusDto::Resolved;
        Ok(())
    }

    fn spawn_lifecycle(&self, round_id: String, deck: &'static DeckVersion) {
        let service = self.clone();
        let placement_duration = self.config.placement_duration_ms;
        let input_freeze = self.config.input_freeze_ms;
        tokio::spawn(async move {
            let schedule = match service.load(&round_id).await.and_then(|round| {
                generate_bot_placement_schedule(
                    &round.bot_seed_root,
                    placement_duration,
                    input_freeze,
                )
                .map_err(ServiceError::from)
            }) {
                Ok(schedule) => schedule,
                Err(error) => {
                    tracing::warn!(%round_id, %error, "automatic bot schedule failed");
                    return;
                }
            };
            let mut elapsed = 0_u64;
            for scheduled in schedule {
                let due_offset =
                    bot_decision_offset_ms(placement_duration, scheduled.decision_time_ms);
                tokio::time::sleep(Duration::from_millis(due_offset.saturating_sub(elapsed))).await;
                elapsed = due_offset;
                if let Err(error) = service.advance_placement_round(&round_id).await {
                    tracing::warn!(%round_id, %error, "automatic bot placement advance failed");
                    if !matches!(error, ServiceError::Conflict) {
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(
                placement_duration.saturating_sub(elapsed),
            ))
            .await;
            if let Err(error) = service.advance_placement_round(&round_id).await {
                tracing::warn!(%round_id, %error, "automatic placement lock failed");
                if !matches!(error, ServiceError::Conflict) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(RANKED_LOCK_PHASE_MS)).await;
            if let Err(error) = service.advance_battle_round(&round_id).await {
                tracing::warn!(%round_id, %error, "automatic battle start failed");
                if !matches!(error, ServiceError::Conflict) {
                    return;
                }
            }
            for _ in 1..=deck.battle_steps {
                tokio::time::sleep(Duration::from_millis(u64::from(deck.step_ms))).await;
                if let Err(error) = service.advance_battle_round(&round_id).await {
                    tracing::warn!(%round_id, %error, "automatic battle frame failed");
                    if !matches!(error, ServiceError::Conflict) {
                        return;
                    }
                }
            }
        });
    }
}

fn validate_verifier_version(value: &str) -> Result<(), ServiceError> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'));
    if !valid {
        return Err(ServiceError::InvalidRequest(
            "verifierVersion must be 1-64 ASCII letters, digits, '.', '_', '/', or '-'".to_owned(),
        ));
    }
    Ok(())
}

fn select_deck(
    request: &CreateRoundRequest,
    random_byte: u8,
    experiment_assignments: &std::collections::BTreeMap<String, String>,
) -> Result<&'static DeckVersion, ServiceError> {
    let deck = if let Some(deck_id) = &request.deck_id {
        deck_by_id(deck_id)
            .ok_or_else(|| ServiceError::InvalidRequest(format!("unknown deck '{deck_id}'")))?
    } else if let Some(variant) = experiment_assignments.get(DECK_STRUCTURE_EXPERIMENT) {
        let deck_id = match variant.as_str() {
            "flat" => "balanced_tape",
            "compression-break" => "compression_break",
            _ => {
                return Err(ServiceError::Computation(
                    "stored deck-structure:v2 assignment is unsupported".to_owned(),
                ));
            }
        };
        deck_by_id(deck_id).ok_or_else(|| {
            ServiceError::Computation("assigned experiment deck is unavailable".to_owned())
        })?
    } else {
        &DECKS[usize::from(random_byte) % DECKS.len()]
    };
    if request
        .deck_version
        .is_some_and(|version| version != deck.version)
    {
        return Err(ServiceError::InvalidRequest(format!(
            "deck '{}' does not have requested version",
            deck.id.as_str()
        )));
    }
    Ok(deck)
}

fn default_ranked_experiment_assignments() -> BTreeMap<String, String> {
    BTreeMap::from([
        (ESCAPE_EXPERIMENT.to_owned(), "midpoint".to_owned()),
        (RISK_DISPLAY_EXPERIMENT.to_owned(), "danger-band".to_owned()),
    ])
}

fn battle_spot(round: &RoundRecord) -> Result<u128, ServiceError> {
    round
        .path
        .battle
        .first()
        .ok_or_else(|| ServiceError::Computation("battle path missing".to_owned()))?
        .price
        .parse::<u128>()
        .map_err(|_| ServiceError::Computation("battle spot is invalid".to_owned()))
}

const fn bot_decision_offset_ms(placement_duration_ms: u64, decision_time_ms: u64) -> u64 {
    placement_duration_ms
        .saturating_sub(BOT_PLACEMENT_WINDOW_MS)
        .saturating_add(decision_time_ms)
}

const fn battle_duration_ms(deck: &DeckVersion) -> u64 {
    deck.battle_steps as u64 * deck.step_ms as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_quick_run_maps_every_random_byte_uniformly_across_four_decks() {
        let assignments = default_ranked_experiment_assignments();
        assert_eq!(assignments.len(), 2);
        assert!(!assignments.contains_key(DECK_STRUCTURE_EXPERIMENT));
        let request = CreateRoundRequest::default();
        let mut counts = [0_u16; 4];
        for entropy in 0_u8..=u8::MAX {
            let selected = select_deck(&request, entropy, &assignments).expect("public deck");
            let index = DECKS
                .iter()
                .position(|deck| deck.id == selected.id)
                .expect("selected deck is shipped");
            counts[index] += 1;
        }
        assert_eq!(counts, [64, 64, 64, 64]);
    }

    #[test]
    fn explicit_alpha_assignment_pins_only_quick_run_and_named_decks_win() {
        let request = CreateRoundRequest::default();
        let mut assignments = default_ranked_experiment_assignments();
        assignments.insert(DECK_STRUCTURE_EXPERIMENT.to_owned(), "flat".to_owned());
        assert_eq!(
            select_deck(&request, 3, &assignments)
                .expect("flat treatment")
                .id
                .as_str(),
            "balanced_tape"
        );
        assignments.insert(
            DECK_STRUCTURE_EXPERIMENT.to_owned(),
            "compression-break".to_owned(),
        );
        assert_eq!(
            select_deck(&request, 2, &assignments)
                .expect("compression treatment")
                .id
                .as_str(),
            "compression_break"
        );

        let featured = CreateRoundRequest {
            deck_id: Some("pulse".to_owned()),
            deck_version: Some(3),
        };
        assert_eq!(
            select_deck(&featured, 0, &assignments)
                .expect("named deck")
                .id
                .as_str(),
            "pulse"
        );
    }
}
