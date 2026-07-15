use std::collections::BTreeMap;

use crate::ProtocolError;

pub const DECK_STRUCTURE_EXPERIMENT: &str = "deck-structure:v2";
pub const ESCAPE_EXPERIMENT: &str = "escape:v2";
pub const RISK_DISPLAY_EXPERIMENT: &str = "risk-display:v2";

/// Validates the immutable treatment map carried by a ranked round.
///
/// Escape and risk display apply to every round. Deck structure is optional:
/// public Quick Run rotates all four decks without a cohort, an explicitly
/// configured closed alpha may assign it, and named challenge decks omit it.
pub fn validate_experiment_assignments(
    assignments: &BTreeMap<String, String>,
) -> Result<(), ProtocolError> {
    if assignments.len() < 2
        || assignments.len() > 3
        || !assignments.contains_key(ESCAPE_EXPERIMENT)
        || !assignments.contains_key(RISK_DISPLAY_EXPERIMENT)
    {
        return Err(ProtocolError::Mismatch("experiment assignment set"));
    }
    for (key, variant) in assignments {
        let valid = match key.as_str() {
            DECK_STRUCTURE_EXPERIMENT => matches!(variant.as_str(), "flat" | "compression-break"),
            ESCAPE_EXPERIMENT => matches!(variant.as_str(), "absent" | "midpoint"),
            RISK_DISPLAY_EXPERIMENT => {
                matches!(variant.as_str(), "probability" | "danger-band")
            }
            _ => false,
        };
        if !valid {
            return Err(ProtocolError::Mismatch("experiment assignment variant"));
        }
    }
    Ok(())
}

pub fn escape_enabled(assignments: &BTreeMap<String, String>) -> Result<bool, ProtocolError> {
    validate_experiment_assignments(assignments)?;
    Ok(assignments
        .get(ESCAPE_EXPERIMENT)
        .is_some_and(|variant| variant == "midpoint"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assignments() -> BTreeMap<String, String> {
        BTreeMap::from([
            (DECK_STRUCTURE_EXPERIMENT.to_owned(), "flat".to_owned()),
            (ESCAPE_EXPERIMENT.to_owned(), "midpoint".to_owned()),
            (RISK_DISPLAY_EXPERIMENT.to_owned(), "danger-band".to_owned()),
        ])
    }

    #[test]
    fn accepts_mandatory_public_and_optional_alpha_treatments() {
        assert!(validate_experiment_assignments(&assignments()).is_ok());
        let mut public = assignments();
        public.remove(DECK_STRUCTURE_EXPERIMENT);
        assert!(validate_experiment_assignments(&public).is_ok());
        assert!(escape_enabled(&public).expect("public assignments"));
        let mut bogus = assignments();
        bogus.insert("impact_fx_v1".to_owned(), "enhanced".to_owned());
        assert!(validate_experiment_assignments(&bogus).is_err());
        let mut wrong_version = assignments();
        wrong_version.remove(ESCAPE_EXPERIMENT);
        wrong_version.insert("escape:v1".to_owned(), "midpoint".to_owned());
        assert!(validate_experiment_assignments(&wrong_version).is_err());
    }
}
