use solmath::SCALE;

/// Small deterministic generator for reproducible local paths and fixtures.
///
/// This is `SplitMix64`, not a cryptographic RNG. Ranked servers must obtain a
/// secret seed from the operating system and keep it hidden until commit-reveal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    #[must_use]
    pub fn domain(seed: u64, domain: u64) -> Self {
        let mut mixer = Self::new(seed ^ domain.rotate_left(23));
        Self::new(mixer.next_u64())
    }

    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    /// Uniform fixed-point probability strictly inside `(0, SCALE)`.
    #[must_use]
    pub fn open_unit_fixed(&mut self) -> i128 {
        let word = self.next_u64();
        let interior = SCALE - 2;
        let scaled = (u128::from(word) * interior) >> 64;
        i128::try_from(scaled + 1).unwrap_or(solmath::SCALE_I - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix_fixture_is_stable() {
        let mut rng = DeterministicRng::new(42);
        assert_eq!(rng.next_u64(), 13_679_457_532_755_275_413);
        assert_eq!(rng.next_u64(), 2_949_826_092_126_892_291);
    }

    #[test]
    fn inverse_cdf_input_never_reaches_an_endpoint() {
        let mut rng = DeterministicRng::new(7);
        for _ in 0..10_000 {
            let value = rng.open_unit_fixed();
            assert!(value > 0 && value < solmath::SCALE_I);
        }
    }
}
