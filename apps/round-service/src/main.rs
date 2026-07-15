use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use strikefall_round_service::{router, RoundService};
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let runtime = RoundService::from_environment().await?;
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3_001);
    let host = std::env::var("HOST").map_or_else(
        |_| Ok(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        |value| value.parse::<IpAddr>(),
    )?;
    let address = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    let (shutdown_sender, shutdown_receiver) = watch::channel(false);
    let recovery_worker = runtime.service.spawn_recovery_worker(
        runtime.recovery_interval,
        runtime.recovery_batch_size,
        shutdown_receiver,
    );
    tracing::info!(
        %address,
        deployment = ?runtime.deployment_mode,
        repository = ?runtime.repository_kind,
        verifying_key = %runtime.service.verifying_key_hex(),
        "Strikefall authoritative round service listening"
    );
    let graceful_sender = shutdown_sender.clone();
    let result = axum::serve(
        listener,
        router(runtime.service).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(graceful_sender))
    .await;
    let _ = shutdown_sender.send(true);
    match tokio::time::timeout(Duration::from_secs(10), recovery_worker).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::error!(%error, "lifecycle recovery worker terminated"),
        Err(_) => tracing::warn!("lifecycle recovery worker did not stop within ten seconds"),
    }
    result?;
    Ok(())
}

async fn shutdown_signal(shutdown_sender: watch::Sender<bool>) {
    let interrupt = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to install interrupt handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "failed to install terminate handler");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
    tracing::info!("shutdown signal received; draining HTTP and lifecycle workers");
    let _ = shutdown_sender.send(true);
}
