import { createResource, createSignal, createMemo, Show, For } from "solid-js";
import type { JSX } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Flame,
  ImageOff,
  PaintBucket,
  PenLine,
  Plus,
  RefreshCw,
  ScanText,
  Sparkles,
  Trash2,
  Type,
} from "lucide-solid";
import {
  addBubble,
  deleteBubble,
  deleteJob,
  deleteTextSegBlock,
  getJob,
  getJobBubbles,
  getJobTextSegBlocks,
  inpaintJob,
  jobInpaintedUrl,
  jobOriginalUrl,
  jobResultUrl,
  redetectJob,
  reocrBubble,
  reocrJob,
  repatchBubble,
  reinpaintBubble,
  rerenderJob,
  retranslateBubble,
  retranslateJob,
  translateJob,
  updateBubble,
} from "../api";
import type { TextSegBox, UpdateBubbleBody } from "../api";
import { BubbleCanvas } from "../components/BubbleCanvas";
import { BubbleList } from "../components/BubbleList";
import { BubbleEditor } from "../components/BubbleEditor";
import type { BubbleUpdatePatch } from "../components/BubbleEditor";
import { TextStyleEditor } from "../components/TextStyleEditor";
import type { TextStylePatch } from "../components/TextStyleEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "./JobsListPage";
import type { PageTranslationJob, TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Stage type
// ---------------------------------------------------------------------------

type Stage = "original" | "inpainted" | "compose" | "result";

const STAGE_LABELS: Record<Stage, string> = {
  original:  "1 · Original",
  inpainted: "2 · Inpainted",
  compose:   "3 · Compose",
  result:    "4 · Result",
};

const ALL_STAGES: Stage[] = ["original", "inpainted", "compose", "result"];

/** Lower index = earlier in the pipeline → renders on the left. */
const STAGE_ORDER: Record<Stage, number> = {
  original: 0, inpainted: 1, compose: 2, result: 3,
};

// Panel context determines which right-panel editor is shown
type PanelContext = "stage1" | "stage3" | null;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function StudioPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Resources
  const [job, { refetch: refetchJob }] = createResource(() => params.id, getJob);
  const [bubbles, { refetch: refetchBubbles }] = createResource(
    () => params.id,
    getJobBubbles,
  );

  // UI state
  const [selectedIndex, setSelectedIndex] = createSignal<number | null>(null);
  const [activeStages, setActiveStages] = createSignal<Stage[]>(["original"]);
  const [panelContext, setPanelContext] = createSignal<PanelContext>(null);
  const [leftCollapsed, setLeftCollapsed] = createSignal(false);
  const [rightCollapsed, setRightCollapsed] = createSignal(false);

  // Job action states
  const [isRedetecting, setIsRedetecting] = createSignal(false);
  const [isInpainting, setIsInpainting] = createSignal(false);
  const [isReocring, setIsReocring] = createSignal(false);
  const [isTranslating, setIsTranslating] = createSignal(false);
  const [isAutoTexts, setIsAutoTexts] = createSignal(false);
  const [isBurning, setIsBurning] = createSignal(false);

  const [isDrawMode, setIsDrawMode] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);

  const storedPadding = parseInt(localStorage.getItem("studio-bubble-padding") ?? "0", 10);
  const [bubblePadding, setBubblePadding] = createSignal<number>(
    Number.isNaN(storedPadding) ? 0 : storedPadding,
  );
  const [imageVersion, setImageVersion] = createSignal(0);

  // TextSeg overlay
  const [showTextSeg, setShowTextSeg] = createSignal(false);
  const [textSegBoxes, setTextSegBoxes] = createSignal<TextSegBox[]>([]);
  const [isLoadingTextSeg, setIsLoadingTextSeg] = createSignal(false);
  const [selectedTextSegIndex, setSelectedTextSegIndex] = createSignal<number | null>(null);

  // Bubble visibility toggle
  const [showBubbles, setShowBubbles] = createSignal(true);

  async function handleToggleTextSeg(): Promise<void> {
    const next = !showTextSeg();
    setShowTextSeg(next);
    if (!next) { setSelectedTextSegIndex(null); return; }
    if (textSegBoxes().length === 0) {
      setIsLoadingTextSeg(true);
      try {
        const boxes = await getJobTextSegBlocks(params.id);
        setTextSegBoxes(boxes);
      } catch {
        setShowTextSeg(false);
      } finally {
        setIsLoadingTextSeg(false);
      }
    }
  }

  async function handleDeleteTextSeg(index: number): Promise<void> {
    try {
      const updated = await deleteTextSegBlock(params.id, index);
      setTextSegBoxes(updated);
      if (selectedTextSegIndex() === index) setSelectedTextSegIndex(null);
      else if ((selectedTextSegIndex() ?? 0) > index)
        setSelectedTextSegIndex((v) => (v ?? 0) - 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete TextSeg block");
    }
  }

  // Derived
  const bubbleList = () => bubbles() ?? [];
  const selectedBubble = (): TranslationBubble | null => {
    const idx = selectedIndex();
    return idx !== null
      ? (bubbleList().find((b) => b.bubbleIndex === idx) ?? null)
      : null;
  };

  // Stages sorted by pipeline position so left panel always shows earlier stage
  const sortedActiveStages = createMemo(() =>
    [...activeStages()].sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]),
  );

  const stage1Active = () => activeStages().includes("original");
  const stage3Active = () => activeStages().includes("compose");

  // ---------------------------------------------------------------------------
  // Stage toggle — max 2 active; clicking a third replaces the oldest
  // ---------------------------------------------------------------------------

  function toggleStage(s: Stage): void {
    setActiveStages((prev) => {
      if (prev.includes(s)) {
        const next = prev.filter((x) => x !== s);
        return next.length > 0 ? next : prev;
      }
      if (prev.length >= 2) {
        return [prev[1]!, s];
      }
      return [...prev, s];
    });
  }

  // ---------------------------------------------------------------------------
  // Selection handlers — update selectedIndex and panelContext together
  // ---------------------------------------------------------------------------

  function handleSelectStage1(idx: number | null): void {
    const alreadySelected = idx !== null && idx === selectedIndex() && panelContext() === "stage1";
    const next = alreadySelected ? null : idx;
    setSelectedIndex(next);
    setPanelContext(next !== null ? "stage1" : null);
  }

  function handleSelectStage3(idx: number | null): void {
    const alreadySelected = idx !== null && idx === selectedIndex() && panelContext() === "stage3";
    const next = alreadySelected ? null : idx;
    setSelectedIndex(next);
    setPanelContext(next !== null ? "stage3" : null);
  }

  // ---------------------------------------------------------------------------
  // Bubble CRUD helpers
  // ---------------------------------------------------------------------------

  async function handleMove(bubbleIndex: number, dx: number, dy: number): Promise<void> {
    const b = bubbleList().find((bbl) => bbl.bubbleIndex === bubbleIndex);
    if (!b) return;
    setActionError(null);
    try {
      await updateBubble(params.id, bubbleIndex, {
        bubbleX: b.bubbleX + dx,
        bubbleY: b.bubbleY + dy,
        bubbleW: b.bubbleW,
        bubbleH: b.bubbleH,
      });
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to move bubble");
    }
  }

  async function handleResize(
    bubbleIndex: number, x: number, y: number, w: number, h: number,
  ): Promise<void> {
    setActionError(null);
    try {
      await updateBubble(params.id, bubbleIndex, { bubbleX: x, bubbleY: y, bubbleW: w, bubbleH: h });
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to resize bubble");
    }
  }

  async function handleDraw(x: number, y: number, w: number, h: number): Promise<void> {
    setActionError(null);
    try {
      const b = await addBubble(params.id, { x, y, w, h });
      await refetchBubbles();
      setSelectedIndex(b.bubbleIndex);
      setPanelContext("stage1");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add bubble");
    }
  }

  async function handleBubbleUpdate(patch: UpdateBubbleBody): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    setActionError(null);
    try {
      await updateBubble(params.id, b.bubbleIndex, patch);
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update bubble");
    }
  }

  async function handleBubbleDelete(): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    setActionError(null);
    try {
      await deleteBubble(params.id, b.bubbleIndex);
      setSelectedIndex(null);
      setPanelContext(null);
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete bubble");
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async function pollUntilDone(): Promise<void> {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await getJob(params.id);
      if (j.status !== "processing") return;
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 1 — job-level actions
  // ---------------------------------------------------------------------------

  async function handleRedetect(): Promise<void> {
    setIsRedetecting(true);
    setActionError(null);
    try {
      await redetectJob(params.id);
      await pollUntilDone();
      setSelectedIndex(null);
      setPanelContext(null);
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-detect failed");
    } finally {
      setIsRedetecting(false);
    }
  }

  async function handleInpaint(): Promise<void> {
    setIsInpainting(true);
    setActionError(null);
    try {
      await inpaintJob(params.id);
      await pollUntilDone();
      await refetchJob();
      setImageVersion((v) => v + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Inpaint failed");
    } finally {
      setIsInpainting(false);
    }
  }

  async function handleReocr(): Promise<void> {
    setIsReocring(true);
    setActionError(null);
    try {
      await reocrJob(params.id);
      await pollUntilDone();
      const j = await getJob(params.id);
      if (j.status === "error") {
        setActionError(j.errorMessage ?? "OCR failed");
      }
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "OCR failed");
    } finally {
      setIsReocring(false);
    }
  }

  async function handleTranslate(): Promise<void> {
    setIsTranslating(true);
    setActionError(null);
    try {
      await translateJob(params.id);
      await pollUntilDone();
      const j = await getJob(params.id);
      if (j.status === "error") {
        setActionError(j.errorMessage ?? "Translate failed");
      }
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Translate failed");
    } finally {
      setIsTranslating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 3 — job-level actions
  // ---------------------------------------------------------------------------

  async function handleAutoTexts(): Promise<void> {
    setIsAutoTexts(true);
    setActionError(null);
    try {
      await redetectJob(params.id);
      await pollUntilDone();
      await retranslateJob(params.id);
      await pollUntilDone();
      setSelectedIndex(null);
      setPanelContext(null);
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Auto Texts failed");
    } finally {
      setIsAutoTexts(false);
    }
  }

  async function handleBurnTexts(): Promise<void> {
    setIsBurning(true);
    setActionError(null);
    try {
      await rerenderJob(params.id, bubblePadding());
      await pollUntilDone();
      await Promise.all([refetchJob(), refetchBubbles()]);
      setImageVersion((v) => v + 1);
      // Notify extension: Studio burned texts → result image updated
      const resultUrl = `${jobResultUrl(params.id)}?v=${imageVersion()}`;
      window.postMessage(
        { type: "web-ocr:image-updated", jobId: params.id, resultUrl },
        window.location.origin,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Burn Texts failed");
    } finally {
      setIsBurning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete job
  // ---------------------------------------------------------------------------

  async function handleDeleteJob(): Promise<void> {
    setIsDeleting(true);
    try {
      await deleteJob(params.id);
      navigate("/jobs");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete job");
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-bubble action handlers (Stage 1 context)
  // ---------------------------------------------------------------------------

  async function handleBubbleReocr(): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    const updated = await reocrBubble(params.id, b.bubbleIndex);
    await refetchBubbles();
    setSelectedIndex(updated.bubbleIndex);
  }

  async function handleBubbleRetranslate(): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    const updated = await retranslateBubble(params.id, b.bubbleIndex);
    await refetchBubbles();
    setSelectedIndex(updated.bubbleIndex);
  }

  async function handleBubbleReinpaint(): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    await reinpaintBubble(params.id, b.bubbleIndex, bubblePadding());
    setImageVersion((v) => v + 1);
  }

  async function handleBubbleRepatch(): Promise<void> {
    const b = selectedBubble();
    if (!b) return;
    await repatchBubble(params.id, b.bubbleIndex, bubblePadding());
    setImageVersion((v) => v + 1);
  }

  // ---------------------------------------------------------------------------
  // Canvas prop factories
  // ---------------------------------------------------------------------------

  const stage1CanvasProps = () => ({
    bubbles: bubbleList(),
    selectedIndex: selectedIndex(),
    drawMode: isDrawMode(),
    bubblePadding: bubblePadding(),
    overlayBoxes: showTextSeg() ? textSegBoxes() : undefined,
    selectedTextSegIndex: showTextSeg() ? selectedTextSegIndex() : null,
    showBubbles: showBubbles(),
    onSelect: handleSelectStage1,
    onMove: handleMove,
    onResize: handleResize,
    onDraw: async (x: number, y: number, w: number, h: number) => {
      setIsDrawMode(false);
      await handleDraw(x, y, w, h);
    },
    showTextOverlay: false,
  });

  async function handleRotateOverlay(bubbleIndex: number, rotation: number): Promise<void> {
    setActionError(null);
    try {
      await updateBubble(params.id, bubbleIndex, { rotation });
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update rotation");
    }
  }

  // Stage 3: text overlay editing (move, resize, rotate all enabled)
  const stage3CanvasProps = () => ({
    bubbles: bubbleList(),
    selectedIndex: selectedIndex(),
    drawMode: false,
    bubblePadding: bubblePadding(),
    onSelect: handleSelectStage3,
    onMove: handleMove,
    onResize: handleResize,
    onDraw: () => {},
    onRotate: handleRotateOverlay,
    showTextOverlay: true,
  });

  // Stage 2 / 4 are read-only views
  const readOnlyCanvasProps = () => ({
    bubbles: bubbleList(),
    selectedIndex: null as number | null,
    drawMode: false,
    bubblePadding: bubblePadding(),
    onSelect: () => {},
    onMove: () => {},
    onResize: () => {},
    onDraw: () => {},
  });

  // ---------------------------------------------------------------------------
  // Stage panel renderer
  // ---------------------------------------------------------------------------

  function renderStage(stage: Stage, j: PageTranslationJob): JSX.Element {
    const v = imageVersion();
    const inpaintedUrl = `${jobInpaintedUrl(params.id)}?v=${v}`;
    const resultUrl    = `${jobResultUrl(params.id)}?v=${v}`;

    const noImagePlaceholder = (label: string, hint: string) => (
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
        <ImageOff class="h-10 w-10 opacity-40" />
        <p class="text-sm">{label}</p>
        <p class="text-xs">{hint}</p>
      </div>
    );

    switch (stage) {
      case "original":
        return (
          <BubbleCanvas
            {...stage1CanvasProps()}
            imageUrl={jobOriginalUrl(params.id)}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        );

      case "inpainted":
        return j.inpaintedImagePath ? (
          <BubbleCanvas
            {...readOnlyCanvasProps()}
            showBubbles={showBubbles()}
            imageUrl={inpaintedUrl}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        ) : noImagePlaceholder("No inpainted image", "Run Inpaint on Stage 1 first.");

      case "compose":
        return j.inpaintedImagePath ? (
          <BubbleCanvas
            {...stage3CanvasProps()}
            imageUrl={inpaintedUrl}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        ) : noImagePlaceholder("No inpainted image", "Run Inpaint on Stage 1 first.");

      case "result":
        return j.resultImagePath ? (
          <BubbleCanvas
            {...readOnlyCanvasProps()}
            imageUrl={resultUrl}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        ) : noImagePlaceholder("No result image", "Run Burn Texts on Stage 3 first.");
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="flex h-screen flex-col bg-slate-50">
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <header class="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 shadow-sm">
        {/* Back */}
        <button
          onClick={() => navigate("/jobs")}
          class="flex items-center gap-1 rounded p-1 text-slate-500 hover:bg-slate-100 transition-colors"
          title="Back to jobs"
          aria-label="Back to jobs"
        >
          <ArrowLeft class="h-4 w-4" />
        </button>

        {/* Title + status */}
        <Show
          when={job()}
          fallback={<div class="h-4 w-40 animate-pulse rounded bg-slate-200" />}
        >
          {(j) => (
            <>
              <h1 class="max-w-xs truncate text-sm font-semibold text-slate-800">
                {j().title}
              </h1>
              <StatusBadge status={j().status} />
            </>
          )}
        </Show>

        {/* Separator */}
        <div class="mx-1 h-5 w-px bg-slate-200" />

        {/* Stage picker */}
        <div class="flex overflow-hidden rounded-lg border border-slate-200 text-xs">
          <For each={ALL_STAGES}>
            {(stage) => {
              const isActive = () => activeStages().includes(stage);
              return (
                <button
                  onClick={() => toggleStage(stage)}
                  aria-pressed={isActive()}
                  class={`px-2.5 py-1.5 font-medium transition-colors border-r border-slate-200 last:border-r-0 ${
                    isActive()
                      ? "bg-violet-600 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {STAGE_LABELS[stage]}
                </button>
              );
            }}
          </For>
        </div>

        {/* Bubble display padding */}
        <div class="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
          <span class="select-none font-medium">Pad</span>
          <button
            class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30"
            disabled={bubblePadding() <= 0}
            onClick={() => {
              const v = Math.max(0, bubblePadding() - 1);
              setBubblePadding(v);
              localStorage.setItem("studio-bubble-padding", String(v));
            }}
            aria-label="Decrease bubble padding"
          >−</button>
          <span class="w-5 text-center tabular-nums">{bubblePadding()}</span>
          <button
            class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30"
            disabled={bubblePadding() >= 20}
            onClick={() => {
              const v = Math.min(20, bubblePadding() + 1);
              setBubblePadding(v);
              localStorage.setItem("studio-bubble-padding", String(v));
            }}
            aria-label="Increase bubble padding"
          >+</button>
        </div>

        {/* TextSeg overlay toggle */}
        <button
          onClick={handleToggleTextSeg}
          disabled={isLoadingTextSeg()}
          aria-pressed={showTextSeg()}
          title="Toggle TextSeg text-block overlay (orange dashed = OCR/inpaint regions)"
          class={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            showTextSeg()
              ? "border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          <Show when={isLoadingTextSeg()} fallback={
            <span class="inline-block h-2.5 w-2.5 rounded-sm border-2 border-current" style={{ "border-style": "dashed" }} />
          }>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          TextSeg
        </button>

        {/* Bubble box visibility toggle */}
        <button
          onClick={() => setShowBubbles((v) => !v)}
          aria-pressed={showBubbles()}
          title="Toggle bubble bounding-box overlay (blue = detection boxes)"
          class={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
            showBubbles()
              ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
              : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50"
          }`}
        >
          <span class="inline-block h-2.5 w-2.5 rounded-sm border-2 border-current" />
          Bubbles
        </button>

        {/* Separator */}
        <div class="mx-1 h-5 w-px bg-slate-200" />

        {/* Stage 1 — detection actions */}
        <Show when={stage1Active()}>
          <button
            onClick={handleRedetect}
            disabled={isRedetecting() || isInpainting() || isReocring() || isTranslating() || isAutoTexts() || isBurning()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Re-detect speech bubbles"
          >
            <Show when={isRedetecting()} fallback={<ScanText class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Detect
          </button>

          <button
            onClick={handleInpaint}
            disabled={isInpainting() || isRedetecting() || isReocring() || isTranslating() || isAutoTexts() || isBurning()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Erase bubble text using the selected inpaint engine (LaMa neural or flood-fill)"
          >
            <Show when={isInpainting()} fallback={<PaintBucket class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Inpaint
          </button>

          <button
            onClick={handleReocr}
            disabled={isReocring() || isRedetecting() || isInpainting() || isTranslating() || isAutoTexts() || isBurning()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Run OCR on all bubbles to extract source text"
          >
            <Show when={isReocring()} fallback={<ScanText class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            OCR
          </button>

          <button
            onClick={handleTranslate}
            disabled={isTranslating() || isRedetecting() || isInpainting() || isReocring() || isAutoTexts() || isBurning()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Translate all bubbles that have OCR text"
          >
            <Show when={isTranslating()} fallback={<Type class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Translate
          </button>
        </Show>

        {/* Stage 1 + Stage 3 separator */}
        <Show when={stage1Active() && stage3Active()}>
          <div class="h-5 w-px bg-slate-200" />
        </Show>

        {/* Stage 3 — compose actions */}
        <Show when={stage3Active()}>
          <button
            onClick={handleAutoTexts}
            disabled={isAutoTexts() || isBurning() || isRedetecting() || isInpainting() || isReocring() || isTranslating()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Re-run detect + translate to regenerate text overlays"
          >
            <Show when={isAutoTexts()} fallback={<Sparkles class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Auto Texts
          </button>

          <button
            onClick={handleBurnTexts}
            disabled={isBurning() || isAutoTexts() || isRedetecting() || isInpainting() || isReocring() || isTranslating()}
            class="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="Burn translated text into the result image"
          >
            <Show when={isBurning()} fallback={<Flame class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Burn Texts
          </button>
        </Show>

        {/* Spacer */}
        <div class="flex-1" />

        {/* Delete job */}
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={isDeleting()}
          class="flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Delete job"
          aria-label="Delete job"
        >
          <Trash2 class="h-3.5 w-3.5" />
          Delete
        </button>
      </header>

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={showDeleteConfirm()}
        title="Delete job"
        message="This will permanently delete the job, its images, and all bubble data. This cannot be undone."
        confirmLabel="Delete"
        loading={isDeleting()}
        onConfirm={handleDeleteJob}
        onCancel={() => { if (!isDeleting()) setShowDeleteConfirm(false); }}
      />

      {/* ── Action error banner ────────────────────────────────────────────── */}
      <Show when={actionError()}>
        {(msg) => (
          <div class="flex items-center gap-2 bg-red-50 px-4 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">
            <span class="flex-1">{msg()}</span>
            <button
              onClick={() => setActionError(null)}
              class="shrink-0 rounded p-0.5 hover:bg-red-100"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      {/* ── Loading / error states ─────────────────────────────────────────── */}
      <Show when={job.loading}>
        <div class="flex flex-1 items-center justify-center">
          <p class="text-sm text-slate-400">Loading job…</p>
        </div>
      </Show>

      <Show when={job.error}>
        <div class="m-6 rounded-2xl bg-red-50 p-6 text-sm text-red-600 ring-1 ring-red-200">
          Failed to load job: {String(job.error)}
        </div>
      </Show>

      {/* ── Main studio layout ─────────────────────────────────────────────── */}
      <Show when={!job.loading && !job.error && job()}>
        {(j) => (
          <div class="flex flex-1 overflow-hidden">

            {/* ── Left panel (collapsible) ────────────────────────────────── */}
            <Show when={!leftCollapsed()}>
              <aside class="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white overflow-hidden">

                {/* Stage 1 section: detection + bubble list */}
                <Show when={stage1Active()}>
                  <div
                    class={`flex flex-col overflow-hidden ${
                      (stage3Active() || (showTextSeg() && textSegBoxes().length > 0))
                        ? "flex-[1] border-b border-slate-200"
                        : "flex-1"
                    }`}
                  >
                    <BubbleList
                      bubbles={bubbleList()}
                      selectedIndex={panelContext() === "stage1" ? selectedIndex() : null}
                      onSelect={handleSelectStage1}
                      onAddBubble={() => setIsDrawMode(true)}
                    />
                  </div>

                  {/* TextSeg block management list */}
                  <Show when={showTextSeg() && textSegBoxes().length > 0}>
                    <div class={`flex flex-[1] flex-col overflow-hidden ${stage3Active() ? "border-b border-slate-200" : ""}`}>
                      <div class="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2">
                        <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-orange-600">
                          TextSeg ({textSegBoxes().length})
                        </span>
                      </div>
                      <div class="flex-1 overflow-y-auto">
                        <For each={textSegBoxes()}>
                          {(box, i) => {
                            const isSelected = () => selectedTextSegIndex() === i();
                            return (
                              <div
                                onClick={() => setSelectedTextSegIndex(isSelected() ? null : i())}
                                class={`group flex cursor-pointer items-center gap-1 border-b border-slate-100 px-2 py-1.5 transition-colors ${
                                  isSelected()
                                    ? "border-l-2 border-l-orange-400 bg-orange-50"
                                    : "hover:bg-slate-50"
                                }`}
                              >
                                <span class={`font-mono text-[10px] font-medium shrink-0 ${isSelected() ? "text-orange-600" : "text-slate-400"}`}>
                                  #{i()}
                                </span>
                                <span class="flex-1 truncate text-[10px] text-slate-500">
                                  {box.w}×{box.h} @ {box.x},{box.y}
                                </span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); void handleDeleteTextSeg(i()); }}
                                  class="invisible shrink-0 rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500 group-hover:visible"
                                  title="Delete TextSeg block"
                                  aria-label="Delete TextSeg block"
                                >
                                  <Trash2 class="h-3 w-3" />
                                </button>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  </Show>
                </Show>

                {/* Stage 3 section: text overlay list */}
                <Show when={stage3Active()}>
                  <div class="flex flex-1 flex-col overflow-hidden">
                    {/* Section header */}
                    <div class="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2">
                      <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Overlays ({bubbleList().length})
                      </span>
                    </div>
                    {/* Overlay list */}
                    <div class="flex-1 overflow-y-auto">
                      <Show
                        when={bubbleList().length > 0}
                        fallback={
                          <div class="px-3 py-6 text-center text-xs text-slate-400">
                            No text overlays
                          </div>
                        }
                      >
                        <For each={bubbleList()}>
                          {(bubble) => {
                            const isSelected = () =>
                              panelContext() === "stage3" &&
                              selectedIndex() === bubble.bubbleIndex;
                            return (
                              <button
                                data-bubble-idx={bubble.bubbleIndex}
                                onClick={() =>
                                  handleSelectStage3(
                                    isSelected() ? null : bubble.bubbleIndex,
                                  )
                                }
                                class={`w-full border-b border-slate-100 px-3 py-2 text-left transition-colors ${
                                  isSelected()
                                    ? "border-l-2 border-l-violet-500 bg-violet-50"
                                    : "hover:bg-slate-50"
                                } ${bubble.isExcluded ? "opacity-50" : ""}`}
                              >
                                <div class="flex items-center gap-1.5">
                                  <span
                                    class={`font-mono text-xs font-medium ${
                                      isSelected() ? "text-violet-700" : "text-slate-500"
                                    }`}
                                  >
                                    #{bubble.bubbleIndex}
                                  </span>
                                  <Show when={bubble.isExcluded}>
                                    <span class="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-500">
                                      ×
                                    </span>
                                  </Show>
                                </div>
                                <p
                                  class={`mt-0.5 truncate text-xs ${
                                    bubble.isExcluded
                                      ? "line-through text-slate-400"
                                      : "text-slate-600"
                                  }`}
                                >
                                  {bubble.translatedText?.slice(0, 24) || "(no text)"}
                                </p>
                              </button>
                            );
                          }}
                        </For>
                      </Show>
                    </div>
                  </div>
                </Show>

                {/* Fallback when no working stage is active */}
                <Show when={!stage1Active() && !stage3Active()}>
                  <div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
                    Activate Stage 1 or Stage 3 to edit
                  </div>
                </Show>
              </aside>
            </Show>

            {/* Collapse toggle — left */}
            <button
              onClick={() => setLeftCollapsed((v) => !v)}
              class="flex w-4 shrink-0 items-center justify-center border-r border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              title={leftCollapsed() ? "Expand left panel" : "Collapse left panel"}
              aria-label={leftCollapsed() ? "Expand left panel" : "Collapse left panel"}
            >
              <Show
                when={leftCollapsed()}
                fallback={<ChevronLeft class="h-3 w-3" />}
              >
                <ChevronRight class="h-3 w-3" />
              </Show>
            </button>

            {/* ── Centre — stage panels ──────────────────────────────────── */}
            <main class="relative flex flex-1 overflow-hidden">
              <Show
                when={sortedActiveStages().length === 2}
                fallback={
                  <div class="relative flex flex-1 flex-col overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[sortedActiveStages()[0]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(sortedActiveStages()[0]!, j())}
                    </div>
                  </div>
                }
              >
                <div class="flex h-full w-full">
                  <div class="flex flex-1 flex-col overflow-hidden border-r border-slate-200">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[sortedActiveStages()[0]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(sortedActiveStages()[0]!, j())}
                    </div>
                  </div>
                  <div class="flex flex-1 flex-col overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[sortedActiveStages()[1]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(sortedActiveStages()[1]!, j())}
                    </div>
                  </div>
                </div>
              </Show>
            </main>

            {/* Collapse toggle — right */}
            <button
              onClick={() => setRightCollapsed((v) => !v)}
              class="flex w-4 shrink-0 items-center justify-center border-l border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              title={rightCollapsed() ? "Expand right panel" : "Collapse right panel"}
              aria-label={rightCollapsed() ? "Expand right panel" : "Collapse right panel"}
            >
              <Show
                when={rightCollapsed()}
                fallback={<ChevronRight class="h-3 w-3" />}
              >
                <ChevronLeft class="h-3 w-3" />
              </Show>
            </button>

            {/* ── Right panel (collapsible, context-sensitive) ────────────── */}
            <Show when={!rightCollapsed()}>
              <aside class="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-white">
                <Show
                  when={panelContext() === "stage1"}
                  fallback={
                    <Show
                      when={panelContext() === "stage3"}
                      fallback={
                        <div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
                          Select a bubble or overlay to edit
                        </div>
                      }
                    >
                      <TextStyleEditor
                        bubble={selectedBubble()}
                        onUpdate={(patch: TextStylePatch) => handleBubbleUpdate(patch as UpdateBubbleBody)}
                        onDelete={handleBubbleDelete}
                      />
                    </Show>
                  }
                >
                  <BubbleEditor
                    bubble={selectedBubble()}
                    onUpdate={(patch: BubbleUpdatePatch) => handleBubbleUpdate(patch as UpdateBubbleBody)}
                    onDelete={handleBubbleDelete}
                    onReocr={handleBubbleReocr}
                    onRetranslate={handleBubbleRetranslate}
                    onReinpaint={handleBubbleReinpaint}
                    onRepatch={handleBubbleRepatch}
                  />
                </Show>
              </aside>
            </Show>

          </div>
        )}
      </Show>
    </div>
  );
}
