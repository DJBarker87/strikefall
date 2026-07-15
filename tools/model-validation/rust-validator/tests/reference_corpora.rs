use strikefall_model_validator::{
    validate_default_corpora, ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED, ADVERSARIAL_ROWS,
    PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED, PRODUCTION_ROWS,
};

#[test]
fn release_corpora_match_the_solmath_fixed_point_composition() {
    let [production, adversarial] = validate_default_corpora().unwrap();
    assert_eq!(production.rows, PRODUCTION_ROWS);
    assert_eq!(adversarial.rows, ADVERSARIAL_ROWS);
    assert!(production.max_absolute_error_scaled <= PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED);
    assert!(adversarial.max_absolute_error_scaled <= ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED);
}
