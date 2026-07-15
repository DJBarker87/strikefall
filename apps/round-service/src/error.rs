use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use strikefall_protocol::ApiErrorDto;
use thiserror::Error;

use crate::RepositoryError;

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("round not found")]
    NotFound,
    #[error("authentication required: {0}")]
    Unauthorized(&'static str),
    #[error("request is not permitted: {0}")]
    Forbidden(&'static str),
    #[error("request conflicts with a newer round revision")]
    Conflict,
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("round is not in the required phase: {0}")]
    InvalidState(&'static str),
    #[error("placement input is frozen")]
    InputFrozen,
    #[error("flag updates are limited; retry in {0} ms")]
    RateLimited(u64),
    #[error("request rate limit reached; retry in {0} ms")]
    AbuseRateLimited(u64),
    #[error("deterministic round computation failed: {0}")]
    Computation(String),
    #[error("repository failure: {0}")]
    Repository(#[from] RepositoryError),
    #[error("cryptographically secure randomness is unavailable")]
    RandomUnavailable,
}

impl From<strikefall_protocol::ProtocolError> for ServiceError {
    fn from(value: strikefall_protocol::ProtocolError) -> Self {
        Self::Computation(value.to_string())
    }
}

impl From<strikefall_core::CoreError> for ServiceError {
    fn from(value: strikefall_core::CoreError) -> Self {
        Self::Computation(value.to_string())
    }
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let internal = matches!(
            &self,
            Self::Computation(_) | Self::Repository(_) | Self::RandomUnavailable
        );
        if internal {
            tracing::error!(error = %self, "internal round service request failure");
        }
        let (status, code, retry_after_ms) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, "round_not_found", None),
            Self::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized", None),
            Self::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden", None),
            Self::Conflict => (StatusCode::CONFLICT, "revision_conflict", None),
            Self::InvalidRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request", None),
            Self::InvalidState(_) => (StatusCode::CONFLICT, "invalid_round_state", None),
            Self::InputFrozen => (StatusCode::LOCKED, "input_frozen", None),
            Self::RateLimited(wait) => (
                StatusCode::TOO_MANY_REQUESTS,
                "flag_rate_limited",
                Some(*wait),
            ),
            Self::AbuseRateLimited(wait) => {
                (StatusCode::TOO_MANY_REQUESTS, "rate_limited", Some(*wait))
            }
            Self::Computation(_) | Self::Repository(_) | Self::RandomUnavailable => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_round_error",
                None,
            ),
        };
        let payload = ApiErrorDto {
            code: code.to_owned(),
            message: if internal {
                "internal round service error".to_owned()
            } else {
                self.to_string()
            },
            retry_after_ms,
        };
        (status, Json(payload)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use axum::response::IntoResponse;

    use super::ServiceError;
    use crate::RepositoryError;

    #[tokio::test]
    async fn internal_failures_do_not_cross_the_http_boundary() {
        let response = ServiceError::Repository(RepositoryError::Backend(
            "database detail that must remain private".to_owned(),
        ))
        .into_response();
        let body = to_bytes(response.into_body(), 4_096)
            .await
            .expect("error response body");
        let text = String::from_utf8(body.to_vec()).expect("UTF-8 error body");
        assert!(text.contains("internal round service error"));
        assert!(!text.contains("database detail"));
    }
}
