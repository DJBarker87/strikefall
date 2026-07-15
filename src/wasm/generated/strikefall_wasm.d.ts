/* tslint:disable */
/* eslint-disable */
/**
 * Returns all launch decks. Fixed-point fields are decimal strings.
 */
export function deck_catalog_json(): string;
/**
 * Replays a complete approach and battle from a decimal u64 seed.
 */
export function generate_round_path_json(deck_id: string, deck_version: number, seed: string, initial_spot: string): string;
/**
 * Replays the canonical battle stream from an exact starting spot. This is
 * the same generator used by ranked rounds and is exposed separately for
 * local calibration campaigns that must not synthesize paths in JavaScript.
 */
export function generate_battle_path_json(deck_id: string, deck_version: number, seed: string, initial_spot: string): string;
/**
 * Returns exact remaining integrated variance after a canonical microstep.
 */
export function remaining_variance_fixed(deck_id: string, deck_version: number, completed_steps: number): string;
/**
 * Continuous no-touch quote. All SCALE-valued inputs and outputs are strings.
 */
export function quote_no_touch_json(spot: string, barrier: string, remaining_variance: string, drift_per_variance: string, side: string, already_breached: boolean): string;
/**
 * Finds a barrier for a target survival probability.
 */
export function barrier_for_survival_fixed(spot: string, target_survival: string, remaining_variance: string, drift_per_variance: string, side: string): string;
/**
 * Locks a full lobby atomically, including same-side crowding.
 */
export function lock_lobby_scores_json(spot: string, remaining_variance: string, drift_per_variance: string, placements_json: string): string;
/**
 * Verifies the complete authoritative ranked-v3 replay against the immutable
 * commitment and server-key values captured by the browser at round creation.
 *
 * This deliberately delegates to the same Rust verifier used by the service
 * and replay-inspector CLI: path, bots, scores, Escape decisions, event
 * semantics, digest chain, and signatures must all regenerate exactly.
 */
export function verify_ranked_replay_json(replay_json: string, expected_commitment: string, expected_server_key: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly deck_catalog_json: (a: number) => void;
  readonly generate_round_path_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly generate_battle_path_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly remaining_variance_fixed: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly quote_no_touch_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void;
  readonly barrier_for_survival_fixed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
  readonly lock_lobby_scores_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly verify_ranked_replay_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
