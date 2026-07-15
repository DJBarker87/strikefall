use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use async_stream::stream;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive};
use axum::response::Sse;
use axum::routing::{get, post};
use axum::{Json, Router};
use strikefall_protocol::{
    CreateRoundRequest, EscapeRequest, FlagUpdateRequest, ReplayVerifiedRequest,
    SignedRoundEventDto,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::{
    CreateSessionRequest, LeaderboardQuery, RenameSessionRequest, RoundService, ServiceError,
    TelemetryBatchRequest, TelemetryConsentRequest, TelemetryMetricsQuery,
};

const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");
const X_REAL_IP: HeaderName = HeaderName::from_static("x-real-ip");

#[derive(Clone, Copy)]
struct ClientIp {
    peer: Option<std::net::IpAddr>,
    forwarded: Option<std::net::IpAddr>,
}

impl ClientIp {
    fn effective(self, service: &RoundService) -> Option<std::net::IpAddr> {
        if service.trust_proxy_headers() {
            self.forwarded.or(self.peer)
        } else {
            self.peer
        }
    }
}

impl<S> FromRequestParts<S> for ClientIp
where
    S: Send + Sync,
{
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(address)| address.ip());
        let forwarded = parts
            .headers
            .get(X_REAL_IP)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        Ok(Self { peer, forwarded })
    }
}

pub fn router(service: RoundService) -> Router {
    let allowed_origin = HeaderValue::from_str(service.allowed_origin()).unwrap_or_else(|error| {
        tracing::warn!(%error, "invalid STRIKEFALL_ALLOWED_ORIGIN; using local preview origin");
        HeaderValue::from_static("http://localhost:4173")
    });
    let cors = CorsLayer::new()
        .allow_origin(allowed_origin)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            LAST_EVENT_ID,
            header::ACCEPT,
        ]);
    Router::new()
        .route("/health", get(health))
        .route("/health/live", get(health))
        .route("/health/ready", get(readiness))
        .route("/v1/decks/{deck_id}/{version}", get(get_deck))
        .route("/v1/sessions", post(create_session))
        .route("/v1/sessions/me", get(get_session))
        .route("/v1/sessions/rename", post(rename_session))
        .route("/v1/sessions/rotate", post(rotate_session))
        .route(
            "/v1/sessions/telemetry-consent",
            post(update_telemetry_consent),
        )
        .route("/v1/solo-rounds", post(create_round))
        .route("/v1/solo-rounds/{round_id}/flag", post(update_flag))
        .route("/v1/solo-rounds/{round_id}/escape", post(escape))
        .route("/v1/solo-rounds/{round_id}/result", get(get_result))
        .route("/v1/solo-rounds/{round_id}/replay", get(get_replay))
        .route(
            "/v1/solo-rounds/{round_id}/replay-verified",
            post(acknowledge_replay),
        )
        .route("/v1/solo-rounds/{round_id}/stream", get(stream_events))
        .route("/v1/leaderboards/{deck_id}", get(get_leaderboard))
        .route("/v1/public-replays/{round_id}", get(get_public_replay))
        .route("/v1/telemetry/batch", post(telemetry_batch))
        .route("/v1/telemetry/metrics", get(telemetry_metrics))
        .layer(DefaultBodyLimit::max(32 * 1_024))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(service)
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn readiness(State(service): State<RoundService>) -> StatusCode {
    match service.readiness().await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(error) => {
            tracing::error!(%error, "readiness check failed");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

async fn get_deck(
    State(service): State<RoundService>,
    Path((deck_id, version)): Path<(String, u16)>,
) -> Result<Json<strikefall_protocol::DeckDto>, ServiceError> {
    service.deck(&deck_id, version).map(Json)
}

async fn create_round(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<CreateRoundRequest>,
) -> Result<(StatusCode, Json<strikefall_protocol::CreateRoundResponse>), ServiceError> {
    service
        .create_round_for_bearer(bearer(&headers)?, client_ip.effective(&service), request)
        .await
        .map(|response| (StatusCode::CREATED, Json(response)))
}

async fn create_session(
    State(service): State<RoundService>,
    client_ip: ClientIp,
    Json(request): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<crate::IssuedSessionDto>), ServiceError> {
    service
        .issue_session(request, client_ip.effective(&service))
        .await
        .map(|response| (StatusCode::CREATED, Json(response)))
}

async fn get_session(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Json<crate::SessionViewDto>, ServiceError> {
    service
        .session_view_for_ip(bearer(&headers)?, client_ip.effective(&service))
        .await
        .map(Json)
}

async fn rename_session(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<RenameSessionRequest>,
) -> Result<Json<crate::SessionViewDto>, ServiceError> {
    service
        .rename_session(bearer(&headers)?, request, client_ip.effective(&service))
        .await
        .map(Json)
}

async fn rotate_session(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Json<crate::IssuedSessionDto>, ServiceError> {
    service
        .rotate_session(bearer(&headers)?, client_ip.effective(&service))
        .await
        .map(Json)
}

async fn update_telemetry_consent(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<TelemetryConsentRequest>,
) -> Result<Json<crate::SessionViewDto>, ServiceError> {
    service
        .update_telemetry_consent(bearer(&headers)?, client_ip.effective(&service), request)
        .await
        .map(Json)
}

async fn update_flag(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<FlagUpdateRequest>,
) -> Result<Json<strikefall_protocol::FlagUpdateResponse>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_flag",
            650,
        )
        .await?;
    service.update_flag(&round_id, request).await.map(Json)
}

async fn escape(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<EscapeRequest>,
) -> Result<Json<strikefall_protocol::EscapeResponse>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_escape",
            30,
        )
        .await?;
    service.escape(&round_id, request).await.map(Json)
}

async fn get_result(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Json<strikefall_protocol::RoundResultResponse>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_result",
            120,
        )
        .await?;
    service.result(&round_id).await.map(Json)
}

async fn get_replay(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Json<strikefall_protocol::ReplayBundleDto>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_replay",
            30,
        )
        .await?;
    service.replay(&round_id).await.map(Json)
}

async fn acknowledge_replay(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<ReplayVerifiedRequest>,
) -> Result<Json<strikefall_protocol::ReplayVerifiedResponse>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_replay_ack",
            30,
        )
        .await?;
    service
        .acknowledge_replay(&round_id, request)
        .await
        .map(Json)
}

async fn stream_events(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ServiceError> {
    service
        .authorize_round_bearer(
            bearer(&headers)?,
            client_ip.effective(&service),
            &round_id,
            "round_stream",
            30,
        )
        .await?;
    let last_event_id = headers
        .get(LAST_EVENT_ID)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| {
                    ServiceError::InvalidRequest(
                        "Last-Event-ID must be an event sequence".to_owned(),
                    )
                })
        })
        .transpose()?;
    let mut receiver = service.subscribe();
    let snapshot = service.event_snapshot(&round_id).await?;
    if last_event_id.is_some_and(|last| snapshot.last().is_none_or(|event| last > event.sequence)) {
        return Err(ServiceError::InvalidRequest(
            "Last-Event-ID is ahead of the durable stream".to_owned(),
        ));
    }
    let mut next_sequence = snapshot
        .last()
        .map_or(0, |event| event.sequence.saturating_add(1));
    let event_stream = stream! {
        for event in snapshot {
            if last_event_id.is_none_or(|last| event.sequence > last) {
                yield Ok(sse_event(&event));
            }
        }
        loop {
            match receiver.recv().await {
                Ok(envelope) if envelope.round_id == round_id && envelope.event.sequence >= next_sequence => {
                    next_sequence = envelope.event.sequence.saturating_add(1);
                    yield Ok(sse_event(&envelope.event));
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("strikefall-keep-alive"),
    ))
}

async fn get_public_replay(
    State(service): State<RoundService>,
    Path(round_id): Path<String>,
    client_ip: ClientIp,
) -> Result<Json<crate::PublicReplayResponseDto>, ServiceError> {
    service
        .public_replay(&round_id, client_ip.effective(&service))
        .await
        .map(Json)
}

async fn get_leaderboard(
    State(service): State<RoundService>,
    Path(deck_id): Path<String>,
    Query(query): Query<LeaderboardQuery>,
    headers: HeaderMap,
    client_ip: ClientIp,
) -> Result<Json<crate::LeaderboardResponse>, ServiceError> {
    service
        .leaderboard(
            bearer(&headers)?,
            client_ip.effective(&service),
            &deck_id,
            query,
        )
        .await
        .map(Json)
}

async fn telemetry_batch(
    State(service): State<RoundService>,
    headers: HeaderMap,
    client_ip: ClientIp,
    Json(request): Json<TelemetryBatchRequest>,
) -> Result<Json<crate::TelemetryBatchResponse>, ServiceError> {
    service
        .ingest_telemetry(bearer(&headers)?, client_ip.effective(&service), request)
        .await
        .map(Json)
}

async fn telemetry_metrics(
    State(service): State<RoundService>,
    Query(query): Query<TelemetryMetricsQuery>,
    headers: HeaderMap,
) -> Result<Json<crate::TelemetryMetricsResponse>, ServiceError> {
    service
        .telemetry_metrics(bearer(&headers)?, query)
        .await
        .map(Json)
}

fn bearer(headers: &HeaderMap) -> Result<&str, ServiceError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or(ServiceError::Unauthorized("missing bearer token"))?;
    Ok(value)
}

fn sse_event(event: &SignedRoundEventDto) -> Event {
    Event::default()
        .id(event.sequence.to_string())
        .event("round_event")
        .data(serde_json::to_string(event).expect("signed event is serializable"))
}
