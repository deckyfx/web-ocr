/**
 * POST /api/translate-page — full pipeline: upload image → detect text →
 * OCR each bubble → translate → persist job.
 *
 * GET  /api/translate-page/:id        — fetch job status + result
 * GET  /api/translate-page/:id/events — SSE progress stream
 */
import Elysia, { t } from "elysia";
import { JobStore } from "@/stores/job-store";
import { inferenceQueue } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";
import { JobSchema, BubbleSchema } from "@/lib/schemas";
import { join } from "path";
import { mkdir } from "fs/promises";
import sharp from "sharp";

const DATA_DIR = "./data/jobs";

const sseStreams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

function sendSse(jobId: string, event: string, data: unknown): void {
  const ctrl = sseStreams.get(jobId);
  if (!ctrl) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  try {
    ctrl.enqueue(new TextEncoder().encode(msg));
  } catch {
    /* client disconnected */
  }
}

export const routeTranslatePage = new Elysia()
  // ── POST /api/translate-page ───────────────────────────────────────────────
  .post(
    "/api/translate-page",
    async ({ body, status: error }) => {
      if (!bootState.isReady) return error(503, { error: "Server not ready" });

      const raw = body.image;
      const commaIdx = raw.indexOf(",");
      const base64 = commaIdx >= 0 ? raw.slice(commaIdx + 1) : raw;
      const imageBytes = Buffer.from(base64, "base64");

      const pngBytes = await sharp(imageBytes).png().toBuffer();
      const { width = 1, height = 1 } = await sharp(pngBytes).metadata();

      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(pngBytes);
      const imageHash = hasher.digest("hex");

      const existing = await JobStore.findByImageHash(imageHash);
      if (existing && existing.status === "done") {
        return { job_id: existing.id, cached: true };
      }

      const job = await JobStore.insert({
        imageHash,
        sourcePath: "upload",
        status: "processing",
        inpaintEnabled: bootState.inpaintEnabled,
        bubbleEnabled: bootState.bubbleEnabled,
      });

      const jobDir = join(DATA_DIR, job.id);
      await mkdir(jobDir, { recursive: true });
      await Bun.write(join(jobDir, "original.png"), pngBytes);

      runPipeline(job.id, pngBytes, width, height).catch(async (err) => {
        await JobStore.setStatus(job.id, "error", String(err));
        sendSse(job.id, "error", { message: String(err) });
        sseStreams.get(job.id)?.close();
        sseStreams.delete(job.id);
      });

      return { job_id: job.id, cached: false };
    },
    {
      body: t.Object({ image: t.String() }),
    },
  )

  // ── GET /api/translate-page/:id ──────────────────────────────────────────
  .get(
    "/api/translate-page/:id",
    async ({ params, status: error }) => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });
      const bubbles = await JobStore.listBubbles(params.id);
      return { job, bubbles };
    },
  )

  // ── GET /api/translate-page/:id/events (SSE) ─────────────────────────────
  .get("/api/translate-page/:id/events", async ({ params, set }) => {
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const jobId = params.id;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        sseStreams.set(jobId, controller);
        JobStore.findById(jobId).then((job) => {
          if (job) {
            const msg = `event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`;
            controller.enqueue(new TextEncoder().encode(msg));
          }
        });
      },
      cancel() {
        sseStreams.delete(jobId);
      },
    });
  });

// ── Background pipeline ─────────────────────────────────────────────────────

async function runPipeline(
  jobId: string,
  pngBytes: Buffer,
  width: number,
  height: number,
): Promise<void> {
  sendSse(jobId, "status", { status: "detecting" });

  let boxes: { x: number; y: number; w: number; h: number }[] = [];
  if (bootState.textSegEnabled && bootState.textSegReady) {
    const seg = await inferenceQueue.enqueue<
      { imageBuffer: Buffer; origWidth: number; origHeight: number },
      { boxes: { x: number; y: number; w: number; h: number }[] }
    >("text-seg", { imageBuffer: pngBytes, origWidth: width, origHeight: height });
    boxes = seg.boxes;
  }

  await JobStore.update(jobId, { totalBubbles: boxes.length });
  sendSse(jobId, "detected", { count: boxes.length });

  const jobDir = join(DATA_DIR, jobId);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    sendSse(jobId, "progress", { index: i, total: boxes.length });

    // Clamp crop rectangle to image bounds to prevent sharp.extract errors
    const left = Math.max(0, Math.min(box.x, width - 1));
    const top = Math.max(0, Math.min(box.y, height - 1));
    const cropW = Math.max(1, Math.min(box.w, width - left));
    const cropH = Math.max(1, Math.min(box.h, height - top));
    const cropBuffer = await sharp(pngBytes)
      .extract({ left, top, width: cropW, height: cropH })
      .png()
      .toBuffer();
    await Bun.write(join(jobDir, `crop_${i}.png`), cropBuffer);

    let sourceText: string | null = null;
    let translatedText: string | null = null;

    if (bootState.ocrReady) {
      const ocrResult = await inferenceQueue.enqueue<
        { imageBuffer: Buffer },
        { text: string }
      >("ocr", { imageBuffer: cropBuffer });
      sourceText = ocrResult.text;
    }

    if (sourceText && bootState.translateReady) {
      const trResult = await inferenceQueue.enqueue<
        { text: string },
        { translatedText: string }
      >("translate", { text: sourceText });
      translatedText = trResult.translatedText;
    }

    await JobStore.insertBubble({
      jobId,
      bubbleIndex: i,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      rotation: 0,
      sourceText,
      translatedText,
    });

    await JobStore.incrementProcessed(jobId);
  }

  const blocks = boxes.map((b) => ({
    id: crypto.randomUUID(),
    ...b,
    source_text: null,
    translated_text: null,
  }));
  await JobStore.update(jobId, {
    status: "done",
    textSegBlocks: JSON.stringify(blocks),
  });

  sendSse(jobId, "done", { job_id: jobId });
  sseStreams.get(jobId)?.close();
  sseStreams.delete(jobId);
}
