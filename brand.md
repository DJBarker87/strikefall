# Strikefall brand system

Strikefall is a storm-dark arcade survival game: tense and technical in the
arena, but never styled like a brokerage terminal. The visual promise is
**plant · outlast · repeat**.

## Colour

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Storm | `--bg` / `--bg-deep` | `#06100e` / `#030706` | Page and arena depth |
| Raised slate | `--surface` / `--surface-raised` | `#0a1714` / `#10221e` | Panels and controls |
| Signal lime | `--primary` | `#c7f36b` | Player agency, primary actions, focus |
| Strike orange | `--strike` | `#ff7447` | The live path and hot moments |
| Impact red | `--danger` | `#ff5f66` | Touches and elimination only |
| Safe mint | `--success` | `#65e3aa` | Survival and verified states |
| Pressure gold | `--warning` | `#f4cc58` | Timing and caution |
| Storm violet | `--violet` | `#ab8cff` | Rare supporting accent |

Deck hues are procedural accents inside this system. Colour is never the only
state cue: flags retain shapes, labels, BOT markers, icons, and text outcomes.

## Type and shape

- Display: condensed system sans (`Arial Narrow`, `Avenir Next Condensed`,
  `Roboto Condensed`) in uppercase with wide tracking.
- Interface: `Avenir Next` / `Segoe UI Variable` system stack for fast offline
  rendering and no font dependency.
- Proof and data: `SFMono-Regular` / `Cascadia Code` / `Roboto Mono`.
- Compact controls use pill geometry; game/result panels use 14–22 px corners.
- The lightning-strike mark is constructed in CSS and is paired with the
  uppercase wordmark. PWA icons use the same lime-on-storm silhouette.

## Image and motion direction

The arena uses layered radial storm light, a faint tactical grid, short glowing
line trails, crowd haze, pennants, ordered impact bursts, and deck-specific
pressure bands. Dramatic effects belong to state changes—lock, strike, cluster
wipe, last-human beat, and result—not ambient decoration. Reduced-motion and
lower-flash preferences must preserve timing and meaning while suppressing
camera and burst intensity.

## Voice

Use short, physical verbs: **read, plant, hold, strike, escape, bank, rematch**.
Explain risk as danger, distance, crowding, and survival. Keep option language
inside optional proof/details. Bots are always plainly labelled; points are
always described as non-redeemable.

Primary player copy: **Plant outside. Survive the strike.**

Developer copy: **A deterministic first-passage game engine built on SolMath.**
