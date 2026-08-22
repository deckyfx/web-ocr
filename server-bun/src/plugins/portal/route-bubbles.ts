import Elysia, { t } from "elysia";
import { JobStore } from "@/stores/job-store";
import { inferenceQueue } from "@/queue/inference-queue";
import { bootState } from "@/boot-state";
import { join } from "path";

const DATA_DIR = "./data/jobs";

const BubbleBody = t.Object({
  x: t.Optional(t.Number()),
  y: t.Optional(t.Number()),
  width: t.Optional(t.Number()),
  height: t.Optional(t.Number()),
  rotation: t.Optional(t.Number()),
  source_text: t.Optional(t.Nullable(t.String())),
  translated_text: t.Optional(t.Nullable(t.String())),
  style_json: t.Optional(t.Nullable(t.String())),
});

export const portalBubbles = new Elysia()
  // GET /api/portal/jobs/:id/bubbles
  .get("/jobs/:id/bubbles", async ({ params, status: error }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });
    return JobStore.listBubbles(params.id);
  })

  // POST /api/portal/jobs/:id/bubbles
  .post(
    "/jobs/:id/bubbles",
    async ({ params, body, status: error }) => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });

      const bubbles = await JobStore.listBubbles(params.id);
      const bubble = await JobStore.insertBubble({
        jobId: params.id,
        bubbleIndex: bubbles.length,
        x: body.x ?? 0,
        y: body.y ?? 0,
        width: body.width ?? 100,
        height: body.height ?? 100,
        rotation: body.rotation ?? 0,
        sourceText: body.source_text ?? null,
        translatedText: body.translated_text ?? null,
      });
      return bubble;
    },
    {
      body: t.Object({
        x: t.Optional(t.Number()),
        y: t.Optional(t.Number()),
        width: t.Optional(t.Number()),
        height: t.Optional(t.Number()),
        rotation: t.Optional(t.Number()),
        source_text: t.Optional(t.Nullable(t.String())),
        translated_text: t.Optional(t.Nullable(t.String())),
      }),
    },
  )

  // PUT /api/portal/jobs/:id/bubbles/:bubbleIndex
  .put(
    "/jobs/:id/bubbles/:bubbleIndex",
    async ({ params, body, status: error }) => {
      const idx = parseInt(params.bubbleIndex, 10);
      const bubble = await JobStore.findBubble(params.id, idx);
      if (!bubble) return error(404, { error: "not found" });

      const updated = await JobStore.updateBubble(bubble.id, {
        x: body.x,
        y: body.y,
        width: body.width,
        height: body.height,
        rotation: body.rotation,
        sourceText: body.source_text,
        translatedText: body.translated_text,
        styleJson: body.style_json,
      });
      if (!updated) return error(404, { error: "bubble update failed" });
      return updated;
    },
    { body: BubbleBody },
  )

  // DELETE /api/portal/jobs/:id/bubbles/:bubbleIndex
  .delete(
    "/jobs/:id/bubbles/:bubbleIndex",
    async ({ params, status: error }) => {
      const idx = parseInt(params.bubbleIndex, 10);
      const bubble = await JobStore.findBubble(params.id, idx);
      if (!bubble) return error(404, { error: "not found" });
      await JobStore.deleteBubble(bubble.id);
      return { deleted: idx };
    },
  )

  // POST /api/portal/jobs/:id/bubbles/:bubbleIndex/reocr
  .post(
    "/jobs/:id/bubbles/:bubbleIndex/reocr",
    async ({ params, status: error }) => {
      if (!bootState.ocrReady) return error(503, { error: "OCR model not ready" });

      const idx = parseInt(params.bubbleIndex, 10);
      const bubble = await JobStore.findBubble(params.id, idx);
      if (!bubble) return error(404, { error: "not found" });

      const cropPath = join(DATA_DIR, params.id, `crop_${idx}.png`);
      const cropFile = Bun.file(cropPath);
      if (!(await cropFile.exists())) return error(404, { error: "crop image not found" });

      const imageBuffer = Buffer.from(await cropFile.arrayBuffer());
      const result = await inferenceQueue.enqueue<
        { imageBuffer: Buffer },
        { text: string; processingTimeMs: number }
      >("ocr", { imageBuffer });

      await JobStore.updateBubble(bubble.id, { sourceText: result.text });
      return { source_text: result.text, elapsed_ms: result.processingTimeMs };
    },
  )

  // POST /api/portal/jobs/:id/bubbles/:bubbleIndex/retranslate
  .post(
    "/jobs/:id/bubbles/:bubbleIndex/retranslate",
    async ({ params, status: error }) => {
      if (!bootState.translateReady && !bootState.ocrReady)
        return error(503, { error: "Services not ready" });

      const idx = parseInt(params.bubbleIndex, 10);
      const bubble = await JobStore.findBubble(params.id, idx);
      if (!bubble) return error(404, { error: "not found" });
      if (!bubble.sourceText) return error(400, { error: "no source text to translate" });

      const result = await inferenceQueue.enqueue<
        { text: string },
        { translatedText: string; processingTimeMs: number }
      >("translate", { text: bubble.sourceText });

      await JobStore.updateBubble(bubble.id, { translatedText: result.translatedText });
      return { translated_text: result.translatedText, elapsed_ms: result.processingTimeMs };
    },
  )

  .post(
    "/jobs/:id/bubbles/:bubbleIndex/reinpaint",
    async ({ params: _, status: error }) => {
      if (!bootState.inpaintEnabled) return error(503, { error: "Inpaint not enabled" });
      return error(501, { error: "Inpaint service not yet implemented in server-bun" });
    },
  )

  .post(
    "/jobs/:id/bubbles/:bubbleIndex/repatch",
    async ({ status: error }) => error(501, { error: "Repatch not yet implemented in server-bun" }),
  );
