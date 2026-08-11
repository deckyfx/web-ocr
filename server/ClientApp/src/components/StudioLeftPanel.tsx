import { Show, For } from "solid-js";
import { PenLine, Plus, Trash2 } from "lucide-solid";
import { BubbleList } from "./BubbleList";
import type { TextSegBox } from "../api";
import type { TranslationBubble } from "../types";
import type { PanelContext, Stage } from "./StudioToolbar";

interface LeftPanelProps {
  stage1Active: boolean;
  stage3Active: boolean;
  panelContext: PanelContext;
  selectedIndex: number | null;
  bubbleList: TranslationBubble[];
  showBubbles: boolean;
  showTextSeg: boolean;
  textSegBoxes: TextSegBox[];
  selectedTextSegIndex: number | null;
  isDrawMode: boolean;
  isTextSegDrawMode: boolean;
  onSelectStage1: (idx: number | null) => void;
  onSelectStage3: (idx: number | null) => void;
  onAddBubble: () => void;
  onAddTextSeg: () => void;
  onDeleteTextSeg: (index: number) => void;
  setSelectedTextSegIndex: (v: number | null) => void;
}

export function StudioLeftPanel(props: LeftPanelProps) {
  return (
    <aside class="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white overflow-hidden">
      {/* Draw mode indicator */}
      <Show when={props.isDrawMode || props.isTextSegDrawMode}>
        <div class={`flex items-center gap-2 px-3 py-2 text-xs font-medium ${
          props.isTextSegDrawMode
            ? "bg-orange-50 text-orange-700 border-b border-orange-200"
            : "bg-blue-50 text-blue-700 border-b border-blue-200"
        }`}>
          <PenLine class="h-3.5 w-3.5 animate-pulse" />
          <span>{props.isTextSegDrawMode ? "Draw TextSeg block" : "Draw bubble"}</span>
          <span class="ml-auto text-[10px] opacity-60">Esc to cancel</span>
        </div>
      </Show>

      <Show when={props.stage1Active}>
        <Show when={props.showBubbles}>
          <div
            class={`flex flex-col overflow-hidden ${
              (props.stage3Active || (props.showTextSeg && props.textSegBoxes.length > 0))
                ? "flex-[1] border-b border-slate-200"
                : "flex-1"
            }`}
          >
            <BubbleList
              bubbles={props.bubbleList}
              selectedIndex={props.panelContext === "stage1" ? props.selectedIndex : null}
              onSelect={props.onSelectStage1}
              onAddBubble={props.onAddBubble}
            />
          </div>
        </Show>

        <Show when={props.showTextSeg}>
          <div class={`flex flex-[1] flex-col overflow-hidden ${props.stage3Active ? "border-b border-slate-200" : ""}`}>
            <div class="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2">
              <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-orange-600">
                TextSeg ({props.textSegBoxes.length})
              </span>
              <button
                onClick={props.onAddTextSeg}
                class={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                  props.isTextSegDrawMode
                    ? "bg-orange-100 text-orange-700"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
                title="Draw a new text segment on the canvas"
              >
                <Plus class="h-3 w-3" />
                <PenLine class="h-3 w-3" />
              </button>
            </div>
            <div class="flex-1 overflow-y-auto scrollbar-thin">
              <Show
                when={props.textSegBoxes.length > 0}
                fallback={
                  <div class="px-3 py-6 text-center text-xs text-slate-400">
                    No text segments
                  </div>
                }
              >
                <For each={props.textSegBoxes}>
                  {(box, i) => {
                    const isSelected = () => props.selectedTextSegIndex === i();
                    return (
                      <button
                        type="button"
                        onClick={() => props.setSelectedTextSegIndex(isSelected() ? null : i())}
                        class={`group flex w-full cursor-pointer items-center gap-1 border-b border-slate-100 px-2 py-1.5 text-left transition-colors ${
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
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); props.onDeleteTextSeg(i()); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); props.onDeleteTextSeg(i()); } }}
                          class="invisible shrink-0 rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500 group-hover:visible group-focus-within:visible focus-visible:visible"
                          title="Delete TextSeg block"
                          aria-label="Delete TextSeg block"
                        >
                          <Trash2 class="h-3 w-3" />
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={props.stage3Active}>
        <div class="flex flex-1 flex-col overflow-hidden">
          <div class="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2">
            <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Overlays ({props.bubbleList.length})
            </span>
          </div>
          <div class="flex-1 overflow-y-auto scrollbar-thin">
            <Show
              when={props.bubbleList.length > 0}
              fallback={
                <div class="px-3 py-6 text-center text-xs text-slate-400">
                  No text overlays
                </div>
              }
            >
              <For each={props.bubbleList}>
                {(bubble) => {
                  const isSelected = () =>
                    props.panelContext === "stage3" &&
                    props.selectedIndex === bubble.bubbleIndex;
                  return (
                    <button
                      data-bubble-idx={bubble.bubbleIndex}
                      onClick={() =>
                        props.onSelectStage3(
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

      <Show when={!props.stage1Active && !props.stage3Active}>
        <div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
          Activate Stage 1 or Stage 3 to edit
        </div>
      </Show>
    </aside>
  );
}
