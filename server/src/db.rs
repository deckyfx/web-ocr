use anyhow::Result;
use turso::Connection;
use tracing::{info, warn};

use crate::config::Config;

pub async fn connect(config: &Config) -> Result<Connection> {
    if config.database_url.starts_with("libsql://") || config.database_url.starts_with("https://") {
        warn!(
            "Remote Turso URL '{}' is not supported by the turso crate yet; \
             falling back to local 'ocr.db'",
            config.database_url
        );
    }

    let path = if config.database_url.starts_with("libsql://")
        || config.database_url.starts_with("https://")
    {
        "ocr.db"
    } else {
        &config.database_url
    };

    info!("Opening local database: {}", path);
    let db = turso::Builder::new_local(path).build().await?;
    let conn = db.connect()?;
    migrate(&conn).await?;
    Ok(conn)
}

async fn migrate(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ocr_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            text        TEXT    NOT NULL,
            translation TEXT,
            target_lang TEXT,
            elapsed_ms  INTEGER,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )",
        (),
    )
    .await?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS translate_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_text TEXT    NOT NULL,
            translated  TEXT    NOT NULL,
            target_lang TEXT    NOT NULL,
            elapsed_ms  INTEGER,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        )",
        (),
    )
    .await?;

    info!("Database migration done");
    Ok(())
}

pub async fn log_ocr(
    conn: &Connection,
    text: &str,
    translation: Option<&str>,
    target_lang: Option<&str>,
    elapsed_ms: u64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ocr_logs (text, translation, target_lang, elapsed_ms)
         VALUES (?1, ?2, ?3, ?4)",
        (text, translation, target_lang, elapsed_ms as i64),
    )
    .await?;
    Ok(())
}

pub async fn log_translate(
    conn: &Connection,
    source: &str,
    translated: &str,
    target_lang: &str,
    elapsed_ms: u64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO translate_logs (source_text, translated, target_lang, elapsed_ms)
         VALUES (?1, ?2, ?3, ?4)",
        (source, translated, target_lang, elapsed_ms as i64),
    )
    .await?;
    Ok(())
}
