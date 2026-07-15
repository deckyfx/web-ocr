# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

```
extension/   TypeScript + Bun browser extension (MV3)
server/      ASP.NET Core Minimal API + Blazor (C#, .NET 10)
desktop/     Avalonia desktop companion (C#, .NET 10)
WebOcr.slnx  .NET 10 solution (open with `dotnet build WebOcr.slnx`)
```

Two languages only: **TypeScript** (extension) and **C#** (server + desktop).

## Common commands

### Extension

```bash
cd extension
bun install
bun run build        # production (type-check + build, bumps version)
bun run build:dev    # dev build only
bun run typecheck    # tsc --noEmit
```

### Server

```bash
cd server
dotnet build                         # compile check
dotnet run                           # starts on :3579; downloads models on first run
dotnet ef migrations add <name>      # after schema changes to src/Data/AppDbContext.cs
dotnet ef database update            # apply locally
```

### Desktop

```bash
cd desktop
dotnet build
dotnet run
```

### Both C# projects together

```bash
dotnet build WebOcr.slnx
```

## Server architecture

**Startup is non-blocking.** `BootBackgroundService` (a `BackgroundService`) runs scaffolding, DB migrations, model downloads, and service init in the background. The HTTP server accepts requests immediately; `/health` returns `"starting"` until `BootState.IsReady = true`.

**`BootState`** is a singleton with per-model readiness flags:
- `IsReady` — true after OCR + Translate services have loaded
- `DictionaryReady` — true only if `DictionaryService.InitializeAsync()` succeeded (failure is non-fatal; `/health` returns `"degraded"`)
- `InpaintReady`, `BubbleReady` — set only when those models are enabled and downloaded
- `InpaintEnabled`, `BubbleEnabled` — mirrors enabled flag from `ModelSettingsStore` so `/health` can distinguish "disabled" from "pending"

**`ModelSettingsStore`** is a singleton that holds runtime-configurable model settings (repo, local dir, enabled, file list). On startup it merges env vars → persisted `data/model-settings.json` → hard-coded defaults. Settings can be updated at runtime via `PUT /api/settings` (persisted to JSON; model changes take effect on next restart).

**Inference queue** — ONNX sessions are CPU-bound. All OCR and translate work is routed through `InferenceQueue` (a `Channel<InferenceJob>`) processed by `InferenceWorker` (a `BackgroundService`). Route handlers enqueue a job and `await` a `TaskCompletionSource<object>`.

**Service registration** is in `ServiceExtensions.cs` (`AddWebOcrServices` + `MapWebOcrRoutes`). Route files are in `src/Routes/`, one extension class per endpoint group.

**Config** is split across two places:

`src/Config.cs` — server/infrastructure config (env vars):

| Var | Default |
|-----|---------|
| `PORT` | `3579` |
| `SOCKET_PATH` | `""` (unset — TCP mode) |
| `DATABASE_URL` | `./data/ocr.db` |
| `DEEPL_API_KEY` | `""` |

`src/ModelSettingsStore.cs` — model config (env vars, also persisted to `data/model-settings.json`):

| Var | Default |
|-----|---------|
| `OCR_MODEL_REPO` | `mayocream/manga-ocr-onnx` |
| `OCR_MODELS_DIR` | `./data/models/ocr` |
| `OCR_MODEL_ENABLED` | `true` |
| `OCR_MODEL_FILES` | `encoder_model.onnx,decoder_model.onnx,vocab.txt` |
| `TRANSLATE_MODEL_REPO` | `Xenova/opus-mt-ja-en` |
| `TRANSLATE_MODELS_DIR` | `./data/models/translate` |
| `TRANSLATE_MODEL_ENABLED` | `true` |
| `TRANSLATE_MODEL_FILES` | `onnx/encoder_model.onnx,onnx/decoder_model.onnx,tokenizer.json` |
| `INPAINT_MODEL_REPO` | `""` (disabled) |
| `INPAINT_MODELS_DIR` | `./data/models/inpaint` |
| `INPAINT_MODEL_ENABLED` | `false` |
| `INPAINT_MODEL_FILES` | `model.onnx` |
| `BUBBLE_MODEL_REPO` | `""` (disabled) |
| `BUBBLE_MODELS_DIR` | `./data/models/bubble` |
| `BUBBLE_MODEL_ENABLED` | `false` |
| `BUBBLE_MODEL_FILES` | `model.onnx` |
| `DICT_DIR` | `./data/models/jdict` |

**Database** uses EF Core + SQLite. `AppDbContext` has `OcrLogs` and `TranslateLogs`. Migrations live in `server/Migrations/` and are applied automatically at boot via `db.Database.MigrateAsync()`.

**JSON serialization** uses `snake_case` policy (`JsonNamingPolicy.SnakeCaseLower`) — all API field names are lowercase snake_case.

**Blazor** — `server/` also serves a Blazor Interactive Server app (UI for future admin/dashboard use). The minimal API routes and Blazor coexist; routes are registered before `MapRazorComponents`. The React/Vite client (`server/src/` TypeScript) is a separate frontend bundled by Vite.

### Server Vite client

`server/` has a **SolidJS + Vite** frontend under `server/ClientApp/src/` (TypeScript). Entry point is `solid-app.tsx`; it exposes `window.AppBridge.mount/unmount` consumed by the Blazor `Index.razor` page. Output lands in `wwwroot/js/app.js` + `app.css`.

The `vite.config.ts` uses the arrow-function form:

```typescript
export default defineConfig(({ mode }) => ({
  // ...
}));   // Note: closing })); not });
```

```bash
cd server
bun install
bun run dev   # Vite dev server
bun run build # Vite production build → wwwroot/js/app.js + app.css
```

## Desktop architecture

**State machine** — `MainViewModel` drives the app through `AppStatus` states: `Idle → Capturing → Selecting → Analyzing → Error`.

**Services:**
- `HotkeyService` — SharpHook global hotkey (`Super+Shift+O`)
- `ScreenCaptureService` — captures the primary monitor via `System.Drawing`
- `LocalTesseractService` — on-device Tesseract 5 OCR (fallback when server is unavailable); downloads `tessdata` on first use
- `ServerClient` — typed `HttpClient` wrapper for `/ocr`, `/analyze`, `/health`; attaches `X-Api-Key` header when `ApiKey` is set in `AppSettings`

**Settings** are persisted to disk via `SettingsStore` and include `ServerUrl` (default `http://localhost:3579`) and `ApiKey`.

**UI** — Avalonia XAML, `OverlayWindow` is a fullscreen transparent window for region selection.

## Extension architecture

MV3 extension with two OCR engines:
- **Tesseract.js** — runs entirely in-browser via `engine.ts`
- **Remote server** — calls the C# server's `/ocr` + `/analyze` endpoints

Key files: `background.ts` (service worker), `content.ts` (overlay + selection), `options.ts` (settings page), `types.ts` (shared types).

## Key invariants

- **Never pre-create `{dictDir}/extracted/`** — `DictionaryService.InitializeAsync()` detects a fresh extraction by the absence of that directory; creating it beforehand makes it think extraction already succeeded.
- **`dotnet ef` migrations must be committed** — `server/Migrations/` is tracked in git; never delete migration files.
- **`server/data/` is gitignored** — models, database, and extracted dictionary are runtime-only.
- **`server/bin/`, `server/obj/`, `desktop/bin/`, `desktop/obj/`, `*/publish/`** are gitignored — never commit build output.
