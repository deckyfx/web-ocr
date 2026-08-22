import * as ort from "onnxruntime-node";
import { readFileSync } from "fs";
import { join } from "path";
import { env } from "@/env";
import { inferenceHandlers } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";

export interface TranslateInput {
  text: string;
  sourceLang?: string;
  targetLang?: string;
}

export interface TranslateOutput {
  translatedText: string;
  engine: "local" | "deepl";
  processingTimeMs: number;
}

interface Tokenizer {
  encode: (text: string) => number[];
  decode: (ids: number[]) => string;
}

let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;

export async function loadTranslateModel(): Promise<void> {
  const dir = env.TRANSLATE_MODELS_DIR;
  const encoderPath = join(dir, "onnx/encoder_model.onnx");
  const decoderPath = join(dir, "onnx/decoder_model.onnx");
  const tokenizerPath = join(dir, "tokenizer.json");

  const { existsSync } = await import("fs");
  if (!existsSync(encoderPath) || !existsSync(decoderPath) || !existsSync(tokenizerPath)) {
    throw new Error(`Translate model files not found in ${dir}.`);
  }

  encoderSession = await ort.InferenceSession.create(encoderPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  decoderSession = await ort.InferenceSession.create(decoderPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });

  // Load tokenizer.json for BPE encode/decode
  tokenizer = buildTokenizer(JSON.parse(readFileSync(tokenizerPath, "utf8")));

  inferenceHandlers.translate = runTranslate;
  bootState.translateReady = true;
  console.log("Translate model loaded.");
}

async function runTranslate(input: unknown): Promise<TranslateOutput> {
  const { text, targetLang = "en" } = input as TranslateInput;

  // Prefer DeepL when configured
  if (env.PREFERRED_TRANSLATION_ENGINE !== "local" && env.DEEPL_API_KEY) {
    return runDeepL(text, targetLang);
  }

  if (!encoderSession || !decoderSession || !tokenizer) {
    throw new Error("Translate model not loaded");
  }

  const start = Date.now();

  const inputIds = tokenizer.encode(text);
  const idsTensor = new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]);
  const attentionMask = new ort.Tensor("int64", BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]);

  const encOut = await encoderSession.run({
    input_ids: idsTensor,
    attention_mask: attentionMask,
  });
  const encoderHidden = encOut["last_hidden_state"];

  // Greedy decode
  const BOS = 0;
  const EOS = 0; // opus-mt uses 0 for both pad and eos
  const MAX_LEN = 512;
  let genIds = [BOS];

  for (let step = 0; step < MAX_LEN; step++) {
    const genTensor = new ort.Tensor("int64", BigInt64Array.from(genIds.map(BigInt)), [1, genIds.length]);
    const decOut = await decoderSession.run({
      input_ids: genTensor,
      encoder_hidden_states: encoderHidden,
      encoder_attention_mask: attentionMask,
    });
    const logits = decOut["logits"].data as Float32Array;
    const seqLen = genIds.length;
    const vocabSize = logits.length / seqLen;
    const lastLogits = logits.slice((seqLen - 1) * vocabSize, seqLen * vocabSize);
    let maxIdx = 0, maxVal = -Infinity;
    for (let j = 0; j < lastLogits.length; j++) {
      if (lastLogits[j] > maxVal) { maxVal = lastLogits[j]; maxIdx = j; }
    }
    if (maxIdx === EOS && step > 0) break;
    genIds.push(maxIdx);
  }

  const translatedText = tokenizer.decode(genIds.slice(1));
  return { translatedText, engine: "local", processingTimeMs: Date.now() - start };
}

async function runDeepL(text: string, targetLang: string): Promise<TranslateOutput> {
  const start = Date.now();
  const res = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: [text],
      target_lang: targetLang.toUpperCase(),
    }),
  });
  if (!res.ok) throw new Error(`DeepL error ${res.status}: ${await res.text()}`);
  const json = await res.json() as { translations: { text: string }[] };
  return {
    translatedText: json.translations[0].text,
    engine: "deepl",
    processingTimeMs: Date.now() - start,
  };
}

/** Minimal BPE tokenizer backed by tokenizer.json (HuggingFace format). */
function buildTokenizer(json: Record<string, unknown>): Tokenizer {
  // Build vocab map: token → id
  const model = json["model"] as Record<string, unknown>;
  const vocabMap = model["vocab"] as Record<string, number>;
  const idToToken = Object.fromEntries(Object.entries(vocabMap).map(([t, id]) => [id, t]));
  const merges: [string, string][] = (model["merges"] as string[]).map((m) => {
    const [a, b] = m.split(" ");
    return [a, b];
  });

  function applyBpe(word: string): string[] {
    let parts = word.split("");
    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of merges) {
        const idx = parts.indexOf(a);
        if (idx !== -1 && parts[idx + 1] === b) {
          parts = [...parts.slice(0, idx), a + b, ...parts.slice(idx + 2)];
          changed = true;
          break;
        }
      }
    }
    return parts;
  }

  return {
    encode(text: string): number[] {
      const tokens: number[] = [];
      for (const word of text.split(" ")) {
        const bpeTokens = applyBpe("▁" + word);
        for (const t of bpeTokens) {
          const id = vocabMap[t];
          if (id !== undefined) tokens.push(id);
        }
      }
      return tokens;
    },
    decode(ids: number[]): string {
      return ids
        .map((id) => idToToken[id] ?? "")
        .join("")
        .replace(/▁/g, " ")
        .trim();
    },
  };
}
