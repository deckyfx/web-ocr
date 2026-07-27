# Next Feature Plan

Four features to implement after PR #6 merges. Work on `master`.

---

## 1. Refresh button — Jobs and Library pages

**Files:** `server/ClientApp/src/pages/JobsListPage.tsx`, `server/ClientApp/src/pages/LibraryPage.tsx`

Both pages already expose `refetch` / `refetchVolumes` / `refetchChapters` from `createResource`.

**Jobs page:** Add a `RefreshCw` (lucide-solid) button in the header row, right-aligned next to the existing icon. Call `refetch()` on click. Spin the icon while `jobs.loading` is true.

**Library page:** Add a Refresh button next to "New Volume" / "New Chapter" in the header. Call both `refetchVolumes()` and `refetchChapters()`. Disable while either resource is loading.

No server changes needed.

---

## 2. Delete button per item — Jobs list page ✅ DONE (merged in PR #6)

**Already implemented.** `JobCard` uses `<div class="group relative ...">` outer wrapper with two sibling native `<button>` elements — delete (absolute top-left) and nav (full-width). No nested interactive elements. `ConfirmDialog` and `deleteError` signal fully wired.

---

## 3. Bubble inner-boundary detection — server-side (SkiaSharp) + frontend padding

### Context

The server already uses SkiaSharp (not OpenCV). The model is RT-DETR outputting bounding boxes only (no segmentation masks). Gemini's Scenario B (contour extraction from the cropped bbox) applies, but translated to SkiaSharp.

### Server-side: inner boundary refinement in `BubbleDetectionService.cs`

After detecting a `BubbleBox`, call a new helper `RefineToInnerBoundary` that crops the bbox from the original bitmap, finds the actual white inner area using SkiaSharp pixel access, and returns a tighter `BubbleBox`.

**Algorithm (pure SkiaSharp, no new dependencies):**

```csharp
private static BubbleBox RefineToInnerBoundary(SKBitmap src, BubbleBox box, byte brightnessThreshold = 220)
{
    int x0 = (int)box.X, y0 = (int)box.Y;
    int w  = (int)box.Width, h = (int)box.Height;

    // Clamp to image bounds
    x0 = Math.Max(0, x0); y0 = Math.Max(0, y0);
    w  = Math.Min(w, src.Width  - x0);
    h  = Math.Min(h, src.Height - y0);
    if (w <= 0 || h <= 0) return box;

    // BFS flood-fill from center to find connected bright region
    int cx = x0 + w / 2, cy = y0 + h / 2;
    var visited = new bool[w, h];
    var queue   = new Queue<(int, int)>();

    bool IsBright(int px, int py) {
        var c = src.GetPixel(px, py);
        return c.Red > brightnessThreshold && c.Green > brightnessThreshold && c.Blue > brightnessThreshold;
    }

    if (!IsBright(cx, cy)) return box; // center not white → no refinement

    queue.Enqueue((cx - x0, cy - y0));
    visited[cx - x0, cy - y0] = true;
    int minX = cx, maxX = cx, minY = cy, maxY = cy;

    while (queue.Count > 0) {
        var (lx, ly) = queue.Dequeue();
        int gx = lx + x0, gy = ly + y0;
        if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
        foreach (var (dx, dy) in new[]{(1,0),(-1,0),(0,1),(0,-1)}) {
            int nx = lx+dx, ny = ly+dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (visited[nx,ny]) continue;
            visited[nx,ny] = true;
            if (IsBright(nx+x0, ny+y0)) queue.Enqueue((nx,ny));
        }
    }

    // Apply a small fixed inset (3 px) to avoid edge contamination
    const int EdgeInset = 3;
    minX += EdgeInset; minY += EdgeInset;
    maxX -= EdgeInset; maxY -= EdgeInset;
    if (maxX <= minX || maxY <= minY) return box;

    return new BubbleBox(minX, minY, maxX - minX, maxY - minY, box.Confidence);
}
```

Call it in `DetectRtDetr` and `DetectYolo` just before adding to `result`:
```csharp
var refined = RefineToInnerBoundary(bitmap, new BubbleBox(x1, y1, bw, bh, score));
result.Add(refined);
```

**Trade-off:** BFS on the cropped region is O(w×h) per bubble — for a typical 200×200 crop this is ~40K pixel checks, negligible compared to ONNX inference time. `GetPixelSpan` can replace `GetPixel` for better cache performance if needed.

### Frontend: configurable display padding prop (fine-tuning only)

Even with server-side refinement, a small visual inset prop on `BubbleCanvas` is useful for tweaking:

**`BubbleCanvas.tsx`** — add prop:
```ts
/** Additional pixel inset on all sides for display only. Does not affect stored coords. */
bubblePadding?: number;
```
Apply in the rect/handle rendering helper. Default `0`.

**StudioPage** — expose as a number input (0–20 px), persisted to `localStorage`.

---

## 4. Push corrected job result back to the extension

This requires three layers: server SSE → `background.ts` → `content.ts`.

### Server — new SSE endpoint

Add to `PortalRoutes.cs`:
```http
GET /api/portal/jobs/{id}/events
Content-Type: text/event-stream
```

Keeps the connection open. Implementation: poll `AppDbContext` every ~2 s in a loop with `HttpContext.RequestAborted` as cancellation token. When `ResultImagePath` is populated or `Status` changes to `"done"`, emit:
```text
event: job-updated
data: {"id":"...","status":"done","result_available":true}
```

Close stream after emitting the done event (one-shot).

### Server — `/ocr` opt-in job tracking

Add an optional `track_job` boolean to `OcrRequest`. When `true`, save the submitted image as a `PageTranslationJob` and return `job_id` in the `OcrResponse`. The existing fast path (no `track_job`) is unchanged.

### Extension — `types.ts` additions

```ts
// New message type
export interface JobResultReadyMsg {
  type: "job-result-ready";
  jobId: string;
  resultImageDataUrl: string;
}
export type ToContentMsg = ... | JobResultReadyMsg;
```

### Extension — `background.ts`

After `runServerFlow` completes and response includes `job_id`:
1. Open `EventSource` to `{serverUrl}/api/portal/jobs/{jobId}/events`
2. On `job-updated` event with `result_available: true`:
   - Fetch `{serverUrl}/api/portal/jobs/{jobId}/result` as blob
   - Convert blob to base64 data URL
   - `sendToTab(tabId, { type: "job-result-ready", jobId, resultImageDataUrl })`
   - Close the `EventSource`

Store active `EventSource` instances in a `Map<string, EventSource>` keyed by `tabId` so they can be cleaned up on tab close.

### Extension — `content.ts`

Handle `"job-result-ready"` message:
- If the result panel is still open, replace or add the corrected image alongside the original crop
- OR show a small "Corrected image ready" banner with a click-to-view action

### Implementation order

1. `#1` Refresh buttons — ✅ DONE (committed to master)
2. `#2` Delete button — ✅ DONE (merged in PR #6)
3. `#3` Bubble inner-boundary refinement — ~2 h (server-side SkiaSharp BFS + optional frontend padding prop)
4. `#4` Push corrected jobs — ~3 h (server SSE + `/ocr` opt-in tracking + extension `background.ts`/`content.ts` wiring)
