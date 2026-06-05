use anyhow::Context;
use lindera::tokenizer::{Tokenizer, TokenizerBuilder};
use serde::Serialize;
use serde_json::json;

// IPADIC detail field indices
const IDX_POS: usize = 0;
const IDX_POS_SUB: usize = 1;
const IDX_CONJ_TYPE: usize = 4;
const IDX_CONJ_FORM: usize = 5;
const IDX_DICT_FORM: usize = 6;
const IDX_READING: usize = 7;

/// A single morpheme extracted from the input text.
#[derive(Debug, Serialize)]
pub struct TokenInfo {
    /// Surface form as it appeared in the original text.
    pub surface: String,
    /// Dictionary (base) form — e.g. "食べる" for "食べ".
    pub dictionary_form: String,
    /// Katakana reading — e.g. "タベ".
    pub reading: String,
    /// Part of speech — e.g. "動詞", "名詞", "助詞".
    pub pos: String,
    /// First POS subcategory — e.g. "自立", "固有名詞".
    pub pos_detail: String,
    /// Conjugation type if applicable — e.g. "一段", "*".
    pub conjugation_type: String,
    /// Conjugation form if applicable — e.g. "連用形", "*".
    pub conjugation_form: String,
    /// True when lindera could not match this surface in the dictionary.
    pub is_unknown: bool,
}

pub struct AnalyzeService {
    tokenizer: Tokenizer,
}

impl AnalyzeService {
    /// Initialise with the embedded IPADIC dictionary.
    pub fn new() -> anyhow::Result<Self> {
        let config = json!({
            "segmenter": {
                "dictionary": "embedded://ipadic",
                "mode": "normal"
            },
            "character_filters": [],
            "token_filters": []
        });

        let tokenizer = TokenizerBuilder::from_config(config)
            .context("failed to create TokenizerBuilder")?
            .build()
            .context("failed to build IPADIC tokenizer")?;

        Ok(Self { tokenizer })
    }

    /// Tokenize `text` and return owned `TokenInfo` structs.
    ///
    /// Tokens borrow from both the tokenizer and the input string, so we eagerly
    /// copy all fields to owned `String`s before returning.
    pub fn tokenize(&self, text: &str) -> anyhow::Result<Vec<TokenInfo>> {
        let mut raw = self
            .tokenizer
            .tokenize(text)
            .map_err(|e| anyhow::anyhow!("tokenize failed: {e}"))?;

        let infos = raw
            .iter_mut()
            .map(|t| {
                // Copy surface and unknown flag before the mutable details() borrow
                let surface = t.surface.to_string();
                let is_unknown = t.word_id.is_unknown();

                // `details()` mutably borrows `t` (lazy-loads from dict on first call),
                // so we eagerly clone all needed strings before releasing the borrow.
                let (pos, pos_detail, conj_type, conj_form, dict_form, reading) = {
                    let details = t.details();
                    let get = |idx: usize| -> String {
                        details
                            .get(idx)
                            .filter(|s| **s != "*")
                            .map(|s| s.to_string())
                            .unwrap_or_default()
                    };
                    (
                        get(IDX_POS),
                        get(IDX_POS_SUB),
                        get(IDX_CONJ_TYPE),
                        get(IDX_CONJ_FORM),
                        get(IDX_DICT_FORM),
                        get(IDX_READING),
                    )
                };

                // dictionary_form falls back to surface for unknown tokens
                let dictionary_form = if dict_form.is_empty() { surface.clone() } else { dict_form };

                TokenInfo {
                    surface,
                    dictionary_form,
                    reading,
                    pos,
                    pos_detail,
                    conjugation_type: conj_type,
                    conjugation_form: conj_form,
                    is_unknown,
                }
            })
            .collect();

        Ok(infos)
    }
}
