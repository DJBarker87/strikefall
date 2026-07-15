# Strikefall share-clip target-device checklist

Status: engineering automation complete; physical-device checks remain unclaimed.

The browser suite proves that Chromium produces independently finalized,
decodable `720×1280` Story, `720×720` Square, and `1280×720` Wide clips with
finite intrinsic durations between 8 and 12 seconds, and that static cards
render at exact `1080×1920`, `1080×1080`, or `1920×1080` dimensions. A keyed
retained candidate binds an exported cluster wipe, late-hit near miss, Escape,
or held-survivor near miss to the matching live window; a missing candidate
falls back to a static card rather than a temporally unrelated clip. Held near
misses use a bounded live replacement slot keyed to the final authoritative
closest-approach step while replay-v4's public wire shape stays unchanged.
Reduced motion makes every format static and never starts the video encoder.
Unit tests prove the layouts contain the branded arena plus public deck, multiplier, labelled
bot field, result, and moment overlays. Those signals do not substitute for a
person sharing from a physical phone.

## Target matrix

- [ ] Current iPhone Safari: Story clip via the native share sheet
- [ ] Current iPhone Safari: Square clip via the native share sheet
- [ ] Current iPhone Safari: Wide clip or explicit static-card fallback via
  share sheet/download
- [ ] Current Android Chrome: Story clip via the native share sheet
- [ ] Current Android Chrome: Square clip via the native share sheet
- [ ] Current Android Chrome: Wide clip or explicit static-card fallback via
  share sheet/download
- [ ] macOS Safari: supported Story/Square/Wide clip or explicit static-card
  fallback
- [ ] Windows/macOS Chrome: Story/Square/Wide download fallback when file Web
  Share is unavailable
- [ ] Reduced-motion iOS and Android: all three formats are static PNG only

## Run on each target

1. Set Motion to **Full effects**, finish a practice round, and open **Share result**.
2. Export **Story**. Confirm the file opens, plays, is 9:16, lasts 8–12 seconds,
   and shows the named live moment. A result-tail clip is acceptable only when
   the selected story itself is the result tail.
3. Confirm the visible overlay contains only Strikefall branding, deck,
   multiplier, bot count, result, and named moment. It must not contain a seed,
   proof digest, bearer token, or round ID.
4. Repeat with **Square** and confirm a 1:1 playable file.
5. Choose **Wide**. On a supported full-effects browser, confirm a playable
   `1280×720` 16:9 clip between 8 and 12 seconds. If encoding is unavailable,
   confirm an explicit `1920×1080` PNG fallback instead—never a wrong moment.
6. Finish a held-survivor near miss and confirm the named clip shows the closest
   approach, not the first threshold crossing or the later result screen.
7. Confirm a supported device opens its native share sheet; cancel once and
   verify cancellation returns to the dialog without an error.
8. Disable file sharing or use an unsupported browser and confirm all three
   formats download instead.
9. Set Motion to **Reduce motion**. Confirm the dialog promises a static card,
   no video encoder starts, and Story/Square/Wide export as PNG at their exact
   declared dimensions.
10. Leave the result screen open for two minutes. Confirm the camera/recording
   indicator is off and device temperature does not keep climbing; encoders and
   media tracks should have frozen after the short result tail.
11. Repeat once offline. Local export must still work; no ranked or replay
   endpoint should be contacted.
12. Verify VoiceOver/TalkBack can announce Format, Story, Square, Wide, export
    status, and Back to result; verify 200% zoom and landscape do not hide an
    action.

Record device model, OS/browser version, chosen format, resulting MIME type,
dimensions, approximate duration, share target, and pass/fail notes. Only check
a box above after that evidence exists.
