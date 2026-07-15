use serde_json::{json, Value};
use strikefall_wasm::{
    barrier_for_survival_fixed, deck_catalog_json, generate_round_path_json,
    lock_lobby_scores_json, quote_no_touch_json,
};

fn parsed(json: String) -> Value {
    serde_json::from_str(&json).expect("WASM boundary must emit valid JSON")
}

fn main() {
    let quote_input = json!({
        "alreadyBreached": false,
        "barrier": "110000000000000",
        "driftPerVariance": "-500000000000",
        "remainingVariance": "6400000000",
        "side": "upper",
        "spot": "100000000000000"
    });
    let barrier_input = json!({
        "driftPerVariance": "-500000000000",
        "remainingVariance": "6400000000",
        "side": "upper",
        "spot": "100000000000000",
        "targetSurvival": "450000000000"
    });
    let path_input = json!({
        "deckId": "balanced_tape",
        "deckVersion": 3,
        "initialSpot": "100000000000000",
        "seed": "3405691582"
    });
    let lobby_input = json!({
        "driftPerVariance": "-500000000000",
        "placements": [
            { "barrier": "110000000000000", "contenderId": 1, "side": "upper" },
            { "barrier": "110500000000000", "contenderId": 2, "side": "upper" },
            { "barrier": "91000000000000", "contenderId": 3, "side": "lower" }
        ],
        "remainingVariance": "6400000000",
        "spot": "100000000000000"
    });
    let placements =
        serde_json::to_string(&lobby_input["placements"]).expect("lobby inputs must serialize");

    let vectors = json!({
        "expected": {
            "barrierSolve": barrier_for_survival_fixed(
                barrier_input["spot"].as_str().unwrap(),
                barrier_input["targetSurvival"].as_str().unwrap(),
                barrier_input["remainingVariance"].as_str().unwrap(),
                barrier_input["driftPerVariance"].as_str().unwrap(),
                barrier_input["side"].as_str().unwrap(),
            ).expect("barrier golden must solve"),
            "deckCatalog": parsed(deck_catalog_json().expect("deck catalog must serialize")),
            "lobbyScores": parsed(lock_lobby_scores_json(
                lobby_input["spot"].as_str().unwrap(),
                lobby_input["remainingVariance"].as_str().unwrap(),
                lobby_input["driftPerVariance"].as_str().unwrap(),
                &placements,
            ).expect("lobby golden must score")),
            "noTouchQuote": parsed(quote_no_touch_json(
                quote_input["spot"].as_str().unwrap(),
                quote_input["barrier"].as_str().unwrap(),
                quote_input["remainingVariance"].as_str().unwrap(),
                quote_input["driftPerVariance"].as_str().unwrap(),
                quote_input["side"].as_str().unwrap(),
                quote_input["alreadyBreached"].as_bool().unwrap(),
            ).expect("quote golden must price")),
            "roundPath": parsed(generate_round_path_json(
                path_input["deckId"].as_str().unwrap(),
                path_input["deckVersion"].as_u64().unwrap() as u16,
                path_input["seed"].as_str().unwrap(),
                path_input["initialSpot"].as_str().unwrap(),
            ).expect("path golden must replay"))
        },
        "inputs": {
            "barrierSolve": barrier_input,
            "lobbyScores": lobby_input,
            "noTouchQuote": quote_input,
            "roundPath": path_input
        },
        "schemaVersion": 1
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&vectors).expect("golden vectors must serialize")
    );
}
