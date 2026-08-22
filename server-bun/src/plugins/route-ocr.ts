import Elysia, { t } from "elysia";
import { bootState } from "@/boot-state";
import { inferenceQueue } from "@/queue/inference-queue";
import { OcrStore } from "@/stores/ocr-store";
import { JobStore } from "@/stores/job-store";
import { ErrBody } from "@/lib/schemas";
import { join } from "path";
import { env } from "@/env";

export const routeOcr = new Elysia()
  // ── POST /ocr ─────────────────────────────────────────────────────────────
  .post(
    "/ocr",
    async ({ body, status: error }) => {
      if (!bootState.ocrReady)
        return error(503, { error: "OCR model not ready" });

      let imageData = body.image;
      const comma = imageData.indexOf(",");
      if (comma >= 0) imageData = imageData.slice(comma + 1);

      // Pre-decode size check (~10 MB binary ≈ 13.7 MB base64).
      if (imageData.length > 14 * 1024 * 1024)
        return error(400, { error: "image payload exceeds 10 MB limit" });

      // Strict Base64 — Buffer.from silently accepts malformed input.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(imageData))
        return error(400, { error: "image must be valid base64" });

      const imageBytes = Buffer.from(imageData, "base64");
      if (imageBytes.length > 10 * 1024 * 1024)
        return error(400, { error: "decoded image exceeds 10 MB limit" });

      const engine = body.translate_engine ?? "none";

      const ocrResult = await inferenceQueue.enqueue<
        { imageBuffer: Buffer },
        { text: string; processingTimeMs: number }
      >("ocr", { imageBuffer: imageBytes });

      let translation: string | null = null;
      if (engine !== "none" && ocrResult.text) {
        const tr = await inferenceQueue.enqueue<
          { text: string },
          { translatedText: string; processingTimeMs: number }
        >("translate", { text: ocrResult.text });
        translation = tr.translatedText;
      }

      OcrStore.insertOcrLog({
        imageHash: await hashBuffer(imageBytes),
        sourceText: ocrResult.text,
        modelRepo: env.OCR_MODEL_REPO,
        processingTimeMs: ocrResult.processingTimeMs,
      }).catch(() => {});

      return {
        text: ocrResult.text,
        translation,
        elapsed_ms: ocrResult.processingTimeMs,
      };
    },
    {
      body: t.Object({
        image: t.String(),
        translate_engine: t.Optional(t.String()),
        track_job: t.Optional(t.Boolean()),
      }),
      response: {
        200: t.Object({
          text: t.String(),
          translation: t.Nullable(t.String()),
          elapsed_ms: t.Integer(),
        }),
        400: ErrBody,
        503: ErrBody,
      },
    },
  )

  // ── GET /jobs/:id/status ──────────────────────────────────────────────────
  .get(
    "/jobs/:id/status",
    async ({ params, status: error }) => {
      const job = await JobStore.findById(params.id);
      if (!job) return error(404, { error: "not found" });
      return { status: job.status, job_id: job.id };
    },
    {
      response: {
        200: t.Object({ status: t.String(), job_id: t.String() }),
        404: ErrBody,
      },
    },
  )

  // ── GET /jobs/:id/result-image ────────────────────────────────────────────
  .get("/jobs/:id/result-image", async ({ params, status: error, set }) => {
    const job = await JobStore.findById(params.id);
    if (!job) return error(404, { error: "not found" });

    const resultPath = join("./data/jobs", params.id, "result.png");
    const file = Bun.file(resultPath);
    if (!(await file.exists())) return error(404, { error: "result image not found" });

    set.headers["Cache-Control"] = "no-cache";
    return file;
  });

async function hashBuffer(buf: Buffer): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(buf);
  return hash.digest("hex");
}
