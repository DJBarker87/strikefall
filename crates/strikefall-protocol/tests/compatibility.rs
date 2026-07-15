use strikefall_protocol::{
    commitment_digest, derive_round_secrets, COMMITMENT_ALGORITHM, PROTOCOL_VERSION,
};

#[test]
fn ranked_commitment_has_a_stable_explicit_schema_fixture() {
    assert_eq!(PROTOCOL_VERSION, "strikefall/ranked-replay/v3");
    assert_eq!(COMMITMENT_ALGORITHM, "SHA-256");
    // Repeating bytes are protocol-field sentinels for this hash vector; they
    // are not the launch decks' calibration digests.
    let digest = commitment_digest(
        PROTOCOL_VERSION,
        "round-fixture-001",
        &[0x11; 32],
        &[0x22; 32],
        &[0x33; 32],
        &[0x44; 32],
    )
    .expect("canonical commitment");
    // Stable key-sorted canonical JSON fixture for the ranked-only schema.
    assert_eq!(
        hex::encode(digest),
        "17fd3f9247a649664a216d628d8542a8e5365481b75806d91974ea07e7e7f50d"
    );
}

#[test]
fn path_bot_and_commit_material_are_domain_isolated() {
    let first = derive_round_secrets(&[9_u8; 32], "round-a").expect("derive secrets");
    let replayed = derive_round_secrets(&[9_u8; 32], "round-a").expect("derive secrets");
    let other_round = derive_round_secrets(&[9_u8; 32], "round-b").expect("derive secrets");
    assert_eq!(first, replayed);
    assert_ne!(first.path_key, first.bot_seed_root);
    assert_ne!(first.path_key, first.salt);
    assert_ne!(first.bot_seed_root, first.salt);
    assert_ne!(first.path_key, other_round.path_key);
}
