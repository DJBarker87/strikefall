"""Pure-stdlib, deterministic Strikefall deck calibration and validation.

This module deliberately treats historical/local returns as disposable input.
Only four normalized realized-variance phase weights and aggregate provenance
leave the derivation boundary. It never exports source rows, return values,
prices, source ordering, or observation labels.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, localcontext
from pathlib import Path
from statistics import NormalDist, median, pstdev
from typing import Any, Iterable, Mapping, Sequence


TOOL_VERSION = "1.0.0"
PHASE_COUNT = 4
WEIGHT_SCALE = 1_000_000
FIXED_SCALE = 1_000_000_000_000
U128_MAX = (1 << 128) - 1
I128_MIN = -(1 << 127)
I128_MAX = (1 << 127) - 1
DEFAULT_SIMULATION_ROUNDS = 512
CATALOG_SCHEMA = "strikefall/deck-catalog/v1"
CALIBRATION_SCHEMA = "strikefall/deck-calibration/v1"
SOURCE_SCHEMA = "strikefall/calibration-source/v1"
TEMPLATE_SCHEMA = "strikefall/deck-template/v1"

_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_FORBIDDEN_EXPORT_KEYS = {
    "timestamp",
    "timestamps",
    "observed_at",
    "price",
    "prices",
    "direction",
    "directions",
    "return",
    "returns",
    "raw_return",
    "raw_returns",
    "raw_row",
    "raw_rows",
    "source_path",
    "input_path",
}


class CalibratorError(ValueError):
    """Raised when calibration input or a deck artifact is invalid."""


@dataclass(frozen=True)
class SourceInput:
    """One local CSV paired with its separately reviewed source manifest."""

    csv_path: Path
    manifest_path: Path


@dataclass(frozen=True)
class WindowShape:
    """A disposable in-memory normalized phase shape."""

    source_id: str
    weights: tuple[int, int, int, int]


def canonical_json(value: Any) -> str:
    """Return the byte-for-byte canonical representation used by digests."""

    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def pretty_json(value: Any) -> str:
    """Return deterministic human-readable JSON with a trailing newline."""

    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        indent=2,
        sort_keys=True,
    ) + "\n"


def digest_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CalibratorError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise CalibratorError(f"JSON root must be an object: {path}")
    return value


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CalibratorError(f"{label} must be an object")
    return value


def _expect_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CalibratorError(f"{label} must be a non-empty string")
    return value.strip()


def _expect_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CalibratorError(f"{label} must be an integer >= {minimum}")
    return value


def _fixed_int(value: Any, label: str, *, signed: bool = False) -> int:
    if not isinstance(value, str):
        raise CalibratorError(f"{label} must be a decimal string")
    pattern = r"-?[0-9]+" if signed else r"[0-9]+"
    if re.fullmatch(pattern, value) is None:
        raise CalibratorError(f"{label} must be a canonical decimal string")
    if value.startswith("-0") or (value.startswith("0") and value != "0"):
        raise CalibratorError(f"{label} must not contain leading zeroes")
    return int(value)


def _validate_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    if manifest.get("schema") != SOURCE_SCHEMA:
        raise CalibratorError(f"source manifest schema must be {SOURCE_SCHEMA}")
    source_id = _expect_string(manifest.get("source_id"), "source_id")
    if _ID_RE.fullmatch(source_id) is None:
        raise CalibratorError("source_id must be a lower snake-case identifier")
    source_kind = _expect_string(manifest.get("source_kind"), "source_kind")
    if source_kind not in {"licensed_market_data", "synthetic", "project_authored"}:
        raise CalibratorError("source_kind is not an allowed offline source type")
    if manifest.get("local_only") is not True:
        raise CalibratorError("source manifest must assert local_only: true")
    return_kind = _expect_string(manifest.get("return_kind"), "return_kind")
    if return_kind != "log_return":
        raise CalibratorError("v1 accepts only log_return inputs")
    return_column = _expect_string(manifest.get("return_column"), "return_column")
    sampling_interval = _expect_string(
        manifest.get("sampling_interval"), "sampling_interval"
    )
    description = _expect_string(manifest.get("description"), "description")
    license_info = _expect_object(manifest.get("license"), "license")
    identifier = _expect_string(license_info.get("identifier"), "license.identifier")
    name = _expect_string(license_info.get("name"), "license.name")
    reference = _expect_string(license_info.get("reference"), "license.reference")
    if license_info.get("terms_confirmed") is not True:
        raise CalibratorError(
            "license.terms_confirmed must be true after a human licence review"
        )
    return {
        "source_id": source_id,
        "source_kind": source_kind,
        "description": description,
        "sampling_interval": sampling_interval,
        "return_kind": return_kind,
        "return_column": return_column,
        "license": {
            "identifier": identifier,
            "name": name,
            "reference": reference,
            "terms_confirmed": True,
        },
    }


def _read_returns(path: Path, column: str) -> list[Decimal]:
    if str(path).startswith(("http://", "https://")):
        raise CalibratorError("network sources are forbidden; provide a local CSV")
    if not path.is_file():
        raise CalibratorError(f"local CSV does not exist: {path}")
    values: list[Decimal] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None or column not in reader.fieldnames:
                raise CalibratorError(f"CSV is missing configured column {column!r}")
            for row_number, row in enumerate(reader, start=2):
                raw = row.get(column)
                if raw is None or not raw.strip():
                    raise CalibratorError(f"missing return at CSV row {row_number}")
                try:
                    value = Decimal(raw.strip())
                except InvalidOperation as error:
                    raise CalibratorError(
                        f"invalid decimal return at CSV row {row_number}"
                    ) from error
                if not value.is_finite():
                    raise CalibratorError(
                        f"non-finite return at CSV row {row_number}"
                    )
                if abs(value) > Decimal("2"):
                    raise CalibratorError(
                        f"implausible absolute log return > 2 at CSV row {row_number}"
                    )
                values.append(value)
    except OSError as error:
        raise CalibratorError(f"cannot read local CSV {path}: {error}") from error
    if not values:
        raise CalibratorError("CSV contains no return observations")
    return values


def _normalized_weights(phase_variance: Sequence[Decimal]) -> tuple[int, int, int, int]:
    if len(phase_variance) != PHASE_COUNT:
        raise CalibratorError("exactly four phase variances are required")
    total = sum(phase_variance, Decimal(0))
    if total <= 0 or any(value <= 0 for value in phase_variance):
        raise CalibratorError("every phase must contain positive realized variance")
    with localcontext() as context:
        context.prec = 80
        exact = [value * WEIGHT_SCALE / total for value in phase_variance]
        floors = [int(value.to_integral_value(rounding=ROUND_FLOOR)) for value in exact]
    remainder = WEIGHT_SCALE - sum(floors)
    order = sorted(
        range(PHASE_COUNT),
        key=lambda index: (-(exact[index] - floors[index]), index),
    )
    for index in order[:remainder]:
        floors[index] += 1
    result = tuple(floors)
    if len(result) != PHASE_COUNT or any(value <= 0 for value in result):
        raise CalibratorError("normalization produced a zero phase weight")
    if sum(result) != WEIGHT_SCALE:
        raise AssertionError("normalized phase weights must conserve the scale")
    return result  # type: ignore[return-value]


def bucket_realized_variance(
    returns: Sequence[Decimal],
    *,
    source_id: str,
    window_size: int,
    stride: int,
) -> list[WindowShape]:
    """Segment returns and retain only normalized four-phase variance shapes."""

    if window_size < PHASE_COUNT or window_size % PHASE_COUNT != 0:
        raise CalibratorError("window_size must be positive and divisible by four")
    if stride < 1:
        raise CalibratorError("stride must be >= 1")
    if len(returns) < window_size:
        raise CalibratorError(
            f"source {source_id!r} has fewer rows than the requested window"
        )
    phase_size = window_size // PHASE_COUNT
    shapes: list[WindowShape] = []
    for start in range(0, len(returns) - window_size + 1, stride):
        window = returns[start : start + window_size]
        phase_variance = []
        for phase in range(PHASE_COUNT):
            values = window[phase * phase_size : (phase + 1) * phase_size]
            phase_variance.append(sum((value * value for value in values), Decimal(0)))
        try:
            weights = _normalized_weights(phase_variance)
        except CalibratorError:
            # A fully flat phase has no usable temporal shape. Dropping it is
            # explicit and deterministic; row contents still never leave RAM.
            continue
        shapes.append(WindowShape(source_id=source_id, weights=weights))
    if not shapes:
        raise CalibratorError(f"source {source_id!r} yielded no usable windows")
    return shapes


def _squared_distance(left: Sequence[int], right: Sequence[int]) -> int:
    return sum((a - b) * (a - b) for a, b in zip(left, right, strict=True))


def _initial_medoids(
    unique_shapes: Sequence[tuple[int, int, int, int]], clusters: int
) -> list[tuple[int, int, int, int]]:
    balanced = (WEIGHT_SCALE // 4,) * PHASE_COUNT
    first = min(unique_shapes, key=lambda item: (_squared_distance(item, balanced), item))
    medoids = [first]
    while len(medoids) < clusters:
        candidates = [shape for shape in unique_shapes if shape not in medoids]
        selected = min(
            candidates,
            key=lambda shape: (
                -min(_squared_distance(shape, medoid) for medoid in medoids),
                shape,
            ),
        )
        medoids.append(selected)
    return medoids


def cluster_shapes(
    shapes: Sequence[WindowShape], clusters: int
) -> list[dict[str, Any]]:
    """Deterministic k-medoids over integer phase weights."""

    if clusters < 1:
        raise CalibratorError("clusters must be >= 1")
    points = [shape.weights for shape in shapes]
    unique_shapes = sorted(set(points))
    if clusters > len(unique_shapes):
        raise CalibratorError(
            f"requested {clusters} clusters from only {len(unique_shapes)} unique shapes"
        )
    medoids = _initial_medoids(unique_shapes, clusters)
    assignments: list[int] = []
    for _ in range(100):
        assignments = [
            min(
                range(clusters),
                key=lambda index: (_squared_distance(point, medoids[index]), index),
            )
            for point in points
        ]
        next_medoids = []
        for cluster_index in range(clusters):
            members = [
                point
                for point, assignment in zip(points, assignments, strict=True)
                if assignment == cluster_index
            ]
            if not members:
                raise AssertionError("a medoid cluster unexpectedly became empty")
            candidates = sorted(set(members))
            next_medoids.append(
                min(
                    candidates,
                    key=lambda candidate: (
                        sum(_squared_distance(candidate, member) for member in members),
                        candidate,
                    ),
                )
            )
        if next_medoids == medoids:
            break
        medoids = next_medoids
    else:
        raise CalibratorError("shape clustering did not converge")

    raw_clusters = []
    for cluster_index, medoid in enumerate(medoids):
        member_indices = [
            index for index, assignment in enumerate(assignments) if assignment == cluster_index
        ]
        source_counts: dict[str, int] = {}
        for index in member_indices:
            source_id = shapes[index].source_id
            source_counts[source_id] = source_counts.get(source_id, 0) + 1
        dispersion = sum(
            _squared_distance(points[index], medoid) for index in member_indices
        )
        raw_clusters.append(
            {
                "variance_weights_ppm": list(medoid),
                "sample_windows": len(member_indices),
                "source_window_counts": dict(sorted(source_counts.items())),
                "dispersion_ppm_squared": str(dispersion),
            }
        )
    raw_clusters.sort(key=lambda cluster: tuple(cluster["variance_weights_ppm"]))
    for index, cluster in enumerate(raw_clusters, start=1):
        cluster["cluster_id"] = f"cluster_{index:02d}"
    return raw_clusters


def derive_calibration(
    sources: Sequence[SourceInput],
    *,
    window_size: int,
    stride: int,
    clusters: int,
) -> dict[str, Any]:
    """Derive a sanitized calibration artifact from one or more local CSVs."""

    if not sources:
        raise CalibratorError("at least one --source CSV MANIFEST pair is required")
    all_shapes: list[WindowShape] = []
    provenance: list[dict[str, Any]] = []
    seen_source_ids: set[str] = set()
    for source in sources:
        manifest = _validate_manifest(load_json(source.manifest_path))
        source_id = manifest["source_id"]
        if source_id in seen_source_ids:
            raise CalibratorError(f"duplicate source_id {source_id!r}")
        seen_source_ids.add(source_id)
        returns = _read_returns(source.csv_path, manifest["return_column"])
        shapes = bucket_realized_variance(
            returns,
            source_id=source_id,
            window_size=window_size,
            stride=stride,
        )
        all_shapes.extend(shapes)
        provenance.append(
            {
                "source_id": source_id,
                "source_kind": manifest["source_kind"],
                "description": manifest["description"],
                "sampling_interval": manifest["sampling_interval"],
                "return_kind": manifest["return_kind"],
                "license": manifest["license"],
                "input_sha256": _sha256_file(source.csv_path),
                "observation_count": len(returns),
                "usable_window_count": len(shapes),
            }
        )
    artifact: dict[str, Any] = {
        "schema": CALIBRATION_SCHEMA,
        "tool": {"name": "strikefall-deck-calibrator", "version": TOOL_VERSION},
        "feature_contract": {
            "feature": "normalized_realized_variance_by_quarter",
            "phase_count": PHASE_COUNT,
            "weight_scale": WEIGHT_SCALE,
            "window_size": window_size,
            "stride": stride,
            "raw_values_exported": False,
            "source_order_exported": False,
        },
        "source_provenance": sorted(provenance, key=lambda item: item["source_id"]),
        "clusters": cluster_shapes(all_shapes, clusters),
    }
    artifact["calibration_digest"] = digest_json(
        {"domain": CALIBRATION_SCHEMA, "artifact": artifact}
    )
    _assert_sanitized_export(artifact)
    return artifact


def _verify_calibration(artifact: Mapping[str, Any]) -> None:
    if artifact.get("schema") != CALIBRATION_SCHEMA:
        raise CalibratorError(f"calibration schema must be {CALIBRATION_SCHEMA}")
    stored = _expect_string(artifact.get("calibration_digest"), "calibration_digest")
    unsigned = dict(artifact)
    unsigned.pop("calibration_digest", None)
    expected = digest_json({"domain": CALIBRATION_SCHEMA, "artifact": unsigned})
    if stored != expected:
        raise CalibratorError("calibration_digest does not match the artifact")
    clusters = artifact.get("clusters")
    if not isinstance(clusters, list) or not clusters:
        raise CalibratorError("calibration must contain at least one cluster")
    _assert_sanitized_export(artifact)


def _validate_weights(value: Any, label: str) -> list[int]:
    if not isinstance(value, list) or len(value) != PHASE_COUNT:
        raise CalibratorError(f"{label} must contain four integers")
    weights = [_expect_int(item, f"{label}[{index}]", 1) for index, item in enumerate(value)]
    if sum(weights) != WEIGHT_SCALE:
        raise CalibratorError(f"{label} must sum to {WEIGHT_SCALE}")
    return weights


def _resolve_shape(
    shape: Mapping[str, Any],
    calibration: Mapping[str, Any] | None,
    used_clusters: set[str],
    unique_cluster_selection: bool,
) -> tuple[list[int], dict[str, Any]]:
    mode = _expect_string(shape.get("mode"), "shape.mode")
    if mode == "hand_authored":
        weights = _validate_weights(
            shape.get("variance_weights_ppm"), "shape.variance_weights_ppm"
        )
        rationale = _expect_string(shape.get("rationale"), "shape.rationale")
        return weights, {"method": mode, "rationale": rationale}
    if mode != "cluster_nearest":
        raise CalibratorError("shape.mode must be hand_authored or cluster_nearest")
    if calibration is None:
        raise CalibratorError("cluster_nearest requires --calibration")
    target = _validate_weights(shape.get("target_weights_ppm"), "shape.target_weights_ppm")
    candidates = []
    for candidate in calibration["clusters"]:
        candidate_object = _expect_object(candidate, "calibration cluster")
        cluster_id = _expect_string(candidate_object.get("cluster_id"), "cluster_id")
        if unique_cluster_selection and cluster_id in used_clusters:
            continue
        weights = _validate_weights(
            candidate_object.get("variance_weights_ppm"),
            f"cluster {cluster_id} variance_weights_ppm",
        )
        candidates.append(
            (_squared_distance(target, weights), cluster_id, weights)
        )
    if not candidates:
        raise CalibratorError("no unused calibration cluster is available")
    distance, cluster_id, weights = min(candidates)
    used_clusters.add(cluster_id)
    return weights, {
        "method": mode,
        "source_calibration_digest": calibration["calibration_digest"],
        "selected_cluster_id": cluster_id,
        "target_distance_ppm_squared": str(distance),
    }


def _variance_at_boundary(
    total: int,
    weights: Sequence[int],
    battle_steps: int,
    step: int,
    opening_runway: Mapping[str, Any] | None = None,
) -> int:
    if step == battle_steps:
        return total
    quarter_len = battle_steps // PHASE_COUNT
    quarter = step // quarter_len
    within = step % quarter_len
    prefix = sum(weights[:quarter])
    progress = prefix * quarter_len + weights[quarter] * within
    denominator = sum(weights) * quarter_len
    linear = total * progress // denominator
    if opening_runway is None or quarter != 0 or step == 0:
        return linear
    runway_steps = int(opening_runway["steps"])
    runway_share_bps = int(opening_runway["variance_share_bps"])
    first_quarter = total * weights[0] // sum(weights)
    runway_variance = first_quarter * runway_share_bps // 10_000
    if within <= runway_steps:
        return runway_variance * within // runway_steps
    return runway_variance + (
        (first_quarter - runway_variance) * (within - runway_steps)
        // (quarter_len - runway_steps)
    )


def _deck_fixtures(deck: Mapping[str, Any]) -> dict[str, Any]:
    total = _fixed_int(deck["total_integrated_variance"], "total_integrated_variance")
    battle_steps = int(deck["battle_steps"])
    weights = list(deck["variance_weights_ppm"])
    opening_runway = deck.get("opening_runway")
    quarter = battle_steps // PHASE_COUNT
    steps = [0, quarter, quarter * 2, quarter * 3, battle_steps]
    if isinstance(opening_runway, dict):
        steps.append(int(opening_runway["steps"]))
        steps.sort()
    return {
        "fixture_id": f"{deck['id']}_v{deck['version']}_variance_boundaries",
        "normalization_sum_ppm": sum(weights),
        "boundary_steps": steps,
        "cumulative_variance": [
            str(
                _variance_at_boundary(
                    total, weights, battle_steps, step, opening_runway
                )
            )
            for step in steps
        ],
        "replay_seed_label": f"strikefall/deck-fixture/v1/{deck['id']}/{deck['version']}",
    }


def _deck_digest_payload(
    catalog: Mapping[str, Any], deck: Mapping[str, Any]
) -> dict[str, Any]:
    unsigned_deck = dict(deck)
    unsigned_deck.pop("calibration_digest", None)
    unsigned_deck.pop("test_fixtures", None)
    return {
        "domain": "strikefall/deck-calibration-digest/v1",
        "catalog_version": catalog.get("catalog_version"),
        "model_assumptions": catalog.get("model_assumptions"),
        "source_provenance": catalog.get("source_provenance"),
        "deck": unsigned_deck,
    }


def _catalog_digest_payload(catalog: Mapping[str, Any]) -> dict[str, Any]:
    unsigned = dict(catalog)
    unsigned.pop("catalog_digest", None)
    unsigned.pop("validation", None)
    return {"domain": "strikefall/deck-catalog-digest/v1", "catalog": unsigned}


def _compile_deck(
    raw: Mapping[str, Any],
    common: Mapping[str, Any],
    calibration: Mapping[str, Any] | None,
    used_clusters: set[str],
    unique_cluster_selection: bool,
) -> dict[str, Any]:
    deck_id = _expect_string(raw.get("id"), "deck.id")
    if _ID_RE.fullmatch(deck_id) is None:
        raise CalibratorError("deck.id must be a lower snake-case identifier")
    shape = _expect_object(raw.get("shape"), f"deck {deck_id} shape")
    weights, selection = _resolve_shape(
        shape, calibration, used_clusters, unique_cluster_selection
    )
    visual = _expect_object(raw.get("visual"), f"deck {deck_id} visual")
    audio = _expect_object(raw.get("audio"), f"deck {deck_id} audio")
    continuation = _expect_object(
        raw.get("continuation_rule", common.get("continuation_rule")),
        f"deck {deck_id} continuation_rule",
    )
    opening_runway_value = raw.get("opening_runway", common.get("opening_runway"))
    opening_runway: dict[str, int] | None = None
    if opening_runway_value is not None:
        runway = _expect_object(opening_runway_value, f"deck {deck_id} opening_runway")
        opening_runway = {
            "steps": _expect_int(runway.get("steps"), "opening_runway.steps", 1),
            "variance_share_bps": _expect_int(
                runway.get("variance_share_bps"),
                "opening_runway.variance_share_bps",
                1,
            ),
        }
    deck: dict[str, Any] = {
        "id": deck_id,
        "version": _expect_int(raw.get("version"), f"deck {deck_id} version", 1),
        "display_name": _expect_string(raw.get("display_name"), "display_name"),
        "approach_steps": _expect_int(
            raw.get("approach_steps", common.get("approach_steps")), "approach_steps", 1
        ),
        "battle_steps": _expect_int(
            raw.get("battle_steps", common.get("battle_steps")), "battle_steps", 4
        ),
        "step_ms": _expect_int(raw.get("step_ms", common.get("step_ms")), "step_ms", 1),
        "variance_weights_ppm": weights,
        "total_integrated_variance": _expect_string(
            raw.get(
                "total_integrated_variance", common.get("total_integrated_variance")
            ),
            "total_integrated_variance",
        ),
        "drift_per_variance": _expect_string(
            raw.get("drift_per_variance", common.get("drift_per_variance")),
            "drift_per_variance",
        ),
        "allowed_initial_survival": _expect_object(
            raw.get(
                "allowed_initial_survival", common.get("allowed_initial_survival")
            ),
            "allowed_initial_survival",
        ),
        "risk_multiplier_cap": _expect_string(
            raw.get("risk_multiplier_cap", common.get("risk_multiplier_cap")),
            "risk_multiplier_cap",
        ),
        "continuation_rule": continuation,
        "monitoring_convention": _expect_string(
            raw.get(
                "monitoring_convention", common.get("monitoring_convention")
            ),
            "monitoring_convention",
        ),
        "visual": {
            "art_theme": _expect_string(visual.get("art_theme"), "visual.art_theme"),
            "hue": _expect_int(visual.get("hue"), "visual.hue"),
            "tempo": _expect_string(visual.get("tempo"), "visual.tempo"),
            "kicker": _expect_string(visual.get("kicker"), "visual.kicker"),
            "description": _expect_string(
                visual.get("description"), "visual.description"
            ),
            "tactical_hint": _expect_string(
                visual.get("tactical_hint"), "visual.tactical_hint"
            ),
        },
        "audio": {
            "profile": _expect_string(audio.get("profile"), "audio.profile")
        },
        "calibration_evidence": selection,
    }
    if opening_runway is not None:
        deck["opening_runway"] = opening_runway
    return deck


def compile_catalog(
    template: Mapping[str, Any],
    calibration: Mapping[str, Any] | None = None,
    *,
    simulation_rounds: int = DEFAULT_SIMULATION_ROUNDS,
) -> dict[str, Any]:
    """Compile a hand-authored or cluster-selected template into a catalog."""

    if template.get("schema") != TEMPLATE_SCHEMA:
        raise CalibratorError(f"template schema must be {TEMPLATE_SCHEMA}")
    if calibration is not None:
        _verify_calibration(calibration)
        provenance = calibration.get("source_provenance")
    else:
        provenance = template.get("source_provenance")
    if not isinstance(provenance, list) or not provenance:
        raise CalibratorError("catalog compilation requires source provenance")
    common = _expect_object(template.get("common"), "common")
    assumptions = _expect_object(template.get("model_assumptions"), "model_assumptions")
    raw_decks = template.get("decks")
    if not isinstance(raw_decks, list) or not raw_decks:
        raise CalibratorError("template.decks must be a non-empty array")
    unique = template.get("unique_cluster_selection", True)
    if not isinstance(unique, bool):
        raise CalibratorError("unique_cluster_selection must be boolean")
    used_clusters: set[str] = set()
    decks = [
        _compile_deck(
            _expect_object(raw, "deck"),
            common,
            calibration,
            used_clusters,
            unique,
        )
        for raw in raw_decks
    ]
    catalog: dict[str, Any] = {
        "schema": CATALOG_SCHEMA,
        "catalog_version": _expect_int(
            template.get("catalog_version"), "catalog_version", 1
        ),
        "tool": {"name": "strikefall-deck-calibrator", "version": TOOL_VERSION},
        "source_provenance": provenance,
        "privacy_contract": {
            "exported_market_feature": "normalized_phase_variance_only",
            "raw_values_exported": False,
            "source_order_exported": False,
            "literal_historical_paths_exported": False,
        },
        "model_assumptions": assumptions,
        "catalog_rules": {
            "require_equal_total_variance": template.get(
                "require_equal_total_variance", True
            ),
            "minimum_pairwise_shape_distance_ppm": _expect_int(
                template.get("minimum_pairwise_shape_distance_ppm", 100_000),
                "minimum_pairwise_shape_distance_ppm",
                0,
            ),
        },
        "decks": decks,
    }
    for deck in decks:
        deck["test_fixtures"] = _deck_fixtures(deck)
        deck["calibration_digest"] = digest_json(_deck_digest_payload(catalog, deck))
    catalog["catalog_digest"] = digest_json(_catalog_digest_payload(catalog))
    validation = validate_catalog(catalog, simulation_rounds=simulation_rounds)
    catalog["validation"] = validation
    _assert_sanitized_export(catalog)
    if not validation["valid"]:
        joined = "; ".join(validation["errors"])
        raise CalibratorError(f"compiled catalog failed validation: {joined}")
    return catalog


class _StableNormalRng:
    """Small specified xorshift64* + Box-Muller generator for campaigns."""

    _MASK = (1 << 64) - 1
    _MULTIPLIER = 2_685_821_657_736_338_717

    def __init__(self, seed_label: str) -> None:
        self._state = int.from_bytes(
            hashlib.sha256(seed_label.encode("utf-8")).digest()[:8], "big"
        ) or 0x9E3779B97F4A7C15
        self._spare: float | None = None

    def _word(self) -> int:
        value = self._state
        value ^= value >> 12
        value ^= (value << 25) & self._MASK
        value ^= value >> 27
        self._state = value & self._MASK
        return (self._state * self._MULTIPLIER) & self._MASK

    def _open_unit(self) -> float:
        return (self._word() + 0.5) / float(1 << 64)

    def normal(self) -> float:
        if self._spare is not None:
            value = self._spare
            self._spare = None
            return value
        radius = math.sqrt(-2.0 * math.log(self._open_unit()))
        angle = 2.0 * math.pi * self._open_unit()
        self._spare = radius * math.sin(angle)
        return radius * math.cos(angle)


def _quantile(values: Sequence[int], fraction: float) -> int:
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * fraction))
    return ordered[index]


def _simulate_deck(
    deck: Mapping[str, Any], _catalog_digest: str, rounds: int
) -> tuple[dict[str, Any], list[str]]:
    total_fixed = _fixed_int(
        deck["total_integrated_variance"], "total_integrated_variance"
    )
    drift_fixed = _fixed_int(
        deck["drift_per_variance"], "drift_per_variance", signed=True
    )
    cap_fixed = _fixed_int(deck["risk_multiplier_cap"], "risk_multiplier_cap")
    weights = [int(value) for value in deck["variance_weights_ppm"]]
    opening_runway = deck.get("opening_runway")
    battle_steps = int(deck["battle_steps"])
    step_ms = int(deck["step_ms"])
    total_variance = total_fixed / FIXED_SCALE
    drift = drift_fixed / FIXED_SCALE
    boundaries = [
        _variance_at_boundary(
            total_fixed, weights, battle_steps, step, opening_runway
        )
        for step in range(battle_steps + 1)
    ]
    schedule = [
        (boundaries[index + 1] - boundaries[index]) / FIXED_SCALE
        for index in range(battle_steps)
    ]
    survival_range = _expect_object(
        deck["allowed_initial_survival"], "allowed_initial_survival"
    )
    probability_scale = _fixed_int(survival_range.get("scale"), "probability scale")
    probability_min = _fixed_int(survival_range.get("min"), "probability min")
    probability_max = _fixed_int(survival_range.get("max"), "probability max")
    low = probability_min / probability_scale
    # The legal arena may extend to 90%, but the reference lobby deliberately
    # concentrates on riskier flags so its survivor median exercises the
    # roadmap's dramatic 2-6 target instead of validating an all-safe lobby.
    high = min(probability_max / probability_scale, max(low + 0.05, 0.25))
    target_probabilities = [low + (high - low) * index / 9 for index in range(10)]
    normal_dist = NormalDist()
    barriers = [
        normal_dist.inv_cdf((probability + 1.0) / 2.0)
        * math.sqrt(total_variance)
        for probability in target_probabilities
    ]
    risk_cap = cap_fixed / FIXED_SCALE
    scores = [min(0.9 / probability, risk_cap) * 100 for probability in target_probabilities]
    # Art, prose, provenance, and deck identity must not change a numerical
    # campaign. All shapes at the same scale use common random numbers so a
    # validation difference comes from pacing rather than seed luck.
    campaign_identity = digest_json(
        {
            "domain": "strikefall/deck-validation-seed/v1",
            "battle_steps": battle_steps,
            "step_ms": step_ms,
            "total_integrated_variance": deck["total_integrated_variance"],
            "drift_per_variance": deck["drift_per_variance"],
        }
    )
    rng = _StableNormalRng(f"strikefall/deck-validation/v1/{campaign_identity}")
    survivors: list[int] = []
    awarded_scores: list[float] = []
    phase_rv = [0.0] * PHASE_COUNT
    total_rv = 0.0
    early_eight_hit_stress = 0
    hit_steps: list[int] = []
    band_survivors = [0] * len(barriers)
    early_step = min(battle_steps, math.ceil(10_000 / step_ms))
    quarter = battle_steps // PHASE_COUNT

    for _round in range(rounds):
        position = 0.0
        maximum = 0.0
        minimum = 0.0
        early_maximum = 0.0
        early_minimum = 0.0
        upper_first_hit: list[int | None] = [None] * len(barriers)
        lower_first_hit: list[int | None] = [None] * len(barriers)
        for step, variance in enumerate(schedule, start=1):
            increment = drift * variance + math.sqrt(variance) * rng.normal()
            position += increment
            total_rv += increment * increment
            phase_rv[min(PHASE_COUNT - 1, (step - 1) // quarter)] += increment * increment
            maximum = max(maximum, position)
            minimum = min(minimum, position)
            if step <= early_step:
                early_maximum = maximum
                early_minimum = minimum
            for index, barrier in enumerate(barriers):
                if upper_first_hit[index] is None and position >= barrier:
                    upper_first_hit[index] = step
                if lower_first_hit[index] is None and position <= -barrier:
                    lower_first_hit[index] = step
        survived = 0
        round_score = 0.0
        early_hits = 0
        for index, barrier in enumerate(barriers):
            upper_survived = maximum < barrier
            lower_survived = minimum > -barrier
            band_survivors[index] += int(upper_survived) + int(lower_survived)
            survived += int(upper_survived) + int(lower_survived)
            if upper_survived:
                round_score += scores[index]
            else:
                hit_steps.append(int(upper_first_hit[index]))
            if lower_survived:
                round_score += scores[index]
            else:
                hit_steps.append(int(lower_first_hit[index]))
            early_hits += int(early_maximum >= barrier) + int(early_minimum <= -barrier)
        survivors.append(survived)
        awarded_scores.append(round_score)
        early_eight_hit_stress += int(early_hits >= 8)

    intended_shares = [weight / WEIGHT_SCALE for weight in weights]
    observed_total = sum(phase_rv)
    observed_shares = [value / observed_total for value in phase_rv]
    phase_error_ppm = round(
        max(
            abs(actual - intended)
            for actual, intended in zip(
                observed_shares, intended_shares, strict=True
            )
        )
        * WEIGHT_SCALE
    )
    realized_ratio = total_rv / (rounds * total_variance)
    rates = [count / (rounds * 2) for count in band_survivors]
    monotone = all(left <= right + 1e-12 for left, right in zip(rates, rates[1:]))
    score_stddev = pstdev(awarded_scores)
    metrics: dict[str, Any] = {
        "rounds": rounds,
        "seed_algorithm": "sha256_seeded_xorshift64star_box_muller_v1",
        "contenders": 20,
        "flag_profile": "symmetric_nested_risk_concentrated_reference_ladder",
        "mean_realized_variance_ratio": round(realized_ratio, 6),
        "observed_phase_variance_ppm": [round(value * WEIGHT_SCALE) for value in observed_shares],
        "phase_share_max_abs_error_ppm": phase_error_ppm,
        "survivors": {
            "p10": _quantile(survivors, 0.10),
            "median": _quantile(survivors, 0.50),
            "p90": _quantile(survivors, 0.90),
            "distinct_counts": len(set(survivors)),
        },
        "reference_ladder_survival_ppm": [round(rate * WEIGHT_SCALE) for rate in rates],
        "reference_ladder_monotone": monotone,
        "elimination_timing": {
            "median_step": int(median(hit_steps)) if hit_steps else None,
            "median_fraction_ppm": (
                round(median(hit_steps) / battle_steps * WEIGHT_SCALE) if hit_steps else None
            ),
            "first_10s_eight_hit_stress_rate_ppm": round(
                early_eight_hit_stress / rounds * WEIGHT_SCALE
            ),
        },
        "score": {
            "mean_lobby_points": round(sum(awarded_scores) / rounds, 3),
            "lobby_points_stddev": round(score_stddev, 3),
        },
    }
    failures = []
    if not 0.80 <= realized_ratio <= 1.20:
        failures.append("mean realized variance is outside 80%-120% of the declared total")
    if phase_error_ppm > 60_000:
        failures.append("simulated phase variance differs from the declared shape by >6%")
    if not 2 <= metrics["survivors"]["median"] <= 6:
        failures.append("reference survivor median is outside the roadmap's 2-6 target")
    if metrics["survivors"]["distinct_counts"] < 3:
        failures.append("reference campaign produces fewer than three survivor counts")
    if not monotone:
        failures.append("nested reference flag survival is not monotone")
    if score_stddev <= 0:
        failures.append("reference campaign has no score variance")
    return metrics, failures


def _recursive_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from _recursive_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _recursive_keys(child)


def _assert_sanitized_export(value: Any) -> None:
    forbidden = sorted(
        key for key in _recursive_keys(value) if key.lower() in _FORBIDDEN_EXPORT_KEYS
    )
    if forbidden:
        raise CalibratorError(
            "export contains forbidden source-level fields: " + ", ".join(forbidden)
        )


def _structural_errors(catalog: Mapping[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if catalog.get("schema") != CATALOG_SCHEMA:
        errors.append(f"schema must be {CATALOG_SCHEMA}")
    try:
        _expect_int(catalog.get("catalog_version"), "catalog_version", 1)
    except CalibratorError as error:
        errors.append(str(error))
    provenance = catalog.get("source_provenance")
    if not isinstance(provenance, list) or not provenance:
        errors.append("source_provenance must be a non-empty array")
    else:
        if any(
            isinstance(item, dict) and item.get("source_kind") == "synthetic"
            for item in provenance
        ):
            warnings.append(
                "synthetic calibration provenance is test-only; replace it with "
                "reviewed licensed data before ranked promotion"
            )
        for index, item in enumerate(provenance):
            try:
                source = _expect_object(item, f"source_provenance[{index}]")
                source_id = _expect_string(source.get("source_id"), "source_id")
                if _ID_RE.fullmatch(source_id) is None:
                    raise CalibratorError("provenance source_id is not lower snake-case")
                source_kind = _expect_string(source.get("source_kind"), "source_kind")
                if source_kind not in {
                    "licensed_market_data",
                    "synthetic",
                    "project_authored",
                }:
                    raise CalibratorError("provenance source_kind is invalid")
                _expect_string(source.get("description"), "source description")
                license_info = _expect_object(source.get("license"), "source license")
                _expect_string(license_info.get("identifier"), "license.identifier")
                _expect_string(license_info.get("name"), "license.name")
                _expect_string(license_info.get("reference"), "license.reference")
                if license_info.get("terms_confirmed") is not True:
                    raise CalibratorError("source license terms are not confirmed")
                if source_kind in {"licensed_market_data", "synthetic"}:
                    _expect_string(
                        source.get("sampling_interval"), "source sampling_interval"
                    )
                    if source.get("return_kind") != "log_return":
                        raise CalibratorError("calibrated source must declare log_return")
                    input_digest = _expect_string(
                        source.get("input_sha256"), "source input_sha256"
                    )
                    if re.fullmatch(r"[0-9a-f]{64}", input_digest) is None:
                        raise CalibratorError("source input_sha256 is invalid")
                    _expect_int(
                        source.get("observation_count"), "source observation_count", 1
                    )
                    _expect_int(
                        source.get("usable_window_count"),
                        "source usable_window_count",
                        1,
                    )
            except CalibratorError as error:
                errors.append(str(error))
    assumptions = catalog.get("model_assumptions")
    if not isinstance(assumptions, dict):
        errors.append("model_assumptions must be an object")
    else:
        required_assumptions = {
            "stochastic_class": "geometric_diffusion_in_variance_time",
            "pricing_payoff": "one_sided_no_touch_survival",
            "historical_role": "normalized_temporal_variance_shape_only",
        }
        for key, expected in required_assumptions.items():
            if assumptions.get(key) != expected:
                errors.append(f"model_assumptions.{key} must be {expected!r}")
        if assumptions.get("fresh_randomness_per_round") is not True:
            errors.append("model_assumptions must require fresh randomness per round")
        if assumptions.get("game_scale_variance_is_separate_from_source_magnitude") is not True:
            errors.append("model assumptions must separate game scale from source magnitude")
    privacy = catalog.get("privacy_contract")
    if not isinstance(privacy, dict):
        errors.append("privacy_contract must be an object")
    else:
        for key in (
            "raw_values_exported",
            "source_order_exported",
            "literal_historical_paths_exported",
        ):
            if privacy.get(key) is not False:
                errors.append(f"privacy_contract.{key} must be false")
    decks = catalog.get("decks")
    if not isinstance(decks, list) or not decks:
        errors.append("decks must be a non-empty array")
        return errors, warnings
    seen: set[tuple[str, int]] = set()
    totals: set[int] = set()
    valid_shapes: list[tuple[str, list[int]]] = []
    for index, item in enumerate(decks):
        prefix = f"decks[{index}]"
        try:
            deck = _expect_object(item, prefix)
            deck_id = _expect_string(deck.get("id"), f"{prefix}.id")
            if _ID_RE.fullmatch(deck_id) is None:
                raise CalibratorError(f"{prefix}.id is not lower snake-case")
            version = _expect_int(deck.get("version"), f"{prefix}.version", 1)
            if version > 65_535:
                raise CalibratorError(f"{prefix}.version exceeds u16")
            identity = (deck_id, version)
            if identity in seen:
                raise CalibratorError(f"duplicate deck identity {identity}")
            seen.add(identity)
            _expect_string(deck.get("display_name"), f"{prefix}.display_name")
            approach_steps = _expect_int(
                deck.get("approach_steps"), f"{prefix}.approach_steps", 1
            )
            if approach_steps > 65_535:
                raise CalibratorError(f"{prefix}.approach_steps exceeds u16")
            battle_steps = _expect_int(
                deck.get("battle_steps"), f"{prefix}.battle_steps", 4
            )
            if battle_steps > 65_535 or battle_steps % PHASE_COUNT != 0:
                raise CalibratorError(f"{prefix}.battle_steps must fit u16 and divide by 4")
            step_ms = _expect_int(deck.get("step_ms"), f"{prefix}.step_ms", 1)
            if step_ms > 65_535:
                raise CalibratorError(f"{prefix}.step_ms exceeds u16")
            weights = _validate_weights(
                deck.get("variance_weights_ppm"), f"{prefix}.variance_weights_ppm"
            )
            valid_shapes.append((deck_id, weights))
            opening_runway_value = deck.get("opening_runway")
            if version >= 3 and opening_runway_value is None:
                raise CalibratorError(f"{prefix}.opening_runway is required for v3+")
            if version < 3 and opening_runway_value is not None:
                raise CalibratorError(f"{prefix}.opening_runway requires v3+")
            opening_runway: Mapping[str, Any] | None = None
            if opening_runway_value is not None:
                opening_runway = _expect_object(
                    opening_runway_value, f"{prefix}.opening_runway"
                )
                runway_steps = _expect_int(
                    opening_runway.get("steps"),
                    f"{prefix}.opening_runway.steps",
                    1,
                )
                runway_share_bps = _expect_int(
                    opening_runway.get("variance_share_bps"),
                    f"{prefix}.opening_runway.variance_share_bps",
                    1,
                )
                quarter_steps = battle_steps // PHASE_COUNT
                if runway_steps >= quarter_steps:
                    raise CalibratorError(
                        f"{prefix}.opening_runway.steps must be inside the first quarter"
                    )
                if runway_share_bps >= 10_000:
                    raise CalibratorError(
                        f"{prefix}.opening_runway.variance_share_bps must be < 10000"
                    )
                if runway_share_bps * quarter_steps >= 10_000 * runway_steps:
                    raise CalibratorError(
                        f"{prefix}.opening_runway must be lower variance than linear pacing"
                    )
            total = _fixed_int(
                deck.get("total_integrated_variance"),
                f"{prefix}.total_integrated_variance",
            )
            if total <= 0:
                raise CalibratorError(f"{prefix}.total_integrated_variance must be positive")
            if total > U128_MAX:
                raise CalibratorError(
                    f"{prefix}.total_integrated_variance exceeds u128"
                )
            totals.add(total)
            drift = _fixed_int(
                deck.get("drift_per_variance"),
                f"{prefix}.drift_per_variance",
                signed=True,
            )
            if abs(drift) > 4 * FIXED_SCALE:
                raise CalibratorError(f"{prefix}.drift_per_variance exceeds +/-4")
            if not I128_MIN <= drift <= I128_MAX:
                raise CalibratorError(f"{prefix}.drift_per_variance exceeds i128")
            survival = _expect_object(
                deck.get("allowed_initial_survival"),
                f"{prefix}.allowed_initial_survival",
            )
            scale = _fixed_int(survival.get("scale"), f"{prefix} probability scale")
            minimum = _fixed_int(survival.get("min"), f"{prefix} probability min")
            maximum = _fixed_int(survival.get("max"), f"{prefix} probability max")
            if scale != FIXED_SCALE or not 0 < minimum < maximum <= scale:
                raise CalibratorError(f"{prefix} probability range is invalid")
            if any(value > U128_MAX for value in (scale, minimum, maximum)):
                raise CalibratorError(f"{prefix} probability value exceeds u128")
            cap = _fixed_int(
                deck.get("risk_multiplier_cap"), f"{prefix}.risk_multiplier_cap"
            )
            if cap < FIXED_SCALE:
                raise CalibratorError(f"{prefix}.risk_multiplier_cap must be >= 1x")
            if cap > U128_MAX:
                raise CalibratorError(f"{prefix}.risk_multiplier_cap exceeds u128")
            previous_variance = 0
            for step in range(1, battle_steps + 1):
                current_variance = _variance_at_boundary(
                    total, weights, battle_steps, step, opening_runway
                )
                if current_variance <= previous_variance:
                    raise CalibratorError(
                        f"{prefix} has a zero fixed-point variance step"
                    )
                previous_variance = current_variance
            continuation = _expect_object(
                deck.get("continuation_rule"), f"{prefix}.continuation_rule"
            )
            if continuation.get("kind") not in {
                "neutral",
                "public_momentum",
                "public_reversal",
            }:
                raise CalibratorError(f"{prefix}.continuation_rule.kind is invalid")
            _expect_string(
                deck.get("monitoring_convention"), f"{prefix}.monitoring_convention"
            )
            visual = _expect_object(deck.get("visual"), f"{prefix}.visual")
            _expect_string(visual.get("art_theme"), f"{prefix}.visual.art_theme")
            hue = _expect_int(visual.get("hue"), f"{prefix}.visual.hue")
            if hue > 360:
                raise CalibratorError(f"{prefix}.visual.hue must be <= 360")
            tempo = Decimal(_expect_string(visual.get("tempo"), f"{prefix}.visual.tempo"))
            if not tempo.is_finite() or tempo <= 0:
                raise CalibratorError(f"{prefix}.visual.tempo must be positive")
            audio = _expect_object(deck.get("audio"), f"{prefix}.audio")
            _expect_string(audio.get("profile"), f"{prefix}.audio.profile")
            fixture = _expect_object(deck.get("test_fixtures"), f"{prefix}.test_fixtures")
            if fixture != _deck_fixtures(deck):
                raise CalibratorError(f"{prefix}.test_fixtures do not match the deck")
            stored_digest = _expect_string(
                deck.get("calibration_digest"), f"{prefix}.calibration_digest"
            )
            if len(stored_digest) != 64 or stored_digest != digest_json(
                _deck_digest_payload(catalog, deck)
            ):
                raise CalibratorError(f"{prefix}.calibration_digest mismatch")
        except (CalibratorError, InvalidOperation) as error:
            errors.append(str(error))
    rules = catalog.get("catalog_rules", {})
    if not isinstance(rules, dict):
        errors.append("catalog_rules must be an object")
    elif not isinstance(rules.get("require_equal_total_variance"), bool):
        errors.append("catalog_rules.require_equal_total_variance must be boolean")
    if isinstance(rules, dict) and rules.get("require_equal_total_variance") is True:
        if len(totals) > 1:
            errors.append("catalog requires equal total integrated variance")
    minimum_distance = 0
    if isinstance(rules, dict):
        value = rules.get("minimum_pairwise_shape_distance_ppm", 0)
        if isinstance(value, int) and not isinstance(value, bool):
            minimum_distance = value
    for left_index, (left_id, left) in enumerate(valid_shapes):
        for right_id, right in valid_shapes[left_index + 1 :]:
            distance = sum(abs(a - b) for a, b in zip(left, right, strict=True))
            if distance < minimum_distance:
                errors.append(
                    f"deck shapes {left_id} and {right_id} are only {distance} ppm apart"
                )
    try:
        _assert_sanitized_export(catalog)
    except CalibratorError as error:
        errors.append(str(error))
    stored_catalog_digest = catalog.get("catalog_digest")
    expected_catalog_digest = digest_json(_catalog_digest_payload(catalog))
    if stored_catalog_digest != expected_catalog_digest:
        errors.append("catalog_digest mismatch")
    return errors, warnings


def validate_catalog(
    catalog: Mapping[str, Any],
    *,
    simulation_rounds: int = DEFAULT_SIMULATION_ROUNDS,
) -> dict[str, Any]:
    """Run structural, digest, privacy, and deterministic campaign checks."""

    if simulation_rounds < 128 or simulation_rounds > 100_000:
        raise CalibratorError("simulation_rounds must be between 128 and 100000")
    structural_errors, warnings = _structural_errors(catalog)
    errors = list(structural_errors)
    simulation_errors: list[str] = []
    simulations: dict[str, Any] = {}
    if not errors:
        catalog_digest = str(catalog["catalog_digest"])
        for item in catalog["decks"]:
            deck = _expect_object(item, "deck")
            metrics, failures = _simulate_deck(deck, catalog_digest, simulation_rounds)
            simulations[str(deck["id"])] = metrics
            deck_failures = [f"{deck['id']}: {failure}" for failure in failures]
            simulation_errors.extend(deck_failures)
            errors.extend(deck_failures)
            stress_rate = metrics["elimination_timing"][
                "first_10s_eight_hit_stress_rate_ppm"
            ]
            if stress_rate > 100_000:
                warnings.append(
                    f"{deck['id']}: reference first-10s eight-hit stress rate "
                    f"is {stress_rate} ppm; run the engine-level cluster campaign"
                )
    return {
        "schema": "strikefall/deck-validation/v1",
        "valid": not errors,
        "ranked_promotion_ready": not errors and not warnings,
        "errors": errors,
        "warnings": warnings,
        "checks": {
            "structural_schema": not structural_errors,
            "digest_integrity": not any("digest" in error for error in errors),
            "privacy_boundary": not any(
                "forbidden" in error or "privacy_contract" in error
                for error in errors
            ),
            "simulation_campaign": bool(simulations) and not simulation_errors,
        },
        "simulation_profile": {
            "purpose": "offline shape and pacing guardrail, not production pricing",
            "crowding_modelled": False,
            "monitoring": "declared discrete deck steps",
            "rounds_per_deck": simulation_rounds,
        },
        "simulations": simulations,
    }
