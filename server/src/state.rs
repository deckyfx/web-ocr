use std::sync::Arc;
use turso::Connection;

use crate::{
    config::Config,
    services::{
        analyze::AnalyzeService,
        dictionary::{DictionaryMode, DictionaryService},
        ocr::OcrService,
        translate::TranslateService,
    },
};

pub struct AppState {
    pub ocr: OcrService,
    pub translate: TranslateService,
    pub analyze: Arc<AnalyzeService>,
    pub dictionary: Arc<DictionaryService>,
    pub dict_mode: DictionaryMode,
    pub db: Connection,
    pub config: Arc<Config>,
    pub http_client: reqwest::Client,
}
