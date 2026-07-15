#!/usr/bin/env python3
"""Independent high-precision model campaigns for Strikefall.

The generator intentionally imports neither Strikefall nor SolMath.  It uses
mpmath for the disclosed first-passage identity and a small, specified
SplitMix64 generator for reproducible campaign inputs.

Run from the repository root:

    python3 tools/model-validation/reference.py --check
    python3 tools/model-validation/reference.py --check-corpora
    python3 tools/model-validation/reference.py --write-corpora
    python3 tools/model-validation/reference.py --bridge-samples 100000
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import tempfile
from collections.abc import Iterable, Iterator
from pathlib import Path

import mpmath as mp


ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "tools/model-validation"
CORPUS = MODEL_DIR / "no_touch_reference.csv"
PRODUCTION_CORPUS = MODEL_DIR / "no_touch_production.csv"
ADVERSARIAL_CORPUS = MODEL_DIR / "no_touch_adversarial.csv"
MANIFEST = MODEL_DIR / "model-corpus-manifest.json"
REQUIREMENTS = MODEL_DIR / "requirements.txt"
SCALE = 10**12
MP_DPS = 80
PRODUCTION_ROWS = 100_000
ADVERSARIAL_ROWS = 10_000
PRODUCTION_SEED = 0x535452494B454641
ADVERSARIAL_SEED = 0x4144564552534152
GENERATOR_VERSION = "strikefall-first-passage-corpora-v1"
PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED = 200_000
ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED = 1_000_000
CSV_HEADER = (
    "case_id",
    "category",
    "side",
    "spot",
    "barrier",
    "remaining_variance",
    "drift_per_variance",
    "already_breached",
    "survival_scaled",
)
DECK_WEIGHTS = (
    ("balanced_tape", (25, 25, 25, 25)),
    ("compression_break", (5, 10, 25, 60)),
    ("opening_rush", (55, 25, 15, 5)),
    ("pulse", (15, 35, 15, 35)),
)

mp.mp.dps = MP_DPS


CASES = (
    ("upper", "100", "101", "0.0001", "-0.5"),
    ("upper", "100", "105", "0.0016", "-0.5"),
    ("upper", "100", "110", "0.0064", "-0.5"),
    ("upper", "100", "120", "0.09", "-0.5"),
    ("upper", "100", "150", "0.04", "0"),
    ("upper", "100", "110", "0.0064", "0"),
    ("upper", "100", "110", "0.0064", "0.25"),
    ("upper", "100", "110", "0.0064", "1"),
    ("upper", "100", "125", "0.04", "-1"),
    ("upper", "37.5", "42", "0.0125", "0.375"),
    ("upper", "999.25", "1000", "0.00000025", "-0.5"),
    ("upper", "1", "4", "0.25", "-0.5"),
    ("lower", "100", "99", "0.0001", "-0.5"),
    ("lower", "100", "95", "0.0016", "-0.5"),
    ("lower", "100", "90", "0.0064", "-0.5"),
    ("lower", "100", "80", "0.09", "-0.5"),
    ("lower", "100", "50", "0.04", "0"),
    ("lower", "100", "90", "0.0064", "0"),
    ("lower", "100", "90", "0.0064", "0.25"),
    ("lower", "100", "90", "0.0064", "1"),
    ("lower", "100", "75", "0.04", "-1"),
    ("lower", "42", "37.5", "0.0125", "0.375"),
    ("lower", "1000", "999.25", "0.00000025", "-0.5"),
    ("lower", "4", "1", "0.25", "-0.5"),
)


class SplitMix64:
    """Fully specified 64-bit input generator (not game randomness)."""

    _MASK = (1 << 64) - 1

    def __init__(self, seed: int) -> None:
        self.state = seed & self._MASK

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & self._MASK
        value = self.state
        value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & self._MASK
        value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & self._MASK
        return (value ^ (value >> 31)) & self._MASK

    def below(self, bound: int) -> int:
        if bound <= 0:
            raise ValueError("bound must be positive")
        return self.next_u64() % bound


def normal_cdf(value: mp.mpf) -> mp.mpf:
    return (1 + mp.erf(value / mp.sqrt(2))) / 2


def quote(
    side: str,
    spot_text: str,
    barrier_text: str,
    variance_text: str,
    drift_text: str,
    already_breached: bool = False,
) -> mp.mpf:
    spot = mp.mpf(spot_text)
    barrier = mp.mpf(barrier_text)
    variance = mp.mpf(variance_text)
    drift = mp.mpf(drift_text)
    breached = already_breached or (
        (side == "upper" and spot >= barrier) or (side == "lower" and spot <= barrier)
    )
    if breached:
        return mp.mpf(0)
    if spot <= 0 or barrier <= 0 or variance < 0:
        raise ValueError("spot/barrier must be positive and variance non-negative")
    if variance == 0:
        return mp.mpf(1)
    if side == "upper":
        distance = mp.log(barrier / spot)
        effective_drift = drift
    elif side == "lower":
        distance = mp.log(spot / barrier)
        effective_drift = -drift
    else:
        raise ValueError(f"unknown side: {side}")
    root = mp.sqrt(variance)
    first = normal_cdf((distance - effective_drift * variance) / root)
    reflected = mp.exp(2 * effective_drift * distance) * normal_cdf(
        (-distance - effective_drift * variance) / root
    )
    return min(mp.mpf(1), max(mp.mpf(0), first - reflected))


def scaled(value: mp.mpf) -> int:
    return int(mp.floor(value * SCALE + mp.mpf("0.5")))


def fixed_text(value: int) -> str:
    negative = value < 0
    magnitude = abs(value)
    whole, fraction = divmod(magnitude, SCALE)
    if fraction:
        rendered = f"{whole}.{fraction:012d}".rstrip("0")
    else:
        rendered = str(whole)
    return f"-{rendered}" if negative else rendered


def round_mpf(value: mp.mpf) -> int:
    return int(mp.floor(value + mp.mpf("0.5")))


def barrier_at_distance(spot: int, distance: mp.mpf, side: str) -> int:
    exponent = distance if side == "upper" else -distance
    barrier = round_mpf(mp.mpf(spot) * mp.exp(exponent))
    if side == "upper":
        return max(spot + 1, barrier)
    return min(spot - 1, max(1, barrier))


def remaining_variance(weights: tuple[int, int, int, int], completed_steps: int) -> int:
    total_variance = 6_400_000_000
    if completed_steps == 240:
        return 0
    quarter_length = 60
    quarter, within = divmod(completed_steps, quarter_length)
    prefix_weight = sum(weights[:quarter])
    progress = prefix_weight * quarter_length + weights[quarter] * within
    denominator = sum(weights) * quarter_length
    elapsed = total_variance * progress // denominator
    return total_variance - elapsed


def reference_row(
    case_id: str,
    category: str,
    side: str,
    spot: int,
    barrier: int,
    variance: int,
    drift: int,
    already_breached: bool,
) -> tuple[str, ...]:
    spot_text = fixed_text(spot)
    barrier_text = fixed_text(barrier)
    variance_text = fixed_text(variance)
    drift_text = fixed_text(drift)
    expected = scaled(
        quote(
            side,
            spot_text,
            barrier_text,
            variance_text,
            drift_text,
            already_breached,
        )
    )
    return (
        case_id,
        category,
        side,
        spot_text,
        barrier_text,
        variance_text,
        drift_text,
        "true" if already_breached else "false",
        str(expected),
    )


def production_rows() -> Iterator[tuple[str, ...]]:
    rng = SplitMix64(PRODUCTION_SEED)
    for index in range(PRODUCTION_ROWS):
        deck_name, weights = DECK_WEIGHTS[rng.below(len(DECK_WEIGHTS))]
        completed = rng.below(241)
        variance = remaining_variance(weights, completed)
        spot = 50 * SCALE + rng.below(200 * SCALE + 1)
        side = "upper" if rng.below(2) == 0 else "lower"
        # Standard-deviation-relative distances cover the live placement band
        # and the later battle quote range without overfitting to fixed prices.
        q = mp.mpf(20_000_000 + rng.below(4_480_000_001)) / 1_000_000_000
        if variance == 0:
            distance = mp.mpf(1 + rng.below(650_000_000_000)) / SCALE
        else:
            distance = min(mp.mpf("0.65"), mp.sqrt(mp.mpf(variance) / SCALE) * q)
        barrier = barrier_at_distance(spot, distance, side)
        yield reference_row(
            f"production-{index:06d}",
            f"{deck_name}:step-{completed:03d}",
            side,
            spot,
            barrier,
            variance,
            -SCALE // 2,
            False,
        )


def _adversarial_case(index: int, rng: SplitMix64) -> tuple[str, str, int, int, int, int, bool]:
    category_index = index % 8
    side = "upper" if rng.below(2) == 0 else "lower"
    spot = SCALE + rng.below(999 * SCALE + 1)
    drift = int(rng.below(8 * SCALE + 1)) - 4 * SCALE

    if category_index == 0:
        category = "near_barrier"
        gap = 1 + rng.below(10_000_000)
        barrier = spot + gap if side == "upper" else max(1, spot - gap)
        variance = 1 + rng.below(10_000_000_000)
    elif category_index == 1:
        category = "low_variance"
        variance = (1, 2, 3, 10, 100, 1_000, 10_000, 1_000_000)[rng.below(8)]
        distance = mp.mpf(1 + rng.below(100_000_000)) / SCALE
        barrier = barrier_at_distance(spot, distance, side)
    elif category_index == 2:
        category = "drift_boundary"
        drift = (-4 * SCALE, -4 * SCALE + 1, 4 * SCALE - 1, 4 * SCALE)[rng.below(4)]
        variance = 1 + rng.below(200_000_000_000)
        distance = mp.mpf(100_000_000 + rng.below(499_900_000_001)) / SCALE
        barrier = barrier_at_distance(spot, distance, side)
    elif category_index == 3:
        category = "zero_variance_limit"
        variance = 0
        distance = mp.mpf(1 + rng.below(650_000_000_000)) / SCALE
        barrier = barrier_at_distance(spot, distance, side)
    elif category_index == 4:
        category = "breached_limit"
        variance = rng.below(200_000_000_001)
        already_breached = True
        offset = rng.below(10_000_001)
        barrier = max(1, spot - offset) if side == "upper" else spot + offset
        return category, side, spot, barrier, variance, drift, already_breached
    elif category_index == 5:
        category = "reflection_sign"
        variance = 1 + rng.below(200_000_000_000)
        distance = mp.mpf(1 + rng.below(650_000_000_000)) / SCALE
        barrier = barrier_at_distance(spot, distance, side)
    elif category_index == 6:
        category = "fixed_point_extreme"
        # Exercise sub-micro-unit prices while keeping log distance inside the
        # public solver's supported range; larger ratios are domain/overflow
        # fuzz cases rather than valid high-precision reference vectors.
        spot = 1_000_000 + rng.below(1_000_000_001)
        distance = mp.mpf(1_000_000_000 + rng.below(649_000_000_001)) / SCALE
        barrier = barrier_at_distance(spot, distance, side)
        variance = 1 + rng.below(500_000_000_000)
    else:
        category = "cdf_cancellation"
        variance = 1 + rng.below(20_000_000_000)
        root = mp.sqrt(mp.mpf(variance) / SCALE)
        multiplier = mp.mpf(1 + rng.below(2_000_000_000)) / 1_000_000_000
        barrier = barrier_at_distance(spot, root * multiplier, side)

    return category, side, spot, barrier, variance, drift, False


def adversarial_rows() -> Iterator[tuple[str, ...]]:
    rng = SplitMix64(ADVERSARIAL_SEED)
    for index in range(ADVERSARIAL_ROWS):
        category, side, spot, barrier, variance, drift, breached = _adversarial_case(index, rng)
        yield reference_row(
            f"adversarial-{index:05d}",
            category,
            side,
            spot,
            barrier,
            variance,
            drift,
            breached,
        )


def corpus_text() -> str:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(("side", "spot", "barrier", "remaining_variance", "drift_per_variance", "survival_scaled"))
    for case in CASES:
        writer.writerow((*case, scaled(quote(*case))))
    return output.getvalue()


def check_smoke_corpus() -> None:
    expected = corpus_text()
    actual = CORPUS.read_text(encoding="utf-8")
    if actual != expected:
        raise SystemExit(
            "reference smoke corpus is stale; inspect `python3 tools/model-validation/reference.py --emit-csv`"
        )
    print(f"high-precision smoke corpus OK: {len(CASES)} vectors at {mp.mp.dps} decimal digits")


def _write_csv(path: Path, rows: Iterable[tuple[str, ...]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(CSV_HEADER)
        writer.writerows(rows)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _file_record(
    path: Path, canonical_path: Path, rows: int, seed: int
) -> dict[str, object]:
    return {
        "path": canonical_path.relative_to(ROOT).as_posix(),
        "rows": rows,
        "seed_hex": f"0x{seed:016x}",
        "bytes": path.stat().st_size,
        "csv_sha256": _sha256(path),
    }


def _manifest_payload(production: Path, adversarial: Path) -> dict[str, object]:
    return {
        "schema": "strikefall/model-validation-manifest/v1",
        "generator_version": GENERATOR_VERSION,
        "generator_sha256": _sha256(Path(__file__)),
        "requirements_sha256": _sha256(REQUIREMENTS),
        "mpmath_decimal_digits": MP_DPS,
        "fixed_point_scale": str(SCALE),
        "rounding": "nearest_integer_half_up_at_public_scale",
        "formula": "continuous_one_sided_first_passage_constant_drift_variance_time",
        "max_absolute_error": {
            "production": {
                "scaled": PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED,
                "probability": fixed_text(PRODUCTION_MAX_ABSOLUTE_ERROR_SCALED),
            },
            "adversarial": {
                "scaled": ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED,
                "probability": fixed_text(ADVERSARIAL_MAX_ABSOLUTE_ERROR_SCALED),
            },
        },
        "corpora": {
            "production": _file_record(
                production, PRODUCTION_CORPUS, PRODUCTION_ROWS, PRODUCTION_SEED
            ),
            "adversarial": _file_record(
                adversarial, ADVERSARIAL_CORPUS, ADVERSARIAL_ROWS, ADVERSARIAL_SEED
            ),
        },
    }


def write_corpora() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="strikefall-model-", dir=MODEL_DIR) as temp_name:
        temp = Path(temp_name)
        production = temp / PRODUCTION_CORPUS.name
        adversarial = temp / ADVERSARIAL_CORPUS.name
        _write_csv(production, production_rows())
        _write_csv(adversarial, adversarial_rows())
        manifest = _manifest_payload(production, adversarial)
        manifest_path = temp / MANIFEST.name
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.replace(production, PRODUCTION_CORPUS)
        os.replace(adversarial, ADVERSARIAL_CORPUS)
        os.replace(manifest_path, MANIFEST)
    print(
        f"wrote {PRODUCTION_ROWS + ADVERSARIAL_ROWS} reference vectors "
        f"({PRODUCTION_ROWS} production, {ADVERSARIAL_ROWS} adversarial)"
    )


def check_corpora() -> None:
    if not MANIFEST.is_file() or not PRODUCTION_CORPUS.is_file() or not ADVERSARIAL_CORPUS.is_file():
        raise SystemExit("model corpora are missing; run with --write-corpora")
    committed = json.loads(MANIFEST.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="strikefall-model-check-") as temp_name:
        temp = Path(temp_name)
        production = temp / PRODUCTION_CORPUS.name
        adversarial = temp / ADVERSARIAL_CORPUS.name
        _write_csv(production, production_rows())
        _write_csv(adversarial, adversarial_rows())
        regenerated = _manifest_payload(production, adversarial)
    if committed != regenerated:
        raise SystemExit(
            "model corpus manifest is stale or regeneration changed; run with --write-corpora and review the diff"
        )
    for name, path in (("production", PRODUCTION_CORPUS), ("adversarial", ADVERSARIAL_CORPUS)):
        record = committed["corpora"][name]
        if path.stat().st_size != record["bytes"] or _sha256(path) != record["csv_sha256"]:
            raise SystemExit(f"{name} corpus does not match its manifest digest")
    print(
        f"reproducible corpora OK: {PRODUCTION_ROWS} production + {ADVERSARIAL_ROWS} adversarial "
        f"vectors at {MP_DPS} decimal digits"
    )
    print(
        f"production sha256={committed['corpora']['production']['csv_sha256']} "
        f"adversarial sha256={committed['corpora']['adversarial']['csv_sha256']}"
    )


def print_manifest_report() -> None:
    payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
    print(json.dumps(payload, sort_keys=True))


def bridge_campaign(samples: int) -> None:
    if samples < 10_000:
        raise SystemExit("bridge campaign requires at least 10,000 samples")
    # The bridge simulation intentionally uses Python's Mersenne Twister only
    # for statistical validation; corpus generation uses specified SplitMix64.
    import random

    scenarios = (
        ("balanced", mp.mpf("0.09531017980432486"), mp.mpf("0.0064"), mp.mpf("-0.5")),
        ("near", mp.mpf("0.03922071315328133"), mp.mpf("0.0016"), mp.mpf("0.25")),
        ("storm", mp.mpf("0.1823215567939546"), mp.mpf("0.09"), mp.mpf("-0.5")),
    )
    for index, (name, distance_mp, variance_mp, drift_mp) in enumerate(scenarios):
        distance = float(distance_mp)
        variance = float(variance_mp)
        drift = float(drift_mp)
        expected_hit = 1 - float(
            quote("upper", "1", str(mp.exp(distance_mp)), str(variance_mp), str(drift_mp))
        )
        rng = random.Random(0x535452494B454641 + index)
        endpoint_hits = 0
        bridge_hits = 0
        root = math.sqrt(variance)
        for _ in range(samples):
            endpoint = drift * variance + root * rng.gauss(0, 1)
            if endpoint >= distance:
                endpoint_hits += 1
                bridge_hits += 1
                continue
            conditional_cross = math.exp(-2 * distance * (distance - endpoint) / variance)
            if rng.random() < conditional_cross:
                bridge_hits += 1
        endpoint_rate = endpoint_hits / samples
        bridge_rate = bridge_hits / samples
        standard_error = math.sqrt(expected_hit * (1 - expected_hit) / samples)
        tolerance = max(0.0035, 6 * standard_error)
        if abs(bridge_rate - expected_hit) > tolerance:
            raise SystemExit(
                f"{name}: bridge={bridge_rate:.6f}, analytic={expected_hit:.6f}, tolerance={tolerance:.6f}"
            )
        if endpoint_rate >= bridge_rate:
            raise SystemExit(f"{name}: sampled endpoints did not undercount continuous crossings")
        print(
            f"bridge {name}: analytic={expected_hit:.6f} bridge={bridge_rate:.6f} "
            f"endpoint-only={endpoint_rate:.6f} samples={samples}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify the 24-vector smoke corpus")
    parser.add_argument("--check-corpora", action="store_true", help="regenerate and verify release corpora/digests")
    parser.add_argument("--write-corpora", action="store_true", help="atomically regenerate release corpora and manifest")
    parser.add_argument("--manifest-report", action="store_true", help="print the committed manifest as one-line JSON")
    parser.add_argument("--emit-csv", action="store_true", help="print the canonical smoke corpus to stdout")
    parser.add_argument("--bridge-samples", type=int, metavar="N", help="run an independent bridge Monte Carlo")
    args = parser.parse_args()
    if not any(
        (
            args.check,
            args.check_corpora,
            args.write_corpora,
            args.manifest_report,
            args.emit_csv,
            args.bridge_samples,
        )
    ):
        parser.error("choose a validation, generation, or report command")
    if args.emit_csv:
        print(corpus_text(), end="")
    if args.write_corpora:
        write_corpora()
    if args.check:
        check_smoke_corpus()
    if args.check_corpora:
        check_corpora()
    if args.manifest_report:
        print_manifest_report()
    if args.bridge_samples:
        bridge_campaign(args.bridge_samples)


if __name__ == "__main__":
    main()
