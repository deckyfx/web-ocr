use anyhow::{Context, Result};
use ort::{session::Session, value::{Tensor, TensorRef}};
use std::{path::Path, sync::Mutex};
use tokenizers::Tokenizer;
use tracing::info;

const EOS_TOKEN: i64 = 0;    // </s>
const PAD_TOKEN: i64 = 60715; // <pad> — decoder start token for MarianMT/OPUS-MT
const MAX_LENGTH: usize = 512;

pub struct TranslateService {
    encoder: Mutex<Session>,
    decoder: Mutex<Session>,
    tokenizer: Tokenizer,
}

impl TranslateService {
    pub fn new(model_dir: &Path) -> Result<Self> {
        info!("Loading translation models from {:?}", model_dir);

        let encoder = Session::builder()
            .context("Failed to create ORT session builder")?
            .commit_from_file(model_dir.join("encoder_model.onnx"))
            .context("Failed to load translation encoder_model.onnx")?;

        let decoder = Session::builder()
            .context("Failed to create ORT session builder")?
            .commit_from_file(model_dir.join("decoder_model.onnx"))
            .context("Failed to load translation decoder_model.onnx")?;

        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("Failed to load tokenizer: {e}"))?;

        let enc_inputs: Vec<_> = encoder.inputs().iter().map(|i| i.name()).collect();
        let enc_outputs: Vec<_> = encoder.outputs().iter().map(|o| o.name()).collect();
        let dec_inputs: Vec<_> = decoder.inputs().iter().map(|i| i.name()).collect();
        let dec_outputs: Vec<_> = decoder.outputs().iter().map(|o| o.name()).collect();
        info!("Translate encoder inputs:  {:?}", enc_inputs);
        info!("Translate encoder outputs: {:?}", enc_outputs);
        info!("Translate decoder inputs:  {:?}", dec_inputs);
        info!("Translate decoder outputs: {:?}", dec_outputs);

        Ok(Self {
            encoder: Mutex::new(encoder),
            decoder: Mutex::new(decoder),
            tokenizer,
        })
    }

    pub fn translate(&self, text: &str) -> Result<String> {
        // Tokenize — post_processor appends </s> automatically
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {e}"))?;

        let input_ids: Vec<i64> =
            encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> =
            encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
        let enc_len = input_ids.len();

        // Run encoder — copy output and release lock
        let (hidden_shape, hidden_data): (Vec<i64>, Vec<f32>) = {
            let ids_tensor =
                Tensor::<i64>::from_array(([1usize, enc_len], input_ids))
                    .context("Failed to create encoder input_ids tensor")?;
            let mask_tensor =
                Tensor::<i64>::from_array(([1usize, enc_len], attention_mask.clone()))
                    .context("Failed to create encoder attention_mask tensor")?;

            let mut enc = self.encoder.lock().unwrap();
            let enc_out = enc
                .run(ort::inputs![
                    "input_ids"      => ids_tensor,
                    "attention_mask" => mask_tensor
                ])
                .context("Translation encoder inference failed")?;

            let (shape, data) = enc_out["last_hidden_state"]
                .try_extract_tensor::<f32>()
                .context("Failed to extract encoder hidden states")?;

            (shape.to_vec(), data.to_vec())
        };

        // Greedy decode — start with <pad> as the BOS token
        let mut tokens: Vec<i64> = vec![PAD_TOKEN];
        let mut dec = self.decoder.lock().unwrap();

        while tokens.len() < MAX_LENGTH {
            let dec_len = tokens.len();

            let dec_ids =
                Tensor::<i64>::from_array(([1usize, dec_len], tokens.clone()))
                    .context("Failed to create decoder input_ids")?;
            let hidden_ref =
                TensorRef::<f32>::from_array_view((hidden_shape.as_slice(), hidden_data.as_slice()))
                    .context("Failed to create hidden_states tensor ref")?;
            let enc_mask =
                Tensor::<i64>::from_array(([1usize, enc_len], attention_mask.clone()))
                    .context("Failed to create encoder_attention_mask")?;

            let dec_out = dec
                .run(ort::inputs![
                    "input_ids"              => dec_ids,
                    "encoder_hidden_states"  => hidden_ref,
                    "encoder_attention_mask" => enc_mask
                ])
                .context("Translation decoder inference failed")?;

            let (logits_shape, logits_data) = dec_out["logits"]
                .try_extract_tensor::<f32>()
                .context("Failed to extract translation logits")?;

            let vocab_size = logits_shape[2] as usize;
            let last_row = (dec_len - 1) * vocab_size;
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

        // Decode output tokens (skip the leading <pad> start token)
        let output_ids: Vec<u32> = tokens[1..].iter().map(|&id| id as u32).collect();
        let translation = self
            .tokenizer
            .decode(&output_ids, true)
            .map_err(|e| anyhow::anyhow!("Detokenization failed: {e}"))?;

        Ok(translation.trim().to_string())
    }
}
