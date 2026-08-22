import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { env } from "@/env";
import { bootState } from "@/boot-state";
import { routeHealth } from "@/plugins/route-health";
import { routeOcr } from "@/plugins/route-ocr";
import { routeTranslate } from "@/plugins/route-translate";
import { routeSettings } from "@/plugins/route-settings";
import { routeTranslatePage } from "@/plugins/route-translate-page";
import { portalPlugin } from "@/plugins/portal/index";
import { routeSpa } from "@/plugins/route-spa";

async function migrateDb(): Promise<void> {
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const { db } = await import("@/db/index");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("DB migrations applied.");
}

async function loadModels(): Promise<void> {
  bootState.inpaintEnabled = env.INPAINT_MODEL_ENABLED;
  bootState.bubbleEnabled = env.BUBBLE_MODEL_ENABLED;
  bootState.textSegEnabled = env.TEXT_SEG_MODEL_ENABLED;

  if (env.OCR_MODEL_ENABLED) {
    const { loadOcrModel } = await import("@/services/ocr-service");
    await loadOcrModel().catch((err) => console.warn("OCR model skipped:", err.message));
  }
  if (env.TRANSLATE_MODEL_ENABLED) {
    const { loadTranslateModel } = await import("@/services/translate-service");
    await loadTranslateModel().catch((err) => console.warn("Translate model skipped:", err.message));
  }
  if (env.TEXT_SEG_MODEL_ENABLED) {
    const { loadTextSegModel } = await import("@/services/text-seg-service");
    await loadTextSegModel().catch((err) => console.warn("TextSeg model skipped:", err.message));
  }

  bootState.isReady = true;
  console.log("Boot complete — server ready.");
}

// Run migrations before accepting any requests
await migrateDb();

const app = new Elysia()
  .use(cors())
  .use(routeHealth)
  .use(routeOcr)
  .use(routeTranslate)
  .use(routeSettings)
  .use(routeTranslatePage)
  .use(portalPlugin)
  .use(routeSpa);

const listen = env.SOCKET_PATH
  ? { unix: env.SOCKET_PATH }
  : { port: env.PORT };

app.listen(listen, ({ hostname, port }) => {
  console.log(`web-ocr-bun listening on http://${hostname}:${port}`);
});

// Load models non-blocking — server accepts requests immediately, /health returns "starting" until ready
loadModels().catch((err) => {
  console.error("Model loading failed:", err);
  process.exit(1);
});

export type App = typeof app;
