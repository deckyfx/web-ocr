import * as ort from "onnxruntime-node";
import { readFileSync } from "fs";
import { join } from "path";
import { env } from "@/env";
import { inferenceHandlers } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";

export interface OcrInput {
  /** Raw image bytes (JPEG/PNG) */
  imageBuffer: Buffer;
}

export interface OcrOutput {
  text: string;
  processingTimeMs: number;
}

/** manga-ocr-onnx encoder/decoder sessions */
let encoderSession: ort.InferenceSession | null = null;
let decoderSession: ort.InferenceSession | null = null;
let vocab: string[] = [];

export async function loadOcrModel(): Promise<void> {
  const dir = env.OCR_MODELS_DIR;
  const encoderPath = join(dir, "encoder_model.onnx");
  const decoderPath = join(dir, "decoder_model.onnx");
  const vocabPath = join(dir, "vocab.txt");

  // Validate files exist before loading sessions
  const { existsSync } = await import("fs");
  if (!existsSync(encoderPath) || !existsSync(decoderPath) || !existsSync(vocabPath)) {
    throw new Error(`OCR model files not found in ${dir}. Run model download first.`);
  }

  encoderSession = await ort.InferenceSession.create(encoderPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  decoderSession = await ort.InferenceSession.create(decoderPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });

  vocab = readFileSync(vocabPath, "utf8").split("\n").map((l) => l.trim());

  inferenceHandlers.ocr = runOcr as (input: unknown, signal: AbortSignal) => Promise<unknown>;
  bootState.ocrReady = true;
  console.log("OCR model loaded.");
}

async function runOcr(input: unknown, signal?: AbortSignal): Promise<OcrOutput> {
  const { imageBuffer } = input as OcrInput;
  if (!encoderSession || !decoderSession) throw new Error("OCR model not loaded");
  if (signal?.aborted) throw new Error("Inference aborted (timeout)");

  const start = Date.now();

  // Pre-process: resize to 224×224, normalise to [-1, 1] float32
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(imageBuffer)
    .resize(224, 224)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) throw new Error(`Expected 3 channels, got ${info.channels}`);

  const float32 = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    float32[i]               = (data[i * 3]     / 127.5) - 1;      // R
    float32[i + 224 * 224]   = (data[i * 3 + 1] / 127.5) - 1;      // G
    float32[i + 2 * 224 * 224] = (data[i * 3 + 2] / 127.5) - 1;    // B
  }

  const pixelTensor = new ort.Tensor("float32", float32, [1, 3, 224, 224]);

  // Encoder
  const encOut = await encoderSession.run({ pixel_values: pixelTensor });
  const encoderHidden = encOut["last_hidden_state"];

  // Greedy decoder — mirrors C# MangaOcrService
  const BOS_TOKEN = 2;
  const EOS_TOKEN = 3;
  const MAX_LEN = 300;
  let inputIds = [BOS_TOKEN];
  const decoded: number[] = [];

  for (let step = 0; step < MAX_LEN; step++) {
    const idsTensor = new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]);
    const decOut = await decoderSession.run({
      input_ids: idsTensor,
      encoder_hidden_states: encoderHidden,
    });
    const logits = decOut["logits"].data as Float32Array;
    const seqLen = inputIds.length;
    const vocabSize = logits.length / seqLen;
    // Take the last token's logits
    const lastLogits = logits.slice((seqLen - 1) * vocabSize, seqLen * vocabSize);
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let j = 0; j < lastLogits.length; j++) {
      if (lastLogits[j] > maxVal) { maxVal = lastLogits[j]; maxIdx = j; }
    }
    if (maxIdx === EOS_TOKEN) break;
    decoded.push(maxIdx);
    inputIds.push(maxIdx);
  }

  // Simple vocab lookup — for SentencePiece the tokens contain "▁" as word boundary
  const text = decoded
    .map((id) => vocab[id] ?? "")
    .join("")
    .replace(/▁/g, " ")
    .trim();

  return { text, processingTimeMs: Date.now() - start };
}
