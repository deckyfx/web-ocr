# Selfhost OCR

> Forked from [brian-girko/image-reader](https://github.com/brian-girko/image-reader) — original OCR Image Reader extension by Brian Girko, licensed under MPL 2.0.

A browser extension (MV3) that lets you select any region on screen and extract text via OCR. Supports two engines: **Tesseract.js** (runs entirely in-browser, no server needed) or a **self-hosted C# server** for GPU-accelerated OCR with optional translation.

## Features

- Click the toolbar button, drag to select a region — text appears instantly
- **Dual engine**: Tesseract.js (offline, in-browser) or self-hosted server (faster, optional DeepL translation)
- **Japanese vertical text** support via `jpn_vert` traineddata (reads columns right-to-left)
- Per-word dictionary panel (Jisho or local Jitendex) with romaji and JLPT tags
- Draggable, resizable result panel
- DeepL translation (client-side or server-side)
- Manifest V3 — works on Chrome, Edge, and Firefox

## Project Structure

```
extension/     Browser extension (TypeScript + Bun)
server/        Self-hosted OCR + translation server (ASP.NET Core + ONNX)
desktop/       Desktop companion app (Avalonia / C#)
WebOcr.slnx    .NET 10 solution file
```

## Extension Setup

### Requirements

- [Bun](https://bun.sh) v1.2+
- Chrome / Edge / Firefox (MV3)

### Build

```bash
cd extension
bun install
bun run build        # production — bumps patch version, outputs to dist/
bun run build:dev    # dev — skips version bump / archive
```

Load the extension in Chrome: `chrome://extensions` → **Load unpacked** → select `extension/dist/`

### Tesseract Engine (default)

No server needed. Language data is downloaded on first use from `tessdata.projectnaptha.com`.

Supported languages include Japanese (`jpn`), Japanese vertical (`jpn_vert`), English (`eng`), Chinese Simplified/Traditional, Korean, and more — selectable in the settings page.

### Self-hosted Server Engine

Requires running the C# server locally. On first run it automatically downloads all required ONNX models (~500 MB) and the Jitendex dictionary.

```bash
cd server
dotnet run
```

Default address: `http://localhost:3579`

In extension settings, choose the **Remote Server** tab, enter the server URL, click **Test Connection**, then save.

## Server Features

- ONNX-based OCR via Manga-OCR (`mayocream/manga-ocr-onnx`)
- Local Japanese→English translation via Opus-MT (`Xenova/opus-mt-ja-en`)
- Jitendex dictionary with Jisho HTTP fallback
- NMeCab morphological tokenization
- Optional DeepL translation (requires `DEEPL_API_KEY`)
- `/health` endpoint reports readiness (`starting` / `ok` / `degraded`)
- Background inference queue — HTTP server accepts requests immediately while models load

## Desktop App

The Avalonia desktop companion runs in the system tray and provides a global hotkey (`Super+Shift+O`) to capture a screen region and analyze it without a browser.

```bash
cd desktop
dotnet run
```

The app sends captured regions to the running server at `http://localhost:3579` (configurable in settings).

## Version

The extension version lives in `extension/package.json` and `extension/static/manifest.json`. Every `bun run build` automatically bumps the patch number and keeps both files in sync.
