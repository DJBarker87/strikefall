# strikefall-protocol

Shared serde types and deterministic verification for ranked Strikefall rounds.
All SolMath-scaled integers are decimal strings on the wire, avoiding JavaScript
precision loss.

## Ranked replay schema

Authoritative rounds use the explicit marker `strikefall/ranked-replay/v3`.
That schema is deliberately different from the browser's local-practice
`strikefall/replay/v4` recipe: ranked decks and paths are SolMath fixed-point
values, each signed 250 ms path frame preserves its close and committed
Brownian-bridge interval high/low, and server bot decisions carry independently
reproducible audit records. Event `type` values are
snake_case and their nested `data` fields are camelCase.

The commitment uses algorithm marker `SHA-256`, key-sorted canonical JSON,
domain-separated path and bot seeds, and the ranked-only bot-root v2 profile.
The pre-round commitment fields remain `protocolVersion`, `algorithm`,
`roundId`, `deckDigest`, `pathDigest`, `botRootDigest`, and `salt`.

Bot placement and Escape audits are deterministic from the revealed bot root
and public state. Each labelled rival has one to three moves in the final
12-second placement window, a 250–1,500 ms reaction delay, and a replay record
containing every fixed-point candidate utility, selected candidate, reason, and
public-state digest. The public snapshot is reconstructed at the signed
observation timestamp, exactly one reaction delay before the action. Future
decisions are not appended to the signed stream until their canonical due time.
The Escape policy API accepts the public line, step, deck,
locked scores, prior touches, and prior escapes; it cannot accept a hidden path
or path seed. Verification regenerates every audit after the reveal.

Unlike practice bundles, the server never reveals its master secret. It reveals
only the round-specific path seed, bot root, salt, and digests after resolution.

`verify_replay_bundle_against` accepts a trusted pre-round commitment and server
public key. Use those anchors for ranked authenticity; verification without them
checks deterministic internal consistency only.
