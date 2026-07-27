import { createEffect, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { PenLine, Plus } from "lucide-solid";
import type { TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BubbleListProps {
  bubbles: TranslationBubble[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
  onAddBubble: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BubbleList(props: BubbleListProps): JSX.Element {
  let listRef!: HTMLDivElement;

  // Scroll the selected item into view whenever selection changes
  createEffect(() => {
    const idx = props.selectedIndex;
    if (idx === null) return;
    const el = listRef?.querySelector<HTMLElement>(`[data-bubble-idx="${idx}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2 shrink-0">
        <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Bubbles ({props.bubbles.length})
        </span>
        <button
          onClick={props.onAddBubble}
          class="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
          title="Draw a new bubble on the canvas"
        >
          <Plus class="h-3 w-3" />
          <PenLine class="h-3 w-3" />
        </button>
      </div>

      {/* List */}
      <div ref={listRef} class="flex-1 overflow-y-auto">
        <Show
          when={props.bubbles.length > 0}
          fallback={
            <div class="px-3 py-6 text-center text-xs text-slate-400">
              No bubbles detected
            </div>
          }
        >
          <For each={props.bubbles}>
            {(bubble) => {
              const isSelected = () => props.selectedIndex === bubble.bubbleIndex;
              return (
                <button
                  data-bubble-idx={bubble.bubbleIndex}
                  onClick={() =>
                    props.onSelect(
                      isSelected() ? null : bubble.bubbleIndex,
                    )
                  }
                  class={`w-full border-b border-slate-100 px-3 py-2 text-left transition-colors ${
                    isSelected()
                      ? "border-l-2 border-l-violet-500 bg-violet-50"
                      : "hover:bg-slate-50"
                  } ${bubble.isExcluded ? "opacity-50" : ""}`}
                >
                  {/* Row header */}
                  <div class="flex items-center gap-1.5">
                    <span
                      class={`font-mono text-xs font-medium ${
                        isSelected() ? "text-violet-700" : "text-slate-500"
                      }`}
                    >
                      #{bubble.bubbleIndex}
                    </span>
                    <Show when={bubble.isManuallyAdded}>
                      <span class="rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700">
                        M
                      </span>
                    </Show>
                    <Show when={bubble.isExcluded}>
                      <span class="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-500">
                        ×
                      </span>
                    </Show>
                  </div>
                  {/* Source text preview */}
                  <p
                    class={`mt-0.5 truncate text-xs ${
                      bubble.isExcluded
                        ? "line-through text-slate-400"
                        : "text-slate-600"
                    }`}
                  >
                    {bubble.sourceText.slice(0, 20) || "(empty)"}
                  </p>
                </button>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
