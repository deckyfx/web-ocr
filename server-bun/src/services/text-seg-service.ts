/**
 * ComicTextDetector text segmentation service.
 * ONNX model: comictextdetector.pt.onnx
 * Input:  float32[1,3,1024,1024] — image resized to 1024×1024, pixel values / 255
 * Output: float32[1,2,1024,1024] — text / background probability map
 */
import * as ort from "onnxruntime-node";
import { join } from "path";
import { env } from "@/env";
import { inferenceHandlers } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";

export interface TextSegInput {
  imageBuffer: Buffer;
  /** Original image dimensions (for scaling boxes back) */
  origWidth: number;
  origHeight: number;
  /** 0–1 probability threshold for text pixels (default 0.5) */
  threshold?: number;
}

export interface TextSegBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextSegOutput {
  boxes: TextSegBox[];
  processingTimeMs: number;
}

const MODEL_SIZE = 1024;
let session: ort.InferenceSession | null = null;

export async function loadTextSegModel(): Promise<void> {
  const modelPath = join(env.TEXT_SEG_MODELS_DIR, "comictextdetector.pt.onnx");
  const { existsSync } = await import("fs");
  if (!existsSync(modelPath)) {
    throw new Error(`TextSeg model not found at ${modelPath}`);
  }
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  inferenceHandlers["text-seg"] = runTextSeg;
  bootState.textSegReady = true;
  console.log("TextSeg model loaded.");
}

async function runTextSeg(input: unknown): Promise<TextSegOutput> {
  const { imageBuffer, origWidth, origHeight, threshold = 0.5 } = input as TextSegInput;
  if (!session) throw new Error("TextSeg model not loaded");

  const start = Date.now();
  const sharp = (await import("sharp")).default;

  // Resize to 1024×1024
  const { data } = await sharp(imageBuffer)
    .resize(MODEL_SIZE, MODEL_SIZE)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const float32 = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    float32[i]                         = data[i * 3]     / 255;  // R
    float32[i + MODEL_SIZE * MODEL_SIZE]   = data[i * 3 + 1] / 255;  // G
    float32[i + 2 * MODEL_SIZE * MODEL_SIZE] = data[i * 3 + 2] / 255;  // B
  }

  const tensor = new ort.Tensor("float32", float32, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const result = await session.run({ input: tensor });
  const probMap = result["output"].data as Float32Array; // [1, 2, 1024, 1024]

  // Channel 0 = background, channel 1 = text
  const textChannel = probMap.slice(MODEL_SIZE * MODEL_SIZE, 2 * MODEL_SIZE * MODEL_SIZE);
  const binaryMask = new Uint8Array(MODEL_SIZE * MODEL_SIZE);
  for (let i = 0; i < binaryMask.length; i++) {
    binaryMask[i] = textChannel[i] >= threshold ? 1 : 0;
  }

  const boxes = connectedComponentBoxes(binaryMask, MODEL_SIZE, MODEL_SIZE, origWidth, origHeight);
  return { boxes, processingTimeMs: Date.now() - start };
}

/** Naive connected-components bounding-box extraction via flood fill. */
function connectedComponentBoxes(
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  origW: number,
  origH: number
): TextSegBox[] {
  const visited = new Uint8Array(maskW * maskH);
  const boxes: TextSegBox[] = [];
  const scaleX = origW / maskW;
  const scaleY = origH / maskH;
  const MIN_AREA = 64; // ignore tiny noise blobs

  for (let startY = 0; startY < maskH; startY++) {
    for (let startX = 0; startX < maskW; startX++) {
      const idx = startY * maskW + startX;
      if (!mask[idx] || visited[idx]) continue;

      let minX = startX, maxX = startX, minY = startY, maxY = startY;
      const stack = [idx];
      visited[idx] = 1;

      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % maskW;
        const cy = (cur - cx) / maskW;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= maskW || ny < 0 || ny >= maskH) continue;
          const ni = ny * maskW + nx;
          if (!mask[ni] || visited[ni]) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }

      const area = (maxX - minX + 1) * (maxY - minY + 1);
      if (area < MIN_AREA) continue;

      // Scale back to original image coordinates
      boxes.push({
        x: Math.round(minX * scaleX),
        y: Math.round(minY * scaleY),
        w: Math.round((maxX - minX + 1) * scaleX),
        h: Math.round((maxY - minY + 1) * scaleY),
      });
    }
  }

  // Merge overlapping/adjacent boxes (replicates C# TextSegmentationService chain-merge)
  return mergeOverlapping(boxes, origW);
}

function mergeOverlapping(boxes: TextSegBox[], imageWidth: number): TextSegBox[] {
  if (boxes.length === 0) return [];
  let changed = true;
  let result = [...boxes];

  while (changed) {
    changed = false;
    const merged: TextSegBox[] = [];
    const used = new Set<number>();

    for (let i = 0; i < result.length; i++) {
      if (used.has(i)) continue;
      let cur = result[i];
      for (let j = i + 1; j < result.length; j++) {
        if (used.has(j)) continue;
        if (overlaps(cur, result[j])) {
          const next = union(cur, result[j]);
          // Guard: stop merging if box exceeds 60% of image width
          if (next.w > imageWidth * 0.6) continue;
          cur = next;
          used.add(j);
          changed = true;
        }
      }
      merged.push(cur);
      used.add(i);
    }
    result = merged;
  }
  return result;
}

function overlaps(a: TextSegBox, b: TextSegBox): boolean {
  const pad = 8;
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

function union(a: TextSegBox, b: TextSegBox): TextSegBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}
