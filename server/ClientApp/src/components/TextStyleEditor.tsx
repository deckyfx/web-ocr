import { createSignal, createEffect, Show, on } from "solid-js";
import type { JSX } from "solid-js";
import { AlignLeft, AlignCenter, AlignRight, Trash2 } from "lucide-solid";
import type { TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TextStylePatch = Partial<{
  translatedText: string;
  fontFamily: string;
  fontSizeOverride: number;
  fontColor: string;
  strokeColor: string;
  strokeWidth: number;
  rotation: number;
  textAlign: "left" | "center" | "right";
}>;

export interface TextStyleEditorProps {
  bubble: TranslationBubble | null;
  onUpdate: (patch: TextStylePatch) => void;
  onDelete?: () => void;
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

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TextStyleEditor(props: TextStyleEditorProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [fontFamily, setFontFamily] = createSignal("");
  const [fontSize, setFontSize] = createSignal(0);
  const [fontColor, setFontColor] = createSignal("#000000");
  const [strokeColor, setStrokeColor] = createSignal("#ffffff");
  const [strokeWidth, setStrokeWidth] = createSignal(0);
  const [rotation, setRotation] = createSignal(0);
  const [textAlign, setTextAlign] = createSignal<"left" | "center" | "right">("center");

  createEffect(
    on(
      () => props.bubble,
      () => {
        const b = props.bubble;
        if (!b) return;
        setText(b.translatedText);
        setFontFamily(b.fontFamily ?? "");
        setFontSize(b.fontSizeOverride ?? 0);
        setFontColor(b.fontColor ?? "#000000");
        setStrokeColor(b.strokeColor ?? "#ffffff");
        setStrokeWidth(b.strokeWidth ?? 0);
        setRotation(b.rotation ?? 0);
        setTextAlign(b.textAlign ?? "center");
      },
    ),
  );

  function commit<K extends keyof TextStylePatch>(key: K, value: TextStylePatch[K]): void {
    props.onUpdate({ [key]: value } as TextStylePatch);
  }

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="shrink-0 border-b border-slate-100 px-3 py-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Text Style
        </span>
      </div>

      <Show
        when={props.bubble}
        fallback={
          <div class="flex flex-1 items-center justify-center text-xs text-slate-400">
            Select a text overlay to edit
          </div>
        }
      >
        {(bubble) => (
          <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
            {/* Label row */}
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-700">
                Overlay #{bubble().bubbleIndex}
              </span>
              <Show when={bubble().isExcluded}>
                <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                  Excluded
                </span>
              </Show>
            </div>

            {/* Translation text */}
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-slate-500">Translation</span>
              <textarea
                rows={4}
                class="resize-y rounded border border-slate-200 px-2 py-1.5 text-xs focus:border-violet-400 focus:outline-none"
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
                onBlur={(e) => commit("translatedText", e.currentTarget.value)}
              />
            </label>

            {/* Font */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">Font</p>
              <div class="flex flex-col gap-1.5">
                <label class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">Family</span>
                  <select
                    class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                    value={fontFamily()}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      setFontFamily(val);
                      commit("fontFamily", val);
                    }}
                  >
                    {FONT_FAMILIES.map((f) => (
                      <option value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </label>

                <div class="grid grid-cols-2 gap-1.5">
                  <label class="flex flex-col gap-0.5">
                    <span class="text-[10px] text-slate-400">Size (0 = auto)</span>
                    <input
                      type="number"
                      min="0"
                      max="72"
                      step="1"
                      class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                      value={fontSize()}
                      onInput={(e) =>
                        setFontSize(
                          Math.min(72, Math.max(0, parseInt(e.currentTarget.value, 10) || 0)),
                        )
                      }
                      onChange={(e) => {
                        const val = Math.min(72, Math.max(0, parseInt(e.currentTarget.value, 10) || 0));
                        setFontSize(val);
                        commit("fontSizeOverride", val);
                      }}
                    />
                  </label>

                  <label class="flex flex-col gap-0.5">
                    <span class="text-[10px] text-slate-400">Color</span>
                    <div class="flex items-center gap-1">
                      <input
                        type="color"
                        class="h-7 w-7 cursor-pointer rounded border border-slate-200 p-0.5"
                        value={fontColor()}
                        onInput={(e) => setFontColor(e.currentTarget.value)}
                        onChange={(e) => commit("fontColor", e.currentTarget.value)}
                      />
                      <input
                        type="text"
                        maxLength={7}
                        class="min-w-0 flex-1 rounded border border-slate-200 px-1.5 py-1 font-mono text-xs focus:border-violet-400 focus:outline-none"
                        value={fontColor()}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          if (HEX_RE.test(v)) setFontColor(v);
                        }}
                        onBlur={(e) => {
                          const v = e.currentTarget.value;
                          if (HEX_RE.test(v)) commit("fontColor", v);
                        }}
                      />
                    </div>
                  </label>
                </div>
              </div>
            </div>

            {/* Stroke */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">Stroke</p>
              <div class="grid grid-cols-2 gap-1.5">
                <label class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">Color</span>
                  <div class="flex items-center gap-1">
                    <input
                      type="color"
                      class="h-7 w-7 cursor-pointer rounded border border-slate-200 p-0.5"
                      value={strokeColor()}
                      onInput={(e) => setStrokeColor(e.currentTarget.value)}
                      onChange={(e) => commit("strokeColor", e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      maxLength={7}
                      class="min-w-0 flex-1 rounded border border-slate-200 px-1.5 py-1 font-mono text-xs focus:border-violet-400 focus:outline-none"
                      value={strokeColor()}
                      onInput={(e) => {
                        const v = e.currentTarget.value;
                        if (HEX_RE.test(v)) setStrokeColor(v);
                      }}
                      onBlur={(e) => {
                        const v = e.currentTarget.value;
                        if (HEX_RE.test(v)) commit("strokeColor", v);
                      }}
                    />
                  </div>
                </label>

                <label class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">Width (0 = none)</span>
                  <input
                    type="number"
                    min="0"
                    max="20"
                    step="1"
                    class="rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                    value={strokeWidth()}
                    onInput={(e) =>
                      setStrokeWidth(
                        Math.min(20, Math.max(0, parseInt(e.currentTarget.value, 10) || 0)),
                      )
                    }
                    onChange={(e) => {
                      const val = Math.min(20, Math.max(0, parseInt(e.currentTarget.value, 10) || 0));
                      setStrokeWidth(val);
                      commit("strokeWidth", val);
                    }}
                  />
                </label>
              </div>
            </div>

            {/* Layout */}
            <div>
              <p class="mb-1.5 text-xs font-medium text-slate-500">Layout</p>
              <div class="flex flex-col gap-2">
                {/* Text align */}
                <div class="flex flex-col gap-0.5">
                  <span class="text-[10px] text-slate-400">Text Align</span>
                  <div class="flex overflow-hidden rounded border border-slate-200">
                    {(["left", "center", "right"] as const).map((align) => {
                      const isActive = () => textAlign() === align;
                      return (
                        <button
                          onClick={() => {
                            setTextAlign(align);
                            commit("textAlign", align);
                          }}
                          class={`flex flex-1 items-center justify-center py-1.5 border-r border-slate-200 last:border-r-0 transition-colors ${
                            isActive()
                              ? "bg-violet-600 text-white"
                              : "bg-white text-slate-500 hover:bg-slate-50"
                          }`}
                          title={align.charAt(0).toUpperCase() + align.slice(1)}
                          aria-pressed={isActive()}
                        >
                          {align === "left" ? (
                            <AlignLeft class="h-3.5 w-3.5" />
                          ) : align === "center" ? (
                            <AlignCenter class="h-3.5 w-3.5" />
                          ) : (
                            <AlignRight class="h-3.5 w-3.5" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Rotation */}
                <label class="flex flex-col gap-0.5">
                  <div class="flex items-center justify-between">
                    <span class="text-[10px] text-slate-400">Rotation</span>
                    <span class="text-[10px] tabular-nums text-slate-500">{rotation()}°</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      class="flex-1 accent-violet-600"
                      value={rotation()}
                      onInput={(e) => setRotation(parseInt(e.currentTarget.value, 10))}
                      onChange={(e) => {
                        const val = parseInt(e.currentTarget.value, 10);
                        setRotation(val);
                        commit("rotation", val);
                      }}
                    />
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="1"
                      class="w-14 rounded border border-slate-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none"
                      value={rotation()}
                      onInput={(e) => {
                        const val = Math.min(180, Math.max(-180, parseInt(e.currentTarget.value, 10) || 0));
                        setRotation(val);
                      }}
                      onChange={(e) => {
                        const val = Math.min(180, Math.max(-180, parseInt(e.currentTarget.value, 10) || 0));
                        setRotation(val);
                        commit("rotation", val);
                      }}
                    />
                  </div>
                </label>
              </div>
            </div>

            {/* Delete */}
            <Show when={props.onDelete}>
              <div class="mt-auto border-t border-slate-100 pt-3">
                <button
                  onClick={props.onDelete}
                  class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 active:bg-red-200"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                  Delete overlay
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
