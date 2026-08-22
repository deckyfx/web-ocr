import Elysia, { t } from "elysia";
import { bootState } from "@/boot-state";
import { inferenceQueue } from "@/queue/inference-queue";
import { OcrStore } from "@/stores/ocr-store";
import { ErrBody } from "@/lib/schemas";
import { env } from "@/env";

export const routeTranslate = new Elysia().post(
  "/translate",
  async ({ body, status: error }) => {
    const text = body.text?.trim();
    if (!text) return error(400, { error: "text is required" });

    const requestedEngine = body.translate_engine?.toLowerCase() ?? env.PREFERRED_TRANSLATION_ENGINE;
    const resolvedEngine =
      requestedEngine === "auto"
        ? env.DEEPL_API_KEY
          ? "deepl"
          : "local"
        : requestedEngine;

    if (resolvedEngine !== "deepl" && !bootState.translateReady)
      return error(503, { error: "Translate model not ready" });

    const result = await inferenceQueue.enqueue<
      { text: string },
      { translatedText: string; engine: string; processingTimeMs: number }
    >("translate", { text });

    OcrStore.insertTranslateLog({
      sourceText: text,
      translatedText: result.translatedText,
      sourceLang: "ja",
      targetLang: "en",
      engine: result.engine,
      processingTimeMs: result.processingTimeMs,
    }).catch(() => {});

    return {
      translation: result.translatedText,
      engine: result.engine,
      elapsed_ms: result.processingTimeMs,
    };
  },
  {
    body: t.Object({
      text: t.String(),
      translate_engine: t.Optional(t.String()),
    }),
    response: {
      200: t.Object({
        translation: t.String(),
        engine: t.String(),
        elapsed_ms: t.Integer(),
      }),
      400: ErrBody,
      503: ErrBody,
    },
  },
);
