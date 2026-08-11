# Project Memory: Selfhost OCR

## Overview

A self-hosted OCR system forked from [brian-girko/image-reader](https://github.com/brian-girko/image-reader). Two languages: **TypeScript** (extension) and **C#** (server + desktop).

## Project Structure

```
extension/     TypeScript + Bun browser extension (MV3)
server/        ASP.NET Core Minimal API + Blazor + SolidJS ClientApp (C#, .NET 10)
desktop/       Avalonia desktop companion (C#, .NET 10)
WebOcr.slnx    .NET 10 solution file
```

## Extension (`extension/`)

**Stack:** TypeScript, Bun, Tesseract.js v7, Manifest V3

### Key Files
- `src/background.ts` — Service worker: message routing, OCR engine selection, DeepL translation, job polling via `chrome.alarms`
- `src/content.ts` — Overlay UI: region selection, result panel (draggable/resizable), explain panel with dictionary, image picker mode
- `src/engine.ts` — Tesseract.js engine (runs in hidden iframe)
- `src/options.ts` — Settings page
- `src/types.ts` — Shared types: `Settings`, `TokenInfo`, `JishoEntry`, message types

### Architecture
- **Dual OCR engine:** Tesseract.js (in-browser) or self-hosted server (`/ocr` + `/analyze`)
- **Message flow:** popup → background → content → engine iframe (for Tesseract) or server (for remote)
- **Settings:** `ocrEngine`, `serverUrl`, `serverTranslation`, `tesseractLang`, `clientTranslation`, `deeplApiKey`
- **Image picker mode:** Click images on page → submit to server `/api/translate-page` → SSE streaming updates
- **Job polling:** Uses `chrome.alarms` for MV3-safe periodic polling of background translation jobs

### Build Commands
```bash
cd extension && bun install
bun run build        # production (type-check + build, bumps version)
bun run build:dev    # dev build only
bun run typecheck    # tsc --noEmit
```

## Server (`server/`)

**Stack:** ASP.NET Core Minimal API, Blazor Interactive Server, SolidJS + Vite client, ONNX Runtime

### Key Files
- `Program.cs` — Entry point
- `src/Config.cs` — Server config: `PORT` (3579), `DATABASE_URL`, `DEEPL_API_KEY`
- `src/ModelSettingsStore.cs` — Model config (env vars + `data/model-settings.json`)
- `src/ServiceExtensions.cs` — Service registration (`AddWebOcrServices` + `MapWebOcrRoutes`)
- `src/OcrEngine.cs` — ONNX OCR via Manga-OCR
- `src/TranslateService.cs` — ONNX translation via Opus-MT
- `src/AnalyzeService.cs` — Tokenization + dictionary lookup
- `src/DictionaryService.cs` — Jitendex dictionary with Jisho fallback
- `src/Workers/InferenceWorker.cs` — Background ONNX inference queue
- `src/Routes/` — Route handlers (one file per endpoint group)

### API Routes (`src/Routes/`)
- `POST /ocr` — OCR + optional translation
- `POST /analyze` — Tokenization + dictionary lookup
- `POST /translate-page` — Submit page translation job (returns `job_id`)
- `GET /api/translate-page/{jobId}/events` — SSE stream for page translation progress
- `GET /jobs/{id}/status` — Job status
- `GET /jobs/{id}/result-image` — Job result image
- `GET /api/settings` — Model settings
- `PUT /api/settings` — Update model settings (persisted)
- `GET /health` — Health check (`starting`/`ok`/`degraded`)

### Architecture
- **Non-blocking startup:** `BootBackgroundService` runs in background; HTTP server starts immediately
- **BootState singleton:** Per-model readiness flags (`IsReady`, `DictionaryReady`, `InpaintReady`, `BubbleReady`)
- **Inference queue:** `Channel<InferenceJob>` processed by `InferenceWorker` (CPU-bound ONNX sessions)
- **Database:** EF Core + SQLite (`AppDbContext` with `OcrLogs`, `TranslateLogs`, `PageTranslationJobs`)
- **JSON:** `snake_case` policy (`JsonNamingPolicy.SnakeCaseLower`)

### Models (env vars, persisted to `data/model-settings.json`)
| Model | Default Repo | Enabled |
|-------|--------------|---------|
| OCR | `mayocream/manga-ocr-onnx` | true |
| Translate | `Xenova/opus-mt-ja-en` | true |
| Inpaint | (disabled) | false |
| Bubble | (disabled) | false |

### Build Commands
```bash
cd server && bun install
bun run dev          # Vite dev server
bun run build        # Vite production build → wwwroot/js/app.js + app.css
dotnet build         # .NET compile check
dotnet run           # Starts on :3579
```

## Server ClientApp (`server/ClientApp/src/`)

**Stack:** SolidJS, @solidjs/router, Vite

### Key Files
- `solid-app.tsx` — Entry point; exposes `window.AppBridge.mount/unmount` for Blazor
- `api.ts` — Typed API client with snake_case ↔ camelCase conversion
- `types.ts` — TypeScript types for jobs, volumes, chapters, bubbles
- `styles.css` — Global styles

### Pages (lazy-loaded)
- `HomePage.tsx` — Dashboard
- `ServerStatusPage.tsx` — Server health/status
- `OpenApiPage.tsx` — API documentation
- `JobsListPage.tsx` — List of translation jobs
- `StudioPage.tsx` — Job editor (bubble editing, inpainting, rerender)
- `LibraryPage.tsx` — Volume list
- `VolumePage.tsx` — Volume chapters
- `ChapterPage.tsx` — Chapter pages

### Components
- `Layout.tsx` — App shell with navigation
- `BubbleEditor.tsx` — Edit bubble text/position/style
- `BubbleCanvas.tsx` — Canvas rendering for bubbles
- `BubbleList.tsx` — List of detected bubbles
- `TextStyleEditor.tsx` — Font/color/stroke settings
- `ConfirmDialog.tsx` — Confirmation modal
- `GroupJobsModal.tsx` — Group jobs into chapters
- `Modal.tsx` — Reusable modal

### Build Commands
```bash
cd server && bun install
bun run dev          # Vite dev server
bun run build        # Production build → wwwroot/js/app.js + app.css
```

### Vite Config
```typescript
export default defineConfig(({ mode }) => ({
  // ...
}));   // Note: closing })); not });
```

## Key Invariants

- Never pre-create `{dictDir}/extracted/` — DictionaryService detects fresh extraction by absence
- `dotnet ef` migrations must be committed — `server/Migrations/` is tracked
- `server/data/` is gitignored — models, DB, dictionary are runtime-only
- Server JSON is `snake_case` — ClientApp converts to camelCase for TypeScript
- Extension version in `package.json` + `manifest.json` — bumped on `bun run build`
