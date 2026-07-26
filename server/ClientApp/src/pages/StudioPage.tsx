import { createResource, createSignal, Show, Switch, Match } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  ImageOff,
  RefreshCw,
  ScanText,
  Sparkles,
} from "lucide-solid";
import {
  addBubble,
  deleteBubble,
  getJob,
  getJobBubbles,
  jobOriginalUrl,
  jobResultUrl,
  redetectJob,
  rerenderJob,
  retranslateJob,
  updateBubble,
} from "../api";
import { BubbleCanvas } from "../components/BubbleCanvas";
import { BubbleList } from "../components/BubbleList";
import { BubbleEditor } from "../components/BubbleEditor";
import type { BubbleUpdatePatch } from "../components/BubbleEditor";
import { StatusBadge } from "./JobsListPage";

// ---------------------------------------------------------------------------
// View mode type
// ---------------------------------------------------------------------------

type ViewMode = "original" | "result" | "sidebyside";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function StudioPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Resources
  const [job] = createResource(() => params.id, getJob);
  const [bubbles, { refetch: refetchBubbles }] = createResource(
    () => params.id,
    getJobBubbles,
  );

  // UI state
  const [selectedIndex, setSelectedIndex] = createSignal<number | null>(null);
  const [viewMode, setViewMode] = createSignal<ViewMode>("result");
  const [isRedetecting, setIsRedetecting] = createSignal(false);
  const [isRetranslating, setIsRetranslating] = createSignal(false);
  const [isRerendering, setIsRerendering] = createSignal(false);
  const [isDrawMode, setIsDrawMode] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // Derived
  const bubbleList = () => bubbles() ?? [];
  const selectedBubble = () => {
    const idx = selectedIndex();
    return idx !== null
      ? (bubbleList().find((b) => b.bubbleIndex === idx) ?? null)
      : null;
  };

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

  async function handleRerender(): Promise<void> {
    setIsRerendering(true);
    setActionError(null);
    try {
      await rerenderJob(params.id);
      await pollUntilDone();
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Re-render failed");
    } finally {
      setIsRerendering(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-components
  // ---------------------------------------------------------------------------

  const canvasProps = () => ({
    bubbles: bubbleList(),
    selectedIndex: selectedIndex(),
    drawMode: isDrawMode(),
    onSelect: handleSelect,
    onMove: handleMove,
    onResize: handleResize,
    onDraw: async (x: number, y: number, w: number, h: number) => {
      setIsDrawMode(false);
      await handleDraw(x, y, w, h);
    },
  });

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

        {/* View mode toggle */}
        <div class="ml-4 flex overflow-hidden rounded-lg border border-slate-200 text-xs">
          {(["original", "result", "sidebyside"] as ViewMode[]).map((mode) => (
            <button
              onClick={() => setViewMode(mode)}
              class={`px-2.5 py-1.5 font-medium transition-colors ${
                viewMode() === mode
                  ? "bg-violet-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {mode === "original"
                ? "Original"
                : mode === "result"
                  ? "Result"
                  : "Side by side"}
            </button>
          ))}
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
      </header>

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

            {/* Centre — canvas */}
            <main class="relative flex flex-1 overflow-hidden">
              <Switch>
                {/* Original */}
                <Match when={viewMode() === "original"}>
                  <BubbleCanvas
                    {...canvasProps()}
                    imageUrl={jobOriginalUrl(params.id)}
                    imageWidth={j().originalWidth}
                    imageHeight={j().originalHeight}
                  />
                </Match>

                {/* Result */}
                <Match when={viewMode() === "result"}>
                  <Show
                    when={j().resultImagePath}
                    fallback={
                      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
                        <ImageOff class="h-10 w-10 opacity-40" />
                        <p class="text-sm">No result image yet</p>
                        <p class="text-xs">
                          Run Re-render to generate the translated image.
                        </p>
                      </div>
                    }
                  >
                    <BubbleCanvas
                      {...canvasProps()}
                      imageUrl={jobResultUrl(params.id)}
                      imageWidth={j().originalWidth}
                      imageHeight={j().originalHeight}
                    />
                  </Show>
                </Match>

                {/* Side by side */}
                <Match when={viewMode() === "sidebyside"}>
                  <div class="flex h-full w-full">
                    <div class="flex-1 overflow-hidden border-r border-slate-700">
                      <BubbleCanvas
                        {...canvasProps()}
                        imageUrl={jobOriginalUrl(params.id)}
                        imageWidth={j().originalWidth}
                        imageHeight={j().originalHeight}
                      />
                    </div>
                    <div class="flex-1 overflow-hidden">
                      <Show
                        when={j().resultImagePath}
                        fallback={
                          <div class="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
                            <ImageOff class="h-10 w-10 opacity-40" />
                            <p class="text-sm">No result image yet</p>
                            <p class="text-xs">Run Re-render to generate the translated image.</p>
                          </div>
                        }
                      >
                        <BubbleCanvas
                          {...canvasProps()}
                          imageUrl={jobResultUrl(params.id)}
                          imageWidth={j().originalWidth}
                          imageHeight={j().originalHeight}
                        />
                      </Show>
                    </div>
                  </div>
                </Match>
              </Switch>
            </main>

            {/* Right — bubble editor */}
            <aside class="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-white">
              <BubbleEditor
                bubble={selectedBubble()}
                onUpdate={handleBubbleUpdate}
                onDelete={handleBubbleDelete}
              />
            </aside>
          </div>
        )}
      </Show>
    </div>
  );
}
