# Studio V2 — Implementation Plan

## Goal

Redesign the Studio page into a proper 4-stage pipeline workspace:
- **Stage 1 (Original)** — detect bubbles, run OCR/translate, inpaint
- **Stage 2 (Inpainted)** — read-only view of Stage 1 output
- **Stage 3 (Compose)** — free text overlay editing (position, font, color, stroke, rotation)
- **Stage 4 (Result)** — read-only view of burned Stage 3 output

After Burn, the Studio page notifies the extension via `window.postMessage` (no new server infrastructure needed — the extension's `content.ts` is already injected into the Studio tab).

---

## Key Invariants

- Stage 2 and Stage 4 are **read-only**; all editing happens in Stage 1 and Stage 3.
- When 2 stages are displayed side-by-side, the **earlier stage is always on the left** (sorted by pipeline order), regardless of click order.
- Left panel and right panel are independently **collapsible**.
- Toolbar buttons are **context-sensitive** to the active stages; inactive-stage buttons are hidden/greyed.
- `server/.env` must never be committed. Never push without explicit user instruction.

---

## Phase 1 — Backend: New Text Properties + DB Migration

### 1.1 New columns on `PageTranslationLog`

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `FontColor` | `string?` | `null` → `#1a1a1a` | Text fill color (CSS hex) |
| `StrokeColor` | `string?` | `null` → none | Text stroke/outline color |
| `StrokeWidth` | `int?` | `null` → 0 | Stroke width in pixels |
| `Rotation` | `float?` | `null` → 0 | Degrees, free rotation |
| `TextAlign` | `string?` | `null` → `center` | `left` / `center` / `right` |

File: `server/src/Data/AppDbContext.cs`  
Migration: `dotnet ef migrations add AddTextStyleProperties`

### 1.2 Update `BubbleTranslation` record

`server/src/Services/TypesettingService.cs`

Add new optional fields matching the DB columns:
```csharp
public record BubbleTranslation(
    BubbleBox Box,
    string    SourceText,
    string    TranslatedText,
    string?   FontFamily       = null,
    int?      FontSizeOverride = null,
    string?   FontColor        = null,   // new
    string?   StrokeColor      = null,   // new
    int?      StrokeWidth      = null,   // new
    float?    Rotation         = null,   // new
    string?   TextAlign        = null);  // new
```

### 1.3 Update `TypesettingService.RenderTextInBubble`

- Parse `FontColor` hex → `SKColor` (fallback `#1a1a1a`)
- If `Rotation != 0`: `canvas.Save()` → `canvas.RotateDegrees(rotation, centerX, centerY)` → render → `canvas.Restore()`
- If `StrokeColor` set: render text twice — first with stroke paint (`Style = Stroke`, `StrokeWidth`), then with fill paint
- `TextAlign`: map to left/center/right X position when placing each line

### 1.4 Update `PageTranslationService` mapping

Wherever `BubbleTranslation` is constructed from DB rows (in `RerenderAsync`, `ReocrBubbleAsync`, route handlers), map the new columns.

---

## Phase 2 — Extension Notification via postMessage

No new server infrastructure. The Studio page runs in a browser tab where `content.ts` is already injected.

### 2.1 Studio page — after Burn Texts resolves

`server/ClientApp/src/pages/StudioPage.tsx`, inside `handleRerender` after `pollUntilDone`:

```ts
window.postMessage({
  type: 'web-ocr:image-updated',
  jobId: params.id,
  resultUrl: jobResultUrl(params.id),
}, '*');
```

### 2.2 `content.ts` — relay to background

```ts
window.addEventListener('message', (e) => {
  if (e.data?.type === 'web-ocr:image-updated') {
    chrome.runtime.sendMessage(e.data);
  }
});
```

### 2.3 `background.ts` — notify other tabs

```ts
case 'web-ocr:image-updated': {
  const { resultUrl } = msg as ImageUpdatedMsg;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id!, { type: 'image-updated', resultUrl });
    }
  });
  break;
}
```

### 2.4 `content.ts` — replace image in page

```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'image-updated') {
    document.querySelectorAll<HTMLImageElement>('img[data-web-ocr-result]').forEach(img => {
      img.src = msg.resultUrl + '?v=' + Date.now();
    });
  }
});
```

The extension already marks replaced images with `data-web-ocr-result` (verify in `content.ts`; add the attribute if missing).

---

## Phase 3 — Frontend: Layout Restructure

### 3.1 Stage ordering fix

`StudioPage.tsx` — `toggleStage`:

```ts
// After computing next[], sort by pipeline index before setting:
const ORDER: Record<Stage, number> = { original:0, inpainted:1, compose:2, result:3 };
return [...next].sort((a,b) => ORDER[a] - ORDER[b]);
```

### 3.2 Collapsible panels

Add two boolean signals: `leftOpen` (default `true`), `rightOpen` (default `true`).

Left panel: `<aside class={leftOpen() ? "w-52" : "w-0 overflow-hidden"}>` + chevron toggle button on the border.  
Right panel: same pattern with `rightOpen`.

Chevron button sits on the inner edge of each panel, always visible.

### 3.3 Split left panel

Left panel has two stacked sections, each only rendered when the relevant stage is active:

```
[Stage 1/2 section]  shown when activeStages includes "original" or "inpainted"
  → BubbleDetectionList  (index, confidence badge, OCR text snippet)

[Stage 3/4 section]  shown when activeStages includes "compose" or "result"
  → TextOverlayList  (index, translated text snippet, color swatch)
```

Both show if all 4 stages are somehow active (shouldn't happen with max-2 rule, but be defensive).

Selection state: two separate signals — `selectedBubbleIndex` (Stage 1) and `selectedTextIndex` (Stage 3).  
Clicking an item in either section selects it on the corresponding canvas and shows the right panel.

### 3.4 Context-sensitive right panel

Right panel switches component based on which left-panel item was last clicked:

| Last selected | Right panel shows |
|---|---|
| Bubble (Stage 1) | `BubbleEditor` — position, OCR text, re-OCR, re-translate |
| Text overlay (Stage 3) | `TextStyleEditor` — content, font family, size, color, stroke color, stroke width, rotation (field + handle), alignment |
| Nothing | Empty state / hint |

New component: `server/ClientApp/src/components/TextStyleEditor.tsx`

Fields: textarea for translated text, font family dropdown, font size number, color picker (FontColor), stroke color picker, stroke width, rotation number input, alignment toggle (L/C/R).  
On change: calls `PATCH /api/portal/jobs/{id}/bubbles/{index}` with updated fields.

### 3.5 Context-sensitive toolbar buttons

Replace current flat button row with stage-aware groups:

**Always visible:** ← back, title, status badge, stage picker, padding control

**Stage 1 active:**
- `Detect Bubbles` — re-runs detection (existing `handleRedetect`)
- `Inpaint All` — re-runs inpainting on all current bubble rects, regenerates `inpainted.png` (new route or repurpose existing rerender without text step)
- `Re-OCR` — enabled only when a bubble is selected (existing per-bubble re-OCR)

**Stage 3 active:**
- `Auto Texts` — re-runs OCR + translate pipeline, repopulates text overlays (existing `handleRetranslate` but triggered from here)
- `Burn Texts` — calls rerender, waits for done, SSE notifies extension (existing `handleRerender`)

**Stage 2 / Stage 4:** no action buttons (read-only stages).

Delete button stays always-visible (far right, red).

---

## Phase 4 — Frontend: Stage 3 Canvas Handles

### 4.1 Resize handles on text overlays

In `BubbleCanvas.tsx`, when `showTextOverlay` is true and a text overlay is selected:

Render 8 small `<rect>` handle elements at corners and edge midpoints of the `foreignObject` bounding box.  
Drag logic: `onMouseDown` on handle → compute resize delta → call `onResize(bubbleIndex, newX, newY, newW, newH)`.

### 4.2 Rotation handle

Above the selected text overlay, render a circular handle connected by a line to the top-center of the box.

Drag logic: compute angle from box center to mouse position → call new `onRotate(bubbleIndex, degrees)` prop.

`onRotate` calls `updateBubble` with `rotation` field → server PATCH → `refetchBubbles`.

### 4.3 Visual feedback

- Non-selected overlays: semi-transparent text, no handles
- Selected overlay: solid text + resize handles + rotation handle + blue outline

---

## Phase 5 — Extension: Wire postMessage Bridge

Changes are minimal — see Phase 2 for full detail.

Files touched:
- `extension/src/content.ts` — add `window.addEventListener('message', ...)` relay + `chrome.runtime.onMessage` image-replace handler
- `extension/src/background.ts` — add `web-ocr:image-updated` case in message switch
- `extension/src/types.ts` — add `ImageUpdatedMsg` type

Verify that `content.ts` already sets `data-web-ocr-result` attribute on replaced images; add it if not.

---

## Implementation Order

```
Phase 1  DB + TypesettingService   (backend, no frontend impact)
Phase 2  SSE infrastructure        (backend)
Phase 3  Layout restructure        (frontend — panels, toolbar, left/right split)
Phase 4  Stage 3 canvas handles    (frontend — most complex UI work)
Phase 5  Extension SSE listener    (extension)
```

Each phase can be a separate PR. Phase 3 and 4 may ship together as one PR since the UI overhaul is coherent.

---

## New Routes Needed

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/portal/jobs/{id}/inpaint` | Re-inpaint all bubbles (no text render) — Stage 1 "Inpaint All" button |

Existing route `PUT /api/portal/jobs/{id}/rerender` already handles Burn Texts.  
Existing `PATCH /api/portal/jobs/{id}/bubbles/{index}` needs new fields (`fontColor`, `strokeColor`, `strokeWidth`, `rotation`, `textAlign`).  
No SSE route needed.

---

## Files Touched (summary)

### Server (C#)
- `src/Data/AppDbContext.cs` — new columns
- `Migrations/` — new migration
- `src/Services/TypesettingService.cs` — rotation, color, stroke, alignment
- `src/Services/PageTranslationService.cs` — map new BubbleTranslation fields; new `InpaintOnlyAsync` method
- `src/Routes/PortalRoutes.cs` — new `/inpaint` route, PATCH new fields

### ClientApp (SolidJS)
- `src/pages/StudioPage.tsx` — stage ordering, collapsible panels, toolbar, left/right split
- `src/components/BubbleCanvas.tsx` — resize + rotation handles for Stage 3
- `src/components/BubbleEditor.tsx` — possibly extend or keep as-is for Stage 1
- `src/components/TextStyleEditor.tsx` — new component for Stage 3 right panel
- `src/components/BubbleDetectionList.tsx` — new component (Stage 1 left section)
- `src/components/TextOverlayList.tsx` — new component (Stage 3 left section)
- `src/api.ts` — new endpoint calls
- `src/types.ts` — new fields on `TranslationBubble`

### Extension
- `src/background.ts` — SSE connect + notifyTabsOfImageUpdate
- `src/content.ts` — image-updated message handler
- `src/types.ts` — new message type
