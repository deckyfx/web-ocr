import { Show, For } from "solid-js";
import {
  ArrowLeft,
  Flame,
  PaintBucket,
  RefreshCw,
  ScanText,
  Sparkles,
  Trash2,
  Type,
} from "lucide-solid";
import { ConfirmDialog } from "./ConfirmDialog";
import { StatusBadge } from "../pages/JobsListPage";
import type { PageTranslationJob } from "../types";

export type Stage = "original" | "inpainted" | "compose" | "result";

export const STAGE_LABELS: Record<Stage, string> = {
  original:  "1 · Original",
  inpainted: "2 · Inpainted",
  compose:   "3 · Compose",
  result:    "4 · Result",
};

export const ALL_STAGES: Stage[] = ["original", "inpainted", "compose", "result"];

export const STAGE_ORDER: Record<Stage, number> = {
  original: 0, inpainted: 1, compose: 2, result: 3,
};

export type PanelContext = "stage1" | "stage3" | null;

interface ToolbarProps {
  job: PageTranslationJob | undefined;
  activeStages: Stage[];
  bubblePadding: number;
  showTextSeg: boolean;
  isLoadingTextSeg: boolean;
  showBubbles: boolean;
  stage1Active: boolean;
  stage3Active: boolean;
  isRedetecting: boolean;
  isInpainting: boolean;
  isReocring: boolean;
  isTranslating: boolean;
  isAutoTexts: boolean;
  isBurning: boolean;
  isDeleting: boolean;
  onNavigateBack: () => void;
  onToggleStage: (s: Stage) => void;
  onSetBubblePadding: (v: number) => void;
  onToggleTextSeg: () => void;
  onToggleShowBubbles: () => void;
  onRedetect: () => void;
  onInpaint: () => void;
  onReocr: () => void;
  onTranslate: () => void;
  onAutoTexts: () => void;
  onBurnTexts: () => void;
  onDeleteClick: () => void;
}

export function StudioToolbar(props: ToolbarProps) {
  return (
    <header class="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 shadow-sm">
      <button
        onClick={props.onNavigateBack}
        class="flex items-center gap-1 rounded p-1 text-slate-500 hover:bg-slate-100 transition-colors"
        title="Back to jobs"
        aria-label="Back to jobs"
      >
        <ArrowLeft class="h-4 w-4" />
      </button>

      <Show
        when={props.job}
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

      <div class="mx-1 h-5 w-px bg-slate-200" />

      <div class="flex overflow-hidden rounded-lg border border-slate-200 text-xs">
        <For each={ALL_STAGES}>
          {(stage) => {
            const isActive = () => props.activeStages.includes(stage);
            return (
              <button
                onClick={() => props.onToggleStage(stage)}
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

      <div class="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
        <span class="select-none font-medium">Pad</span>
        <button
          class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30"
          disabled={props.bubblePadding <= 0}
          onClick={() => {
            const v = Math.max(0, props.bubblePadding - 1);
            props.onSetBubblePadding(v);
          }}
          aria-label="Decrease bubble padding"
        >−</button>
        <span class="w-5 text-center tabular-nums">{props.bubblePadding}</span>
        <button
          class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30"
          disabled={props.bubblePadding >= 20}
          onClick={() => {
            const v = Math.min(20, props.bubblePadding + 1);
            props.onSetBubblePadding(v);
          }}
          aria-label="Increase bubble padding"
        >+</button>
      </div>

      <button
        onClick={props.onToggleTextSeg}
        disabled={props.isLoadingTextSeg}
        aria-pressed={props.showTextSeg}
        title="Toggle TextSeg text-block overlay"
        class={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          props.showTextSeg
            ? "border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        <Show when={props.isLoadingTextSeg} fallback={
          <span class="inline-block h-2.5 w-2.5 rounded-sm border-2 border-current" style={{ "border-style": "dashed" }} />
        }>
          <RefreshCw class="h-3.5 w-3.5 animate-spin" />
        </Show>
        TextSeg
      </button>

      <button
        onClick={props.onToggleShowBubbles}
        aria-pressed={props.showBubbles}
        title="Toggle bubble bounding-box overlay"
        class={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
          props.showBubbles
            ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
            : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50"
        }`}
      >
        <span class="inline-block h-2.5 w-2.5 rounded-sm border-2 border-current" />
        Bubbles
      </button>

      <div class="mx-1 h-5 w-px bg-slate-200" />

      <Show when={props.stage1Active}>
        <button
          onClick={props.onRedetect}
          disabled={props.isRedetecting || props.isInpainting || props.isReocring || props.isTranslating || props.isAutoTexts || props.isBurning}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-detect speech bubbles"
        >
          <Show when={props.isRedetecting} fallback={<ScanText class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Detect
        </button>

        <button
          onClick={props.onInpaint}
          disabled={props.isInpainting || props.isRedetecting || props.isReocring || props.isTranslating || props.isAutoTexts || props.isBurning}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Erase bubble text using the selected inpaint engine"
        >
          <Show when={props.isInpainting} fallback={<PaintBucket class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Inpaint
        </button>

        <button
          onClick={props.onReocr}
          disabled={props.isReocring || props.isRedetecting || props.isInpainting || props.isTranslating || props.isAutoTexts || props.isBurning}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Run OCR on all bubbles to extract source text"
        >
          <Show when={props.isReocring} fallback={<ScanText class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          OCR
        </button>

        <button
          onClick={props.onTranslate}
          disabled={props.isTranslating || props.isRedetecting || props.isInpainting || props.isReocring || props.isAutoTexts || props.isBurning}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Translate all bubbles that have OCR text"
        >
          <Show when={props.isTranslating} fallback={<Type class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Translate
        </button>
      </Show>

      <Show when={props.stage1Active && props.stage3Active}>
        <div class="h-5 w-px bg-slate-200" />
      </Show>

      <Show when={props.stage3Active}>
        <button
          onClick={props.onAutoTexts}
          disabled={props.isAutoTexts || props.isBurning || props.isRedetecting || props.isInpainting || props.isReocring || props.isTranslating}
          class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-run detect + translate to regenerate text overlays"
        >
          <Show when={props.isAutoTexts} fallback={<Sparkles class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Auto Texts
        </button>

        <button
          onClick={props.onBurnTexts}
          disabled={props.isBurning || props.isAutoTexts || props.isRedetecting || props.isInpainting || props.isReocring || props.isTranslating}
          class="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          title="Burn translated text into the result image"
        >
          <Show when={props.isBurning} fallback={<Flame class="h-3.5 w-3.5" />}>
            <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Burn Texts
        </button>
      </Show>

      <div class="flex-1" />

      <button
        onClick={props.onDeleteClick}
        disabled={props.isDeleting}
        class="flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        title="Delete job"
        aria-label="Delete job"
      >
        <Trash2 class="h-3.5 w-3.5" />
        Delete
      </button>
    </header>
  );
}
