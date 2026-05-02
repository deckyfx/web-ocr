use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageEncoder;

/// Capture the primary monitor and return base64-encoded PNG bytes.
pub fn capture_full_screen() -> Result<String> {
    let monitors = xcap::Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors.into_iter().find(|m| m.is_primary().unwrap_or(false)).or_else(|| {
        xcap::Monitor::all().ok()?.into_iter().next()
    }).context("No monitor found")?;

    let img = monitor.capture_image().context("Screen capture failed")?;

    let mut png = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut png);
    enc.write_image(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ColorType::Rgba8.into(),
    )
    .context("PNG encode failed")?;

    Ok(STANDARD.encode(&png))
}

/// Crop a region from raw PNG bytes and return base64-encoded PNG.
pub fn crop_png(png_bytes: &[u8], x: u32, y: u32, width: u32, height: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(png_bytes).context("Failed to decode captured PNG")?;
    let cropped = image::imageops::crop_imm(&img.to_rgba8(), x, y, width, height).to_image();

    let mut out = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut out);
    enc.write_image(
        cropped.as_raw(),
        cropped.width(),
        cropped.height(),
        image::ColorType::Rgba8.into(),
    )
    .context("PNG encode failed")?;

    Ok(out)
}
