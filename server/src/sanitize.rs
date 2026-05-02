use once_cell::sync::Lazy;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

// Compiled once at startup
static RE_FURIGANA: Lazy<Regex> = Lazy::new(|| {
    // Matches furigana captured by OCR: 漢字(かんじ) / 漢字（かんじ） / 漢字《かんじ》
    Regex::new(r"[（\(《][\p{Hiragana}\p{Katakana}ー]+[）\)》]").unwrap()
});

static RE_ARTIFACTS: Lazy<Regex> = Lazy::new(|| {
    // Common OCR noise: lone dots, vertical/horizontal bars, bullets, shape chars
    Regex::new(r"[・.．|｜_＿◆◇▲△▽▼●○□■✦✧※♦♠♣♥♡★☆→←↑↓]").unwrap()
});

static RE_LONG_VOWEL: Lazy<Regex> = Lazy::new(|| {
    // Collapse ーーー → ー (OCR duplicates from elongated speech bubbles)
    Regex::new(r"ー{2,}").unwrap()
});

static RE_MULTI_SPACE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\s{2,}").unwrap()
});

static RE_SENTENCE: Lazy<Regex> = Lazy::new(|| {
    // Match text up to and including a sentence-ender (look-behind unsupported in regex crate)
    Regex::new(r"[^。！？!?]*[。！？!?]").unwrap()
});

/// Clean raw manga OCR text through a normalisation + noise-removal pipeline.
///
/// Pipeline order matters:
/// 1. NFKC — normalises full/half-width and ligature variants before regex runs
/// 2. Furigana — remove before artifact pass so kana inside brackets is gone first
/// 3. Artifacts — stray punctuation and border noise
/// 4. Long-vowel collapse — ーーー → ー
/// 5. Join lines — vertical text OCR inserts newlines mid-sentence
/// 6. Whitespace normalise — collapse runs of spaces left by removals
pub fn clean_manga_text(raw: &str) -> String {
    // 1. NFKC normalization: Ａ→A, ｱ→ア, ﾎﾞ→ボ, etc.
    let s: String = raw.nfkc().collect();

    // 2. Furigana: 食べ(た) → 食べ
    let s = RE_FURIGANA.replace_all(&s, "");

    // 3. OCR border/artifact characters
    let s = RE_ARTIFACTS.replace_all(&s, "");

    // 4. Elongated vowel marks: ーーー → ー
    let s = RE_LONG_VOWEL.replace_all(&s, "ー");

    // 5. Join newlines — Japanese has no spaces; newlines are column breaks
    let s = s.replace('\n', "").replace('\r', "");

    // 6. Collapse multi-space left by removals
    RE_MULTI_SPACE.replace_all(s.trim(), " ").to_string()
}

/// Split cleaned text into individual sentences on 。！？ boundaries.
/// Each sentence retains its terminal punctuation.
/// Any trailing text without a sentence-ender is appended as a final fragment.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences: Vec<String> = RE_SENTENCE
        .find_iter(text)
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Append any trailing fragment that has no sentence-ender
    let consumed = RE_SENTENCE
        .find_iter(text)
        .last()
        .map(|m| m.end())
        .unwrap_or(0);
    let tail = text[consumed..].trim();
    if !tail.is_empty() {
        sentences.push(tail.to_string());
    }

    sentences
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfkc_normalises_fullwidth() {
        assert_eq!(clean_manga_text("Ａｂｃ"), "Abc");
    }

    #[test]
    fn furigana_stripped() {
        assert_eq!(clean_manga_text("食べ(た)た"), "食べた");
        assert_eq!(clean_manga_text("漢字（かんじ）"), "漢字");
        assert_eq!(clean_manga_text("漢字《かんじ》"), "漢字");
    }

    #[test]
    fn long_vowel_collapsed() {
        assert_eq!(clean_manga_text("だーーーー"), "だー");
    }

    #[test]
    fn newlines_joined() {
        assert_eq!(clean_manga_text("食べ\nた"), "食べた");
    }

    #[test]
    fn sentence_split() {
        let sentences = split_sentences("食べた。飲んだ！帰った？");
        assert_eq!(sentences, vec!["食べた。", "飲んだ！", "帰った？"]);
    }
}
