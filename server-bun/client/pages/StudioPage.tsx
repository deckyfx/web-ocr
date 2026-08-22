import { useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ArrowLeft, Trash2, AlertTriangle, X } from "lucide-react";
import {
  getJob, getBubbles, getTextSegBlocks,
  addTextSegBlock, deleteTextSegBlock,
  reocrJob, retranslateJob, redetectJob, inpaintJob, rerenderJob,
  deleteJob,
  jobOriginalUrl, jobInpaintedUrl, jobResultUrl,
} from "../api";
import { useStudioStore } from "../stores/studio";
import { BubbleCanvas } from "../components/BubbleCanvas";
import { StudioToolbar } from "../components/StudioToolbar";
import { TextSegDetail } from "../components/TextSegDetail";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useState } from "react";

export function StudioPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const store = useStudioStore();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const jobQ = useQuery({ queryKey: ["job", id], queryFn: () => getJob(id!), enabled: !!id });
  const bubblesQ = useQuery({ queryKey: ["bubbles", id], queryFn: () => getBubbles(id!), enabled: !!id });
  const textSegQ = useQuery({ queryKey: ["textseg", id], queryFn: () => getTextSegBlocks(id!), enabled: !!id });

  const job = jobQ.data ?? null;
  const bubbles = bubblesQ.data ?? [];
  const textSegBlocks = textSegQ.data ?? [];

  // image dimensions from job (fallback to 1×1 until loaded)
  const imgW = 1920;
  const imgH = 1080;

  // ── Escape key cancels draw mode ───────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.setTextSegDrawMode(false);
      if (e.key === "d" || e.key === "D") store.setTextSegDrawMode(!store.isTextSegDrawMode);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [store.isTextSegDrawMode]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ["job", id] });
    qc.invalidateQueries({ queryKey: ["bubbles", id] });
    qc.invalidateQueries({ queryKey: ["textseg", id] });
  };

  const runAction = useCallback(
    async (
      flag: "isRedetecting" | "isReocring" | "isTranslating" | "isInpainting" | "isBurning",
      fn: () => Promise<unknown>
    ) => {
      store.setLoading(flag, true);
      store.setActionError(null);
      try {
        await fn();
        refetchAll();
      } catch (err) {
        store.setActionError(String(err));
      } finally {
        store.setLoading(flag, false);
      }
    },
    [id]
  );

  const deleteMutation = useMutation({
    mutationFn: () => deleteJob(id!),
    onSuccess: () => navigate("/"),
  });

  const handleDrawTextSeg = useCallback(
    async (x: number, y: number, w: number, h: number) => {
      await addTextSegBlock(id!, { x, y, w, h });
      qc.invalidateQueries({ queryKey: ["textseg", id] });
    },
    [id]
  );

  const handleDeleteTextSeg = useCallback(
    async (blockId: string) => {
      await deleteTextSegBlock(id!, blockId);
      store.selectTextSeg(null);
      qc.invalidateQueries({ queryKey: ["textseg", id] });
    },
    [id]
  );

  // ── Image URL for current stage ────────────────────────────────────────────

  const imageUrl = (() => {
    if (!id) return "";
    const v = `?v=${store.imageVersion}`;
    switch (store.activeStage) {
      case "inpainted": return jobInpaintedUrl(id) + v;
      case "result":    return jobResultUrl(id) + v;
      default:          return jobOriginalUrl(id) + v;
    }
  })();

  // ── Bubble navigation ──────────────────────────────────────────────────────

  const canPrevBubble = store.selectedBubbleIndex !== null && store.selectedBubbleIndex > 0;
  const canNextBubble = store.selectedBubbleIndex !== null && store.selectedBubbleIndex < bubbles.length - 1;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <button
          onClick={() => navigate("/")}
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-sm font-semibold text-gray-200 truncate flex-1">
          {job?.id.slice(0, 8) ?? "Studio"}
        </h1>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          job?.status === "done" ? "bg-emerald-900 text-emerald-300" :
          job?.status === "error" ? "bg-red-900 text-red-300" :
          "bg-yellow-900 text-yellow-300"
        }`}>
          {job?.status ?? "…"}
        </span>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="p-1.5 rounded-lg text-red-400 hover:bg-red-400/10 transition-colors"
          title="Delete job"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* Toolbar */}
      <StudioToolbar
        stage={store.activeStage}
        onStageChange={store.setActiveStage}
        showBubbles={store.showBubbles}
        showTextSeg={store.showTextSeg}
        isTextSegDrawMode={store.isTextSegDrawMode}
        isRedetecting={store.isRedetecting}
        isReocring={store.isReocring}
        isTranslating={store.isTranslating}
        isInpainting={store.isInpainting}
        isBurning={store.isBurning}
        onRedetect={() => runAction("isRedetecting", () => redetectJob(id!))}
        onReocr={() => runAction("isReocring", () => reocrJob(id!))}
        onTranslate={() => runAction("isTranslating", () => retranslateJob(id!))}
        onInpaint={() => runAction("isInpainting", () => inpaintJob(id!))}
        onBurn={() => runAction("isBurning", () => rerenderJob(id!))}
        onToggleBubbles={() => store.setShowBubbles(!store.showBubbles)}
        onToggleTextSeg={() => store.setShowTextSeg(!store.showTextSeg)}
        onToggleDrawMode={() => store.setTextSegDrawMode(!store.isTextSegDrawMode)}
      />

      {/* Error banner */}
      {store.actionError && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-900/60 border-b border-red-800 text-red-300 text-sm shrink-0">
          <AlertTriangle size={14} />
          <span className="flex-1">{store.actionError}</span>
          <button onClick={() => store.setActionError(null)}><X size={14} /></button>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel — bubble list */}
        {!store.leftCollapsed && (
          <div className="w-48 shrink-0 border-r border-gray-800 bg-gray-900 overflow-y-auto">
            <div className="p-2 text-xs text-gray-500 font-semibold uppercase tracking-wider border-b border-gray-800">
              Bubbles ({bubbles.length})
            </div>
            {bubbles.map((b, i) => (
              <button
                key={b.id}
                onClick={() => store.selectBubble(i === store.selectedBubbleIndex ? null : i)}
                className={`w-full text-left px-3 py-2 text-xs border-b border-gray-800/50 transition-colors ${
                  i === store.selectedBubbleIndex
                    ? "bg-indigo-600/20 text-indigo-300"
                    : "text-gray-400 hover:bg-gray-800"
                }`}
              >
                <div className="font-mono text-gray-500">#{i + 1}</div>
                <div className="truncate">{b.translatedText ?? b.sourceText ?? "—"}</div>
              </button>
            ))}
          </div>
        )}

        {/* Collapse toggle */}
        <button
          onClick={() => store.setLeftCollapsed(!store.leftCollapsed)}
          className="self-center p-0.5 text-gray-600 hover:text-gray-400 shrink-0"
        >
          {store.leftCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {/* Canvas */}
        <div
          className="flex-1 min-w-0 overflow-auto bg-gray-950 flex items-center justify-center p-4"
          onClick={() => { store.selectBubble(null); store.selectTextSeg(null); }}
        >
          {imageUrl && (
            <div className="max-w-full max-h-full">
              <BubbleCanvas
                imageUrl={imageUrl}
                imageWidth={imgW}
                imageHeight={imgH}
                bubbles={bubbles}
                selectedBubbleIndex={store.selectedBubbleIndex}
                overlayBoxes={store.showTextSeg ? textSegBlocks : []}
                selectedTextSegIndex={store.selectedTextSegIndex}
                textSegDrawMode={store.isTextSegDrawMode}
                showBubbles={store.showBubbles}
                showTextOverlay={store.activeStage === "result"}
                bubblePadding={store.bubblePadding}
                onSelectBubble={store.selectBubble}
                onSelectTextSeg={store.selectTextSeg}
                onDrawTextSeg={handleDrawTextSeg}
              />
            </div>
          )}
          {!imageUrl && (
            <div className="text-gray-600 text-sm">No image</div>
          )}
        </div>

        {/* Right panel — detail */}
        <button
          onClick={() => store.setRightCollapsed(!store.rightCollapsed)}
          className="self-center p-0.5 text-gray-600 hover:text-gray-400 shrink-0"
        >
          {store.rightCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        {!store.rightCollapsed && (
          <div className="w-64 shrink-0 border-l border-gray-800 bg-gray-900 overflow-y-auto">
            {store.selectedTextSegIndex !== null && store.showTextSeg ? (
              <TextSegDetail
                box={textSegBlocks[store.selectedTextSegIndex] ?? null}
                index={store.selectedTextSegIndex}
                onDelete={handleDeleteTextSeg}
              />
            ) : store.selectedBubbleIndex !== null ? (
              <div className="p-3 flex flex-col gap-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Bubble #{store.selectedBubbleIndex + 1}
                </div>
                {(() => {
                  const b = bubbles[store.selectedBubbleIndex];
                  if (!b) return null;
                  return (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-gray-500">Source</label>
                        <div className="bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 min-h-[3rem]">
                          {b.sourceText ?? <span className="italic text-gray-600">—</span>}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-gray-500">Translation</label>
                        <div className="bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 min-h-[3rem]">
                          {b.translatedText ?? <span className="italic text-gray-600">—</span>}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-600 text-sm p-4 text-center">
                Select a TextSeg block or bubble to inspect
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bubble navigation footer */}
      {store.selectedBubbleIndex !== null && bubbles.length > 0 && (
        <div className="flex items-center justify-center gap-4 py-1.5 bg-gray-900 border-t border-gray-800 shrink-0">
          <button
            onClick={() => store.selectBubble(store.selectedBubbleIndex! - 1)}
            disabled={!canPrevBubble}
            className="p-1 text-gray-400 hover:text-white disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-gray-400">
            {store.selectedBubbleIndex + 1} / {bubbles.length}
          </span>
          <button
            onClick={() => store.selectBubble(store.selectedBubbleIndex! + 1)}
            disabled={!canNextBubble}
            className="p-1 text-gray-400 hover:text-white disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {/* Delete confirm */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete job?"
          message="This will permanently delete the job and all associated data."
          confirmLabel="Delete"
          danger
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
