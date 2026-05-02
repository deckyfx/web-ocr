use anyhow::{Context, Result};
use image::DynamicImage;
use ort::{session::Session, value::{Tensor, TensorRef}};
use std::{path::Path, sync::Mutex};
use tracing::info;

const BOS_TOKEN: i64 = 2;
const EOS_TOKEN: i64 = 3;
const MAX_LENGTH: usize = 300;
const SPECIAL_TOKEN_CUTOFF: i64 = 14;

pub struct OcrService {
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
    vocab: Vec<String>,
}

impl OcrService {
    pub fn new(model_dir: &Path) -> Result<Self> {
        info!("Loading OCR models from {:?}", model_dir);

        let encoder = Session::builder()
            .context("Failed to create ORT session builder")?
            .commit_from_file(model_dir.join("encoder_model.onnx"))
            .context("Failed to load encoder_model.onnx")?;

        let decoder = Session::builder()
            .context("Failed to create ORT session builder")?
            .commit_from_file(model_dir.join("decoder_model.onnx"))
            .context("Failed to load decoder_model.onnx")?;

        let vocab = Self::load_vocab(model_dir.join("vocab.txt"))?;

        let enc_inputs: Vec<_> = encoder.inputs().iter().map(|i| i.name()).collect();
        let enc_outputs: Vec<_> = encoder.outputs().iter().map(|o| o.name()).collect();
        let dec_inputs: Vec<_> = decoder.inputs().iter().map(|i| i.name()).collect();
        let dec_outputs: Vec<_> = decoder.outputs().iter().map(|o| o.name()).collect();
        info!("Encoder inputs:  {:?}", enc_inputs);
        info!("Encoder outputs: {:?}", enc_outputs);
        info!("Decoder inputs:  {:?}", dec_inputs);
        info!("Decoder outputs: {:?}", dec_outputs);
        info!("Vocab size: {}", vocab.len());

        Ok(Self {
            encoder: Mutex::new(encoder),
            decoder: Mutex::new(decoder),
            vocab,
        })
    }

    pub fn recognize(&self, img: &DynamicImage) -> Result<String> {
        let (pixel_data, pixel_shape) = Self::preprocess(img);

        // Run encoder — copy output immediately so we can release the lock
        let (hidden_shape, hidden_data): (Vec<i64>, Vec<f32>) = {
            let pixel_tensor = Tensor::<f32>::from_array((pixel_shape, pixel_data))
                .context("Failed to create pixel_values tensor")?;

            let mut enc = self.encoder.lock().unwrap();
            let enc_out = enc
                .run(ort::inputs!["pixel_values" => pixel_tensor])
                .context("Encoder inference failed")?;

            let (shape, data) = enc_out["last_hidden_state"]
                .try_extract_tensor::<f32>()
                .context("Failed to extract encoder output")?;

            (shape.to_vec(), data.to_vec())
            // enc_out and enc guard drop here → mutex released
        };

        // Greedy decode
        let mut tokens: Vec<i64> = vec![BOS_TOKEN];
        let mut dec = self.decoder.lock().unwrap();

        while tokens.len() < MAX_LENGTH {
            let seq_len = tokens.len();

            let input_ids = Tensor::<i64>::from_array(([1usize, seq_len], tokens.clone()))
                .context("Failed to build input_ids tensor")?;

            let hidden_ref =
                TensorRef::<f32>::from_array_view((hidden_shape.as_slice(), hidden_data.as_slice()))
                    .context("Failed to create encoder_hidden_states tensor")?;

            let dec_out = dec
                .run(ort::inputs![
                    "input_ids"             => input_ids,
                    "encoder_hidden_states" => hidden_ref
                ])
                .context("Decoder inference failed")?;

            // logits shape: [1, seq_len, vocab_size]
            let (logits_shape, logits_data) = dec_out["logits"]
                .try_extract_tensor::<f32>()
                .context("Failed to extract logits")?;

            let vocab_size = logits_shape[2] as usize;
            let last_row = (seq_len - 1) * vocab_size;
            let last_logits = &logits_data[last_row..last_row + vocab_size];

            let next_token = last_logits
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(i, _)| i as i64)
                .unwrap_or(EOS_TOKEN);

            if next_token == EOS_TOKEN {
                break;
            }
            tokens.push(next_token);
        }

        Ok(self.detokenize(&tokens))
    }

    /// Converts image to grayscale, resizes to fit within 224×224 preserving aspect ratio,
    /// centers on a white 224×224 canvas, and returns flat CHW float data normalised to [-1, 1].
    /// Dark-background images (white text on black) are inverted so text is dark on white,
    /// matching the training distribution of manga-ocr.
    fn preprocess(img: &DynamicImage) -> (Vec<f32>, [usize; 4]) {
        use image::imageops;

        let mut gray = img.to_luma8();
        let (w, h) = (gray.width(), gray.height());

        // Invert if background is dark (mean brightness below midpoint)
        let sum: u64 = gray.pixels().map(|p| p.0[0] as u64).sum();
        let mean = sum as f64 / (w * h) as f64;
        if mean < 127.0 {
            imageops::invert(&mut gray);
        }

        // Scale to fit within 224×224 preserving aspect ratio
        let scale = 224.0 / w.max(h) as f64;
        let scaled_w = ((w as f64 * scale) as u32).max(1);
        let scaled_h = ((h as f64 * scale) as u32).max(1);
        let resized = imageops::resize(&gray, scaled_w, scaled_h, imageops::FilterType::Lanczos3);
        let resized_raw = resized.as_raw();

        // Place centered on a white 224×224 canvas using raw Vec arithmetic
        let x_off = ((224 - scaled_w) / 2) as usize;
        let y_off = ((224 - scaled_h) / 2) as usize;
        let mut canvas = vec![255u8; 224 * 224];
        for row in 0..scaled_h as usize {
            let src_start = row * scaled_w as usize;
            let dst_start = (row + y_off) * 224 + x_off;
            canvas[dst_start..dst_start + scaled_w as usize]
                .copy_from_slice(&resized_raw[src_start..src_start + scaled_w as usize]);
        }

        // Normalise to [-1, 1] and replicate across 3 channels (CHW layout)
        let mut data = vec![0f32; 3 * 224 * 224];
        for i in 0..224 * 224 {
            let v = (canvas[i] as f32 / 255.0 - 0.5) / 0.5;
            data[i] = v;
            data[224 * 224 + i] = v;
            data[2 * 224 * 224 + i] = v;
        }
        (data, [1, 3, 224, 224])
    }

    fn load_vocab(path: impl AsRef<Path>) -> Result<Vec<String>> {
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read vocab.txt at {:?}", path.as_ref()))?;
        Ok(content.lines().map(|l| l.to_string()).collect())
    }

    fn detokenize(&self, tokens: &[i64]) -> String {
        tokens
            .iter()
            .filter(|&&id| id > SPECIAL_TOKEN_CUTOFF)
            .filter_map(|&id| self.vocab.get(id as usize))
            .map(|token| token.strip_prefix("##").unwrap_or(token.as_str()))
            .collect()
    }
}
