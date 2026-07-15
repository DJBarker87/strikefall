from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path


TOOL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = TOOL_ROOT.parents[1]
sys.path.insert(0, str(TOOL_ROOT))

from strikefall_decks.calibrator import (  # noqa: E402
    CALIBRATION_SCHEMA,
    CalibratorError,
    SourceInput,
    bucket_realized_variance,
    compile_catalog,
    derive_calibration,
    load_json,
    validate_catalog,
)


FIXTURES = TOOL_ROOT / "fixtures"
CSV_FIXTURE = FIXTURES / "synthetic_returns.csv"
SOURCE_FIXTURE = FIXTURES / "synthetic_source.json"
TEMPLATE_FIXTURE = FIXTURES / "four_decks.template.json"


def synthetic_calibration() -> dict[str, object]:
    return derive_calibration(
        [SourceInput(CSV_FIXTURE, SOURCE_FIXTURE)],
        window_size=16,
        stride=16,
        clusters=4,
    )


class ExtractionTests(unittest.TestCase):
    def test_four_phase_realized_variance_is_exact_and_sign_invariant(self) -> None:
        values = [
            Decimal("0.004"),
            Decimal("-0.002"),
            Decimal("0.002"),
            Decimal("-0.001"),
        ] * 4
        first = bucket_realized_variance(
            values, source_id="fixture", window_size=16, stride=16
        )
        second = bucket_realized_variance(
            [-value for value in values],
            source_id="fixture",
            window_size=16,
            stride=16,
        )
        self.assertEqual(first[0].weights, (250000, 250000, 250000, 250000))
        self.assertEqual(first[0].weights, second[0].weights)

    def test_fixture_derives_the_four_roadmap_shapes(self) -> None:
        artifact = synthetic_calibration()
        self.assertEqual(artifact["schema"], CALIBRATION_SCHEMA)
        shapes = {
            tuple(cluster["variance_weights_ppm"])
            for cluster in artifact["clusters"]
        }
        self.assertEqual(
            shapes,
            {
                (250000, 250000, 250000, 250000),
                (50000, 100000, 250000, 600000),
                (550000, 250000, 150000, 50000),
                (150000, 350000, 150000, 350000),
            },
        )
        self.assertEqual(sum(cluster["sample_windows"] for cluster in artifact["clusters"]), 4)

    def test_derivation_is_byte_deterministic_and_sanitized(self) -> None:
        first = synthetic_calibration()
        second = synthetic_calibration()
        self.assertEqual(first, second)
        rendered = json.dumps(first, sort_keys=True)
        self.assertNotIn("synthetic-001", rendered)
        self.assertNotIn("100.00", rendered)
        self.assertNotIn("positive", rendered)
        self.assertNotIn("observation_label", rendered)
        self.assertNotIn("reference_level", rendered)
        self.assertNotIn("sign_label", rendered)

    def test_unconfirmed_or_remote_source_is_rejected(self) -> None:
        manifest = load_json(SOURCE_FIXTURE)
        manifest["license"]["terms_confirmed"] = False
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(CalibratorError, "terms_confirmed"):
                derive_calibration(
                    [SourceInput(CSV_FIXTURE, path)],
                    window_size=16,
                    stride=16,
                    clusters=4,
                )

        manifest = load_json(SOURCE_FIXTURE)
        manifest["local_only"] = False
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(CalibratorError, "local_only"):
                derive_calibration(
                    [SourceInput(CSV_FIXTURE, path)],
                    window_size=16,
                    stride=16,
                    clusters=4,
                )

    def test_repeated_sources_are_order_independent(self) -> None:
        second_manifest = load_json(SOURCE_FIXTURE)
        second_manifest["source_id"] = "strikefall_synthetic_shapes_copy_v1"
        with tempfile.TemporaryDirectory() as directory:
            second_path = Path(directory) / "second.json"
            second_path.write_text(json.dumps(second_manifest), encoding="utf-8")
            first = derive_calibration(
                [
                    SourceInput(CSV_FIXTURE, SOURCE_FIXTURE),
                    SourceInput(CSV_FIXTURE, second_path),
                ],
                window_size=16,
                stride=16,
                clusters=4,
            )
            second = derive_calibration(
                [
                    SourceInput(CSV_FIXTURE, second_path),
                    SourceInput(CSV_FIXTURE, SOURCE_FIXTURE),
                ],
                window_size=16,
                stride=16,
                clusters=4,
            )
        self.assertEqual(first, second)
        self.assertEqual(sum(item["sample_windows"] for item in first["clusters"]), 8)


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.calibration = synthetic_calibration()
        cls.template = load_json(TEMPLATE_FIXTURE)
        cls.catalog = compile_catalog(
            cls.template, cls.calibration, simulation_rounds=192
        )

    def test_compiles_exact_launch_catalog_with_provenance_and_fixtures(self) -> None:
        catalog = self.catalog
        self.assertTrue(catalog["validation"]["valid"])
        self.assertFalse(catalog["validation"]["ranked_promotion_ready"])
        self.assertEqual(
            [deck["id"] for deck in catalog["decks"]],
            ["balanced_tape", "compression_break", "opening_rush", "pulse"],
        )
        expected = {
            "balanced_tape": [250000, 250000, 250000, 250000],
            "compression_break": [50000, 100000, 250000, 600000],
            "opening_rush": [550000, 250000, 150000, 50000],
            "pulse": [150000, 350000, 150000, 350000],
        }
        expected_runways = {
            "balanced_tape": {"steps": 40, "variance_share_bps": 340},
            "compression_break": {"steps": 40, "variance_share_bps": 1600},
            "opening_rush": {"steps": 40, "variance_share_bps": 125},
            "pulse": {"steps": 40, "variance_share_bps": 450},
        }
        for deck in catalog["decks"]:
            self.assertEqual(deck["variance_weights_ppm"], expected[deck["id"]])
            self.assertEqual(deck["opening_runway"], expected_runways[deck["id"]])
            self.assertEqual(len(deck["calibration_digest"]), 64)
            self.assertEqual(
                deck["test_fixtures"]["cumulative_variance"][-1],
                deck["total_integrated_variance"],
            )
            self.assertIn(40, deck["test_fixtures"]["boundary_steps"])
            self.assertEqual(
                deck["allowed_initial_survival"],
                {
                    "min": "120000000000",
                    "max": "900000000000",
                    "scale": "1000000000000",
                },
            )

    def test_compile_and_campaign_are_deterministic(self) -> None:
        again = compile_catalog(
            self.template, self.calibration, simulation_rounds=192
        )
        self.assertEqual(self.catalog, again)

    def test_tampering_breaks_deck_and_catalog_digests(self) -> None:
        tampered = copy.deepcopy(self.catalog)
        tampered["decks"][0]["visual"]["hue"] = 159
        report = validate_catalog(tampered, simulation_rounds=192)
        self.assertFalse(report["valid"])
        self.assertTrue(any("calibration_digest mismatch" in item for item in report["errors"]))
        self.assertTrue(any("catalog_digest mismatch" in item for item in report["errors"]))

    def test_invalid_hand_authored_shape_is_rejected(self) -> None:
        template = copy.deepcopy(self.template)
        template["decks"][0]["shape"] = {
            "mode": "hand_authored",
            "variance_weights_ppm": [250000, 250000, 250000, 249999],
            "rationale": "Deliberate malformed fixture",
        }
        template["source_provenance"] = self.calibration["source_provenance"]
        with self.assertRaisesRegex(CalibratorError, "must sum"):
            compile_catalog(template, simulation_rounds=192)

    def test_fixed_point_schedule_rejects_zero_variance_steps(self) -> None:
        template = copy.deepcopy(self.template)
        template["common"]["total_integrated_variance"] = "1"
        with self.assertRaisesRegex(CalibratorError, "zero fixed-point variance step"):
            compile_catalog(template, self.calibration, simulation_rounds=192)

    def test_valid_hand_authored_catalog_is_supported(self) -> None:
        template = copy.deepcopy(self.template)
        for deck in template["decks"]:
            target = deck["shape"]["target_weights_ppm"]
            deck["shape"] = {
                "mode": "hand_authored",
                "variance_weights_ppm": target,
                "rationale": "Roadmap launch allocation",
            }
        template["source_provenance"] = self.calibration["source_provenance"]
        result = compile_catalog(template, simulation_rounds=192)
        self.assertTrue(result["validation"]["valid"])
        self.assertTrue(
            all(
                deck["calibration_evidence"]["method"] == "hand_authored"
                for deck in result["decks"]
            )
        )

    def test_simulation_reports_pacing_variance_and_monotone_ladder(self) -> None:
        for metrics in self.catalog["validation"]["simulations"].values():
            self.assertGreaterEqual(metrics["survivors"]["distinct_counts"], 3)
            self.assertTrue(metrics["reference_ladder_monotone"])
            self.assertGreater(metrics["score"]["lobby_points_stddev"], 0)
            self.assertLessEqual(metrics["phase_share_max_abs_error_ppm"], 60000)
            self.assertIsNotNone(metrics["elimination_timing"]["median_step"])

    def test_checked_in_sample_is_the_exact_512_round_build(self) -> None:
        expected = load_json(REPO_ROOT / "docs" / "decks" / "sample-catalog.v3.json")
        generated = compile_catalog(
            self.template, self.calibration, simulation_rounds=512
        )
        self.assertEqual(generated, expected)

    def test_privacy_guard_rejects_source_level_export_keys(self) -> None:
        tampered = copy.deepcopy(self.catalog)
        tampered["source_provenance"][0]["timestamp"] = "forbidden-row-label"
        report = validate_catalog(tampered, simulation_rounds=192)
        self.assertFalse(report["valid"])
        self.assertFalse(report["checks"]["privacy_boundary"])
        self.assertTrue(any("forbidden" in item for item in report["errors"]))

        semantic_tamper = copy.deepcopy(self.catalog)
        semantic_tamper["privacy_contract"]["raw_values_exported"] = True
        semantic_report = validate_catalog(semantic_tamper, simulation_rounds=192)
        self.assertFalse(semantic_report["checks"]["privacy_boundary"])


class CliTests(unittest.TestCase):
    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(TOOL_ROOT / "calibrate.py"), *arguments],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

    def test_end_to_end_cli_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calibration_path = Path(directory) / "calibration.json"
            catalog_path = Path(directory) / "catalog.json"
            result = self.run_cli(
                "derive",
                "--source",
                str(CSV_FIXTURE),
                str(SOURCE_FIXTURE),
                "--window-size",
                "16",
                "--stride",
                "16",
                "--clusters",
                "4",
                "--output",
                str(calibration_path),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_cli(
                "compile",
                "--template",
                str(TEMPLATE_FIXTURE),
                "--calibration",
                str(calibration_path),
                "--simulation-rounds",
                "192",
                "--output",
                str(catalog_path),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_cli(
                "validate",
                str(catalog_path),
                "--simulation-rounds",
                "192",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertTrue(report["valid"])

    def test_cli_rejects_a_corrupted_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            catalog = copy.deepcopy(CatalogTests.catalog)
            catalog["decks"][0]["variance_weights_ppm"][0] += 1
            path.write_text(json.dumps(catalog), encoding="utf-8")
            result = self.run_cli(
                "validate", str(path), "--simulation-rounds", "192"
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)["valid"])


if __name__ == "__main__":
    unittest.main()
