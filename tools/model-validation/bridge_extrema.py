#!/usr/bin/env python3
"""Independent acceptance test for Strikefall bridge-extrema monitoring.

The runtime retains one exact conditional upper maximum and lower minimum per
public frame. Their marginals reproduce continuous one-sided first passage;
they intentionally use independent uniforms, so this script does not validate
the joint probability of hitting both sides in the same interval.
"""

from __future__ import annotations

import argparse
import math
import random
from dataclasses import dataclass


ABSOLUTE_ACCEPTANCE = 0.0075  # 0.75 percentage points at the default sample count.


@dataclass(frozen=True)
class Scenario:
    name: str
    log_distance: float
    variance: float
    drift: float


SCENARIOS = (
    Scenario("launch-balanced", math.log(1.10), 0.0064, -0.5),
    Scenario("near-neutral", math.log(1.04), 0.0016, 0.25),
    Scenario("high-variance", math.log(1.20), 0.09, -0.5),
)


def normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def continuous_survival(distance: float, variance: float, drift: float) -> float:
    root = math.sqrt(variance)
    first = normal_cdf((distance - drift * variance) / root)
    reflected = math.exp(2.0 * drift * distance) * normal_cdf(
        (-distance - drift * variance) / root
    )
    return max(0.0, min(1.0, first - reflected))


def bridge_extreme(opening: float, closing: float, variance: float, uniform: float, upper: bool) -> float:
    root = math.sqrt((opening - closing) ** 2 - 2.0 * variance * math.log(uniform))
    return (opening + closing + (root if upper else -root)) / 2.0


def campaign(samples: int) -> None:
    if samples < 100_000:
        raise SystemExit("bridge-extrema campaign requires at least 100,000 samples")
    largest_residual = 0.0
    for scenario_index, scenario in enumerate(SCENARIOS):
        for side_index, side in enumerate(("upper", "lower")):
            # Reflecting X -> -X converts lower monitoring to an upper problem.
            effective_drift = scenario.drift if side == "upper" else -scenario.drift
            expected_hit = 1.0 - continuous_survival(
                scenario.log_distance,
                scenario.variance,
                effective_drift,
            )
            rng = random.Random(0x535452494B454641 + 17 * scenario_index + side_index)
            bridge_hits = 0
            endpoint_hits = 0
            root = math.sqrt(scenario.variance)
            for _ in range(samples):
                endpoint = effective_drift * scenario.variance + root * rng.gauss(0.0, 1.0)
                if endpoint >= scenario.log_distance:
                    endpoint_hits += 1
                maximum = bridge_extreme(
                    0.0,
                    endpoint,
                    scenario.variance,
                    max(math.ulp(1.0), rng.random()),
                    True,
                )
                if maximum >= scenario.log_distance:
                    bridge_hits += 1
            bridge_rate = bridge_hits / samples
            endpoint_rate = endpoint_hits / samples
            residual = abs(bridge_rate - expected_hit)
            largest_residual = max(largest_residual, residual)
            if residual > ABSOLUTE_ACCEPTANCE:
                raise SystemExit(
                    f"{scenario.name}/{side}: residual={residual:.6f} exceeds "
                    f"{ABSOLUTE_ACCEPTANCE:.6f}"
                )
            if endpoint_rate >= bridge_rate:
                raise SystemExit(f"{scenario.name}/{side}: endpoints did not undercount crossings")
            print(
                f"{scenario.name}/{side}: analytic={expected_hit:.6f} "
                f"bridge-extrema={bridge_rate:.6f} endpoint-only={endpoint_rate:.6f} "
                f"residual={residual:.6f} samples={samples}"
            )
    print(
        f"acceptance OK: maximum absolute one-sided residual={largest_residual:.6f} "
        f"<= {ABSOLUTE_ACCEPTANCE:.6f}; joint upper/lower dependence not claimed"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=100_000)
    args = parser.parse_args()
    campaign(args.samples)


if __name__ == "__main__":
    main()
