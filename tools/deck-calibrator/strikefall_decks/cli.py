"""Command-line interface for the offline Strikefall deck calibrator."""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from typing import Sequence

from .calibrator import (
    DEFAULT_SIMULATION_ROUNDS,
    CalibratorError,
    SourceInput,
    compile_catalog,
    derive_calibration,
    load_json,
    pretty_json,
    validate_catalog,
)


def _write_json(path: Path | None, value: object) -> None:
    rendered = pretty_json(value)
    if path is None:
        sys.stdout.write(rendered)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="strikefall-deck-calibrator",
        description=(
            "Derive sanitized four-phase variance shapes and compile versioned "
            "Strikefall deck catalogs using local files only."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    derive = subparsers.add_parser(
        "derive", help="derive deterministic shape clusters from local return CSVs"
    )
    derive.add_argument(
        "--source",
        action="append",
        nargs=2,
        metavar=("CSV", "MANIFEST"),
        required=True,
        help="local CSV and its reviewed licence/provenance manifest; repeatable",
    )
    derive.add_argument("--window-size", type=int, required=True)
    derive.add_argument("--stride", type=int, default=None)
    derive.add_argument("--clusters", type=int, default=4)
    derive.add_argument("--output", type=Path)

    compile_command = subparsers.add_parser(
        "compile", help="compile a hand-authored or cluster-selected catalog"
    )
    compile_command.add_argument("--template", type=Path, required=True)
    compile_command.add_argument("--calibration", type=Path)
    compile_command.add_argument(
        "--simulation-rounds", type=int, default=DEFAULT_SIMULATION_ROUNDS
    )
    compile_command.add_argument("--output", type=Path)

    validate = subparsers.add_parser(
        "validate", help="validate a compiled catalog and rerun its campaign"
    )
    validate.add_argument("catalog", type=Path)
    validate.add_argument(
        "--simulation-rounds", type=int, default=DEFAULT_SIMULATION_ROUNDS
    )
    validate.add_argument("--report", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "derive":
            sources = [
                SourceInput(Path(csv_path), Path(manifest_path))
                for csv_path, manifest_path in args.source
            ]
            stride = args.stride if args.stride is not None else args.window_size
            artifact = derive_calibration(
                sources,
                window_size=args.window_size,
                stride=stride,
                clusters=args.clusters,
            )
            _write_json(args.output, artifact)
            return 0
        if args.command == "compile":
            template = load_json(args.template)
            calibration = load_json(args.calibration) if args.calibration else None
            catalog = compile_catalog(
                template,
                calibration,
                simulation_rounds=args.simulation_rounds,
            )
            _write_json(args.output, catalog)
            return 0
        if args.command == "validate":
            catalog = load_json(args.catalog)
            report = validate_catalog(
                catalog, simulation_rounds=args.simulation_rounds
            )
            _write_json(args.report, report)
            return 0 if report["valid"] else 1
        parser.error("unknown command")
    except CalibratorError as error:
        parser.exit(2, f"error: {error}\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
