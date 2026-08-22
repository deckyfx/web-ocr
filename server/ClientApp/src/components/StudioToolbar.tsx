import { Show, For, createSignal } from "solid-js";
import {
  ArrowLeft,
  Eye,
  Flame,
  Layers,
  PaintBucket,
  RefreshCw,
  ScanText,
  Settings2,
  Sparkles,
  Trash2,
  Type,
} from "lucide-solid";
import { Dropdown, DropdownItem, DropdownSeparator } from "./Dropdown";
import { ConfirmDialog } from "./ConfirmDialog";
import { StatusBadge } from "../pages/JobsListPage";
import type { PageTranslationJob } from "../types";

export type Stage = "original" | "inpainted" | "compose" | "result";

export const STAGE_LABELS: Record<Stage, string> = {
  original:  "Original",
  inpainted: "Inpainted",
  compose:   "Compose",
  result:    "Result",
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
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);

  const anyActionRunning = () =>
    props.isRedetecting || props.isInpainting || props.isReocring ||
    props.isTranslating || props.isAutoTexts || props.isBurning;

  const stageLabel = () => {
    const labels = props.activeStages.map((s) => STAGE_LABELS[s]);
    return labels.length > 0 ? labels.join(" + ") : "Stages";
  };

  return (
    <header class="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 shadow-sm">
      {/* Back */}
      <button
        onClick={props.onNavigateBack}
        class="flex items-center gap-1 rounded p-1 text-slate-500 hover:bg-slate-100 transition-colors"
        title="Back to jobs"
        aria-label="Back to jobs"
      >
        <ArrowLeft class="h-4 w-4" />
      </button>

      {/* Title + status */}
      <Show
        when={props.job}
        fallback={<div class="h-4 w-40 animate-pulse rounded bg-slate-200" />}
      >
        {(j) => (
          <>
            <h1 class="max-w-[250px] truncate text-sm font-semibold text-slate-800">
              {j().title}
            </h1>
            <StatusBadge status={j().status} />
          </>
        )}
      </Show>

      <div class="mx-1 h-5 w-px bg-slate-200" />

      {/* Stages dropdown */}
      <Dropdown
        trigger={(onClick) => (
          <button
            onClick={onClick}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
            title="Toggle stages"
          >
            <Layers class="h-3.5 w-3.5" />
            <span class="max-w-[180px] truncate">{stageLabel()}</span>
          </button>
        )}
      >
        <For each={ALL_STAGES}>
          {(stage) => {
            const isActive = () => props.activeStages.includes(stage);
            return (
              <DropdownItem onClick={() => props.onToggleStage(stage)}>
                <Show
                  when={isActive()}
                  fallback={<span class="h-2.5 w-2.5 rounded-sm border-2 border-slate-300" />}
                >
                  <span class="h-2.5 w-2.5 rounded-sm border-2 border-violet-500 bg-violet-100" />
                </Show>
                <span class="flex-1">{STAGE_LABELS[stage]}</span>
                <Show when={isActive()}>
                  <span class="text-[10px] text-slate-400">#{STAGE_ORDER[stage] + 1}</span>
                </Show>
              </DropdownItem>
            );
          }}
        </For>
      </Dropdown>

      {/* View dropdown — overlays + padding */}
      <Dropdown
        trigger={(onClick) => (
          <button
            onClick={onClick}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
            title="View settings"
          >
            <Eye class="h-3.5 w-3.5" />
            View
          </button>
        )}
      >
        <DropdownItem onClick={props.onToggleTextSeg}>
          <Show
            when={props.showTextSeg}
            fallback={<span class="h-2.5 w-2.5 rounded-sm border-2 border-slate-400" />}
          >
            <span class="h-2.5 w-2.5 rounded-sm border-2 border-orange-500 bg-orange-100" />
          </Show>
          <span class="flex-1">TextSeg</span>
          <Show when={props.isLoadingTextSeg}>
            <RefreshCw class="h-3 w-3 animate-spin text-slate-400" />
          </Show>
        </DropdownItem>

        <DropdownItem onClick={props.onToggleShowBubbles}>
          <Show
            when={props.showBubbles}
            fallback={<span class="h-2.5 w-2.5 rounded-sm border-2 border-slate-400" />}
          >
            <span class="h-2.5 w-2.5 rounded-sm border-2 border-blue-500 bg-blue-100" />
          </Show>
          <span class="flex-1">Bubbles</span>
        </DropdownItem>

        <DropdownSeparator />

        <div class="px-3 py-1.5">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-slate-500">Padding</span>
            <div class="flex items-center gap-1">
              <button
                class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30 text-xs"
                disabled={props.bubblePadding <= 0}
                onClick={() => props.onSetBubblePadding(Math.max(0, props.bubblePadding - 1))}
              >−</button>
              <span class="w-5 text-center text-xs tabular-nums">{props.bubblePadding}</span>
              <button
                class="flex h-5 w-5 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-30 text-xs"
                disabled={props.bubblePadding >= 20}
                onClick={() => props.onSetBubblePadding(Math.min(20, props.bubblePadding + 1))}
              >+</button>
            </div>
          </div>
        </div>
      </Dropdown>

      {/* Actions dropdown — stage-specific actions */}
      <Dropdown
        trigger={(onClick) => (
          <button
            onClick={onClick}
            disabled={anyActionRunning()}
            class="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Actions"
          >
            <Show when={anyActionRunning()} fallback={<Settings2 class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Actions
          </button>
        )}
      >
        {/* Stage 1 actions */}
        <Show when={props.stage1Active}>
          <div class="px-3 py-1">
            <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stage 1</span>
          </div>

          <DropdownItem onClick={props.onRedetect} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isRedetecting} fallback={<ScanText class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Detect bubbles
          </DropdownItem>

          <DropdownItem onClick={props.onInpaint} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isInpainting} fallback={<PaintBucket class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Inpaint
          </DropdownItem>

          <DropdownItem onClick={props.onReocr} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isReocring} fallback={<ScanText class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            OCR all
          </DropdownItem>

          <DropdownItem onClick={props.onTranslate} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isTranslating} fallback={<Type class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Translate all
          </DropdownItem>

          <Show when={props.stage3Active}>
            <DropdownSeparator />
          </Show>
        </Show>

        {/* Stage 3 actions */}
        <Show when={props.stage3Active}>
          <div class="px-3 py-1">
            <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stage 3</span>
          </div>

          <DropdownItem onClick={props.onAutoTexts} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isAutoTexts} fallback={<Sparkles class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            Auto Texts
          </DropdownItem>

          <DropdownItem onClick={props.onBurnTexts} class={anyActionRunning() ? "opacity-50 pointer-events-none" : ""}>
            <Show when={props.isBurning} fallback={<Flame class="h-3.5 w-3.5" />}>
              <RefreshCw class="h-3.5 w-3.5 animate-spin" />
            </Show>
            <span class="text-violet-600">Burn Texts</span>
          </DropdownItem>
        </Show>

        {/* No stage active */}
        <Show when={!props.stage1Active && !props.stage3Active}>
          <div class="px-3 py-4 text-center text-xs text-slate-400">
            Activate a stage first
          </div>
        </Show>
      </Dropdown>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Delete */}
      <button
        onClick={() => setShowDeleteConfirm(true)}
        disabled={props.isDeleting}
        class="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
        title="Delete job"
        aria-label="Delete job"
      >
        <Trash2 class="h-4 w-4" />
      </button>

      <ConfirmDialog
        open={showDeleteConfirm()}
        title="Delete job"
        message="This will permanently delete the job, its images, and all bubble data. This cannot be undone."
        confirmLabel="Delete"
        loading={props.isDeleting}
        onConfirm={() => { setShowDeleteConfirm(false); props.onDeleteClick(); }}
        onCancel={() => { if (!props.isDeleting) setShowDeleteConfirm(false); }}
      />
    </header>
  );
}
