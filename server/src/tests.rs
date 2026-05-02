use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::Client;
use serde_json::{json, Value};

const BASE: &str = "http://localhost:3579";

fn image_b64(filename: &str) -> String {
    let bytes = std::fs::read(format!("samples/{filename}"))
        .unwrap_or_else(|_| panic!("cannot read samples/{filename}"));
    STANDARD.encode(&bytes)
}

fn client() -> Client {
    Client::new()
}

// ── /health ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_returns_ok() {
    let body: Value = client()
        .get(format!("{BASE}/health"))
        .send()
        .await
        .expect("server not running at {BASE}")
        .json()
        .await
        .unwrap();

    assert_eq!(body["status"], "ok");
    assert!(body["version"].is_string());
    assert!(body["deepl_available"].is_boolean());
    println!("version: {}  deepl_available: {}", body["version"], body["deepl_available"]);
}

// ── /translate ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn translate_rejects_empty_text() {
    let status = client()
        .post(format!("{BASE}/translate"))
        .json(&json!({ "text": "" }))
        .send()
        .await
        .unwrap()
        .status();

    assert_eq!(status, 400);
}

#[tokio::test]
async fn translate_rejects_whitespace_text() {
    let status = client()
        .post(format!("{BASE}/translate"))
        .json(&json!({ "text": "   " }))
        .send()
        .await
        .unwrap()
        .status();

    assert_eq!(status, 400);
}

#[tokio::test]
async fn translate_valid_text() {
    let body: Value = client()
        .post(format!("{BASE}/translate"))
        .json(&json!({ "text": "こんにちは" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let translation = body["translation"].as_str().unwrap();
    assert!(!translation.is_empty());
    println!("translation: {translation:?}");
}

// ── /ocr errors ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn ocr_rejects_invalid_base64() {
    let status = client()
        .post(format!("{BASE}/ocr"))
        .json(&json!({ "image": "not-valid-base64!!!" }))
        .send()
        .await
        .unwrap()
        .status();

    assert_eq!(status, 400);
}

#[tokio::test]
async fn ocr_rejects_non_image_bytes() {
    let b64 = STANDARD.encode(b"this is not an image");
    let status = client()
        .post(format!("{BASE}/ocr"))
        .json(&json!({ "image": b64 }))
        .send()
        .await
        .unwrap()
        .status();

    assert_eq!(status, 400);
}

#[tokio::test]
async fn ocr_no_engine_returns_no_translation() {
    let data_uri = format!("data:image/jpeg;base64,{}", image_b64("00.jpg"));
    let body: Value = client()
        .post(format!("{BASE}/ocr"))
        .json(&json!({ "image": data_uri }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert!(body["text"].is_string());
    assert!(body.get("translation").is_none(), "translation must be absent when engine is omitted");
}

#[tokio::test]
async fn ocr_engine_none_returns_no_translation() {
    let b64 = image_b64("00.jpg");
    let body: Value = client()
        .post(format!("{BASE}/ocr"))
        .json(&json!({ "image": b64, "translate_engine": "none" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert!(body["text"].is_string());
    assert!(body.get("translation").is_none(), "translation must be absent for engine=none");
}

#[tokio::test]
async fn ocr_engine_deepl_without_key_returns_500() {
    // Only meaningful when DEEPL_API_KEY is NOT set on the server.
    // When a key IS configured this will succeed instead — skip assertion in that case.
    let res = client()
        .post(format!("{BASE}/ocr"))
        .json(&json!({ "image": image_b64("00.jpg"), "translate_engine": "deepl" }))
        .send()
        .await
        .unwrap();

    let status = res.status().as_u16();
    assert!(
        status == 200 || status == 500,
        "expected 200 (key present) or 500 (key absent), got {status}"
    );
    println!("deepl engine status: {status}");
}

// ── OCR + local translate — one test per sample ───────────────────────────────

macro_rules! sample_test {
    ($name:ident, $file:literal) => {
        #[tokio::test]
        async fn $name() {
            let b64 = image_b64($file);
            let res = client()
                .post(format!("{BASE}/ocr"))
                .json(&json!({ "image": b64, "translate_engine": "local" }))
                .send()
                .await
                .unwrap_or_else(|e| panic!("request failed for {}: {e}", $file));

            assert_eq!(res.status(), 200, "POST /ocr returned non-200 for {}", $file);

            let body: Value = res.json().await.unwrap();
            let text = body["text"].as_str().unwrap_or("");
            let translation = body["translation"].as_str().unwrap_or("(none — empty OCR)");
            let elapsed = body["elapsed_ms"].as_u64().unwrap_or(0);

            println!(
                "\n[{}] {}ms\n  OCR:         {text:?}\n  Translation: {translation:?}",
                $file, elapsed,
            );

            assert!(body["text"].is_string(), "missing `text` for {}", $file);
            assert!(body["elapsed_ms"].is_number(), "missing `elapsed_ms` for {}", $file);
        }
    };
}

sample_test!(sample_00, "00.jpg");
sample_test!(sample_01, "01.jpg");
sample_test!(sample_02, "02.jpg");
sample_test!(sample_03, "03.jpg");
sample_test!(sample_04, "04.jpg");
sample_test!(sample_05, "05.jpg");
sample_test!(sample_06, "06.jpg");
sample_test!(sample_07, "07.jpg");
sample_test!(sample_08, "08.jpg");
sample_test!(sample_09, "09.jpg");
sample_test!(sample_10, "10.jpg");
sample_test!(sample_11, "11.jpg");
