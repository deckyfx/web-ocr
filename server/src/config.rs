use anyhow::{Context, Result};
use std::path::PathBuf;

pub struct Config {
    pub port: u16,
    pub ocr_models_dir: PathBuf,
    pub translate_models_dir: PathBuf,
    pub dict_dir: PathBuf,
    pub database_url: String,
    pub deepl_api_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        Ok(Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3579".to_string())
                .parse()
                .context("PORT must be a valid number")?,

            ocr_models_dir: PathBuf::from(
                std::env::var("OCR_MODELS_DIR").unwrap_or_else(|_| "./models/ocr".to_string()),
            ),

            translate_models_dir: PathBuf::from(
                std::env::var("TRANSLATE_MODELS_DIR")
                    .unwrap_or_else(|_| "./models/translate".to_string()),
            ),

            dict_dir: PathBuf::from(
                std::env::var("DICT_DIR").unwrap_or_else(|_| "./models/jdict".to_string()),
            ),

            database_url: std::env::var("DATABASE_URL").unwrap_or_else(|_| "ocr.db".to_string()),

            deepl_api_key: std::env::var("DEEPL_API_KEY").ok().filter(|s| !s.is_empty()),
        })
    }
}
