use alloc::vec::Vec;

use crate::{BarrierSide, FlagPlacement, PathPoint};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct TouchEvent {
    pub contender_id: u16,
    pub step: u16,
    pub side: BarrierSide,
    pub barrier: u128,
    pub line_value: u128,
}

fn point_touches(point: &PathPoint, barrier: u128, side: BarrierSide) -> bool {
    match side {
        BarrierSide::Upper => point.interval_high >= barrier,
        BarrierSide::Lower => point.interval_low <= barrier,
    }
}

/// Finds the first public interval whose retained Brownian-bridge extremum
/// reaches the flag. This is continuous one-sided monitoring at 250 ms frame
/// granularity without emitting internal events.
#[must_use]
pub fn first_touch(path: &[PathPoint], placement: FlagPlacement) -> Option<TouchEvent> {
    path.iter()
        .find(|point| point_touches(point, placement.barrier, placement.side))
        .map(|point| TouchEvent {
            contender_id: placement.contender_id,
            step: point.step,
            side: placement.side,
            barrier: placement.barrier,
            line_value: match placement.side {
                BarrierSide::Upper => point.interval_high,
                BarrierSide::Lower => point.interval_low,
            },
        })
}

/// Resolves a cluster in deterministic `(step, contender_id)` order so the UI
/// can render a readable cascade instead of one unordered explosion blob.
#[must_use]
pub fn resolve_touches(path: &[PathPoint], placements: &[FlagPlacement]) -> Vec<TouchEvent> {
    let mut events: Vec<_> = placements
        .iter()
        .filter_map(|placement| first_touch(path, *placement))
        .collect();
    events.sort_unstable_by_key(|event| (event.step, event.contender_id));
    events
}

/// Minimum unsigned price distance observed before a touch (or over the whole
/// path for a survivor), useful for near-miss result cards.
#[must_use]
pub fn closest_approach(path: &[PathPoint], placement: FlagPlacement) -> Option<u128> {
    path.iter()
        .map(|point| match placement.side {
            BarrierSide::Upper => placement.barrier.saturating_sub(point.interval_high),
            BarrierSide::Lower => point.interval_low.saturating_sub(placement.barrier),
        })
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(step: u16, price: u128) -> PathPoint {
        PathPoint {
            step,
            variance_elapsed: u128::from(step),
            log_return: 0,
            price,
            interval_high: price,
            interval_low: price,
        }
    }

    #[test]
    fn cluster_events_have_stable_cascade_order() {
        let path = [point(0, 100), point(1, 103), point(2, 107)];
        let flags = [
            FlagPlacement {
                contender_id: 7,
                side: BarrierSide::Upper,
                barrier: 102,
            },
            FlagPlacement {
                contender_id: 3,
                side: BarrierSide::Upper,
                barrier: 102,
            },
            FlagPlacement {
                contender_id: 1,
                side: BarrierSide::Upper,
                barrier: 106,
            },
        ];
        let events = resolve_touches(&path, &flags);
        assert_eq!(
            events
                .iter()
                .map(|event| event.contender_id)
                .collect::<Vec<_>>(),
            [3, 7, 1]
        );
    }

    #[test]
    fn retained_wick_detects_a_touch_hidden_between_endpoints() {
        let path = [
            point(0, 100),
            PathPoint {
                step: 1,
                variance_elapsed: 1,
                log_return: 0,
                price: 101,
                interval_high: 107,
                interval_low: 96,
            },
        ];
        let upper = FlagPlacement {
            contender_id: 1,
            side: BarrierSide::Upper,
            barrier: 105,
        };
        let lower = FlagPlacement {
            contender_id: 2,
            side: BarrierSide::Lower,
            barrier: 98,
        };
        assert_eq!(first_touch(&path, upper).unwrap().line_value, 107);
        assert_eq!(first_touch(&path, lower).unwrap().line_value, 96);
        assert_eq!(closest_approach(&path, upper), Some(0));
        assert_eq!(closest_approach(&path, lower), Some(0));
    }
}
