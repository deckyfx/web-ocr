import { createSignal, createEffect, Show, on } from "solid-js";
import type { JSX } from "solid-js";
import { RefreshCw, ScanText, Sparkles, PaintBucket, Type, Trash2 } from "lucide-solid";
import type { TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BubbleUpdatePatch = Partial<{
  bubbleX: number;
  bubbleY: number;
  bubbleW: number;
  bubbleH: number;
  sourceText: string;
  translatedText: string;
  isExcluded: boolean;
  fontFamily: string;
  fontSizeOverride: number;
}>;

export interface BubbleEditorProps {
  bubble: TranslationBubble | null;
  onUpdate: (patch: BubbleUpdatePatch) => void;
  onDelete: () => void;
  onReocr?: () => Promise<void>;
  onRetranslate?: () => Promise<void>;
  onReinpaint?: () => Promise<void>;
  onRepatch?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_FAMILIES = [
  { value: "", label: "Auto (sans-serif)" },
  { value: "sans-serif", label: "Sans-serif" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Monospace" },
  { value: "Arial", label: "Arial" },
  { value: "Verdana", label: "Verdana" },
  { value: "Georgia", label: "Georgia" },
  { value: "Impact", label: "Impact" },
  { value: "Tahoma", label: "Tahoma" },
  { value: "Comic Sans MS", label: "Comic Sans MS" },
  { value: "Courier New", label: "Courier New" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function NumInput(inputProps: {
  label: string;
  value: number;
  onInput: (v: number) => void;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label class="flex flex-col gap-0.5">
      <span class="text-[10px] text-slate-400">{inputProps.label}</span>
      <input
        type="number"
        step="0.1"
        value={inputProps.value}
        onInput={(e) =>
          inputProps.onInput(parseFloat(e.currentTarget.value) || 0)
        }
        onChange={(e) =>
          inputProps.onChange(parseFloat(e.currentTarget.value) || 0)
        }
        class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BubbleEditor(props: BubbleEditorProps): JSX.Element {
  const [x, setX] = createSignal(0);
  const [y, setY] = createSignal(0);
  const [w, setW] = createSignal(0);
  const [h, setH] = createSignal(0);
  const [sourceText, setSourceText] = createSignal("");
  const [translatedText, setTranslatedText] = createSignal("");
  const [isExcluded, setIsExcluded] = createSignal(false);
  const [fontFamily, setFontFamily] = createSignal("");
  const [fontSizeOverride, setFontSizeOverride] = createSignal(0);

  // Per-bubble action loading states
  const [isReocring, setIsReocring] = createSignal(false);
  const [isRetranslating, setIsRetranslating] = createSignal(false);
  const [isReinpainting, setIsReinpainting] = createSignal(false);
  const [isRepatching, setIsRepatching] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // Reset form fields when bubble changes (selection OR external data update)
  createEffect(
    on(
      () => props.bubble,
      () => {
        const b = props.bubble;
        if (!b) return;
        setX(b.bubbleX);
        setY(b.bubbleY);
        setW(b.bubbleW);
        setH(b.bubbleH);
        setSourceText(b.sourceText);
        setTranslatedText(b.translatedText);
        setIsExcluded(b.isExcluded);
        setFontFamily(b.fontFamily ?? "");
        setFontSizeOverride(b.fontSizeOverride ?? 0);
        setActionError(null);
      },
    ),
  );

  async function runAction(
    setter: (v: boolean) => void,
    action?: () => Promise<void>,
  ): Promise<void> {
    if (!action) return;
    setter(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setter(false);
    }
  }

  const anyBusy = () =>
    isReocring() || isRetranslating() || isReinpainting() || isRepatching();

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="shrink-0 border-b border-slate-100 px-3 py-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Editor
        </span>
      </div>

      <Show
        when={props.bubble}
        fallback={
          <div class="flex flex-1 items-center justify-center text-xs text-slate-400">
            Select a bubble to edit
          </div>
        }
      >
        {(bubble) => (
          <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
            {/* Title row */}
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-700">
                Bubble #{bubble().bubbleIndex}
              </span>
              <Show when={bubble().isManuallyAdded}>
                <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  Manual
                </span>
              </Show>
              <span class="ml-auto text-[10px] text-slate-400">
                {bubble().isManuallyAdded
                  ? "N/A conf"
                  : `${Math.round(bubble().confidence * 100)}% conf`}
              </span>
            </div>

            {/* Coordinates */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">
                Position &amp; Size (px)
              </p>
              <div class="grid grid-cols-2 gap-1.5">
                <NumInput
                  label="X"
                  value={x()}
                  onInput={setX}
                  onChange={(v) => props.onUpdate({ bubbleX: v })}
                />
                <NumInput
                  label="Y"
                  value={y()}
                  onInput={setY}
                  onChange={(v) => props.onUpdate({ bubbleY: v })}
                />
                <NumInput
                  label="W"
                  value={w()}
                  onInput={setW}
                  onChange={(v) => props.onUpdate({ bubbleW: v })}
                />
                <NumInput
                  label="H"
                  value={h()}
                  onInput={setH}
                  onChange={(v) => props.onUpdate({ bubbleH: v })}
                />
              </div>
            </div>

            {/* Source text */}
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-slate-500">Source</span>
              <textarea
                rows={3}
                class="resize-y rounded border border-slate-200 px-2 py-1.5 text-xs focus:border-violet-400 focus:outline-none"
                value={sourceText()}
                onInput={(e) => setSourceText(e.currentTarget.value)}
                onBlur={(e) =>
                  props.onUpdate({ sourceText: e.currentTarget.value })
                }
              />
            </label>

            {/* Translation */}
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-slate-500">
                Translation
              </span>
              <textarea
                rows={4}
                class="resize-y rounded border border-slate-200 px-2 py-1.5 text-xs focus:border-violet-400 focus:outline-none"
                value={translatedText()}
                onInput={(e) => setTranslatedText(e.currentTarget.value)}
                onBlur={(e) =>
                  props.onUpdate({ translatedText: e.currentTarget.value })
                }
              />
            </label>

            {/* Render Style */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">
                Render Style
              </p>
              <div class="flex flex-col gap-1.5">
                <label class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">Font Family</span>
                  <select
                    class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                    value={fontFamily()}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      setFontFamily(val);
                      props.onUpdate({ fontFamily: val });
                    }}
                  >
                    {FONT_FAMILIES.map((f) => (
                      <option value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </label>

                <label class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">
                    Font Size (0 = auto-fit)
                  </span>
                  <input
                    type="number"
                    min="0"
                    max="72"
                    step="1"
                    class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                    value={fontSizeOverride()}
                    onInput={(e) =>
                      setFontSizeOverride(
                        parseInt(e.currentTarget.value, 10) || 0,
                      )
                    }
                    onChange={(e) => {
                      const val = parseInt(e.currentTarget.value, 10) || 0;
                      setFontSizeOverride(val);
                      props.onUpdate({ fontSizeOverride: val });
                    }}
                  />
                </label>
              </div>
            </div>

            {/* Per-bubble actions */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">
                Bubble Actions
              </p>

              <Show when={actionError()}>
                {(msg) => (
                  <div class="mb-2 flex items-start gap-1.5 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700 ring-1 ring-inset ring-red-200">
                    <span class="flex-1">{msg()}</span>
                    <button
                      onClick={() => setActionError(null)}
                      class="shrink-0 hover:text-red-900"
                      aria-label="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </Show>

              <div class="grid grid-cols-2 gap-1">
                {/* Re-OCR */}
                <button
                  onClick={() => runAction(setIsReocring, props.onReocr)}
                  disabled={anyBusy() || !props.onReocr}
                  class="flex items-center justify-center gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Re-run OCR on this bubble"
                >
                  <Show
                    when={isReocring()}
                    fallback={<ScanText class="h-3 w-3" />}
                  >
                    <RefreshCw class="h-3 w-3 animate-spin" />
                  </Show>
                  Re-OCR
                </button>

                {/* Re-translate */}
                <button
                  onClick={() =>
                    runAction(setIsRetranslating, props.onRetranslate)
                  }
                  disabled={anyBusy() || !props.onRetranslate}
                  class="flex items-center justify-center gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Re-translate current source text"
                >
                  <Show
                    when={isRetranslating()}
                    fallback={<Sparkles class="h-3 w-3" />}
                  >
                    <RefreshCw class="h-3 w-3 animate-spin" />
                  </Show>
                  Re-translate
                </button>

                {/* Re-inpaint */}
                <button
                  onClick={() =>
                    runAction(setIsReinpainting, props.onReinpaint)
                  }
                  disabled={anyBusy() || !props.onReinpaint}
                  class="flex items-center justify-center gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="White-fill this bubble in the result image"
                >
                  <Show
                    when={isReinpainting()}
                    fallback={<PaintBucket class="h-3 w-3" />}
                  >
                    <RefreshCw class="h-3 w-3 animate-spin" />
                  </Show>
                  Re-inpaint
                </button>

                {/* Re-patch */}
                <button
                  onClick={() => runAction(setIsRepatching, props.onRepatch)}
                  disabled={anyBusy() || !props.onRepatch}
                  class="flex items-center justify-center gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Re-render text in this bubble"
                >
                  <Show
                    when={isRepatching()}
                    fallback={<Type class="h-3 w-3" />}
                  >
                    <RefreshCw class="h-3 w-3 animate-spin" />
                  </Show>
                  Re-patch
                </button>
              </div>
            </div>

            {/* Exclude toggle */}
            <div class="flex items-center gap-2">
              <input
                id="exclude-check"
                type="checkbox"
                class="h-3.5 w-3.5 rounded accent-violet-600"
                checked={isExcluded()}
                onChange={(e) => {
                  const val = e.currentTarget.checked;
                  setIsExcluded(val);
                  props.onUpdate({ isExcluded: val });
                }}
              />
              <label
                for="exclude-check"
                class="cursor-pointer text-xs text-slate-600"
              >
                Exclude from render
              </label>
            </div>

            {/* Delete */}
            <div class="mt-auto border-t border-slate-100 pt-3">
              <button
                onClick={props.onDelete}
                class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 active:bg-red-200"
              >
                <Trash2 class="h-3.5 w-3.5" />
                Delete bubble
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
