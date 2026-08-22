# Refactor Plan: Remove Bubble Detection, Simplify to TextSeg-Only

## Background / Why

The project currently has **two overlapping detection systems**:
1. **TextSeg** (Text Segmentation) — detects text ink blocks with pixel-accurate masks
2. **Bubble Detection** — detects speech bubble bounding boxes

This creates confusion in the UI (two lists, two overlays, unclear which is used for what). The reality is:
- **TextSeg is the primary driver** — used for OCR regions and inpaint masks
- **Bubbles are secondary** — only used for typesetting (where to place translated text)

**Goal**: Drop bubble detection entirely. Use TextSeg blocks for everything:
- OCR regions → TextSeg blocks
- Inpaint masks → TextSeg pixel mask (already works)
- Text placement → Expand TextSeg boxes slightly (instead of using bubble shapes)

**Trade-off**: Text placement becomes rectangular (no bubble shapes), but for a self-hosted tool this is acceptable. The architecture becomes much simpler.

---

## Current Architecture

### Pipeline (`server/src/Services/PageTranslationService.cs`)
```
1. TextSeg → text blocks + pixel mask
2. Bubble Detection → bubble boxes (CONCURRENT with step 1)
3. Group TextSeg blocks by containing bubble (GetTypesettingBox)
4. OCR each group → source text
5. Translate → translated text
6. Inpaint using TextSeg pixel mask
7. Typeset using bubble boxes as placement targets
```

**After refactor**:
```
1. TextSeg → text blocks + pixel mask
2. Expand each TextSeg block by N% for typesetting
3. OCR each block → source text
4. Translate → translated text
5. Inpaint using TextSeg pixel mask
6. Typeset using expanded TextSeg boxes as placement targets
```

### Key Files

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `server/src/Services/PageTranslationService.cs` | Pipeline orchestrator | Remove BubbleDetectionService, expand TextSeg boxes |
| `server/src/Services/BubbleDetectionService.cs` | Bubble detection | Can be deleted or kept unused |
| `server/src/ModelSettingsStore.cs` | Model config | Remove BUBBLE_MODEL_* settings |
| `server/src/BootExtensions.cs` | Service registration | Remove BubbleDetectionService registration |
| `server/src/Config.cs` | Server config | Remove bubble-related config |
| `server/src/Routes/HealthRoutes.cs` | Health endpoint | Remove bubble readiness check |
| `server/src/Routes/PortalRoutes.cs` | Portal routes | May need updates |
| `server/.env` | Environment vars | Remove BUBBLE_MODEL_* |
| `server/.env.example` | Example env | Remove BUBBLE_MODEL_* |
| `server/ClientApp/src/pages/StudioPage.tsx` | Studio UI | Remove bubble list/toggle, change Pad→Expand |
| `server/ClientApp/src/components/StudioToolbar.tsx` | Toolbar | Remove bubble toggle from View menu |
| `server/ClientApp/src/components/StudioLeftPanel.tsx` | Left panel | Remove bubble list section |
| `server/ClientApp/src/components/BubbleList.tsx` | Bubble list | Can be deleted or repurposed |
| `server/ClientApp/src/components/BubbleEditor.tsx` | Bubble editor | Can be deleted or simplified |
| `server/ClientApp/src/components/BubbleCanvas.tsx` | Canvas | Remove bubble rendering, keep TextSeg overlay |
| `server/ClientApp/src/components/StudioStageView.tsx` | Stage view | Remove bubble props |
| `server/ClientApp/src/api.ts` | API client | Remove bubble API functions |
| `server/ClientApp/src/types.ts` | Types | Remove TranslationBubble type |

---

## Step-by-Step Changes

### Phase 1: Remove Bubble Settings from Config

#### 1.1 Update `server/.env`
Remove these lines:
```
BUBBLE_MODEL_ENABLED=true
BUBBLE_MODEL_REPO=ogkalu/comic-text-and-bubble-detector
BUBBLE_MODEL_FILES=detector-v4-s_int8.onnx
```

#### 1.2 Update `server/.env.example`
Remove the entire "Bubble detection" section:
```
# Bubble detection — RT-DETR INT8, detects speech bubbles (optional)
# https://huggingface.co/ogkalu/comic-text-and-bubble-detector  — Apache 2.0, 11 MB
BUBBLE_MODEL_ENABLED=false
BUBBLE_MODEL_REPO=ogkalu/comic-text-and-bubble-detector
# BUBBLE_MODELS_DIR=./data/models/bubble
BUBBLE_MODEL_FILES=detector-v4-s_int8.onnx
```

#### 1.3 Update `server/src/ModelSettingsStore.cs`
Remove bubble model settings:
- `BubbleModelRepo`
- `BubbleModelsDir`
- `BubbleModelEnabled`
- `BubbleModelFiles`

Remove from the `Current` property and the startup merge logic.

#### 1.4 Update `server/src/BootExtensions.cs`
Remove `BubbleDetectionService` registration from `AddWebOcrServices()`.

---

### Phase 2: Remove Bubble Status from Health/Status

#### 2.1 Update `server/src/Routes/HealthRoutes.cs`
Remove `BubbleReady` and `BubbleEnabled` from the health response.

#### 2.2 Update `server/src/BootState.cs`
Remove `BubbleReady` and `BubbleEnabled` properties.

#### 2.3 Update `server/ClientApp/src/pages/ServerStatusPage.tsx`
Remove bubble status display from the server status page.

---

### Phase 3: Rewrite Pipeline

#### 3.1 Update `server/src/Services/PageTranslationService.cs`

**Remove**:
- `BubbleDetectionService bubbleDetector` parameter from constructor
- `bubbleDetector.Detect(imagePng)` call
- `GetTypesettingBox()` grouping logic
- `BubbleBoxComparer` usage

**Add**:
- `TextSegExpandPercent` setting (default 30%)
- Logic to expand each TextSeg block by N% for typesetting
- Each expanded block becomes a `BubbleTranslation` target

**New flow**:
```csharp
// 1. TextSeg detection (unchanged)
var textSegResult = ...;

// 2. Expand TextSeg blocks for typesetting
var expandedBlocks = textSegResult.TextBlocks
    .Select(b => ExpandBlock(b, expandPercent))
    .ToList();

// 3. OCR each block (no grouping needed)
for (int i = 0; i < expandedBlocks.Count; i++)
{
    var cropped = CropBubble(imagePng, expandedBlocks[i], padding: 0.05f);
    var ocrResult = await RunOcr(cropped);
    var sourceText = ocrResult.Text;
    
    // 4. Translate
    var translated = await RunTranslate(sourceText);
    
    // 5. Store result
    translations.Add(new BubbleTranslation(expandedBlocks[i], sourceText, translated));
}

// 6. Inpaint using TextSeg mask (unchanged)
// 7. Typeset using expanded blocks (unchanged, just uses different boxes)
```

**Helper method to expand a block**:
```csharp
private static BubbleBox ExpandBlock(BubbleBox block, float expandPercent)
{
    float expandX = block.Width * expandPercent / 100f;
    float expandY = block.Height * expandPercent / 100f;
    return new BubbleBox(
        block.X - expandX,
        block.Y - expandY,
        block.Width + expandX * 2,
        block.Height + expandY * 2,
        block.Confidence);
}
```

#### 3.2 Update `server/src/Routes/PortalRoutes.cs`
Remove `RedetectAsync` route (or update it to re-run TextSeg only).

#### 3.3 Update `server/src/Services/PageTranslationActions.cs`
Update `RedetectAsync` to not use bubble detection.

---

### Phase 4: Update UI

#### 4.1 Update `server/ClientApp/src/components/StudioToolbar.tsx`
- Remove "Bubbles" toggle from View dropdown
- Change "Pad" label to "Expand" (controls TextSeg region expansion)
- Keep the expand/pad control but rename it

#### 4.2 Update `server/ClientApp/src/components/StudioLeftPanel.tsx`
- Remove `showBubbles` prop
- Remove bubble list section
- Keep only TextSeg list
- Remove `onAddBubble` prop (use TextSeg add instead)

#### 4.3 Update `server/ClientApp/src/pages/StudioPage.tsx`
- Remove `showBubbles` signal
- Remove `isDrawMode` signal (only TextSeg draw mode now)
- Remove `bubbleList` derived signal
- Remove `selectedBubble` derived signal
- Remove bubble-related handlers (handleMove, handleResize, handleBubbleUpdate, etc.)
- Remove bubble CRUD imports
- Update `effectiveShowBubbles` → always false
- Update `effectiveShowTextSeg` → always true (or based on stage)

#### 4.4 Update `server/ClientApp/src/components/BubbleCanvas.tsx`
- Remove bubble rendering (the `<For each={props.bubbles}>` section)
- Keep TextSeg overlay rendering
- Remove `bubbles` prop
- Remove `selectedIndex` prop (for bubbles)
- Remove `onMove`, `onResize`, `onDraw` props
- Remove `showBubbles` prop
- Keep `overlayBoxes`, `selectedTextSegIndex`, `onSelectTextSeg`

#### 4.5 Update `server/ClientApp/src/components/StudioStageView.tsx`
- Remove bubble-related props
- Pass only TextSeg props to BubbleCanvas

#### 4.6 Update `server/ClientApp/src/api.ts`
- Remove bubble API functions: `addBubble`, `deleteBubble`, `updateBubble`, `getJobBubbles`
- Remove `TranslationBubble` import from types
- Keep TextSeg API functions

#### 4.7 Update `server/ClientApp/src/types.ts`
- Remove `TranslationBubble` type (or keep for backward compat)

#### 4.8 Delete or repurpose
- `server/ClientApp/src/components/BubbleList.tsx` — delete
- `server/ClientApp/src/components/BubbleEditor.tsx` — delete or simplify to text editor
- `server/ClientApp/src/components/TextStyleEditor.tsx` — keep (for text styling)

---

### Phase 5: Add Expand Setting to Pipeline

#### 5.1 Update `server/src/ModelSettingsStore.cs`
Add new setting:
```csharp
public int TextSegExpandPercent { get; set; } = 30;
```

Add env var:
```
TEXT_SEG_EXPAND_PERCENT=30
```

#### 5.2 Update `server/ClientApp/src/api.ts`
Add API endpoint to get/update expand setting:
```typescript
export async function getSettings(): Promise<{ textSegExpandPercent: number }> { ... }
export async function updateSettings(settings: { textSegExpandPercent?: number }): Promise<void> { ... }
```

#### 5.3 Update Studio UI
Replace the "Pad" control with "Expand" control that calls the settings API.

---

## Verification Checklist

After all changes:

- [ ] `dotnet build` passes
- [ ] `bun run build` passes (ClientApp)
- [ ] Server starts without errors
- [ ] `/health` endpoint returns status without bubble info
- [ ] `/api/settings` returns settings without bubble model
- [ ] TextSeg detection works (run on a manga page)
- [ ] OCR works on TextSeg blocks
- [ ] Translation works
- [ ] Inpainting works (using TextSeg mask)
- [ ] Typesetting works (using expanded TextSeg boxes)
- [ ] Studio UI shows only TextSeg list
- [ ] Studio UI expand control works
- [ ] No console errors in browser

---

## Migration Notes

- Existing `textseg_blocks.json` files will still work (they just won't have text fields yet)
- Existing `PageTranslationLogs` (bubble logs) in DB are still used for storing OCR/translation results
- The `BubbleDetectionService` class can be kept in the codebase but unused, or deleted entirely
- The `BUBBLE_MODEL_*` env vars are ignored if not set (safe to remove)

---

## Files to Create/Modify/Delete

### Create
- None

### Modify
- `server/.env` — remove bubble settings
- `server/.env.example` — remove bubble settings
- `server/src/ModelSettingsStore.cs` — remove bubble settings, add expand setting
- `server/src/BootExtensions.cs` — remove BubbleDetectionService
- `server/src/BootState.cs` — remove bubble readiness
- `server/src/Routes/HealthRoutes.cs` — remove bubble status
- `server/src/Routes/PortalRoutes.cs` — update redetect
- `server/src/Services/PageTranslationService.cs` — rewrite pipeline
- `server/src/Services/PageTranslationActions.cs` — update redetect
- `server/ClientApp/src/api.ts` — remove bubble API, add expand setting
- `server/ClientApp/src/types.ts` — remove TranslationBubble
- `server/ClientApp/src/pages/StudioPage.tsx` — major simplification
- `server/ClientApp/src/pages/ServerStatusPage.tsx` — remove bubble status
- `server/ClientApp/src/components/StudioToolbar.tsx` — remove bubble toggle, rename pad
- `server/ClientApp/src/components/StudioLeftPanel.tsx` — remove bubble list
- `server/ClientApp/src/components/StudioStageView.tsx` — remove bubble props
- `server/ClientApp/src/components/BubbleCanvas.tsx` — remove bubble rendering

### Delete (optional)
- `server/ClientApp/src/components/BubbleList.tsx`
- `server/ClientApp/src/components/BubbleEditor.tsx`
