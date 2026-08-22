import * as ort from "onnxruntime-node";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { env } from "@/env";
import { inferenceHandlers } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";
import { runtimeSettings } from "@/stores/settings-store";

export interface TranslateInput {
  text: string;
  engine?: string;
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
let modelBosToken = 0;
let modelEosToken = 0;

export async function loadTranslateModel(): Promise<void> {
  const dir = env.TRANSLATE_MODELS_DIR;
  const encoderPath = join(dir, "onnx/encoder_model.onnx");
  const decoderPath = join(dir, "onnx/decoder_model.onnx");
  const tokenizerPath = join(dir, "tokenizer.json");

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

  // config.json is required — it carries the BOS/EOS token IDs needed for greedy decode.
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Translate model config.json not found in ${dir}.`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (typeof cfg["decoder_start_token_id"] !== "number" || typeof cfg["eos_token_id"] !== "number") {
    throw new Error(`Translate model config.json is missing decoder_start_token_id or eos_token_id.`);
  }
  modelBosToken = cfg["decoder_start_token_id"];
  modelEosToken = cfg["eos_token_id"];

  inferenceHandlers.translate = runTranslate;
  bootState.translateReady = true;
  console.log("Translate model loaded.");
}

async function runTranslate(input: unknown): Promise<TranslateOutput> {
  if (!input || typeof input !== "object" || typeof (input as TranslateInput).text !== "string") {
    throw new Error("Invalid translate input: text must be a string");
  }
  const { text, engine, targetLang = "en" } = input as TranslateInput;

  // Resolve which engine to use: explicit request → runtime setting → env default.
  const resolved = engine === "deepl" || engine === "local"
    ? engine
    : runtimeSettings.preferredTranslationEngine !== "local" && env.DEEPL_API_KEY
      ? "deepl"
      : "local";

  if (resolved === "deepl") {
    if (!env.DEEPL_API_KEY) throw new Error("DeepL API key not configured");
    return runDeepL(text, targetLang);
  }

  if (!encoderSession || !decoderSession || !tokenizer) {
    throw new Error("Translate model not loaded");
  }

  const start = Date.now();

  const MAX_INPUT_LEN = 512;
  const inputIds = tokenizer.encode(text).slice(0, MAX_INPUT_LEN);
  const idsTensor = new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]);
  const attentionMask = new ort.Tensor("int64", BigInt64Array.from(inputIds.map(() => 1n)), [1, inputIds.length]);

  const encOut = await encoderSession.run({
    input_ids: idsTensor,
    attention_mask: attentionMask,
  });
  const encoderHidden = encOut["last_hidden_state"];

  // Greedy decode — use model config tokens (e.g. Xenova/opus-mt-ja-en: BOS=60715, EOS=0).
  const BOS = modelBosToken;
  const EOS = modelEosToken;
  const MAX_LEN = 512;
  let genIds = [BOS];

  for (let step = 0; step < MAX_LEN; step++) {
    const genTensor = new ort.Tensor("int64", BigInt64Array.from(genIds.map(BigInt)), [1, genIds.length]);
    const decOut = await decoderSession.run({
      input_ids: genTensor,
      encoder_hidden_states: encoderHidden,
      encoder_attention_mask: attentionMask,
    });
    const logits = decOut["logits"]?.data as Float32Array | undefined;
    if (!logits) throw new Error("Translate decoder produced no logits");
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
  const key = env.DEEPL_API_KEY ?? "";
  // Free-tier keys end with :fx; paid keys use api.deepl.com
  const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const res = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Authorization": `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: [text], target_lang: targetLang.toUpperCase() }),
  });
  if (!res.ok) {
    const status = res.status;
    await res.body?.cancel();
    throw new Error(`DeepL HTTP ${status}`);
  }
  const json = await res.json() as { translations?: { text: string }[] };
  const first = json.translations?.[0];
  if (!first?.text) throw new Error("DeepL returned no translations");
  return {
    translatedText: first.text,
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
  const mergeRank = new Map<string, number>(
    (model["merges"] as string[]).map((m, i) => [m, i]),
  );

  function applyBpe(word: string): string[] {
    let parts = word.split("");
    while (parts.length > 1) {
      let bestRank = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const rank = mergeRank.get(`${parts[i]} ${parts[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      parts = [...parts.slice(0, bestIdx), parts[bestIdx] + parts[bestIdx + 1], ...parts.slice(bestIdx + 2)];
    }
    return parts;
  }

  const unkId = vocabMap["<unk>"] ?? 0;

  return {
    encode(text: string): number[] {
      const tokens: number[] = [];
      for (const word of text.split(" ")) {
        const bpeTokens = applyBpe("▁" + word);
        for (const t of bpeTokens) {
          tokens.push(vocabMap[t] ?? unkId);
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
