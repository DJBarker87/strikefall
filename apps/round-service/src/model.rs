use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use strikefall_protocol::{
    BotEscapeDecisionDto, BotEscapeRecordDto, BotPlacementDecisionDto, ContenderPlacementDto,
    EscapeRecordDto, LockedScoreDto, ReplayBundleDto, ReplayVerificationAckDto, RevealDto,
    RoundPathDto, RoundResultDto, RoundStatusDto, SignedRoundEventDto, TouchDto,
};

/// Complete authoritative state for one ranked round.
///
/// The Postgres adapter stores this value as one JSONB document while keeping
/// lifecycle and revision columns beside it for indexed scheduling and
/// optimistic updates. Keeping the canonical document whole makes a repository
/// load indistinguishable from the in-memory implementation and prevents proof
/// material from being partially persisted.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RoundRecord {
    pub id: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    pub revision: u64,
    pub session_id: Option<String>,
    #[serde(default)]
    pub experiment_assignments: BTreeMap<String, String>,
    pub deck_id: String,
    pub deck_version: u16,
    pub initial_spot: u128,
    pub path_seed: u64,
    pub bot_seed_root: [u8; 32],
    pub salt: [u8; 32],
    pub deck_digest: [u8; 32],
    pub path_digest: [u8; 32],
    pub commitment: [u8; 32],
    pub server_verifying_key: String,
    pub status: RoundStatusDto,
    pub created_at_ms: u64,
    pub placement_deadline_ms: u64,
    pub input_freeze_at_ms: u64,
    pub battle_started_at_ms: Option<u64>,
    pub battle_next_step: u16,
    pub last_flag_update_ms: Option<u64>,
    pub last_client_sequence: Option<u64>,
    /// Stable lobby state used to reconstruct exactly what was visible at each
    /// timed bot decision after a crash or delayed worker pass.
    pub initial_bots: Vec<ContenderPlacementDto>,
    pub bots: Vec<ContenderPlacementDto>,
    pub bot_placement_next_index: usize,
    pub next_bot_placement_at_ms: Option<u64>,
    pub bot_placement_decisions: Vec<BotPlacementDecisionDto>,
    pub placements: Vec<ContenderPlacementDto>,
    pub locked_scores: Vec<LockedScoreDto>,
    pub path: RoundPathDto,
    pub escape: Option<EscapeRecordDto>,
    pub bot_escape_decisions: Vec<BotEscapeDecisionDto>,
    pub bot_escapes: Vec<BotEscapeRecordDto>,
    pub touches: Vec<TouchDto>,
    pub result: Option<RoundResultDto>,
    pub replay_verification: Option<ReplayVerificationAckDto>,
    pub events: Vec<SignedRoundEventDto>,
}

impl RoundRecord {
    #[must_use]
    pub fn reveal(&self) -> RevealDto {
        RevealDto {
            path_seed: self.path_seed.to_string(),
            bot_seed_root: hex::encode(self.bot_seed_root),
            salt: hex::encode(self.salt),
            deck_digest: hex::encode(self.deck_digest),
            path_digest: hex::encode(self.path_digest),
        }
    }

    #[must_use]
    pub fn replay_bundle(&self) -> Option<ReplayBundleDto> {
        if self.protocol_version != strikefall_protocol::PROTOCOL_VERSION {
            return None;
        }
        Some(ReplayBundleDto {
            protocol_version: self.protocol_version.clone(),
            round_id: self.id.clone(),
            deck: strikefall_protocol::deck_to_dto(strikefall_core::deck_by_ref(
                &self.deck_id,
                self.deck_version,
            )?),
            initial_spot: self.initial_spot.to_string(),
            commitment: hex::encode(self.commitment),
            server_verifying_key: self.server_verifying_key.clone(),
            experiment_assignments: self.experiment_assignments.clone(),
            bots: self.bots.clone(),
            bot_placement_decisions: self.bot_placement_decisions.clone(),
            placements: self.placements.clone(),
            locked_scores: self.locked_scores.clone(),
            path: self.path.clone(),
            escape: self.escape.clone(),
            bot_escape_decisions: self.bot_escape_decisions.clone(),
            bot_escapes: self.bot_escapes.clone(),
            touches: self.touches.clone(),
            result: self.result.clone()?,
            reveal: self.reveal(),
            replay_verification: self.replay_verification.clone(),
            events: self.events.clone(),
        })
    }
}

fn default_protocol_version() -> String {
    strikefall_protocol::PROTOCOL_VERSION.to_owned()
}
