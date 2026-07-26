# Translation Portal — Design Plan

Full-stack plan for the web review portal, job storage, and library organisation features.
Built as an extension of the existing ASP.NET Core server + SolidJS frontend.

---

## 1. Goals

| Goal | Detail |
|------|--------|
| Job storage | Every translation job persists its input image, output image, bubble coordinates, OCR texts, and translations to disk + DB |
| Review portal | Web UI to browse jobs, compare original vs result, inspect/edit per-bubble data |
| Studio editor | Interactive canvas to re-detect, add/remove/resize bubbles, re-translate, re-render |
| Library | Organise jobs into Chapters → Volumes (Volumes can hold Chapters, Chapters hold Pages/Jobs) |

---

## 2. Data Model

### 2.1 New DB Entities (EF Core / SQLite)

```text
Volume
  Id            int PK
  Title         string
  Synopsis      string?
  CoverImagePath string?
  SortOrder     int
  CreatedAt     DateTime

Chapter
  Id            int PK
  VolumeId      int? FK→Volume (null = standalone chapter)
  Title         string
  ChapterNumber string   ("1", "2", "1.5" etc.)
  SortOrder     int
  CreatedAt     DateTime

PageTranslationJob                    ← new (replaces in-memory-only TTL store for persistence)
  Id                 string PK (GUID matching TranslationJobStore.Id)
  Title              string           (defaults to "Job {id-prefix}"; user-editable)
  Status             string           ("processing" | "done" | "error")
  OriginalImagePath  string           (relative: "jobs/{id}/original.png")
  ResultImagePath    string?          (relative: "jobs/{id}/result.png", null until done)
  OriginalWidth      int
  OriginalHeight     int
  BubbleCount        int
  ChapterId          int? FK→Chapter
  PageOrder          int              (sort order within chapter)
  ErrorMessage       string?
  CreatedAt          DateTime
  CompletedAt        DateTime?
```

### 2.2 Extend Existing Entity

`PageTranslationLog` (per-bubble) — add two columns via migration:
```text
  IsManuallyAdded  bool (default false)  — user drew this box; not from model
  IsExcluded       bool (default false)  — user wants to skip this bubble
  LastEditedAt     DateTime?
```

### 2.3 File Layout on Disk

```text
data/
  jobs/
    {jobId}/
      original.png     ← input image saved at job start
      result.png       ← patched output saved at job completion
```

---

## 3. Server Changes

### 3.1 Config

Add computed property to `AppConfig`:

```csharp
public string JobsDir => Path.Combine(Path.GetDirectoryName(DatabasePath)!, "jobs");
```


### 3.2 `PageTranslationService` changes

`TranslatePageAsync(jobId, imagePng, ...)`:

1. **At start** — save `original.png` + insert `PageTranslationJob` row (status=processing)
2. **Per bubble** — existing `LogBubbleAsync` (no change needed)
3. **At end** — save `result.png` + update `PageTranslationJob` row (status=done, resultImagePath)
4. **On error** — update `PageTranslationJob` row (status=error, errorMessage)

### 3.3 New API Routes (`src/Routes/PortalRoutes.cs`)

#### Jobs

```text
GET  /api/portal/jobs                       list jobs (paginated, filter by status/chapter)
GET  /api/portal/jobs/{id}                  job metadata + bubble count
DELETE /api/portal/jobs/{id}                delete job row + disk files
PUT  /api/portal/jobs/{id}                  update title / chapterId / pageOrder

GET  /api/portal/jobs/{id}/original         stream original.png
GET  /api/portal/jobs/{id}/result           stream result.png (404 if not done)
```

#### Bubbles

```text
GET    /api/portal/jobs/{id}/bubbles         list all bubbles for a job
POST   /api/portal/jobs/{id}/bubbles         add bubble (isManuallyAdded=true)
PUT    /api/portal/jobs/{id}/bubbles/{idx}   update coords / texts / isExcluded
DELETE /api/portal/jobs/{id}/bubbles/{idx}   delete bubble row
```

#### Job Actions (all fire background work, return 202 with `{"id":"<jobId>"}`)

```text
POST /api/portal/jobs/{id}/redetect          re-run BubbleDetectionService on stored original
POST /api/portal/jobs/{id}/retranslate       re-translate all (or subset via body) bubbles
POST /api/portal/jobs/{id}/rerender          re-run TypesettingService with current DB bubble data → update result.png
```

#### Library

```text
GET    /api/portal/volumes
POST   /api/portal/volumes
PUT    /api/portal/volumes/{id}
DELETE /api/portal/volumes/{id}

GET    /api/portal/chapters?volumeId=        (null volumeId = standalone chapters)
POST   /api/portal/chapters
PUT    /api/portal/chapters/{id}
DELETE /api/portal/chapters/{id}

GET    /api/portal/chapters/{id}/jobs        ordered pages in chapter
PUT    /api/portal/chapters/{id}/jobs/reorder  reorder pages (array of job ids)
```

---

## 4. Frontend Architecture

### 4.1 Stack (no changes to toolchain)

- **SolidJS** (existing, extend `server/ClientApp/src/`)
- **Tailwind CSS v4** (existing)
- **SolidJS Router** — add `@solidjs/router` for client-side navigation
- **No Fabric.js** — use SVG overlay for bubble editing (simpler, no heavy lib)

### 4.2 Route Map

```text
/                        → Dashboard (existing, add stats strip)
/jobs                    → Jobs list
/jobs/{id}               → Job Studio (main editing view)
/library                 → Volumes list
/library/{volumeId}      → Volume detail: chapter list
/library/chapters/{id}   → Chapter detail: page/thumbnail grid
```

### 4.3 Page Designs

#### `/jobs` — Jobs List

- Search/filter bar (status, date range, chapter)
- Grid of cards: thumbnail (result.png or original if no result), title, date, bubble count, status badge
- Bulk: assign to chapter, delete
- Button: "Upload image" (opens translate-page flow in-portal)

#### `/jobs/{id}` — Job Studio

**Layout: Three-column**

```text
┌──────────────────────────────────────────────────────┐
│ Header: job title (editable) | status | toolbar      │
├───────────────┬───────────────────────┬──────────────┤
│  Left panel   │   Centre: Canvas      │  Right panel │
│  Bubble list  │   (split original/    │  Selected    │
│  + metadata   │    result toggle)     │  bubble      │
│               │                       │  editor      │
└───────────────┴───────────────────────┴──────────────┘
```

**Centre canvas:**
- Toggle: Original | Result | Side-by-side
- SVG overlay on original image with:
  - Coloured bounding boxes per bubble
  - Dim excluded bubbles
  - Click box → select (highlights in right panel)
  - Drag to reposition
  - Resize handles (corner drag)
  - "+" cursor mode: draw new rectangle → creates bubble
- Zoom + pan

**Left panel:**
- Ordered list of bubbles
- Each row: index, confidence badge, first 30 chars of source text
- Excluded bubbles greyed out with strikethrough
- Click row → select bubble on canvas

**Right panel (selected bubble):**
- Bounding box coords (x, y, w, h) — editable inputs
- Confidence (read-only if from model, N/A if manual)
- Source text (editable — user can correct OCR)
- Translated text (editable)
- Toggle: Include / Exclude
- Buttons: Re-OCR this bubble | Re-translate this bubble

**Toolbar buttons:**
- Re-detect all (replaces all model bubbles, keeps manual ones)
- Re-translate all
- Re-render → updates result image
- Assign to Chapter (dropdown)
- Download result
- Delete job

#### `/library` — Library

- Grid of Volume cards + "Standalone Chapters" section
- Create volume button
- Drag-and-drop reorder (or up/down arrows)

#### `/library/{volumeId}` — Volume

- Editable title + synopsis + cover image
- Chapter list with sort order
- Create chapter, drag-and-drop reorder

#### `/library/chapters/{id}` — Chapter

- Editable chapter title + number
- Page/job grid: thumbnails in order
- Drag-and-drop reorder
- Click thumbnail → go to Job Studio
- Batch: Upload & add pages

---

## 5. Implementation Phases

### Phase 1 — Job Storage (do first, unblocks everything)

1. Add `PageTranslationJob`, `Chapter`, `Volume` entities to `AppDbContext`
2. Add `IsManuallyAdded`, `IsExcluded`, `LastEditedAt` to `PageTranslationLog`
3. EF migration: `AddPortalSchema`
4. Add `JobsDir` to `AppConfig`
5. Update `PageTranslationService.TranslatePageAsync`:
   - Save `original.png` at start
   - Insert `PageTranslationJob` row (status=processing)
   - Save `result.png` and update row on success
   - Update row on error
6. Update route handler to pass `AppConfig`

### Phase 2 — Portal REST API

7. `PortalRoutes.cs`: jobs CRUD + image endpoints
8. `PortalRoutes.cs`: bubbles CRUD
9. `PortalRoutes.cs`: job actions (redetect / retranslate / rerender)
10. `PortalRoutes.cs`: volumes + chapters CRUD
11. Register all in `ServiceExtensions.MapWebOcrRoutes`

### Phase 3 — Frontend Scaffolding

12. Add `@solidjs/router` dependency
13. Update `solid-app.tsx` to use `<Router>` + lazy-load pages
14. Update Blazor `Index.razor` for SPA layout (full viewport, pass route)
15. Shared: `api.ts` typed fetch helpers, `types.ts`, nav sidebar

### Phase 4 — Jobs List Page

16. `JobsPage.tsx`: fetch + render job cards
17. Job card component: thumbnail, status, date, bubble count
18. Filter/search bar

### Phase 5 — Job Studio Page

19. `StudioPage.tsx`: layout skeleton
20. `BubbleCanvas.tsx`: SVG overlay + zoom/pan
21. `BubbleList.tsx`: left panel
22. `BubbleEditor.tsx`: right panel with form inputs
23. Studio toolbar: redetect/retranslate/rerender wired to API

### Phase 6 — Library Pages

24. `LibraryPage.tsx`: volumes grid
25. `VolumePage.tsx`: chapter list + drag reorder
26. `ChapterPage.tsx`: page thumbnail grid + drag reorder

---

## 6. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Image storage | Files on disk, paths in DB | SQLite BLOB is not suitable for ~MB images; file serving is trivial |
| Bubble editing canvas | SVG overlay (not Fabric.js) | No heavy dep; SVG drag+resize is ~200 lines; Fabric.js brings React/Canvas complexity that doesn't compose well with SolidJS signals |
| Job ID | GUID string (existing) | Same ID used for in-memory TTL store and persistent DB row |
| Re-detect strategy | Replace model bubbles, keep `isManuallyAdded=true` rows | Preserves user corrections |
| Rerender | Calls `TypesettingService` with DB bubble data, overwrites `result.png` | Same service already used in pipeline |
| Router | SolidJS Router inside existing SolidJS app (not Blazor routing) | Keeps SPA simple; Blazor single page hosts SolidJS root |
| Library hierarchy | Volume → Chapter → Job | Mirrors manga-reader (Series→Chapter→Page) but renamed to match our domain |
| Page order in chapter | `PageOrder int` field, user-editable | Allows non-sequential uploads, drag-and-drop reorder |

---

## 7. Reference: manga-reader Features to Port

The `manga-reader` subrepo implements a very similar Studio. Key things to learn from it
and port to our SolidJS + ASP.NET setup:

| manga-reader | Our equivalent |
|---|---|
| `StudioCanvas.tsx` (Fabric.js) | `BubbleCanvas.tsx` (SVG overlay — lighter) |
| `Region` discriminated union (rect/poly/oval) | `BubbleBox` (rect only for now, extend to poly later) |
| `UserCaptions` table (per-region OCR+translation+patch) | `PageTranslationLog` (already has this shape) |
| `pageData.maskData` (Fabric JSON) | Not needed — we store numeric coords, not canvas state |
| Series → Chapter → Page hierarchy | Volume → Chapter → PageTranslationJob |
| `EditChapterPage`, `UploadChapterPage` | Combined into `ChapterPage` + upload flow |
| AutoDetectButton, OCRButton tools | Toolbar actions: re-detect, re-OCR per bubble |
| Inpaint + merge-and-save flow | Re-render action (TypesettingService re-runs) |
| Client-side patch via Fabric Textbox | Phase 2 enhancement — not MVP |

---

## 8. Out of Scope (MVP)

- Polygon / oval bubble shapes (rectangles only; extend later)
- Client-side typesetting (server renders; user edits input data and re-renders)
- Multi-user / auth
- Export to CBZ/PDF
- Public reader mode (like manga-reader's reader pages)
- Real-time collaboration
