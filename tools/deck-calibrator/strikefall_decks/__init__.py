"""Deterministic offline calibration tools for Strikefall regime decks."""

from .calibrator import (
    CalibratorError,
    compile_catalog,
    derive_calibration,
    validate_catalog,
)

__all__ = [
    "CalibratorError",
    "compile_catalog",
    "derive_calibration",
    "validate_catalog",
]

__version__ = "1.0.0"
