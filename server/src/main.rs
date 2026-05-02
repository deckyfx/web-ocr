mod config;
mod db;
mod error;
mod routes;
mod sanitize;
mod services;
mod state;
#[cfg(test)]
mod tests;

use anyhow::Result;
use axum::{routing::{get, post}, Router};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use config::Config;
use services::{
    analyze::AnalyzeService,
    dictionary::{DictionaryMode, DictionaryService},
    ocr::OcrService,
    translate::TranslateService,
};
use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(Config::from_env()?);

    let ocr       = OcrService::new(&config.ocr_models_dir)?;
    let translate = TranslateService::new(&config.translate_models_dir)?;
    let analyze   = Arc::new(AnalyzeService::new()?);
    let dictionary = Arc::new(DictionaryService::load(&config.dict_dir).await?);
    let dict_mode  = DictionaryMode::new(config.dictionary_mode == "local");
    let db = db::connect(&config).await?;

    let http_client = reqwest::Client::new();
    let state = Arc::new(AppState {
        ocr,
        translate,
        analyze,
        dictionary,
        dict_mode,
        db,
        config: config.clone(),
        http_client,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health",          get(routes::health::handler))
        .route("/ocr",             post(routes::ocr::handler))
        .route("/translate",       post(routes::translate::handler))
        .route("/analyze",         post(routes::analyze::handler))
        .route("/dictionary/mode", get(routes::dictionary::get_mode)
                                   .post(routes::dictionary::set_mode))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    info!("Listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
