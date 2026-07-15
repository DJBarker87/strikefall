use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SideDto {
    Upper,
    Lower,
}

impl SideDto {
    #[must_use]
    pub const fn to_core(self) -> strikefall_core::BarrierSide {
        match self {
            Self::Upper => strikefall_core::BarrierSide::Upper,
            Self::Lower => strikefall_core::BarrierSide::Lower,
        }
    }
}

impl From<strikefall_core::BarrierSide> for SideDto {
    fn from(value: strikefall_core::BarrierSide) -> Self {
        match value {
            strikefall_core::BarrierSide::Upper => Self::Upper,
            strikefall_core::BarrierSide::Lower => Self::Lower,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRefDto {
    pub id: String,
    pub version: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningRunwayDto {
    pub steps: u16,
    pub variance_share_bps: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDto {
    pub id: String,
    pub version: u16,
    pub display_name: String,
    pub approach_steps: u16,
    pub battle_steps: u16,
    pub step_ms: u16,
    pub monitoring_convention: String,
    pub variance_weights: [u16; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening_runway: Option<OpeningRunwayDto>,
    pub total_integrated_variance: String,
    pub drift_per_variance: String,
    pub min_initial_survival: String,
    pub max_initial_survival: String,
    pub risk_multiplier_cap: String,
    pub art_theme: String,
    pub audio_profile: String,
    pub calibration_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPointDto {
    pub step: u16,
    pub variance_elapsed: String,
    pub log_return: String,
    pub price: String,
    pub interval_high: String,
    pub interval_low: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPathDto {
    pub approach: Vec<PathPointDto>,
    pub battle: Vec<PathPointDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContenderPlacementDto {
    pub contender_id: u16,
    pub name: String,
    pub is_bot: bool,
    pub persona: Option<String>,
    pub side: SideDto,
    pub barrier: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedScoreDto {
    pub contender_id: u16,
    pub side: SideDto,
    pub barrier: String,
    pub normalized_distance: String,
    pub initial_survival: String,
    pub risk_multiplier: String,
    pub crowd_factor: String,
    pub terminal_score: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchDto {
    pub contender_id: u16,
    pub step: u16,
    pub side: SideDto,
    pub barrier: String,
    pub line_value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscapeRecordDto {
    pub step: u16,
    pub banked_score: String,
    pub line_value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventActorDto {
    Player,
    Bot,
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPlacementDecisionDto {
    pub contender_id: u16,
    pub persona: String,
    pub policy_version: String,
    pub decision_number: u16,
    /// Milliseconds after the placement window opened.
    pub decision_time_ms: u64,
    /// Milliseconds after the placement window opened when public state was sampled.
    pub observation_time_ms: u64,
    /// Committed delay between `observation_time_ms` and `decision_time_ms`.
    pub reaction_latency_ms: u16,
    pub public_inputs_digest: String,
    pub entropy_digest: String,
    pub candidates_digest: String,
    pub candidate_count: u16,
    pub selected_candidate: u16,
    pub selected_utility: String,
    pub reason_code: String,
    pub candidates: Vec<BotPlacementCandidateDto>,
    pub placement: ContenderPlacementDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPlacementCandidateDto {
    pub candidate_number: u16,
    pub side: SideDto,
    pub target_survival: String,
    pub barrier: String,
    pub quoted_survival: String,
    pub projected_crowd_factor: String,
    pub terminal_score: String,
    /// Signed SCALE=1e12 fixed-point utility in point units.
    pub utility: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotEscapeDecisionDto {
    pub contender_id: u16,
    pub persona: String,
    pub policy_version: String,
    pub decision_bucket: u16,
    pub step: u16,
    pub public_inputs_digest: String,
    pub survival_probability: String,
    pub threshold: String,
    pub chance_roll: String,
    pub decision_chance: String,
    pub accepted: bool,
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotEscapeRecordDto {
    pub contender_id: u16,
    pub decision_bucket: u16,
    pub escape: EscapeRecordDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagClusterDto {
    pub step: u16,
    pub contender_ids: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayVerificationAckDto {
    pub proof_digest: String,
    pub verifier_version: String,
    pub acknowledged_at_ms: u64,
    pub event_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContenderOutcomeDto {
    Survived,
    Eliminated,
    Escaped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContenderResultDto {
    pub contender_id: u16,
    pub name: String,
    pub outcome: ContenderOutcomeDto,
    pub score: String,
    pub rank: u16,
    pub touch_step: Option<u16>,
    pub closest_approach: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundResultDto {
    pub outcome: ContenderOutcomeDto,
    pub score: String,
    pub rank: u16,
    pub survivors: u16,
    pub closest_approach: String,
    pub contenders: Vec<ContenderResultDto>,
    pub proof_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoundStatusDto {
    Placement,
    Battle,
    Resolved,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoundRequest {
    pub deck_id: Option<String>,
    pub deck_version: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoundResponse {
    pub protocol_version: String,
    pub round_id: String,
    pub deck: DeckDto,
    pub status: RoundStatusDto,
    pub commitment: String,
    pub server_verifying_key: String,
    pub created_at_ms: u64,
    pub placement_deadline_ms: u64,
    pub input_freeze_at_ms: u64,
    pub experiment_assignments: BTreeMap<String, String>,
    pub approach: Vec<PathPointDto>,
    pub player_placement: ContenderPlacementDto,
    pub bots: Vec<ContenderPlacementDto>,
    pub stream_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagUpdateRequest {
    pub side: SideDto,
    pub barrier: String,
    pub client_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagUpdateResponse {
    pub event_sequence: u64,
    pub placement: ContenderPlacementDto,
    pub input_freeze_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscapeRequest {
    pub client_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscapeResponse {
    pub event_sequence: u64,
    pub escape: EscapeRecordDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealDto {
    pub path_seed: String,
    pub bot_seed_root: String,
    pub salt: String,
    pub deck_digest: String,
    pub path_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundResultResponse {
    pub round_id: String,
    pub status: RoundStatusDto,
    pub result: Option<RoundResultDto>,
    pub reveal: Option<RevealDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayVerifiedRequest {
    pub proof_digest: String,
    pub verifier_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayVerifiedResponse {
    pub event_sequence: u64,
    pub already_acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoundEventKindDto {
    RoundCreated {
        protocol_version: String,
        commitment: String,
        experiment_assignments: BTreeMap<String, String>,
        player_placement: ContenderPlacementDto,
    },
    ApproachFrame {
        point: PathPointDto,
    },
    PlacementOpened {
        placement_deadline_ms: u64,
        input_freeze_at_ms: u64,
        bot_policy_version: String,
    },
    BotPlacementDecision {
        decision: BotPlacementDecisionDto,
    },
    FlagMoved {
        actor: EventActorDto,
        placement: ContenderPlacementDto,
        client_sequence: Option<u64>,
    },
    PlacementLocked {
        locked_scores_digest: String,
        locked_scores: Vec<LockedScoreDto>,
        battle_starts_at_ms: u64,
    },
    BattleFrame {
        point: PathPointDto,
    },
    FlagCluster {
        cluster: FlagClusterDto,
    },
    BotEscapeEvaluated {
        decision: BotEscapeDecisionDto,
    },
    EscapeAccepted {
        contender_id: u16,
        actor: EventActorDto,
        escape: EscapeRecordDto,
    },
    FlagHit {
        touch: TouchDto,
    },
    RoundEnded {
        proof_digest: String,
    },
    SeedRevealed {
        reveal: RevealDto,
    },
    ReplayVerified {
        proof_digest: String,
        verifier_version: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRoundEventDto {
    pub sequence: u64,
    pub server_time_ms: u64,
    pub previous_digest: String,
    pub kind: RoundEventKindDto,
    pub digest: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBundleDto {
    pub protocol_version: String,
    pub round_id: String,
    pub deck: DeckDto,
    pub initial_spot: String,
    pub commitment: String,
    pub server_verifying_key: String,
    pub experiment_assignments: BTreeMap<String, String>,
    pub bots: Vec<ContenderPlacementDto>,
    pub bot_placement_decisions: Vec<BotPlacementDecisionDto>,
    pub placements: Vec<ContenderPlacementDto>,
    pub locked_scores: Vec<LockedScoreDto>,
    pub path: RoundPathDto,
    pub escape: Option<EscapeRecordDto>,
    pub bot_escape_decisions: Vec<BotEscapeDecisionDto>,
    pub bot_escapes: Vec<BotEscapeRecordDto>,
    pub touches: Vec<TouchDto>,
    pub result: RoundResultDto,
    pub reveal: RevealDto,
    pub replay_verification: Option<ReplayVerificationAckDto>,
    pub events: Vec<SignedRoundEventDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReportDto {
    pub valid: bool,
    pub round_id: String,
    pub verified_checks: Vec<String>,
    pub path_points: usize,
    pub signed_events: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDto {
    pub code: String,
    pub message: String,
    pub retry_after_ms: Option<u64>,
}
