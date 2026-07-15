use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    DeckDto, LockedScoreDto, ProtocolError, RoundEventKindDto, RoundPathDto, SignedRoundEventDto,
    COMMITMENT_ALGORITHM, PROTOCOL_VERSION,
};

const ZERO_DIGEST: [u8; 32] = [0; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundSecrets {
    pub path_key: [u8; 32],
    pub path_seed: u64,
    pub bot_seed_root: [u8; 32],
    pub salt: [u8; 32],
}

/// SHA-256 with explicit domain and length framing between every input.
#[must_use]
pub fn hash_framed<'a>(domain: &[u8], parts: impl IntoIterator<Item = &'a [u8]>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

pub fn derive_round_secrets(
    master_secret: &[u8; 32],
    round_id: &str,
) -> Result<RoundSecrets, ProtocolError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SeedMessage<'a> {
        protocol_version: &'a str,
        domain: &'a str,
        master_seed: String,
        round_id: &'a str,
    }

    let master_seed = hex::encode(master_secret);
    let derive = |domain| {
        canonical_digest(&SeedMessage {
            protocol_version: PROTOCOL_VERSION,
            domain,
            master_seed: master_seed.clone(),
            round_id,
        })
    };
    let path_key = derive("strikefall/path")?;
    let bot_seed_root = derive("strikefall/bots")?;
    let salt = hash_framed(
        b"strikefall/commit",
        [master_secret.as_slice(), round_id.as_bytes()],
    );
    let mut seed_bytes = [0_u8; 8];
    seed_bytes.copy_from_slice(&path_key[..8]);
    Ok(RoundSecrets {
        path_key,
        path_seed: u64::from_be_bytes(seed_bytes),
        bot_seed_root,
        salt,
    })
}

fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    // `serde_json::Map` is key-sorted unless its optional `preserve_order`
    // feature is enabled. This workspace deliberately leaves that feature off,
    // matching the browser's recursive key-sorted canonical JSON encoder.
    let value = serde_json::to_value(value)?;
    Ok(serde_json::to_vec(&value)?)
}

fn canonical_digest<T: Serialize>(value: &T) -> Result<[u8; 32], ProtocolError> {
    let bytes = canonical_bytes(value)?;
    Ok(Sha256::digest(bytes).into())
}

pub fn deck_digest(deck: &DeckDto) -> Result<[u8; 32], ProtocolError> {
    #[derive(Serialize)]
    struct Payload<'a> {
        domain: &'static str,
        deck: &'a DeckDto,
    }
    canonical_digest(&Payload {
        domain: "strikefall/deck/v1",
        deck,
    })
}

pub fn path_digest(path: &RoundPathDto) -> Result<[u8; 32], ProtocolError> {
    #[derive(Serialize)]
    struct Payload<'a> {
        domain: &'static str,
        path: &'a RoundPathDto,
    }
    canonical_digest(&Payload {
        domain: "strikefall/path/v1",
        path,
    })
}

pub fn locked_scores_digest(scores: &[LockedScoreDto]) -> Result<[u8; 32], ProtocolError> {
    let bytes = serde_json::to_vec(scores)?;
    Ok(hash_framed(
        b"strikefall/locked-scores/v1",
        [bytes.as_slice()],
    ))
}

pub fn commitment_digest(
    protocol_version: &str,
    round_id: &str,
    deck_digest: &[u8; 32],
    path_digest: &[u8; 32],
    bot_seed_root: &[u8; 32],
    salt: &[u8; 32],
) -> Result<[u8; 32], ProtocolError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CommitmentPayload<'a> {
        protocol_version: &'a str,
        algorithm: &'static str,
        round_id: &'a str,
        deck_digest: String,
        path_digest: String,
        bot_root_digest: String,
        salt: String,
    }
    let bot_root_digest = canonical_digest(&serde_json::json!({
        "botSeed": hex::encode(bot_seed_root),
        "domain": "strikefall/ranked-bot-root/v2",
        "profile": "ranked-fixed-v2"
    }))?;
    canonical_digest(&CommitmentPayload {
        protocol_version,
        algorithm: COMMITMENT_ALGORITHM,
        round_id,
        deck_digest: hex::encode(deck_digest),
        path_digest: hex::encode(path_digest),
        bot_root_digest: hex::encode(bot_root_digest),
        salt: hex::encode(salt),
    })
}

pub fn event_digest(
    previous_digest: &str,
    sequence: u64,
    server_time_ms: u64,
    kind: &RoundEventKindDto,
) -> Result<[u8; 32], ProtocolError> {
    let previous = if sequence == 0 {
        ZERO_DIGEST
    } else {
        decode_array::<32>(previous_digest, "previousDigest")?
    };
    let payload = serde_json::to_vec(kind)?;
    Ok(hash_framed(
        b"strikefall/ranked-event/v2",
        [
            previous.as_slice(),
            sequence.to_be_bytes().as_slice(),
            server_time_ms.to_be_bytes().as_slice(),
            payload.as_slice(),
        ],
    ))
}

pub fn result_proof_digest<T: Serialize>(
    deck_digest: &[u8; 32],
    path_digest: &[u8; 32],
    placements: &T,
    locked_scores: &[LockedScoreDto],
    resolution: &impl Serialize,
) -> Result<[u8; 32], ProtocolError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ResultPayload<'a, T, U> {
        domain: &'static str,
        deck_digest: String,
        path_digest: String,
        placements: &'a T,
        locked_scores: &'a [LockedScoreDto],
        resolution: &'a U,
    }
    canonical_digest(&ResultPayload {
        domain: "strikefall/result/v1",
        deck_digest: hex::encode(deck_digest),
        path_digest: hex::encode(path_digest),
        placements,
        locked_scores,
        resolution,
    })
}

pub fn verify_event_log(
    events: &[SignedRoundEventDto],
    verifying_key_hex: &str,
) -> Result<(), ProtocolError> {
    let key_bytes = decode_array::<32>(verifying_key_hex, "serverVerifyingKey")?;
    let verifying_key =
        VerifyingKey::from_bytes(&key_bytes).map_err(|_| ProtocolError::InvalidSignature)?;
    let mut expected_previous = hex::encode(ZERO_DIGEST);
    for (index, event) in events.iter().enumerate() {
        let expected_sequence =
            u64::try_from(index).map_err(|_| ProtocolError::Mismatch("event sequence overflow"))?;
        if event.sequence != expected_sequence || event.previous_digest != expected_previous {
            return Err(ProtocolError::Mismatch("event ordering or hash link"));
        }
        let digest = event_digest(
            &event.previous_digest,
            event.sequence,
            event.server_time_ms,
            &event.kind,
        )?;
        if event.digest != hex::encode(digest) {
            return Err(ProtocolError::Mismatch("event digest"));
        }
        let signature_bytes = decode_array::<64>(&event.signature, "event.signature")?;
        let signature = Signature::from_bytes(&signature_bytes);
        verifying_key
            .verify(&digest, &signature)
            .map_err(|_| ProtocolError::InvalidSignature)?;
        expected_previous.clone_from(&event.digest);
    }
    Ok(())
}

pub(crate) fn decode_array<const N: usize>(
    encoded: &str,
    field: &'static str,
) -> Result<[u8; N], ProtocolError> {
    let bytes = hex::decode(encoded).map_err(|_| ProtocolError::InvalidHex(field))?;
    bytes
        .try_into()
        .map_err(|_| ProtocolError::InvalidHex(field))
}
