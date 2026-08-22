import Elysia, { t } from "elysia";
import { JobStore } from "@/stores/job-store";
import { inferenceQueue } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";
import { TextSegBlockSchema, ErrBody } from "@/lib/schemas";
import { join } from "path";
import sharp from "sharp";

const DATA_DIR = "./data/jobs";

const CountSchema = t.Object({ processed: t.Integer(), total: t.Integer() });

export const portalActions = new Elysia()
  // POST /api/portal/jobs/:id/redetect
  .post(
    "/jobs/:id/redetect",
    async ({ params, status: error }) => {
      if (!bootState.textSegEnabled || !bootState.textSegReady)
        return error(503, { error: "TextSeg not ready" });

      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const originalFile = Bun.file(join(DATA_DIR, params.id, "original.png"));
      if (!(await originalFile.exists())) return error(404, { error: "original image not found" });

      const imageBuffer = Buffer.from(await originalFile.arrayBuffer());
      const { width = 1, height = 1 } = await sharp(imageBuffer).metadata();

      const result = await inferenceQueue.enqueue<
        { imageBuffer: Buffer; origWidth: number; origHeight: number },
        { boxes: { x: number; y: number; w: number; h: number }[]; processingTimeMs: number }
      >("text-seg", { imageBuffer, origWidth: width, origHeight: height });

      const blocks = result.boxes.map((b) => ({
        id: crypto.randomUUID(),
        ...b,
        source_text: null,
        translated_text: null,
      }));
      await JobStore.update(params.id, { textSegBlocks: JSON.stringify(blocks) });
      return { blocks, elapsed_ms: result.processingTimeMs };
    },
    {
      response: {
        200: t.Object({ blocks: t.Array(TextSegBlockSchema), elapsed_ms: t.Integer() }),
        404: ErrBody,
        503: ErrBody,
      },
    },
  )

  // POST /api/portal/jobs/:id/reocr
  .post(
    "/jobs/:id/reocr",
    async ({ params, status: error }) => {
      if (!bootState.ocrReady) return error(503, { error: "OCR not ready" });

      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const bubbles = await JobStore.listBubbles(params.id);
      let processed = 0;

      for (const bubble of bubbles) {
        const cropFile = Bun.file(join(DATA_DIR, params.id, `crop_${bubble.bubbleIndex}.png`));
        if (!(await cropFile.exists())) continue;

        const imageBuffer = Buffer.from(await cropFile.arrayBuffer());
        const result = await inferenceQueue.enqueue<
          { imageBuffer: Buffer },
          { text: string; processingTimeMs: number }
        >("ocr", { imageBuffer });

        await JobStore.updateBubble(bubble.id, { sourceText: result.text });
        processed++;
      }

      return { processed, total: bubbles.length };
    },
    { response: { 200: CountSchema, 404: ErrBody, 503: ErrBody } },
  )

  // POST /api/portal/jobs/:id/retranslate
  .post(
    "/jobs/:id/retranslate",
    async ({ params, status: error }) => {
      if (!bootState.translateReady) return error(503, { error: "Translate not ready" });

      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const bubbles = await JobStore.listBubbles(params.id);
      let processed = 0;

      for (const bubble of bubbles) {
        if (!bubble.sourceText) continue;
        const result = await inferenceQueue.enqueue<
          { text: string },
          { translatedText: string }
        >("translate", { text: bubble.sourceText });

        await JobStore.updateBubble(bubble.id, { translatedText: result.translatedText });
        processed++;
      }

      return { processed, total: bubbles.length };
    },
    { response: { 200: CountSchema, 404: ErrBody, 503: ErrBody } },
  )

  // POST /api/portal/jobs/:id/translate (alias of retranslate)
  .post(
    "/jobs/:id/translate",
    async ({ params, status: error }) => {
      if (!bootState.translateReady) return error(503, { error: "Translate not ready" });

      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const bubbles = await JobStore.listBubbles(params.id);
      let processed = 0;
      for (const bubble of bubbles) {
        if (!bubble.sourceText) continue;
        const result = await inferenceQueue.enqueue<
          { text: string },
          { translatedText: string }
        >("translate", { text: bubble.sourceText });
        await JobStore.updateBubble(bubble.id, { translatedText: result.translatedText });
        processed++;
      }
      return { processed, total: bubbles.length };
    },
    { response: { 200: CountSchema, 404: ErrBody, 503: ErrBody } },
  )

  // POST /api/portal/jobs/:id/inpaint (stub)
  .post(
    "/jobs/:id/inpaint",
    async ({ status: error }) => {
      if (!bootState.inpaintEnabled) return error(503, { error: "Inpaint not enabled" });
      return error(501, { error: "Inpaint not yet implemented in server-bun" });
    },
    { response: { 501: ErrBody, 503: ErrBody } },
  )

  // POST /api/portal/jobs/:id/rerender (stub)
  .post(
    "/jobs/:id/rerender",
    async ({ status: error }) =>
      error(501, { error: "Rerender (TypesettingService) not yet implemented in server-bun" }),
    { response: { 501: ErrBody } },
  );
