# Selfhost OCR

A browser extension (MV3) that lets you select any region on screen and extract text via OCR. Supports two engines: **Tesseract.js** (runs entirely in-browser, no server needed) or a **self-hosted Rust server** for GPU-accelerated OCR with optional translation.

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
server/        Self-hosted OCR + translation server (Rust + ONNX)
desktop/       Desktop companion app (Dioxus)
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
bun run build:dev    # dev — skips version bump archive
```

Load the extension in Chrome: `chrome://extensions` → **Load unpacked** → select `extension/dist/`

### Tesseract Engine (default)

No server needed. Language data is downloaded on first use from `tessdata.projectnaptha.com`.

Supported languages include Japanese (`jpn`), Japanese vertical (`jpn_vert`), English (`eng`), Chinese Simplified/Traditional, Korean, and more — selectable in the settings page.

Go to the extension settings, choose **Tesseract** tab, select a language, click **Check Language** to verify the traineddata is available, then save.

### Self-hosted Server Engine

Requires running the Rust server locally.

```bash
cd server
cargo run --release
```

Default address: `http://localhost:3579`

In extension settings, choose the **Remote Server** tab, enter the server URL, click **Test Connection**, then save.

## Server Features

- ONNX-based OCR (faster than Tesseract on CPU/GPU)
- Optional local translation (Jitendex dictionary)
- Optional DeepL translation (requires API key)
- `/health` endpoint reports version and capabilities

## Version

The extension version lives in `extension/package.json` and `extension/static/manifest.json`. Every `bun run build` automatically bumps the patch number and keeps both files in sync.
