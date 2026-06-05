import type { createWorker, PSM } from "tesseract.js";
import type { ToEngineMsg, FromEngineMsg } from "./types";

// Tesseract UMD global loaded via <script src="tesseract/tesseract.min.js"> in engine.html
declare const Tesseract: { createWorker: typeof createWorker };

// ── State ─────────────────────────────────────────────────────────────────────

let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
let currentLang = "";
let currentQuality = "";

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent<ToEngineMsg>) => {
  if (!e.data?.type) return;
  if (e.data.type === "ocr-request") {
    void handleOcrRequest(e.data);
  }
});

// Ready as soon as the script loads
postUp({ type: "engine-ready" });

// ── OCR request handler ───────────────────────────────────────────────────────

async function handleOcrRequest(msg: ToEngineMsg): Promise<void> {
  const { requestId, image, lang, quality } = msg;

  try {
    const w = await getWorker(lang, quality, requestId);

    postUp({ type: "ocr-progress", requestId, status: "Recognizing text…", progress: 0.85 });

    const result = await w.recognize(`data:image/jpeg;base64,${image}`);

    postUp({ type: "ocr-result", requestId, text: result.data.text });
  } catch (err) {
    postUp({
      type: "ocr-error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

async function getWorker(lang: string, quality: string, requestId: string): Promise<Awaited<ReturnType<typeof createWorker>>> {
  const needsReload = worker === null || lang !== currentLang || quality !== currentQuality;

  if (needsReload) {
    if (worker) {
      await worker.terminate().catch(console.warn);
      worker = null;
    }

    postUp({ type: "ocr-progress", requestId, status: "Loading Tesseract engine…", progress: 0.05 });

    const base = chrome.runtime.getURL("");
    const workerPath = `${base}tesseract/worker.min.js`;
    const corePath   = `${base}tesseract/tesseract-core-simd-lstm.wasm.js`;
    const langPath   = `https://tessdata.projectnaptha.com/${quality}`;

    const w = await Tesseract.createWorker(lang, 1, {
      workerPath,
      corePath,
      langPath,
      cacheMethod: "none",
      workerBlobURL: false,
      logger: (info: { status: string; progress: number }) => {
        if (info.status && typeof info.progress === "number") {
          postUp({
            type: "ocr-progress",
            requestId,
            status: formatStatus(info.status, info.progress),
            progress: info.progress,
          });
        }
      },
    });

    // PSM 5 = single uniform block of vertically-aligned text.
    // Required for jpn_vert so columns are read right-to-left, top-to-bottom.
    if (lang.endsWith("_vert")) {
      await w.setParameters({ tessedit_pageseg_mode: "5" as PSM });
    }

    worker = w;
    currentLang = lang;
    currentQuality = quality;
  }

  return worker!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function postUp(msg: FromEngineMsg): void {
  window.parent.postMessage(msg, "*");
}

function formatStatus(status: string, progress: number): string {
  const pct = Math.round(progress * 100);
  switch (status) {
    case "loading tesseract core":       return `Loading engine… ${pct}%`;
    case "loading language traineddata": return `Loading language data… ${pct}%`;
    case "initializing tesseract":       return `Initializing… ${pct}%`;
    case "initializing api":             return `Initializing API… ${pct}%`;
    case "recognizing text":             return `Recognizing… ${pct}%`;
    default:                             return `${status} ${pct}%`;
  }
}
