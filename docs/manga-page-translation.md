# Manga Page Translation Pipeline

Full in-browser manga page translation: click an image → server detects speech bubbles → OCR → translate → inpaint → typeset → replace image in page.

---

## Overview

```text
User clicks image on page
        ↓
Extension uploads image to server
        ↓
Server pipeline (async job):
  [1] Bubble Detection   — RT-DETR ONNX → bounding boxes
  [2] OCR per bubble     — manga-ocr    → Japanese text
  [3] Translation        — opus-mt      → English text
  [4] Inpainting         — LaMa ONNX   → text removed from bubbles
  [5] Typesetting        — SkiaSharp   → translated text rendered into bubbles
        ↓
Extension polls for result → replaces <img> src with processed image
```

---

## Architecture

### Extension Side

| File | Role |
|---|---|
| `static/popup.html` | Mode selector shown when toolbar icon is clicked |
| `src/popup.ts` | Sends chosen mode message to content script |
| `src/background.ts` | Fetches cross-origin images on behalf of content script |
| `src/content.ts` | Image picker mode + upload + progress overlay + img replacement |
| `static/manifest.json` | `default_popup` → `popup.html` |

### Server Side

| File | Role |
|---|---|
| `src/Routes/TranslatePage.cs` | `POST /api/translate-page` → job ID; `GET /api/translate-page/{id}` → status/result |
| `src/Services/PageTranslationService.cs` | Orchestrates the full pipeline |
| `src/Services/BubbleDetectionService.cs` | YOLOv8 ONNX inference → bounding boxes |
| `src/Services/TypesettingService.cs` | SkiaSharp text rendering into inpainted image |
| `src/Jobs/TranslationJobStore.cs` | In-memory job registry (id → status, progress, result) |
| `src/BootState.cs` | Add `BubbleDetectorReady` flag |
| `src/ModelSettingsStore.cs` | Already has `BubbleEnabled`/`BubbleRepo` slots |

---

## Pipeline Stages Detail

### 1. Bubble Detection (RT-DETR ONNX)

- **Model**: `ogkalu/comic-text-and-bubble-detector` — `detector-v4-s_int8.onnx`
  - Architecture: RT-DETR-v2-S (ResNet50-vd backbone), INT8-quantised
  - Trained on ~11 000 images (manga, webtoon, manhwa, western comics)
  - 3 classes: **0=bubble**, 1=text-in-bubble, 2=text-outside-bubble  ← we use class 0 only
  - License: **Apache 2.0**  Size: **11.1 MB**
  - Used by [mayocream/koharu](https://github.com/mayocream/koharu) (same author as our OCR model)
- **Input**: `images [1, 3, 640, 640]` float32 normalised + `orig_target_sizes [1, 2]` int64 (H, W of padded input)
- **Output**: `labels [1, 300]` int64, `boxes [1, 300, 4]` float32 (x1,y1,x2,y2 pixel coords), `scores [1, 300]` float32
- **Post-process**: filter class 0 + confidence, NMS (IoU 0.45), unpad coordinates back to original image space
- **Fallback**: If model not configured → return whole image as single "bubble" (degrades gracefully; OCR still works on full image)
- **Env var**: `BUBBLE_MODEL_REPO=ogkalu/comic-text-and-bubble-detector` `BUBBLE_MODEL_FILES=detector-v4-s_int8.onnx` `BUBBLE_MODEL_ENABLED=true`

**Alternative models researched (ONNX available):**
- `kitsumed/yolov8m_seg-speech-bubble` — segmentation masks, `model_dynamic.onnx` (109 MB) — **GPL-3.0** ⚠️ (avoid)
- `Kiuyha/Manga-Bubble-YOLO` — `onnx/yolo26n.onnx` (6 MB) — Apache 2.0, E2E head (no NMS), input 1280×1280, output `(1,300,6)`

### 2. OCR per Bubble

- Crop each bounding box from original image (with ~5% padding)
- Run existing `MangaOcrService.RecognizeAsync(croppedPng)`
- Collect `(bbox, japanese_text)` pairs
- Skip bubbles where OCR returns empty string

### 3. Translation

- Run existing `TranslateService.TranslateAsync(text)` on each non-empty OCR result
- Collect `(bbox, source_text, translated_text)` triples

### 4. Inpainting

- **Model**: `Carve/LaMa-ONNX` — `lama_fp32.onnx`
  - Architecture: LaMa (Large Mask inpainting), Fourier-Convolution backbone
  - License: **Apache 2.0**  Size: **208 MB**  Input: fixed **512 × 512**
  - For each bubble: crop region → resize to 512×512 → run LaMa with bubble-shape mask → resize back → paste
  - **Manga-specific note**: `dreMaz/AnimeMangaInpainting` (MIT, 205 MB) is finetuned on 300k manga images
    but only exports `.ckpt` — no ONNX. Use generic `Carve/LaMa-ONNX` until an ONNX manga-finetuned model is available.
- **MVP fallback**: if inpaint model not loaded → white-fill bubble interior using SkiaSharp
- **Env var**: `INPAINT_MODEL_REPO=Carve/LaMa-ONNX` `INPAINT_MODEL_FILES=lama_fp32.onnx` `INPAINT_MODEL_ENABLED=true`

### 5. Typesetting (SkiaSharp)

- For each `(bbox, translated_text)`:
  - Binary-search best font size (max size where text fits in 85% of bubble bounds)
  - Word-wrap at found size
  - Render centered (horizontal + vertical) into bbox on the inpainted image
- Font: bundle `Bangers-Regular.ttf` (OFL license, designed for comics) as embedded resource
- Fallback font: `SKTypeface.Default`
- Text color: black `#1a1a1a`, stroke `white` for legibility on varied backgrounds

---

## API Contract

### Submit Job

```http
POST /api/translate-page
Content-Type: application/json

{
  "image": "<base64 PNG/JPEG>",
  "source_lang": "ja",
  "target_lang": "en"
}

→ 202 Accepted
{
  "job_id": "abc123"
}
```

### Stream Progress (SSE)

```text
GET /api/translate-page/{job_id}/events
Accept: text/event-stream

→ 200 text/event-stream

data: {"type":"log","message":"Uploading image... ✓","stage":"detecting","progress":0.05}

data: {"type":"log","message":"Detecting speech bubbles...","stage":"detecting","progress":0.1}

data: {"type":"log","message":"Detected 5 bubbles ✓","stage":"ocr","progress":0.15,"count":5}

data: {"type":"log","message":"Extracting text: bubble 1 / 5...","stage":"ocr","progress":0.2}

data: {"type":"log","message":"Translating...","stage":"translating","progress":0.6}

data: {"type":"log","message":"Removing original text...","stage":"inpainting","progress":0.75}

data: {"type":"log","message":"Rendering translated text...","stage":"typesetting","progress":0.9}

data: {"type":"done","result":"<base64 PNG>"}
```

SSE stream closes after `done` or `error` event. Extension uses `EventSource` to consume it — no polling needed.

### Fallback Poll (for environments where SSE fails)

```json
GET /api/translate-page/{job_id}

→ 200 OK
{
  "status": "pending | running | done | error",
  "stage":  "detecting | ocr | translating | inpainting | typesetting",
  "progress": 0.65,
  "result": "<base64 PNG>",
  "error": "..."
}
```

Job results held in memory 5 minutes after completion then evicted.

---

## Extension UI Flow

```text
[Toolbar icon click]
        ↓
┌─────────────────────┐
│  What do you want?  │
│                     │
│  ▭  Region scan     │  ← existing draw-to-select flow
│  🖼  Translate image │  ← new image picker mode
└─────────────────────┘
        ↓ (user picks "Translate image")
Content script enters image picker mode:
  - Cursor changes to crosshair/pointer
  - Hovering <img> elements shows blue highlight + "Click to translate" tooltip
  - Clicking captures the image

        ↓
Progress overlay appears over the original image:
  "Uploading…"
  "Detecting bubbles…"
  "OCR + translating… (3/7 bubbles)"
  "Inpainting…"
  "Typesetting…"
  "Done ✓"

        ↓
Original <img> src replaced with processed image data URL
```

---

## Implementation Phases

### Phase 1 — Extension popup + image picker (Sprint 1)
- [ ] `static/popup.html` — two-button mode selector
- [ ] `src/popup.ts` — sends message, closes popup
- [ ] `src/background.ts` — add `fetch-image` message handler for cross-origin images
- [ ] `src/content.ts` — `startImageMode()`, image highlight, upload, progress overlay, src replacement
- [ ] `static/manifest.json` — `default_popup`, remove `onClicked` dependency
- [ ] `build.ts` — add `popup.ts` entry

### Phase 2 — Server pipeline skeleton (Sprint 1, parallel)
- [ ] `TranslationJobStore.cs` — in-memory job store with log list + TTL eviction
- [ ] `TranslatePage.cs` — POST + GET + SSE `/events` endpoints
- [ ] `PageTranslationService.cs` — pipeline orchestration with per-step log callbacks
- [ ] `BubbleDetectionService.cs` — YOLOv8 ONNX + NMS + white-fill fallback
- [ ] `TypesettingService.cs` — SkiaSharp auto-size + word-wrap + render
- [ ] Register services in `ServiceExtensions.cs`

### Phase 3 — Wire real models (Sprint 2)
- [x] Research ONNX models — see §Pipeline Stages Detail for full findings
- [ ] Enable bubble model: `BUBBLE_MODEL_ENABLED=true` — `ogkalu/comic-text-and-bubble-detector` `detector-v4-s_int8.onnx` (11 MB, Apache 2.0)
- [ ] Enable inpaint model: `INPAINT_MODEL_ENABLED=true` — `Carve/LaMa-ONNX` `lama_fp32.onnx` (208 MB, Apache 2.0)
- [ ] Wire `InpaintService` into pipeline (replace white-fill fallback in `PageTranslationService.cs`)
- [ ] Bundle Bangers font as embedded resource

### Phase 4 — Polish (Sprint 3)
- [x] SSE streaming for real-time progress (see Stream Progress endpoint above)
- [ ] Per-bubble progress count in extension overlay
- [ ] "Undo" button in extension to restore original src
- [ ] Handle `<canvas>` elements (extract via `canvas.toDataURL()`)

---

## Key Invariants

- Jobs are **in-memory only** — not persisted to DB, evicted after 5 min
- Bubble detection failure is **non-fatal** — whole image treated as single region
- Inpaint model absence is **non-fatal** — white-fill fallback used
- Extension image fetch goes through **background service worker** to bypass CORS
- Pipeline runs through **existing `InferenceQueue`** — CPU-bound work is serialized, no parallel ONNX sessions

---

## File Change Summary

```text
extension/
  static/manifest.json        modified — default_popup
  static/popup.html           NEW
  static/popup.css            NEW
  src/popup.ts                NEW
  src/background.ts           modified — add fetch-image handler
  src/content.ts              modified — image picker mode, upload, overlay
  build.ts                    modified — add popup entry

server/
  src/Routes/TranslatePage.cs          NEW
  src/Services/PageTranslationService.cs NEW
  src/Services/BubbleDetectionService.cs NEW
  src/Services/TypesettingService.cs   NEW
  src/Jobs/TranslationJobStore.cs      NEW
  src/BootState.cs                     modified — BubbleDetectorReady
  src/ServiceExtensions.cs             modified — register new services
```
