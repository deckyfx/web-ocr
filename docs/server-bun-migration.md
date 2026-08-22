# server-bun Migration Plan

Rewriting the C# ASP.NET Core server (`server/`) into a Bun-native stack:
**Elysia + Drizzle + React 19 + Zustand + Tailwind** — output goes into `./server-bun/`.

---

## Why Bother

### The Core Insight

`onnxruntime-node` (Microsoft's official Node.js binding) supports **every ONNX model already in use**:
manga-OCR, Opus-MT, comictextdetector, LaMa, RT-DETR — the same `.onnx` files, the same
`data/models/` directory, zero model conversion required.

The C# server exists because .NET had the most mature ONNX runtime at project start. That gap is
closed. Every capability maps 1-to-1 to a Node/Bun package.

### What Changes for the Dev Loop

| Pain point now | After migration |
|---|---|
| `dotnet build` adds ~5 s per save | `bun --hot` — instant reload, no compile step |
| EF migrations (generate → apply → commit) | Drizzle migrations — same pattern, ½ the files |
| Two languages to context-switch between | TypeScript end-to-end |
| C# verbosity inflates AI context fast | TS is ~40 % fewer tokens for equivalent logic |
| Separate Vite dev server + .NET server | One Elysia process serves API + React SPA |
| `Microsoft.ML.OnnxRuntime` NuGet package | `onnxruntime-node` npm package — same API surface |

---

## Pros

### Definite Wins

1. **Same ONNX models, no re-training** — `onnxruntime-node` loads `.onnx` files identically.
   Tensor shapes, input/output names — unchanged. The inference code becomes shorter, not different.

2. **`bun:sqlite` is faster than EF Core + SQLite** — native, synchronous where possible,
   zero ORM overhead for hot paths (log inserts, job status polls).

3. **Eden Treaty** — the SolidJS frontend gets end-to-end type safety for every API route
   for free. No more manually keeping TS types in sync with C# DTOs.

4. **`sharp`** — image resize/crop/composite that replaces System.Drawing and SkiaSharp.
   Faster (libvips), smaller Docker layer, better WebP support.

5. **Single process, single language** — Elysia serves the SolidJS SPA, the REST API,
   and SSE streams. No reverse proxy needed in dev.

6. **Smaller Docker image** — no .NET runtime (~200 MB). Bun binary + `node_modules` is
   lighter and starts in < 100 ms vs ~800 ms for .NET.

7. **`@huggingface/hub`** — replaces the custom HuggingFace download logic in
   `BootBackgroundService`. Better resume support, progress events.

8. **Context efficiency** — the entire server-bun codebase will fit in ~2–3 k lines of TS
   vs ~5–6 k lines of C# for the same surface. AI sessions will last 3–4× longer per context
   window.

9. **`QueueEngine` pattern** — maps directly to `InferenceQueue` + `InferenceWorker`.
   The BUN.md guide covers this exact use case.

---

## Cons / Risks

### Real Risks (Ordered by Impact)

#### 1. TypesettingService — hardest to replicate

The C# typesetting renders translated text onto images using SkiaSharp. It handles:
- Automatic font-size fitting inside bubble bounds
- `strokeWidth` / `strokeColor` text outlines
- `rotation` transforms per bubble
- Telea inpainting for non-bubble text blocks (white-fill fallback)

**Replacement:** `node-canvas` (Cairo-backed) is the closest equivalent. It supports
`fillText`, `strokeText`, rotation transforms, and `ctx.drawImage`. Font-size fitting
requires a binary-search loop (measure → shrink → repeat) — same as the C# version.
Telea inpainting is trickier; the current C# calls OpenCV via P/Invoke. Options:
- Port the Telea algorithm to TS (it's ~80 lines of math)
- Use the TextSeg pixel mask + LaMa instead of Telea (already available)
- `sharp` + manual pixel fill as fallback

**Risk level: Medium.** The golden path (LaMa inpaint + bubble typeset) is straightforward.
Telea is only used for non-bubble text blocks.

#### 2. NMeCab (Japanese morphological analysis)

`AnalyzeService` uses `NMeCab.dll` (native C library) for tokenizing Japanese text.
No direct Node equivalent with the same dictionary format.

**Replacement options:**
- `kuromoji` (pure JS, MeCab-compatible IPAdic) — slower but zero native deps
- `sudachijs` (SudachiDict, better for modern Japanese)
- Keep a sidecar: run a tiny Python/MeCab process and call it via Unix socket (same
  pattern as manga-reader's `MangaOCRService`)

**Risk level: Low–Medium.** The `/analyze` route is used for dictionary popup in the
browser extension, not the core pipeline. `kuromoji` covers 90 % of cases.

#### 3. `onnxruntime-node` CPU-only by default

The C# `Microsoft.ML.OnnxRuntime` supports DirectML (GPU on Windows) and CUDA out of
the box via NuGet package swap. `onnxruntime-node` is CPU-only unless you install
`onnxruntime-gpu` and have CUDA set up.

**Impact:** For the target workload (manga translation, batch sizes of 1) CPU inference
is adequate — the C# server also runs CPU inference on most deployments. GPU is a
"nice to have" that can be added later by swapping the npm package.

**Risk level: Low** for typical home-server use.

#### 4. comictextdetector post-processing

The C# `TextSegmentationService` runs connected-component analysis and BFS boundary
refinement in-process using `System.Drawing`. In TS this would use `sharp` pixel
buffers + manual JS loops. The BFS is pure math — portable — but it's ~300 lines of
careful index arithmetic.

**Risk level: Medium.** The logic exists and is tested; it just needs a faithful port.
Pixel buffer access in `sharp` is via `raw()` — straightforward.

#### 5. EF Core migrations must be translated to Drizzle

The C# server has committed migration files (`server/Migrations/`). Drizzle starts
fresh. The new schema must produce the **same column names** (snake_case, already
matching Drizzle's convention) so that `data/ocr.db` can be reused if desired.

**Risk level: Low.** The schema is small (6 tables, ~50 columns total). One afternoon.

---

## Package Map (C# → Bun)

| C# component | Bun replacement |
|---|---|
| `Microsoft.ML.OnnxRuntime` | `onnxruntime-node` |
| `System.Drawing` / `SkiaSharp` | `sharp` |
| `SkiaSharp` text rendering | `node-canvas` |
| `NMeCab` | `kuromoji` (or sidecar) |
| EF Core + SQLite | Drizzle ORM + `bun:sqlite` |
| EF Migrations | `drizzle-kit generate` + `MigrationManager` |
| `BackgroundService` (boot) | `async` init on app start |
| `Channel<T>` (InferenceQueue) | `QueueEngine` pattern (BUN_QUEUE.md) |
| `Channel<T>` (PageTranslation) | second `QueueEngine` or worker thread |
| HuggingFace download logic | `@huggingface/hub` |
| CORS + minimal API routing | Elysia plugins |
| `JsonNamingPolicy.SnakeCaseLower` | Elysia serializes plain objects — name keys manually in snake_case |
| `ILogger` | `consola` or `pino` |
| `DeepL.NET` | `deepl-node` (already in manga-reader) |
| Blazor admin UI | SolidJS (already the frontend, move into server-bun) |

---

## Architecture of `server-bun/`

```
server-bun/
├── src/
│   ├── index.ts                  # Entry: create Elysia app, boot, listen
│   ├── env.ts                    # Type-safe env (BUN_ENV_CONFIG.md pattern)
│   ├── db/
│   │   ├── index.ts              # drizzle(new Database(...))
│   │   ├── schema.ts             # All 6 tables
│   │   ├── migration-manager.ts  # MigrationManager (from BUN_DATABASE.md)
│   │   └── migrations/           # drizzle-kit output
│   ├── stores/                   # Repository pattern (BUN_DATABASE.md)
│   │   ├── job-store.ts
│   │   ├── bubble-store.ts
│   │   ├── volume-store.ts
│   │   └── chapter-store.ts
│   ├── queue/
│   │   ├── inference-queue.ts    # QueueEngine for ONNX jobs (serial)
│   │   └── pipeline-queue.ts     # QueueEngine for page-translation jobs
│   ├── services/
│   │   ├── boot.ts               # Download models, init services (replaces BootBackgroundService)
│   │   ├── ocr.ts                # manga-OCR encoder-decoder (onnxruntime-node)
│   │   ├── translate.ts          # Opus-MT + DeepL fallback
│   │   ├── textseg.ts            # comictextdetector + connected-component analysis
│   │   ├── bubble-detection.ts   # RT-DETR / YOLOv8 + NMS
│   │   ├── inpaint.ts            # LaMa 512×512 + flood-fill fallback
│   │   ├── typeset.ts            # node-canvas text render + composite
│   │   ├── pipeline.ts           # Full page translation pipeline
│   │   ├── analyze.ts            # kuromoji tokenize + Jitendex lookup
│   │   ├── dictionary.ts         # Jitendex SQLite + Jisho API
│   │   └── model-downloader.ts   # @huggingface/hub download
│   ├── plugins/
│   │   ├── routeApp.ts           # Serve SolidJS SPA (wildcard)
│   │   ├── routePublic.ts        # /health, /ocr, /translate, /analyze
│   │   ├── routeSettings.ts      # /api/settings
│   │   ├── routeJobs.ts          # /api/portal/jobs + textseg-blocks
│   │   ├── routeBubbles.ts       # /api/portal/jobs/{id}/bubbles
│   │   ├── routeActions.ts       # /api/portal/jobs/{id}/redetect etc.
│   │   └── routeLibrary.ts       # /api/portal/volumes + chapters
│   └── public/                   # SolidJS built output (copy from server/wwwroot/js)
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── build.ts                      # Bun.build → single binary
```

---

## Inference Queue Design

The C# `InferenceWorker` serializes all ONNX work through a single `Channel<InferenceJob>`.
This is exactly what `QueueEngine` (BUN_QUEUE.md) does. The job types map directly:

```typescript
type InferenceJob =
  | { kind: "ocr";    image: Buffer; tcs: PromiseWithResolvers<OcrResult> }
  | { kind: "translate"; text: string; engine: string; tcs: PromiseWithResolvers<string> }
  | { kind: "textseg"; image: Buffer; tcs: PromiseWithResolvers<TextSegResult> }
  | { kind: "inpaint"; image: Buffer; mask: Buffer; tcs: PromiseWithResolvers<Buffer> }
  | { kind: "bubble";  image: Buffer; tcs: PromiseWithResolvers<BubbleBox[]> }
```

Route handlers do:
```typescript
const { promise, resolve, reject } = Promise.withResolvers<OcrResult>();
inferenceQueue.enqueue({ kind: "ocr", image, tcs: { promise, resolve, reject } });
const result = await promise;
```

---

## Migration Phases

### Phase 0 — Project scaffold (½ day)

- `cd server-bun && bun init`
- Install: `elysia`, `onnxruntime-node`, `sharp`, `node-canvas`, `drizzle-orm`,
  `drizzle-kit`, `@huggingface/hub`, `deepl-node`, `kuromoji`, `@types/*`
- Add to `web-ocr.code-workspace` folders
- Create `src/env.ts` with all env var definitions

### Phase 1 — Database + stores (1 day)

- Write `src/db/schema.ts` — translate all 6 EF Core entities to Drizzle table defs
- `bun run db:generate` → initial migration
- Write all 4 store classes
- Verify schema matches `data/ocr.db` column names (use `bun:sqlite` pragma to compare)

### Phase 2 — Inference services (2–3 days)

Order matters (each depends on the previous for integration testing):

1. `model-downloader.ts` + `boot.ts` — downloads models, sets readiness flags
2. `ocr.ts` — manga-OCR encoder-decoder seq2seq
3. `translate.ts` — Opus-MT + DeepL
4. `textseg.ts` — comictextdetector + connected-component + BFS
5. `bubble-detection.ts` — RT-DETR + NMS
6. `inpaint.ts` — LaMa crop/pad/infer/composite via `sharp`
7. `typeset.ts` — `node-canvas` text render onto inpainted image

### Phase 3 — API routes (1–2 days)

Port all 40+ routes from `server/src/Routes/*.cs` into Elysia plugins. Most are
thin wrappers around stores + queue enqueues; the porting is mechanical.

### Phase 4 — Wire SolidJS frontend (½ day)

- Copy `server/ClientApp/` into `server-bun/client/` (or symlink)
- Update `vite.config.ts` dev-server proxy from port 3579 → same port (no change if
  Elysia runs on the same port)
- Generate Eden Treaty types from the Elysia `App` export
- Update `api.ts` to use Eden Treaty instead of raw `fetch` (optional, incremental)

### Phase 5 — Single binary build + Docker (½ day)

- Write `build.ts` using `Bun.build` (see BUN_BUILD_FULLSTACK.md)
- Update `Dockerfile` to use `oven/bun` base image
- Remove .NET SDK layer (~300 MB saving in builder stage)

---

## ONNX Runtime: What to Expect

```typescript
import * as ort from "onnxruntime-node";

// Load model (once at boot)
const session = await ort.InferenceSession.create("data/models/ocr/encoder_model.onnx");

// Run inference (same tensor names as C#)
const feeds = { pixel_values: new ort.Tensor("float32", pixelData, [1, 3, 224, 224]) };
const result = await session.run(feeds);
const hidden = result["last_hidden_state"];
```

The C# code uses `new DenseTensor<float>(data, new[] { 1, 3, 224, 224 })` — the
TS version is one-to-one. All existing tensor shapes, input names, and output names
from the C# services are reusable without modification.

**Known difference:** `ort.Tensor` data must be `Float32Array`, not `number[]`.
Use `new Float32Array(pixelData)` when preparing inputs from `sharp` raw buffers.

---

## What Stays in C# (For Now)

Nothing is forced to stay. But the **desktop app** (`desktop/`) is Avalonia and will
remain C#. It already calls the server via HTTP (`ServerClient`), so it's decoupled.

If a Docker-only deployment is the target, the desktop app is irrelevant and the
entire C# codebase can be retired.

---

## Effort Estimate

| Phase | Estimate |
|---|---|
| Phase 0 — Scaffold | 0.5 days |
| Phase 1 — DB + stores | 1 day |
| Phase 2 — Inference services | 2–3 days |
| Phase 3 — API routes | 1–2 days |
| Phase 4 — Frontend wiring | 0.5 days |
| Phase 5 — Build + Docker | 0.5 days |
| **Total** | **5–7 days** |

Parallel risk mitigation: inference services (Phase 2) can be unit-tested against the
existing `data/models/` files before any routing work begins.

---

## Recommendation

**Do it.** The risks are all medium-or-lower, the gains are significant for a project
that will keep evolving, and the manga-reader reference project already proves the
stack works for an identical domain (manga serving + OCR + translation). The migration
is mechanical enough to be done in a focused sprint. Start with Phase 0–1 to validate
the DB schema, then a single inference service (OCR is the simplest) to prove the ONNX
path before committing to the full rewrite.
