import { createResource, createSignal, createMemo, createEffect, onCleanup, Show } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import {
  addTextSegBlock,
  deleteBubble,
  deleteJob,
  deleteTextSegBlock,
  getJob,
  getJobBubbles,
  getJobTextSegBlocks,
  inpaintJob,
  jobResultUrl,
  redetectJob,
  reocrJob,
  rerenderJob,
  retranslateJob,
  translateJob,
  updateBubble,
} from "../api";
import type { TextSegBox, UpdateBubbleBody } from "../api";
import { TextStyleEditor } from "../components/TextStyleEditor";
import type { TextStylePatch } from "../components/TextStyleEditor";
import { TextSegDetail } from "../components/TextSegDetail";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StudioToolbar, STAGE_ORDER } from "../components/StudioToolbar";
import type { Stage } from "../components/StudioToolbar";
import { StudioLeftPanel } from "../components/StudioLeftPanel";
import { StudioStageView } from "../components/StudioStageView";
import type { PageTranslationJob, TranslationBubble } from "../types";

export function StudioPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [job, { refetch: refetchJob }] = createResource(() => params.id, getJob);
  const [bubbles, { refetch: refetchBubbles }] = createResource(
    () => params.id,
    getJobBubbles,
  );

  const [selectedIndex, setSelectedIndex] = createSignal<number | null>(null);
  const [activeStages, setActiveStages] = createSignal<Stage[]>(["original"]);
  const [leftCollapsed, setLeftCollapsed] = createSignal(false);
  const [rightCollapsed, setRightCollapsed] = createSignal(false);

  const [isRedetecting, setIsRedetecting] = createSignal(false);
  const [isInpainting, setIsInpainting] = createSignal(false);
  const [isReocring, setIsReocring] = createSignal(false);
  const [isTranslating, setIsTranslating] = createSignal(false);
  const [isAutoTexts, setIsAutoTexts] = createSignal(false);
  const [isBurning, setIsBurning] = createSignal(false);

  const [actionError, setActionError] = createSignal<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);

  const storedPadding = parseInt(localStorage.getItem("studio-bubble-padding") ?? "0", 10);
  const [bubblePadding, setBubblePadding] = createSignal<number>(
    Number.isNaN(storedPadding) ? 0 : storedPadding,
  );
  const [imageVersion, setImageVersion] = createSignal(0);

  const [showTextSeg, setShowTextSeg] = createSignal(true);
  const [textSegBoxes, setTextSegBoxes] = createSignal<TextSegBox[]>([]);
  const [isLoadingTextSeg, setIsLoadingTextSeg] = createSignal(false);
  const [selectedTextSegIndex, setSelectedTextSegIndex] = createSignal<number | null>(null);

  const [showBubbles, setShowBubbles] = createSignal(false);
  const [isTextSegDrawMode, setIsTextSegDrawMode] = createSignal(false);

  // Escape key cancels TextSeg draw mode
  createEffect(() => {
    if (!isTextSegDrawMode()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsTextSegDrawMode(false);
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Load TextSeg on mount (shown by default)
  createEffect(() => {
    if (showTextSeg() && textSegBoxes().length === 0 && !isLoadingTextSeg()) {
      setIsLoadingTextSeg(true);
      getJobTextSegBlocks(params.id)
        .then(setTextSegBoxes)
        .catch(() => setShowTextSeg(false))
        .finally(() => setIsLoadingTextSeg(false));
    }
  });

  async function handleToggleTextSeg(): Promise<void> {
    const next = !showTextSeg();
    setShowTextSeg(next);
    if (!next) { setSelectedTextSegIndex(null); return; }
    if (textSegBoxes().length === 0) {
      setIsLoadingTextSeg(true);
      try {
        const boxes = await getJobTextSegBlocks(params.id);
        setTextSegBoxes(boxes);
      } catch (err) {
        setShowTextSeg(false);
        setActionError(err instanceof Error ? err.message : "Failed to load TextSeg blocks");
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

  function handleAddTextSeg(): void {
    setIsTextSegDrawMode((v) => !v);
  }

  async function handleTextSegDraw(x: number, y: number, w: number, h: number): Promise<void> {
    setIsTextSegDrawMode(false);
    setActionError(null);
    try {
      const updated = await addTextSegBlock(params.id, { x, y, w, h });
      setTextSegBoxes(updated);
      setSelectedTextSegIndex(updated.length - 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add TextSeg block");
    }
  }

  const bubbleList = () => bubbles() ?? [];
  const selectedBubble = (): TranslationBubble | null => {
    const idx = selectedIndex();
    return idx !== null
      ? (bubbleList().find((b) => b.bubbleIndex === idx) ?? null)
      : null;
  };

  const sortedActiveStages = createMemo(() =>
    [...activeStages()].sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b]),
  );

  const effectiveShowBubbles = createMemo(() => {
    if (!showBubbles()) return false;
    const stages = activeStages();
    return stages.includes("original") || stages.includes("compose");
  });
  const effectiveShowTextSeg = createMemo(() => {
    if (!showTextSeg()) return false;
    const stages = activeStages();
    return stages.includes("original") || stages.includes("inpainted");
  });

  const stage1Active = () => activeStages().includes("original");
  const stage3Active = () => activeStages().includes("compose");

  function toggleStage(s: Stage): void {
    setActiveStages((prev) => {
      if (prev.includes(s)) {
        const next = prev.filter((x) => x !== s);
        return next.length > 0 ? next : prev;
      }
      if (prev.length >= 2) return [prev[1]!, s];
      return [...prev, s];
    });
  }

  function handleSelectStage3(idx: number | null): void {
    const next = idx !== null && idx === selectedIndex() ? null : idx;
    setSelectedIndex(next);
  }

  function handleSelectTextSeg(idx: number | null): void {
    setSelectedTextSegIndex(idx);
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
      refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete bubble");
    }
  }

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
      setSelectedIndex(null);
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
      if (j.status === "error") setActionError(j.errorMessage ?? "OCR failed");
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
      if (j.status === "error") setActionError(j.errorMessage ?? "Translate failed");
      await refetchBubbles();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Translate failed");
    } finally {
      setIsTranslating(false);
    }
  }

  async function handleAutoTexts(): Promise<void> {
    setIsAutoTexts(true);
    setActionError(null);
    try {
      await redetectJob(params.id);
      await pollUntilDone();
      await retranslateJob(params.id);
      await pollUntilDone();
      setSelectedIndex(null);
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

  /** Common props for every StudioStageView instance. */
  const commonStageProps = () => ({
    jobId: params.id,
    job: job()!,
    imageVersion: imageVersion(),
    bubbleList: bubbleList(),
    selectedIndex: selectedIndex(),
    bubblePadding: bubblePadding(),
    textSegBoxes: textSegBoxes(),
    selectedTextSegIndex: selectedTextSegIndex(),
    onSelect: handleSelectStage3,
    onSelectTextSeg: handleSelectTextSeg,
  });

  return (
    <div class="flex h-screen flex-col bg-slate-50">
      <StudioToolbar
        job={job()}
        activeStages={activeStages()}
        bubblePadding={bubblePadding()}
        showTextSeg={showTextSeg()}
        isLoadingTextSeg={isLoadingTextSeg()}
        showBubbles={showBubbles()}
        stage1Active={stage1Active()}
        stage3Active={stage3Active()}
        isRedetecting={isRedetecting()}
        isInpainting={isInpainting()}
        isReocring={isReocring()}
        isTranslating={isTranslating()}
        isAutoTexts={isAutoTexts()}
        isBurning={isBurning()}
        isDeleting={isDeleting()}
        onNavigateBack={() => navigate("/jobs")}
        onToggleStage={toggleStage}
        onSetBubblePadding={(v) => {
          setBubblePadding(v);
          localStorage.setItem("studio-bubble-padding", String(v));
        }}
        onToggleTextSeg={handleToggleTextSeg}
        onToggleShowBubbles={() => setShowBubbles((v) => !v)}
        onRedetect={handleRedetect}
        onInpaint={handleInpaint}
        onReocr={handleReocr}
        onTranslate={handleTranslate}
        onAutoTexts={handleAutoTexts}
        onBurnTexts={handleBurnTexts}
        onDeleteClick={() => setShowDeleteConfirm(true)}
      />

      <ConfirmDialog
        open={showDeleteConfirm()}
        title="Delete job"
        message="This will permanently delete the job, its images, and all bubble data. This cannot be undone."
        confirmLabel="Delete"
        loading={isDeleting()}
        onConfirm={handleDeleteJob}
        onCancel={() => { if (!isDeleting()) setShowDeleteConfirm(false); }}
      />

      <Show when={actionError()}>
        {(msg) => (
          <div class="flex items-center gap-2 bg-red-50 px-4 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">
            <span class="flex-1">{msg()}</span>
            <button
              onClick={() => setActionError(null)}
              class="shrink-0 rounded p-0.5 hover:bg-red-100"
              aria-label="Dismiss error"
            >✕</button>
          </div>
        )}
      </Show>

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

      <Show when={!job.loading && !job.error && job()}>
        {(j) => (
          <div class="flex flex-1 overflow-hidden">
            <Show when={!leftCollapsed()}>
              <StudioLeftPanel
                stage1Active={stage1Active()}
                stage3Active={stage3Active()}
                selectedIndex={selectedIndex()}
                bubbleList={bubbleList()}
                showTextSeg={effectiveShowTextSeg()}
                textSegBoxes={textSegBoxes()}
                selectedTextSegIndex={selectedTextSegIndex()}
                isTextSegDrawMode={isTextSegDrawMode()}
                onSelectStage3={handleSelectStage3}
                onAddTextSeg={handleAddTextSeg}
                onDeleteTextSeg={handleDeleteTextSeg}
                setSelectedTextSegIndex={setSelectedTextSegIndex}
              />
            </Show>

            <button
              onClick={() => setLeftCollapsed((v) => !v)}
              class="flex w-4 shrink-0 items-center justify-center border-r border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              title={leftCollapsed() ? "Expand left panel" : "Collapse left panel"}
              aria-label={leftCollapsed() ? "Expand left panel" : "Collapse left panel"}
            >
              <Show when={leftCollapsed()} fallback={<ChevronLeft class="h-3 w-3" />}>
                <ChevronRight class="h-3 w-3" />
              </Show>
            </button>

            <main class="relative flex flex-1 overflow-hidden">
              <Show
                when={sortedActiveStages().length === 2}
                fallback={
                  <div class="relative flex flex-1 flex-col overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {sortedActiveStages()[0]!}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      <StudioStageView
                        {...commonStageProps()}
                        stage={sortedActiveStages()[0]!}
                        showTextSeg={effectiveShowTextSeg()}
                        showBubbles={effectiveShowBubbles()}
                        isTextSegDrawMode={isTextSegDrawMode()}
                        onDrawTextSeg={(x, y, w, h) => void handleTextSegDraw(x, y, w, h)}
                      />
                    </div>
                  </div>
                }
              >
                <div class="flex h-full w-full">
                  <div class="flex flex-1 flex-col overflow-hidden border-r border-slate-200">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {sortedActiveStages()[0]!}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      <StudioStageView
                        {...commonStageProps()}
                        stage={sortedActiveStages()[0]!}
                        showTextSeg={effectiveShowTextSeg()}
                        showBubbles={effectiveShowBubbles()}
                        isTextSegDrawMode={isTextSegDrawMode()}
                        onDrawTextSeg={(x, y, w, h) => void handleTextSegDraw(x, y, w, h)}
                      />
                    </div>
                  </div>
                  <div class="flex flex-1 flex-col overflow-hidden">
                    <div class="shrink-0 bg-slate-100 px-2 py-0.5 text-center text-xs font-medium text-slate-500">
                      {sortedActiveStages()[1]!}
                    </div>
                    <div class="flex-1 overflow-hidden">
                      <StudioStageView
                        {...commonStageProps()}
                        stage={sortedActiveStages()[1]!}
                        showTextSeg={effectiveShowTextSeg()}
                        showBubbles={effectiveShowBubbles()}
                        isTextSegDrawMode={false}
                        onDrawTextSeg={() => {}}
                      />
                    </div>
                  </div>
                </div>
              </Show>
            </main>

            <button
              onClick={() => setRightCollapsed((v) => !v)}
              class="flex w-4 shrink-0 items-center justify-center border-l border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              title={rightCollapsed() ? "Expand right panel" : "Collapse right panel"}
              aria-label={rightCollapsed() ? "Expand right panel" : "Collapse right panel"}
            >
              <Show when={rightCollapsed()} fallback={<ChevronRight class="h-3 w-3" />}>
                <ChevronLeft class="h-3 w-3" />
              </Show>
            </button>

            <Show when={!rightCollapsed()}>
              <aside class="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-white">
                <Show
                  when={selectedTextSegIndex() !== null && effectiveShowTextSeg()}
                  fallback={
                    <Show
                      when={selectedIndex() !== null}
                      fallback={
                        <div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
                          Select an overlay or text segment to edit
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
                  <TextSegDetail
                    box={textSegBoxes()[selectedTextSegIndex()!]}
                    index={selectedTextSegIndex()}
                    onDelete={(idx) => void handleDeleteTextSeg(idx)}
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
