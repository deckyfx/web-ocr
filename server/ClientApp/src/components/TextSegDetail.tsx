import { Show } from "solid-js";
import { Trash2 } from "lucide-solid";
import type { TextSegBox } from "../api";

interface TextSegDetailProps {
  box: TextSegBox | null;
  index: number | null;
  onDelete: (index: number) => void;
}

export function TextSegDetail(props: TextSegDetailProps) {
  return (
    <div class="flex flex-col h-full">
      <Show
        when={props.box !== null && props.box !== undefined && props.index !== null}
        fallback={
          <div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-slate-400">
            Select a text segment to view details
          </div>
        }
      >
        <>
          {/* Header */}
          <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <span class="flex-1 text-xs font-semibold uppercase tracking-wide text-orange-600">
              TextSeg #{props.index}
            </span>
            <button
              onClick={() => props.index !== null && props.onDelete(props.index)}
              class="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors"
              title="Delete this text segment"
            >
              <Trash2 class="h-3 w-3" />
              Delete
            </button>
          </div>

          {/* Details */}
          <div class="flex-1 overflow-y-auto p-3 space-y-3">
            {/* Position */}
            <div>
              <label class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Position
              </label>
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded bg-slate-50 px-2 py-1">
                  <span class="text-[10px] text-slate-400">X</span>
                  <span class="ml-1 text-xs font-medium text-slate-700">{Math.round(props.box!.x)}</span>
                </div>
                <div class="rounded bg-slate-50 px-2 py-1">
                  <span class="text-[10px] text-slate-400">Y</span>
                  <span class="ml-1 text-xs font-medium text-slate-700">{Math.round(props.box!.y)}</span>
                </div>
              </div>
            </div>

            {/* Size */}
            <div>
              <label class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Size
              </label>
              <div class="grid grid-cols-2 gap-2">
                <div class="rounded bg-slate-50 px-2 py-1">
                  <span class="text-[10px] text-slate-400">W</span>
                  <span class="ml-1 text-xs font-medium text-slate-700">{Math.round(props.box!.w)}</span>
                </div>
                <div class="rounded bg-slate-50 px-2 py-1">
                  <span class="text-[10px] text-slate-400">H</span>
                  <span class="ml-1 text-xs font-medium text-slate-700">{Math.round(props.box!.h)}</span>
                </div>
              </div>
            </div>

            {/* Area */}
            <div>
              <label class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Area
              </label>
              <div class="rounded bg-slate-50 px-2 py-1">
                <span class="text-xs font-medium text-slate-700">
                  {Math.round((props.box?.w ?? 0) * (props.box?.h ?? 0))} px²
                </span>
              </div>
            </div>

            {/* OCR source text */}
            <div>
              <label class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Source text
              </label>
              <Show
                when={props.box?.source_text}
                fallback={
                  <p class="text-[10px] italic text-slate-400">No text yet — run OCR</p>
                }
              >
                <p class="rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700 leading-relaxed break-all">
                  {props.box?.source_text}
                </p>
              </Show>
            </div>

            {/* Translation */}
            <div>
              <label class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Translation
              </label>
              <Show
                when={props.box?.translated_text}
                fallback={
                  <p class="text-[10px] italic text-slate-400">No translation yet</p>
                }
              >
                <p class="rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700 leading-relaxed break-words">
                  {props.box?.translated_text}
                </p>
              </Show>
            </div>

            {/* Usage hint */}
            <div class="mt-2 rounded-lg bg-orange-50 p-2 text-[10px] text-orange-700">
              <p class="font-medium mb-1">Used for:</p>
              <ul class="list-disc list-inside space-y-0.5 text-orange-600">
                <li>OCR text extraction</li>
                <li>Inpaint mask (ink removal)</li>
              </ul>
            </div>
          </div>
        </>
      </Show>
    </div>
  );
}
