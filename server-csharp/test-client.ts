/**
 * test-client.ts
 * Sends every sample image through /ocr → /analyze and prints a colour-coded report.
 *
 * Usage:
 *   bun run server-csharp/test-client.ts [--server http://localhost:3579] [--engine auto|local|deepl|none]
 */

import { join, basename } from "node:path";
import { readdirSync, existsSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const args = Bun.argv.slice(2);
const serverIdx = args.indexOf("--server");
const engineIdx = args.indexOf("--engine");

const BASE_URL = serverIdx !== -1 ? args[serverIdx + 1] : "http://localhost:3579";
const ENGINE   = engineIdx  !== -1 ? args[engineIdx  + 1] : "auto";
const SAMPLES  = join(import.meta.dir, "samples");

// ─── Colour helpers ───────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const c = (code: string) => (isTTY ? `\x1b[${code}m` : "");
const RESET  = c("0");
const BOLD   = c("1");
const DIM    = c("2");
const GREEN  = c("32");
const YELLOW = c("33");
const RED    = c("31");
const CYAN   = c("36");

// ─── API helpers ─────────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface OcrResponse {
  text:        string;
  translation: string | null;
  elapsed_ms:  number;
}

interface TranslateResponse {
  translation: string;
  elapsed_ms:  number;
}

interface AnalyzeToken {
  surface:     string;
  reading:     string | null;
  romaji:      string | null;
  part_of_speech: string | null;
}

interface Definition {
  word:      string;
  reading:   string;
  is_common: boolean;
  jlpt:      string | null;
  glosses:   string[];
}

interface AnalyzeResponse {
  original:    string;
  sanitized:   string;
  sentences:   string[];
  tokens:      AnalyzeToken[];
  definitions: (Definition | null)[];
  elapsed_ms:  number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

if (serverIdx !== -1 && (!args[serverIdx + 1] || args[serverIdx + 1].startsWith("--"))) {
  console.error(`${RED}Error: --server requires a URL argument${RESET}`);
  process.exit(1);
}
if (engineIdx !== -1 && (!args[engineIdx + 1] || args[engineIdx + 1].startsWith("--"))) {
  console.error(`${RED}Error: --engine requires a value argument${RESET}`);
  process.exit(1);
}
const VALID_ENGINES = ["auto", "local", "deepl", "none"];
if (!VALID_ENGINES.includes(ENGINE)) {
  console.error(`${RED}Error: unknown engine '${ENGINE}' — valid: ${VALID_ENGINES.join(" | ")}${RESET}`);
  process.exit(1);
}
if (!existsSync(SAMPLES)) {
  console.error(`${RED}Error: samples directory not found: ${SAMPLES}${RESET}`);
  console.error(`  Create it and add test images (.jpg, .png, .webp, or .gif).`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const images = readdirSync(SAMPLES)
  .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
  .sort();

if (images.length === 0) {
  console.error(`${RED}No images found in ${SAMPLES}${RESET}`);
  process.exit(1);
}

console.log(`${BOLD}Web OCR Server — test client${RESET}`);
console.log(`${DIM}Server : ${BASE_URL}${RESET}`);
console.log(`${DIM}Engine : ${ENGINE}${RESET}`);
console.log(`${DIM}Samples: ${images.length} images${RESET}`);
console.log();

// Verify server is up
try {
  const health = await fetch(`${BASE_URL}/health`);
  if (!health.ok) throw new Error(`HTTP ${health.status}`);
  const hj = await health.json() as Record<string, unknown>;
  console.log(`${GREEN}✓ /health${RESET}  status=${hj["status"]}  version=${hj["version"]}`);
  console.log();
} catch (e) {
  console.error(`${RED}✗ Server unreachable at ${BASE_URL}${RESET}`);
  console.error(`  ${e}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;

for (const file of images) {
  const imgPath = join(SAMPLES, file);
  const label   = basename(file);

  console.log(`${BOLD}── ${label} ──────────────────────────────────────────${RESET}`);

  try {
    // 1. Read & encode
    const bytes  = await Bun.file(imgPath).arrayBuffer();
    const b64    = Buffer.from(bytes).toString("base64");

    // 2. POST /ocr
    const t0  = performance.now();
    const ocr = await postJson<OcrResponse>("/ocr", {
      image:            b64,
      translate_engine: ENGINE,
    });
    const ocrMs = (performance.now() - t0).toFixed(0);

    const ocrText = ocr.text?.trim() ?? "";
    if (!ocrText) {
      console.log(`  ${YELLOW}⚠ /ocr returned empty text${RESET}  (${ocr.elapsed_ms} ms server / ${ocrMs} ms round-trip)`);
    } else {
      console.log(`  ${GREEN}✓ /ocr${RESET}  ${DIM}${ocr.elapsed_ms} ms${RESET}`);
      console.log(`    text: ${CYAN}${ocrText}${RESET}`);
    }

    if (ocr.translation) {
      console.log(`    tran: ${ocr.translation}`);
    }

    // 3. POST /analyze  (only if OCR produced text)
    if (ocrText) {
      const t1  = performance.now();
      const ana = await postJson<AnalyzeResponse>("/analyze", {
        text:     ocrText,
        sanitize: true,
        mode:     "local",
      });
      const anaMs = (performance.now() - t1).toFixed(0);

      const tokenSummary = ana.tokens
        .slice(0, 6)
        .map(t => t.surface)
        .join(" ");

      console.log(`  ${GREEN}✓ /analyze${RESET}  ${DIM}${ana.elapsed_ms} ms${RESET}  tokens: ${ana.tokens.length}`);
      console.log(`    ${DIM}${tokenSummary}${ana.tokens.length > 6 ? " …" : ""}${RESET}`);
    }

    passed++;
  } catch (err) {
    console.error(`  ${RED}✗ Error: ${err}${RESET}`);
    failed++;
  }

  console.log();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const total  = passed + failed;
const colour = failed === 0 ? GREEN : failed < total ? YELLOW : RED;
console.log(`${BOLD}Results: ${colour}${passed}/${total} passed${RESET}${failed > 0 ? `  ${RED}${failed} failed${RESET}` : ""}`);
