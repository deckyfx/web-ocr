# Next Sprint Plan — TextSeg First-Class Citizen

## Context / Where We Left Off

Session ended on branch **`refactor/split-large-files`** at tag **`before-break`** (`ec69411`).

### Branch state at session end
```
master                    ← clean, v1.4.0, no MiMo work
refactor/split-large-files ← at before-break (ec69411) — last good state
wip/mimo-refactor          ← saved MiMo's broken work for reference
```

### Why before-break
Another AI agent (MiMo) attempted the REFACTOR-PLAN.md changes but broke things:
- Stripped `id` fields from `textseg_blocks.json` → Studio delete broke
- Used raw (unexpanded) TextSeg box coords as typesetting targets → text in tiny boxes
- The working result was saved to `wip/mimo-refactor` for reference; `refactor/split-large-files`
  was reset to `before-break` so we start from a clean baseline.

The original `REFACTOR-PLAN.md` (fully remove bubble detection) remains a **future goal**.
This sprint takes a smaller, safer step first.

---

## This Sprint's Goal

**Make TextSeg the first-class citizen in the UI, without breaking the pipeline.**

The pipeline keeps running exactly as it does today (bubble detection still runs, still groups
TextSeg blocks by bubble for OCR, still uses bubble boxes as typesetting targets). Only the UI
changes: instead of showing bubble boxes to the user, we show TextSeg blocks everywhere.

The user never sees "bubble #3"; they see "text segment #3" with its OCR text and translation.

---

## Two Bugs to Fix in This Sprint

### Bug 1 — TextSeg Grouping: Runaway Chain-Merging

**File**: `server/src/Services/TextSegmentationService.cs`

**Symptom**: Entire bottom-left section of a page collapses into one 597×682 px blob
(observed in job `e0e361386ad7`). Also, some blocks include visible noise on their edges.

**Root cause**: The proximity-merge loop (step 3 in `FindTextBlocks`) merges any two boxes
whose X-gap ≤ 50px AND Y-gap ≤ 50px. This is iterative — after merging A and B, the enlarged
A+B becomes close enough to C, then A+B+C to D, etc. Small text lines chained through the
panel merge into one enormous box.

**Fix**: Add a max-size guard inside the merge condition. If the proposed merged rectangle
would be larger than `MaxMergedWidth × MaxMergedHeight` in both dimensions simultaneously,
skip that merge pair.

```csharp
// Add these constants (around line 60):
private const int MaxMergedWidth  = 300;  // px — each dimension must exceed to block merge
private const int MaxMergedHeight = 350;  // px

// Change the merge condition (around line 327):
// Before:
if (gapX <= MergeDistance && gapY <= MergeDistance)

// After:
int newX = Math.Min(ax, bx);
int newY = Math.Min(ay, by);
int newW = Math.Max(ax + aw, bx + bw) - newX;
int newH = Math.Max(ay + ah, by + bh) - newY;
bool tooBig = newW > MaxMergedWidth && newH > MaxMergedHeight;
if (gapX <= MergeDistance && gapY <= MergeDistance && !tooBig)
{
    rects[i] = (newX, newY, newW, newH);
    rects.RemoveAt(j);
    j--;
    anyMerged = true;
}
```

Note: the guard uses AND (both dimensions must exceed), not OR, so valid tall vertical-text
columns (84×242) and wide horizontal rows are still merged correctly.

---

### Bug 2 — textseg_blocks.json Missing OCR/Translation Text

**File**: `server/src/Services/PageTranslationService.cs`

**Symptom**: After running a full pipeline job, `textseg_blocks.json` has `source_text: null`
and `translated_text: null` for all blocks. The OCR results only go to `OcrLog` in the DB,
never written back to the JSON file that Studio reads.

**Root cause**: The pipeline writes `textseg_blocks.json` at step 1 (detection), then discards
the connection between that file and the OCR results computed in step 4.

**Fix**: Load `textseg_blocks.json` into memory before the OCR loop, match each `BubbleBox`
region to its `TextSegBlock` by integer coordinates, update `source_text` and `translated_text`
during the loop, then write the file back once all groups are done.

**Implementation sketch** (in the main pipeline method, around the OCR loop):

```csharp
// After writing textseg_blocks.json (line ~106), keep the list in memory:
List<TextSegBlock>? tsBlocks = textSegResult is not null ? blocks : null;
// (blocks is already defined above from the Select() call)

// Inside the OCR loop, after computing `part` for each individual region:
if (tsBlocks is not null && !string.IsNullOrEmpty(part))
{
    var match = tsBlocks.FirstOrDefault(
        b => b.X == (int)region.X && b.Y == (int)region.Y);
    if (match is not null) match.SourceText = part;
}

// After computing `translated` for the group:
if (tsBlocks is not null && !string.IsNullOrEmpty(translated))
{
    foreach (var region in groupRegions)
    {
        var match = tsBlocks.FirstOrDefault(
            b => b.X == (int)region.X && b.Y == (int)region.Y);
        if (match is not null) match.TranslatedText = translated;
    }
}

// After all groups, write back:
if (tsBlocks is not null)
{
    var updatedJson = System.Text.Json.JsonSerializer.Serialize(
        tsBlocks,
        new System.Text.Json.JsonSerializerOptions
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
        });
    await File.WriteAllTextAsync(Path.Combine(jobDir, "textseg_blocks.json"), updatedJson, ct);
}
```

Same fix must be applied to the re-OCR and re-translate action paths in
`server/src/Services/PageTranslationActions.cs`.

---

## Phase 2 — UI: TextSeg First-Class

> **Pipeline does not change.** Bubble detection still runs, still groups TextSeg blocks,
> still supplies typesetting targets. The user just never sees bubble boxes.

### New branch

```bash
git checkout refactor/split-large-files   # already at before-break
git checkout -b refactor/textseg-first-class
```

### 2.1 — StudioLeftPanel.tsx

**Goal**: Remove the dual-list (bubbles above, TextSeg below). Show ONLY the TextSeg list
in Stage 1 panel. Show text preview in each row instead of bare coordinates.

**Remove from props interface**:
- `panelContext: PanelContext`
- `selectedIndex: number | null`
- `bubbleList: TranslationBubble[]`
- `showBubbles: boolean`
- `isDrawMode: boolean`
- `onSelectStage1: (idx: number | null) => void`
- `onSelectStage3: (idx: number | null) => void`
- `onAddBubble: () => void`

**Stage 1 panel body** — replace the `<Show when={props.showBubbles}>` + `<BubbleList>` block
with just the TextSeg list (currently the second `<Show when={props.showTextSeg}>` block).
Change the draw mode indicator to only show the orange TextSeg mode.

**List item content** — replace `{box.w}×{box.h} @ {box.x},{box.y}` with:
```tsx
<span class="flex-1 truncate text-[10px] text-slate-500">
  {box.source_text
    ? box.source_text.slice(0, 20)
    : `${box.w}×${box.h}`}
</span>
```

**Stage 3 panel** — keep the existing overlay list as-is (shows typeset bubble regions by
translated text preview). This is fine since Stage 3 = compose view.

**Remove imports**: `BubbleList`, `TranslationBubble`, `PanelContext`.

---

### 2.2 — StudioPage.tsx

**Remove signals**:
- `showBubbles` — delete (was controlling bubble overlay visibility)
- `isDrawMode` — delete (was for bubble draw mode, only TextSeg draw remains)
- `panelContext` — delete
- `selectedIndex` — rename/clarify: this was used for both bubbles and stage3; keep only
  the stage3 usage (it drives text overlay selection, which we still need)

**Remove handlers**:
- `handleAddBubble`, `handleMove`, `handleResize`, `handleBubbleUpdate`,
  `handleBubbleContextMenu`, `handleBubbleDelete` (all bubble CRUD)

**Keep / rename**:
- `selectedTextSegIndex` / `setSelectedTextSegIndex` — unchanged, now the ONLY selection
- `isTextSegDrawMode` / `setIsTextSegDrawMode` — unchanged

**Update `<StudioLeftPanel>` call** — remove all the dropped props, no longer pass
`panelContext`, `showBubbles`, `isDrawMode`, `bubbleList`, `selectedIndex`, etc.

**Remove imports**: `getJobBubbles`, `addBubble`, `deleteBubble`, `updateBubble`,
`reocrBubble`, `retranslateBubble`, `reinpaintBubble`, `repatchBubble` from `../api`.

---

### 2.3 — TextSegDetail.tsx (right panel)

The component already exists. Update it to display `source_text` and `translated_text`
from the `TextSegBox` object once Bug 2 is fixed. Add a subtle "No text yet — run OCR"
placeholder when both are null.

**Type update** in `api.ts`:
```ts
export interface TextSegBox {
  id: string;
  x: number; y: number; w: number; h: number;
  source_text?: string | null;
  translated_text?: string | null;
}
```

---

### 2.4 — BubbleCanvas.tsx / StudioStageView.tsx

The canvas component already renders TextSeg overlays. Remove `bubbles` and `showBubbles`
props from the canvas component and its parent `StudioStageView`. The bubble overlay
rendering was already secondary; removing it cleans up prop drilling.

---

### 2.5 — What to DELETE (optional cleanup, can defer)

- `server/ClientApp/src/components/BubbleList.tsx` — no longer used in left panel
- `server/ClientApp/src/components/BubbleEditor.tsx` — bubble CRUD editor
- Bubble API functions in `api.ts`: `addBubble`, `deleteBubble`, `updateBubble`,
  `getJobBubbles`, `reocrBubble`, `retranslateBubble`, `reinpaintBubble`, `repatchBubble`

These can stay as dead code for a PR or be deleted. Either is fine.

---

## Verification Checklist (after implementation)

- [ ] `dotnet build` — zero errors
- [ ] `bun run typecheck` in `server/ClientApp` — zero errors
- [ ] `bun run build` in `server/ClientApp` — builds without warnings
- [ ] Run a full pipeline job on a manga page — no errors
- [ ] `textseg_blocks.json` now has `source_text` and `translated_text` populated
- [ ] Studio left panel shows TextSeg list only (no bubble list) in Stage 1
- [ ] Left panel rows show Japanese source text preview (not just coords)
- [ ] Selecting a row highlights that TextSeg block on the canvas
- [ ] Right panel (TextSegDetail) shows source + translated text
- [ ] Stage 3 overlay list still works (typeset bubble results)
- [ ] Add TextSeg block (draw mode) still works
- [ ] Delete TextSeg block still works (uses string id, not index)
- [ ] Inpaint still produces pixel-accurate results
- [ ] Re-OCR action still works via toolbar
- [ ] No large runaway TextSeg blobs for job `e0e361386ad7` after grouping fix

---

## Files Changed (summary)

| File | Change |
|------|--------|
| `server/src/Services/TextSegmentationService.cs` | Add max-size merge guard |
| `server/src/Services/PageTranslationService.cs` | Write OCR/translate back to textseg_blocks.json |
| `server/src/Services/PageTranslationActions.cs` | Same, for re-OCR and re-translate action paths |
| `server/ClientApp/src/api.ts` | Add `source_text`/`translated_text` to `TextSegBox` type |
| `server/ClientApp/src/pages/StudioPage.tsx` | Remove bubble signals/handlers/props |
| `server/ClientApp/src/components/StudioLeftPanel.tsx` | TextSeg-only list, text preview |
| `server/ClientApp/src/components/TextSegDetail.tsx` | Display source + translated text |
| `server/ClientApp/src/components/BubbleCanvas.tsx` | Remove bubble props |
| `server/ClientApp/src/components/StudioStageView.tsx` | Remove bubble prop drilling |

---

## Future Work (post this sprint)

1. **Full bubble-removal refactor** — see `REFACTOR-PLAN.md` (remove `BubbleDetectionService`,
   replace with `ExpandBlock` helper). This becomes easier once TextSeg is first-class in UI.
2. **Smarter TextSeg grouping** — instead of pure distance-based merge, group by bubble
   membership when bubble detection is enabled; fall back to distance when disabled.
3. **Studio UX polish** — richer TextSeg detail editor, font/size controls per block.
4. **Shard large files** — `PageTranslationService.cs` and `StudioPage.tsx` exceed 500 lines.
5. **False-positive filtering** — filter TextSeg blocks whose OCR result is empty, garbage,
   or a single punctuation character.

---

## Reference: Key File Locations

```
server/src/Services/
  TextSegmentationService.cs   ← grouping bug (FindTextBlocks method, ~line 241)
  PageTranslationService.cs    ← main pipeline (OCR loop ~line 148, tsBlocks update)
  PageTranslationActions.cs    ← re-OCR / re-translate action paths

server/ClientApp/src/
  api.ts                       ← TextSegBox type (add source_text/translated_text)
  pages/StudioPage.tsx         ← remove bubble signals and handlers
  components/StudioLeftPanel.tsx  ← TextSeg-only list
  components/TextSegDetail.tsx    ← right panel: show OCR + translation
  components/BubbleCanvas.tsx     ← remove bubble props
  components/StudioStageView.tsx  ← remove bubble prop drilling
```

---

## Git Commands to Resume

```bash
cd /home/decky/Documents/funs/bun/web-ocr

# Confirm starting point
git checkout refactor/split-large-files
git log --oneline -3
# Should show: ec69411 docs: add refactor plan for removing bubble detection

# Create the work branch
git checkout -b refactor/textseg-first-class

# Reference branches
# master               = clean v1.4.0
# wip/mimo-refactor    = MiMo's broken attempt (for reference only)
```
