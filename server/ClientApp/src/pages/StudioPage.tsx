import { createResource, createSignal, Show, For } from "solid-js";
import type { JSX } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  ImageOff,
  RefreshCw,
  ScanText,
  Sparkles,
  Trash2,
} from "lucide-solid";
import {
  addBubble,
  deleteBubble,
  deleteJob,
  getJob,
  getJobBubbles,
  jobInpaintedUrl,
  jobOriginalUrl,
  jobResultUrl,
  redetectJob,
  reocrBubble,
  repatchBubble,
  reinpaintBubble,
  rerenderJob,
  retranslateBubble,
  retranslateJob,
  updateBubble,
} from "../api";
import { BubbleCanvas } from "../components/BubbleCanvas";
import { BubbleList } from "../components/BubbleList";
import { BubbleEditor } from "../components/BubbleEditor";
import type { BubbleUpdatePatch } from "../components/BubbleEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "./JobsListPage";
import type { PageTranslationJob, TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Stage type
// ---------------------------------------------------------------------------

/** Pipeline stage identifier. Clicking stage buttons in the toolbar selects
 *  up to 2 at a time; when 2 are active they display side-by-side. */
type Stage = "original" | "inpainted" | "compose" | "result";

const STAGE_LABELS: Record<Stage, string> = {
  original:  "1 · Original",
  inpainted: "2 · Inpainted",
  compose:   "3 · Compose",
  result:    "4 · Result",
};

const ALL_STAGES: Stage[] = ["original", "inpainted", "compose", "result"];

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
  // Stage picker: up to 2 active stages shown side-by-side
  const [activeStages, setActiveStages] = createSignal<Stage[]>(["result"]);
  const [isRedetecting, setIsRedetecting] = createSignal(false);
  const [isRetranslating, setIsRetranslating] = createSignal(false);
  const [isRerendering, setIsRerendering] = createSignal(false);
  const [isDrawMode, setIsDrawMode] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);
  const storedPadding = parseInt(localStorage.getItem("studio-bubble-padding") ?? "0", 10);
  const [bubblePadding, setBubblePadding] = createSignal<number>(
    Number.isNaN(storedPadding) ? 0 : storedPadding,
  );
  // Incremented after reinpaint/repatch so image URLs cache-bust
  const [imageVersion, setImageVersion] = createSignal(0);

  // Derived
  const bubbleList = () => bubbles() ?? [];
  const selectedBubble = () => {
    const idx = selectedIndex();
    return idx !== null
      ? (bubbleList().find((b) => b.bubbleIndex === idx) ?? null)
      : null;
  };

  // ---------------------------------------------------------------------------
  // Stage toggle — max 2 active; clicking a third replaces the oldest
  // ---------------------------------------------------------------------------

  function toggleStage(s: Stage): void {
    setActiveStages((prev) => {
      if (prev.includes(s)) {
        // Deselect — always keep at least 1
        const next = prev.filter((x) => x !== s);
        return next.length > 0 ? next : prev;
      }
      if (prev.length >= 2) {
        // Replace oldest (first in array)
        return [prev[1]!, s];
      }
      return [...prev, s];
    });
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  function handleSelect(idx: number | null): void {
    setSelectedIndex(idx === selectedIndex() ? null : idx);
  }

  async function handleMove(
    bubbleIndex: number,
    dx: number,
    dy: number,
  ): Promise<void> {
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
    bubbleIndex: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<void> {
    setActionError(null);
    try {
      await updateBubble(params.id, bubbleIndex, {
        bubbleX: x,
        bubbleY: y,
        bubbleW: w,
        bubbleH: h,
      });
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to resize bubble");
    }
  }

  async function handleDraw(
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<void> {
    setActionError(null);
    try {
      const b = await addBubble(params.id, { x, y, w, h });
      await refetchBubbles();
      setSelectedIndex(b.bubbleIndex);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add bubble");
    }
  }

  async function handleBubbleUpdate(patch: BubbleUpdatePatch): Promise<void> {
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
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete bubble");
    }
  }

  /** Poll job status until it leaves the "processing" state (done or error). */
  async function pollUntilDone(): Promise<void> {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await getJob(params.id);
      if (j.status !== "processing") return;
    }
  }

  async function handleRedetect(): Promise<void> {
    setIsRedetecting(true);
    setActionError(null);
    try {
      await redetectJob(params.id);
      await pollUntilDone();
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-detect failed");
    } finally {
      setIsRedetecting(false);
    }
  }

  async function handleRetranslate(): Promise<void> {
    setIsRetranslating(true);
    setActionError(null);
    try {
      await retranslateJob(params.id);
      await pollUntilDone();
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-translate failed");
    } finally {
      setIsRetranslating(false);
    }
  }

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

  async function handleRerender(): Promise<void> {
    setIsRerendering(true);
    setActionError(null);
    try {
      await rerenderJob(params.id, bubblePadding());
      await pollUntilDone();
      await Promise.all([refetchJob(), refetchBubbles()]);
      setImageVersion((v) => v + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-render failed");
    } finally {
      setIsRerendering(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-bubble action handlers
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
  // Canvas props helper
  // ---------------------------------------------------------------------------

  const canvasProps = () => ({
    bubbles: bubbleList(),
    selectedIndex: selectedIndex(),
    drawMode: isDrawMode(),
    bubblePadding: bubblePadding(),
    onSelect: handleSelect,
    onMove: handleMove,
    onResize: handleResize,
    onDraw: async (x: number, y: number, w: number, h: number) => {
      setIsDrawMode(false);
      await handleDraw(x, y, w, h);
    },
  });

  // ---------------------------------------------------------------------------
  // Stage panel renderer
  // ---------------------------------------------------------------------------

  function renderStage(stage: Stage, j: PageTranslationJob): JSX.Element {
    const v = imageVersion();
    const inpaintedUrl = () => `${jobInpaintedUrl(params.id)}?v=${v}`;
    const resultUrl    = () => `${jobResultUrl(params.id)}?v=${v}`;

    const noImagePlaceholder = (label: string) => (
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
        <ImageOff class="h-10 w-10 opacity-40" />
        <p class="text-sm">{label}</p>
        <p class="text-xs">Run Re-render to generate this image.</p>
      </div>
    );

    switch (stage) {
      case "original":
        return (
          <BubbleCanvas
            {...canvasProps()}
            imageUrl={jobOriginalUrl(params.id)}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        );

      case "inpainted":
        return j.inpaintedImagePath ? (
          <BubbleCanvas
            {...canvasProps()}
            imageUrl={inpaintedUrl()}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        ) : noImagePlaceholder("No inpainted image yet");

      case "compose":
        // Inpainted background + editable text overlay (glyphs only, no burn yet)
        return j.inpaintedImagePath ? (
          <BubbleCanvas
            {...canvasProps()}
            imageUrl={inpaintedUrl()}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
            showTextOverlay
          />
        ) : noImagePlaceholder("No inpainted image yet");

      case "result":
        return j.resultImagePath ? (
          <BubbleCanvas
            {...canvasProps()}
            imageUrl={resultUrl()}
            imageWidth={j.originalWidth}
            imageHeight={j.originalHeight}
          />
        ) : noImagePlaceholder("No result image yet");
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
          fallback={
            <div class="h-4 w-40 animate-pulse rounded bg-slate-200" />
          }
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

        {/* Stage picker — click 1 or 2 stages; 2 shows side-by-side */}
        <div class="ml-4 flex overflow-hidden rounded-lg border border-slate-200 text-xs">
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
                  title={
                    isActive()
                      ? `Hide ${STAGE_LABELS[stage]}`
                      : `Show ${STAGE_LABELS[stage]}`
                  }
                >
                  {STAGE_LABELS[stage]}
                </button>
              );
            }}
          </For>
        </div>

        {/* Bubble display padding */}
        <div class="ml-3 flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
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

        {/* Spacer */}
        <div class="flex-1" />

        {/* Action buttons */}
        <button
          onClick={handleRedetect}
          disabled={isRedetecting()}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-detect bubbles"
          aria-label="Re-detect bubbles"
        >
          <Show when={isRedetecting()} fallback={<ScanText class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Re-detect
        </button>

        <button
          onClick={handleRetranslate}
          disabled={isRetranslating()}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-translate"
          aria-label="Re-translate"
        >
          <Show when={isRetranslating()} fallback={<Sparkles class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Re-translate
        </button>

        <button
          onClick={handleRerender}
          disabled={isRerendering()}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-render image"
          aria-label="Re-render image"
        >
          <Show when={isRerendering()} fallback={<RefreshCw class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Re-render
        </button>

        {/* Divider */}
        <div class="mx-1 h-5 w-px bg-slate-200" />

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

      {/* ── Action error banner ─────────────────────────────────────────── */}
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

      {/* ── Loading / error states ───────────────────────────────────────── */}
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

      {/* ── Main studio layout ────────────────────────────────────────────── */}
      <Show when={!job.loading && !job.error && job()}>
        {(j) => (
          <div class="flex flex-1 overflow-hidden">
            {/* Left — bubble list */}
            <aside class="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white">
              <BubbleList
                bubbles={bubbleList()}
                selectedIndex={selectedIndex()}
                onSelect={handleSelect}
                onAddBubble={() => setIsDrawMode(true)}
              />
            </aside>

            {/* Centre — stage panels (1 or 2 active) */}
            <main class="relative flex flex-1 overflow-hidden">
              <Show
                when={activeStages().length === 2}
                fallback={
                  /* Single stage — full width */
                  <div class="relative flex flex-1 flex-col overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[activeStages()[0]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(activeStages()[0]!, j())}
                    </div>
                  </div>
                }
              >
                {/* Side-by-side — two stages */}
                <div class="flex h-full w-full">
                  <div class="flex flex-col flex-1 overflow-hidden border-r border-slate-200">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[activeStages()[0]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(activeStages()[0]!, j())}
                    </div>
                  </div>
                  <div class="flex flex-col flex-1 overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {STAGE_LABELS[activeStages()[1]!]}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      {renderStage(activeStages()[1]!, j())}
                    </div>
                  </div>
                </div>
              </Show>
            </main>

            {/* Right — bubble editor */}
            <aside class="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-white">
              <BubbleEditor
                bubble={selectedBubble()}
                onUpdate={handleBubbleUpdate}
                onDelete={handleBubbleDelete}
                onReocr={handleBubbleReocr}
                onRetranslate={handleBubbleRetranslate}
                onReinpaint={handleBubbleReinpaint}
                onRepatch={handleBubbleRepatch}
              />
            </aside>
          </div>
        )}
      </Show>
    </div>
  );
}
