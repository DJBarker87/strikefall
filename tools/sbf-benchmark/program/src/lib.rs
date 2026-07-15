use solana_account_info::AccountInfo;
use solana_program_entrypoint::{entrypoint, ProgramResult};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

#[cfg(feature = "quote")]
use solana_msg::msg;
#[cfg(feature = "quote")]
use strikefall_core::{one_sided_no_touch, BarrierSide, NoTouchInputs};

entrypoint!(process_instruction);

const INPUT_BYTES: usize = 66;

#[cfg(feature = "quote")]
#[inline(always)]
fn log_compute_units() {
    #[cfg(target_os = "solana")]
    // SAFETY: this is the SVM's parameterless logging syscall. The host build
    // intentionally does nothing because it has no compute meter.
    unsafe {
        solana_msg::syscalls::sol_log_compute_units_();
    }
}

fn fixed(bytes: &[u8]) -> Result<u128, ProgramError> {
    let array: [u8; 16] = bytes
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u128::from_le_bytes(array))
}

fn signed_fixed(bytes: &[u8]) -> Result<i128, ProgramError> {
    let array: [u8; 16] = bytes
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(i128::from_le_bytes(array))
}

/// Measures the exact product-core no-touch quote with no accounts or CPI.
///
/// Data is `spot:u128 | barrier:u128 | variance:u128 | drift:i128 |
/// upper:u8 | already_breached:u8`, all fixed integers little-endian. The
/// baseline build parses the identical payload but excludes the quote feature,
/// providing a linked-size control.
pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() != INPUT_BYTES {
        return Err(ProgramError::InvalidInstructionData);
    }
    let spot = fixed(&instruction_data[0..16])?;
    let barrier = fixed(&instruction_data[16..32])?;
    let remaining_variance = fixed(&instruction_data[32..48])?;
    let drift_per_variance = signed_fixed(&instruction_data[48..64])?;
    let upper = match instruction_data[64] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let already_breached = match instruction_data[65] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    #[cfg(feature = "quote")]
    {
        log_compute_units();
        let quote = one_sided_no_touch(NoTouchInputs {
            spot,
            barrier,
            remaining_variance,
            drift_per_variance,
            side: if upper {
                BarrierSide::Upper
            } else {
                BarrierSide::Lower
            },
            already_breached,
        })
        .map_err(|_| ProgramError::Custom(1))?;
        log_compute_units();
        msg!("quote_succeeded = true");
        core::hint::black_box(quote);
    }

    #[cfg(not(feature = "quote"))]
    core::hint::black_box((
        spot,
        barrier,
        remaining_variance,
        drift_per_variance,
        upper,
        already_breached,
    ));

    Ok(())
}
