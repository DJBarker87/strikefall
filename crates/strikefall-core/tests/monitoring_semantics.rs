use strikefall_core::{
    barrier_for_survival, first_touch, generate_battle_path, one_sided_no_touch, BarrierSide,
    DeckVersion, FlagPlacement, NoTouchInputs, OpeningRunwaySchedule, BALANCED_TAPE, SCALE,
};

const SAMPLES: u64 = 4_096;
const ACCEPTANCE: u128 = 35_000_000_000; // 3.5 percentage points.

fn verify_side(side: BarrierSide) {
    // Four conditional intervals exercise composition while keeping this
    // deterministic statistical gate fast in debug CI. The bridge identity is
    // invariant to the number of public partitions.
    let deck = DeckVersion {
        battle_steps: 8,
        step_ms: 7_500,
        opening_runway: Some(OpeningRunwaySchedule {
            steps: 1,
            variance_share_bps: 500,
        }),
        ..BALANCED_TAPE
    };
    let spot = 100 * SCALE;
    let target_survival = 550_000_000_000;
    let barrier = barrier_for_survival(
        spot,
        target_survival,
        deck.total_integrated_variance,
        deck.drift_per_variance,
        side,
    )
    .unwrap();
    let quote = one_sided_no_touch(NoTouchInputs {
        spot,
        barrier,
        remaining_variance: deck.total_integrated_variance,
        drift_per_variance: deck.drift_per_variance,
        side,
        already_breached: false,
    })
    .unwrap();
    let placement = FlagPlacement {
        contender_id: 1,
        side,
        barrier,
    };
    let survivors = (0..SAMPLES)
        .filter(|seed| {
            let path = generate_battle_path(&deck, *seed, spot).unwrap();
            first_touch(&path, placement).is_none()
        })
        .count() as u128;
    let observed = survivors * SCALE / u128::from(SAMPLES);
    let residual = observed.abs_diff(quote.survival_probability);
    assert!(
        residual <= ACCEPTANCE,
        "{side:?} bridge residual {residual} exceeds {ACCEPTANCE}; observed={observed}, quoted={}",
        quote.survival_probability,
    );
}

#[test]
fn bridge_extrema_track_the_continuous_quote_on_both_sides() {
    verify_side(BarrierSide::Upper);
    verify_side(BarrierSide::Lower);
}
